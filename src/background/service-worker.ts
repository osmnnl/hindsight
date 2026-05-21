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
  isGetRecordingMessage,
  isToggleRecordingMessage,
  type CaptureRuntimeMessage,
  type RecordingState,
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

const TIER_3_TYPES: ReadonlySet<EventType> = new Set(['performance.longtask', 'performance.cls']);

/** Tier 4 recording-only event types (PRD §6.1.1). Page-world emits
 *  these always (cheap throttled listeners), the SW drops them unless
 *  the tab is in recording mode. Avoids needing a state-sync channel
 *  back to page-world. */
const TIER_4_TYPES: ReadonlySet<EventType> = new Set(['cursor', 'action.scroll']);

function isTier2(type: EventType): boolean {
  return TIER_2_TYPES.has(type);
}

function isTier3(type: EventType): boolean {
  return TIER_3_TYPES.has(type);
}

function isTier4(type: EventType): boolean {
  return TIER_4_TYPES.has(type);
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

    if (isToggleRecordingMessage(msg)) {
      void toggleRecording(msg.tabId).then(sendResponse);
      return true;
    }

    if (isGetRecordingMessage(msg)) {
      sendResponse(getRecordingState(msg.tabId));
      return;
    }
  }
);

// ---------------------------------------------------------------------------
// Recording mode (PRD §6.5). Tier 4 captures (DOM mutations, cursor
// trail, periodic screenshots) wire in alongside this in M4·W13; this
// commit ships the start/stop state machine + recording.* envelope
// minting so the side panel UI works end-to-end.
// ---------------------------------------------------------------------------

// Recording state — persisted to chrome.storage.local so a service-
// worker eviction (Chrome kills idle MV3 SWs after ~30s) doesn't
// silently kill an in-progress recording. The in-memory Map mirrors
// the storage snapshot for synchronous reads on the capture hot path;
// every mutation writes through to the persisted record so a fresh
// SW boot can rehydrate (see hydrateRecordingState below) and re-arm
// the screenshot interval.
const recordingByTab = new Map<number, { startedAt: number }>();

const RECORDING_STORAGE_KEY = 'recording/active';

interface PersistedRecordingState {
  [tabId: string]: { startedAt: number };
}

async function persistRecordingState(): Promise<void> {
  const snapshot: PersistedRecordingState = {};
  for (const [tabId, entry] of recordingByTab) {
    snapshot[String(tabId)] = { startedAt: entry.startedAt };
  }
  try {
    if (Object.keys(snapshot).length === 0) {
      await chrome.storage.local.remove(RECORDING_STORAGE_KEY);
    } else {
      await chrome.storage.local.set({ [RECORDING_STORAGE_KEY]: snapshot });
    }
  } catch {
    /* storage briefly unavailable — next mutation retries */
  }
}

/** Read persisted recording state on SW boot, repopulate the Map and
 *  re-arm a screenshot interval for each active recording. Called
 *  unconditionally at module load — cheap no-op when nothing is
 *  recording. */
async function hydrateRecordingState(): Promise<void> {
  let snapshot: PersistedRecordingState | undefined;
  try {
    const stored = await chrome.storage.local.get(RECORDING_STORAGE_KEY);
    snapshot = stored[RECORDING_STORAGE_KEY] as PersistedRecordingState | undefined;
  } catch {
    return;
  }
  if (!snapshot) return;
  for (const [tabIdStr, entry] of Object.entries(snapshot)) {
    const tabId = Number(tabIdStr);
    if (!Number.isFinite(tabId)) continue;
    // Verify the tab still exists — closed tabs leave stale entries
    // if the SW was evicted before chrome.tabs.onRemoved fired.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        continue;
      }
    } catch {
      continue;
    }
    recordingByTab.set(tabId, { startedAt: entry.startedAt });
    armRecordingTimer(tabId);
  }
  // Drop any tab entries that no longer have real tabs behind them.
  await persistRecordingState();
}

void hydrateRecordingState().catch(() => {});

function armRecordingTimer(tabId: number): void {
  if (recordingScreenshotTimers.has(tabId)) return;
  const timer = setInterval(() => {
    void captureRecordingTickScreenshot(tabId).catch(() => {});
  }, RECORDING_SHOT_INTERVAL_MS);
  recordingScreenshotTimers.set(tabId, timer);
}

function getRecordingState(tabId: number): RecordingState {
  const entry = recordingByTab.get(tabId);
  return entry ? { recording: true, startedAt: entry.startedAt } : { recording: false };
}

/** Periodic screenshot timers active per recording tab (PRD §6.5.1
 *  "Periodic screenshots every 2 seconds"). Stored as numbers because
 *  chrome service worker setInterval returns a number, not a Timer
 *  object. */
const recordingScreenshotTimers = new Map<number, ReturnType<typeof setInterval>>();

/** PRD §6.5.1 Tier 4 recording-tick cadence. */
const RECORDING_SHOT_INTERVAL_MS = 2000;

async function toggleRecording(tabId: number): Promise<RecordingState> {
  const current = recordingByTab.get(tabId);
  if (current) {
    recordingByTab.delete(tabId);
    const existingTimer = recordingScreenshotTimers.get(tabId);
    if (existingTimer != null) {
      clearInterval(existingTimer);
      recordingScreenshotTimers.delete(tabId);
    }
    await persistRecordingState();
    const durationMs = Date.now() - current.startedAt;
    await emitRecordingEvent(tabId, 'recording.stop', { durationMs });
    return { recording: false };
  }
  const startedAt = Date.now();
  recordingByTab.set(tabId, { startedAt });
  armRecordingTimer(tabId);
  await persistRecordingState();
  await emitRecordingEvent(tabId, 'recording.start', { startedAt });
  return { recording: true, startedAt };
}

/** Fires every RECORDING_SHOT_INTERVAL_MS while a tab is recording.
 *  Same captureVisibleTab + queueEvent path as maybeCaptureScreenshot,
 *  but tagged trigger='recording-tick' so the side panel and replay
 *  bundle can distinguish a cadence shot from an error shot.
 *
 *  IMPORTANT: chrome.tabs.captureVisibleTab() grabs the *currently
 *  visible* tab of the window. If the user switched to a different
 *  tab mid-recording, capturing without a guard would shoot the wrong
 *  page. We check that the recording tab is still active in its
 *  window before firing — silent skip otherwise. */
async function captureRecordingTickScreenshot(tabId: number): Promise<void> {
  if (!recordingByTab.has(tabId)) return;
  let dataUrl: string;
  try {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // tabs.get needs the 'tabs' permission. If denied, fall back to
      // capturing whatever's visible — the user accepted the recording
      // expectation that the focused page gets shot.
      tab = undefined;
    }
    if (tab && !tab.active) return; // recording tab is no longer visible
    const windowId = tab?.windowId;
    dataUrl =
      windowId != null
        ? await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 })
        : await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 70 });
  } catch {
    return; // tab inactive in its window; we'll try again on the next tick.
  }
  if (!dataUrl) return;
  const captureCfg = await loadCaptureConfig();
  const url = lastUrlPerTab.get(tabId) ?? '';
  const session = await getOrCreateSession(tabId, safeOrigin(url));
  const sequenceNumber = nextSequence(session.sessionId, session.lastSequence);
  const event: CapturedEvent = {
    id: crypto.randomUUID(),
    type: 'screenshot',
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url,
    data: {
      storageRef: `screenshots/${session.sessionId}/${crypto.randomUUID()}.jpg`,
      dataUrl,
      trigger: 'recording-tick',
      width: 0,
      height: 0,
    },
  };
  await queueEvent(tabId, event, sequenceNumber, captureCfg.maxEventsPerTab);
}

async function emitRecordingEvent(
  tabId: number,
  type: 'recording.start' | 'recording.stop',
  payload: { startedAt?: number; durationMs?: number }
): Promise<void> {
  const captureCfg = await loadCaptureConfig();
  const url = lastUrlPerTab.get(tabId) ?? '';
  const origin = safeOrigin(url);
  const session = await getOrCreateSession(tabId, origin);
  const sequenceNumber = nextSequence(session.sessionId, session.lastSequence);
  const base = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    sessionId: session.sessionId,
    sequenceNumber,
    tabId,
    url,
  };
  const event: CapturedEvent =
    type === 'recording.start'
      ? { ...base, type: 'recording.start', data: {} }
      : { ...base, type: 'recording.stop', data: { durationMs: payload.durationMs ?? 0 } };
  const buffer = await queueEvent(tabId, event, sequenceNumber, captureCfg.maxEventsPerTab);
  await renderBadge(tabId, buffer);
}

// Clean up recording state when its tab closes — same lifecycle as
// the navigation lastUrl map. Also clears the screenshot interval so
// captureVisibleTab doesn't keep firing against a dead tab id.
chrome.tabs.onRemoved.addListener((tabId) => {
  const wasRecording = recordingByTab.delete(tabId);
  const timer = recordingScreenshotTimers.get(tabId);
  if (timer != null) {
    clearInterval(timer);
    recordingScreenshotTimers.delete(tabId);
  }
  notifiedThisSession.delete(`session-for-tab-${tabId}`);
  if (wasRecording) {
    void persistRecordingState().catch(() => {});
  }
});

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

  // Tier 3 toggle (OQ-M3-J) — performance observers gated; screenshot
  // capture stays on because it's triggered server-side from the error
  // path, not from a page-world observer.
  if (!captureCfg.tier3Enabled && isTier3(msg.capture.type)) return;

  // Tier 4 — recording-only. Page-world emits cursor / scroll always;
  // the SW drops them when not recording so non-recording sessions
  // never pay the storage cost.
  if (!recordingByTab.has(tabId) && isTier4(msg.capture.type)) return;

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
    case 'action.scroll':
      event = {
        ...baseEnvelope,
        type: 'action.scroll',
        data: capture.data,
        ...withMeta(meta),
      };
      break;
    case 'cursor':
      event = { ...baseEnvelope, type: 'cursor', data: capture.data, ...withMeta(meta) };
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
      // Desktop notifications (PRD §6.2.2). cascade-head + anomaly
      // (repeated identical failure) are the two detection signals
      // that warrant a system notification today. cascade-member,
      // slow, and single-event failed fires stay quiet so the
      // notification surface doesn't go noisy.
      if (detectionCfg.notificationsEnabled) {
        if (detection.flags.includes('cascade-head')) {
          void notifyDetection(event, session.sessionId, 'cascade', detectionCfg).catch(() => {});
        }
        if (detection.flags.includes('anomaly')) {
          void notifyDetection(event, session.sessionId, 'anomaly', detectionCfg).catch(() => {});
        }
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

type NotificationRule = 'cascade' | 'anomaly';

async function notifyDetection(
  event: CapturedEvent,
  sessionId: string,
  rule: NotificationRule,
  cfg: DetectionSettings
): Promise<void> {
  if (cfg.notificationFrequency === 'first-per-session') {
    let perSession = notifiedThisSession.get(sessionId);
    if (!perSession) {
      perSession = new Set();
      notifiedThisSession.set(sessionId, perSession);
    }
    if (perSession.has(rule)) return;
    perSession.add(rule);
  }

  const origin = safeOrigin(event.url);
  const messages: Record<NotificationRule, { title: string; message: string }> = {
    cascade: {
      title: 'Hindsight: failure cascade',
      message: `3+ failures on ${origin} within 10s — open the side panel for details.`,
    },
    anomaly: {
      title: 'Hindsight: repeated identical failure',
      message: `Same endpoint failing on ${origin} — open the side panel for details.`,
    },
  };
  const copy = messages[rule];

  // chrome.notifications is an optional permission. Detection settings'
  // toggle requests it at enable time; here we just try and let the API
  // throw if the user has revoked since.
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: copy.title,
      message: copy.message,
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
  // PRD §6.2.2: "Color reflects severity (green = none, yellow =
  // warnings, red = errors)." Empty badge ("") collapses the bubble
  // entirely so healthy pages stay visually quiet — green is implicit.
  const failedCount = buffer.reduce((n, e) => n + (isErrorEvent(e) ? 1 : 0), 0);
  const hasWarn = buffer.some(
    (e) =>
      e.meta?.flags?.includes('slow') === true ||
      e.type === 'performance.longtask' ||
      e.type === 'performance.cls'
  );

  let text = '';
  let color = '#22c55e'; // green — only visible if we ever surface a "captures alive" pulse.
  if (failedCount > 0) {
    text = String(failedCount);
    color = '#dc2626';
  } else if (hasWarn) {
    text = '!';
    color = '#f59e0b';
  }

  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
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
