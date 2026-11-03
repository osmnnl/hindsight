import { describe, expect, it } from 'vitest';

import { CASCADE_WINDOW_MS, SLOW_REQUEST_MS, detect, resolveClusters } from './detection';
import type { CapturedEvent, ConsoleErrorEvent, NetworkFetchEvent } from '@/types/events';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 0, 0);

function fetchEvt(
  over: {
    id?: string;
    ts?: number;
    url?: string;
    status?: number;
    method?: string;
    durationMs?: number;
    cascadeOf?: string;
  } = {}
): NetworkFetchEvent {
  return {
    id: over.id ?? 'n',
    type: 'network.fetch',
    timestamp: over.ts ?? BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 1,
    tabId: 1,
    url: 'https://example.com/page',
    data: {
      request: {
        method: over.method ?? 'GET',
        url: over.url ?? 'https://api.example.com/v1/x',
        headers: {},
        body: null,
      },
      response: {
        status: over.status ?? 200,
        statusText: 'OK',
        headers: {},
        body: '{}',
      },
      timing: { startedAt: over.ts ?? BASE_TS, durationMs: over.durationMs ?? 50 },
      error: null,
    },
    ...(over.cascadeOf ? { meta: { cascadeOf: over.cascadeOf } } : {}),
  };
}

function consoleErrEvt(over: { id?: string; ts?: number } = {}): ConsoleErrorEvent {
  return {
    id: over.id ?? 'c',
    type: 'console.error',
    timestamp: over.ts ?? BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 2,
    tabId: 1,
    url: 'https://example.com/page',
    data: { level: 'error', message: 'boom' },
  };
}

describe('detect — single-event rules', () => {
  it('flags failed network with 500 status', () => {
    const r = detect(fetchEvt({ status: 500 }), []);
    expect(r.flags).toContain('failed');
  });

  it('flags successful network with no flags', () => {
    const r = detect(fetchEvt({ status: 200 }), []);
    expect(r.flags).toEqual([]);
  });

  it('flags console.error as failed', () => {
    const r = detect(consoleErrEvt(), []);
    expect(r.flags).toContain('failed');
  });

  it('flags slow request when duration > 3000ms', () => {
    const r = detect(fetchEvt({ status: 200, durationMs: SLOW_REQUEST_MS + 100 }), []);
    expect(r.flags).toContain('slow');
  });

  it('does not flag a 2999ms request as slow', () => {
    const r = detect(fetchEvt({ status: 200, durationMs: SLOW_REQUEST_MS - 1 }), []);
    expect(r.flags).not.toContain('slow');
  });
});

describe('detect — cascade rule', () => {
  it('does nothing when only 1 prior failure exists', () => {
    const buffer: CapturedEvent[] = [fetchEvt({ id: 'a', ts: BASE_TS, status: 500 })];
    const r = detect(fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500 }), buffer);
    expect(r.cascadeOf).toBeUndefined();
  });

  it('marks the third failure within window as a cascade member', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', ts: BASE_TS, status: 500 }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500 }),
    ];
    const r = detect(fetchEvt({ id: 'c', ts: BASE_TS + 2000, status: 500 }), buffer);
    expect(r.cascadeOf).toBe('a');
    expect(r.flags).toContain('cascade-member');
  });

  it('marks the threshold-tripping event as cascade-head (one-shot signal)', () => {
    // The 3rd failure within the window is what SW desktop notifications
    // and the sidepanel cluster banner key off — without cascade-head
    // on this exact event, the one-shot notification never fires.
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', ts: BASE_TS, status: 500 }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500 }),
    ];
    const r = detect(fetchEvt({ id: 'c', ts: BASE_TS + 2000, status: 500 }), buffer);
    expect(r.flags).toContain('cascade-head');
    expect(r.flags).toContain('cascade-member');
  });

  it('does NOT re-fire cascade-head on the 4th failure (inherits cluster)', () => {
    // The 4th failure joins the cluster as a plain member. cascade-head
    // is a one-shot flag — if it fired again, SW notifications would
    // spam the user every additional in-window failure.
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', ts: BASE_TS, status: 500 }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500 }),
      fetchEvt({ id: 'c', ts: BASE_TS + 2000, status: 500, cascadeOf: 'a' }),
    ];
    const r = detect(fetchEvt({ id: 'd', ts: BASE_TS + 3000, status: 500 }), buffer);
    expect(r.cascadeOf).toBe('a');
    expect(r.flags).toContain('cascade-member');
    expect(r.flags).not.toContain('cascade-head');
  });

  it('does not cascade across different origins', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', ts: BASE_TS, status: 500, url: 'https://api.a.com/x' }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500, url: 'https://api.b.com/x' }),
    ];
    const r = detect(
      fetchEvt({ id: 'c', ts: BASE_TS + 2000, status: 500, url: 'https://api.c.com/x' }),
      buffer
    );
    expect(r.cascadeOf).toBeUndefined();
  });

  it('does not cascade across the 10-second window', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', ts: BASE_TS, status: 500 }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500 }),
    ];
    const r = detect(
      fetchEvt({ id: 'c', ts: BASE_TS + CASCADE_WINDOW_MS + 1, status: 500 }),
      buffer
    );
    expect(r.cascadeOf).toBeUndefined();
  });

  it('inherits an existing cascade head when one exists in the window', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'head', ts: BASE_TS, status: 500 }),
      fetchEvt({ id: 'b', ts: BASE_TS + 1000, status: 500, cascadeOf: 'head' }),
    ];
    const r = detect(fetchEvt({ id: 'c', ts: BASE_TS + 2000, status: 500 }), buffer);
    expect(r.cascadeOf).toBe('head');
  });
});

describe('detect — repeated identical failure', () => {
  it('flags an exact repeat as anomaly', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({
        id: 'a',
        url: 'https://api.example.com/x',
        method: 'POST',
        status: 500,
      }),
    ];
    const r = detect(
      fetchEvt({
        id: 'b',
        ts: BASE_TS + 100,
        url: 'https://api.example.com/x',
        method: 'POST',
        status: 500,
      }),
      buffer
    );
    expect(r.flags).toContain('anomaly');
  });

  it('does not flag a different status as anomaly', () => {
    const buffer: CapturedEvent[] = [
      fetchEvt({ id: 'a', url: 'https://api.example.com/x', status: 500 }),
    ];
    const r = detect(fetchEvt({ id: 'b', url: 'https://api.example.com/x', status: 503 }), buffer);
    expect(r.flags).not.toContain('anomaly');
  });
});

/** Runs events through detect() the way the SW does: stamp, then append. */
function pipeline(events: NetworkFetchEvent[]): CapturedEvent[] {
  const stored: CapturedEvent[] = [];
  for (const e of events) {
    const r = detect(e, stored);
    stored.push(r.cascadeOf ? { ...e, meta: { flags: r.flags, cascadeOf: r.cascadeOf } } : e);
  }
  return stored;
}

function clusters(stored: CapturedEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [member, head] of resolveClusters(stored)) {
    out.set(head, [...(out.get(head) ?? [head]), member].sort());
  }
  return out;
}

describe('cascade clustering (1.0 A3)', () => {
  it('[500, 401, 401, 401, 404] → one 401 cluster of 3; 500 and 404 stay single', () => {
    const statuses = [500, 401, 401, 401, 404];
    const stored = pipeline(
      statuses.map((status, i) => fetchEvt({ id: `e${i}`, ts: BASE_TS + i * 200, status }))
    );
    const c = clusters(stored);
    expect([...c.entries()]).toEqual([['e1', ['e1', 'e2', 'e3']]]);
    expect(stored[3]!.meta?.flags).toContain('cascade-head');
    expect(stored[0]!.meta).toBeUndefined();
    expect(stored[4]!.meta).toBeUndefined();
  });

  it('still triggers a generic cascade for 3× 5xx (head counted)', () => {
    const stored = pipeline(
      [500, 502, 503].map((status, i) => fetchEvt({ id: `s${i}`, ts: BASE_TS + i * 100, status }))
    );
    expect([...clusters(stored).entries()]).toEqual([['s0', ['s0', 's1', 's2']]]);
  });

  it('keeps 403 in the auth class with 401', () => {
    const stored = pipeline(
      [401, 403, 401].map((status, i) => fetchEvt({ id: `a${i}`, ts: BASE_TS + i, status }))
    );
    expect(clusters(stored).get('a0')).toEqual(['a0', 'a1', 'a2']);
  });

  it('groups relative request URLs by the page origin', () => {
    // fetch('/api/auth?i=N') is captured with a relative URL.
    const stored = pipeline(
      [0, 1, 2].map((i) =>
        fetchEvt({ id: `r${i}`, ts: BASE_TS + i, status: 401, url: `/api/auth?i=${i}` })
      )
    );
    expect(clusters(stored).get('r0')).toEqual(['r0', 'r1', 'r2']);
  });

  it('later members join the same cluster without backfilling other classes', () => {
    const stored = pipeline(
      [500, 500, 404, 500, 500].map((status, i) =>
        fetchEvt({ id: `m${i}`, ts: BASE_TS + i * 100, status })
      )
    );
    expect([...clusters(stored).entries()]).toEqual([['m0', ['m0', 'm1', 'm3', 'm4']]]);
  });
});
