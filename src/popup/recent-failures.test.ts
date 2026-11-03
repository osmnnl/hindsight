import { describe, expect, it } from 'vitest';
import type { CapturedEvent } from '@/types/events';
import { recentFailures } from './recent-failures';

let seq = 0;
function net(status: number, meta?: CapturedEvent['meta']): CapturedEvent {
  seq++;
  return {
    id: `e${seq}`,
    type: 'network.fetch',
    timestamp: seq,
    sessionId: 's',
    sequenceNumber: seq,
    tabId: 1,
    url: 'https://example.test/',
    data: {
      request: { method: 'GET', url: 'https://example.test/api', headers: {}, body: null },
      response: { status, statusText: '', headers: {}, body: null },
      timing: { startedAt: seq, durationMs: 1 },
      error: null,
    },
    ...(meta ? { meta } : {}),
  } as CapturedEvent;
}

describe('recentFailures', () => {
  it('returns the newest failures first, capped', () => {
    const evts = [net(500), net(200), net(404), net(502), net(503)];
    expect(recentFailures(evts, 3).map((r) => r.event.id)).toEqual([
      evts[4]!.id,
      evts[3]!.id,
      evts[2]!.id,
    ]);
  });

  it('collapses a cascade into its head with a member count', () => {
    const head = net(401);
    const a = net(401, { cascadeOf: head.id });
    const b = net(401, { cascadeOf: head.id });
    const other = net(500);
    const out = recentFailures([head, a, b, other], 3);
    expect(out.map((r) => [r.event.id, r.clusterSize])).toEqual([
      [other.id, 1],
      [head.id, 3],
    ]);
  });

  it('includes console errors and skips successes', () => {
    const err = {
      ...net(200),
      type: 'console.error',
      data: { level: 'error', message: 'boom' },
    } as CapturedEvent;
    expect(recentFailures([net(200), err], 3).map((r) => r.event.type)).toEqual(['console.error']);
  });
});
