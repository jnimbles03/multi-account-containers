const {expect, initializeWithTab} = require("../common");

/**
 * Spec for unverified Firefox Sync records applied by sync.restore.
 * These tests fail while restore still treats remote deletions, retargeted
 * site assignments, and neverAsk as authoritative.
 */
describe("Unverified sync data must not retarget containers", function() {
  const pinnedUrl = "https://pinned.example/inbox";
  const siteKey = "siteContainerMap@@_pinned.example";
  const workCookieStoreId = "firefox-container-2";
  const personalCookieStoreId = "firefox-container-1";
  const workUserContextId = "2";
  const attackerContainerName = "Attacker Container";
  const attackerUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const workProxy = {
    type: "socks",
    host: "proxy.example",
    port: 1080
  };

  beforeEach(async function() {
    this.webExt = await initializeWithTab({
      cookieStoreId: "firefox-default",
      url: "about:blank"
    });
    this.browser = this.webExt.browser;
    this.background = this.webExt.background.window;
    await this.browser.storage.local.set({syncEnabled: true});
    await this.background.identityState.storageArea.upgradeData();
    await this.background.proxifiedContainers.set(workCookieStoreId, {
      type: workProxy.type,
      host: workProxy.host,
      port: workProxy.port
    });
    await this.background.assignManager.storageArea.set(pinnedUrl, {
      userContextId: workUserContextId,
      neverAsk: false
    }, false, false);
    await detachSyncListeners(this.background, this.browser);
    await this.background.sync.errorHandledRunSync();
    this.published = await this.browser.storage.sync.get();
    this.workUuid = uuidNamed(this.published, "Work");
    this.personalUuid = uuidNamed(this.published, "Personal");
    expect(this.workUuid, "backup published the Work container id").to.be.a("string");
    expect(this.personalUuid, "backup published the Personal container id").to.be.a("string");
    const publishedAssignment = this.published[siteKey];
    expect(publishedAssignment.identityMacAddonUUID).to.equal(this.workUuid);
    expect(publishedAssignment.neverAsk).to.equal(false);
  });

  afterEach(function() {
    this.webExt.destroy();
  });

  it("keeps the local pin when a sync change retargets it and sets never-ask", async function() {
    await this.browser.storage.sync.set({
      [siteKey]: {
        userContextId: "1",
        neverAsk: true,
        identityMacAddonUUID: this.personalUuid,
        hostname: "pinned.example"
      },
      deletedIdentityList: [this.workUuid]
    });
    this.browser.contextualIdentities.remove.resetHistory();
    this.browser.tabs.create.resetHistory();

    await deliverRemoteSyncChange(this.background);

    const assignment = await this.background.assignManager.storageArea.get(pinnedUrl);
    const workContainer = await this.browser.contextualIdentities.get(workCookieStoreId);
    const removedIds = this.browser.contextualIdentities.remove.getCalls()
      .map(call => call.args[0]);
    const problems = [];
    if (!workContainer || workContainer.name !== "Work") {
      problems.push("remote deletedIdentityList removed the local Work container");
    }
    if (removedIds.includes(workCookieStoreId)) {
      problems.push("contextualIdentities.remove ran for the Work container");
    }
    if (!assignment) {
      problems.push("local site assignment was deleted");
    } else {
      if (String(assignment.userContextId) !== workUserContextId) {
        problems.push(
          "site assignment userContextId is " + assignment.userContextId +
          " after remote retarget"
        );
      }
      if (assignment.identityMacAddonUUID !== this.workUuid) {
        problems.push("site assignment container id changed to the remote container");
      }
      if (assignment.neverAsk !== false) {
        problems.push("remote neverAsk was stored on the local assignment");
      }
    }
    expect(problems).to.deep.equal([]);
  });

  it("does not open the pinned site in the retargeted container without confirmation", async function() {
    await this.browser.storage.sync.set({
      [siteKey]: {
        userContextId: "1",
        neverAsk: true,
        identityMacAddonUUID: this.personalUuid,
        hostname: "pinned.example"
      }
    });
    await deliverRemoteSyncChange(this.background);

    const workTab = await this.browser.tabs.create({
      cookieStoreId: workCookieStoreId,
      url: "about:blank"
    });
    const personalTab = await this.browser.tabs.create({
      cookieStoreId: personalCookieStoreId,
      url: "about:blank"
    });
    const workDecision = await this.background.assignManager.handleProxifiedRequest({
      tabId: workTab.id,
      url: pinnedUrl
    });
    const personalDecision = await this.background.assignManager.handleProxifiedRequest({
      tabId: personalTab.id,
      url: pinnedUrl
    });
    expect(workDecision).to.include({
      type: workProxy.type,
      host: workProxy.host,
      port: workProxy.port
    });
    expect(personalDecision).to.deep.equal({});

    this.browser.tabs.create.resetHistory();
    await this.browser.tabs.create({
      cookieStoreId: "firefox-default",
      url: pinnedUrl
    }, {
      options: {
        webRequestError: true
      }
    });

    const created = this.browser.tabs.create.getCalls().slice(1).map(call => call.args[0]);
    const silentOpens = created.filter(props => props.url === pinnedUrl);
    const personalConfirms = created.filter(props =>
      typeof props.url === "string" &&
      props.url.includes("confirm-page.html") &&
      props.url.includes("cookieStoreId=" + personalCookieStoreId)
    );
    const problems = [];
    if (silentOpens.length !== 0) {
      const targets = silentOpens.map(props => props.cookieStoreId).join(",");
      problems.push("pinned site opened with no confirmation in " + targets);
    }
    for (const open of silentOpens) {
      if (open.cookieStoreId === personalCookieStoreId) {
        problems.push(
          "pinned site opened in the container whose proxy listener returns no proxy"
        );
      }
    }
    if (personalConfirms.length !== 0) {
      problems.push("confirmation page targeted the remote container");
    }
    expect(problems).to.deep.equal([]);
  });

  it("does not apply a remote never-ask flag to the existing assignment", async function() {
    await this.browser.storage.sync.set({
      [siteKey]: {
        userContextId: workUserContextId,
        neverAsk: true,
        identityMacAddonUUID: this.workUuid,
        hostname: "pinned.example"
      }
    });
    await deliverRemoteSyncChange(this.background);

    const assignment = await this.background.assignManager.storageArea.get(pinnedUrl);
    expect(String(assignment.userContextId)).to.equal(workUserContextId);
    expect(assignment.neverAsk).to.equal(false);

    this.browser.tabs.create.resetHistory();
    await this.browser.tabs.create({
      cookieStoreId: "firefox-default",
      url: pinnedUrl
    }, {
      options: {
        webRequestError: true
      }
    });
    const silentOpens = this.browser.tabs.create.getCalls()
      .slice(1)
      .map(call => call.args[0])
      .filter(props => props.url === pinnedUrl);
    expect(silentOpens).to.deep.equal([]);
  });

  it("does not delete a local pin listed only in the remote deleted site list", async function() {
    await this.browser.storage.sync.remove(siteKey);
    await this.browser.storage.sync.set({
      deletedSiteList: [siteKey]
    });
    const removeSpy = spyMethod(this.background.assignManager.storageArea, "remove");
    try {
      await deliverRemoteSyncChange(this.background);
      const removedPins = removeSpy.calls.filter(args =>
        args[0] === siteKey || args[0] === pinnedUrl
      );
      expect(removedPins).to.deep.equal([]);
      const assignment = await this.background.assignManager.storageArea.get(pinnedUrl);
      expect(assignment).to.be.an("object");
      expect(String(assignment.userContextId)).to.equal(workUserContextId);
      expect(assignment.neverAsk).to.equal(false);
    } finally {
      removeSpy.restore();
    }
  });

  it("ignores a sync container id and host the browser does not already have", async function() {
    await this.browser.storage.sync.set({
      ["identity@@_" + attackerUuid]: {
        name: attackerContainerName,
        color: "red",
        icon: "circle",
        cookieStoreId: "firefox-container-999",
        macAddonUUID: attackerUuid
      },
      [siteKey]: {
        userContextId: "999",
        neverAsk: true,
        identityMacAddonUUID: attackerUuid,
        hostname: "not-the-pinned-host.example"
      },
      "siteContainerMap@@_not-the-pinned-host.example": {
        userContextId: "999",
        neverAsk: true,
        identityMacAddonUUID: attackerUuid,
        hostname: "not-the-pinned-host.example"
      }
    });
    this.browser.contextualIdentities.create.resetHistory();

    await deliverRemoteSyncChange(this.background);

    const createdNames = this.browser.contextualIdentities.create.getCalls()
      .map(call => call.args[0].name);
    const containers = await this.browser.contextualIdentities.query({});
    const assignment = await this.background.assignManager.storageArea.get(pinnedUrl);
    const unknownAssignment = await this.background.assignManager.storageArea.get(
      "https://not-the-pinned-host.example/"
    );
    expect(createdNames).to.not.include(attackerContainerName);
    expect(containers.map(container => container.name)).to.not.include(attackerContainerName);
    expect(String(assignment.userContextId)).to.equal(workUserContextId);
    expect(assignment.neverAsk).to.equal(false);
    expect(unknownAssignment).to.equal(null);
  });
});

function uuidNamed(syncData, name) {
  for (const value of Object.values(syncData)) {
    if (value && value.name === name && value.macAddonUUID) {
      return value.macAddonUUID;
    }
  }
  return null;
}

async function detachSyncListeners(background, browser) {
  await browser.storage.onChanged.removeListener(
    background.sync.storageArea.onChangedListener
  );
  await background.sync.removeContextualIdentityListeners();
}

async function deliverRemoteSyncChange(background) {
  const syncApi = background.sync;
  const calls = [];
  const original = syncApi.errorHandledRunSync.bind(syncApi);
  syncApi.errorHandledRunSync = function errorHandledRunSync() {
    const promise = original();
    calls.push(promise);
    return promise;
  };
  try {
    syncApi.storageArea.onChangedListener({
      "siteContainerMap@@_pinned.example": {newValue: {}}
    }, "sync");
    if (calls.length !== 1) {
      throw new Error("storage.onChanged for the sync area did not start restore");
    }
    await calls[0];
  } finally {
    syncApi.errorHandledRunSync = original;
  }
}

function spyMethod(object, name) {
  const original = object[name];
  function tracking() {
    tracking.callCount += 1;
    tracking.calls.push(Array.from(arguments));
    return original.apply(this, arguments);
  }
  tracking.callCount = 0;
  tracking.calls = [];
  tracking.restore = () => {
    object[name] = original;
  };
  object[name] = tracking;
  return tracking;
}
