import { describe, expect, it } from 'vitest';
import { newestFirst } from './list-order';
import type { CapturedEvent } from '@/types/events';

const ev = (id: string, timestamp: number) => ({ id, timestamp }) as CapturedEvent;

const req = (id: string, startedAt: number, timestamp: number) =>
  ({ id, type: 'network.fetch', timestamp, data: { timing: { startedAt } } }) as CapturedEvent;

describe('newestFirst', () => {
  it('places a request by its start time, the time its row shows', () => {
    // 404 started at 3, completed (captured) at 9; console error at 4.
    const arrival = [ev('err', 4), req('404', 3, 9)];
    expect(newestFirst(arrival).map((e) => e.id)).toEqual(['err', '404']);
  });

  it('orders by timestamp, not arrival', () => {
    // A fetch started at t=10 completes after a click at t=20.
    const arrival = [ev('click', 20), ev('fetch', 10), ev('console', 30)];
    expect(newestFirst(arrival).map((e) => e.id)).toEqual(['console', 'click', 'fetch']);
  });

  it('keeps newest arrival first on equal timestamps', () => {
    expect(newestFirst([ev('a', 5), ev('b', 5)]).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('does not mutate the input', () => {
    const input = [ev('a', 2), ev('b', 1)];
    newestFirst(input);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
  });
});
