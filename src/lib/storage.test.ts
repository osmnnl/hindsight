// Byte-bounded rolling-buffer projection (the 20-tab crash fix). capBuffer
// and approxEventBytes are pure — they own the memory / write-size ceiling
// that keeps 20 active tabs from ballooning the SW heap + chrome.storage.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approxEventBytes,
  archiveSession,
  capBuffer,
  clearSession,
  queueEvent,
  readEvents,
  slimFailure,
  BYTE_CAP_PER_TAB,
} from './storage';
import { EVENTS_SCHEMA_VERSION, type ArchivedSession, type CapturedEvent } from '@/types/events';

/** Minimal in-memory chrome.storage.local for the read/archive-path tests. */
function installChromeMock(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          const out: Record<string, unknown> = {};
          if (keys == null) {
            for (const [k, v] of store) out[k] = v;
            return out;
          }
          for (const k of Array.isArray(keys) ? keys : [keys])
            if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        remove: async (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

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

  it('counts action.input field value (the byte-cap blind spot fixed in review)', () => {
    const input = {
      id: 'e1',
      type: 'action.input',
      data: { value: 'y'.repeat(9000), target: {} },
    } as unknown as CapturedEvent;
    expect(approxEventBytes(input)).toBeGreaterThanOrEqual(9000);
  });
});

describe('slimFailure', () => {
  it('strips request/response bodies so the failures ring stays tiny', () => {
    const failed = ev(1, 200_000); // 200KB response body
    const slim = slimFailure(failed);
    const d = slim.data as { request: { body: unknown }; response: { body: unknown } };
    expect(d.response.body).toBeNull();
    expect(d.request.body).toBeNull();
    expect(approxEventBytes(slim)).toBeLessThan(1000); // was ~200KB
    // Non-body fields survive (detection needs them).
    expect(slim.id).toBe('e1');
    expect(slim.type).toBe('network.fetch');
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

  it('byte-caps an input-heavy buffer (capped values still counted)', () => {
    // 200 keystroke events each carrying a 10KB (INPUT_VALUE_CAP) value → 2MB;
    // capBuffer must trim to hold the byte ceiling.
    const arr = Array.from(
      { length: 200 },
      (_, i) =>
        ({
          id: `e${i}`,
          type: 'action.input',
          data: { value: 'z'.repeat(10_000) },
        }) as unknown as CapturedEvent
    );
    const out = capBuffer(arr, 200, BYTE_CAP_PER_TAB);
    const total = out.reduce((n, e) => n + approxEventBytes(e), 0);
    expect(total).toBeLessThanOrEqual(BYTE_CAP_PER_TAB);
    expect(out.length).toBeLessThan(200);
  });
});

describe('maxEventsPerTab is honored on read + archive (data-loss bugs)', () => {
  it('readEvents(tabId, max) surfaces > 200 events; default still caps at 200', async () => {
    installChromeMock();
    const tabId = 9001;
    for (let i = 1; i <= 300; i++) await queueEvent(tabId, ev(i), i, 2000);
    expect((await readEvents(tabId, 2000)).length).toBe(300); // configured cap honored
    expect((await readEvents(tabId)).length).toBe(200); // default unchanged (back-compat)
    await clearSession(tabId);
  });

  it('archiveSession(tabId, max) archives > 200 events instead of the 200 default', async () => {
    const store = installChromeMock();
    const tabId = 9002;
    store.set(`sessions/${tabId}`, {
      sessionId: 's2',
      tabId,
      origin: 'https://x.test',
      userAgent: 't',
      startedAt: 1,
      lastSequence: 0,
      schemaVersion: EVENTS_SCHEMA_VERSION,
    });
    for (let i = 1; i <= 300; i++) await queueEvent(tabId, ev(i), i, 2000);
    await archiveSession(tabId, 2000);
    const archives = store.get('archives/recent') as ArchivedSession[];
    expect(archives).toHaveLength(1);
    expect(archives[0]!.events.length).toBe(300); // not truncated to 200
  });
});
