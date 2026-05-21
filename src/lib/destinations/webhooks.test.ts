import { describe, expect, it } from 'vitest';

import { formatWebhookPayload, WEBHOOK_SOFT_CAP } from './webhooks';

describe('formatWebhookPayload', () => {
  it('Slack uses { text, mrkdwn: true }', () => {
    const p = formatWebhookPayload('slack', '## hello');
    expect(p).toEqual({ text: '## hello', mrkdwn: true });
  });

  it('Discord uses { content }', () => {
    const p = formatWebhookPayload('discord', '## hello');
    expect(p).toEqual({ content: '## hello' });
  });

  it('Teams uses MessageCard envelope', () => {
    const p = formatWebhookPayload('teams', '## hello');
    expect(p).toMatchObject({
      '@type': 'MessageCard',
      summary: 'Hindsight bug report',
      text: '## hello',
    });
  });
});

describe('WEBHOOK_SOFT_CAP', () => {
  it('keeps Discord under its 2000-char hard limit', () => {
    expect(WEBHOOK_SOFT_CAP.discord).toBeLessThanOrEqual(2000);
  });

  it('keeps Slack at the 3000-char practical paste limit', () => {
    expect(WEBHOOK_SOFT_CAP.slack).toBe(3000);
  });

  it('lets Teams take the largest body (less aggressive limit)', () => {
    expect(WEBHOOK_SOFT_CAP.teams).toBeGreaterThan(WEBHOOK_SOFT_CAP.slack);
  });
});
