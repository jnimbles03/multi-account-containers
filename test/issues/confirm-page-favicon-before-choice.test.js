const http = require("http");
const fs = require("fs");
const path = require("path");
const {pathToFileURL} = require("url");
const {JSDOM, ResourceLoader} = require("jsdom");
const {buildBackgroundDom, expect} = require("../common");

const SRC_ROOT = path.resolve(__dirname, "../../src");
const CONFIRM_PAGE_HTML = fs.readFileSync(
  path.join(SRC_ROOT, "confirm-page.html"),
  "utf8"
);

// Firefox maps a tab cookieStoreId onto the document's originAttributes.userContextId
// (ext-tabs.js tabs.create, ext-toolkit.js getContainerForCookieStoreId,
// tabbrowser.js _createTab / createBrowser, E10SUtils.predictOriginAttributes).
// Image loads call channel->AsyncOpen with those origin attributes
// (HTMLImageElement::AfterMaybeChangeAttr -> LoadSelectedImage ->
// nsImageLoadingContent::LoadImage -> nsContentUtils::LoadImage ->
// imgLoader::LoadImage -> NewImageChannel -> AsyncOpen).
// Cookies are keyed by OriginAttributes, including mUserContextId
// (CookieKey.h, OriginAttributes.h). An extension with <all_urls> makes
// AddonAllowsLoad true, so Set-Cookie is not forced into a foreign partition
// (CookieService.cpp SetCookieStringFromHttp, BasePrincipal::AddonAllowsLoad,
// WebExtensionPolicyCore::CanAccessURI). The jar used is the tab's userContextId.
function userContextIdForCookieStoreId(cookieStoreId) {
  if (!cookieStoreId || cookieStoreId === "firefox-default") {
    return 0;
  }
  const prefix = "firefox-container-";
  if (cookieStoreId.startsWith(prefix)) {
    return Number(cookieStoreId.slice(prefix.length));
  }
  throw new Error(`Unrecognized cookieStoreId: ${cookieStoreId}`);
}

class ExtensionPageLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.startsWith("chrome:")) {
      const promise = Promise.resolve(Buffer.from(""));
      promise.abort = () => {};
      promise.getHeader = () => undefined;
      return promise;
    }
    if (url.startsWith("moz-extension://")) {
      const pathname = decodeURIComponent(new URL(url).pathname);
      const filePath = path.join(SRC_ROOT, pathname);
      return super.fetch(pathToFileURL(filePath).href, options);
    }
    return super.fetch(url, options);
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function startPinnedSite() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie || "",
        body: Buffer.concat(chunks).toString("utf8")
      });
      res.setHeader("Set-Cookie", "from-favicon=1; Path=/");
      res.statusCode = 200;
      res.end("favicon");
    });
  });
  return {server, requests, address: listen(server)};
}

function createCookieJars() {
  const jars = new Map();
  return {
    seed(userContextId, name, value) {
      if (!jars.has(userContextId)) {
        jars.set(userContextId, new Map());
      }
      jars.get(userContextId).set(name, value);
    },
    header(userContextId) {
      const jar = jars.get(userContextId);
      if (!jar) {
        return "";
      }
      return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
    },
    store(userContextId, setCookie) {
      const pair = setCookie.split(";")[0];
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.seed(userContextId, name, value);
    },
    names(userContextId) {
      const jar = jars.get(userContextId);
      return jar ? Array.from(jar.keys()).sort() : [];
    }
  };
}

// Stand-in for Firefox opening an image channel when an <img> src is set.
// It performs the network request the product's jsdom build skips, because
// jsdom 16.7.0 returns before fetch unless the optional canvas package is
// installed (HTMLImageElement-impl.js _updateTheImageData).
function installImageChannel(window, userContextId, jars) {
  const requests = [];
  const started = [];

  function openChannel(rawUrl) {
    const absolute = new window.URL(rawUrl, window.location.href);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return;
    }
    const href = absolute.href;
    if (started.includes(href)) {
      return;
    }
    started.push(href);
    const cookie = jars.header(userContextId);
    const request = new Promise((resolve, reject) => {
      const req = http.request(href, {
        method: "GET",
        headers: {
          Accept: "image/png,image/*;q=0.8,*/*;q=0.5",
          Cookie: cookie
        }
      }, (res) => {
        const setCookie = res.headers["set-cookie"];
        const cookies = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
        cookies.forEach((line) => jars.store(userContextId, line));
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });
    requests.push(request);
  }

  const originalSrc = Object.getOwnPropertyDescriptor(
    window.HTMLImageElement.prototype,
    "src"
  );
  Object.defineProperty(window.HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: true,
    get: originalSrc.get,
    set(value) {
      originalSrc.set.call(this, value);
      openChannel(value);
    }
  });

  const originalSetAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function(name, value) {
    originalSetAttribute.call(this, name, value);
    if (String(name).toLowerCase() === "src" && this.localName === "img") {
      openChannel(value);
    }
  };

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    openChannel(url);
    if (originalFetch) {
      return originalFetch(input, init);
    }
    return Promise.resolve({ok: false, status: 0});
  };

  const OriginalXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    xhr.open = function(method, url) {
      void method;
      openChannel(url);
      return originalOpen.apply(xhr, arguments);
    };
    return xhr;
  };

  return {
    async settled() {
      await Promise.all(requests);
    }
  };
}

async function showConfirmationPage(confirmPageUrl, cookieStoreId, jars) {
  const userContextId = userContextIdForCookieStoreId(cookieStoreId);
  let channel;
  const dom = new JSDOM(CONFIRM_PAGE_HTML, {
    url: confirmPageUrl,
    runScripts: "dangerously",
    resources: new ExtensionPageLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      window.matchMedia = () => ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {}
      });
      window.browser = {
        i18n: {
          getMessage() {
            return "message";
          }
        },
        contextualIdentities: {
          get: async () => ({name: "Container", cookieStoreId})
        },
        runtime: {
          sendMessage: async () => {}
        },
        tabs: {
          query: async () => [{id: 1, index: 0, groupId: -1}],
          create: async () => ({id: 2}),
          group: async () => {},
          remove: async () => {}
        },
        windows: {WINDOW_ID_CURRENT: 1}
      };
      channel = installImageChannel(window, userContextId, jars);
    }
  });

  await new Promise((resolve) => {
    dom.window.addEventListener("load", resolve);
  });
  await channel.settled();
  return {dom, userContextId};
}

async function navigateFromContainer({cookieStoreId, pageUrl}) {
  let opener;
  const webExt = await buildBackgroundDom({
    async afterBuild(background) {
      opener = await background.browser.tabs._create({
        cookieStoreId,
        url: "about:blank",
        active: true
      });
    }
  });

  const background = webExt.background.window;
  await background.assignManager.storageArea.set(pageUrl, {
    userContextId: "4",
    neverAsk: false
  });
  webExt.background.browser.tabs.create.resetHistory();

  const listenerCall = background.browser.webRequest.onBeforeRequest.addListener.getCall(0);
  const decisions = [];
  const originalListener = listenerCall.args[0];
  listenerCall.args[0] = async (options) => {
    const result = await originalListener(options);
    decisions.push({
      url: options.url,
      type: options.type,
      frameId: options.frameId,
      result
    });
    return result;
  };

  const navigatingTab = await webExt.background.browser.tabs._create({
    cookieStoreId,
    url: pageUrl,
    active: true,
    openerTabId: opener.id
  }, {
    options: {
      webRequestError: true
    }
  });

  const confirmCalls = webExt.background.browser.tabs.create.getCalls()
    .map((call) => call.args[0])
    .filter((props) => props.url && props.url.includes("confirm-page.html"));

  return {
    webExt,
    navigatingTab,
    confirmCalls,
    background,
    decisions,
    requestFilter: listenerCall.args[1]
  };
}

describe("pinned-site confirmation must not contact the destination early", function() {
  this.timeout(20000);

  let site;
  let pinnedUrl;
  let origin;

  before(async function() {
    site = startPinnedSite();
    const address = await site.address;
    origin = `http://127.0.0.1:${address.port}`;
    pinnedUrl = `${origin}/pinned/page`;
  });

  after(function(done) {
    site.server.close(done);
  });

  async function expectNoEarlyContact(leavingCookieStoreId) {
    const before = site.requests.length;
    const jars = createCookieJars();
    const leavingContext = userContextIdForCookieStoreId(leavingCookieStoreId);
    const assignedContext = 4;
    jars.seed(leavingContext, "from-leaving-container", "1");
    jars.seed(assignedContext, "from-assigned-container", "1");

    const navigation = await navigateFromContainer({
      cookieStoreId: leavingCookieStoreId,
      pageUrl: pinnedUrl
    });

    try {
      expect(navigation.confirmCalls).to.have.lengthOf(1);
      const confirm = navigation.confirmCalls[0];
      const confirmUrl = new URL(confirm.url);
      expect(confirmUrl.searchParams.get("url")).to.equal(pinnedUrl);
      expect(confirmUrl.searchParams.get("cookieStoreId")).to.equal("firefox-container-4");

      const page = await showConfirmationPage(confirm.url, confirm.cookieStoreId, jars);
      page.dom.window.close();

      const earlyRequests = site.requests.slice(before).map((request) => ({
        method: request.method,
        url: request.url,
        cookie: request.cookie
      }));
      const pinnedDecision = navigation.decisions.filter((decision) => decision.url === pinnedUrl);

      expect({
        pinnedDocumentDecision: pinnedDecision,
        // Image requests are outside the blocking listener, which is registered
        // only for main_frame navigations.
        blockingListenerTypes: navigation.requestFilter.types,
        requestsBeforeChoice: earlyRequests,
        cookiesInLeavingContainer: jars.names(leavingContext),
        cookiesInAssignedContainer: jars.names(assignedContext)
      }).to.deep.equal({
        pinnedDocumentDecision: [{
          url: pinnedUrl,
          type: "main_frame",
          frameId: 0,
          result: {cancel: true}
        }],
        blockingListenerTypes: ["main_frame"],
        requestsBeforeChoice: [],
        cookiesInLeavingContainer: ["from-leaving-container"],
        cookiesInAssignedContainer: ["from-assigned-container"]
      });
    } finally {
      navigation.webExt.destroy();
    }
  }

  it("does not request the pinned origin from another container before the user chooses", async function() {
    await expectNoEarlyContact("firefox-container-1");
  });

  it("does not request the pinned origin from the default container before the user chooses", async function() {
    await expectNoEarlyContact("firefox-default");
  });
});
