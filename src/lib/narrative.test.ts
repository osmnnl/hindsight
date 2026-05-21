import { describe, expect, it } from 'vitest';

import type {
  ActionClickEvent,
  ActionInputEvent,
  CapturedEvent,
  ConsoleErrorEvent,
  NavigationEvent,
  NetworkFetchEvent,
} from '@/types/events';
import { narrate } from './narrative';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 32, 0);

function netFetch(over: Partial<NetworkFetchEvent> & { url?: string } = {}): NetworkFetchEvent {
  return {
    id: 'n',
    type: 'network.fetch',
    timestamp: BASE_TS,
    sessionId: 'sess',
    sequenceNumber: 1,
    tabId: 1,
    url: over.url ?? 'https://example.com/page',
    data: {
      request: { method: 'POST', url: 'https://example.com/api/save', headers: {}, body: null },
      response: { status: 500, statusText: 'Internal Server Error', headers: {}, body: '{}' },
      timing: { startedAt: BASE_TS, durationMs: 412 },
      error: null,
    },
    ...over,
  };
}

function consoleErr(over: Partial<ConsoleErrorEvent> = {}): ConsoleErrorEvent {
  return {
    id: 'c',
    type: 'console.error',
    timestamp: BASE_TS + 1000,
    sessionId: 'sess',
    sequenceNumber: 2,
    tabId: 1,
    url: 'https://example.com/page',
    data: { level: 'error', message: 'Cannot read property x' },
    ...over,
  };
}

function click(over: Partial<ActionClickEvent> = {}): ActionClickEvent {
  return {
    id: 'k',
    type: 'action.click',
    timestamp: BASE_TS + 2000,
    sessionId: 'sess',
    sequenceNumber: 3,
    tabId: 1,
    url: 'https://example.com/page',
    data: {
      target: { tag: 'BUTTON', accessibleName: 'Save' },
      button: 0,
      modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    },
    ...over,
  };
}

function input(over: Partial<ActionInputEvent> = {}): ActionInputEvent {
  return {
    id: 'i',
    type: 'action.input',
    timestamp: BASE_TS + 3000,
    sessionId: 'sess',
    sequenceNumber: 4,
    tabId: 1,
    url: 'https://example.com/page',
    data: {
      target: { tag: 'INPUT', accessibleName: 'Email' },
      value: 'foo@example.com',
      inputType: 'email',
    },
    ...over,
  };
}

function nav(over: Partial<NavigationEvent> = {}): NavigationEvent {
  return {
    id: 'v',
    type: 'navigation',
    timestamp: BASE_TS + 4000,
    sessionId: 'sess',
    sequenceNumber: 5,
    tabId: 1,
    url: 'https://example.com/dashboard',
    data: {
      fromUrl: 'https://example.com/login',
      toUrl: 'https://example.com/dashboard',
      transitionType: 'link',
    },
    ...over,
  };
}

describe('narrate', () => {
  it('returns empty string for empty input', () => {
    expect(narrate([])).toBe('');
  });

  it('renders an overview line with host, span, counts', () => {
    const out = narrate([netFetch(), click(), nav()]);
    expect(out).toContain('## Session narrative');
    expect(out).toContain('**3** events');
    expect(out).toContain('example.com');
    expect(out).toMatch(/over \dms|over \ds/);
  });

  it('lists network failures with status / method / path / duration', () => {
    const out = narrate([netFetch()]);
    expect(out).toContain('**Failures**');
    expect(out).toContain('**500** POST /api/save');
    expect(out).toContain('412ms');
  });

  it('lists console errors under Failures', () => {
    const out = narrate([consoleErr()]);
    expect(out).toContain('**Failures**');
    expect(out).toContain('console.error');
    expect(out).toContain('Cannot read property x');
  });

  it('emits an Actions section for click + input', () => {
    const out = narrate([click(), input()]);
    expect(out).toContain('**Actions**');
    expect(out).toContain('click on <button>');
    expect(out).toContain('Save');
    expect(out).toContain('input *Email*');
    expect(out).toContain('foo@example.com');
  });

  it('emits a Navigation section with the chain', () => {
    const out = narrate([nav()]);
    expect(out).toContain('**Navigation**');
    expect(out).toContain('/login → /dashboard');
  });

  it('omits sections that have no events', () => {
    const out = narrate([click()]);
    expect(out).toContain('**Actions**');
    expect(out).not.toContain('**Failures**');
    expect(out).not.toContain('**Navigation**');
  });

  it('sorts events by timestamp before rendering', () => {
    const out = narrate([nav(), click(), netFetch()]);
    // Failures (oldest network) appear before the actions and nav lines.
    const failIdx = out.indexOf('**Failures**');
    const actIdx = out.indexOf('**Actions**');
    const navIdx = out.indexOf('**Navigation**');
    expect(failIdx).toBeLessThan(actIdx);
    expect(actIdx).toBeLessThan(navIdx);
  });

  it('clamps long messages so the narrative stays readable', () => {
    const long = 'x'.repeat(500);
    const out = narrate([consoleErr({ data: { level: 'error', message: long } })]);
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(300));
  });

  it('produces no Failures section for purely successful network', () => {
    const ok: CapturedEvent = netFetch({
      data: {
        request: { method: 'GET', url: 'https://example.com/api/ok', headers: {}, body: null },
        response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
        timing: { startedAt: BASE_TS, durationMs: 50 },
        error: null,
      },
    });
    const out = narrate([ok]);
    expect(out).not.toContain('**Failures**');
    expect(out).toContain('**1** event');
  });

  it('handles initial navigation (fromUrl = null) as "(initial)"', () => {
    const out = narrate([nav({ data: { fromUrl: null, toUrl: 'https://example.com/home' } })]);
    expect(out).toContain('(initial) → /home');
  });
});
