// Markdown bug-report formatter — PRD §6.4.2 "Markdown (bug report)".
//
// Produces a single human-readable markdown document covering every
// captured event family. Used by:
//   - Sidepanel "Copy bug report" (M2 path; sidepanel keeps the
//     network-only fast path for screenshots but switches to this
//     for the textual copy).
//   - Webhook payloads (Slack / Discord / Teams) — see
//     src/lib/destinations/.
//   - Web-intent prefilled bodies (GitHub issues, mailto).
//
// Composition: narrative banner (when ≥ 2 events) → summary table
// → per-event detail. Per-event sections vary by type — network
// gets request / response / cURL, console gets stack, action gets
// target descriptor, navigation gets fromUrl → toUrl.

import { narrate } from '@/lib/narrative';
import type {
  ActionClickEvent,
  ActionInputEvent,
  CapturedEvent,
  ConsoleErrorEvent,
  ConsoleInfoEvent,
  ConsoleUnhandledEvent,
  ConsoleWarnEvent,
  NavigationEvent,
  NetworkFetchEvent,
  NetworkXhrEvent,
} from '@/types/events';

type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;
type ConsoleEvent = ConsoleErrorEvent | ConsoleWarnEvent | ConsoleInfoEvent | ConsoleUnhandledEvent;

export interface MarkdownReportOptions {
  /** Title for the top-level heading. */
  title?: string;
  /** Skip the narrative banner even when events.length ≥ 2. */
  skipNarrative?: boolean;
  /** When > 0, render only this many of the most recent events in
   *  detail (the summary table still lists all). Set by the
   *  size-aware degradation pass when the report exceeds a
   *  destination's character cap. */
  maxDetailEvents?: number;
  /** Earlier events the per-tab rolling buffer dropped before this
   *  report was built (from storage.omittedEventCount). > 0 renders an
   *  honesty note so a capped session isn't silently misrepresented as
   *  complete. Distinct from maxDetailEvents (an export-side detail
   *  limit); both can appear. */
  omittedEventCount?: number;
}

export function toMarkdownReport(
  events: CapturedEvent[],
  opts: MarkdownReportOptions = {}
): string {
  if (events.length === 0) return '';

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const title = opts.title ?? deriveTitle(sorted);
  const narrative = opts.skipNarrative || sorted.length < 2 ? '' : narrate(sorted);

  const lines: string[] = [];
  lines.push(`# ${escapeMd(title)}`);
  lines.push('');
  lines.push(`Captured: ${new Date().toISOString()}`);
  lines.push(`Events: ${sorted.length}`);
  if (opts.omittedEventCount && opts.omittedEventCount > 0) {
    lines.push('');
    lines.push(
      `> ⚠️ ${opts.omittedEventCount} earlier event(s) omitted — the per-tab rolling buffer keeps only the most recent activity (capture limit, not an export limit).`
    );
  }
  lines.push('');

  if (narrative) {
    lines.push(narrative);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Per-event detail section.
  const detailLimit =
    opts.maxDetailEvents && opts.maxDetailEvents > 0 ? opts.maxDetailEvents : sorted.length;
  const detailEvents = sorted.slice(-detailLimit);
  if (detailEvents.length < sorted.length) {
    lines.push(
      `> Showing the **${detailEvents.length} most recent** events out of ${sorted.length} captured (truncated by destination size limit).`
    );
    lines.push('');
  }

  for (const e of detailEvents) {
    lines.push(renderEvent(e));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  while (lines[lines.length - 1] === '' || lines[lines.length - 1] === '---') lines.pop();
  return lines.join('\n');
}

function renderEvent(e: CapturedEvent): string {
  if (e.type === 'network.fetch' || e.type === 'network.xhr') return renderNetwork(e);
  if (
    e.type === 'console.error' ||
    e.type === 'console.warn' ||
    e.type === 'console.info' ||
    e.type === 'console.unhandled'
  ) {
    return renderConsole(e);
  }
  if (e.type === 'navigation') return renderNavigation(e);
  if (e.type === 'action.click' || e.type === 'action.input') return renderAction(e);
  return renderGeneric(e);
}

function renderNetwork(e: NetworkRequestEvent): string {
  const status = e.data.response.status || 'ERR';
  const lines: string[] = [];
  lines.push(`## ${status} ${e.data.request.method} ${e.data.request.url}`);
  lines.push('');
  lines.push(`- **At:** ${new Date(e.timestamp).toISOString()}`);
  lines.push(`- **Duration:** ${e.data.timing.durationMs}ms`);
  lines.push(`- **Page:** ${e.url}`);
  if (e.data.error) lines.push(`- **Network error:** ${e.data.error}`);
  lines.push('');
  lines.push('### Request headers');
  lines.push('```json');
  lines.push(JSON.stringify(e.data.request.headers, null, 2));
  lines.push('```');
  if (e.data.request.body) {
    lines.push('');
    lines.push('### Request body');
    lines.push('```');
    lines.push(formatJson(e.data.request.body));
    lines.push('```');
  }
  lines.push('');
  lines.push('### Response headers');
  lines.push('```json');
  lines.push(JSON.stringify(e.data.response.headers, null, 2));
  lines.push('```');
  if (e.data.response.body) {
    lines.push('');
    lines.push('### Response body');
    lines.push('```');
    lines.push(formatJson(e.data.response.body));
    lines.push('```');
  }
  return lines.join('\n');
}

function renderConsole(e: ConsoleEvent): string {
  const lines: string[] = [];
  lines.push(`## ${e.type.toUpperCase()} · ${new Date(e.timestamp).toISOString()}`);
  lines.push('');
  lines.push(`> ${escapeMd(e.data.message)}`);
  if (e.data.source) {
    lines.push('');
    lines.push(
      `Source: \`${e.data.source.file}:${e.data.source.line}${e.data.source.column != null ? ':' + e.data.source.column : ''}\``
    );
  }
  if (e.data.stack) {
    lines.push('');
    lines.push('```');
    lines.push(e.data.stack);
    lines.push('```');
  }
  return lines.join('\n');
}

function renderNavigation(e: NavigationEvent): string {
  return [
    `## Navigation · ${new Date(e.timestamp).toISOString()}`,
    '',
    `${e.data.fromUrl ?? '(initial)'} → ${e.data.toUrl}`,
    e.data.transitionType ? `_transitionType: ${e.data.transitionType}_` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function renderAction(e: ActionClickEvent | ActionInputEvent): string {
  const lines: string[] = [];
  const verb = e.type === 'action.click' ? 'Click' : 'Input';
  const name = e.data.target.accessibleName ?? e.data.target.tag.toLowerCase();
  lines.push(`## ${verb} · ${new Date(e.timestamp).toISOString()}`);
  lines.push('');
  lines.push(`**Target:** \`<${e.data.target.tag.toLowerCase()}>\` ${escapeMd(name)}`);
  if (e.type === 'action.input') {
    lines.push(`**Value:** \`${escapeMd(e.data.value)}\``);
  }
  return lines.join('\n');
}

function renderGeneric(e: CapturedEvent): string {
  return [
    `## ${e.type} · ${new Date(e.timestamp).toISOString()}`,
    '',
    '```json',
    JSON.stringify(e.data, null, 2),
    '```',
  ].join('\n');
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

function formatJson(str: string): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function escapeMd(s: string): string {
  // Escape the markdown specials that show up in real captured data:
  //   `       — would open a code span mid-text
  //   |       — confuses table rendering
  //   *  _    — turn `/api/_internal/` paths into italics; URLs with
  //             query params containing * also misrender on some
  //             renderers (GitHub, Slack)
  //   [ ]     — link syntax; an unbalanced bracket in a path or
  //             query value otherwise eats following text
  // Other specials (`#`, `>`) are positional — only meaningful at
  // line start — so we leave them alone to avoid over-escaping
  // strings used as inline labels.
  return s.replace(/[`|*_[\]]/g, (c) => `\\${c}`);
}
