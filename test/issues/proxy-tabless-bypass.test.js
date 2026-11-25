const { expect, buildBackgroundDom } = require("../common");

/*
 * Stand-in for Firefox proxy routing, built from mozilla-firefox/firefox
 * revision 4a7b56cdc419768220e195d758c9e3e4852bc6b2 (2026-11-24).
 *
 * A service worker registered by a page is stored under that page's client
 * principal (ServiceWorkerManager.cpp:911, ClientInfo.cpp:108). The worker
 * keeps the principal's origin attributes, including userContextId
 * (RemoteWorkerChild.cpp:348), and its associated browsing context stays 0
 * (WorkerLoadInfo.cpp:88, WorkerPrivate.h:847). fetch() from that worker
 * passes that id (Fetch.cpp:802). FetchDriver only attaches a browsing
 * context when the id is non-zero (FetchDriver.cpp:670), so
 * ChannelWrapper::GetBrowserElement is null (ChannelWrapper.cpp:457-483).
 * ProxyChannelFilter then reports tabId -1 (ProxyChannelFilter.sys.mjs:384)
 * and cookieStoreId from those origin attributes
 * (ProxyChannelFilter.sys.mjs:349, ext-toolkit.js:46). The extension's
 * listener is registered for "<all_urls>", which includes https
 * (MatchPattern.cpp:83 and MatchPattern.cpp:252).
 *
 * The listener return value is validated (ProxyChannelFilter.sys.mjs:41-70).
 * An empty object has no type, so validation throws, the catch leaves the
 * proxy unset, and the filter keeps the default proxy
 * (ProxyChannelFilter.sys.mjs:432-454). A rejected listener takes the same
 * catch path. With no earlier proxy, that default is null. The channel then
 * connects with a null proxy (nsHttpChannel.cpp:8861 and
 * nsHttpChannel.cpp:8903, nsHttpConnectionInfo.cpp:92). HTTP proxies are
 * dialed at the proxy host (DnsAndConnectSocket.cpp:152). SOCKS proxies are
 * dialed at the proxy host (nsSOCKSIOLayer.cpp:425). A null or "direct"
 * proxy is dialed at the origin.
 */

const FIREFOX_PROXY_TYPES = Object.freeze({
  DIRECT: "direct",
  HTTPS: "https",
  PROXY: "http",
  HTTP: "http",
  SOCKS: "socks",
  SOCKS4: "socks4",
});

function cookieStoreIdForUserContext(userContextId) {
  if (userContextId) {
    return `firefox-container-${userContextId}`;
  }
  return "firefox-default";
}

function serviceWorkerProxyRequest({ userContextId, url }) {
  return {
    url,
    method: "GET",
    type: "xmlhttprequest",
    tabId: -1,
    cookieStoreId: cookieStoreIdForUserContext(userContextId),
    originUrl: undefined,
    documentUrl: undefined,
  };
}

function assertValidProxyData(proxyData) {
  if (proxyData.type && String(proxyData.type).toLowerCase() === "direct") {
    return { type: "direct" };
  }
  const type = proxyData.type;
  if (typeof type !== "string" ||
      !Object.prototype.hasOwnProperty.call(FIREFOX_PROXY_TYPES, type.toUpperCase())) {
    throw new Error(`Invalid proxy server type: "${type}"`);
  }
  if (typeof proxyData.host !== "string" || proxyData.host.length === 0 ||
      proxyData.host.includes(" ")) {
    throw new Error(`Invalid proxy server host: "${proxyData.host}"`);
  }
  const port = Number.parseInt(proxyData.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy server port: "${proxyData.port}"`);
  }
  if (proxyData.proxyDNS !== undefined && typeof proxyData.proxyDNS !== "boolean") {
    throw new Error(`Invalid proxyDNS value: "${proxyData.proxyDNS}"`);
  }
  if (proxyData.connectionIsolationKey !== undefined &&
      typeof proxyData.connectionIsolationKey !== "string") {
    throw new Error("Invalid proxy connection isolation key");
  }
  return {
    type: FIREFOX_PROXY_TYPES[type.toUpperCase()],
    host: proxyData.host,
    port,
    proxyDNS: proxyData.proxyDNS,
    connectionIsolationKey: proxyData.connectionIsolationKey,
  };
}

// defaultProxyInfo is null: no browser-wide proxy was configured. The only
// proxy the user turned on is the container proxy stored by this extension.
function firefoxConnection({ listenerResult, listenerError, originHost }) {
  let proxyInfo;
  try {
    if (listenerError) {
      throw listenerError;
    }
    const ret = listenerResult;
    if (ret === null || ret === undefined) {
      proxyInfo = ret;
    } else if (typeof ret !== "object") {
      throw new Error("proxyData must be an object or array of objects");
    } else {
      const list = Array.isArray(ret) ? ret : [ret];
      if (list.length === 0) {
        proxyInfo = null;
      } else if (list[0] === null || list[0] === undefined) {
        proxyInfo = null;
      } else {
        proxyInfo = assertValidProxyData(list[0]);
      }
    }
  } catch {
    proxyInfo = undefined;
  }
  const chosen = proxyInfo !== undefined ? proxyInfo : null;
  if (!chosen || chosen.type === "direct") {
    return { kind: "direct", host: originHost };
  }
  return {
    kind: "proxy",
    type: chosen.type,
    host: chosen.host,
    port: chosen.port,
    proxyDNS: chosen.proxyDNS,
    connectionIsolationKey: chosen.connectionIsolationKey,
  };
}

async function runRegisteredListener(listener, request) {
  try {
    const listenerResult = await listener(request);
    return { listenerResult };
  } catch (listenerError) {
    return { listenerError };
  }
}

describe("container proxy for tab-less requests", () => {
  const originHost = "attacker.example";
  const attackUrl = `https://${originHost}/collect`;

  beforeEach(async () => {
    this.background = await buildBackgroundDom();
    this.page = this.background.background;
    this.registered = [];
    this.background.browser.proxy = {
      onRequest: {
        addListener: (fn, filter) => {
          this.registered.push({ fn, filter });
        }
      }
    };
    this.page.window.assignManager.maybeAddProxyListeners();
    await this.background.browser.storage.local.set({
      proxifiedContainersKey: [
        {
          cookieStoreId: "firefox-container-4",
          proxy: {
            type: "http",
            host: "proxy.example",
            port: 8080,
          }
        },
        {
          cookieStoreId: "firefox-container-5",
          proxy: {
            type: "socks",
            host: "socks.example",
            port: 1080,
          }
        },
        {
          cookieStoreId: "firefox-container-6",
          proxy: {
            type: "socks4",
            host: "socks4.example",
            port: 1080,
          }
        },
        {
          cookieStoreId: "firefox-container-7",
          proxy: {
            type: "https",
            host: "vpn.example",
            port: 443,
            mozProxyEnabled: true,
          }
        }
      ]
    });
  });

  afterEach(() => {
    return this.page.destroy();
  });

  function listener() {
    expect(this.registered).to.have.lengthOf(1);
    expect(this.registered[0].filter).to.deep.equal({ urls: ["<all_urls>"] });
    expect(this.registered[0].fn).to.equal(
      this.page.window.assignManager.handleProxifiedRequest
    );
    return this.registered[0].fn;
  }

  async function connectionFor(request) {
    const outcome = await runRegisteredListener(listener.call(this), request);
    return firefoxConnection({
      listenerResult: outcome.listenerResult,
      listenerError: outcome.listenerError,
      originHost,
    });
  }

  it("registers the proxy listener for every url", () => {
    listener.call(this);
  });

  const proxiedContainers = [
    {
      userContextId: 4,
      type: "http",
      host: "proxy.example",
      port: 8080,
    },
    {
      userContextId: 5,
      type: "socks",
      host: "socks.example",
      port: 1080,
      proxyDNS: true,
    },
    {
      userContextId: 6,
      type: "socks4",
      host: "socks4.example",
      port: 1080,
      proxyDNS: true,
    },
    {
      userContextId: 7,
      type: "https",
      host: "vpn.example",
      port: 443,
      mozProxyEnabled: true,
    },
  ];

  proxiedContainers.forEach((configured) => {
    it(`sends a service-worker fetch in container ${configured.userContextId} through its ${configured.type} proxy`, async () => {
      const request = serviceWorkerProxyRequest({
        userContextId: configured.userContextId,
        url: attackUrl,
      });
      const route = await connectionFor.call(this, request);
      expect(route.kind).to.equal("proxy");
      expect(route.host).to.equal(configured.host);
      expect(route.type).to.equal(configured.type);
      expect(route.port).to.equal(configured.port);
      if (configured.proxyDNS) {
        expect(route.proxyDNS).to.equal(true);
      }
      if (configured.mozProxyEnabled) {
        expect(route.connectionIsolationKey).to.equal(
          String(this.page.window.MozillaVPN_Background.isolationKey)
        );
      }
      expect(route.host).to.not.equal(originHost);
    });
  });

  it("sends a tab-less fetch through the proxy named on the request when another container has a different proxy", async () => {
    const request = serviceWorkerProxyRequest({
      userContextId: 5,
      url: attackUrl,
    });
    const route = await connectionFor.call(this, request);
    expect(route).to.include({
      kind: "proxy",
      type: "socks",
      host: "socks.example",
      port: 1080,
      proxyDNS: true,
    });
  });

  it("still uses the container proxy when the tab lookup rejects", async () => {
    const request = serviceWorkerProxyRequest({
      userContextId: 4,
      url: attackUrl,
    });
    // The channel still carries the container, but the tab is already gone.
    request.tabId = 4242;
    const route = await connectionFor.call(this, request);
    expect(route).to.include({
      kind: "proxy",
      type: "http",
      host: "proxy.example",
      port: 8080,
    });
  });

  it("leaves a tab-less fetch direct when that container has no proxy", async () => {
    const request = serviceWorkerProxyRequest({
      userContextId: 9,
      url: attackUrl,
    });
    const route = await connectionFor.call(this, request);
    expect(route.kind).to.equal("direct");
    expect(route.host).to.equal(originHost);
  });

  it("keeps a tabbed request on the container proxy", async () => {
    const tab = await this.background.browser.tabs.create({
      cookieStoreId: "firefox-container-4",
      url: attackUrl,
    });
    const route = await connectionFor.call(this, {
      url: attackUrl,
      method: "GET",
      type: "main_frame",
      tabId: tab.id,
      cookieStoreId: tab.cookieStoreId,
    });
    expect(route).to.include({
      kind: "proxy",
      type: "http",
      host: "proxy.example",
      port: 8080,
    });
  });
});
