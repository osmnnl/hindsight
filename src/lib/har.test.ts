import { describe, expect, it } from 'vitest';

import { toHar } from './har';
import type { CapturedEvent, NetworkFetchEvent } from '@/types/events';

function makeFetchEvent(overrides: Partial<NetworkFetchEvent['data']> = {}): NetworkFetchEvent {
  return {
    id: 'evt-1',
    type: 'network.fetch',
    timestamp: 1_700_000_000_000,
    sessionId: 'sess-1',
    sequenceNumber: 1,
    tabId: 42,
    url: 'https://example.com/page',
    data: {
      request: {
        method: 'POST',
        url: 'https://api.example.com/v1/save?id=123&kind=foo',
        headers: { 'Content-Type': 'application/json', Authorization: '***MASKED***' },
        body: '{"hello":"world"}',
        ...overrides.request,
      },
      response: {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
        body: '{"error":"validation"}',
        ...overrides.response,
      },
      timing: { startedAt: 1_700_000_000_000, durationMs: 412, ...overrides.timing },
      error: overrides.error ?? null,
    },
  };
}

describe('toHar', () => {
  it('produces a HAR 1.2 log with creator + entries', () => {
    const har = toHar([makeFetchEvent()], { creatorVersion: '0.0.1' });
    expect(har.version).toBe('1.2');
    expect(har.creator).toEqual({ name: 'Hindsight', version: '0.0.1' });
    expect(har.entries).toHaveLength(1);
  });

  it('maps request / response / timings / cache slot per spec', () => {
    const har = toHar([makeFetchEvent()], { creatorVersion: '0.0.1' });
    const e = har.entries[0]!;

    expect(e.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(e.time).toBe(412);
    expect(e.cache).toEqual({});
    expect(e.timings.wait).toBe(412);
    expect(e.timings.send).toBe(-1);
    expect(e.timings.blocked).toBe(-1);

    expect(e.request.method).toBe('POST');
    expect(e.request.url).toBe('https://api.example.com/v1/save?id=123&kind=foo');
    expect(e.request.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: '***MASKED***' },
    ]);
    expect(e.request.postData).toEqual({
      mimeType: 'application/json',
      text: '{"hello":"world"}',
    });

    expect(e.response.status).toBe(400);
    expect(e.response.statusText).toBe('Bad Request');
    expect(e.response.content).toMatchObject({
      mimeType: 'application/json',
      text: '{"error":"validation"}',
    });
  });

  it('parses the query string from the request URL', () => {
    const har = toHar([makeFetchEvent()], { creatorVersion: '0.0.1' });
    expect(har.entries[0]?.request.queryString).toEqual([
      { name: 'id', value: '123' },
      { name: 'kind', value: 'foo' },
    ]);
  });

  it('extracts Cookie request header into request.cookies', () => {
    const event = makeFetchEvent({
      request: {
        method: 'GET',
        url: 'https://api.example.com/u',
        headers: { Cookie: 'sid=abc; theme=dark' },
        body: null,
      },
    });
    const har = toHar([event], { creatorVersion: '0.0.1' });
    expect(har.entries[0]?.request.cookies).toEqual([
      { name: 'sid', value: 'abc' },
      { name: 'theme', value: 'dark' },
    ]);
  });

  it('extracts Set-Cookie response header into response.cookies (single pair)', () => {
    const event = makeFetchEvent({
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'Set-Cookie': 'sid=abc; Path=/; HttpOnly', 'Content-Type': 'text/html' },
        body: '<html/>',
      },
    });
    const har = toHar([event], { creatorVersion: '0.0.1' });
    expect(har.entries[0]?.response.cookies).toEqual([{ name: 'sid', value: 'abc' }]);
  });

  it('skips non-network events', () => {
    const other: CapturedEvent = {
      id: 'evt-2',
      type: 'console.error',
      timestamp: 1,
      sessionId: 'sess-1',
      sequenceNumber: 2,
      tabId: 42,
      url: 'https://example.com',
      data: { level: 'error', message: 'boom' },
    };
    const har = toHar([makeFetchEvent(), other], { creatorVersion: '0.0.1' });
    expect(har.entries).toHaveLength(1);
  });

  it('throws when no network events are present', () => {
    expect(() => toHar([], { creatorVersion: '0.0.1' })).toThrow(/no network events/);
  });

  it('emits the optional browser block when supplied', () => {
    const har = toHar([makeFetchEvent()], {
      creatorVersion: '0.0.1',
      browser: { name: 'Chrome', version: '124.0' },
    });
    expect(har.browser).toEqual({ name: 'Chrome', version: '124.0' });
  });

  it('round-trips the event id, sessionId, sequenceNumber under _hindsight', () => {
    const har = toHar([makeFetchEvent()], { creatorVersion: '0.0.1' });
    expect(har.entries[0]?._hindsight).toEqual({
      eventId: 'evt-1',
      sessionId: 'sess-1',
      sequenceNumber: 1,
    });
  });

  it('null body emits no postData and content with size 0', () => {
    const event = makeFetchEvent({
      request: { method: 'GET', url: 'https://x/y', headers: {}, body: null },
      response: { status: 204, statusText: 'No Content', headers: {}, body: null },
    });
    const har = toHar([event], { creatorVersion: '0.0.1' });
    const entry = har.entries[0]!;
    expect(entry.request.postData).toBeUndefined();
    expect(entry.request.bodySize).toBe(0);
    expect(entry.response.content.size).toBe(0);
    expect(entry.response.content.text).toBeUndefined();
  });
});
