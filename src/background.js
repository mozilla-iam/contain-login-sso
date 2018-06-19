// Param values from https://developer.mozilla.org/Add-ons/WebExtensions/API/contextualIdentities/create
const CONTAINER_NAME = "SSO Login";
const CONTAINER_COLOR = "red";
const CONTAINER_ICON = "briefcase";
const FIREFOX_DEFAULT_COOKIE_STORE = "firefox-default";

const SSO_DOMAINS = [
  "https://auth-dev.mozilla.auth0.com/*",
  "https://auth.mozilla.auth0.com/*",
  "https://auth.allizom.org/*",
  "https://auth.mozilla.com/*"
];

const SSO_CALLBACK_URL = "/login/callback";
const SSO_LDAP_LOGIN_URL = "/usernamepassword/login";

let SSOCookieStoreId = null;
let detectedDomains = [];

const canceledRequests = {};
const tabsWaitingToLoad = {};

function cancelRequest (tab, options) {
  // we decided to cancel the request at this point, register canceled request
  canceledRequests[tab.id] = {
    requestIds: {
      [options.requestId]: true
    },
    urls: {
      [options.url]: true
    }
  };

  // since webRequest onCompleted and onErrorOccurred are not 100% reliable
  // we register a timer here to cleanup canceled requests, just to make sure we don't
  // end up in a situation where certain urls in a tab.id stay canceled
  setTimeout(() => {
    if (canceledRequests[tab.id]) {
      delete canceledRequests[tab.id];
    }
  }, 2000);
}

function shouldCancelEarly (tab, options) {
  // we decided to cancel the request at this point
  if (!canceledRequests[tab.id]) {
    cancelRequest(tab, options);
  } else {
    let cancelEarly = false;
    if (canceledRequests[tab.id].requestIds[options.requestId] ||
        canceledRequests[tab.id].urls[options.url]) {
      // same requestId or url from the same tab
      // this is a redirect that we have to cancel early to prevent opening two tabs
      cancelEarly = true;
    }
    // register this requestId and url as canceled too
    canceledRequests[tab.id].requestIds[options.requestId] = true;
    canceledRequests[tab.id].urls[options.url] = true;
    if (cancelEarly) {
      return true;
    }
  }
  return false;
}

async function setupContainer () {
  const contexts = await browser.contextualIdentities.query({name: CONTAINER_NAME});
  if (contexts.length > 0) {
    SSOCookieStoreId = contexts[0].cookieStoreId;
  } else {
    const context = await browser.contextualIdentities.create({
      name: CONTAINER_NAME,
      color: CONTAINER_COLOR,
      icon: CONTAINER_ICON
    });
    SSOCookieStoreId = context.cookieStoreId;
  }
}

function reopenTab ({url, tab, cookieStoreId}) {
  console.log("Reopening tab in container: "+tab.id+" url: "+url);
  browser.tabs.create({
    url,
    cookieStoreId,
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId
  }).then(() => {
      browser.tabs.executeScript({
        code: "console.log('location:', window.location.href);"
      });
      browser.tabs.remove(tab.id);
  });
}

// Callback from listener to detect SSO logins
async function detectSSO (options) {
  const tab = await validUrlToDetectOrContain(options);
  if (tab === false) {
    return;
  }

  if ((options.url.endsWith(SSO_LDAP_LOGIN_URL)) && (options.method === "POST")) {
    if (tab.cookieStoreId !== SSOCookieStoreId) {
      // Get them SSO cookies and transfer them to our container
      moveDomainCookiesToStore(FIREFOX_DEFAULT_COOKIE_STORE, SSOCookieStoreId, options.url);

      // Get them original RP cookies and do the same
      let parsedOriginUrl = new URL(options.originUrl);
      let rpUrl = parsedOriginUrl.searchParams.get('redirect_uri');
      moveDomainCookiesToStore(FIREFOX_DEFAULT_COOKIE_STORE, SSOCookieStoreId, rpUrl);

      return containUrl(SSOCookieStoreId, tab, options, options.originUrl);
    }
  }
}

async function moveDomainCookiesToStore(fromStoreId, toStoreId, url) {
  // Copies cookies in fromStoreid to toStoreId then deletes them from fromStoreId
  let parsedUrl = new URL(url);
  // Get TLD + first domain
  let domainAndTld = parsedUrl.hostname.split('.').slice(2).join('.');

  const cookies = await browser.cookies.getAll({domain: domainAndTld});

  for (let cookie of cookies) {
    console.log("Moving cookie "+cookie.name+" from "+fromStoreId+" to "+toStoreId);
    // note that we do not set cookie.domain - i.e. all cookies are host-only cookies.
    browser.cookies.set({storeId: toStoreId, name: cookie.name, path: cookie.path,
      secure: cookie.secure, url: "https://"+cookie.domain+"/", value: cookie.value, httpOnly: cookie.httpOnly,
      firstPartyDomain: cookie.firstPartyDomain, expirationDate: cookie.expirationDate});
    browser.cookies.remove({storeId: fromStoreId, url: "https://"+cookie.domain+"/", name: cookie.name})
  }
}

async function validUrlToDetectOrContain(options) {
  // Generic checks to figure out if we want to handle this request or not, such as:
  // - is this from a tab? we don't care about other browser traffic.
  // - is this an incognito tab? we don't want to contain requests explicitly made incognito.
  if (options.tabId === -1) {
    return false;
  }
  if (tabsWaitingToLoad[options.tabId]) {
    // Cleanup just to make sure we don't get a race-condition with startup reopening
    delete tabsWaitingToLoad[options.tabId];
  }
  const tab = await browser.tabs.get(options.tabId);
  if (tab.incognito) {
    return false;
  }
  return tab;
}

// Contains a URL into our container
async function containUrl(cookieStoreId, tab, options, url) {
  // Called from listener callbacks
  if (shouldCancelEarly(tab, options)) {
    // We need to cancel early to prevent multiple reopenings
    return {cancel: true};
  }
  // Decided to contain
  reopenTab({
    url,
    tab,
    cookieStoreId
  });
  return {cancel: true};
}

(async function init () {
  try {
    await setupContainer();
  } catch (error) {
    // See https://github.com/mozilla/contain-facebook/issues/23
    // which apparently may run you into random issues
    console.log(error);
    return;
  }

  // Clean up canceled requests
  browser.webRequest.onCompleted.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: SSO_DOMAINS, types: ["main_frame", "xmlhttprequest"]});
  browser.webRequest.onErrorOccurred.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: SSO_DOMAINS, types: ["main_frame", "xmlhttprequest"]});

  browser.webRequest.onBeforeRequest.addListener(detectSSO, {urls: SSO_DOMAINS, types: ["main_frame", "xmlhttprequest"]}, ["blocking", "requestBody"]);
})();
