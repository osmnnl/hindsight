// Web-intent destinations — PRD §6.4.1 "Mechanism 1 (Web Intent)".
//
// Zero-setup destinations: the user clicks a button, a new browser
// tab opens at the destination's "new issue" / "new email" form
// with our markdown pre-filled. No webhook URL, no API key, no
// vendor lock-in. The user reviews, edits if needed, and submits
// in the destination's own UI.

import { toMarkdownReport } from '@/lib/formatters/markdown';
import type { CapturedEvent } from '@/types/events';

/** Hard cap on URL length the browser will accept. Most modern
 *  browsers tolerate ≈ 2 MB but the user's destination (mail
 *  client, GitHub) caps at ~8 KB practically. Stay conservative. */
export const URL_LENGTH_SAFE_MAX = 7500;

export interface BuildIntentResult {
  url: string;
  truncated: boolean;
}

/**
 * GitHub new-issue URL with title + body query params. Returns
 * `null` when owner/repo aren't provided — the side panel can show
 * a helpful message pointing the user at Settings → Sharing.
 */
export function buildGithubIssueUrl(
  events: CapturedEvent[],
  opts: { owner: string; repo: string; title?: string }
): BuildIntentResult | null {
  if (!opts.owner || !opts.repo) return null;
  const title = opts.title ?? deriveTitle(events);
  return buildIntent(
    events,
    title,
    `https://github.com/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/issues/new`,
    'title',
    'body'
  );
}

/**
 * mailto: URL with subject + body. The browser hands this off to
 * the default mail client.
 */
export function buildMailtoUrl(
  events: CapturedEvent[],
  opts: { to?: string; subject?: string } = {}
): BuildIntentResult {
  const subject = opts.subject ?? `Bug report — ${deriveTitle(events)}`;
  // mailto base: trailing question mark before query params.
  const base = opts.to ? `mailto:${encodeURIComponent(opts.to)}` : 'mailto:';
  return buildIntent(events, subject, base, 'subject', 'body');
}

/** Shared builder. Returns the URL plus a `truncated` flag the
 *  side panel surfaces to the user so they don't paste an
 *  incomplete report. */
function buildIntent(
  events: CapturedEvent[],
  title: string,
  baseUrl: string,
  titleParam: string,
  bodyParam: string
): BuildIntentResult {
  // First pass: full body. Step down maxDetailEvents until the
  // encoded URL fits the safe cap.
  let truncated = false;
  let body = toMarkdownReport(events, { title });
  let url = composeUrl(baseUrl, titleParam, title, bodyParam, body);
  if (url.length > URL_LENGTH_SAFE_MAX) {
    let detail = Math.max(1, Math.floor(events.length / 2));
    let bestFit: string | null = null;
    while (detail >= 1) {
      body = toMarkdownReport(events, { title, maxDetailEvents: detail });
      url = composeUrl(baseUrl, titleParam, title, bodyParam, body);
      if (url.length <= URL_LENGTH_SAFE_MAX) {
        bestFit = url;
        break;
      }
      if (detail === 1) break;
      detail = Math.max(1, Math.floor(detail / 2));
    }
    truncated = true;
    // Even the leanest body (one event, no narrative) overflows — fall
    // back to a stub that explains the situation so the URL still fits
    // the browser's hard cap. The recipient can ask for the ZIP / HAR
    // export instead.
    if (!bestFit) {
      const stub = `# ${title}\n\n_Bug report exceeded the URL length limit (${url.length.toLocaleString()} chars). Ask the reporter for the .zip or .har export instead — they contain the full session._`;
      url = composeUrl(baseUrl, titleParam, title, bodyParam, stub);
    }
  }
  return { url, truncated };
}

function composeUrl(
  base: string,
  titleParam: string,
  title: string,
  bodyParam: string,
  body: string
): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${titleParam}=${encodeURIComponent(title)}&${bodyParam}=${encodeURIComponent(
    body
  )}`;
}

function deriveTitle(events: CapturedEvent[]): string {
  for (const e of events) {
    try {
      return new URL(e.url).host;
    } catch {
      /* fall through */
    }
  }
  return 'Hindsight session';
}
