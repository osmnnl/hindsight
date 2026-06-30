// xhr-overhead.bench.ts — PRD §13.1 row 2 perf gate for the XHR patch.
//
// Mirrors fetch-overhead.bench.ts. Runs createXhrPatch against a
// synthetic baseline XHR class and asserts the p95 per-call overhead
// stays under the same 0.5 ms budget. CI calls this via
// `npm run bench` (separate run from the fetch bench).

import { createXhrPatch } from '../src/lib/network-patch';

const ITERATIONS = 10_000;
const WARMUP = 500;
/** Hard cap from PRD §13.1 — table row "XMLHttpRequest patch overhead per call". */
const P95_BUDGET_MS = 0.5;

// ---------------------------------------------------------------------------
// Synthetic baseline XHR
// ---------------------------------------------------------------------------
//
// The class only implements the surface createXhrPatch reads:
//   - new XHR()
//   - .open(method, url)
//   - .setRequestHeader(name, value)
//   - .send(body)
//   - .addEventListener('loadend', fn)
//   - .getAllResponseHeaders()
//   - .responseType / .responseText / .response / .status / .statusText
//
// 'loadend' fires on a microtask so the patch sees the same async shape
// real XHR has. Type assertions tell TS to treat this as the real
// constructor — the bench only cares about call overhead.
//
// The response body is a realistic ~32 KB payload, not an 11-byte
// fiction: the gate measures the SYNCHRONOUS per-call overhead the patch
// adds in front of the page's own load handler, and since the fix reads
// the body detached (off the loadend turn) that overhead must stay flat
// regardless of body size. A trivial body would hide that contract.
const RESPONSE_BODY = JSON.stringify({
  items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `row-${i}`, ok: true })),
});

class SyntheticXHR {
  status = 200;
  statusText = 'OK';
  responseType: '' | 'text' | 'json' | 'arraybuffer' | 'blob' | 'document' = '';
  responseText = RESPONSE_BODY;
  response: unknown = RESPONSE_BODY;
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  open(_method: string, _url: string): void {
    /* baseline does nothing */
  }
  setRequestHeader(_name: string, _value: string): void {
    /* baseline does nothing */
  }
  send(_body?: unknown): void {
    queueMicrotask(() => {
      const fns = this.listeners.get('loadend') ?? [];
      for (const fn of fns) fn({});
    });
  }
  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\n';
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    const arr = this.listeners.get(name) ?? [];
    arr.push(fn);
    this.listeners.set(name, arr);
  }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

async function timeFn(XHR: typeof XMLHttpRequest, n: number): Promise<Float64Array> {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const xhr = new XHR();
      xhr.open('GET', 'https://bench.local/x');
      xhr.addEventListener('loadend', () => resolve());
      xhr.send();
    });
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
    `\nxhr-overhead bench — ${ITERATIONS.toLocaleString()} iterations after ${WARMUP} warmup\n`
  );

  const BaselineXHR = SyntheticXHR as unknown as typeof XMLHttpRequest;
  const PatchedXHR = createXhrPatch(BaselineXHR, () => {
    /* no-op post — measuring call overhead, not the bridge */
  });

  await timeFn(BaselineXHR, WARMUP);
  await timeFn(PatchedXHR, WARMUP);

  const baselineSamples = await timeFn(BaselineXHR, ITERATIONS);
  const patchedSamples = await timeFn(PatchedXHR, ITERATIONS);

  const b = summarize('baseline', baselineSamples);
  const p = summarize('patched ', patchedSamples);

  const deltaP50 = p.p50 - b.p50;
  const deltaP95 = p.p95 - b.p95;
  const deltaP99 = p.p99 - b.p99;
  console.log(`delta      p50=${fmt(deltaP50)}  p95=${fmt(deltaP95)}  p99=${fmt(deltaP99)}`);
  console.log(`budget     p95<${P95_BUDGET_MS}ms (PRD §13.1 row 2)\n`);

  if (deltaP95 > P95_BUDGET_MS) {
    console.error(
      `FAIL — XHR patch p95 overhead ${deltaP95.toFixed(4)}ms exceeds PRD §13.1 budget of ${P95_BUDGET_MS}ms.`
    );
    process.exit(1);
  }
  console.log(`PASS — XHR patch p95 overhead within budget.`);
}

void main();
