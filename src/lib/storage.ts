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

/** PRD §13.2 hardening — `archives/recent` was bounded only by the 7-day
 *  TTL, never by session COUNT. Every tab close read the whole (growing)
 *  archive blob, pushed the closed session's full event buffer, and wrote
 *  the whole blob back; a heavy-browsing week could grow it to hundreds of
 *  MB, and the read-modify-write spike on tab close is a crash trigger.
 *  Cap the retained session count so the blob stays bounded. */
export const ARCHIVE_MAX_SESSIONS = 30;

// PRD §6.1.3: rolling buffer 200 events per tab by default (configurable up
// to 2000). Settings UI exposes the override; for now we hard-code the
// default until the Settings shell lands.
export const DEFAULT_MAX_EVENTS_PER_TAB = 200;

/** PRD §13.2: "events queued in service worker memory, flushed every
 *  250ms". The window is short enough that captures feel real-time in the
 *  popup but long enough to batch the bursty Tier 2 traffic (input,
 *  click) into a single storage write per cycle. */
export const FLUSH_INTERVAL_MS = 250;

/** PRD §13.2 hardening — the rolling buffer is capped by BYTES as well as
 *  by event count. A tab streaming large request/response bodies (each
 *  ≤200KB via BODY_CAP) or recording screenshots would otherwise hold tens
 *  of MB in the SW heap (persistedByTab) AND rewrite all of it to
 *  chrome.storage.local on every 250ms flush — the mechanism behind the
 *  20-tab browser-wide slowdown + SW-OOM crash (measured: ~8.6 MB/tab ×
 *  20 ≈ 145 MB, SW dies under sustained load). Bounding per-tab bytes caps
 *  both SW memory and per-flush write size regardless of maxEventsPerTab. */
export const BYTE_CAP_PER_TAB = 2_000_000;

/** Cheap per-event size estimate — reads only the known large fields
 *  (network bodies, screenshot dataUrls, console messages/stacks) instead
 *  of JSON-serializing the whole event on every queue/flush. */
export function approxEventBytes(event: CapturedEvent): number {
  const d = event.data as Record<string, unknown> | undefined;
  let n = 256; // envelope + small-field overhead
  if (d) {
    const req = d.request as { body?: unknown } | undefined;
    const res = d.response as { body?: unknown } | undefined;
    if (typeof req?.body === 'string') n += req.body.length;
    if (typeof res?.body === 'string') n += res.body.length;
    if (typeof d.dataUrl === 'string') n += d.dataUrl.length;
    if (typeof d.message === 'string') n += d.message.length;
    if (typeof d.stack === 'string') n += d.stack.length;
    if (typeof d.value === 'string') n += d.value.length; // action.input field value
  }
  return n;
}

/** Projects the rolling buffer: newest `maxCount` events, then trims the
 *  oldest until the estimated byte size is within `maxBytes`. Always keeps
 *  at least the newest event, even if it alone exceeds the cap. */
export function capBuffer(
  events: CapturedEvent[],
  maxCount: number,
  maxBytes: number = BYTE_CAP_PER_TAB
): CapturedEvent[] {
  const arr = events.length > maxCount ? events.slice(-maxCount) : events;
  let total = 0;
  let keepFrom = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    total += approxEventBytes(arr[i]!);
    if (total > maxBytes && i < arr.length - 1) {
      keepFrom = i + 1;
      break;
    }
  }
  return keepFrom > 0 ? arr.slice(keepFrom) : arr;
}

// ---------------------------------------------------------------------------
// Session metadata — get-or-create + sequence number minting.
// ---------------------------------------------------------------------------

/** In-memory mirror of persisted session metadata, keyed by tab. Every
 *  capture calls getOrCreateSession; without the cache that was one
 *  chrome.storage.local round-trip per event. The SW is the only writer
 *  of session keys, so the mirror can't go stale across contexts; an SW
 *  eviction simply drops it and the next read rehydrates from disk. */
const metaByTab = new Map<number, SessionMetadata>();

/**
 * Returns the session metadata for `tabId`, creating it on first use.
 * Side effect: persists newly-minted sessions so subsequent service worker
 * wake-ups see the same sessionId.
 */
export async function getOrCreateSession(tabId: number, origin: string): Promise<SessionMetadata> {
  const cached = metaByTab.get(tabId);
  if (cached && cached.schemaVersion === EVENTS_SCHEMA_VERSION) {
    return cached;
  }

  const key = StorageKeys.sessionMeta(tabId);
  const stored = await chrome.storage.local.get(key);
  const existing = stored[key] as SessionMetadata | undefined;
  if (existing && existing.schemaVersion === EVENTS_SCHEMA_VERSION) {
    metaByTab.set(tabId, existing);
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
  metaByTab.set(tabId, fresh);
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
  return capBuffer([...persisted, ...pending.events], max);
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
  const nextEvents = capBuffer([...persisted, ...pending.events], max);

  const metaKey = StorageKeys.sessionMeta(tabId);
  const eventsKey = StorageKeys.sessionEvents(tabId);
  let meta = metaByTab.get(tabId);
  if (!meta) {
    const stored = await chrome.storage.local.get(metaKey);
    meta = stored[metaKey] as SessionMetadata | undefined;
  }

  const writes: Record<string, unknown> = { [eventsKey]: nextEvents };
  if (meta && meta.lastSequence < pending.lastSequence) {
    const updated = { ...meta, lastSequence: pending.lastSequence };
    writes[metaKey] = updated;
    metaByTab.set(tabId, updated);
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
  return capBuffer([...persisted, ...pending.events], DEFAULT_MAX_EVENTS_PER_TAB);
}

/**
 * Cheap, synchronous peek at the highest sequence number the projected
 * buffer would carry, read from the in-memory mirrors only — no disk, no
 * buffer materialization. Returns -1 when nothing is cached (cold SW), so
 * the caller falls back to a full read rather than trust a stale skip.
 * Used by the GET_EVENTS poll short-circuit to avoid re-cloning an
 * unchanged buffer every tick.
 */
export function peekLastSequence(tabId: number): number {
  const pending = pendingByTab.get(tabId);
  if (pending && pending.events.length > 0) return pending.lastSequence;
  const meta = metaByTab.get(tabId);
  if (meta) return meta.lastSequence;
  const persisted = persistedByTab.get(tabId);
  if (persisted)
    return persisted.length > 0 ? (persisted[persisted.length - 1]?.sequenceNumber ?? 0) : 0;
  return -1;
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
  metaByTab.delete(tabId);
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
let archiveChain: Promise<void> = Promise.resolve();

export function archiveSession(tabId: number): Promise<void> {
  // Serialize archive writes. Tab close fires `void archiveSession(tabId)`
  // fire-and-forget (service-worker.ts onRemoved); closing a whole window
  // fires ~20 at once. Each is a read-modify-write of the SAME
  // `archives/recent` key — concurrently that's a lost-update race
  // (last writer wins, most sessions vanish). Chaining makes them atomic.
  archiveChain = archiveChain.catch(() => {}).then(() => doArchiveSession(tabId));
  return archiveChain;
}

async function doArchiveSession(tabId: number): Promise<void> {
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
  // Count cap (newest wins) so the blob can't grow unbounded across a
  // heavy-browsing week — bounds both the stored size and the tab-close
  // read-modify-write spike.
  const capped = kept.length > ARCHIVE_MAX_SESSIONS ? kept.slice(-ARCHIVE_MAX_SESSIONS) : kept;

  await chrome.storage.local.set({ [StorageKeys.archives]: capped });
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
 *  archive" link — explicit user action. Serialized on the same chain as
 *  archiveSession/sweepArchive so it can't clobber a concurrent archive. */
export function clearArchive(): Promise<void> {
  archiveChain = archiveChain
    .catch(() => {})
    .then(() => chrome.storage.local.remove(StorageKeys.archives));
  return archiveChain;
}

/**
 * TTL sweep of the archive. Idempotent: no-op when nothing is past the
 * cutoff. Intended for lazy invocation on service-worker start; future
 * archive surfaces (settings "Clear archive", side panel list) can call
 * it on demand. Serialized on `archiveChain` — the top-level sweepArchive()
 * on SW start and an onRemoved→archiveSession() can otherwise both
 * read-modify-write archives/recent in the same wake and clobber each
 * other (a freshly archived session lost to a late sweep .set).
 */
export function sweepArchive(): Promise<void> {
  archiveChain = archiveChain.catch(() => {}).then(() => doSweepArchive());
  return archiveChain;
}

async function doSweepArchive(): Promise<void> {
  const stored = await chrome.storage.local.get(StorageKeys.archives);
  const existing = (stored[StorageKeys.archives] as ArchivedSession[] | undefined) ?? [];
  if (existing.length === 0) return;
  const cutoff = Date.now() - ARCHIVE_TTL_MS;
  const kept = existing.filter((a) => a.archivedAt >= cutoff);
  if (kept.length === existing.length) return;
  await chrome.storage.local.set({ [StorageKeys.archives]: kept });
}
