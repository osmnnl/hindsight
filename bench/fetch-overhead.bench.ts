// fetch-overhead.bench.ts — PRD §13.1 / §13.3 perf benchmark gate.
//
// Runs the createFetchPatch wrapper against a synthetic baseline and
// asserts the p95 per-call overhead stays under the PRD budget. CI
// invokes this via `npm run bench`; a budget breach exits non-zero
// and fails the build.
//
// Scope: fetch only. XHR has the same budget per PRD §13.1 but a
// class-wrap microbenchmark deserves its own harness — landing in M2.

import { createFetchPatch } from '../src/lib/network-patch';

const ITERATIONS = 10_000;
const WARMUP = 500;
/** Hard cap from PRD §13.1 — table row "fetch() patch overhead per call". */
const P95_BUDGET_MS = 0.5;

/** Synthetic baseline fetch that resolves immediately with a small JSON
 *  body. Purpose is to measure *only* what createFetchPatch adds. */
function makeBaseline(): typeof fetch {
  return (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response('{"ok":true}', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function timeFn(fn: typeof fetch, n: number): Promise<Float64Array> {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn('https://bench.local/x', { method: 'GET' });
    samples[i] = performance.now() - t0;
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

function summarize(
  label: string,
  samples: Float64Array
): { p50: number; p95: number; p99: number } {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const avg = mean(samples);
  console.log(
    `${label.padEnd(10)} mean=${fmt(avg)}  p50=${fmt(p50)}  p95=${fmt(p95)}  p99=${fmt(p99)}`
  );
  return { p50, p95, p99 };
}

function fmt(ms: number): string {
  return `${ms.toFixed(4)}ms`.padStart(11);
}

async function main(): Promise<void> {
  console.log(
    `\nfetch-overhead bench — ${ITERATIONS.toLocaleString()} iterations after ${WARMUP} warmup\n`
  );

  const baseline = makeBaseline();
  const patched = createFetchPatch(baseline, () => {
    /* no-op post — we're benchmarking call overhead, not the bridge */
  });

  // Warmup — let the JIT settle and dispatch tables stabilize.
  await timeFn(baseline, WARMUP);
  await timeFn(patched, WARMUP);

  // Measure.
  const baselineSamples = await timeFn(baseline, ITERATIONS);
  const patchedSamples = await timeFn(patched, ITERATIONS);

  const b = summarize('baseline', baselineSamples);
  const p = summarize('patched ', patchedSamples);

  const deltaP50 = p.p50 - b.p50;
  const deltaP95 = p.p95 - b.p95;
  const deltaP99 = p.p99 - b.p99;
  console.log(`delta      p50=${fmt(deltaP50)}  p95=${fmt(deltaP95)}  p99=${fmt(deltaP99)}`);
  console.log(`budget     p95<${P95_BUDGET_MS}ms (PRD §13.1)\n`);

  if (deltaP95 > P95_BUDGET_MS) {
    console.error(
      `FAIL — fetch patch p95 overhead ${deltaP95.toFixed(4)}ms exceeds PRD §13.1 budget of ${P95_BUDGET_MS}ms.`
    );
    process.exit(1);
  }
  console.log(`PASS — fetch patch p95 overhead within budget.`);
}

void main();
