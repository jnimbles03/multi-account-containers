const {expect, nextTick, buildBackgroundDom} = require("../common");

/*
 * Site assignments are stored and enforced by assignManager.storageArea.getSiteStoreKey.
 * These tests describe the behavior of that key: a host and port must not share a rule
 * with a different host, and a port is omitted only when it is the default for that scheme.
 * They fail while the key is the hostname with the port digits appended and no separator.
 */

const CONTAINER_ID = "4";
const CONTAINER = "firefox-container-4";
const OTHER_CONTAINER_ID = "1";
const OTHER_CONTAINER = "firefox-container-1";

async function send(background, message) {
  const [promise] = background.browser.runtime.onMessage.addListener.yield(message);
  await promise;
}

async function assignSite(background, url, userContextId) {
  await send(background, {
    method: "setOrRemoveAssignment",
    tabId: null,
    url,
    userContextId,
    value: false
  });
}

async function unassignSite(background, url, userContextId) {
  await send(background, {
    method: "setOrRemoveAssignment",
    tabId: null,
    url,
    userContextId,
    value: true
  });
}

async function lockContainer(background, cookieStoreId) {
  await send(background, {
    method: "addRemoveSiteIsolation",
    cookieStoreId
  });
}

async function rememberNeverAsk(background, pageUrl, cookieStoreId) {
  await send(background, {
    method: "neverAsk",
    neverAsk: true,
    pageUrl,
    cookieStoreId
  });
  const storage = background.window.assignManager.storageArea;
  let settings = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    settings = await storage.get(pageUrl);
    if (settings && settings.neverAsk === true) {
      return settings;
    }
    await nextTick();
  }
  return settings;
}

async function openAndDecide(background, details) {
  background.browser.tabs.create.resetHistory();
  background.browser.tabs.remove.resetHistory();
  const responses = {};
  const tab = await background.browser.tabs._create(details, {
    responses,
    options: {
      // The fake browser still emits completion events after a blocking
      // cancel removes the tab. Skip those so the assertion is the decision.
      webRequestDontYield: ["onUpdated", "onCompleted", "onErrorOccurred"]
    }
  });
  const decisions = await Promise.all(responses.webRequest.onBeforeRequest || []);
  return {
    tab,
    decisions,
    created: background.browser.tabs.create.getCalls().map((call) => call.args[0])
  };
}

function opensInContainer(created, url, cookieStoreId) {
  return created.filter((props) => {
    return props && props.cookieStoreId === cookieStoreId && props.url === url;
  });
}

function mentionsHostInContainer(created, host, cookieStoreId) {
  return created.filter((props) => {
    if (!props || !props.url) {
      return false;
    }
    const url = String(props.url);
    const targetsContainer = props.cookieStoreId === cookieStoreId || url.includes(cookieStoreId);
    return targetsContainer && url.includes(host);
  });
}

describe("site assignment host and port identity", function () {
  let extension;
  let background;

  before(async function () {
    extension = await buildBackgroundDom();
    background = extension.background;
  });

  after(function () {
    extension.destroy();
  });

  beforeEach(async function () {
    await background.browser.storage.local.clear();
    await background.browser.storage.sync.clear();
    const assignManager = background.window.assignManager;
    assignManager.storageArea.exemptedTabs = {};
    assignManager.canceledRequests = {};
  });

  describe("storage identity", function () {
    it("keeps http://10.0.0.1:23 distinct from http://10.0.0.123 and http://10.0.0.12:3", async function () {
      const storage = background.window.assignManager.storageArea;
      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);

      const assigned = await storage.get("http://10.0.0.1:23/");
      expect(assigned).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://10.0.0.123/")).to.equal(null);
      expect(await storage.get("http://10.0.0.12:3/")).to.equal(null);

      const listed = await storage.getAssignedSites(CONTAINER_ID);
      const labels = Object.values(listed).map((site) => site.hostname);
      expect(labels).to.not.include("10.0.0.123");

      await assignSite(background, "http://10.0.0.123/", OTHER_CONTAINER_ID);
      await assignSite(background, "http://10.0.0.12:3/", "2");

      expect(await storage.get("http://10.0.0.1:23/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://10.0.0.123/")).to.have.property("userContextId", OTHER_CONTAINER_ID);
      expect(await storage.get("http://10.0.0.12:3/")).to.have.property("userContextId", "2");
    });

    it("keeps http://192.168.1.1:81 distinct from http://192.168.1.181", async function () {
      const storage = background.window.assignManager.storageArea;
      await assignSite(background, "http://192.168.1.1:81/", CONTAINER_ID);

      expect(await storage.get("http://192.168.1.1:81/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://192.168.1.181/")).to.equal(null);
      expect(await storage.get("http://192.168.1.18:1/")).to.equal(null);

      await assignSite(background, "http://192.168.1.181/", OTHER_CONTAINER_ID);
      expect(await storage.get("http://192.168.1.1:81/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://192.168.1.181/")).to.have.property("userContextId", OTHER_CONTAINER_ID);
    });

    it("keeps a hostname distinct from the same characters with a port glued on", async function () {
      const storage = background.window.assignManager.storageArea;
      await assignSite(background, "http://app.internal:8080/", CONTAINER_ID);

      expect(await storage.get("http://app.internal:8080/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://app.internal8080/")).to.equal(null);
      expect(await storage.get("http://app.internal/")).to.equal(null);

      await assignSite(background, "http://app.internal8080/", OTHER_CONTAINER_ID);
      expect(await storage.get("http://app.internal:8080/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://app.internal8080/")).to.have.property("userContextId", OTHER_CONTAINER_ID);
    });

    it("omits a port only when it is the default for that scheme", async function () {
      const storage = background.window.assignManager.storageArea;
      await assignSite(background, "https://mail.example/", CONTAINER_ID);
      await assignSite(background, "http://files.example/", OTHER_CONTAINER_ID);

      expect(await storage.get("https://mail.example:443/")).to.have.property("userContextId", CONTAINER_ID);
      expect(await storage.get("http://mail.example:443/")).to.equal(null);
      expect(await storage.get("https://mail.example:80/")).to.equal(null);

      expect(await storage.get("http://files.example:80/")).to.have.property("userContextId", OTHER_CONTAINER_ID);
      expect(await storage.get("https://files.example:80/")).to.equal(null);
      expect(await storage.get("http://files.example:443/")).to.equal(null);
    });

    it("does not delete an assignment when a colliding url is removed", async function () {
      const storage = background.window.assignManager.storageArea;
      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);
      await unassignSite(background, "http://10.0.0.123/", CONTAINER_ID);
      await unassignSite(background, "http://10.0.0.12:3/", CONTAINER_ID);

      expect(await storage.get("http://10.0.0.1:23/")).to.have.property("userContextId", CONTAINER_ID);

      await unassignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);
      expect(await storage.get("http://10.0.0.1:23/")).to.equal(null);
    });

    it("does not exempt a tab whose host only collides with the assigned host and port", async function () {
      const storage = background.window.assignManager.storageArea;
      const assignedTab = await background.browser.tabs._create({
        cookieStoreId: OTHER_CONTAINER,
        url: "http://10.0.0.1:23/"
      });
      const collidingTab = await background.browser.tabs._create({
        cookieStoreId: "firefox-container-2",
        url: "http://10.0.0.123/"
      });
      const gluedPortTab = await background.browser.tabs._create({
        cookieStoreId: "firefox-container-3",
        url: "http://10.0.0.12:3/"
      });

      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);

      expect(storage.isExempted("http://10.0.0.1:23/", assignedTab.id)).to.equal(true);
      expect(storage.isExempted("http://10.0.0.123/", collidingTab.id)).to.equal(false);
      expect(storage.isExempted("http://10.0.0.12:3/", gluedPortTab.id)).to.equal(false);
      expect(storage.isExempted("http://10.0.0.1:23/", collidingTab.id)).to.equal(false);

      storage.setExempted("http://10.0.0.1:23/", 4242);
      expect(storage.isExempted("http://10.0.0.1:23/", 4242)).to.equal(true);
      expect(storage.isExempted("http://10.0.0.123/", 4242)).to.equal(false);
      storage.removeExempted("http://10.0.0.123/");
      expect(storage.isExempted("http://10.0.0.1:23/", 4242)).to.equal(true);
      storage.removeExempted("http://10.0.0.1:23/");
      expect(storage.isExempted("http://10.0.0.1:23/", 4242)).to.equal(false);
    });
  });

  describe("request enforcement", function () {
    async function expectEjectedToDefault(background, url, fromCookieStoreId) {
      const {decisions, created} = await openAndDecide(background, {
        cookieStoreId: fromCookieStoreId,
        url
      });
      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(opensInContainer(created, url, "firefox-default")).to.have.lengthOf(1);
      expect(mentionsHostInContainer(created, new URL(url).hostname, fromCookieStoreId)).to.deep.equal([]);
    }

    async function expectStaysInContainer(background, url, cookieStoreId) {
      const {decisions, created} = await openAndDecide(background, {
        cookieStoreId,
        url
      });
      expect(decisions[0]).to.deep.equal({});
      expect(created).to.deep.equal([]);
    }

    it("does not let a colliding host stay in a container locked to http://10.0.0.1:23", async function () {
      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);
      await lockContainer(background, CONTAINER);

      const state = await background.window.identityState.storageArea.get(CONTAINER);
      expect(state.isIsolated).to.equal("locked");

      await expectStaysInContainer(background, "http://10.0.0.1:23/", CONTAINER);
      await expectEjectedToDefault(background, "http://10.0.0.1/", CONTAINER);
      await expectEjectedToDefault(background, "http://10.0.0.1:80/", CONTAINER);
      await expectEjectedToDefault(background, "http://10.0.0.123/", CONTAINER);
      await expectEjectedToDefault(background, "http://10.0.0.12:3/", CONTAINER);
      await expectEjectedToDefault(background, "http://10.9.9.9/", CONTAINER);
    });

    it("does not let http://192.168.1.181 stay in a container locked to http://192.168.1.1:81", async function () {
      await assignSite(background, "http://192.168.1.1:81/", CONTAINER_ID);
      await lockContainer(background, CONTAINER);

      await expectStaysInContainer(background, "http://192.168.1.1:81/", CONTAINER);
      await expectEjectedToDefault(background, "http://192.168.1.181/", CONTAINER);
      await expectEjectedToDefault(background, "http://192.168.1.18:1/", CONTAINER);
    });

    it("does not let a glued hostname stay in a container locked to the host and port", async function () {
      await assignSite(background, "http://app.internal:8080/", CONTAINER_ID);
      await lockContainer(background, CONTAINER);

      await expectStaysInContainer(background, "http://app.internal:8080/", CONTAINER);
      await expectEjectedToDefault(background, "http://app.internal8080/", CONTAINER);
    });

    it("does not treat http on port 443 or https on port 80 as the other scheme's assignment", async function () {
      await assignSite(background, "https://mail.example/", CONTAINER_ID);
      await lockContainer(background, CONTAINER);

      await expectStaysInContainer(background, "https://mail.example/", CONTAINER);
      await expectStaysInContainer(background, "https://mail.example:443/", CONTAINER);
      await expectEjectedToDefault(background, "http://mail.example:443/", CONTAINER);
      await expectEjectedToDefault(background, "https://mail.example:80/", CONTAINER);

      await background.browser.storage.local.clear();
      background.window.assignManager.storageArea.exemptedTabs = {};
      background.window.assignManager.canceledRequests = {};
      await assignSite(background, "http://files.example/", CONTAINER_ID);
      await lockContainer(background, CONTAINER);

      await expectStaysInContainer(background, "http://files.example/", CONTAINER);
      await expectStaysInContainer(background, "http://files.example:80/", CONTAINER);
      await expectEjectedToDefault(background, "https://files.example:80/", CONTAINER);
      await expectEjectedToDefault(background, "http://files.example:443/", CONTAINER);
    });

    it("does not open a colliding host in the always-open container", async function () {
      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);
      const neverAsk = await rememberNeverAsk(background, "http://10.0.0.1:23/", CONTAINER);
      expect(neverAsk).to.have.property("neverAsk", true);

      const exact = await openAndDecide(background, {
        cookieStoreId: "firefox-default",
        url: "http://10.0.0.1:23/"
      });
      expect(exact.decisions[0]).to.deep.equal({cancel: true});
      expect(opensInContainer(exact.created, "http://10.0.0.1:23/", CONTAINER)).to.have.lengthOf(1);

      for (const url of ["http://10.0.0.123/", "http://10.0.0.12:3/"]) {
        const opened = await openAndDecide(background, {
          cookieStoreId: "firefox-default",
          url
        });
        expect(opened.decisions[0], url).to.deep.equal({});
        expect(mentionsHostInContainer(opened.created, new URL(url).hostname, CONTAINER), url).to.deep.equal([]);
      }
    });

    it("does not auto-open a colliding host when always-open still asks for confirmation", async function () {
      await assignSite(background, "http://192.168.1.1:81/", CONTAINER_ID);

      const exact = await openAndDecide(background, {
        cookieStoreId: "firefox-default",
        url: "http://192.168.1.1:81/"
      });
      expect(exact.decisions[0]).to.deep.equal({cancel: true});
      expect(mentionsHostInContainer(exact.created, "192.168.1.1", CONTAINER)).to.not.deep.equal([]);

      const colliding = await openAndDecide(background, {
        cookieStoreId: "firefox-default",
        url: "http://192.168.1.181/"
      });
      expect(colliding.decisions[0]).to.deep.equal({});
      expect(mentionsHostInContainer(colliding.created, "192.168.1.181", CONTAINER)).to.deep.equal([]);
    });

    it("does not let an exempted colliding tab stay in a locked container", async function () {
      const storage = background.window.assignManager.storageArea;
      const collidingTab = await background.browser.tabs._create({
        cookieStoreId: OTHER_CONTAINER,
        url: "http://10.0.0.123/"
      });
      await assignSite(background, "http://10.0.0.1:23/", CONTAINER_ID);
      await lockContainer(background, OTHER_CONTAINER);
      expect(storage.isExempted("http://10.0.0.123/", collidingTab.id)).to.equal(false);

      background.browser.tabs.create.resetHistory();
      const responses = {};
      await background.browser.tabs._update(collidingTab.id, {
        url: "http://10.0.0.123/"
      }, {
        responses,
        options: {
          webRequestDontYield: ["onUpdated", "onCompleted", "onErrorOccurred"]
        }
      });
      const decisions = await Promise.all(responses.webRequest.onBeforeRequest || []);
      const created = background.browser.tabs.create.getCalls().map((call) => call.args[0]);

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(opensInContainer(created, "http://10.0.0.123/", "firefox-default")).to.have.lengthOf(1);
      expect(mentionsHostInContainer(created, "10.0.0.123", OTHER_CONTAINER)).to.deep.equal([]);
      expect(mentionsHostInContainer(created, "10.0.0.123", CONTAINER)).to.deep.equal([]);
    });
  });
});
