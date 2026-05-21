// Template-based narrative engine — PRD §22.1.
//
// Produces a markdown summary of a CapturedEvent[] suitable for the
// top of a bug report. No LLM, ever — PRD §22.1 makes that an explicit
// v2+ feature. The output here is deterministic, easy to test, and
// readable as a plain handoff to an engineer.
//
// Surfaces today:
//   - Popup buildBulkReport prepends the narrative.
//   - Popup downloadEventsAsJson attaches a `_narrative` field.
//   - HAR export does NOT include the narrative (per OQ-M2-F — the
//     HAR consumers we target don't tolerate non-spec fields at the
//     top level).

import {
  isActionEvent,
  isFailedNetwork,
  type ActionClickEvent,
  type ActionInputEvent,
  type CapturedEvent,
  type ConsoleErrorEvent,
  type ConsoleUnhandledEvent,
  type NavigationEvent,
  type NetworkFetchEvent,
  type NetworkXhrEvent,
} from '@/types/events';

type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;

/**
 * Renders a markdown narrative for `events`. Returns an empty string
 * for an empty input — callers should suppress the section heading
 * when no narrative is produced.
 */
export function narrate(events: CapturedEvent[]): string {
  if (events.length === 0) return '';

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  const lines: string[] = [];
  lines.push('## Session narrative');
  lines.push('');
  lines.push(overviewLine(sorted));
  lines.push('');

  const failureBlock = renderFailures(sorted);
  if (failureBlock) {
    lines.push(failureBlock);
    lines.push('');
  }

  const actionBlock = renderActions(sorted);
  if (actionBlock) {
    lines.push(actionBlock);
    lines.push('');
  }

  const navBlock = renderNavigation(sorted);
  if (navBlock) {
    lines.push(navBlock);
    lines.push('');
  }

  // Trim trailing blank.
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function overviewLine(sorted: CapturedEvent[]): string {
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = last.timestamp - first.timestamp;
  const host = (() => {
    try {
      return new URL(first.url).host;
    } catch {
      return first.url;
    }
  })();

  const counts = countByCategory(sorted);
  const parts: string[] = [];
  parts.push(`**${sorted.length}** event${sorted.length === 1 ? '' : 's'}`);
  if (counts.failures > 0)
    parts.push(`${counts.failures} failure${counts.failures === 1 ? '' : 's'}`);
  if (counts.network > 0) parts.push(`${counts.network} network`);
  if (counts.actions > 0) parts.push(`${counts.actions} action${counts.actions === 1 ? '' : 's'}`);
  if (counts.navigations > 0)
    parts.push(`${counts.navigations} navigation${counts.navigations === 1 ? '' : 's'}`);

  return `${parts.join(' · ')} on **${host}** over ${formatSpan(span)} (${fmtTime(first.timestamp)} → ${fmtTime(last.timestamp)}).`;
}

interface CategoryCounts {
  failures: number;
  network: number;
  actions: number;
  navigations: number;
  console: number;
}

function countByCategory(events: CapturedEvent[]): CategoryCounts {
  const c: CategoryCounts = {
    failures: 0,
    network: 0,
    actions: 0,
    navigations: 0,
    console: 0,
  };
  for (const e of events) {
    if (isFailedNetwork(e) || e.type === 'console.error' || e.type === 'console.unhandled') {
      c.failures++;
    }
    if (e.type === 'network.fetch' || e.type === 'network.xhr') c.network++;
    if (isActionEvent(e)) c.actions++;
    if (e.type === 'navigation') c.navigations++;
    if (e.type.startsWith('console.')) c.console++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

function renderFailures(sorted: CapturedEvent[]): string | null {
  const failures = sorted.filter(
    (e): e is NetworkRequestEvent | ConsoleErrorEvent | ConsoleUnhandledEvent =>
      isFailedNetwork(e) || e.type === 'console.error' || e.type === 'console.unhandled'
  );
  if (failures.length === 0) return null;

  const rows = failures.map((e) => {
    if (e.type === 'network.fetch' || e.type === 'network.xhr') {
      const path = safePath(e.data.request.url);
      const status = e.data.response.status || 'ERR';
      return `- \`${fmtTime(e.timestamp)}\` **${status}** ${e.data.request.method} ${path} · ${e.data.timing.durationMs}ms`;
    }
    const head = e.type === 'console.unhandled' ? 'unhandled' : 'console.error';
    const msg = clamp(e.data.message, 200);
    return `- \`${fmtTime(e.timestamp)}\` **${head}** — ${msg}`;
  });
  return ['**Failures**', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

function renderActions(sorted: CapturedEvent[]): string | null {
  const actions = sorted.filter(
    (e): e is ActionClickEvent | ActionInputEvent =>
      e.type === 'action.click' || e.type === 'action.input'
  );
  if (actions.length === 0) return null;

  const rows = actions.map((e) => {
    const name = e.data.target.accessibleName ?? e.data.target.tag.toLowerCase();
    if (e.type === 'action.click') {
      return `- \`${fmtTime(e.timestamp)}\` click on <${e.data.target.tag.toLowerCase()}> *${clamp(name, 80)}*`;
    }
    return `- \`${fmtTime(e.timestamp)}\` input *${clamp(name, 80)}* = ${clamp(e.data.value, 120)}`;
  });
  return ['**Actions**', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Navigation chain
// ---------------------------------------------------------------------------

function renderNavigation(sorted: CapturedEvent[]): string | null {
  const navs = sorted.filter((e): e is NavigationEvent => e.type === 'navigation');
  if (navs.length === 0) return null;

  const rows = navs.map((e) => {
    const from = e.data.fromUrl ? safePath(e.data.fromUrl) : '(initial)';
    const to = safePath(e.data.toUrl);
    return `- \`${fmtTime(e.timestamp)}\` ${from} → ${to}`;
  });
  return ['**Navigation**', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatSpan(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
