import { describe, expect, it } from 'vitest';
import { MASKED } from '@/lib/masking';
import type { NetworkFetchEvent } from '@/types/events';
import { extractAccessToken, toFetch } from './copy-formats';

function req(
  headers: Record<string, string>,
  body: string | null = null,
  method = 'POST'
): NetworkFetchEvent {
  return {
    id: 'e1',
    type: 'network.fetch',
    timestamp: 0,
    sessionId: 's',
    sequenceNumber: 0,
    tabId: 1,
    url: 'https://example.test/',
    data: {
      request: { method, url: 'https://example.test/api?q=1', headers, body },
      response: { status: 500, statusText: '', headers: {}, body: null },
      timing: { startedAt: 0, durationMs: 1 },
      error: null,
    },
  };
}

describe('toFetch (copy as fetch)', () => {
  it('produces a runnable call with method, headers and body', () => {
    const out = toFetch(req({ 'content-type': 'application/json' }, '{"a":"it\'s"}'));
    const calls: unknown[][] = [];
    // Evaluate the snippet against a stub fetch to prove it parses and
    // round-trips the request faithfully.
    new Function('fetch', out)((...args: unknown[]) => calls.push(args));
    expect(calls).toEqual([
      [
        'https://example.test/api?q=1',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"it\'s"}' },
      ],
    ]);
  });

  it('omits empty headers and body', () => {
    expect(toFetch(req({}, null, 'GET'))).toBe(
      'fetch("https://example.test/api?q=1", {\n  method: "GET",\n});'
    );
  });
});

describe('extractAccessToken (masked-token copy guard)', () => {
  it('strips the scheme prefix', () => {
    expect(extractAccessToken(req({ Authorization: 'Bearer abc.def' }))).toBe('abc.def');
  });

  it('surfaces the mask so the UI can lock the Token chip', () => {
    expect(extractAccessToken(req({ authorization: `Bearer ${MASKED}` }))).toContain(MASKED);
  });

  it('is empty without an Authorization header', () => {
    expect(extractAccessToken(req({}))).toBe('');
  });
});
