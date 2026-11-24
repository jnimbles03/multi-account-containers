const {expect, buildBackgroundDom} = require("../common");

/*
 * Site assignment is stored under siteContainerMap@@_<host>. These tests
 * drive the real background listener: a top-level navigation is given to
 * webRequest.onBeforeRequest, which calls storageArea.get / isExempted.
 * They fail while any address that merely contains the storage prefix is
 * treated as an already-built key, and they pass once every web URL is
 * keyed only by its normalized host (a value is an existing storage key
 * only when it starts with the prefix).
 */

const STORAGE_PREFIX = "siteContainerMap@@_";
const PINNED_HOST = "mail.example";
const PINNED_URL = `https://${PINNED_HOST}/inbox`;
const ASSIGNED_USER_CONTEXT_ID = "4";
const ASSIGNED_STORE = "firefox-container-4";
const OTHER_STORE = "firefox-container-1";
const DEFAULT_STORE = "firefox-default";

const QUERY_URL = `https://${PINNED_HOST}/inbox?continue=${STORAGE_PREFIX}`;
const PATH_URL = `https://${PINNED_HOST}/${STORAGE_PREFIX}/inbox`;
const EXPLICIT_443_URL = `https://${PINNED_HOST}:443/inbox?continue=${STORAGE_PREFIX}`;
const PORT_URL = `https://${PINNED_HOST}:8443/inbox`;
const PORTED_QUERY_URL = `https://${PINNED_HOST}:8443/inbox?continue=${STORAGE_PREFIX}`;

describe("container isolation when a navigated URL contains the storage prefix", function () {
  beforeEach(async function () {
    this.webExt = await buildBackgroundDom();
    this.browser = this.webExt.browser;
    this.assignManager = this.webExt.background.window.assignManager;
  });

  afterEach(async function () {
    await this.webExt.destroy();
  });

  async function send(browser, message) {
    const results = browser.runtime.onMessage.addListener.yield(message);
    await Promise.all(results);
  }

  async function pinHost(browser, pageUrl, userContextId = ASSIGNED_USER_CONTEXT_ID) {
    await send(browser, {
      method: "setOrRemoveAssignment",
      tabId: null,
      url: pageUrl,
      userContextId,
      value: false,
    });
  }

  async function rememberNeverAsk(assignManager, pageUrl, cookieStoreId) {
    // The confirm page calls _neverAsk, which stores through a promise it
    // does not return to the message listener.
    assignManager._neverAsk({
      neverAsk: true,
      pageUrl,
      cookieStoreId,
      defaultContainer: false,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      const stored = await assignManager.storageArea.get(pageUrl);
      if (stored && stored.neverAsk === true) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("neverAsk was not stored for the pinned host");
  }

  async function lockContainer(browser, cookieStoreId) {
    await send(browser, {
      method: "addRemoveSiteIsolation",
      cookieStoreId,
    });
  }

  async function navigate(browser, {url, cookieStoreId, redirects}) {
    const responses = {};
    const tab = await browser.tabs._create({
      url,
      cookieStoreId,
    }, {
      options: {
        webRequestError: true,
        webRequestRedirects: redirects || [],
      },
      responses,
    });
    const decisions = [];
    for (const result of responses.webRequest.onBeforeRequest) {
      decisions.push(await result);
    }
    return {tab, decisions};
  }

  function forgetCreates(browser) {
    browser.tabs.create.resetHistory();
  }

  function openedIn(browser, cookieStoreId, url) {
    return browser.tabs.create.getCalls().filter((call) => {
      const props = call.args[0] || {};
      if (props.cookieStoreId !== cookieStoreId) {
        return false;
      }
      if (url === undefined) {
        return true;
      }
      return props.url === url;
    });
  }

  function confirmPageFor(browser, assignedStore) {
    return browser.tabs.create.getCalls().filter((call) => {
      const props = call.args[0] || {};
      return typeof props.url === "string"
        && props.url.startsWith("moz-extension://fake/confirm-page.html?")
        && props.url.includes(`cookieStoreId=${assignedStore}`);
    });
  }

  describe("a host pinned from a normal URL", function () {
    beforeEach(async function () {
      await pinHost(this.browser, PINNED_URL);
      const stored = await this.assignManager.storageArea.get(PINNED_URL);
      expect(stored).to.include({
        userContextId: ASSIGNED_USER_CONTEXT_ID,
        neverAsk: false,
      });
      const all = await this.browser.storage.local.get();
      expect(all).to.have.property(`${STORAGE_PREFIX}${PINNED_HOST}`);
    });

    it("still reopens a normal top-level load in the assigned container", async function () {
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: PINNED_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      expect(openedIn(this.browser, DEFAULT_STORE)).to.have.lengthOf(0);
      expect(openedIn(this.browser, OTHER_STORE, PINNED_URL)).to.have.lengthOf(0);
    });

    it("reopens a top-level load whose query contains the storage prefix in the assigned container", async function () {
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: QUERY_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      const confirm = confirmPageFor(this.browser, ASSIGNED_STORE)[0].args[0];
      expect(confirm.url).to.include(encodeURIComponent(QUERY_URL));
      expect(openedIn(this.browser, OTHER_STORE, QUERY_URL)).to.have.lengthOf(0);
      expect(openedIn(this.browser, DEFAULT_STORE, QUERY_URL)).to.have.lengthOf(0);
    });

    it("reopens a top-level load whose path contains the storage prefix in the assigned container", async function () {
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: PATH_URL,
        cookieStoreId: DEFAULT_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)[0].args[0].url)
        .to.include(encodeURIComponent(PATH_URL));
      expect(openedIn(this.browser, DEFAULT_STORE, PATH_URL)).to.have.lengthOf(0);
    });

    it("reopens a :443 URL that embeds the storage prefix using the host assignment", async function () {
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: EXPLICIT_443_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      expect(openedIn(this.browser, OTHER_STORE, EXPLICIT_443_URL)).to.have.lengthOf(0);
    });

    it("follows a redirect onto a prefixed URL of the pinned host into the assigned container", async function () {
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: "https://attacker.example/go",
        cookieStoreId: OTHER_STORE,
        redirects: [QUERY_URL],
      });

      expect(decisions[0]).to.deep.equal({});
      expect(decisions[1]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)[0].args[0].url)
        .to.include(encodeURIComponent(QUERY_URL));
      expect(openedIn(this.browser, OTHER_STORE, QUERY_URL)).to.have.lengthOf(0);
    });

    it("keeps a prefixed URL of the pinned host inside its locked container", async function () {
      await lockContainer(this.browser, ASSIGNED_STORE);
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: QUERY_URL,
        cookieStoreId: ASSIGNED_STORE,
      });

      expect(decisions[0]).to.deep.equal({});
      expect(openedIn(this.browser, DEFAULT_STORE)).to.have.lengthOf(0);
      expect(this.browser.tabs.create).to.not.have.been.called;
    });

    it("moves an unassigned host out of a locked container into the default container", async function () {
      await lockContainer(this.browser, OTHER_STORE);
      forgetCreates(this.browser);
      const url = "https://unassigned.example/";
      const {decisions} = await navigate(this.browser, {
        url,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(openedIn(this.browser, DEFAULT_STORE, url)).to.have.lengthOf(1);
    });

    it("sends a prefixed URL of the pinned host to its assigned container when the current container is locked", async function () {
      await lockContainer(this.browser, OTHER_STORE);
      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: PATH_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      const confirms = confirmPageFor(this.browser, ASSIGNED_STORE);
      expect(confirms.length).to.be.at.least(1);
      expect(confirms[0].args[0].url).to.include(encodeURIComponent(PATH_URL));
      expect(openedIn(this.browser, DEFAULT_STORE, PATH_URL)).to.have.lengthOf(0);
      expect(openedIn(this.browser, OTHER_STORE, PATH_URL)).to.have.lengthOf(0);
    });

    it("opens a prefixed URL directly in the assigned container after never-ask was stored for that host", async function () {
      await rememberNeverAsk(this.assignManager, PINNED_URL, ASSIGNED_STORE);
      const stored = await this.assignManager.storageArea.get(QUERY_URL);
      expect(stored).to.include({
        userContextId: ASSIGNED_USER_CONTEXT_ID,
        neverAsk: true,
      });

      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: QUERY_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(openedIn(this.browser, ASSIGNED_STORE, QUERY_URL)).to.have.lengthOf(1);
      expect(openedIn(this.browser, OTHER_STORE, QUERY_URL)).to.have.lengthOf(0);
      expect(openedIn(this.browser, DEFAULT_STORE, QUERY_URL)).to.have.lengthOf(0);
    });

    it("treats an exemption recorded for the prefixed URL as an exemption for the host", async function () {
      const {tab} = await navigate(this.browser, {
        url: "https://attacker.example/",
        cookieStoreId: OTHER_STORE,
      });
      await send(this.browser, {
        method: "exemptContainerAssignment",
        tabId: tab.id,
        pageUrl: QUERY_URL,
      });

      expect(this.assignManager.storageArea.isExempted(PINNED_URL, tab.id)).to.equal(true);
      expect(this.assignManager.storageArea.isExempted(QUERY_URL, tab.id)).to.equal(true);
      expect(this.assignManager.storageArea.isExempted(PATH_URL, tab.id)).to.equal(true);

      forgetCreates(this.browser);
      const responses = {};
      await this.browser.tabs._update(tab.id, {url: PATH_URL}, {
        options: {webRequestError: true},
        responses,
      });
      const decisions = [];
      for (const result of responses.webRequest.onBeforeRequest) {
        decisions.push(await result);
      }

      expect(decisions[0]).to.deep.equal({});
      expect(this.browser.tabs.create).to.not.have.been.called;
    });

    it("clears a host exemption when the assignment is removed by its host URL", async function () {
      const {tab} = await navigate(this.browser, {
        url: "https://attacker.example/",
        cookieStoreId: OTHER_STORE,
      });
      await send(this.browser, {
        method: "exemptContainerAssignment",
        tabId: tab.id,
        pageUrl: PATH_URL,
      });
      await send(this.browser, {
        method: "setOrRemoveAssignment",
        tabId: null,
        url: PINNED_URL,
        userContextId: ASSIGNED_USER_CONTEXT_ID,
        value: true,
      });

      expect(this.assignManager.storageArea.isExempted(QUERY_URL, tab.id)).to.equal(false);
      expect(this.assignManager.storageArea.isExempted(PATH_URL, tab.id)).to.equal(false);
      expect(await this.assignManager.storageArea.get(QUERY_URL)).to.equal(null);
    });
  });

  describe("a host pinned while the address already contains the storage prefix", function () {
    it("pins the host, so a later normal URL opens in that container", async function () {
      await pinHost(this.browser, QUERY_URL);
      const stored = await this.assignManager.storageArea.get(PINNED_URL);
      expect(stored).to.include({
        userContextId: ASSIGNED_USER_CONTEXT_ID,
        neverAsk: false,
      });
      const all = await this.browser.storage.local.get();
      expect(all).to.not.have.property(QUERY_URL);

      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: PINNED_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
    });
  });

  describe("a non-default port", function () {
    it("keeps the port in the key for a prefixed URL on that port", async function () {
      await pinHost(this.browser, PORT_URL);
      const stored = await this.assignManager.storageArea.get(PORTED_QUERY_URL);
      expect(stored).to.include({userContextId: ASSIGNED_USER_CONTEXT_ID});

      forgetCreates(this.browser);
      const {decisions} = await navigate(this.browser, {
        url: PORTED_QUERY_URL,
        cookieStoreId: OTHER_STORE,
      });

      expect(decisions[0]).to.deep.equal({cancel: true});
      expect(confirmPageFor(this.browser, ASSIGNED_STORE)).to.have.lengthOf(1);
      expect(openedIn(this.browser, OTHER_STORE, PORTED_QUERY_URL)).to.have.lengthOf(0);
    });
  });

  describe("callers that already hold a storage key", function () {
    it("reads and deletes an assignment addressed by its storage key", async function () {
      await pinHost(this.browser, PINNED_URL);
      const key = `${STORAGE_PREFIX}${PINNED_HOST}`;

      const byKey = await this.assignManager.storageArea.get(key);
      expect(byKey).to.include({userContextId: ASSIGNED_USER_CONTEXT_ID});

      await this.assignManager.storageArea.set(key, {
        userContextId: ASSIGNED_USER_CONTEXT_ID,
        neverAsk: true,
      });
      expect(await this.assignManager.storageArea.get(PINNED_URL)).to.include({
        neverAsk: true,
      });

      await this.assignManager.storageArea.remove(key);
      expect(await this.assignManager.storageArea.get(PINNED_URL)).to.equal(null);
      expect(await this.assignManager.storageArea.get(QUERY_URL)).to.equal(null);
    });
  });
});
