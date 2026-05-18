export {};

// Background service worker.
//
// Holds a per-tab circular buffer of captures in chrome.storage.session,
// updates the action badge with the count of failed requests, and responds
// to popup queries.
//
// TODO(m1-w2): replace LegacyCapture with the canonical CapturedEvent
// discriminated union from src/types/events.ts (PRD §6.1.2). This file is
// a like-for-like .js → .ts port; logic is unchanged.

const MAX_PER_TAB = 200;
const STORAGE_PREFIX = 'tab:';

interface LegacyCapture {
  id: string;
  type: 'fetch' | 'xhr';
  url: string;
  method: string;
  status: number;
  statusText?: string;
  startedAt: number;
  duration: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  error?: string | null;
  pageUrl?: string;
  pageTitle?: string;
  capturedAt?: number;
}

type IncomingMessage =
  | { type: 'CAPTURE'; payload: LegacyCapture; pageUrl?: string; pageTitle?: string }
  | { type: 'GET_CAPTURES'; tabId: number }
  | { type: 'CLEAR_CAPTURES'; tabId: number };

chrome.runtime.onMessage.addListener(
  (msg: IncomingMessage, sender, sendResponse): boolean | void => {
    if (msg.type === 'CAPTURE') {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      void handleCapture(tabId, msg.payload, msg.pageUrl, msg.pageTitle);
      return;
    }

    if (msg.type === 'GET_CAPTURES') {
      void getCaptures(msg.tabId).then(sendResponse);
      return true;
    }

    if (msg.type === 'CLEAR_CAPTURES') {
      void clearCaptures(msg.tabId).then(() => sendResponse(true));
      return true;
    }
  }
);

async function handleCapture(
  tabId: number,
  capture: LegacyCapture,
  pageUrl?: string,
  pageTitle?: string
): Promise<void> {
  const key = STORAGE_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  const existing = (stored[key] as LegacyCapture[] | undefined) ?? [];

  const enriched: LegacyCapture = { ...capture, pageUrl, pageTitle, capturedAt: Date.now() };
  const next = existing.concat(enriched).slice(-MAX_PER_TAB);

  await chrome.storage.session.set({ [key]: next });

  const failedCount = next.reduce((n, c) => n + (isFailed(c) ? 1 : 0), 0);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: failedCount > 0 ? String(failedCount) : '',
    });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  } catch {
    /* tab might be gone */
  }
}

async function getCaptures(tabId: number): Promise<LegacyCapture[]> {
  const key = STORAGE_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as LegacyCapture[] | undefined) ?? [];
}

async function clearCaptures(tabId: number): Promise<void> {
  const key = STORAGE_PREFIX + tabId;
  await chrome.storage.session.remove(key);
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    /* tab gone */
  }
}

function isFailed(c: LegacyCapture): boolean {
  return c.status >= 400 || c.status === 0 || !!c.error;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(STORAGE_PREFIX + tabId).catch(() => {});
});

chrome.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId === 0 && details.transitionType === 'reload') {
    void chrome.storage.session.remove(STORAGE_PREFIX + details.tabId).catch(() => {});
    void chrome.action.setBadgeText({ tabId: details.tabId, text: '' }).catch(() => {});
  }
});
