// Background service worker — central authority for the capture pipeline.
//
// Receives RawCapture envelopes from the ISOLATED-world bridge, wraps
// each into a full CapturedEvent (PRD §6.1.2) with id, sessionId,
// sequenceNumber, timestamp, tabId, page url, and persists to
// chrome.storage.local under the per-tab keys from PRD §6.1.3. Also
// runs the action-badge state machine.

import {
  appendEvent,
  clearSession,
  DEFAULT_MAX_EVENTS_PER_TAB,
  getOrCreateSession,
  readEvents,
} from '@/lib/storage';
import {
  isCaptureMessage,
  isClearEventsMessage,
  isGetEventsMessage,
  type CaptureRuntimeMessage,
  type RuntimeMessage,
} from '@/lib/runtime-messages';
import { isFailedNetwork, type CapturedEvent } from '@/types/events';

// In-memory monotonic sequence counter per session. Hydrated lazily on
// first capture after a service-worker wake-up; loss across wake-ups is
// acceptable because PRD §6.1.3 calls out "On browser restart: live
// session resets". Same applies to SW evictions in practice.
const sequenceCursor = new Map<string, number>();

chrome.runtime.onMessage.addListener(
  (msg: RuntimeMessage, sender, sendResponse): boolean | void => {
    if (isCaptureMessage(msg)) {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      void handleCapture(tabId, msg);
      return;
    }

    if (isGetEventsMessage(msg)) {
      void readEvents(msg.tabId).then(sendResponse);
      return true;
    }

    if (isClearEventsMessage(msg)) {
      void clearSession(msg.tabId)
        .then(() => clearBadge(msg.tabId))
        .then(() => sendResponse(true));
      return true;
    }
  }
);

async function handleCapture(tabId: number, msg: CaptureRuntimeMessage): Promise<void> {
  const origin = safeOrigin(msg.pageUrl);
  const session = await getOrCreateSession(tabId, origin);
  const sequenceNumber = nextSequence(session.sessionId);

  // The discriminator from RawCapture is identical to the CapturedEvent
  // EventType literal, so the construction below is type-safe by
  // narrowing on `msg.capture.type`.
  const baseEnvelope = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url: msg.pageUrl,
  };

  // CapturedEvent is a discriminated union over `type`. Building each
  // variant explicitly preserves TS's narrowing — the alternative (a
  // single `{ ...base, ...msg.capture }` spread) widens `data` to
  // `unknown`.
  let event: CapturedEvent;
  switch (msg.capture.type) {
    case 'network.fetch':
      event = { ...baseEnvelope, type: 'network.fetch', data: msg.capture.data };
      break;
    case 'network.xhr':
      event = { ...baseEnvelope, type: 'network.xhr', data: msg.capture.data };
      break;
    case 'network.websocket':
      event = { ...baseEnvelope, type: 'network.websocket', data: msg.capture.data };
      break;
    case 'network.sse':
      event = { ...baseEnvelope, type: 'network.sse', data: msg.capture.data };
      break;
    case 'console.error':
      event = { ...baseEnvelope, type: 'console.error', data: msg.capture.data };
      break;
    case 'console.warn':
      event = { ...baseEnvelope, type: 'console.warn', data: msg.capture.data };
      break;
    case 'console.info':
      event = { ...baseEnvelope, type: 'console.info', data: msg.capture.data };
      break;
    case 'console.unhandled':
      event = { ...baseEnvelope, type: 'console.unhandled', data: msg.capture.data };
      break;
    case 'action.click':
      event = { ...baseEnvelope, type: 'action.click', data: msg.capture.data };
      break;
    case 'action.input':
      event = { ...baseEnvelope, type: 'action.input', data: msg.capture.data };
      break;
    case 'navigation':
      event = { ...baseEnvelope, type: 'navigation', data: msg.capture.data };
      break;
    default: {
      const _exhaustive: never = msg.capture;
      void _exhaustive;
      return;
    }
  }

  const buffer = await appendEvent(tabId, event, DEFAULT_MAX_EVENTS_PER_TAB);
  await renderBadge(tabId, buffer);
}

function nextSequence(sessionId: string): number {
  const current = sequenceCursor.get(sessionId) ?? 0;
  const next = current + 1;
  sequenceCursor.set(sessionId, next);
  return next;
}

async function renderBadge(tabId: number, buffer: CapturedEvent[]): Promise<void> {
  const failedCount = buffer.reduce((n, e) => n + (isFailedNetwork(e) ? 1 : 0), 0);
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

async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    /* tab gone */
  }
}

function safeOrigin(pageUrl: string): string {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return pageUrl;
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle — drop session + buffer on close, also on full reload
// (PRD §6.1.3: live session resets on full reload).
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearSession(tabId).catch(() => {});
});

chrome.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId === 0 && details.transitionType === 'reload') {
    void clearSession(details.tabId).catch(() => {});
    void clearBadge(details.tabId).catch(() => {});
  }
});
