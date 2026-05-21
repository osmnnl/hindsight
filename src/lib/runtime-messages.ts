// Typed envelope for the page-world → ISOLATED-world → service-worker
// message hop. Centralizing the shapes here prevents drift between the
// three execution contexts that each see this data on the wire.
//
// The page-world interceptor knows only the raw payload (no sessionId, no
// sequenceNumber); the service worker is the central authority that mints
// the envelope. So the wire format here intentionally carries only the
// type discriminator and the per-type `data` payload — never a full
// CapturedEvent.

import type {
  ActionClickData,
  ActionInputData,
  ConsoleData,
  NavigationData,
  NetworkFetchData,
  NetworkSseData,
  NetworkWebSocketData,
  NetworkXhrData,
  Redaction,
} from '@/types/events';

/** Bridge tag — checked by the ISOLATED-world bridge to filter out
 *  unrelated postMessage traffic on the page. Bumped on breaking changes
 *  to the wire format. */
export const CAPTURE_BRIDGE_TAG = 'hindsight:capture/v1' as const;

// ---------------------------------------------------------------------------
// Page → bridge (window.postMessage)
// ---------------------------------------------------------------------------

/**
 * One union member per event type the page world emits. The discriminant
 * is the same `EventType` literal the service worker will stamp onto the
 * envelope, so no translation table is needed.
 */
export type RawCapture =
  | { type: 'network.fetch'; data: NetworkFetchData }
  | { type: 'network.xhr'; data: NetworkXhrData }
  | { type: 'network.websocket'; data: NetworkWebSocketData }
  | { type: 'network.sse'; data: NetworkSseData }
  | { type: 'console.error'; data: ConsoleData }
  | { type: 'console.warn'; data: ConsoleData }
  | { type: 'console.info'; data: ConsoleData }
  | { type: 'console.unhandled'; data: ConsoleData }
  | { type: 'action.click'; data: ActionClickData }
  | { type: 'action.input'; data: ActionInputData }
  | { type: 'navigation'; data: NavigationData };

export interface PageBridgeMessage {
  source: typeof CAPTURE_BRIDGE_TAG;
  capture: RawCapture;
  /** Page-world-applied redactions — e.g. form-field masking happens at
   *  the DOM site because that's where the field metadata is visible.
   *  The service worker merges these with its own header / body
   *  redactions before persisting EventMeta. */
  redactions?: Redaction[];
}

// ---------------------------------------------------------------------------
// Bridge → service worker (chrome.runtime.sendMessage)
// ---------------------------------------------------------------------------

export interface CaptureRuntimeMessage {
  kind: 'CAPTURE';
  capture: RawCapture;
  pageUrl: string;
  pageTitle: string;
  /** Page-world-applied redactions; the service worker concatenates
   *  these with its own to form the final EventMeta.redactions list. */
  redactions?: Redaction[];
}

export interface GetEventsRuntimeMessage {
  kind: 'GET_EVENTS';
  tabId: number;
}

export interface ClearEventsRuntimeMessage {
  kind: 'CLEAR_EVENTS';
  tabId: number;
}

export interface GetArchiveRuntimeMessage {
  kind: 'GET_ARCHIVE';
}

export interface ClearArchiveRuntimeMessage {
  kind: 'CLEAR_ARCHIVE';
}

export type RuntimeMessage =
  | CaptureRuntimeMessage
  | GetEventsRuntimeMessage
  | ClearEventsRuntimeMessage
  | GetArchiveRuntimeMessage
  | ClearArchiveRuntimeMessage;

// ---------------------------------------------------------------------------
// Type guards — used by the service worker dispatch switch.
// ---------------------------------------------------------------------------

export function isCaptureMessage(m: RuntimeMessage): m is CaptureRuntimeMessage {
  return m.kind === 'CAPTURE';
}

export function isGetEventsMessage(m: RuntimeMessage): m is GetEventsRuntimeMessage {
  return m.kind === 'GET_EVENTS';
}

export function isClearEventsMessage(m: RuntimeMessage): m is ClearEventsRuntimeMessage {
  return m.kind === 'CLEAR_EVENTS';
}

export function isGetArchiveMessage(m: RuntimeMessage): m is GetArchiveRuntimeMessage {
  return m.kind === 'GET_ARCHIVE';
}

export function isClearArchiveMessage(m: RuntimeMessage): m is ClearArchiveRuntimeMessage {
  return m.kind === 'CLEAR_ARCHIVE';
}
