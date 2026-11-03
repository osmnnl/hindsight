import { describe, expect, it } from 'vitest';
import { newestFirst } from './list-order';
import type { CapturedEvent } from '@/types/events';

const ev = (id: string, timestamp: number) => ({ id, timestamp }) as CapturedEvent;

describe('newestFirst', () => {
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
