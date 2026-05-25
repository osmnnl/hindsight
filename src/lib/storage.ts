// Storage helpers — single source of truth for chrome.storage.local key
// shapes and session-level metadata wiring (PRD §6.1.3).
//
// All capture-side persistence goes through this module so the eviction
// policy, schema-version migration hook (PRD §10.3), and key naming stay
// in one place. Settings live on chrome.storage.sync and are handled by
// src/lib/settings.ts.

import {
  EVENTS_SCHEMA_VERSION,
  type ArchivedSession,
  type CapturedEvent,
  type SessionMetadata,
} from '@/types/events';

// ---------------------------------------------------------------------------
// Key derivation — keep all literals here.
// ---------------------------------------------------------------------------

export const StorageKeys = {
  sessionMeta: (tabId: number): string => `sessions/${tabId}`,
  sessionEvents: (tabId: number): string => `sessions/${tabId}/events`,
  /** Closed-tab archive — PRD §6.1.3 "kept for 7 days then evicted". */
  archives: 'archives/recent',
} as const;

/** PRD §6.1.3: archive entries past this age are dropped on the next
 *  sweep. Seven days strikes a balance between "long enough to find a
 *  yesterday's bug" and "small enough that local storage doesn't bloat
 *  on a heavy-browsing day." */
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Drops both the event buffer and the session metadata for a tab without
 * archiving — used by the user Clear button and the reload path
 * (PRD §6.1.3 "live session resets on full reload"). Tab close goes
 * through archiveSession instead.
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

/**
 * Closed-tab path. Flushes any pending events, then moves the session's
 * metadata + final event buffer into `archives/recent` so the side
 * panel's M3 "recent sessions" view can surface it. Always pairs the
 * archive write with a clean-up so live storage doesn't double-count.
 * Empty sessions are dropped without archiving.
 */
export async function archiveSession(tabId: number): Promise<void> {
  await flushTab(tabId);

  const metaKey = StorageKeys.sessionMeta(tabId);
  const eventsKey = StorageKeys.sessionEvents(tabId);
  const stored = await chrome.storage.local.get([metaKey, eventsKey, StorageKeys.archives]);
  const meta = stored[metaKey] as SessionMetadata | undefined;
  const events = (stored[eventsKey] as CapturedEvent[] | undefined) ?? [];

  if (!meta || events.length === 0) {
    await clearSession(tabId);
    return;
  }

  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  const existing = (stored[StorageKeys.archives] as ArchivedSession[] | undefined) ?? [];
  const kept = existing.filter((a) => a.archivedAt >= cutoff);
  kept.push({ meta, events, archivedAt: Date.now() });

  await chrome.storage.local.set({ [StorageKeys.archives]: kept });
  await clearSession(tabId);
}

/**
 * Reads the archive (newest first). Returns an empty array when nothing
 * has landed yet. TTL-filters at read time so a stale on-disk entry
 * never reaches the UI — the lazy `sweepArchive()` on SW start
 * eventually cleans the disk too, but a race between SW wake-up and a
 * sidepanel archive request can otherwise surface expired sessions
 * for the duration of one render cycle.
 */
export async function readArchive(): Promise<ArchivedSession[]> {
  const stored = await chrome.storage.local.get(StorageKeys.archives);
  const list = (stored[StorageKeys.archives] as ArchivedSession[] | undefined) ?? [];
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  return list.filter((a) => a.archivedAt >= cutoff).sort((a, b) => b.archivedAt - a.archivedAt);
}

/** Drops every archived session. Used by the sidepanel's "Clear
 *  archive" link — explicit user action. */
export async function clearArchive(): Promise<void> {
  await chrome.storage.local.remove(StorageKeys.archives);
}

/**
 * TTL sweep of the archive. Idempotent: no-op when nothing is past the
 * cutoff. Intended for lazy invocation on service-worker start; future
 * archive surfaces (settings "Clear archive", side panel list) can call
 * it on demand.
 */
export async function sweepArchive(): Promise<void> {
  const stored = await chrome.storage.local.get(StorageKeys.archives);
  const existing = (stored[StorageKeys.archives] as ArchivedSession[] | undefined) ?? [];
  if (existing.length === 0) return;
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  const kept = existing.filter((a) => a.archivedAt >= cutoff);
  if (kept.length === existing.length) return;
  await chrome.storage.local.set({ [StorageKeys.archives]: kept });
}
