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
  peekLastSequence,
  queueEvent,
  readArchive,
  readEvents,
  sweepArchive,
} from '@/lib/storage';
import {
  isCaptureBatchMessage,
  isCaptureMessage,
  isClearArchiveMessage,
  isClearEventsMessage,
  isGetArchiveMessage,
  isGetEventsMessage,
  isGetRecordingMessage,
  isToggleRecordingMessage,
  type CaptureRuntimeMessage,
  type EventsUnchanged,
  type RecordingState,
  type RecordingStateBroadcast,
  type RuntimeMessage,
} from '@/lib/runtime-messages';
import {
  DEFAULT_BODY_RULES,
  DEFAULT_HEADER_RULES,
  maskBody,
  maskHeaders,
  tryCompilePattern,
  type BodyPatternRule,
  type HeaderMaskingRule,
} from '@/lib/masking';
import { detect } from '@/lib/detection';
import { openCapturePanel } from '@/lib/panel';
import { initI18n, t } from '@/lib/i18n';
import {
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_CAPTURE_SETTINGS,
  DEFAULT_DETECTION_SETTINGS,
  readAdvancedSettings,
  readCaptureSettings,
  readDetectionSettings,
  readPrivacySettings,
  SettingsKeys,
  type AdvancedSettings,
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
  headerRules: HeaderMaskingRule[];
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

// Advanced settings cache — used here only to honour debugLogging.
// Verbose mode prints the masking pipeline's input/output on every
// network capture so a user (or maintainer) can confirm rule disables
// are actually flowing through the SW.
let advancedConfigPromise: Promise<AdvancedSettings> | null = null;

function loadAdvancedConfig(): Promise<AdvancedSettings> {
  if (advancedConfigPromise) return advancedConfigPromise;
  advancedConfigPromise = readAdvancedSettings().catch(() => ({
    ...DEFAULT_ADVANCED_SETTINGS,
  }));
  return advancedConfigPromise;
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
    const disabled = new Set(settings.disabledDefaultRules);
    return {
      headerRules: DEFAULT_HEADER_RULES.filter((r) => !disabled.has(r.id)),
      bodyRules: [
        ...DEFAULT_BODY_RULES.filter((r) => !disabled.has(r.id)),
        ...compileCustomPatterns(settings.customPatterns),
      ],
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
  // Settings moved from sync → local in W14 (sync silently fails when
  // the user's Chrome doesn't have profile sync turned on). The
  // capture buffer was already on local, so this listener now
  // dispatches off a single area; the key-in-changes check still
  // discriminates between settings slices and unrelated event-buffer
  // writes.
  if (area !== 'local') return;
  if (SettingsKeys.privacy in changes) privacyConfigPromise = null;
  if (SettingsKeys.capture in changes) captureConfigPromise = null;
  if (SettingsKeys.detection in changes) detectionConfigPromise = null;
  if (SettingsKeys.advanced in changes) advancedConfigPromise = null;
});

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (msg: RuntimeMessage, sender, sendResponse): boolean | void => {
    // Every async branch returns true to keep the message channel open
    // and pairs its .then(sendResponse) with a .catch that ALSO calls
    // sendResponse — if storage throws (corruption, quota, teardown)
    // a missing sendResponse leaves the popup / sidepanel hung waiting
    // forever. Falling back to a safe default keeps the UI responsive
    // and surfaces an unhandled rejection at the call site rather than
    // here.
    if (isCaptureMessage(msg)) {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      void handleCapture(tabId, msg).catch(() => {
        /* fire-and-forget capture — no sendResponse expected */
      });
      return;
    }

    if (isCaptureBatchMessage(msg)) {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      // Sequential on purpose: handleCapture mints sequence numbers and
      // appends to the same per-tab buffer, so in-batch order must hold.
      void (async () => {
        for (const item of msg.captures) {
          await handleCapture(tabId, {
            kind: 'CAPTURE',
            capture: item.capture,
            pageUrl: msg.pageUrl,
            pageTitle: msg.pageTitle,
            ...(item.redactions ? { redactions: item.redactions } : {}),
          }).catch(() => {
            /* one bad capture must not drop the rest of the batch */
          });
        }
      })();
      return;
    }

    if (isGetEventsMessage(msg)) {
      // Poll short-circuit: when the caller's buffer is already current,
      // skip re-cloning the whole ≤200-event buffer across the IPC.
      const known = msg.knownLastSequence;
      if (known != null) {
        const cur = peekLastSequence(msg.tabId);
        if (cur !== -1 && cur === known) {
          sendResponse({ unchanged: true } satisfies EventsUnchanged);
          return true;
        }
      }
      readEvents(msg.tabId)
        .then(sendResponse)
        .catch(() => sendResponse([]));
      return true;
    }

    if (isClearEventsMessage(msg)) {
      clearSession(msg.tabId)
        .then(() => clearBadge(msg.tabId))
        .then(() => sendResponse(true))
        .catch(() => sendResponse(false));
      return true;
    }

    if (isGetArchiveMessage(msg)) {
      readArchive()
        .then(sendResponse)
        .catch(() => sendResponse([]));
      return true;
    }

    if (isClearArchiveMessage(msg)) {
      clearArchive()
        .then(() => sendResponse(true))
        .catch(() => sendResponse(false));
      return true;
    }

    if (isToggleRecordingMessage(msg)) {
      toggleRecording(msg.tabId)
        .then(sendResponse)
        .catch(() => sendResponse({ recording: false }));
      return true;
    }

    if (isGetRecordingMessage(msg)) {
      // Content scripts can't know their own tab id — fall back to the
      // sender (the bridge's Tier 4 gate uses this at page load).
      const tabId = msg.tabId ?? sender.tab?.id;
      sendResponse(tabId == null ? { recording: false } : getRecordingState(tabId));
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

/** Tell the tab's bridge the recording state changed so its Tier 4 gate
 *  (cursor/scroll dropped before the IPC) tracks toggles live. */
function broadcastRecordingState(tabId: number, recording: boolean): void {
  const msg: RecordingStateBroadcast = { kind: 'RECORDING_STATE', recording };
  try {
    void chrome.tabs.sendMessage(tabId, msg).catch(() => {
      /* tab has no content script (chrome:// etc.) — fine */
    });
  } catch {
    /* tab gone — fine */
  }
}

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
    broadcastRecordingState(tabId, false);
    const durationMs = Date.now() - current.startedAt;
    await emitRecordingEvent(tabId, 'recording.stop', { durationMs });
    return { recording: false };
  }
  const startedAt = Date.now();
  recordingByTab.set(tabId, { startedAt });
  armRecordingTimer(tabId);
  await persistRecordingState();
  broadcastRecordingState(tabId, true);
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

// Clean up SW in-memory state when a tab closes. There are two
// classes of leak we close here:
//   - tabId-keyed Maps: drop the entry synchronously.
//   - sessionId-keyed Maps: look up the sessionId from chrome.storage
//     (fire-and-forget) before dropping the entry. notifiedThisSession
//     used to delete a synthetic `session-for-tab-${tabId}` key that
//     never existed, leaking one entry per closed tab forever.
chrome.tabs.onRemoved.addListener((tabId) => {
  const wasRecording = recordingByTab.delete(tabId);
  const timer = recordingScreenshotTimers.get(tabId);
  if (timer != null) {
    clearInterval(timer);
    recordingScreenshotTimers.delete(tabId);
  }
  // Tab-keyed cleanups.
  screenshotLastShotAt.delete(tabId);
  // Session-keyed cleanups — async lookup, fire-and-forget.
  void chrome.storage.local
    .get(`sessions/${tabId}`)
    .then((stored) => {
      const meta = stored[`sessions/${tabId}`] as { sessionId?: string } | undefined;
      if (meta?.sessionId) {
        notifiedThisSession.delete(meta.sessionId);
        sequenceCursor.delete(meta.sessionId);
      }
    })
    .catch(() => {
      /* storage unavailable during teardown — accept the tiny leak */
    });
  if (wasRecording) {
    void persistRecordingState().catch(() => {});
  }
});

async function handleCapture(tabId: number, msg: CaptureRuntimeMessage): Promise<void> {
  const origin = safeOrigin(msg.pageUrl);
  const privacy = await loadPrivacyConfig();
  const captureCfg = await loadCaptureConfig();
  const advanced = await loadAdvancedConfig();
  const debug = advanced.debugLogging;

  if (debug) {
    console.info(
      '[hindsight]',
      msg.capture.type,
      'page=' + origin,
      '— headerRules:',
      privacy.headerRules.map((r) => r.id),
      'bodyRules:',
      privacy.bodyRules.map((r) => r.id)
    );
  }

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
  const { capture, redactions: swRedactions } = applyMasking(
    msg.capture,
    privacy.headerRules,
    privacy.bodyRules,
    debug
  );
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

  // Re-read locale from storage on every notification so a recently
  // flipped Settings → Language is honoured. Service worker is
  // event-driven (PRD §9) — the in-memory locale otherwise lags until
  // the next module wake-up.
  await initI18n();
  const origin = safeOrigin(event.url);
  const copy =
    rule === 'cascade'
      ? {
          title: t('bg.notif.cascade.title'),
          message: t('bg.notif.cascade.message', { origin }),
        }
      : {
          title: t('bg.notif.anomaly.title'),
          message: t('bg.notif.anomaly.message', { origin }),
        };

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
  headerRules: HeaderMaskingRule[],
  bodyRules: BodyPatternRule[],
  debug = false
): MaskedResult {
  // Only network.fetch / network.xhr carry the request/response shape we
  // mask today. Other types (console, action, navigation) pass through
  // unchanged; their masking lives in their own capture sites when those
  // event families land.
  if (capture.type !== 'network.fetch' && capture.type !== 'network.xhr') {
    return { capture, redactions: [] };
  }

  const data: NetworkFetchData | NetworkXhrData = capture.data;
  if (debug) {
    // Snippet the headers we care about so the user can tell whether the
    // ***MASKED*** string is coming from us (SW masking) or from an
    // upstream interceptor in the page. First 24 chars only — don't
    // dump a full bearer token to the SW console.
    const authRaw =
      data.request.headers['Authorization'] ?? data.request.headers['authorization'] ?? '';
    const cookieRaw = data.request.headers['Cookie'] ?? data.request.headers['cookie'] ?? '';
    const snip = (s: string): string => (s.length > 24 ? s.slice(0, 24) + '…' : s);
    console.info(
      '[hindsight] applyMasking',
      capture.data.request.method,
      capture.data.request.url,
      '— req-header-keys=',
      Object.keys(data.request.headers),
      '— rule-count=',
      headerRules.length,
      '— RAW Authorization snippet=',
      JSON.stringify(snip(authRaw)),
      '— RAW Cookie snippet=',
      JSON.stringify(snip(cookieRaw))
    );
  }
  const reqH = maskHeaders(data.request.headers, 'request.headers', headerRules);
  const respH = maskHeaders(data.response.headers, 'response.headers', headerRules);
  const reqB = maskBody(data.request.body, 'request.body', bodyRules);
  const respB = maskBody(data.response.body, 'response.body', bodyRules);
  if (debug) {
    console.info(
      '[hindsight] mask result — req-masked-keys=',
      Object.entries(reqH.headers)
        .filter(([, v]) => v === '***MASKED***')
        .map(([k]) => k),
      '— redactions=',
      [...reqH.redactions, ...respH.redactions, ...reqB.redactions, ...respB.redactions].map(
        (r) => `${r.scope}:${r.rule}`
      )
    );
  }

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

/** Last badge state written per tab. renderBadge runs on EVERY capture
 *  but the badge only changes when severity crosses a threshold — so the
 *  common case (a page emitting successful fetches / clicks while the
 *  badge stays empty) was paying 2 awaited chrome.action IPCs per capture
 *  for a no-op. Diff against this and skip the IPCs when unchanged. The
 *  SW is the only writer, so the mirror can't go stale; an eviction drops
 *  it and the next render rewrites unconditionally (cache miss). */
const lastBadgeByTab = new Map<number, { text: string; color: string }>();

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

  const prev = lastBadgeByTab.get(tabId);
  if (prev && prev.text === text && prev.color === color) return;
  lastBadgeByTab.set(tabId, { text, color });

  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Tab might be gone — drop the mirror so a later render for a reused
    // id doesn't get suppressed against a write that never landed.
    lastBadgeByTab.delete(tabId);
  }
}

async function clearBadge(tabId: number): Promise<void> {
  lastBadgeByTab.delete(tabId);
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
  // Firefox: the sidebar is window-global and sidebarAction.open() must fire
  // synchronously within the command's user gesture — open it before any
  // await (no tab id needed).
  if (!chrome.sidePanel?.open) {
    await openCapturePanel(undefined);
    return;
  }
  // Chrome: the side panel is per-tab, so we need the active tab id first.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) {
    await openCapturePanel(tab.id);
  }
}
