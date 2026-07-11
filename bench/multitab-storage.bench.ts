// multitab-storage.bench.ts — the real-Chromium gate for the 20-tab
// storage/memory crash (perf-plan.md "storage regime"). The tsx benches
// touch pure functions with a no-op post; NONE exercise chrome.storage.local
// under multi-tab load, which is exactly where the crash lives. This one
// loads the BUILT extension in real headless Chromium, opens 20 tabs that
// each stream large-body fetches, and asserts:
//
//   - the service worker STAYS ALIVE for the whole run (no OOM/crash), and
//   - chrome.storage.local stays under a bounded ceiling (buffer is capped
//     by BYTES, not just event count).
//
// Baseline (pre-fix) FAILS: storage climbs to ~135 MB and the SW/context
// dies within ~8-12 s. After the byte-cap fix it should hold ~40 MB and
// survive.
//
// NOT part of `npm run bench` (needs a browser download + is slow):
//   npm run bench:multitab

import http from 'node:http';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from 'playwright';

const EXT = path.resolve('dist');
const TABS = Number(process.env.BENCH_TABS ?? 20); // BENCH_TABS=60/100 to probe the SW ceiling
const FETCHES = 400; // per tab — sustains traffic through all samples
const DELAY_MS = 50; // ~20 req/s/tab
const BODY_BYTES = 120_000; // large response bodies → big captured events
const STORAGE_CEIL_MB = TABS * 2 + 30; // ~2MB byte-cap/tab + overhead

const BIG = JSON.stringify({ pad: 'x'.repeat(BODY_BYTES) });
const fmtMB = (b: number): string => (b / 1_048_576).toFixed(1) + ' MB';

function startSite(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(BIG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><meta charset=utf8><body><script>
        (async () => {
          for (let i = 0; i < ${FETCHES}; i++) {
            try { const r = await fetch('/api?i=' + i); await r.text(); } catch (e) {}
            await new Promise((r) => setTimeout(r, ${DELAY_MS}));
          }
        })();
      </script></body>`
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

async function storageTotalMB(sw: Worker): Promise<number> {
  const bytes = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    let total = 0;
    for (const v of Object.values(all)) total += JSON.stringify(v).length;
    return total;
  });
  return bytes / 1_048_576;
}

async function main(): Promise<void> {
  console.log(
    `\nmultitab-storage bench — ${TABS} tabs × ${FETCHES} fetches × ${BODY_BYTES / 1000}KB body\n`
  );
  const site = await startSite();
  let context: BrowserContext | undefined;
  let swSurvived = true;
  let maxStorage = 0;
  try {
    try {
      context = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      });
    } catch (e) {
      console.log(`SKIP — full chromium channel unavailable (${(e as Error).message}).`);
      return;
    }

    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent('serviceworker', { timeout: 8000 });
    }

    const pages = [];
    for (let i = 0; i < TABS; i++) {
      const p = await context.newPage();
      await p.goto(site.url, { waitUntil: 'commit' }).catch(() => {});
      pages.push(p);
    }

    let last = 0;
    for (const t of [5000, 12000, 20000, 28000]) {
      await new Promise((r) => setTimeout(r, t - last));
      last = t;
      const w = context.serviceWorkers()[0];
      if (!w) {
        console.log(`t≈${t / 1000}s: ⚠️ NO service worker (crashed/evicted).`);
        swSurvived = false;
        continue;
      }
      try {
        const mb = await storageTotalMB(w);
        maxStorage = Math.max(maxStorage, mb);
        console.log(`t≈${t / 1000}s: storage.local=${fmtMB(mb * 1_048_576)}  SW=alive`);
      } catch (e) {
        console.log(
          `t≈${t / 1000}s: ⚠️ SW eval failed (${String((e as Error).message).slice(0, 50)}) → crash under load.`
        );
        swSurvived = false;
      }
    }

    console.log(
      `\npeak storage.local: ${fmtMB(maxStorage * 1_048_576)}   ceiling: ${STORAGE_CEIL_MB} MB`
    );
    const bounded = maxStorage < STORAGE_CEIL_MB;
    if (!swSurvived) {
      console.error(`\nFAIL — service worker crashed under sustained multi-tab load.`);
      process.exitCode = 1;
      return;
    }
    if (!bounded) {
      console.error(
        `\nFAIL — storage.local grew to ${fmtMB(maxStorage * 1_048_576)} (> ${STORAGE_CEIL_MB} MB ceiling): buffer not byte-bounded.`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\nPASS — SW survived and storage stayed bounded under multi-tab load.`);
  } catch (e) {
    console.error('BENCH ERROR:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    await context?.close();
    site.close();
  }
}

void main();
