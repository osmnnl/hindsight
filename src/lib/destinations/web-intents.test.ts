import { describe, expect, it } from 'vitest';

import type { CapturedEvent, NetworkFetchEvent } from '@/types/events';
import { URL_LENGTH_SAFE_MAX, buildGithubIssueUrl, buildMailtoUrl } from './web-intents';

const BASE_TS = Date.UTC(2026, 4, 21, 14, 0, 0);

function netEvt(id = 'n'): NetworkFetchEvent {
  return {
    id,
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
        headers: {},
        body: '{"x":1}',
      },
      response: { status: 500, statusText: 'Internal', headers: {}, body: 'oops' },
      timing: { startedAt: BASE_TS, durationMs: 412 },
      error: null,
    },
  };
}

describe('buildGithubIssueUrl', () => {
  it('returns null when owner is missing', () => {
    expect(buildGithubIssueUrl([netEvt()], { owner: '', repo: 'hindsight' })).toBeNull();
  });

  it('returns null when repo is missing', () => {
    expect(buildGithubIssueUrl([netEvt()], { owner: 'osmnnl', repo: '' })).toBeNull();
  });

  it('builds an issues/new URL with title and body params', () => {
    const r = buildGithubIssueUrl([netEvt()], { owner: 'osmnnl', repo: 'hindsight' });
    expect(r).not.toBeNull();
    expect(r?.url).toContain('https://github.com/osmnnl/hindsight/issues/new');
    expect(r?.url).toContain('title=');
    expect(r?.url).toContain('body=');
  });

  it('URL-encodes owner and repo', () => {
    const r = buildGithubIssueUrl([netEvt()], { owner: 'team/x', repo: 'my repo' });
    expect(r?.url).toContain('team%2Fx');
    expect(r?.url).toContain('my%20repo');
  });

  it('truncates when the URL exceeds URL_LENGTH_SAFE_MAX', () => {
    const events: CapturedEvent[] = [];
    for (let i = 0; i < 100; i++) events.push({ ...netEvt('n' + i), timestamp: BASE_TS + i });
    const r = buildGithubIssueUrl(events, { owner: 'a', repo: 'b' });
    expect(r).not.toBeNull();
    expect(r?.url.length).toBeLessThanOrEqual(URL_LENGTH_SAFE_MAX);
    expect(r?.truncated).toBe(true);
  });
});

describe('buildMailtoUrl', () => {
  it('produces mailto: with subject + body', () => {
    const r = buildMailtoUrl([netEvt()]);
    expect(r.url.startsWith('mailto:')).toBe(true);
    expect(r.url).toContain('subject=');
    expect(r.url).toContain('body=');
  });

  it('encodes a to: recipient', () => {
    const r = buildMailtoUrl([netEvt()], { to: 'engineer@example.com' });
    expect(r.url.startsWith('mailto:engineer%40example.com?')).toBe(true);
  });

  it('respects an explicit subject', () => {
    const r = buildMailtoUrl([netEvt()], { subject: 'Discharge bug' });
    expect(r.url).toContain('subject=Discharge%20bug');
  });
});
