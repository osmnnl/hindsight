// masking-cost.bench.ts — PRD §13.1 perf budget for capture-time masking.
//
// Every captured network event funnels through maskHeaders +
// maskBody (PRD §11.2 capture-time redaction). The cost is paid
// synchronously inside the page-world interceptor before the
// CapturedEvent is sent to the SW, so it directly adds to the
// fetch / XHR overhead budgets (§13.1 row 1 + row 2).
//
// Budget here is the slice attributable to *masking only*. The
// fetch wrapper bench already proves the wrapper itself fits inside
// 0.5 ms p95; this bench guards the masking sub-budget so a future
// rule addition can't silently eat the headroom.
//
//   p95 budget — header walk:  < 0.05 ms (realistic header set)
//   p95 budget — body scan:    < 0.20 ms (4 KB realistic JSON)
//
// Synthetic load tries to look like a real authenticated SaaS
// request: cookie + auth bearer + a JSON body containing one PII
// hit (so the regex actually fires the replacement path).

import {
  DEFAULT_BODY_RULES,
  DEFAULT_HEADER_RULES,
  maskBody,
  maskHeaders,
} from '../src/lib/masking';

const ITERATIONS = 10_000;
const WARMUP = 500;
const HEADER_P95_BUDGET_MS = 0.05;
const BODY_P95_BUDGET_MS = 0.2;

const SAMPLE_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
  'cache-control': 'no-cache',
  'content-type': 'application/json',
  cookie: 'session=abc123def456; csrftoken=xyz; locale=en-US',
  origin: 'https://app.example.com',
  pragma: 'no-cache',
  referer: 'https://app.example.com/dashboard',
  'sec-ch-ua': '"Chromium";v="130"',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'x-csrf-token': 'csrf-token-xyz-789',
  'x-request-id': 'req-2026-05-25-001',
};

// 4 KB-ish realistic API request body with one CC-shaped hit
// (Luhn-valid 16-digit number) and one TCKN-shaped hit. Both
// fire the replace path so the bench measures the hot branch,
// not the fast-skip branch.
const SAMPLE_BODY = JSON.stringify({
  customer: {
    id: 'cus_2GqkX9pDfH3yQ',
    name: 'Test User',
    email: 'test@example.com',
    phone: '+1-555-0123',
    address: {
      street: '123 Main Street, Apt 4B',
      city: 'San Francisco',
      state: 'CA',
      zip: '94105',
      country: 'US',
    },
  },
  payment: {
    method: 'card',
    card_number: '4532015112830366',
    expiry: '12/28',
    cvc: '***',
    tckn: '10000000146',
  },
  cart: Array.from({ length: 8 }, (_, i) => ({
    sku: `sku-${1000 + i}`,
    name: `Product ${i + 1}`,
    qty: (i % 3) + 1,
    price: 19.99 + i * 5,
  })),
  meta: {
    source: 'web',
    referrer: 'https://google.com/search?q=widgets',
    session: 'sess_8h2k1JdH3yQ',
    timestamp: '2026-05-25T10:23:45.123Z',
  },
});

function timeHeaders(n: number): Float64Array {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    maskHeaders(SAMPLE_HEADERS, 'request.headers', DEFAULT_HEADER_RULES);
    samples[i] = performance.now() - t0;
  }
  return samples;
}

function timeBody(n: number): Float64Array {
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    maskBody(SAMPLE_BODY, 'request.body', DEFAULT_BODY_RULES);
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
    `${label.padEnd(10)} mean=${fmt(avg)}  p50=${fmt(p50)}  p95=${fmt(p95)}  p99=${fmt(p99)}`
  );
  return { p50, p95, p99 };
}

function main(): void {
  console.log(
    `\nmasking-cost bench — ${ITERATIONS.toLocaleString()} iterations after ${WARMUP} warmup\n`
  );

  // Warmup: prime the JIT and let the regex engine cache.
  timeHeaders(WARMUP);
  timeBody(WARMUP);

  const headerSamples = timeHeaders(ITERATIONS);
  const bodySamples = timeBody(ITERATIONS);

  const h = summarize('headers ', headerSamples);
  const b = summarize('body    ', bodySamples);
  console.log(
    `budget     headers p95<${HEADER_P95_BUDGET_MS}ms · body p95<${BODY_P95_BUDGET_MS}ms (PRD §11.2 + §13.1)\n`
  );

  let failed = false;
  if (h.p95 > HEADER_P95_BUDGET_MS) {
    console.error(
      `FAIL — maskHeaders p95 ${h.p95.toFixed(4)}ms exceeds budget of ${HEADER_P95_BUDGET_MS}ms.`
    );
    failed = true;
  }
  if (b.p95 > BODY_P95_BUDGET_MS) {
    console.error(
      `FAIL — maskBody p95 ${b.p95.toFixed(4)}ms exceeds budget of ${BODY_P95_BUDGET_MS}ms.`
    );
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`PASS — masking p95 overhead within budget.`);
}

main();
