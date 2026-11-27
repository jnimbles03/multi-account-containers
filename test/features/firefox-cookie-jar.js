"use strict";

/**
 * In-memory stand-in for the Firefox cookie service steps that
 * browsingData.removeCookies and a later page load actually run.
 *
 * Deletion match, Firefox ESR 91 (strict_min_version) and the current
 * release branch, same condition:
 * toolkit/components/extensions/parent/ext-browsingData.js:112 (esr91)
 * and :105 (gecko-dev release):
 *   options.hostnames.includes(cookie.host.replace(/^\./, ""))
 * together with the cookieStoreId comparison against
 * getCookieStoreIdForOriginAttributes (ext-toolkit.js:53-78 on esr91).
 *
 * A later load of the site sends a cookie when GetCookiesForURI
 * (netwerk/cookie/CookieService.cpp:868, esr91) accepts it:
 *   host from nsIURI.host via GetHostOrIPv6WithBrackets
 *     (nsContentUtils.cpp:7469, nsIURI.idl:150; hostPort is the separate
 *     attribute at nsIURI.idl:143 and is not used)
 *   CookieCommons::DomainMatches (CookieCommons.cpp:36)
 *   Cookie::RawHost / IsDomain / Host (Cookie.h:65-79)
 *   secure check (CookieService.cpp:983)
 *   scheme SCHEME_UNSET is sent (CookieCommons.cpp:563)
 *   SameSite foreign check is skipped for a first-party load
 *     (CookieService.cpp:993, aIsSameSiteForeign false)
 *   httpOnly is sent on an HTTP-bound load (CookieService.cpp:1000)
 *   CookieCommons::PathMatches (CookieCommons.cpp:45, called at
 *     CookieService.cpp:1003)
 *   unexpired (CookieService.cpp:1008)
 */

const CONTAINER_STORE = "firefox-container-";
const SCHEME_UNSET = 0;

function cookieStoreIdForOriginAttributes(originAttributes) {
  if (originAttributes.privateBrowsingId) {
    return "firefox-private";
  }
  if (originAttributes.userContextId) {
    return CONTAINER_STORE + originAttributes.userContextId;
  }
  return "firefox-default";
}

function isDomain(cookie) {
  return cookie.host.charAt(0) === ".";
}

function rawHost(cookie) {
  return isDomain(cookie) ? cookie.host.slice(1) : cookie.host;
}

function domainMatches(cookie, host) {
  return rawHost(cookie) === host ||
    (isDomain(cookie) && host.endsWith(cookie.host));
}

function pathMatches(cookie, requestPath) {
  const cookiePath = cookie.path;
  if (!cookiePath) {
    return false;
  }
  if (cookiePath === requestPath) {
    return true;
  }
  const isPrefix = requestPath.startsWith(cookiePath);
  if (isPrefix && cookiePath.charAt(cookiePath.length - 1) === "/") {
    return true;
  }
  return isPrefix && requestPath.charAt(cookiePath.length) === "/";
}

function requestHost(pageUrl) {
  return new URL(pageUrl).hostname;
}

function createFirefoxCookieJar() {
  const cookies = [];
  const calls = [];

  async function removeCookies(options) {
    calls.push({
      hostnames: options.hostnames ? options.hostnames.slice() : null,
      cookieStoreId: options.cookieStoreId || null
    });

    if (!(options.since || options.hostnames || options.cookieStoreId)) {
      cookies.length = 0;
      return;
    }

    const snapshot = cookies.slice();
    for (const cookie of snapshot) {
      const hostMatches = !options.hostnames ||
        options.hostnames.includes(cookie.host.replace(/^\./, ""));
      const storeMatches = !options.cookieStoreId ||
        cookieStoreIdForOriginAttributes(cookie.originAttributes) ===
          options.cookieStoreId;
      const sinceMatches = !options.since ||
        cookie.creationTime >= options.since * 1000;
      if (hostMatches && storeMatches && sinceMatches) {
        const index = cookies.indexOf(cookie);
        if (index !== -1) {
          cookies.splice(index, 1);
        }
      }
    }
  }

  function sentOnVisit({url, userContextId}) {
    const page = new URL(url);
    const host = requestHost(url);
    const nowSeconds = Date.now() / 1000;
    const firstPartyHttpBound = true;
    return cookies.filter((cookie) => {
      if (cookie.originAttributes.userContextId !== userContextId) {
        return false;
      }
      if (!domainMatches(cookie, host)) {
        return false;
      }
      if (cookie.isSecure && page.protocol !== "https:") {
        return false;
      }
      if (cookie.schemeMap !== SCHEME_UNSET) {
        const schemeType = page.protocol === "https:" ? 0x02 : 0x01;
        if ((cookie.schemeMap & schemeType) === 0) {
          return false;
        }
      }
      if (!firstPartyHttpBound && cookie.isHttpOnly) {
        return false;
      }
      if (!pathMatches(cookie, page.pathname)) {
        return false;
      }
      if (cookie.expiry <= nowSeconds) {
        return false;
      }
      return true;
    });
  }

  return {
    cookies,
    calls,
    removeCookies,
    sentOnVisit,
    add(cookie) {
      cookies.push({
        host: cookie.host,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || "/",
        isSecure: !!cookie.isSecure,
        isHttpOnly: cookie.isHttpOnly !== false,
        schemeMap: SCHEME_UNSET,
        expiry: cookie.expiry || Math.floor(Date.now() / 1000) + 86400,
        creationTime: Date.now() * 1000,
        originAttributes: {
          privateBrowsingId: 0,
          userContextId: cookie.userContextId
        }
      });
    },
    install(browser) {
      browser.browsingData.removeCookies.callsFake(removeCookies);
    }
  };
}

module.exports = {
  createFirefoxCookieJar
};
