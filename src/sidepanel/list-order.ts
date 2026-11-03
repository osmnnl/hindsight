import type { CapturedEvent } from '@/types/events';

/** The time a row shows: a request's start, everything else its capture
 *  timestamp (a request is captured when it completes). */
export function rowTime(e: CapturedEvent): number {
  if (e.type === 'network.fetch' || e.type === 'network.xhr') {
    return e.data.timing?.startedAt ?? e.timestamp;
  }
  return e.timestamp;
}

/** Newest-first by the time each row shows. Events arrive in completion
 *  order (a slow fetch lands after a later click), so the list sorts
 *  instead of reversing arrival; ties keep newest-arrival first
 *  (Array#sort is stable). */
export function newestFirst(data: CapturedEvent[]): CapturedEvent[] {
  return data
    .slice()
    .reverse()
    .sort((a, b) => rowTime(b) - rowTime(a));
}
