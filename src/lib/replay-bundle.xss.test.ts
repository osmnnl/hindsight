// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import type { NetworkFetchEvent } from '@/types/events';
import { generateBundle, jsonForScriptElement } from './replay-bundle';

const PAYLOADS = [
  '</script><script>window.__pwned=1</script>',
  '<!--<script>window.__pwned=1</script>',
  'line\u2028sep\u2029para',
  '</SCRIPT ><img src=x onerror="window.__pwned=1">',
  '&lt;b&gt; & <![CDATA[ ]]>',
];

function evt(i: number, body: string): NetworkFetchEvent {
  return {
    id: `n${i}`,
    type: 'network.fetch',
    timestamp: 1_700_000_000_000 + i * 1000,
    sessionId: 'sess',
    sequenceNumber: i,
    tabId: 1,
    url: 'https://example.com/page',
    data: {
      request: { method: 'POST', url: 'https://api.example.com/x', headers: {}, body },
      response: { status: 500, statusText: 'Internal', headers: {}, body },
      timing: { startedAt: 1_700_000_000_000, durationMs: 5 },
      error: null,
    },
  };
}

describe('replay bundle stored-XSS regression (1.0 A1)', () => {
  const events = Array.from({ length: 15 }, (_, i) => evt(i, PAYLOADS[i % PAYLOADS.length]!));
  const html = generateBundle(events, { appVersion: '1.0.0', title: 'xss' });
  const doc = new DOMParser().parseFromString(html, 'text/html');

  it('a captured body cannot open or close a script element', () => {
    const scripts = [...doc.querySelectorAll('script')];
    // Exactly the data block and the viewer — nothing injected.
    expect(scripts.map((s) => s.type || 'js')).toEqual(['application/json', 'js']);
    expect(doc.querySelectorAll('img').length).toBe(0);
    const dataText = doc.getElementById('hs-data')!.textContent!;
    expect(dataText).not.toMatch(/[<>&\u2028\u2029]/);
  });

  it('round-trips every event and body byte-equal', () => {
    const data = JSON.parse(doc.getElementById('hs-data')!.textContent!) as {
      events: NetworkFetchEvent[];
    };
    expect(data.events.length).toBe(events.length);
    data.events.forEach((e, i) => {
      expect(e.data.request.body).toBe(events[i]!.data.request.body);
      expect(e.data.response!.body).toBe(events[i]!.data.response!.body);
    });
  });

  it('ships a CSP that only allows the nonced viewer script', () => {
    const csp = doc
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute('content')!;
    expect(csp).toContain("default-src 'none'");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(nonce).toBeTruthy();
    const viewer = [...doc.querySelectorAll('script')].find((s) => !s.type)!;
    expect(viewer.getAttribute('nonce')).toBe(nonce);
  });

  it('uses a fresh nonce per bundle', () => {
    const nonceOf = (h: string) => /'nonce-([^']+)'/.exec(h)![1];
    expect(nonceOf(generateBundle(events, { appVersion: '1' }))).not.toBe(nonceOf(html));
  });

  it('escapes the five dangerous characters', () => {
    expect(jsonForScriptElement('</script>&\u2028\u2029')).toBe(
      '"\\u003c/script\\u003e\\u0026\\u2028\\u2029"'
    );
  });
});
