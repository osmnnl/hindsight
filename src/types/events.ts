// Unified event model — canonical implementation of PRD §6.1.2.
//
// Every capture flowing through Hindsight is a CapturedEvent. The
// discriminated union on `type` keeps storage homogeneous, lets the
// timeline render with a single switch, and gives exporters a stable
// shape to derive HAR / Markdown / replay bundles from.
//
// This file is the source of truth. Capture sites (service worker,
// content scripts, side panel) should import from here rather than
// redefine local shapes. The .js → .ts port committed alongside this
// file still uses LegacyCapture in places; the M1-week-2 sprint
// rewires it to CapturedEvent end-to-end.

// ---------------------------------------------------------------------------
// Discriminator
// ---------------------------------------------------------------------------

export type EventType =
  // Tier 1 — essential (PRD §6.1.1)
  | 'network.fetch'
  | 'network.xhr'
  | 'console.error'
  | 'console.unhandled'
  | 'navigation'
  // Tier 2 — important
  | 'network.websocket'
  | 'console.warn'
  | 'console.info'
  | 'action.click'
  | 'action.input'
  // Tier 3 — conditional
  | 'network.sse'
  | 'screenshot'
  | 'performance.longtask'
  | 'performance.cls'
  // Tier 4 — recording-mode only
  | 'recording.start'
  | 'recording.stop'
  | 'action.scroll'
  | 'action.focus'
  | 'mutation'
  | 'cursor';

// ---------------------------------------------------------------------------
// Cross-cutting metadata
// ---------------------------------------------------------------------------

/**
 * A single capture-time redaction. PRD §11.2: PII is masked before it is
 * ever written to storage; the metadata here records *that* something was
 * masked, *where*, and *which rule* matched — never the original value.
 */
export interface Redaction {
  /** Where the redaction happened. */
  scope: 'request.headers' | 'request.body' | 'response.headers' | 'response.body' | 'form.value';
  /** Header name, JSON path, or form field name where the redaction landed. */
  path: string;
  /** Identifier of the rule that fired (e.g. 'header.authorization', 'pattern.tckn'). */
  rule: string;
}

export interface EventMeta {
  /** Redactions applied at capture time, if any. */
  redactions?: Redaction[];
  /** Parent event id if this event is part of a detected cascade (PRD §6.2.3). */
  cascadeOf?: string;
  /** Flags surfaced by the detection rule engine (PRD §6.2.1). */
  flags?: EventFlag[];
}

export type EventFlag = 'slow' | 'failed' | 'anomaly' | 'cascade-head' | 'cascade-member';

// ---------------------------------------------------------------------------
// Per-type payloads
// ---------------------------------------------------------------------------

export interface NetworkRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Serialized request body. May be `null` (no body) or a faithful string repr. */
  body: string | null;
}

export interface NetworkResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Serialized response body. May be `null` if the request errored before headers. */
  body: string | null;
}

export interface NetworkTiming {
  /** Unix ms when the request was initiated. */
  startedAt: number;
  /** Total duration in ms (response end - request start). */
  durationMs: number;
}

export interface NetworkFetchData {
  request: NetworkRequest;
  response: NetworkResponse;
  timing: NetworkTiming;
  /** Stringified network error if the fetch threw (CORS, abort, DNS, etc.). */
  error: string | null;
}

export type NetworkXhrData = NetworkFetchData;

export interface NetworkWebSocketData {
  /** Phase of the connection lifecycle. */
  phase: 'connect' | 'open' | 'message' | 'close' | 'error';
  url: string;
  direction?: 'send' | 'recv';
  /** Frame size in bytes. Frame content is metadata-only by default (PRD §6.1.1 Tier 2). */
  byteSize?: number;
  code?: number;
  reason?: string;
}

export interface NetworkSseData {
  phase: 'connect' | 'message' | 'error' | 'close';
  url: string;
  /** Event name (`message` is default). */
  event?: string;
  /** Last event id for resumption. */
  lastEventId?: string;
}

export type ConsoleLevel = 'info' | 'warn' | 'error' | 'unhandled';

export interface ConsoleData {
  level: ConsoleLevel;
  message: string;
  stack?: string;
  /** Source location for the call site when available. */
  source?: { file: string; line: number; column?: number };
}

/**
 * A descriptor for a click/input/focus target. Captures accessible identity
 * over brittle CSS selectors.
 */
export interface TargetDescriptor {
  /** e.g. 'BUTTON', 'A', 'INPUT'. */
  tag: string;
  /** Accessible name: aria-label, then visible text, then placeholder. */
  accessibleName?: string;
  id?: string;
  name?: string;
  /** Sparse classlist (PRD §6.1.1 Tier 2 — limited to avoid noise). */
  classes?: string[];
  /** Bounding rect at capture time, viewport-relative. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface ActionClickData {
  target: TargetDescriptor;
  /** Mouse button: 0 = primary, 1 = middle, 2 = secondary. */
  button: 0 | 1 | 2;
  modifiers: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
}

export interface ActionInputData {
  target: TargetDescriptor;
  /** Input value after the change. May be `***MASKED***` per PRD §11.2. */
  value: string;
  /** Type of the input element (`password`, `email`, ...). */
  inputType?: string;
}

export interface ActionScrollData {
  scrollX: number;
  scrollY: number;
}

export interface ActionFocusData {
  target: TargetDescriptor;
  /** Whether the event was a `focus` (true) or `blur` (false). */
  focused: boolean;
}

export interface NavigationData {
  fromUrl: string | null;
  toUrl: string;
  /** chrome.webNavigation transition type, when available. */
  transitionType?: string;
}

export interface ScreenshotData {
  /** Storage ref (e.g. `screenshots/<sessionId>/<eventId>.jpg`). Used
   *  by the replay-bundle generator (M4) to externalize large images
   *  out of the event buffer. */
  storageRef: string;
  /** Inline JPEG data URL captured by chrome.tabs.captureVisibleTab.
   *  M3 first cut keeps the bytes inline so the popup / side panel
   *  can render without a second storage round-trip. M4 moves them
   *  to the storageRef path for the replay bundle (PRD §5). */
  dataUrl?: string;
  /** What surfaced this screenshot (PRD §6.1.1 Tier 3 — error trigger,
   *  recording cadence, etc.). */
  trigger: 'error' | 'recording-tick' | 'mutation' | 'manual';
  /** Encoded dimensions. */
  width: number;
  height: number;
}

export interface PerformanceLongTaskData {
  /** Duration in ms (>50ms per PRD §6.1.1 Tier 3, surfaced at >100ms per §6.2.1). */
  durationMs: number;
  /** Origin attribution if available. */
  attribution?: string;
}

export interface PerformanceClsData {
  /** Cumulative layout shift score for this entry. */
  value: number;
  hadRecentInput: boolean;
}

export interface RecordingStartData {
  /** User-provided title; empty until labelled in the export dialog. */
  title?: string;
}

export interface RecordingStopData {
  /** Total recording duration in ms. */
  durationMs: number;
}

export interface MutationData {
  /** Number of nodes added/removed/changed in this batch. */
  added: number;
  removed: number;
  changed: number;
  /** Reference to a diff-encoded payload in storage (kept out of the event
   *  body to avoid bloating the timeline). */
  diffRef?: string;
}

export interface CursorData {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// CapturedEvent — the discriminated union
// ---------------------------------------------------------------------------

/**
 * Shared envelope. The PRD section that defines this lives at §6.1.2.
 */
interface BaseEvent<T extends EventType, D> {
  /** Unique within a session. UUID v4 is fine. */
  id: string;
  type: T;
  /** Unix ms. Monotonic per session within a tab. */
  timestamp: number;
  /** Per-tab session UUID (PRD §6.1.3). */
  sessionId: string;
  /** Ordering within the session — fills gaps when timestamps tie. */
  sequenceNumber: number;
  tabId: number;
  /** Page URL at the time of the event (not the request URL — that lives in `data`). */
  url: string;
  data: D;
  meta?: EventMeta;
}

export type NetworkFetchEvent = BaseEvent<'network.fetch', NetworkFetchData>;
export type NetworkXhrEvent = BaseEvent<'network.xhr', NetworkXhrData>;
export type NetworkWebSocketEvent = BaseEvent<'network.websocket', NetworkWebSocketData>;
export type NetworkSseEvent = BaseEvent<'network.sse', NetworkSseData>;
export type ConsoleErrorEvent = BaseEvent<'console.error', ConsoleData>;
export type ConsoleWarnEvent = BaseEvent<'console.warn', ConsoleData>;
export type ConsoleInfoEvent = BaseEvent<'console.info', ConsoleData>;
export type ConsoleUnhandledEvent = BaseEvent<'console.unhandled', ConsoleData>;
export type ActionClickEvent = BaseEvent<'action.click', ActionClickData>;
export type ActionInputEvent = BaseEvent<'action.input', ActionInputData>;
export type ActionScrollEvent = BaseEvent<'action.scroll', ActionScrollData>;
export type ActionFocusEvent = BaseEvent<'action.focus', ActionFocusData>;
export type NavigationEvent = BaseEvent<'navigation', NavigationData>;
export type ScreenshotEvent = BaseEvent<'screenshot', ScreenshotData>;
export type PerformanceLongTaskEvent = BaseEvent<'performance.longtask', PerformanceLongTaskData>;
export type PerformanceClsEvent = BaseEvent<'performance.cls', PerformanceClsData>;
export type RecordingStartEvent = BaseEvent<'recording.start', RecordingStartData>;
export type RecordingStopEvent = BaseEvent<'recording.stop', RecordingStopData>;
export type MutationEvent = BaseEvent<'mutation', MutationData>;
export type CursorEvent = BaseEvent<'cursor', CursorData>;

export type CapturedEvent =
  | NetworkFetchEvent
  | NetworkXhrEvent
  | NetworkWebSocketEvent
  | NetworkSseEvent
  | ConsoleErrorEvent
  | ConsoleWarnEvent
  | ConsoleInfoEvent
  | ConsoleUnhandledEvent
  | ActionClickEvent
  | ActionInputEvent
  | ActionScrollEvent
  | ActionFocusEvent
  | NavigationEvent
  | ScreenshotEvent
  | PerformanceLongTaskEvent
  | PerformanceClsEvent
  | RecordingStartEvent
  | RecordingStopEvent
  | MutationEvent
  | CursorEvent;

// ---------------------------------------------------------------------------
// Type-narrowing guards
// ---------------------------------------------------------------------------

/** All network-family events (fetch, xhr, websocket, sse). */
export type NetworkEvent =
  | NetworkFetchEvent
  | NetworkXhrEvent
  | NetworkWebSocketEvent
  | NetworkSseEvent;

/** All console-family events. */
export type ConsoleEvent =
  | ConsoleErrorEvent
  | ConsoleWarnEvent
  | ConsoleInfoEvent
  | ConsoleUnhandledEvent;

/** All action-family events. */
export type ActionEvent =
  | ActionClickEvent
  | ActionInputEvent
  | ActionScrollEvent
  | ActionFocusEvent;

const NETWORK_TYPES = new Set<EventType>([
  'network.fetch',
  'network.xhr',
  'network.websocket',
  'network.sse',
]);

const CONSOLE_TYPES = new Set<EventType>([
  'console.error',
  'console.warn',
  'console.info',
  'console.unhandled',
]);

const ACTION_TYPES = new Set<EventType>([
  'action.click',
  'action.input',
  'action.scroll',
  'action.focus',
]);

export function isNetworkEvent(e: CapturedEvent): e is NetworkEvent {
  return NETWORK_TYPES.has(e.type);
}

export function isConsoleEvent(e: CapturedEvent): e is ConsoleEvent {
  return CONSOLE_TYPES.has(e.type);
}

export function isActionEvent(e: CapturedEvent): e is ActionEvent {
  return ACTION_TYPES.has(e.type);
}

export function isFailedNetwork(e: CapturedEvent): e is NetworkFetchEvent | NetworkXhrEvent {
  if (e.type !== 'network.fetch' && e.type !== 'network.xhr') return false;
  const status = e.data.response.status;
  return status === 0 || status >= 400 || e.data.error != null;
}

export function isErrorEvent(e: CapturedEvent): boolean {
  if (e.type === 'console.error' || e.type === 'console.unhandled') return true;
  return isFailedNetwork(e);
}

/**
 * Heuristic: "is this a real API/data fetch as opposed to framework
 * plumbing or a static asset?". Used by the side panel + replay
 * bundle viewer's `API` filter — Next.js (and any modern SPA framework)
 * generates tens-to-hundreds of internal requests per page load
 * (chunked JS, prefetched data, image optimizer, fonts) that drown
 * out the actual API calls the user wants to debug.
 *
 * Decision tree:
 *   1. Must be network.fetch / network.xhr.
 *   2. Reject framework internals: /_next/, /__webpack, /__vite, /_hot/, /__nextjs.
 *   3. Reject by URL extension (.js, .css, .png, .woff, .map, ...).
 *   4. Reject by response content-type (text/css, image/*, font/*, *javascript*).
 *   5. Otherwise keep — missing content-type defaults to "kept" so we
 *      don't lose CORS preflights, streaming endpoints, or odd backends.
 *
 * False negatives (real APIs we skip) are worse than false positives
 * (noise we let through), so the heuristic is conservative.
 */
// Hoisted to module scope so the Set isn't reconstructed on every
// call. The sidepanel re-runs isApiRequest across the full buffer
// on each render — at 1000 events × N renders, the per-call Set
// allocation was the dominant cost (see bench/filter-1000.bench.ts).
const ASSET_EXTS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'sass',
  'less',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'otf',
  'map',
  'wasm',
  'mp4',
  'webm',
  'mp3',
  'ogg',
]);

export function isApiRequest(e: CapturedEvent): boolean {
  if (e.type !== 'network.fetch' && e.type !== 'network.xhr') return false;

  const url = e.data.request.url;

  // Framework internals — most extensions never want to see these.
  if (url.includes('/_next/')) return false;
  if (url.includes('/__webpack') || url.includes('/__vite') || url.includes('/_hot/')) return false;
  if (url.includes('/__nextjs')) return false;
  if (url.includes('/sockjs-node')) return false;

  // Strip query + fragment, take final segment's extension.
  const clean = url.split('?')[0]?.split('#')[0]?.toLowerCase() ?? '';
  const lastSeg = clean.split('/').pop() ?? '';
  const dot = lastSeg.lastIndexOf('.');
  const ext = dot >= 0 ? lastSeg.slice(dot + 1) : '';
  if (ASSET_EXTS.has(ext)) return false;

  // Content-type based reject. Header lookup is case-insensitive in
  // HTTP but our captured map preserves the original case, so check
  // both common spellings.
  const ct = (
    e.data.response.headers['content-type'] ??
    e.data.response.headers['Content-Type'] ??
    ''
  ).toLowerCase();
  if (ct) {
    if (ct.startsWith('text/css')) return false;
    if (ct.startsWith('image/')) return false;
    if (ct.startsWith('font/')) return false;
    if (ct.includes('javascript')) return false;
    if (ct.startsWith('video/') || ct.startsWith('audio/')) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Coarse event categories — the side panel + settings "show / hide" filter
// (multi-select). Every EventType maps to exactly one category so nothing
// falls through the filter.
// ---------------------------------------------------------------------------

export type EventCategory =
  | 'network'
  | 'realtime'
  | 'console'
  | 'navigation'
  | 'action'
  | 'performance'
  | 'screenshot';

/** Display order + the canonical full set (used as the default "show
 *  everything" selection). */
export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'network',
  'realtime',
  'console',
  'navigation',
  'action',
  'performance',
  'screenshot',
] as const;

/** Map an event to its coarse category. HTTP request/response events
 *  (fetch, XHR — the ones with status codes) are `network`; persistent /
 *  streaming connections (WebSocket, SSE) are `realtime`. Recording-mode
 *  extras (cursor, mutation, recording.start/stop) ride along with
 *  `action` since they're all user-activity / recording-session events. */
export function categoryOf(e: CapturedEvent): EventCategory {
  switch (e.type) {
    case 'network.fetch':
    case 'network.xhr':
      return 'network';
    case 'network.websocket':
    case 'network.sse':
      return 'realtime';
    case 'console.error':
    case 'console.warn':
    case 'console.info':
    case 'console.unhandled':
      return 'console';
    case 'navigation':
      return 'navigation';
    case 'action.click':
    case 'action.input':
    case 'action.scroll':
    case 'action.focus':
    case 'cursor':
    case 'mutation':
    case 'recording.start':
    case 'recording.stop':
      return 'action';
    case 'performance.longtask':
    case 'performance.cls':
      return 'performance';
    case 'screenshot':
      return 'screenshot';
  }
}

// ---------------------------------------------------------------------------
// Session envelope
// ---------------------------------------------------------------------------

/**
 * Session-level metadata kept alongside the event buffer (PRD §6.1.3 key
 * `sessions/{tabId}`).
 */
export interface SessionMetadata {
  sessionId: string;
  tabId: number;
  origin: string;
  userAgent: string;
  startedAt: number;
  /** Monotonic counter; the service worker bumps this with every event
   *  and persists it so a service-worker eviction doesn't restart the
   *  sequence at 1 mid-session. */
  lastSequence: number;
  /** Bumped on every schema migration (PRD §10.3). */
  schemaVersion: number;
}

/** Storage schema version this codebase emits. Bump on breaking change. */
export const EVENTS_SCHEMA_VERSION = 1;

/**
 * One entry in the closed-tab archive (PRD §6.1.3 key `archives/recent`,
 * TTL 7 days). Carries the session metadata, the full event buffer at
 * the time of close, and the archive timestamp the sweeper uses for TTL
 * checks. The archive is the bridge between live tabs and the side
 * panel's "recent sessions" view (M3).
 */
export interface ArchivedSession {
  meta: SessionMetadata;
  events: CapturedEvent[];
  archivedAt: number;
}
