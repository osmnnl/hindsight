// filter-1000.bench.ts — PRD §13.1 sidepanel render budget (row 3).
//
// PRD §13.1 sets "side-panel render with 1000 events < 200 ms" as
// the perf gate for the inspection surface. The render pipeline is
// dominated by two phases:
//
//   1. Filtering: a fan-out across `isApiRequest` / `isErrorEvent`
//      / host predicate / search predicate over the buffer.
//   2. HTML string assembly: per-event row construction + a single
//      innerHTML replacement.
//
// Phase 1 is testable in Node (pure functions, no DOM). Phase 2
// needs jsdom and is deferred — but the filter pass is the part
// that scales linearly with event count, and the most common worst
// case is a 1000-event session where the user toggles the API chip.
// If isApiRequest is slow, the whole render gets backed up.
//
// Budget here is a sub-slice of PRD §13.1 row 3: filter 1000 events
// in well under 1 ms p95 so the render budget has all 199+ ms left
// for DOM mutation.

import { isApiRequest, isErrorEvent, type CapturedEvent } from '../src/types/events';

const ITERATIONS = 1_000;
const WARMUP = 100;
/** Hard cap — well below the 200 ms PRD §13.1 row 3 budget since
 *  filtering is only one of several phases the render budget covers. */
const P95_BUDGET_MS = 2;

/** Build a realistic 1000-event session: mix of framework chunks,
 *  static assets, real API calls, errors, console, and actions. The
 *  ratios match what a typical Next.js app produces during a session
 *  (lots of framework noise, a handful of real API hits). */
function buildSession(n: number): CapturedEvent[] {
  const out: CapturedEvent[] = [];
  const hosts = ['app.example.com', 'cdn.example.com', 'analytics.example.com'];
  const paths = [
    '/_next/static/chunks/main.js',
    '/_next/static/chunks/framework.js',
    '/_next/static/media/logo.png',
    '/_next/data/index.json',
    '/api/users/me',
    '/api/orders?limit=20',
    '/static/img/hero.webp',
    '/fonts/inter.woff2',
    '/sockjs-node/info',
    '/api/checkout',
  ];
  for (let i = 0; i < n; i++) {
    const path = paths[i % paths.length]!;
    const host = hosts[i % hosts.length]!;
    const url = `https://${host}${path}`;
    const isJs = path.endsWith('.js');
    const isPng = path.endsWith('.png') || path.endsWith('.webp');
    const isFont = path.endsWith('.woff2');
    const status = i % 17 === 0 ? 500 : 200;
    const contentType = isJs
      ? 'application/javascript'
      : isPng
        ? 'image/webp'
        : isFont
          ? 'font/woff2'
          : 'application/json';
    out.push({
      id: `evt-${i}`,
      sessionId: 'sess-bench',
      tabId: 1,
      timestamp: 1_700_000_000_000 + i * 50,
      sequenceNumber: i,
      type: i % 2 === 0 ? 'network.fetch' : 'network.xhr',
      url,
      data: {
        request: {
          method: 'GET',
          url,
          headers: { accept: 'application/json' },
          body: null,
        },
        response: {
          status,
          statusText: status === 200 ? 'OK' : 'Server Error',
          headers: { 'content-type': contentType },
          body: '{"ok":true}',
        },
        timing: { startedAt: 1_700_000_000_000 + i * 50, durationMs: 12 + (i % 30) },
        error: null,
      },
    });
  }
  return out;
}

function timeFilter(
  events: CapturedEvent[],
  pred: (e: CapturedEvent) => boolean,
  n: number
): Float64Array {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    // Build an array (matches what filteredEvents() does — not just
    // a counting reduce — so we capture allocation cost too).
    const _kept = events.filter(pred);
    samples[i] = performance.now() - t0;
    if (_kept.length < 0) throw new Error('unreachable');
  }
  return samples;
}

function percentile(samples: Float64Array, p: number): number {
  const sorted = Float64Array.from(samples).sort();
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

function mean(samples: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] ?? 0;
  return sum / samples.length;
}

function fmt(ms: number): string {
  return `${ms.toFixed(4)}ms`.padStart(11);
}

function summarize(
  label: string,
  samples: Float64Array
): { p50: number; p95: number; p99: number } {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const avg = mean(samples);
  console.log(
    `${label.padEnd(12)} mean=${fmt(avg)}  p50=${fmt(p50)}  p95=${fmt(p95)}  p99=${fmt(p99)}`
  );
  return { p50, p95, p99 };
}

function main(): void {
  const events = buildSession(1000);
  console.log(
    `\nfilter-1000 bench — ${ITERATIONS.toLocaleString()} iterations of filter(1000 events) after ${WARMUP} warmup\n`
  );

  // Warmup both predicates.
  timeFilter(events, isApiRequest, WARMUP);
  timeFilter(events, isErrorEvent, WARMUP);

  const apiSamples = timeFilter(events, isApiRequest, ITERATIONS);
  const errSamples = timeFilter(events, isErrorEvent, ITERATIONS);

  const api = summarize('isApiRequest', apiSamples);
  const err = summarize('isErrorEvent', errSamples);

  console.log(`budget       p95<${P95_BUDGET_MS}ms (PRD §13.1 row 3 sub-budget)\n`);

  let failed = false;
  if (api.p95 > P95_BUDGET_MS) {
    console.error(
      `FAIL — isApiRequest filter p95 ${api.p95.toFixed(4)}ms exceeds budget of ${P95_BUDGET_MS}ms.`
    );
    failed = true;
  }
  if (err.p95 > P95_BUDGET_MS) {
    console.error(
      `FAIL — isErrorEvent filter p95 ${err.p95.toFixed(4)}ms exceeds budget of ${P95_BUDGET_MS}ms.`
    );
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`PASS — 1000-event filter pass within budget.`);
}

main();
