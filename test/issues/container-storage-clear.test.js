const {expect, initializeWithTab, nextTick} = require("../common");

/**
 * Stand-in for Firefox browsingData, built from the implementation this
 * extension runs on (strict_min_version 91.1.0; checked at Firefox 91.0.1
 * and Firefox 161.0.1).
 *
 * Removal with cookieStoreId is accepted only for cookies, indexedDB, and
 * (because next-gen localStorage is on by default) localStorage. Any other
 * data type rejects the whole call before anything is deleted:
 * toolkit/components/extensions/parent/ext-browsingData.js
 *   Firefox 161.0.1 lines 323-358
 *   Firefox 91.0.1 lines 308-343
 * removeIndexedDB is not exposed ("unsupported": true in
 * toolkit/components/extensions/schemas/browsing_data.json, filtered by
 * toolkit/components/extensions/Schemas.sys.mjs lines 2396-2398).
 * IndexedDB is removed only by browsingData.remove(..., {indexedDB: true}),
 * which clears quota client "idb" and not "ls" or "cache"
 * (dom/quota/nsIQuotaManagerService.idl lines 356-377,
 * dom/quota/QuotaManagerService.cpp lines 1306-1319,
 * dom/quota/Client.h lines 23-27, dom/quota/Client.cpp lines 29-59 and 148-175).
 * removeLocalStorage does not clear IndexedDB. With next-gen localStorage
 * (modules/libpref/init/StaticPrefList.yaml dom.storage.enable_unsupported_legacy_implementation
 * default false, so NextGenLocalStorageEnabled is true:
 * dom/localstorage/LocalStorageCommon.cpp lines 44-59), the
 * extension:purge-localStorage observer returns without deleting other stores
 * (dom/storage/StorageObserver.cpp lines 313-316).
 * Cache and service workers are not in the cookieStoreId allow-list, so this
 * stand-in rejects them and these tests do not require them to be removed.
 */

const DEFAULT_STORE = "firefox-default";
const PRIVATE_STORE = "firefox-private";
const CONTAINER_STORE = "firefox-container-";
const NEXT_GEN_LOCAL_STORAGE = true;
const CLIENT_INDEXED_DB = "idb";
const CLIENT_LOCAL_STORAGE = "ls";
const CLIENT_DOM_CACHE = "cache";

function createFirefoxBrowsingData(state) {
  function getCookieStoreIdForContainer(containerId) {
    return CONTAINER_STORE + containerId;
  }

  function getCookieStoreIdForOriginAttributes(originAttributes) {
    if (originAttributes.privateBrowsingId) {
      return PRIVATE_STORE;
    }
    if (originAttributes.userContextId) {
      return getCookieStoreIdForContainer(originAttributes.userContextId);
    }
    return DEFAULT_STORE;
  }

  function isPrivateCookieStoreId(storeId) {
    return storeId === PRIVATE_STORE;
  }

  function isDefaultCookieStoreId(storeId) {
    return storeId === DEFAULT_STORE;
  }

  function isContainerCookieStoreId(storeId) {
    return storeId !== null && storeId.startsWith(CONTAINER_STORE);
  }

  // Desktop path: ContextualIdentityService.getPublicIdentityFromId uses ==
  // (ContextualIdentityService.sys.mjs lines 853-860, Firefox 161.0.1).
  function getContainerForCookieStoreId(storeId) {
    if (!isContainerCookieStoreId(storeId)) {
      return null;
    }
    const containerId = storeId.substring(CONTAINER_STORE.length);
    const identity = state.publicIdentities.find(info => {
      return String(info.userContextId) === String(containerId) && info.public;
    });
    if (!identity) {
      return null;
    }
    return parseInt(containerId, 10);
  }

  function quotaMatches(record, options) {
    if (!["http", "https", "file"].includes(record.scheme)) {
      return false;
    }
    const storeId = getCookieStoreIdForOriginAttributes({
      userContextId: record.userContextId,
      privateBrowsingId: record.privateBrowsingId
    });
    const hostMatches = !options.hostnames || options.hostnames.includes(record.host);
    const storeMatches = !options.cookieStoreId || storeId === options.cookieStoreId;
    return hostMatches && storeMatches;
  }

  async function clearQuotaManager(options, clientType) {
    if (options.cookieStoreId === PRIVATE_STORE) {
      return;
    }
    if (clientType === CLIENT_INDEXED_DB) {
      state.indexedDbRemovalStarted = true;
    }
    if (state.blockers[clientType]) {
      await state.blockers[clientType];
    }
    state.quota = state.quota.filter(record => {
      if (record.clientType !== clientType) {
        return true;
      }
      return !quotaMatches(record, options);
    });
  }

  async function clearCookies(options) {
    if (state.blockers.cookies) {
      await state.blockers.cookies;
    }
    if (options.since || options.hostnames || options.cookieStoreId) {
      state.cookies = state.cookies.filter(cookie => {
        const createdAfter = !options.since || cookie.creationTime >= options.since * 1000;
        const host = cookie.host.replace(/^\./, "");
        const hostMatches = !options.hostnames || options.hostnames.includes(host);
        const storeMatches = !options.cookieStoreId ||
          getCookieStoreIdForOriginAttributes(cookie.originAttributes) === options.cookieStoreId;
        const remove = createdAfter && hostMatches && storeMatches;
        return !remove;
      });
      return;
    }
    state.cookies = [];
  }

  async function clearLocalStorage(options) {
    if (options.since) {
      return Promise.reject({
        message: "Firefox does not support clearing localStorage with 'since'."
      });
    }
    // extension:purge-localStorage is a no-op for other stores when
    // next-gen localStorage is enabled.
    if (NEXT_GEN_LOCAL_STORAGE) {
      return clearQuotaManager(options, CLIENT_LOCAL_STORAGE);
    }
    return undefined;
  }

  function handleRemoval(dataType, options) {
    switch (dataType) {
    case "cache":
      return Promise.reject({
        message: "cache removal is not modeled past the cookieStoreId rejection"
      });
    case "cookies":
      return clearCookies(options);
    case "indexedDB":
      return clearQuotaManager(options, CLIENT_INDEXED_DB);
    case "localStorage":
      return clearLocalStorage(options);
    case "serviceWorkers":
      return Promise.reject({
        message: "serviceWorkers removal is not modeled past the cookieStoreId rejection"
      });
    default:
      return undefined;
    }
  }

  function doRemoval(options, dataToRemove) {
    if (options.originTypes &&
        (options.originTypes.protectedWeb || options.originTypes.extension)) {
      return Promise.reject({
        message: "Firefox does not support protectedWeb or extension as originTypes."
      });
    }

    if (options.cookieStoreId) {
      const supportedTypes = ["cookies", "indexedDB"];
      if (NEXT_GEN_LOCAL_STORAGE) {
        supportedTypes.push("localStorage");
      }
      for (const dataType of Object.keys(dataToRemove)) {
        if (dataToRemove[dataType] && !supportedTypes.includes(dataType)) {
          return Promise.reject({
            message: `Firefox does not support clearing ${dataType} with 'cookieStoreId'.`
          });
        }
      }
      if (!isPrivateCookieStoreId(options.cookieStoreId) &&
          !isDefaultCookieStoreId(options.cookieStoreId) &&
          !getContainerForCookieStoreId(options.cookieStoreId)) {
        return Promise.reject({
          message: `Invalid cookieStoreId: ${options.cookieStoreId}`
        });
      }
    }

    const removalPromises = [];
    for (const dataType of Object.keys(dataToRemove)) {
      if (dataToRemove[dataType]) {
        const result = handleRemoval(dataType, options);
        if (result !== undefined) {
          removalPromises.push(result);
        }
      }
    }
    return Promise.all(removalPromises);
  }

  return {
    remove(options, dataToRemove) {
      return doRemoval(options, dataToRemove);
    },
    removeCache(options) {
      return doRemoval(options, {cache: true});
    },
    removeCookies(options) {
      return doRemoval(options, {cookies: true});
    },
    removeLocalStorage(options) {
      return doRemoval(options, {localStorage: true});
    }
  };
}

function installBrowsingData(browser, state) {
  const api = createFirefoxBrowsingData(state);
  const browsingData = browser.browsingData;
  for (const name of Object.keys(api)) {
    const stub = browsingData[name];
    if (stub && typeof stub.callsFake === "function") {
      stub.callsFake((...args) => api[name](...args));
    } else {
      browsingData[name] = (...args) => api[name](...args);
    }
  }
  // Firefox does not expose removeIndexedDB. A call must not pretend to clear.
  if (Object.prototype.hasOwnProperty.call(browsingData, "removeIndexedDB")) {
    browsingData.removeIndexedDB = undefined;
  }
}

function quotaValues(state, clientType, userContextId, host) {
  return state.quota
    .filter(record => {
      return record.clientType === clientType &&
        record.userContextId === userContextId &&
        record.host === host;
    })
    .map(record => record.value);
}

function cookieValues(state, userContextId, host) {
  return state.cookies
    .filter(cookie => {
      return cookie.originAttributes.userContextId === userContextId &&
        cookie.host === host;
    })
    .map(cookie => cookie.value);
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await nextTick();
  }
}

describe("clear container storage", function () {
  const originHost = "app.example";
  const targetUserContextId = 4;
  const otherUserContextId = 2;
  const sessionMarker = "container-session";
  const otherMarker = "other-container-session";

  beforeEach(async function () {
    this.webExt = await initializeWithTab();
    this.storage = {
      publicIdentities: [1, 2, 3, 4].map(userContextId => {
        return {userContextId, public: true};
      }),
      quota: [],
      cookies: [],
      blockers: {},
      indexedDbRemovalStarted: false
    };
    installBrowsingData(this.webExt.background.browser, this.storage);
    this.webExt.popup.browser.permissions.request.callsFake(async (request) => {
      return Boolean(request && request.permissions && request.permissions.includes("browsingData"));
    });

    const store = (clientType, userContextId, value) => {
      this.storage.quota.push({
        clientType,
        userContextId,
        privateBrowsingId: 0,
        scheme: "https",
        host: originHost,
        value
      });
    };
    for (const clientType of [CLIENT_INDEXED_DB, CLIENT_LOCAL_STORAGE, CLIENT_DOM_CACHE]) {
      store(clientType, targetUserContextId, sessionMarker);
      store(clientType, otherUserContextId, otherMarker);
    }
    for (const userContextId of [targetUserContextId, otherUserContextId]) {
      this.storage.cookies.push({
        host: originHost,
        name: "session",
        value: userContextId === targetUserContextId ? sessionMarker : otherMarker,
        path: "/",
        creationTime: 1,
        originAttributes: {userContextId, privateBrowsingId: 0}
      });
    }
    this.storage.serviceWorkers = [
      {host: originHost, userContextId: targetUserContextId, scope: `https://${originHost}/`}
    ];

    this.identity = {
      cookieStoreId: `firefox-container-${targetUserContextId}`,
      name: "Shopping",
      color: "pink",
      icon: "cart",
      hasHiddenTabs: false,
      hasOpenTabs: false,
      numberOfOpenTabs: 0
    };
    const popupWindow = this.webExt.popup.window;
    popupWindow.__identity = this.identity;
    const logicType = popupWindow.eval("typeof Logic");
    if (logicType !== "object") {
      throw new Error(`popup Logic binding was ${logicType}`);
    }
    await popupWindow.eval("Logic.showPanel('containerInfo', window.__identity)");
  });

  afterEach(function () {
    this.webExt.destroy();
  });

  async function confirmClear(webExt) {
    await webExt.popup.helper.clickElementById("clear-container-storage-info");
    await webExt.popup.helper.clickElementById("clear-container-storage-ok-link");
    await flush();
  }

  function successShown(webExt) {
    return Array.from(webExt.popup.document.querySelectorAll(".popup-notification-card"))
      .some(card => card.classList.contains("is-shown"));
  }

  it("removes the container IndexedDB session before reporting that storage was cleared", async function () {
    let releaseIndexedDb = () => {};
    this.storage.blockers[CLIENT_INDEXED_DB] = new Promise(resolve => {
      releaseIndexedDb = resolve;
    });

    await confirmClear(this.webExt);

    expect(
      this.storage.indexedDbRemovalStarted,
      "browsingData.remove must clear indexedDB for this container before success. " +
        `indexedDB=${JSON.stringify(quotaValues(this.storage, CLIENT_INDEXED_DB, targetUserContextId, originHost))} ` +
        `localStorage=${JSON.stringify(quotaValues(this.storage, CLIENT_LOCAL_STORAGE, targetUserContextId, originHost))} ` +
        `cookies=${JSON.stringify(cookieValues(this.storage, targetUserContextId, originHost))} ` +
        `successShown=${successShown(this.webExt)} ` +
        `otherIndexedDB=${JSON.stringify(quotaValues(this.storage, CLIENT_INDEXED_DB, otherUserContextId, originHost))}`
    ).to.equal(true);
    expect(
      successShown(this.webExt),
      "storageWasClearedConfirmation must wait until indexedDB removal finishes"
    ).to.equal(false);
    expect(
      quotaValues(this.storage, CLIENT_INDEXED_DB, targetUserContextId, originHost),
      "indexedDB session must still be present while its removal is in progress"
    ).to.deep.equal([sessionMarker]);

    releaseIndexedDb();
    await flush();

    expect(quotaValues(this.storage, CLIENT_INDEXED_DB, targetUserContextId, originHost))
      .to.deep.equal([]);
    expect(quotaValues(this.storage, CLIENT_LOCAL_STORAGE, targetUserContextId, originHost))
      .to.deep.equal([]);
    expect(cookieValues(this.storage, targetUserContextId, originHost))
      .to.deep.equal([]);
    expect(quotaValues(this.storage, CLIENT_INDEXED_DB, otherUserContextId, originHost))
      .to.deep.equal([otherMarker]);
    expect(quotaValues(this.storage, CLIENT_LOCAL_STORAGE, otherUserContextId, originHost))
      .to.deep.equal([otherMarker]);
    expect(cookieValues(this.storage, otherUserContextId, originHost))
      .to.deep.equal([otherMarker]);
    expect(successShown(this.webExt)).to.equal(true);
    const userContextId = this.webExt.popup.window.Utils.userContextId(this.identity.cookieStoreId);
    expect(userContextId).to.equal(targetUserContextId);
  });
});
