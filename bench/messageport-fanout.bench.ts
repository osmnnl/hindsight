// messageport-fanout.bench.ts — the real-Chromium gate for root cause #1
// (perf-plan.md §3.1). The tsx benches in this dir run post() as a no-op,
// so they CANNOT see the dominant cost: window.postMessage('*') waking the
// page's own 'message' listeners once per capture. This one loads the
// BUILT extension in a real headless Chromium, registers a page-side
// 'message' listener, fires N captures, and counts how many times that
// listener is woken by capture traffic.
//
//   port active (fix working)  → ~0 wakeups, captures still reach the SW
//   broadcast (fix reverted /  → ~N wakeups
//   transfer unsupported)
//
// NOT part of `npm run bench` (needs a browser download + is slow). Run
// on demand / pre-release:  npm run bench:fanout
//
// Requires the full chromium channel (extensions don't load in the
// headless-shell): npx playwright install chromium

import http from 'node:http';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';

const EXT = path.resolve('dist');
const N = 40; // captures to fire after the handshake settles
/** Allow a tiny slack for a stray pre-connect handshake offer; the old
 *  broadcast behavior produces ~N, so this cleanly separates the two. */
const FANOUT_BUDGET = 3;

function startSite(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><html><body><h1>fanout bench</h1><script>
        // The page's OWN message listener — exactly what window.postMessage('*')
        // wakes per capture. The fix routes captures over a private port so this
        // never fires for capture traffic.
        window.__pageMsgCount = 0;
        window.addEventListener('message', () => { window.__pageMsgCount++; });
      </script></body></html>`
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

async function countSwFetchEvents(context: BrowserContext): Promise<number> {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 8000 });
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    let n = 0;
    for (const [key, value] of Object.entries(all)) {
      if (!/^sessions\/\d+\/events$/.test(key)) continue;
      for (const e of value as Array<{ type?: string }>) {
        if (e?.type === 'network.fetch') n++;
      }
    }
    return n;
  });
}

async function main(): Promise<void> {
  console.log(`\nmessageport-fanout bench — ${N} captures, real Chromium\n`);

  const site = await startSite();
  let context: BrowserContext | undefined;
  try {
    try {
      context = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
      });
    } catch (e) {
      console.log(`SKIP — full chromium channel unavailable (${(e as Error).message}).`);
      console.log('Run `npx playwright install chromium` on a machine that can launch it.');
      return;
    }

    // Wait for the extension service worker to come up.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 8000 });

    const page = await context.newPage();
    await page.goto(site.url, { waitUntil: 'load' });

    // Let the MAIN↔ISOLATED port handshake complete, then zero the counter
    // so the one-shot handshake offer doesn't count against the capture run.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      (window as unknown as { __pageMsgCount: number }).__pageMsgCount = 0;
    });

    // Fire N captures from the page.
    await page.evaluate(async (n: number) => {
      const calls: Promise<unknown>[] = [];
      for (let i = 0; i < n; i++) calls.push(fetch(`/api?i=${i}`).catch(() => undefined));
      await Promise.all(calls);
    }, N);

    // Let the bridge batch (250ms) + SW flush (250ms) settle.
    await page.waitForTimeout(1200);

    const fanout = await page.evaluate(
      () => (window as unknown as { __pageMsgCount: number }).__pageMsgCount
    );
    const swFetches = await countSwFetchEvents(context);

    console.log(
      `page 'message' wakeups from ${N} captures : ${fanout}   (budget ≤ ${FANOUT_BUDGET})`
    );
    console.log(`network.fetch events that reached the SW   : ${swFetches}   (expected ≥ ${N})`);

    const capturesFlow = swFetches >= N;
    const fanoutEliminated = fanout <= FANOUT_BUDGET;

    if (!capturesFlow) {
      console.error(`\nFAIL — captures did not reach the SW (pipeline broken).`);
      process.exitCode = 1;
      return;
    }
    if (!fanoutEliminated) {
      console.error(
        `\nFAIL — page listeners were woken ${fanout}× by capture traffic. The private` +
          ` port is not active (reverted, or cross-world transfer unsupported here).`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`\nPASS — captures flow over the private port; page listeners are not woken.`);
  } finally {
    await context?.close();
    site.close();
  }
}

void main();
