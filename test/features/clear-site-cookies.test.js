"use strict";

const {initializeWithTab, expect} = require("../common");
const {createFirefoxCookieJar} = require("./firefox-cookie-jar");

const CONTAINER_USER_CONTEXT_ID = 4;
const OTHER_USER_CONTEXT_ID = 1;
const COOKIE_STORE_ID = "firefox-container-" + CONTAINER_USER_CONTEXT_ID;

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for the clear-cookies handler");
}

async function assignSiteAndClearCookies(pageUrl) {
  const webExt = await initializeWithTab({
    cookieStoreId: "firefox-default",
    url: pageUrl
  });
  const jar = createFirefoxCookieJar();
  jar.install(webExt.background.browser);

  await webExt.popup.browser.runtime.sendMessage({
    method: "setOrRemoveAssignment",
    tabId: null,
    url: pageUrl,
    userContextId: CONTAINER_USER_CONTEXT_ID,
    value: false
  });

  const assignedHost = new URL(pageUrl).hostname;
  jar.add({
    host: assignedHost,
    name: "session",
    value: "signed-in",
    userContextId: CONTAINER_USER_CONTEXT_ID
  });
  jar.add({
    host: assignedHost,
    name: "session",
    value: "other-container",
    userContextId: OTHER_USER_CONTEXT_ID
  });
  jar.add({
    host: "other.example",
    name: "other",
    value: "keep",
    userContextId: CONTAINER_USER_CONTEXT_ID
  });

  const notices = [];
  // Top-level const bindings are visible to eval, not as window properties.
  const logic = webExt.popup.window.eval("Logic");
  const originalNotify = logic.notify.bind(logic);
  logic.notify = (options) => {
    notices.push(options);
    return originalNotify(options);
  };
  webExt.popup.browser.permissions.request.resolves(true);

  await logic.showPanel("containerAssignments", {
    name: "Shopping",
    cookieStoreId: COOKIE_STORE_ID,
    color: "pink",
    icon: "cart"
  }, false, false);

  const button = webExt.popup.document.querySelector(".reset-assignment");
  expect(button, "clear-cookies button for the assignment").to.not.equal(null);
  button.click();
  await waitFor(() => notices.length > 0);

  return {webExt, jar, notices, assignedHost};
}

function assertSiteCookiesCleared(pageUrl, result) {
  const requestedHosts = result.jar.calls.reduce((hosts, call) => {
    return hosts.concat(call.hostnames || []);
  }, []);

  expect(result.notices.map((notice) => notice.messageId)).to.eql([
    "cookiesClearedSuccess"
  ]);
  expect(
    result.jar.calls.every((call) => call.cookieStoreId === COOKIE_STORE_ID),
    "clear must name the container the user selected, saw " +
      JSON.stringify(result.jar.calls)
  ).to.equal(true);

  const stillSent = result.jar.sentOnVisit({
    url: pageUrl,
    userContextId: CONTAINER_USER_CONTEXT_ID
  });
  expect(
    stillSent.map((cookie) => cookie.name),
    "host-only cookies for " + pageUrl + " are still sent after clear; " +
      "removeCookies saw " + JSON.stringify(result.jar.calls)
  ).to.eql([]);
  expect(
    requestedHosts,
    "removeCookies must name the assigned host " + result.assignedHost +
      " for " + pageUrl + ", saw " + JSON.stringify(result.jar.calls)
  ).to.include(result.assignedHost);

  const otherContainer = result.jar.sentOnVisit({
    url: pageUrl,
    userContextId: OTHER_USER_CONTEXT_ID
  });
  expect(otherContainer.map((cookie) => cookie.value)).to.eql([
    "other-container"
  ]);

  const otherHost = result.jar.sentOnVisit({
    url: "https://other.example/",
    userContextId: CONTAINER_USER_CONTEXT_ID
  });
  expect(otherHost.map((cookie) => cookie.name)).to.eql(["other"]);
}

describe("Clear site cookies uses the assigned host", function () {
  this.timeout(20000);

  afterEach(function () {
    if (this.webExt) {
      this.webExt.destroy();
      this.webExt = null;
    }
  });

  async function clear(pageUrl) {
    const result = await assignSiteAndClearCookies(pageUrl);
    this.webExt = result.webExt;
    assertSiteCookiesCleared(pageUrl, result);
  }

  it("clears host-only cookies for an assigned www host", async function () {
    await clear.call(this, "https://www.example.com/");
  });

  it("clears host-only cookies for an assigned non-default port", async function () {
    await clear.call(this, "https://example.com:8443/");
  });

  it("clears host-only cookies for an assigned www host on a non-default port", async function () {
    await clear.call(this, "http://www.example.com:8080/");
  });

  it("clears host-only cookies for an assigned host with no www prefix and no explicit port", async function () {
    await clear.call(this, "https://example.com/");
  });
});
