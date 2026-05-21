// Storage helpers — single source of truth for chrome.storage.local key
// shapes and session-level metadata wiring (PRD §6.1.3).
//
// All capture-side persistence goes through this module so the eviction
// policy, schema-version migration hook (PRD §10.3), and key naming stay
// in one place. Settings live on chrome.storage.sync and are handled by
// src/lib/settings.ts.

import { EVENTS_SCHEMA_VERSION, type CapturedEvent, type SessionMetadata } from '@/types/events';

// ---------------------------------------------------------------------------
// Key derivation — keep all literals here.
// ---------------------------------------------------------------------------

export const StorageKeys = {
  sessionMeta: (tabId: number): string => `sessions/${tabId}`,
  sessionEvents: (tabId: number): string => `sessions/${tabId}/events`,
} as const;

// PRD §6.1.3: rolling buffer 200 events per tab by default (configurable up
// to 2000). Settings UI exposes the override; for now we hard-code the
// default until the Settings shell lands.
export const DEFAULT_MAX_EVENTS_PER_TAB = 200;

/** PRD §13.2: "events queued in service worker memory, flushed every
 *  250ms". The window is short enough that captures feel real-time in the
 *  popup but long enough to batch the bursty Tier 2 traffic (input,
 *  click) into a single storage write per cycle. */
export const FLUSH_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Session metadata — get-or-create + sequence number minting.
// ---------------------------------------------------------------------------

/**
 * Returns the session metadata for `tabId`, creating it on first use.
 * Side effect: persists newly-minted sessions so subsequent service worker
 * wake-ups see the same sessionId.
 */
export async function getOrCreateSession(tabId: number, origin: string): Promise<SessionMetadata> {
  const key = StorageKeys.sessionMeta(tabId);
  const stored = await chrome.storage.local.get(key);
  const existing = stored[key] as SessionMetadata | undefined;
  if (existing && existing.schemaVersion === EVENTS_SCHEMA_VERSION) {
    return existing;
  }

  const fresh: SessionMetadata = {
    sessionId: crypto.randomUUID(),
    tabId,
    origin,
    userAgent: navigator.userAgent,
    startedAt: Date.now(),
    lastSequence: 0,
    schemaVersion: EVENTS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [key]: fresh });
  return fresh;
}

// ---------------------------------------------------------------------------
// Batched event writes — PRD §13.1 / §13.2 perf strategy.
// ---------------------------------------------------------------------------

interface TabPending {
  events: CapturedEvent[];
  /** Highest sequence number any queued event carries. Persisted on flush
   *  so SessionMetadata.lastSequence stays in step. */
  lastSequence: number;
}

const pendingByTab = new Map<number, TabPending>();
const flushTimerByTab = new Map<number, ReturnType<typeof setTimeout>>();
/** Persisted-events cache. Avoids reading chrome.storage.local on every
 *  capture; refreshed on flush so the projected buffer stays accurate. */
const persistedByTab = new Map<number, CapturedEvent[]>();

/**
 * Enqueues an event for persistence and schedules a flush within
 * FLUSH_INTERVAL_MS if one isn't already pending. Returns the projected
 * buffer (persisted + every event queued so far this cycle, FIFO-capped)
 * so the caller — typically the badge state machine — sees the same
 * picture the user will once the flush lands.
 */
export async function queueEvent(
  tabId: number,
  event: CapturedEvent,
  sequenceNumber: number,
  max: number = DEFAULT_MAX_EVENTS_PER_TAB
): Promise<CapturedEvent[]> {
  let pending = pendingByTab.get(tabId);
  if (!pending) {
    pending = { events: [], lastSequence: 0 };
    pendingByTab.set(tabId, pending);
  }
  pending.events.push(event);
  pending.lastSequence = Math.max(pending.lastSequence, sequenceNumber);

  if (!persistedByTab.has(tabId)) {
    persistedByTab.set(tabId, await readEventsRaw(tabId));
  }
  scheduleFlush(tabId, max);

  const persisted = persistedByTab.get(tabId) ?? [];
  return [...persisted, ...pending.events].slice(-max);
}

function scheduleFlush(tabId: number, max: number): void {
  if (flushTimerByTab.has(tabId)) return;
  const timer = setTimeout(() => {
    flushTimerByTab.delete(tabId);
    void flushTab(tabId, max).catch(() => {});
  }, FLUSH_INTERVAL_MS);
  flushTimerByTab.set(tabId, timer);
}

/**
 * Writes the queued events for `tabId` to chrome.storage.local and
 * updates SessionMetadata.lastSequence in the same batch. No-op when
 * nothing is pending. Safe to call ad-hoc (e.g. on tab close) — the
 * scheduled timer auto-cancels.
 */
export async function flushTab(
  tabId: number,
  max: number = DEFAULT_MAX_EVENTS_PER_TAB
): Promise<void> {
  const timer = flushTimerByTab.get(tabId);
  if (timer) {
    clearTimeout(timer);
    flushTimerByTab.delete(tabId);
  }
  const pending = pendingByTab.get(tabId);
  if (!pending || pending.events.length === 0) return;
  pendingByTab.delete(tabId);

  const persisted = persistedByTab.get(tabId) ?? (await readEventsRaw(tabId));
  const nextEvents = [...persisted, ...pending.events].slice(-max);

  const metaKey = StorageKeys.sessionMeta(tabId);
  const eventsKey = StorageKeys.sessionEvents(tabId);
  const stored = await chrome.storage.local.get(metaKey);
  const meta = stored[metaKey] as SessionMetadata | undefined;

  const writes: Record<string, unknown> = { [eventsKey]: nextEvents };
  if (meta && meta.lastSequence < pending.lastSequence) {
    writes[metaKey] = { ...meta, lastSequence: pending.lastSequence };
  }
  await chrome.storage.local.set(writes);
  persistedByTab.set(tabId, nextEvents);
}

/**
 * Reads the per-tab event buffer the way the popup wants to see it:
 * persisted captures plus anything still in the in-memory queue.
 * Use this from any consumer that needs the user-visible view; use
 * readEventsRaw only when you specifically want what's on disk.
 */
export async function readEvents(tabId: number): Promise<CapturedEvent[]> {
  const persisted = persistedByTab.get(tabId) ?? (await readEventsRaw(tabId));
  const pending = pendingByTab.get(tabId);
  if (!pending || pending.events.length === 0) return persisted;
  return [...persisted, ...pending.events].slice(-DEFAULT_MAX_EVENTS_PER_TAB);
}

async function readEventsRaw(tabId: number): Promise<CapturedEvent[]> {
  const key = StorageKeys.sessionEvents(tabId);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as CapturedEvent[] | undefined) ?? [];
}

/**
 * Drops both the event buffer and the session metadata for a tab. Used by
 * the Clear button, tab close, and full-reload navigation handler. Also
 * tears down any in-memory queue and pending timer so the next session
 * starts clean.
 */
export async function clearSession(tabId: number): Promise<void> {
  const timer = flushTimerByTab.get(tabId);
  if (timer) {
    clearTimeout(timer);
    flushTimerByTab.delete(tabId);
  }
  pendingByTab.delete(tabId);
  persistedByTab.delete(tabId);
  await chrome.storage.local.remove([
    StorageKeys.sessionMeta(tabId),
    StorageKeys.sessionEvents(tabId),
  ]);
}
