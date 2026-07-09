// Byte-bounded rolling-buffer projection (the 20-tab crash fix). capBuffer
// and approxEventBytes are pure — they own the memory / write-size ceiling
// that keeps 20 active tabs from ballooning the SW heap + chrome.storage.

import { describe, expect, it } from 'vitest';

import { approxEventBytes, capBuffer, BYTE_CAP_PER_TAB } from './storage';
import type { CapturedEvent } from '@/types/events';

/** Minimal network.fetch event with a response body of `bodyLen` chars. */
function ev(id: number, bodyLen = 0): CapturedEvent {
  return {
    id: `e${id}`,
    type: 'network.fetch',
    timestamp: id,
    sessionId: 's',
    sequenceNumber: id,
    tabId: 1,
    url: 'https://x.test/',
    data: { request: { body: null }, response: { body: 'x'.repeat(bodyLen) } },
  } as unknown as CapturedEvent;
}

describe('approxEventBytes', () => {
  it('counts response body length plus envelope overhead', () => {
    const n = approxEventBytes(ev(1, 1000));
    expect(n).toBeGreaterThanOrEqual(1000);
    expect(n).toBeLessThan(1000 + 512); // overhead is small/constant
  });

  it('counts screenshot dataUrl length', () => {
    const shot = {
      id: 'e1',
      type: 'screenshot',
      data: {
        dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(50_000),
        storageRef: 'r',
        trigger: 'error',
        width: 1,
        height: 1,
      },
    } as unknown as CapturedEvent;
    expect(approxEventBytes(shot)).toBeGreaterThanOrEqual(50_000);
  });
});

describe('capBuffer', () => {
  it('returns the input unchanged when under both caps', () => {
    const arr = [ev(1), ev(2), ev(3)];
    expect(capBuffer(arr, 200)).toBe(arr);
  });

  it('count-caps to the newest maxCount events', () => {
    const arr = Array.from({ length: 300 }, (_, i) => ev(i));
    const out = capBuffer(arr, 200);
    expect(out).toHaveLength(200);
    expect(out[out.length - 1]!.id).toBe('e299'); // newest kept
    expect(out[0]!.id).toBe('e100'); // oldest 100 dropped
  });

  it('byte-caps: drops oldest until under maxBytes, keeps newest', () => {
    // 10 events × ~500KB = ~5MB; cap 2MB → keep ~4 newest.
    const arr = Array.from({ length: 10 }, (_, i) => ev(i, 500_000));
    const out = capBuffer(arr, 200, 2_000_000);
    const total = out.reduce((n, e) => n + approxEventBytes(e), 0);
    expect(total).toBeLessThanOrEqual(2_000_000);
    expect(out.length).toBeLessThan(10);
    expect(out[out.length - 1]!.id).toBe('e9'); // newest always retained
  });

  it('keeps at least the newest event even if it alone exceeds the cap', () => {
    const arr = [ev(1, 100), ev(2, 5_000_000)];
    const out = capBuffer(arr, 200, 2_000_000);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('e2');
  });

  it('byte cap can trim below maxCount for body-heavy tabs', () => {
    // 200 events × ~40KB ≈ 8MB (the measured 20-tab crash profile) → cap
    // pulls it well under the count-only 200.
    const arr = Array.from({ length: 200 }, (_, i) => ev(i, 40_000));
    const out = capBuffer(arr, 200, BYTE_CAP_PER_TAB);
    expect(out.length).toBeLessThan(200);
    const total = out.reduce((n, e) => n + approxEventBytes(e), 0);
    expect(total).toBeLessThanOrEqual(BYTE_CAP_PER_TAB);
  });
});
