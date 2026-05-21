// Background service worker — central authority for the capture pipeline.
//
// Receives RawCapture envelopes from the ISOLATED-world bridge, applies
// the masking engine (PRD §11.2 — capture-time, never at export), drops
// blocklisted origins entirely, then wraps each into a full CapturedEvent
// (PRD §6.1.2) and persists to chrome.storage.local under the per-tab
// keys from PRD §6.1.3. Also runs the action-badge state machine.

import {
  archiveSession,
  clearArchive,
  clearSession,
  getOrCreateSession,
  queueEvent,
  readArchive,
  readEvents,
  sweepArchive,
} from '@/lib/storage';
import {
  isCaptureMessage,
  isClearArchiveMessage,
  isClearEventsMessage,
  isGetArchiveMessage,
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
import { detect } from '@/lib/detection';
import {
  DEFAULT_CAPTURE_SETTINGS,
  DEFAULT_DETECTION_SETTINGS,
  readCaptureSettings,
  readDetectionSettings,
  readPrivacySettings,
  SettingsKeys,
  type CaptureSettings,
  type CustomPatternSetting,
  type DetectionSettings,
} from '@/lib/settings';
import {
  isErrorEvent,
  type CapturedEvent,
  type EventMeta,
  type EventType,
  type NavigationData,
  type NavigationEvent,
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

// Capture settings cache. Invalidated on chrome.storage.onChanged for
// settings/capture so the user toggling Tier 2 / changing the buffer
// cap takes effect on the next event without an SW restart.
let captureConfigPromise: Promise<CaptureSettings> | null = null;

function loadCaptureConfig(): Promise<CaptureSettings> {
  if (captureConfigPromise) return captureConfigPromise;
  captureConfigPromise = readCaptureSettings().catch(() => ({ ...DEFAULT_CAPTURE_SETTINGS }));
  return captureConfigPromise;
}

// Detection settings cache. Invalidated on chrome.storage.onChanged for
// settings/detection. Controls the smart-detection master switch + the
// notifications policy.
let detectionConfigPromise: Promise<DetectionSettings> | null = null;

function loadDetectionConfig(): Promise<DetectionSettings> {
  if (detectionConfigPromise) return detectionConfigPromise;
  detectionConfigPromise = readDetectionSettings().catch(() => ({
    ...DEFAULT_DETECTION_SETTINGS,
  }));
  return detectionConfigPromise;
}

// Per-session notification dedup. Keyed by sessionId + ruleId so a
// 20-failure cascade only notifies once (OQ-M3-G first-per-session
// resolution; 'every' frequency bypasses this check).
const notifiedThisSession = new Map<string, Set<string>>();

const TIER_2_TYPES: ReadonlySet<EventType> = new Set([
  'network.websocket',
  'console.warn',
  'console.info',
  'action.click',
  'action.input',
]);

function isTier2(type: EventType): boolean {
  return TIER_2_TYPES.has(type);
}

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
  if (area === 'sync' && SettingsKeys.capture in changes) {
    captureConfigPromise = null;
  }
  if (area === 'sync' && SettingsKeys.detection in changes) {
    detectionConfigPromise = null;
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

    if (isGetArchiveMessage(msg)) {
      void readArchive().then(sendResponse);
      return true;
    }

    if (isClearArchiveMessage(msg)) {
      void clearArchive().then(() => sendResponse(true));
      return true;
    }
  }
);

async function handleCapture(tabId: number, msg: CaptureRuntimeMessage): Promise<void> {
  const origin = safeOrigin(msg.pageUrl);
  const privacy = await loadPrivacyConfig();
  const captureCfg = await loadCaptureConfig();

  // Per-domain blocklist (PRD §6.6.1 "Per-domain 'never capture here'").
  // Dropped silently — the user explicitly told us to ignore this origin.
  if (privacy.blocklist.has(origin)) return;

  // Tier 2 toggle. OQ-M2-J: only NEW captures are filtered — existing
  // buffer stays untouched. Tier 1 cannot be disabled per PRD §6.1.1.
  if (!captureCfg.tier2Enabled && isTier2(msg.capture.type)) return;

  // Apply capture-time masking before envelope construction. The result
  // is a new RawCapture variant with masked data and a redaction list.
  const { capture, redactions: swRedactions } = applyMasking(msg.capture, privacy.bodyRules);
  // Merge with redactions the page-world already applied (form-field
  // masking, for instance, lives at the DOM site because that's where
  // FormFieldMeta is visible).
  const allRedactions = [...(msg.redactions ?? []), ...swRedactions];

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
  const meta: EventMeta | undefined =
    allRedactions.length > 0 ? { redactions: allRedactions } : undefined;

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
    case 'performance.longtask':
      event = {
        ...baseEnvelope,
        type: 'performance.longtask',
        data: capture.data,
        ...withMeta(meta),
      };
      break;
    case 'performance.cls':
      event = {
        ...baseEnvelope,
        type: 'performance.cls',
        data: capture.data,
        ...withMeta(meta),
      };
      break;
    default: {
      const _exhaustive: never = capture;
      void _exhaustive;
      return;
    }
  }

  // Detection engine — stamp meta.flags + meta.cascadeOf based on the
  // recent buffer before persistence (PRD §6.2.1). The buffer query is
  // cheap thanks to W6-1's in-memory cache in storage.ts.
  const detectionCfg = await loadDetectionConfig();
  if (detectionCfg.smartDetectionEnabled) {
    const recentBuffer = await readEvents(tabId);
    const detection = detect(event, recentBuffer);
    if (detection.flags.length > 0 || detection.cascadeOf) {
      const existingMeta: EventMeta = event.meta ?? {};
      event.meta = {
        ...existingMeta,
        ...(detection.flags.length > 0
          ? { flags: [...(existingMeta.flags ?? []), ...detection.flags] }
          : {}),
        ...(detection.cascadeOf ? { cascadeOf: detection.cascadeOf } : {}),
      };
      // Desktop notifications (PRD §6.2.2). Only the cascade-head moment
      // triggers — cascade-member fires are quiet by design.
      if (detectionCfg.notificationsEnabled && detection.flags.includes('cascade-head')) {
        void notifyCascade(event, session.sessionId, detectionCfg).catch(() => {});
      }
    }
  }

  const buffer = await queueEvent(tabId, event, sequenceNumber, captureCfg.maxEventsPerTab);
  await renderBadge(tabId, buffer);

  // Tier 3 screenshot on error (PRD §6.1.1) — fire-and-forget. Caps at
  // one screenshot per tab per 2 s; failures are silent (some pages
  // can't be captured, that's fine).
  if (isErrorEvent(event)) {
    void maybeCaptureScreenshot(tabId, event, session, captureCfg).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Screenshot on error (PRD §6.1.1 Tier 3, §6.2.1 white-screen heuristic
// adjacent). chrome.tabs.captureVisibleTab is throttled by Chrome to
// roughly 2 per second per window; we add our own 2-second per-tab gate
// so simultaneous bursts don't queue.
// ---------------------------------------------------------------------------

const SCREENSHOT_MIN_INTERVAL_MS = 2000;
const screenshotLastShotAt = new Map<number, number>();

async function notifyCascade(
  event: CapturedEvent,
  sessionId: string,
  cfg: DetectionSettings
): Promise<void> {
  if (cfg.notificationFrequency === 'first-per-session') {
    let perSession = notifiedThisSession.get(sessionId);
    if (!perSession) {
      perSession = new Set();
      notifiedThisSession.set(sessionId, perSession);
    }
    if (perSession.has('cascade')) return;
    perSession.add('cascade');
  }

  // chrome.notifications is an optional permission. Detection settings'
  // toggle requests it at enable time; here we just try and let the API
  // throw if the user has revoked since.
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Hindsight: failure cascade',
      message: `Detected on ${safeOrigin(event.url)} — open the side panel for details.`,
      priority: 1,
    });
  } catch {
    /* permission revoked, browser pop-out closed, etc. — silent */
  }
}

async function maybeCaptureScreenshot(
  tabId: number,
  trigger: CapturedEvent,
  session: { sessionId: string; lastSequence: number },
  captureCfg: CaptureSettings
): Promise<void> {
  const now = Date.now();
  const last = screenshotLastShotAt.get(tabId) ?? 0;
  if (now - last < SCREENSHOT_MIN_INTERVAL_MS) return;
  screenshotLastShotAt.set(tabId, now);

  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 });
  } catch {
    return; // Tab inactive, cross-origin restriction, etc. — silent skip.
  }
  if (!dataUrl) return;

  // Best-effort dimension probe. chrome.tabs.captureVisibleTab returns
  // raw bytes; reading the actual size needs a decode pass we don't
  // care to pay here. The replay bundle (M4) will re-measure on demand.
  const dims = { width: 0, height: 0 };

  const sequenceNumber = nextSequence(session.sessionId, session.lastSequence);
  const event: CapturedEvent = {
    id: crypto.randomUUID(),
    type: 'screenshot',
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url: trigger.url,
    data: {
      storageRef: `screenshots/${session.sessionId}/${crypto.randomUUID()}.jpg`,
      dataUrl,
      trigger: 'error',
      width: dims.width,
      height: dims.height,
    },
    meta: { cascadeOf: trigger.id },
  };
  await queueEvent(tabId, event, sequenceNumber, captureCfg.maxEventsPerTab);
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
  // PRD §6.2.1: failed requests AND console.error / console.unhandled
  // both feed the badge. isErrorEvent unifies both predicates.
  const failedCount = buffer.reduce((n, e) => n + (isErrorEvent(e) ? 1 : 0), 0);
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
// Tab lifecycle — archive on close, drop on full reload.
// PRD §6.1.3: live session resets on reload; closed tabs land in
// archives/recent with a 7-day TTL.
// ---------------------------------------------------------------------------

// Lazy TTL sweep on service-worker start. Cheap on the happy path (no
// expired entries) and self-correcting if the SW was evicted long enough
// for entries to age out.
void sweepArchive().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastUrlPerTab.delete(tabId);
  void archiveSession(tabId).catch(() => {});
});

// Per-tab "last committed top-frame URL" — used to fill NavigationData.fromUrl
// without an extra chrome.tabs.get round-trip. Volatile; resets on
// service-worker eviction. The first navigation after eviction reports
// fromUrl=null, which is acceptable (PRD §6.1.3 lets live state lapse).
const lastUrlPerTab = new Map<number, string>();

chrome.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId !== 0) return; // top frame only — sub-frames are not navigations in PRD §6.1.1 terms.
  const { tabId, url, transitionType } = details;

  if (transitionType === 'reload') {
    lastUrlPerTab.delete(tabId);
    void clearSession(tabId).catch(() => {});
    void clearBadge(tabId).catch(() => {});
    return;
  }

  const fromUrl = lastUrlPerTab.get(tabId) ?? null;
  lastUrlPerTab.set(tabId, url);
  void emitNavigationEvent(tabId, url, fromUrl, transitionType).catch(() => {});
});

async function emitNavigationEvent(
  tabId: number,
  toUrl: string,
  fromUrl: string | null,
  transitionType: string
): Promise<void> {
  const origin = safeOrigin(toUrl);
  const privacy = await loadPrivacyConfig();
  // Same blocklist rule as handleCapture: a blocked origin drops every
  // event family, navigation markers included.
  if (privacy.blocklist.has(origin)) return;

  // navigation is Tier 1 (always on), so no tier-2 gate here.
  const captureCfg = await loadCaptureConfig();
  const session = await getOrCreateSession(tabId, origin);
  const sequenceNumber = nextSequence(session.sessionId, session.lastSequence);

  const data: NavigationData = {
    fromUrl,
    toUrl,
    ...(transitionType ? { transitionType } : {}),
  };
  const event: NavigationEvent = {
    id: crypto.randomUUID(),
    type: 'navigation',
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url: toUrl,
    data,
  };

  const buffer = await queueEvent(tabId, event, sequenceNumber, captureCfg.maxEventsPerTab);
  await renderBadge(tabId, buffer);
}

// ---------------------------------------------------------------------------
// Keyboard commands (manifest.commands — PRD §9.2).
// ---------------------------------------------------------------------------

chrome.commands?.onCommand?.addListener?.((command) => {
  if (command === 'open-side-panel') {
    void openSidePanelForActiveTab().catch(() => {});
  }
  // capture-last-moment and toggle-recording land in M4 alongside
  // recording mode (PRD §6.5).
});

async function openSidePanelForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
}
