import { describe, expect, it } from 'vitest';

import type { CapturedEvent, NetworkFetchEvent } from '@/types/events';
import { generateBundle } from './replay-bundle';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 0, 0);

function fetchEvt(over: Partial<NetworkFetchEvent['data']> = {}): NetworkFetchEvent {
  return {
    id: 'n1',
    type: 'network.fetch',
    timestamp: BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 1,
    tabId: 1,
    url: 'https://example.com/page',
    data: {
      request: {
        method: 'POST',
        url: 'https://api.example.com/save',
        headers: { Authorization: '***MASKED***' },
        body: '{"x":1}',
      },
      response: { status: 500, statusText: 'Internal', headers: {}, body: 'oops' },
      timing: { startedAt: BASE_TS, durationMs: 412 },
      error: null,
      ...over,
    },
  };
}

function readData(html: string): unknown {
  const m = /<script type="application\/json" id="hs-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no data block');
  return JSON.parse(m[1]!);
}

describe('generateBundle', () => {
  it('returns a full HTML document', () => {
    const html = generateBundle([fetchEvt()], { appVersion: '0.4.0' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<head');
    expect(html).toContain('</body>');
  });

  it('embeds the events as an inert JSON data block', () => {
    const html = generateBundle([fetchEvt()], { appVersion: '0.4.0' });
    expect(html).toContain('<script type="application/json" id="hs-data">');
    expect(html).not.toContain('window.__HINDSIGHT__');
    expect(html).toContain('"network.fetch"');
    expect(html).toContain('"sess"');
  });

  it('inlines the viewer JS and CSS so the file opens offline', () => {
    const html = generateBundle([fetchEvt()], { appVersion: '0.4.0' });
    // No <script src=…> or <link rel=stylesheet href=…> — every asset
    // should be inline so the bundle has zero external dependencies.
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/);
  });

  it('stamps the producing app version in the footer', () => {
    const html = generateBundle([fetchEvt()], { appVersion: '0.4.0' });
    expect(html).toContain('Hindsight v0.4.0');
  });

  it('falls back to the first event origin when no title given', () => {
    const html = generateBundle([fetchEvt()], { appVersion: '0.4.0' });
    expect(html).toContain('example.com');
  });

  it('respects an explicit title', () => {
    const html = generateBundle([fetchEvt()], {
      appVersion: '0.4.0',
      title: 'Discharge bug',
    });
    expect(html).toContain('Discharge bug');
  });

  it('survives an empty event list', () => {
    const html = generateBundle([], { appVersion: '0.4.0' });
    // Empty events → empty array, narrative is empty string
    expect(readData(html)).toEqual({ events: [], narrative: '', clusters: {} });
  });

  it('embeds a narrative banner when events span 2+ entries', () => {
    const second: CapturedEvent = {
      ...fetchEvt(),
      id: 'n2',
      timestamp: BASE_TS + 1000,
    };
    const html = generateBundle([fetchEvt(), second], { appVersion: '0.4.0' });
    expect(html).toContain('Session narrative');
  });

  it('escapes HTML in the title field', () => {
    const html = generateBundle([fetchEvt()], {
      appVersion: '0.4.0',
      title: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows the masked-field count and the local-only note in the header', () => {
    const masked = fetchEvt();
    masked.meta = {
      redactions: [
        { scope: 'request.headers', path: 'Authorization', rule: 'header.authorization' },
        { scope: 'response.body', path: '$.token', rule: 'body.token' },
      ],
    };
    const html = generateBundle([masked, { ...fetchEvt(), id: 'n2' }], { appVersion: '1.0.0' });
    expect(html).toContain('2 masked fields');
    expect(html).toContain('nothing was uploaded');
  });

  it('keeps a 15-event bundle under 120 KB', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({ ...fetchEvt(), id: `n${i}` }));
    const html = generateBundle(events, { appVersion: '1.0.0' });
    expect(new TextEncoder().encode(html).length).toBeLessThan(120 * 1024);
  });
});
