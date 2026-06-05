import { describe, expect, it } from 'vitest';

import type { CapturedEvent, EventCategory, NetworkFetchEvent } from './events';
import { EVENT_CATEGORIES, categoryOf, isApiRequest } from './events';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 0, 0);

function fetchEvt(
  url: string,
  opts: { contentType?: string; status?: number; method?: string } = {}
): NetworkFetchEvent {
  const headers: Record<string, string> = {};
  if (opts.contentType) headers['content-type'] = opts.contentType;
  return {
    id: 'e' + Math.random().toString(36).slice(2, 7),
    type: 'network.fetch',
    timestamp: BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 1,
    tabId: 1,
    url: 'https://app.example.com/',
    data: {
      request: {
        method: opts.method ?? 'GET',
        url,
        headers: {},
        body: null,
      },
      response: {
        status: opts.status ?? 200,
        statusText: 'OK',
        headers,
        body: null,
      },
      timing: { startedAt: BASE_TS, durationMs: 12 },
      error: null,
    },
  };
}

describe('isApiRequest', () => {
  it('keeps a JSON API endpoint', () => {
    expect(
      isApiRequest(
        fetchEvt('https://api.example.com/v1/users', { contentType: 'application/json' })
      )
    ).toBe(true);
  });

  it('keeps a GraphQL endpoint', () => {
    expect(
      isApiRequest(
        fetchEvt('https://api.example.com/graphql', {
          contentType: 'application/json',
          method: 'POST',
        })
      )
    ).toBe(true);
  });

  it('keeps a request with no response content-type (preflight, streaming)', () => {
    expect(isApiRequest(fetchEvt('https://api.example.com/v1/save', { method: 'OPTIONS' }))).toBe(
      true
    );
  });

  it('rejects Next.js chunked JS', () => {
    expect(isApiRequest(fetchEvt('https://app.example.com/_next/static/chunks/main.js'))).toBe(
      false
    );
  });

  it('rejects Next.js data prefetches', () => {
    expect(isApiRequest(fetchEvt('https://app.example.com/_next/data/abc123/page.json'))).toBe(
      false
    );
  });

  it('rejects Next.js image optimizer', () => {
    expect(
      isApiRequest(fetchEvt('https://app.example.com/_next/image?url=/foo.png&w=1080&q=75'))
    ).toBe(false);
  });

  it('rejects a .js asset', () => {
    expect(isApiRequest(fetchEvt('https://cdn.example.com/bundle.js'))).toBe(false);
  });

  it('rejects a .css asset', () => {
    expect(isApiRequest(fetchEvt('https://cdn.example.com/styles.css'))).toBe(false);
  });

  it('rejects a .woff2 font', () => {
    expect(isApiRequest(fetchEvt('https://cdn.example.com/font.woff2'))).toBe(false);
  });

  it('rejects a PNG image even when served as JSON content-type (treats URL ext as authoritative)', () => {
    expect(
      isApiRequest(
        fetchEvt('https://cdn.example.com/avatar.png', { contentType: 'application/json' })
      )
    ).toBe(false);
  });

  it('rejects by content-type when URL has no extension', () => {
    expect(
      isApiRequest(fetchEvt('https://cdn.example.com/asset/abc123', { contentType: 'image/png' }))
    ).toBe(false);
    expect(
      isApiRequest(fetchEvt('https://cdn.example.com/asset/abc124', { contentType: 'text/css' }))
    ).toBe(false);
    expect(
      isApiRequest(
        fetchEvt('https://cdn.example.com/asset/abc125', { contentType: 'application/javascript' })
      )
    ).toBe(false);
    expect(
      isApiRequest(fetchEvt('https://cdn.example.com/asset/abc126', { contentType: 'font/woff2' }))
    ).toBe(false);
  });

  it('rejects Vite HMR and sockjs', () => {
    expect(isApiRequest(fetchEvt('http://localhost:5173/__vite_ping'))).toBe(false);
    expect(isApiRequest(fetchEvt('http://localhost:3000/sockjs-node/info'))).toBe(false);
  });

  it('strips query/fragment before extension check', () => {
    expect(isApiRequest(fetchEvt('https://cdn.example.com/main.js?v=42#asd'))).toBe(false);
  });

  it('rejects non-network event types', () => {
    const consoleErr: CapturedEvent = {
      id: 'c1',
      type: 'console.error',
      timestamp: BASE_TS,
      sessionId: 's',
      sequenceNumber: 1,
      tabId: 1,
      url: 'https://app.example.com/',
      data: { level: 'error', message: 'boom' },
    };
    expect(isApiRequest(consoleErr)).toBe(false);
  });

  it('keeps capitalized Content-Type header', () => {
    const e = fetchEvt('https://api.example.com/v1/users');
    e.data.response.headers['Content-Type'] = 'application/json';
    expect(isApiRequest(e)).toBe(true);
  });

  it('keeps a Next.js Server Action POST to /', () => {
    expect(
      isApiRequest(
        fetchEvt('https://app.example.com/', { method: 'POST', contentType: 'text/plain' })
      )
    ).toBe(true);
  });

  it('rejects an .map sourcemap fetch', () => {
    expect(isApiRequest(fetchEvt('https://cdn.example.com/bundle.js.map'))).toBe(false);
  });
});

describe('categoryOf', () => {
  function ev(type: CapturedEvent['type']): CapturedEvent {
    // categoryOf only reads `type`; the rest is filler.
    return {
      id: 'x',
      timestamp: BASE_TS,
      sessionId: 's',
      sequenceNumber: 1,
      tabId: 1,
      url: 'https://app.example.com/',
      type,
      data: {},
    } as unknown as CapturedEvent;
  }

  const cases: Array<[CapturedEvent['type'], EventCategory]> = [
    ['network.fetch', 'network'],
    ['network.xhr', 'network'],
    ['network.websocket', 'network'],
    ['network.sse', 'network'],
    ['console.error', 'console'],
    ['console.warn', 'console'],
    ['console.info', 'console'],
    ['console.unhandled', 'console'],
    ['navigation', 'navigation'],
    ['action.click', 'action'],
    ['action.input', 'action'],
    ['action.scroll', 'action'],
    ['action.focus', 'action'],
    ['cursor', 'action'],
    ['mutation', 'action'],
    ['recording.start', 'action'],
    ['recording.stop', 'action'],
    ['performance.longtask', 'performance'],
    ['performance.cls', 'performance'],
    ['screenshot', 'screenshot'],
  ];

  it.each(cases)('maps %s -> %s', (type, expected) => {
    expect(categoryOf(ev(type))).toBe(expected);
    expect(EVENT_CATEGORIES).toContain(expected);
  });
});
