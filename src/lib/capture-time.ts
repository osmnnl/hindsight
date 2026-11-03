// Event timestamps — when the capture happened, not when it arrived.
//
// The bridge coalesces ~250 ms of captures into one CAPTURE_BATCH (v0.6.2
// perf fix), so stamping `Date.now()` on receipt in the service worker put
// every event of a batch at the flush moment: actions typed before a request
// sorted after it and the scrubber span collapsed to a few ms. The page world
// now stamps `t` at capture; the SW trusts it within a sanity window so a
// skewed or forged page clock can't push events far into the past or future.

/** How far before receipt a capture-time stamp is still believed (covers
 *  batching, a sleeping SW waking up, and slow tab teardown flushes). */
export const CAPTURE_TIME_MAX_AGE_MS = 60_000;
/** Allowed clock lead of the page over the SW. */
export const CAPTURE_TIME_MAX_LEAD_MS = 1_000;

export function captureTimestamp(t: number | undefined, now: number): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return now;
  if (t < now - CAPTURE_TIME_MAX_AGE_MS) return now - CAPTURE_TIME_MAX_AGE_MS;
  if (t > now + CAPTURE_TIME_MAX_LEAD_MS) return now + CAPTURE_TIME_MAX_LEAD_MS;
  return t;
}
