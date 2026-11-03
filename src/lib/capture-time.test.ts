import { describe, expect, it } from 'vitest';

import {
  CAPTURE_TIME_MAX_AGE_MS,
  CAPTURE_TIME_MAX_LEAD_MS,
  captureTimestamp,
} from './capture-time';

describe('captureTimestamp', () => {
  const now = 1_800_000_000_000;

  it('keeps capture-time stamps of one flushed batch in order and unchanged', () => {
    // Three captures 0 / 90 / 180 ms apart, all delivered in one 250 ms flush.
    const batch = [now - 230, now - 140, now - 50];
    const stamped = batch.map((t) => captureTimestamp(t, now));
    expect(stamped).toEqual(batch);
    expect(stamped[2]! - stamped[0]!).toBe(180);
  });

  it('falls back to receipt time when the page sent no stamp', () => {
    expect(captureTimestamp(undefined, now)).toBe(now);
    expect(captureTimestamp(Number.NaN, now)).toBe(now);
  });

  it('clamps stamps outside the sanity window', () => {
    expect(captureTimestamp(now - 3_600_000, now)).toBe(now - CAPTURE_TIME_MAX_AGE_MS);
    expect(captureTimestamp(now + 3_600_000, now)).toBe(now + CAPTURE_TIME_MAX_LEAD_MS);
  });
});
