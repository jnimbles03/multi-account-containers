const {expect, buildBackgroundDom} = require("../common");

/*
 * Spec for container-switch interception.
 *
 * A main-frame navigation from a tab that is not in the assigned container
 * may open one replacement tab (the confirm page, or the target itself when
 * never-ask is set). Further main-frame navigations from that same tab must
 * not keep calling tabs.create:
 *   - while a replacement opened for that source tab and hostname is still
 *     open, another navigation to the same hostname creates nothing;
 *   - at most MAX_OPENS_PER_WINDOW replacements may be created for one
 *     source tab in any WINDOW_MS, even after those replacements are
 *     closed, and even when each navigation uses a different URL.
 * The cap is what stops a page from turning location changes into an
 * unbounded stream of tabs. It has to survive webRequest onErrorOccurred
 * and onCompleted, which today drop the only duplicate record, and the
 * two-second canceledRequests timeout.
 */

const MAX_OPENS_PER_WINDOW = 3;
const WINDOW_MS = 10000;
const NEW_TAB_GRACE_MS = 2000;
const ASSIGNED_ORIGIN = "https://shop.example";
const ATTACKER_URL = "https://evil.example/landing";

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assignedUrl(nonce) {
  return `${ASSIGNED_ORIGIN}/item/${nonce}?n=${nonce}#s${nonce}`;
}

function createdSince(browser, baseline) {
  return browser.tabs.create.getCalls().slice(baseline);
}

async function settleCreates(browser) {
  const pending = browser.tabs.create.getCalls().map((call) => call.returnValue);
  await Promise.all(pending);
  await delay(0);
}

/*
 * webextensions-api-fake tabs._navigate yields the real onBeforeRequest
 * listener and does not itself model a canceled channel. Firefox does:
 * WebRequest.sys.mjs calls channel.cancel(NS_ERROR_ABORT), and
 * ChannelWrapper::Cancel then ErrorCheck(), which dispatches the error
 * event that WebRequest maps to onErrorOccurred. Invoke that listener
 * with the canceled request so the extension's cleanup runs.
 */
async function finishCanceledRequest(browser, tabId, url) {
  const results = browser.webRequest.onErrorOccurred.addListener.yield({
    tabId,
    url,
    type: "main_frame",
    frameId: 0,
    error: "NS_ERROR_ABORT",
  });
  await Promise.all(results.map((result) => Promise.resolve(result)));
}

async function navigate(browser, tabId, url) {
  let source;
  try {
    source = await browser.tabs.get(tabId);
  } catch (error) {
    return {missingTab: true, error};
  }
  if (!source) {
    return {missingTab: true};
  }
  const results = await browser.tabs._navigate(tabId, url);
  const decision = await results.onBeforeRequest[0];
  if (decision && decision.cancel) {
    await finishCanceledRequest(browser, tabId, url);
  }
  await settleCreates(browser);
  return {decision, missingTab: false};
}

async function burst(browser, tabId, urls, {closeReplacements = false} = {}) {
  const baseline = browser.tabs.create.callCount;
  const decisions = [];
  for (const url of urls) {
    const before = browser.tabs.create.callCount;
    const outcome = await navigate(browser, tabId, url);
    decisions.push(outcome);
    if (outcome.missingTab) {
      break;
    }
    if (closeReplacements) {
      const opened = createdSince(browser, before);
      for (const call of opened) {
        const tab = await call.returnValue;
        await browser.tabs.remove(tab.id);
      }
    }
  }
  return {
    baseline,
    decisions,
    created: createdSince(browser, baseline),
  };
}

describe("unbounded container-switch tab creation", function () {
  this.timeout(20000);

  async function boot() {
    const webExt = await buildBackgroundDom();
    const {window} = webExt.background;
    // messageHandler is a top-level const, so it is not a window property.
    // A classic script on the background page can see that binding.
    const script = window.document.createElement("script");
    script.textContent = "window.__messageHandler = messageHandler;";
    window.document.body.appendChild(script);
    const {browser} = webExt;
    await browser.storage.local.set({
      replaceTabEnabled: false,
      "siteContainerMap@@_shop.example": {
        userContextId: "4",
        neverAsk: false,
      },
      "siteContainerMap@@_news.example": {
        userContextId: "4",
        neverAsk: false,
      },
    });
    return webExt;
  }

  function handler(webExt) {
    return webExt.background.window.__messageHandler;
  }

  // Drop the "just created" marker. The product itself clears it two
  // seconds after a tab is created; one test waits that timer out.
  function ageTab(webExt) {
    handler(webExt).lastCreatedTab = null;
  }

  describe("with an aged tab outside the assigned container", function () {
    let webExt;
    let browser;
    let background;
    let attackerTab;

    beforeEach(async function () {
      webExt = await boot();
      browser = webExt.browser;
      background = webExt.background;
      attackerTab = await browser.tabs._create({
        cookieStoreId: "firefox-default",
        url: ATTACKER_URL,
      });
      ageTab(webExt);
    });

    afterEach(async function () {
      await webExt.destroy();
    });

    it("still opens one confirmation tab for a single navigation", async function () {
      const baseline = browser.tabs.create.callCount;
      const outcome = await navigate(browser, attackerTab.id, assignedUrl(1));
      const created = createdSince(browser, baseline);

      expect(outcome.decision).to.deep.include({cancel: true});
      expect(created).to.have.lengthOf(1);
      expect(created[0].args[0].active).to.equal(true);
      expect(created[0].args[0].url).to.include("confirm-page.html");
      expect(created[0].args[0].url).to.include("shop.example");
      const source = await browser.tabs.get(attackerTab.id);
      expect(source.url).to.equal(ATTACKER_URL);
    });

    it("does not open another tab for each new query, path, or fragment", async function () {
      const urls = [];
      for (let n = 1; n <= 8; n++) {
        urls.push(assignedUrl(n));
      }
      const {created, decisions} = await burst(browser, attackerTab.id, urls);

      expect(decisions.every((outcome) => outcome.decision && outcome.decision.cancel)).to.equal(true);
      expect(created).to.have.lengthOf(1);
      expect(created.filter((call) => call.args[0].active === true)).to.have.lengthOf(1);
    });

    it("does not open another tab when the same URL is requested again after the error cleanup", async function () {
      const url = `${ASSIGNED_ORIGIN}/repeat`;
      const {created} = await burst(browser, attackerTab.id, [url, url, url]);

      expect(created).to.have.lengthOf(1);
    });

    it("does not open another tab after onCompleted runs for the source tab", async function () {
      await navigate(browser, attackerTab.id, assignedUrl(1));
      const completed = browser.webRequest.onCompleted.addListener.yield({
        tabId: attackerTab.id,
        url: assignedUrl(1),
        type: "main_frame",
        frameId: 0,
      });
      await Promise.all(completed.map((result) => Promise.resolve(result)));

      const baseline = browser.tabs.create.callCount;
      await navigate(browser, attackerTab.id, assignedUrl(2));

      expect(createdSince(browser, baseline)).to.have.lengthOf(0);
    });

    it("does not open another tab after the two-second canceled-request timeout", async function () {
      await navigate(browser, attackerTab.id, assignedUrl(1));
      await delay(NEW_TAB_GRACE_MS + 500);

      const baseline = browser.tabs.create.callCount;
      const outcome = await navigate(browser, attackerTab.id, assignedUrl(2));

      expect(outcome.missingTab).to.equal(false);
      expect(outcome.decision.cancel).to.equal(true);
      expect(createdSince(browser, baseline)).to.have.lengthOf(0);
    });

    it("allows at most three replacements in ten seconds once earlier ones are closed", async function () {
      const urls = [];
      for (let n = 1; n <= 5; n++) {
        urls.push(assignedUrl(n));
      }
      const {created} = await burst(browser, attackerTab.id, urls, {
        closeReplacements: true,
      });

      expect(created.length).to.be.at.most(MAX_OPENS_PER_WINDOW);
    });

    it("allows one more replacement after the ten-second window", async function () {
      this.timeout(WINDOW_MS + 10000);
      const first = [];
      for (let n = 1; n <= MAX_OPENS_PER_WINDOW; n++) {
        first.push(assignedUrl(n));
      }
      const opened = await burst(browser, attackerTab.id, first, {
        closeReplacements: true,
      });
      expect(opened.created.length).to.equal(MAX_OPENS_PER_WINDOW);

      await delay(WINDOW_MS + 1000);
      const baseline = browser.tabs.create.callCount;
      const outcome = await navigate(browser, attackerTab.id, assignedUrl(99));

      expect(outcome.decision.cancel).to.equal(true);
      expect(createdSince(browser, baseline)).to.have.lengthOf(1);
    });

    it("does not treat a second assigned hostname as the same open confirmation", async function () {
      const {created} = await burst(browser, attackerTab.id, [
        assignedUrl(1),
        "https://news.example/story?n=1",
      ]);

      expect(created).to.have.lengthOf(2);
    });

    it("does not intercept a tab that is already in the assigned container", async function () {
      const inside = await browser.tabs._create({
        cookieStoreId: "firefox-container-4",
        url: ATTACKER_URL,
      });
      ageTab(webExt);
      const baseline = browser.tabs.create.callCount;
      const outcome = await navigate(browser, inside.id, assignedUrl(1));

      expect(outcome.decision.cancel).to.equal(undefined);
      expect(createdSince(browser, baseline)).to.have.lengthOf(0);
    });

    it("does not intercept a tab the user exempted", async function () {
      background.window.assignManager.storageArea.setExempted(assignedUrl(1), attackerTab.id);
      const baseline = browser.tabs.create.callCount;
      const outcome = await navigate(browser, attackerTab.id, assignedUrl(1));

      expect(outcome.decision.cancel).to.equal(undefined);
      expect(createdSince(browser, baseline)).to.have.lengthOf(0);
    });
  });

  describe("when the assignment is set to never ask", function () {
    let webExt;
    let browser;
    let attackerTab;

    beforeEach(async function () {
      webExt = await boot();
      browser = webExt.browser;
      await browser.storage.local.set({
        "siteContainerMap@@_shop.example": {
          userContextId: "4",
          neverAsk: true,
        },
      });
      attackerTab = await browser.tabs._create({
        cookieStoreId: "firefox-default",
        url: ATTACKER_URL,
      });
      ageTab(webExt);
    });

    afterEach(async function () {
      await webExt.destroy();
    });

    it("does not open a new focused container tab for every location change", async function () {
      const urls = [];
      for (let n = 1; n <= 8; n++) {
        urls.push(assignedUrl(n));
      }
      const {created, decisions} = await burst(browser, attackerTab.id, urls);

      expect(decisions.every((outcome) => outcome.decision && outcome.decision.cancel)).to.equal(true);
      expect(created).to.have.lengthOf(1);
      expect(created[0].args[0].active).to.equal(true);
      expect(created[0].args[0].cookieStoreId).to.equal("firefox-container-4");
      expect(created[0].args[0].url).to.equal(assignedUrl(1));
    });
  });

  describe("when the current container is site-isolated", function () {
    let webExt;
    let browser;
    let lockedTab;

    beforeEach(async function () {
      webExt = await boot();
      browser = webExt.browser;
      // The attacker page itself has to be allowed in the locked container.
      // Otherwise the product closes that tab on its first load, and the
      // page never gets to navigate anywhere else.
      await browser.storage.local.set({
        "siteContainerMap@@_evil.example": {
          userContextId: "1",
          neverAsk: true,
        },
        "identitiesState@@_firefox-container-1": {
          hiddenTabs: [],
          macAddonUUID: "isolation-test-uuid",
          isIsolated: "locked",
        },
      });
      lockedTab = await browser.tabs._create({
        cookieStoreId: "firefox-container-1",
        url: ATTACKER_URL,
      });
      ageTab(webExt);
    });

    afterEach(async function () {
      await webExt.destroy();
    });

    it("does not open a default-container tab for every new URL on one host", async function () {
      const urls = [];
      for (let n = 1; n <= 8; n++) {
        urls.push(`https://unassigned.example/p?n=${n}`);
      }
      const {created, decisions} = await burst(browser, lockedTab.id, urls);

      expect(decisions.every((outcome) => outcome.decision && outcome.decision.cancel)).to.equal(true);
      expect(created).to.have.lengthOf(1);
      expect(created[0].args[0].cookieStoreId).to.equal("firefox-default");
      expect(created[0].args[0].active).to.equal(true);
    });

    it("caps replacements from one tab even when every navigation uses a new hostname", async function () {
      const urls = [];
      for (let n = 1; n <= 6; n++) {
        urls.push(`https://host-${n}.example/`);
      }
      const {created} = await burst(browser, lockedTab.id, urls, {
        closeReplacements: true,
      });

      expect(created.length).to.be.at.most(MAX_OPENS_PER_WINDOW);
    });
  });

  describe("after the new-tab grace timer", function () {
    let webExt;

    beforeEach(async function () {
      webExt = await boot();
    });

    afterEach(async function () {
      await webExt.destroy();
    });

    it("still caps location changes once the product has forgotten the tab was new", async function () {
      this.timeout(NEW_TAB_GRACE_MS + 15000);
      const {browser} = webExt;
      const attackerTab = await browser.tabs._create({
        cookieStoreId: "firefox-default",
        url: ATTACKER_URL,
      });
      expect(handler(webExt).lastCreatedTab.id).to.equal(attackerTab.id);

      await delay(NEW_TAB_GRACE_MS + 100);
      expect(handler(webExt).lastCreatedTab).to.equal(null);

      const urls = [];
      for (let n = 1; n <= 6; n++) {
        urls.push(assignedUrl(n));
      }
      const {created, decisions} = await burst(browser, attackerTab.id, urls);

      expect(decisions.every((outcome) => !outcome.missingTab)).to.equal(true);
      expect(created).to.have.lengthOf(1);
    });
  });

  describe("from two long-lived source tabs", function () {
    let webExt;

    beforeEach(async function () {
      webExt = await boot();
    });

    afterEach(async function () {
      await webExt.destroy();
    });

    it("allows each source tab its own confirmation", async function () {
      const {browser} = webExt;
      const first = await browser.tabs._create({
        cookieStoreId: "firefox-default",
        url: ATTACKER_URL,
      });
      const second = await browser.tabs._create({
        cookieStoreId: "firefox-default",
        url: "https://evil.example/other",
      });
      ageTab(webExt);

      const baseline = browser.tabs.create.callCount;
      await navigate(browser, first.id, assignedUrl(1));
      await navigate(browser, second.id, assignedUrl(2));

      expect(createdSince(browser, baseline)).to.have.lengthOf(2);
    });
  });
});
