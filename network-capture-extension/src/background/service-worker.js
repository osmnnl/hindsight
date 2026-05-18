// src/background/service-worker.js
// Holds a per-tab circular buffer of captures in chrome.storage.session,
// updates the action badge with the count of failed requests, and responds
// to popup queries.

const MAX_PER_TAB = 200;
const STORAGE_PREFIX = 'tab:';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CAPTURE') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    handleCapture(tabId, msg.payload, msg.pageUrl, msg.pageTitle);
    return; // no response
  }

  if (msg.type === 'GET_CAPTURES') {
    getCaptures(msg.tabId).then(sendResponse);
    return true; // async
  }

  if (msg.type === 'CLEAR_CAPTURES') {
    clearCaptures(msg.tabId).then(() => sendResponse(true));
    return true;
  }
});

async function handleCapture(tabId, capture, pageUrl, pageTitle) {
  const key = STORAGE_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  const existing = stored[key] || [];

  const enriched = { ...capture, pageUrl, pageTitle, capturedAt: Date.now() };
  const next = existing.concat(enriched).slice(-MAX_PER_TAB);

  await chrome.storage.session.set({ [key]: next });

  const failedCount = next.reduce((n, c) => n + (isFailed(c) ? 1 : 0), 0);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: failedCount > 0 ? String(failedCount) : '',
    });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  } catch (e) { /* tab might be gone */ }
}

async function getCaptures(tabId) {
  const key = STORAGE_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || [];
}

async function clearCaptures(tabId) {
  const key = STORAGE_PREFIX + tabId;
  await chrome.storage.session.remove(key);
  try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}
}

function isFailed(c) {
  return c.status >= 400 || c.status === 0 || c.error;
}

// Clean up storage on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(STORAGE_PREFIX + tabId).catch(() => {});
});

// On full reload of a tab, also clear so old captures don't leak across navigations
chrome.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId === 0 && details.transitionType === 'reload') {
    chrome.storage.session.remove(STORAGE_PREFIX + details.tabId).catch(() => {});
    chrome.action.setBadgeText({ tabId: details.tabId, text: '' }).catch(() => {});
  }
});
