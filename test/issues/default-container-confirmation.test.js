const fs = require("fs");
const path = require("path");
const {JSDOM} = require("jsdom");
const {implementation: LocationImpl} = require("jsdom/lib/jsdom/living/window/Location-impl.js");
const {buildDom, expect} = require("../common");

// jsdom does not navigate on location.replace. The confirm page calls that
// method, and Firefox navigates the document's own tab. Record the URL here
// and perform that main-frame navigation in the tab model below.
const originalLocationReplace = LocationImpl.prototype.replace;
LocationImpl.prototype.replace = function replaceDocument(url) {
  const hook = this._globalObject && this._globalObject.__confirmNavigation;
  if (typeof hook === "function") {
    hook(String(url));
    return;
  }
  return originalLocationReplace.call(this, url);
};

/*
 * Stand-in for Firefox tab creation and webRequest matching, built from the
 * versions this extension declares (strict_min_version 91.1.0) and still
 * present on ESR 140:
 *
 * - browser/components/extensions/parent/ext-tabs.js (esr91) sets
 *   options.userContextId only when createProperties.cookieStoreId is
 *   truthy, via getUserContextIdForCookieStoreId. A truthy openerTabId is
 *   passed through as openerBrowser. See lines 675-682, 731-735, and 781.
 * - toolkit/components/extensions/parent/ext-tabs-base.js (esr91) lines
 *   2267-2316: a non-container id, including "firefox-default", becomes
 *   DEFAULT_USER_CONTEXT_ID. caps/nsIScriptSecurityManager.idl line 289 sets
 *   that constant to 0. Omitted cookieStoreId leaves userContextId unset.
 * - browser/base/content/tabbrowser.js (esr91) lines 2613-2621 and 2648-2666:
 *   if userContextId == null and the opener tab exists, the new tab copies
 *   the opener's usercontextid. An explicit 0 does not inherit. ESR 140
 *   tabbrowser _createTab keeps the same check.
 * - toolkit/components/extensions/parent/ext-toolkit.js (esr91) lines 41-50
 *   and browser/components/extensions/parent/ext-browser.js line 819: a
 *   truthy userContextId is reported as firefox-container-N, otherwise
 *   firefox-default. ext-browser.js line 865 reports the selected tab as
 *   the only active tab. ext-tabs.js selects the created tab when active
 *   is true.
 * - toolkit/components/extensions/MatchPattern.cpp (esr91) lines 227-228 and
 *   262-264: <all_urls> is only http, https, ws, wss, file, ftp, and data.
 *   moz-extension confirm-page loads do not reach onBeforeRequest.
 */

const LOCKED_CONTAINER = "firefox-container-1";
const DEFAULT_CONTAINER = "firefox-default";
const ATTACKER_URL = "https://attacker.example/landing";
const ASSIGNED_URL = "https://assigned.example/target";
const PERMITTED_SCHEMES = /^(https?|wss?|file|ftp|data):/i;

let requestSerial = 0;

function userContextIdForCookieStoreId(cookieStoreId) {
  if (!cookieStoreId) {
    return null;
  }
  if (cookieStoreId === "firefox-default" || cookieStoreId === "firefox-private") {
    return 0;
  }
  if (cookieStoreId.startsWith("firefox-container-")) {
    return parseInt(cookieStoreId.slice("firefox-container-".length), 10);
  }
  return null;
}

function cookieStoreIdForUserContextId(userContextId) {
  if (userContextId) {
    return `firefox-container-${userContextId}`;
  }
  return DEFAULT_CONTAINER;
}

function firefoxAllUrlsMatches(url) {
  return PERMITTED_SCHEMES.test(url);
}

function installWebRequestSchemeFilter(browser) {
  for (const eventName of ["onBeforeRequest", "onCompleted", "onErrorOccurred"]) {
    const listener = browser.webRequest[eventName].addListener;
    const originalYield = listener.yield;
    listener.yield = function yieldIfPermitted(request) {
      if (request && request.url && !firefoxAllUrlsMatches(request.url)) {
        return [];
      }
      return originalYield.apply(listener, arguments);
    };
  }
}

async function resolveFirefoxCookieStoreId(browser, createProperties) {
  let userContextId = null;
  if (createProperties.cookieStoreId) {
    userContextId = userContextIdForCookieStoreId(createProperties.cookieStoreId);
  }

  let openerTab = null;
  if (createProperties.openerTabId !== null && createProperties.openerTabId !== undefined) {
    const tabs = await browser.tabs._query({});
    openerTab = tabs.find((tab) => tab.id === createProperties.openerTabId) || null;
  }

  if ((userContextId === null || userContextId === undefined) && openerTab) {
    const inherited = userContextIdForCookieStoreId(openerTab.cookieStoreId);
    userContextId = inherited || 0;
  }

  return cookieStoreIdForUserContextId(userContextId);
}

function installFirefoxTabBehavior(browser) {
  installWebRequestSchemeFilter(browser);
  const rawCreate = browser.tabs._create;

  async function firefoxTabsCreate(createProperties = {}, fake) {
    const properties = {
      ...createProperties,
      cookieStoreId: await resolveFirefoxCookieStoreId(browser, createProperties),
    };
    const tab = await rawCreate.call(browser.tabs, properties, fake);
    const active = (properties.active === null || properties.active === undefined)
      ? !properties.discarded
      : properties.active;
    if (active) {
      const tabs = await browser.tabs._query({});
      for (const other of tabs) {
        other.active = other.id === tab.id;
      }
    }
    return tab;
  }

  browser.tabs._create = firefoxTabsCreate;
  browser.tabs.create.callsFake(firefoxTabsCreate);
}

async function navigateMainFrame(browser, tabId, url) {
  const request = {
    frameId: 0,
    method: "GET",
    parentFrameId: -1,
    requestId: `req-${++requestSerial}`,
    tabId,
    timeStamp: Date.now(),
    type: "main_frame",
    url,
  };
  let decisions = [];
  if (firefoxAllUrlsMatches(url) &&
      browser.webRequest.onBeforeRequest.addListener.callCount) {
    const yielded = browser.webRequest.onBeforeRequest.addListener.yield(request);
    const pending = Array.isArray(yielded) ? yielded : [yielded];
    decisions = await Promise.all(pending);
  }
  const canceled = decisions.some((decision) => decision && decision.cancel);
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (tab && !canceled) {
    tab.url = url;
  }
  return {canceled, decisions, tab};
}

async function flushBackground() {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function readExtensionScript(relativePath) {
  return fs.readFileSync(path.join(__dirname, "../../src", relativePath), "utf8");
}

async function chooseNoContainer(browser, confirmTab) {
  const html = fs.readFileSync(path.join(__dirname, "../../src/confirm-page.html"), "utf8");
  const dom = new JSDOM(html, {
    url: confirmTab.url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const errors = [];
  dom.window.addEventListener("error", (event) => {
    errors.push(String(event.error || event.message));
  });
  dom.window.addEventListener("unhandledrejection", (event) => {
    errors.push(String(event.reason));
  });
  dom.window.browser = browser;
  dom.window.matchMedia = () => ({matches: false});
  browser.runtime.sendMessage.callsFake((message) => {
    const yielded = browser.runtime.onMessage.addListener.yield(message);
    const value = Array.isArray(yielded) ? yielded[0] : yielded;
    return Promise.resolve(value);
  });

  let replacedUrl = null;
  dom.window.__confirmNavigation = (nextUrl) => {
    replacedUrl = nextUrl;
  };

  dom.window.eval(readExtensionScript("js/utils.js"));
  dom.window.eval(readExtensionScript("js/confirm-page.js"));
  await flushBackground();

  const noContainerButton = dom.window.document.getElementById("deny-no-container");
  const stayButton = dom.window.document.getElementById("deny");
  const noContainerOffered = noContainerButton.style.display !== "none";
  const stayOffered = stayButton.style.display !== "none";
  // jsdom throws on form submission. The product handler calls preventDefault;
  // give the button an explicit type so the activation still runs that handler.
  noContainerButton.type = "button";
  noContainerButton.click();
  await flushBackground();

  let navigation = null;
  if (replacedUrl) {
    navigation = await navigateMainFrame(browser, confirmTab.id, replacedUrl);
  }
  dom.window.close();
  return {
    errors,
    navigation,
    noContainerOffered,
    replacedUrl,
    stayOffered,
  };
}

async function exemptedContainers(browser, backgroundWindow) {
  const tabs = await browser.tabs._query({});
  const exempted = backgroundWindow.assignManager.storageArea.exemptedTabs;
  const containers = [];
  for (const tabIds of Object.values(exempted)) {
    for (const tabId of tabIds) {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      containers.push(tab ? tab.cookieStoreId : "missing-tab");
    }
  }
  return containers;
}

describe("default-container confirmation inherits the opener container", function () {
  beforeEach(async function () {
    this.webExt = await buildDom({
      popup: false,
      background: {
        async afterBuild(background) {
          installFirefoxTabBehavior(background.browser);
          await background.browser.tabs._create({
            cookieStoreId: LOCKED_CONTAINER,
            url: "https://start.example/",
          });
        },
      },
    });
    this.browser = this.webExt.background.browser;
    this.backgroundWindow = this.webExt.background.window;
    const lockedTabs = await this.browser.tabs._query({cookieStoreId: LOCKED_CONTAINER});
    this.lockedTab = lockedTabs[0];
    await this.browser.storage.local.set({
      syncEnabled: false,
      replaceTabEnabled: false,
      "siteContainerMap@@_bank.example": {
        userContextId: "1",
        neverAsk: false,
      },
      "siteContainerMap@@_assigned.example": {
        userContextId: "2",
        neverAsk: false,
      },
    });
    const containerState = await this.backgroundWindow.identityState.storageArea.get(LOCKED_CONTAINER);
    containerState.isIsolated = "locked";
    await this.backgroundWindow.identityState.storageArea.set(LOCKED_CONTAINER, containerState);
  });

  afterEach(function () {
    this.webExt.destroy();
  });

  async function isolateAttackerTab() {
    // The locked tab is already open. The new-tab timer only treats the
    // tab site isolation creates, not this existing container tab, as disposable.
    this.backgroundWindow.eval("messageHandler.lastCreatedTab = null");
    const first = await navigateMainFrame(this.browser, this.lockedTab.id, ATTACKER_URL);
    expect(first.canceled, "locked container should push the unassigned site out").to.equal(true);
    await flushBackground();
    const tabs = await this.browser.tabs._query({});
    const attackerTabs = tabs.filter((tab) => tab.url === ATTACKER_URL);
    expect(attackerTabs, "site isolation opens the unassigned site once").to.have.length(1);
    expect(attackerTabs[0].cookieStoreId).to.equal(DEFAULT_CONTAINER);
    expect(attackerTabs[0].openerTabId).to.equal(this.lockedTab.id);
    return attackerTabs[0];
  }

  async function confirmAssignedSite(attackerTab) {
    const moved = await navigateMainFrame(this.browser, attackerTab.id, ASSIGNED_URL);
    expect(moved.canceled, "assigned site in the fresh default tab should be canceled").to.equal(true);
    await flushBackground();
    const tabs = await this.browser.tabs._query({});
    const confirmTabs = tabs.filter((tab) => {
      return typeof tab.url === "string" && tab.url.includes("confirm-page.html");
    });
    expect(confirmTabs, "confirmation tab").to.have.length(1);
    const choice = await chooseNoContainer(this.browser, confirmTabs[0]);
    await flushBackground();
    const after = await this.browser.tabs._query({});
    const loaded = after.filter((tab) => tab.url === ASSIGNED_URL);
    const exempted = await exemptedContainers(this.browser, this.backgroundWindow);
    return {choice, confirmTab: confirmTabs[0], loaded, exempted, after};
  }

  it("opens the no-container choice in firefox-default when a just-created default tab reaches an assigned site", async function () {
    const attackerTab = await isolateAttackerTab.call(this);
    const lastCreatedId = this.backgroundWindow.eval("messageHandler.lastCreatedTab && messageHandler.lastCreatedTab.id");
    expect(lastCreatedId).to.equal(attackerTab.id);
    const result = await confirmAssignedSite.call(this, attackerTab);

    expect({
      noContainerOffered: result.choice.noContainerOffered,
      stayOffered: result.choice.stayOffered,
      errors: result.choice.errors,
      replacedUrl: result.choice.replacedUrl,
      confirmationTab: result.confirmTab.cookieStoreId,
      assignedSiteTabs: result.loaded.map((tab) => tab.cookieStoreId),
      exempted: result.exempted,
      lockedContainerHasAssignedSite: result.after.some((tab) => {
        return tab.cookieStoreId === LOCKED_CONTAINER && tab.url === ASSIGNED_URL;
      }),
    }).to.deep.equal({
      noContainerOffered: true,
      stayOffered: false,
      errors: [],
      replacedUrl: ASSIGNED_URL,
      confirmationTab: DEFAULT_CONTAINER,
      assignedSiteTabs: [DEFAULT_CONTAINER],
      exempted: [DEFAULT_CONTAINER],
      lockedContainerHasAssignedSite: false,
    });
  });

  it("opens the no-container choice in firefox-default when replace-tab is enabled", async function () {
    const attackerTab = await isolateAttackerTab.call(this);
    this.backgroundWindow.eval("messageHandler.lastCreatedTab = null");
    await this.browser.storage.local.set({replaceTabEnabled: true});
    const result = await confirmAssignedSite.call(this, attackerTab);

    expect({
      confirmationTab: result.confirmTab.cookieStoreId,
      assignedSiteTabs: result.loaded.map((tab) => tab.cookieStoreId),
      exempted: result.exempted,
      replacedUrl: result.choice.replacedUrl,
    }).to.deep.equal({
      confirmationTab: DEFAULT_CONTAINER,
      assignedSiteTabs: [DEFAULT_CONTAINER],
      exempted: [DEFAULT_CONTAINER],
      replacedUrl: ASSIGNED_URL,
    });
  });

  it("opens the no-container choice in firefox-default when the default tab is still a new-tab page", async function () {
    const attackerTab = await isolateAttackerTab.call(this);
    this.backgroundWindow.eval("messageHandler.lastCreatedTab = null");
    attackerTab.url = "about:blank";
    const result = await confirmAssignedSite.call(this, attackerTab);

    expect({
      confirmationTab: result.confirmTab.cookieStoreId,
      assignedSiteTabs: result.loaded.map((tab) => tab.cookieStoreId),
      exempted: result.exempted,
      replacedUrl: result.choice.replacedUrl,
    }).to.deep.equal({
      confirmationTab: DEFAULT_CONTAINER,
      assignedSiteTabs: [DEFAULT_CONTAINER],
      exempted: [DEFAULT_CONTAINER],
      replacedUrl: ASSIGNED_URL,
    });
  });
});
