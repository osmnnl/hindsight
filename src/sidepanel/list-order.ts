import type { CapturedEvent } from '@/types/events';

/** Newest-first by capture timestamp. Events arrive in completion order
 *  (a slow fetch lands after a later click), so the list sorts by
 *  `timestamp`; ties keep newest-arrival first (Array#sort is stable). */
export function newestFirst(data: CapturedEvent[]): CapturedEvent[] {
  return data
    .slice()
    .reverse()
    .sort((a, b) => b.timestamp - a.timestamp);
}
