// Storage helpers — single source of truth for chrome.storage.local key
// shapes and session-level metadata wiring (PRD §6.1.3).
//
// All capture-side persistence goes through this module so the eviction
// policy, schema-version migration hook (PRD §10.3), and key naming stay
// in one place. Settings live on chrome.storage.sync and are handled by
// src/lib/settings.ts (added when the Settings UI shell lands).

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
    schemaVersion: EVENTS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [key]: fresh });
  return fresh;
}

/**
 * Atomically appends a single event to the per-tab buffer, enforcing the
 * FIFO eviction cap. Returns the resulting buffer so callers can derive
 * badge state without a second read.
 *
 * TODO(perf): PRD §13.1 mandates batched writes every 250ms; this version
 * writes per-event, which is fine at low traffic but will need batching
 * once detection rules + screenshot triggers fire concurrently.
 */
export async function appendEvent(
  tabId: number,
  event: CapturedEvent,
  max: number = DEFAULT_MAX_EVENTS_PER_TAB
): Promise<CapturedEvent[]> {
  const key = StorageKeys.sessionEvents(tabId);
  const stored = await chrome.storage.local.get(key);
  const existing = (stored[key] as CapturedEvent[] | undefined) ?? [];
  const next = existing.concat(event).slice(-max);
  await chrome.storage.local.set({ [key]: next });
  return next;
}

/**
 * Reads the per-tab event buffer. Returns an empty array if the tab has no
 * captures yet. Order is insertion order (oldest first).
 */
export async function readEvents(tabId: number): Promise<CapturedEvent[]> {
  const key = StorageKeys.sessionEvents(tabId);
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as CapturedEvent[] | undefined) ?? [];
}

/**
 * Drops both the event buffer and the session metadata for a tab. Used by
 * the Clear button, tab close, and full-reload navigation handler.
 *
 * TODO(m1-w3): PRD §6.1.3 says closed-tab sessions should move to
 * `archives/recent` (TTL 7 days) instead of being hard-deleted. That
 * archive arrives with the side-panel timeline in M3.
 */
export async function clearSession(tabId: number): Promise<void> {
  await chrome.storage.local.remove([
    StorageKeys.sessionMeta(tabId),
    StorageKeys.sessionEvents(tabId),
  ]);
}
