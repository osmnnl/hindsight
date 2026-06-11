import { describe, expect, it } from 'vitest';

import { capText, stringifyCapped, TRUNCATION_MARKER } from './capture-limits';

describe('capText', () => {
  it('returns short strings unchanged', () => {
    expect(capText('hello', 100)).toBe('hello');
  });

  it('truncates past the cap with a marker', () => {
    const out = capText('x'.repeat(150), 100);
    expect(out).toBe('x'.repeat(100) + TRUNCATION_MARKER);
  });
});

describe('stringifyCapped', () => {
  it('serializes small values exactly like JSON.stringify', () => {
    expect(stringifyCapped({ a: 1, b: 'two' }, 1000)).toBe('{"a":1,"b":"two"}');
  });

  it('caps the output of large objects', () => {
    const big = { data: 'y'.repeat(50_000) };
    const out = stringifyCapped(big, 1000);
    expect(out.length).toBeLessThanOrEqual(1000 + TRUNCATION_MARKER.length);
  });

  it('bounds the work for huge object graphs instead of serializing them fully', () => {
    // 100k nodes — a full stringify would produce ~1.5MB; the budget
    // aborts long before that and falls back to String(value).
    const huge = Array.from({ length: 100_000 }, (_, i) => ({ i }));
    const out = stringifyCapped(huge, 500);
    expect(out.length).toBeLessThanOrEqual(500 + TRUNCATION_MARKER.length);
  });

  it('handles circular references without throwing', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(stringifyCapped(cyc, 100)).toBe('[object Object]');
  });

  it('stringifies undefined-producing values via String()', () => {
    expect(stringifyCapped(undefined, 100)).toBe('undefined');
  });
});
