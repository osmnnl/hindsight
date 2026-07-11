import { describe, expect, it } from 'vitest';

import type {
  ActionClickEvent,
  CapturedEvent,
  ConsoleErrorEvent,
  NavigationEvent,
  NetworkFetchEvent,
} from '@/types/events';
import { toMarkdownReport } from './markdown';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 0, 0);

function netEvt(over: Partial<NetworkFetchEvent['data']> = {}): NetworkFetchEvent {
  return {
    id: 'n',
    type: 'network.fetch',
    timestamp: BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 1,
    tabId: 1,
    url: 'https://example.com/p',
    data: {
      request: {
        method: 'POST',
        url: 'https://api.example.com/save',
        headers: { 'Content-Type': 'application/json' },
        body: '{"x":1}',
      },
      response: { status: 500, statusText: 'Internal', headers: {}, body: 'oops' },
      timing: { startedAt: BASE_TS, durationMs: 412 },
      error: null,
      ...over,
    },
  };
}

function clickEvt(): ActionClickEvent {
  return {
    id: 'k',
    type: 'action.click',
    timestamp: BASE_TS + 100,
    sessionId: 'sess',
    sequenceNumber: 2,
    tabId: 1,
    url: 'https://example.com/p',
    data: {
      target: { tag: 'BUTTON', accessibleName: 'Save' },
      button: 0,
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    },
  };
}

function consoleEvt(): ConsoleErrorEvent {
  return {
    id: 'c',
    type: 'console.error',
    timestamp: BASE_TS + 200,
    sessionId: 'sess',
    sequenceNumber: 3,
    tabId: 1,
    url: 'https://example.com/p',
    data: { level: 'error', message: 'boom', stack: 'at foo' },
  };
}

function navEvt(): NavigationEvent {
  return {
    id: 'v',
    type: 'navigation',
    timestamp: BASE_TS + 50,
    sessionId: 'sess',
    sequenceNumber: 4,
    tabId: 1,
    url: 'https://example.com/p',
    data: { fromUrl: 'https://example.com/a', toUrl: 'https://example.com/p' },
  };
}

describe('toMarkdownReport', () => {
  it('returns empty string for empty input', () => {
    expect(toMarkdownReport([])).toBe('');
  });

  it('renders a title + Captured/Events header', () => {
    const md = toMarkdownReport([netEvt()]);
    expect(md).toMatch(/^# /);
    expect(md).toContain('Events: 1');
    expect(md).toContain('Captured: ');
  });

  it('embeds a narrative section for 2+ events', () => {
    const md = toMarkdownReport([netEvt(), clickEvt()]);
    expect(md).toContain('Session narrative');
  });

  it('omits narrative for single event', () => {
    const md = toMarkdownReport([netEvt()]);
    expect(md).not.toContain('Session narrative');
  });

  it('renders network detail with request/response sections', () => {
    const md = toMarkdownReport([netEvt()]);
    expect(md).toContain('## 500 POST https://api.example.com/save');
    expect(md).toContain('Request headers');
    expect(md).toContain('Request body');
    expect(md).toContain('Response headers');
    expect(md).toContain('Response body');
  });

  it('renders console with stack', () => {
    const md = toMarkdownReport([consoleEvt()]);
    expect(md).toContain('CONSOLE.ERROR');
    expect(md).toContain('boom');
    expect(md).toContain('at foo');
  });

  it('renders navigation chain', () => {
    const md = toMarkdownReport([navEvt()]);
    expect(md).toContain('https://example.com/a → https://example.com/p');
  });

  it('renders action with target descriptor', () => {
    const md = toMarkdownReport([clickEvt()]);
    expect(md).toContain('Click');
    expect(md).toContain('`<button>`');
    expect(md).toContain('Save');
  });

  it('respects maxDetailEvents and notes the truncation', () => {
    const events: CapturedEvent[] = [netEvt(), clickEvt(), consoleEvt(), navEvt()];
    const md = toMarkdownReport(events, { maxDetailEvents: 2 });
    expect(md).toContain('Showing the **2 most recent** events out of 4');
  });

  it('honors skipNarrative even when events.length >= 2', () => {
    const md = toMarkdownReport([netEvt(), clickEvt()], { skipNarrative: true });
    expect(md).not.toContain('Session narrative');
  });

  it('escapes markdown specials in titles (underscores and asterisks)', () => {
    // A real Next.js path like /api/_test_method_/health would otherwise
    // turn into "/api/<em>test</em>method<em>/health" on GitHub
    // renderers. Same hazard for query params containing `*`.
    const md = toMarkdownReport([netEvt()], {
      title: 'failed: GET /_test_method_/health *raw*',
    });
    const titleLine = md.split('\n')[0]!;
    expect(titleLine).toContain('\\_test\\_method\\_');
    expect(titleLine).toContain('\\*raw\\*');
  });

  it('escapes bracket pairs in titles so links do not collapse text', () => {
    const md = toMarkdownReport([netEvt()], { title: 'failed: [POST] /api/orders' });
    const titleLine = md.split('\n')[0]!;
    expect(titleLine).toContain('\\[POST\\]');
  });
});

describe('capture-limit omitted-events note', () => {
  it('renders the note when omittedEventCount > 0', () => {
    const md = toMarkdownReport([netEvt()], { omittedEventCount: 49 });
    expect(md).toContain('49 earlier event(s) omitted');
  });
  it('omits the note when omittedEventCount is 0 / undefined', () => {
    expect(toMarkdownReport([netEvt()], {})).not.toContain('earlier event(s) omitted');
    expect(toMarkdownReport([netEvt()], { omittedEventCount: 0 })).not.toContain(
      'earlier event(s) omitted'
    );
  });
});
