// Keyboard-command → side panel handoff (PRD §9.2 commands).
//
// The service worker has no DOM, so it cannot build a Blob download the
// way the popup does (and `downloads` is not a permission we hold). For
// "Capture last moment" (⌘⇧B) the SW opens the side panel inside the
// command's user gesture and plants this key; the panel — on boot or via
// storage.onChanged when already open — consumes it and runs the same
// replay-bundle download the popup button runs.

import type { CapturedEvent } from '@/types/events';

export const PENDING_ACTION_KEY = 'sidepanel/pending-action';

/** A planted action older than this is stale (the panel failed to open,
 *  or opened much later for an unrelated reason) and is ignored. */
export const PENDING_ACTION_TTL_MS = 10_000;

export interface PendingAction {
  action: 'download-bundle';
  /** Tab the command was pressed on; the panel only acts for that tab. */
  tabId: number;
  at: number;
}

export function makePendingAction(tabId: number, now: number): PendingAction {
  return { action: 'download-bundle', tabId, at: now };
}

export function isFreshPendingAction(value: unknown, now: number): value is PendingAction {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PendingAction>;
  return (
    v.action === 'download-bundle' &&
    typeof v.tabId === 'number' &&
    typeof v.at === 'number' &&
    now - v.at >= 0 &&
    now - v.at <= PENDING_ACTION_TTL_MS
  );
}

/** Builds the download filename shared by the popup and side panel. */
export function bundleFileName(events: CapturedEvent[], now: Date): string {
  let host = 'session';
  for (const e of events) {
    try {
      const h = new URL(e.url).host;
      if (h) {
        host = h;
        break;
      }
    } catch {
      /* keep looking */
    }
  }
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `hindsight-${host}-${ts}.html`;
}
