// Webhook destinations — PRD §6.4.1 "Mechanism 2 (Webhook)".
//
// Slack incoming webhooks, Discord webhooks, and Microsoft Teams
// connector webhooks all share the same shape from our side: HTTPS
// POST a JSON body with a text/markdown payload. Each service's
// rendering quirks (Slack mrkdwn vs Discord markdown vs Teams card)
// stay encapsulated here.
//
// Privacy: the SETTINGS layer (chrome.storage.sync) stores the URL
// and is the only thing that knows the destination identity. This
// module sees only the URL the caller hands in.

import type { CapturedEvent } from '@/types/events';
import { toMarkdownReport, type MarkdownReportOptions } from '@/lib/formatters/markdown';

export type WebhookDestination = 'slack' | 'discord' | 'teams';

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Soft text caps per destination — PRD §6.4.3. When the markdown
 *  body would blow past these, the caller can re-render via
 *  toMarkdownReport({ maxDetailEvents }) until it fits. Numbers are
 *  conservative versus the documented hard limits so we leave room
 *  for markdown overhead and avoid surprise 413 responses. */
export const WEBHOOK_SOFT_CAP: Record<WebhookDestination, number> = {
  slack: 3000,
  discord: 1900,
  teams: 25_000,
};

/**
 * Builds the JSON payload for the named destination. Each service has
 * its own field for the text body; the rest is consistent enough
 * across the three to share an envelope.
 */
export function formatWebhookPayload(
  destination: WebhookDestination,
  markdown: string
): Record<string, unknown> {
  if (destination === 'slack') {
    // Slack incoming webhook payload schema. "mrkdwn" enables the
    // markdown subset Slack understands; full GitHub-flavored
    // markdown does NOT render — bold + italic + code + link is the
    // safe subset.
    return { text: markdown, mrkdwn: true };
  }
  if (destination === 'discord') {
    // Discord caps the `content` field at ~2000 chars. Caller is
    // expected to pre-truncate via maxDetailEvents.
    return { content: markdown };
  }
  // Teams MessageCard. Simple text field — adaptive cards are a
  // future polish.
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: 'Hindsight bug report',
    text: markdown,
  };
}

/** Hard timeout for a single webhook POST. A misconfigured URL
 *  (typo, localhost:9999, internal-only host) would otherwise leave
 *  the sidepanel UI in "… sending" forever. PRD §13.1 doesn't gate
 *  user-initiated network calls, but the UX commitment is that no
 *  share button hangs indefinitely. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Posts the formatted payload to the destination webhook. Returns
 * a result object instead of throwing so callers can render a
 * meaningful "send failed" UI without try/catch noise.
 */
export async function sendWebhook(
  url: string,
  payload: Record<string, unknown>
): Promise<WebhookSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      return { ok: false, error: `timeout after ${WEBHOOK_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full send path used by the side panel: builds a size-aware markdown
 * body for `destination`, formats the payload, posts it, returns the
 * result. Truncation happens here so the side panel doesn't need to
 * know per-destination limits.
 */
export async function dispatchToWebhook(
  destination: WebhookDestination,
  url: string,
  events: CapturedEvent[]
): Promise<WebhookSendResult & { chars: number; truncated: boolean }> {
  const cap = WEBHOOK_SOFT_CAP[destination];
  // First pass: render in full.
  let markdown = toMarkdownReport(events, {});
  let truncated = false;
  if (markdown.length > cap) {
    // Binary-style step-down: halve the detail set until it fits
    // or we're down to a single event. Keeps the truncation
    // deterministic across runs.
    let detail = Math.max(1, Math.floor(events.length / 2));
    while (detail >= 1) {
      const opts: MarkdownReportOptions = { maxDetailEvents: detail };
      markdown = toMarkdownReport(events, opts);
      if (markdown.length <= cap) break;
      if (detail === 1) break; // can't go lower
      detail = Math.max(1, Math.floor(detail / 2));
    }
    truncated = true;
  }

  const payload = formatWebhookPayload(destination, markdown);
  const result = await sendWebhook(url, payload);
  return { ...result, chars: markdown.length, truncated };
}
