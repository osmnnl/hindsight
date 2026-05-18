// Background service worker — central authority for the capture pipeline.
//
// Receives RawCapture envelopes from the ISOLATED-world bridge, applies
// the masking engine (PRD §11.2 — capture-time, never at export), drops
// blocklisted origins entirely, then wraps each into a full CapturedEvent
// (PRD §6.1.2) and persists to chrome.storage.local under the per-tab
// keys from PRD §6.1.3. Also runs the action-badge state machine.

import {
  appendEvent,
  bumpSessionSequence,
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
import {
  DEFAULT_BODY_RULES,
  DEFAULT_HEADER_RULES,
  maskBody,
  maskHeaders,
  tryCompilePattern,
  type BodyPatternRule,
} from '@/lib/masking';
import { readPrivacySettings, SettingsKeys, type CustomPatternSetting } from '@/lib/settings';
import {
  isFailedNetwork,
  type CapturedEvent,
  type EventMeta,
  type NetworkFetchData,
  type NetworkXhrData,
  type Redaction,
} from '@/types/events';

// In-memory monotonic sequence counter per session. The value mirrors
// SessionMetadata.lastSequence in chrome.storage.local — hydrated from
// the persisted record on each handleCapture so a service-worker
// eviction never restarts at 1 mid-session.
const sequenceCursor = new Map<string, number>();

// ---------------------------------------------------------------------------
// Privacy config cache — rehydrated on first use and invalidated when the
// user edits settings (chrome.storage.onChanged). Caching matters because
// every capture event hits this path; a chrome.storage.sync.get per event
// would noticeably tax the perf budget (PRD §13.1).
// ---------------------------------------------------------------------------

interface PrivacyConfig {
  bodyRules: BodyPatternRule[];
  blocklist: Set<string>;
}

let privacyConfigPromise: Promise<PrivacyConfig> | null = null;

function loadPrivacyConfig(): Promise<PrivacyConfig> {
  if (privacyConfigPromise) return privacyConfigPromise;
  privacyConfigPromise = (async () => {
    const settings = await readPrivacySettings();
    return {
      bodyRules: [...DEFAULT_BODY_RULES, ...compileCustomPatterns(settings.customPatterns)],
      blocklist: new Set(settings.blocklistedOrigins),
    };
  })();
  return privacyConfigPromise;
}

function compileCustomPatterns(patterns: CustomPatternSetting[]): BodyPatternRule[] {
  const rules: BodyPatternRule[] = [];
  for (const p of patterns) {
    const re = tryCompilePattern(p.source);
    if (!re) continue;
    const bodyScopes = p.scope.filter(
      (s): s is 'request.body' | 'response.body' => s === 'request.body' || s === 'response.body'
    );
    if (bodyScopes.length === 0) continue;
    rules.push({
      id: `user.${p.id}`,
      label: p.label || 'Custom pattern',
      scope: bodyScopes,
      kind: 'body-pattern',
      pattern: re,
    });
  }
  return rules;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && SettingsKeys.privacy in changes) {
    privacyConfigPromise = null;
  }
});

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

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
  const privacy = await loadPrivacyConfig();

  // Per-domain blocklist (PRD §6.6.1 "Per-domain 'never capture here'").
  // Dropped silently — the user explicitly told us to ignore this origin.
  if (privacy.blocklist.has(origin)) return;

  // Apply capture-time masking before envelope construction. The result
  // is a new RawCapture variant with masked data and a redaction list.
  const { capture, redactions } = applyMasking(msg.capture, privacy.bodyRules);

  const session = await getOrCreateSession(tabId, origin);
  const sequenceNumber = nextSequence(session.sessionId, session.lastSequence);

  const baseEnvelope = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url: msg.pageUrl,
  };
  const meta: EventMeta | undefined = redactions.length > 0 ? { redactions } : undefined;

  // CapturedEvent is a discriminated union over `type`. Building each
  // variant explicitly preserves TS's narrowing — the alternative (a
  // single `{ ...base, ...capture }` spread) widens `data` to `unknown`.
  let event: CapturedEvent;
  switch (capture.type) {
    case 'network.fetch':
      event = { ...baseEnvelope, type: 'network.fetch', data: capture.data, ...withMeta(meta) };
      break;
    case 'network.xhr':
      event = { ...baseEnvelope, type: 'network.xhr', data: capture.data, ...withMeta(meta) };
      break;
    case 'network.websocket':
      event = { ...baseEnvelope, type: 'network.websocket', data: capture.data, ...withMeta(meta) };
      break;
    case 'network.sse':
      event = { ...baseEnvelope, type: 'network.sse', data: capture.data, ...withMeta(meta) };
      break;
    case 'console.error':
      event = { ...baseEnvelope, type: 'console.error', data: capture.data, ...withMeta(meta) };
      break;
    case 'console.warn':
      event = { ...baseEnvelope, type: 'console.warn', data: capture.data, ...withMeta(meta) };
      break;
    case 'console.info':
      event = { ...baseEnvelope, type: 'console.info', data: capture.data, ...withMeta(meta) };
      break;
    case 'console.unhandled':
      event = { ...baseEnvelope, type: 'console.unhandled', data: capture.data, ...withMeta(meta) };
      break;
    case 'action.click':
      event = { ...baseEnvelope, type: 'action.click', data: capture.data, ...withMeta(meta) };
      break;
    case 'action.input':
      event = { ...baseEnvelope, type: 'action.input', data: capture.data, ...withMeta(meta) };
      break;
    case 'navigation':
      event = { ...baseEnvelope, type: 'navigation', data: capture.data, ...withMeta(meta) };
      break;
    default: {
      const _exhaustive: never = capture;
      void _exhaustive;
      return;
    }
  }

  const buffer = await appendEvent(tabId, event, DEFAULT_MAX_EVENTS_PER_TAB);
  await bumpSessionSequence(tabId, sequenceNumber);
  await renderBadge(tabId, buffer);
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

interface MaskedResult {
  capture: CaptureRuntimeMessage['capture'];
  redactions: Redaction[];
}

function applyMasking(
  capture: CaptureRuntimeMessage['capture'],
  bodyRules: BodyPatternRule[]
): MaskedResult {
  // Only network.fetch / network.xhr carry the request/response shape we
  // mask today. Other types (console, action, navigation) pass through
  // unchanged; their masking lives in their own capture sites when those
  // event families land.
  if (capture.type !== 'network.fetch' && capture.type !== 'network.xhr') {
    return { capture, redactions: [] };
  }

  const data: NetworkFetchData | NetworkXhrData = capture.data;
  const reqH = maskHeaders(data.request.headers, 'request.headers', DEFAULT_HEADER_RULES);
  const respH = maskHeaders(data.response.headers, 'response.headers', DEFAULT_HEADER_RULES);
  const reqB = maskBody(data.request.body, 'request.body', bodyRules);
  const respB = maskBody(data.response.body, 'response.body', bodyRules);

  const maskedData: NetworkFetchData = {
    request: { ...data.request, headers: reqH.headers, body: reqB.body },
    response: { ...data.response, headers: respH.headers, body: respB.body },
    timing: data.timing,
    error: data.error,
  };

  const redactions = [
    ...reqH.redactions,
    ...respH.redactions,
    ...reqB.redactions,
    ...respB.redactions,
  ];

  if (capture.type === 'network.fetch') {
    return { capture: { type: 'network.fetch', data: maskedData }, redactions };
  }
  return { capture: { type: 'network.xhr', data: maskedData }, redactions };
}

function withMeta(meta: EventMeta | undefined): { meta?: EventMeta } {
  return meta ? { meta } : {};
}

// ---------------------------------------------------------------------------
// Sequence + badge helpers
// ---------------------------------------------------------------------------

function nextSequence(sessionId: string, persistedFloor: number): number {
  // Take the higher of "what we have in memory" and "what storage says" so
  // a fresh service-worker wake-up resumes the persisted counter, and
  // back-to-back captures within the same wake-up keep advancing it.
  const current = Math.max(sequenceCursor.get(sessionId) ?? 0, persistedFloor);
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
