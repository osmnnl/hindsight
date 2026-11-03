// Standalone HTML replay bundle generator — PRD §5.
//
// The killer-differentiator feature: a single self-contained HTML
// file that bundles a captured session AND an interactive viewer.
// Open it in any browser, scrub through the timeline, read every
// request body, see the redactions panel — no extension, no
// service, no login. The recipient drags the file into a tab
// and they're done.
//
// Implementation contract:
//   - generateBundle(events, opts) → HTML string.
//   - Output is a complete document: <!doctype html> ... </html>.
//   - All assets (events, viewer JS, CSS) are inlined; the file
//     opens offline without any network requests.
//   - The viewer is vanilla DOM (OQ-M4-D). No framework, no CDN.
//   - Size budget per PRD §5.4: 10 MB typical, 50 MB recording.
//
// The viewer's CSS and JS live in replay-bundle-viewer.ts.
//
// Tests: replay-bundle.test.ts, replay-bundle.xss.test.ts.

import { resolveClusters } from '@/lib/detection';
import { narrate } from '@/lib/narrative';
import { VIEWER_CSS, VIEWER_JS } from '@/lib/replay-bundle-viewer';
import type { CapturedEvent } from '@/types/events';

export interface GenerateBundleOptions {
  /** The Hindsight version that produced the bundle. Stamped into
   *  the viewer footer so a recipient can reproduce the producing
   *  environment if needed. */
  appVersion: string;
  /** Optional title shown in the viewer header — falls back to the
   *  origin of the first event when not provided. */
  title?: string;
  /** Earlier events the per-tab rolling buffer dropped before this
   *  bundle was built (storage.omittedEventCount). > 0 renders an
   *  honesty banner so a capped recording isn't shipped as if complete. */
  omittedEventCount?: number;
}

/**
 * Returns the full HTML document for a replay bundle. Caller saves
 * it as a `.html` file and ships it.
 */
export function generateBundle(events: CapturedEvent[], opts: GenerateBundleOptions): string {
  const narrative = narrate(events);
  const title = opts.title ?? deriveTitle(events);
  // Cluster membership is resolved here (TS) rather than re-implemented in
  // the viewer, so both surfaces count a cascade the same way.
  const clusters = Object.fromEntries(resolveClusters(events));
  const dataJson = jsonForScriptElement({ events, narrative, clusters });
  // Per-bundle nonce: only the viewer script below may run. Captured
  // payloads can't reach a script context anyway (the data block is inert
  // JSON with `<` escaped), and the CSP also blocks inline handlers and any
  // network fetch should a future viewer change regress the escaping.
  const nonce = makeNonce();

  // The data block sits above the viewer so huge sessions stream-parse
  // before the viewer reads it.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" />
  <title>${escapeHtml(title)} — Hindsight replay</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${VIEWER_CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="dot"></span> Hindsight replay</div>
    <div class="title">${escapeHtml(title)}</div>
    <div class="meta"><span id="event-count"></span> · <span id="time-span"></span></div>
  </header>
  ${
    opts.omittedEventCount && opts.omittedEventCount > 0
      ? `<div class="omitted-banner">⚠️ ${opts.omittedEventCount} earlier event(s) omitted — the per-tab rolling buffer keeps only the most recent activity (capture limit, not an export limit).</div>`
      : ''
  }
  <main class="grid">
    <section class="scrubber-wrap" aria-label="Timeline scrubber">
      <div id="scrubber-bars" class="scrubber-bars" aria-hidden="true"></div>
      <input id="scrubber-input" type="range" min="0" max="100" step="1" value="100" aria-label="Jump to time" />
      <div class="scrubber-axis"><span id="scrubber-start"></span><span id="scrubber-end"></span></div>
    </section>
    <section class="toolbar" aria-label="Event filters">
      <div class="chips">
        <button class="chip" data-filter="failed">Failed</button>
        <button class="chip" data-filter="api" title="Hide static assets and framework internals">API</button>
        <button class="chip active" data-filter="all">All</button>
      </div>
      <input id="search-input" type="search" placeholder="Search URLs, methods, messages…" aria-label="Search events" />
      <label class="cursor-toggle"><input id="show-cursor" type="checkbox" /> cursor / scroll</label>
      <span class="hint" id="result-count"></span>
    </section>
    <details class="narrative-panel" ${narrative ? 'open' : ''}>
      <summary>Session narrative</summary>
      <pre id="narrative-text"></pre>
    </details>
    <section id="event-list" class="list" role="list"></section>
    <aside id="detail-pane" class="detail empty" aria-live="polite">
      <p class="hint">Click an event to inspect it. <kbd>←</kbd> / <kbd>→</kbd> step through.</p>
    </aside>
  </main>
  <footer class="footnote">Generated by Hindsight v${escapeHtml(opts.appVersion)} · single-file replay (PRD §5)</footer>
  <script type="application/json" id="hs-data">${dataJson}</script>
  <script nonce="${nonce}">${VIEWER_JS}</script>
</body>
</html>`;
}

/**
 * JSON that is safe as the raw text of a <script> element. `<` is the only
 * character that can end the element (`</script`) or flip the tokenizer into
 * the escaped state (`<!--`), so escaping it — plus `>` and `&` for good
 * measure, and U+2028/U+2029 so the text also stays valid JS if ever
 * evaluated — makes any captured body inert. JSON.parse reads the escapes
 * back to the original characters, so payloads round-trip byte-equal.
 */
export function jsonForScriptElement(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function deriveTitle(events: CapturedEvent[]): string {
  for (const e of events) {
    try {
      return new URL(e.url).host;
    } catch {
      // fall through
    }
  }
  return 'Hindsight session';
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c
  );
}
