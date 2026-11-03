// a11y.ts — WCAG AA + render-budget gate for the extension UI (1.0 C3/C4/C6).
//
// Loads the BUILT extension (dist/) in real Chromium, feeds the popup and
// side panel a deterministic event fixture (chrome.runtime GET_EVENTS is
// stubbed in the page, nothing reaches the network), then checks — in light
// AND dark — on the popup, side panel list, side panel detail and settings:
//
//   contrast   every visible text node ≥ 4.5:1 (3:1 for large text) against
//              its effective, alpha-blended background (WCAG 1.4.3)
//   names      every visible control has an accessible name, and an
//              aria-label contains the visible label (4.1.2, 2.5.3)
//   focus      every Tab stop paints a visible focus indicator (2.4.7)
//
// plus the side panel keyboard flow (2.1.1): the event list is one Tab stop,
// ↓×3 + Enter opens the 4th event, Esc returns focus to that row, `/` focuses
// search, `f` switches to Failed — and the 1000-event render budget
// (PRD §13.1: < 200 ms).
//
// No axe-core (not a dependency); uses only the playwright devDependency.
//   npm run build && npm run test:a11y
// Requires the full chromium channel: npx playwright install chromium

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';

const EXT = path.resolve('dist');
const RENDER_BUDGET_MS = 200;
const FAKE_TAB = { id: 4242, windowId: 1, url: 'https://shop.example.test/checkout', active: true };

type Fixture = Record<string, unknown>[];

/** n events of mixed kinds, oldest first, with one 401 cascade. */
function fixture(n: number): Fixture {
  const t0 = Date.parse('2026-11-03T10:00:00Z');
  const out: Fixture = [];
  const base = (i: number, type: string) => ({
    id: `evt-${i}`,
    type,
    timestamp: t0 + i * 250,
    sessionId: 'session-a11y',
    sequenceNumber: i,
    tabId: FAKE_TAB.id,
    url: FAKE_TAB.url,
  });
  const net = (i: number, method: string, url: string, status: number, extra = {}) => ({
    ...base(i, 'network.fetch'),
    data: {
      request: { method, url, headers: { accept: 'application/json' }, body: null },
      response: {
        status,
        statusText: status >= 400 ? 'Error' : 'OK',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: status < 400, items: [1, 2, 3] }),
      },
      timing: { startedAt: t0 + i * 250, durationMs: 40 + (i % 7) * 30 },
      error: null,
    },
    ...extra,
  });
  for (let i = 0; i < n; i++) {
    const k = i % 10;
    if (k === 0) out.push(net(i, 'POST', 'https://shop.example.test/api/checkout', 500));
    else if (k === 1)
      out.push({
        ...base(i, 'console.error'),
        data: { level: 'error', message: `Checkout failed (${i})` },
      });
    else if (k === 2)
      out.push({
        ...base(i, 'action.click'),
        data: {
          target: { tag: 'button', accessibleName: 'Buy now', selector: '#buy' },
          button: 0,
          modifiers: { alt: false, ctrl: false, meta: false, shift: false },
        },
      });
    else out.push(net(i, 'GET', `https://shop.example.test/api/items/${i}`, 200));
  }
  // A 401 cascade near the newest end so it is on screen.
  const head = n - 3;
  out[head] = net(head, 'GET', 'https://shop.example.test/api/auth', 401, {
    meta: { flags: ['failed', 'cascade-head'] },
  });
  for (const m of [n - 2, n - 1])
    out[m] = net(m, 'GET', 'https://shop.example.test/api/auth', 401, {
      meta: { cascadeOf: `evt-${head}`, flags: ['failed', 'cascade-member'] },
    });
  return out;
}

/** In-page stub: the active tab is FAKE_TAB and GET_EVENTS returns the fixture.
 *  Records how long the first non-empty list render takes. */
function stub([events, tab]: [Fixture, typeof FAKE_TAB]): void {
  if (location.protocol !== 'chrome-extension:') return;
  const w = window as unknown as { __renderMs?: number; __layoutMs?: number };
  const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (msg: {
    kind?: string;
  }) => {
    if (msg?.kind === 'GET_EVENTS') {
      if (w.__renderMs === undefined && location.pathname.includes('sidepanel')) {
        const t0 = performance.now();
        const list = document.getElementById('list');
        if (list) {
          const mo = new MutationObserver(() => {
            mo.disconnect();
            w.__renderMs = performance.now() - t0;
            void list.offsetHeight; // force style + layout
            w.__layoutMs = performance.now() - t0;
          });
          mo.observe(list, { childList: true });
        }
      }
      return structuredClone(events);
    }
    if (msg?.kind === 'CLEAR_EVENTS') return undefined;
    try {
      return await send(msg);
    } catch {
      return undefined;
    }
  };
  chrome.tabs.query = (async () => [tab]) as unknown as typeof chrome.tabs.query;
}

/** Runs in the page: returns human-readable WCAG violations. */
function audit(): string[] {
  const problems: string[] = [];
  const parse = (c: string): [number, number, number, number] => {
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    return [m[0]!, m[1]!, m[2]!, m[3] ?? 1];
  };
  const blend = (top: number[], bottom: number[]): number[] => {
    const a = top[3]!;
    return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1);
  };
  const lum = (c: number[]): number => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: number[], b: number[]): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const effectiveBg = (el: Element): number[] => {
    const layers: number[][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (const l of layers.reverse()) bg = blend(l, bg);
    return bg;
  };
  const visible = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], .sr-only, .hidden')) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1;
  };
  const label = (el: Element): string =>
    `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
      el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).join('.')
        : ''
    } "${(el.textContent ?? '').trim().slice(0, 30)}"`;

  // Contrast — every element that directly owns visible text.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent?.trim()) continue;
    seen.add(el);
    if (!visible(el) || el.closest('svg, option, mark, [disabled], .json-tree')) continue;
    const s = getComputedStyle(el);
    // Opacity on an ancestor fades the text too.
    let alpha = 1;
    for (let n: Element | null = el; n; n = n.parentElement)
      alpha *= Number(getComputedStyle(n).opacity);
    const bg = effectiveBg(el);
    const fg = blend([...parse(s.color).slice(0, 3), parse(s.color)[3] * alpha], bg);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const r = ratio(fg, bg);
    if (r < (large ? 3 : 4.5)) problems.push(`contrast ${r.toFixed(2)} ${label(el)}`);
  }

  // Accessible names.
  const controls = document.querySelectorAll<HTMLElement>(
    'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=option], [role=switch], [tabindex="0"]'
  );
  for (const el of controls) {
    if (!visible(el) && !(el instanceof HTMLInputElement && el.type === 'range')) continue;
    const text = (el.innerText ?? '').replace(/\s+/g, ' ').trim();
    const aria = el.getAttribute('aria-label')?.trim() ?? '';
    const by = el
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    const forLabel =
      el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim();
    const wrap = el.closest('label')?.textContent?.trim();
    const isField = el.matches('input, select, textarea');
    const name =
      by || aria || forLabel || wrap || (isField ? '' : text) || el.getAttribute('title') || '';
    if (!name.trim()) problems.push(`no accessible name ${label(el)}`);
    // 2.5.3 applies to text labels; a lone glyph (↑, ×) has no words to speak.
    const words = /[\p{L}\p{N}]/u.test(text);
    if (aria && words && !isField && !aria.toLowerCase().includes(text.toLowerCase()))
      problems.push(`aria-label "${aria}" hides visible label "${text}" (2.5.3)`);
  }
  return problems;
}

/** Tabs through the page; every stop must paint an outline or box-shadow. */
async function auditFocus(page: Page, maxStops = 60): Promise<string[]> {
  const problems: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const start = await page.evaluate(() => document.body.focus());
  void start;
  const seen = new Set<string>();
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring =
        (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1) || s.boxShadow !== 'none';
      const key = `${el.tagName}#${el.id}.${el.className}|${(el.textContent ?? '').trim().slice(0, 20)}`;
      return { key, ring };
    });
    if (!info || seen.has(info.key)) break;
    seen.add(info.key);
    if (!info.ring) problems.push(`no visible focus: ${info.key}`);
  }
  return problems;
}

async function openPage(
  ctx: BrowserContext,
  id: string,
  file: string,
  size: { width: number; height: number }
): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize(size);
  // Measure settled colours, not mid-transition frames.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${id}/src/${file}`);
  await page.waitForTimeout(900);
  return page;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('dist/ missing — run npm run build first');
    process.exit(2);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hindsight-a11y-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const failures: string[] = [];
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const id = sw.url().split('/')[2]!;

    // tsx (esbuild keepNames) wraps named functions in __name(); give the
    // page a no-op so functions passed to evaluate() run there unchanged.
    await ctx.addInitScript({ content: 'globalThis.__name = (f) => f;' });

    // --- 1000-event render budget (PRD §13.1) -----------------------------
    await ctx.addInitScript(stub, [fixture(1000), FAKE_TAB] as [Fixture, typeof FAKE_TAB]);
    const big = await ctx.newPage();
    await big.setViewportSize({ width: 420, height: 800 });
    // `all` filter so all 1000 rows render.
    await big.goto(`chrome-extension://${id}/src/settings/settings.html`);
    await big.evaluate(() =>
      chrome.storage.local.set({ 'sidepanel/ui-state': { filterMode: 'all' } })
    );
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      await big.goto(`chrome-extension://${id}/src/sidepanel/sidepanel.html`);
      await big.waitForFunction(() => (window as { __layoutMs?: number }).__layoutMs !== undefined);
      times.push(
        await big.evaluate(() => (window as unknown as { __layoutMs: number }).__layoutMs)
      );
    }
    const rows = await big.locator('#list [role=option]').count();
    times.sort((a, b) => a - b);
    const median = times[2]!;
    console.info(
      `render 1000 events → ${rows} rows: median ${median.toFixed(1)} ms (runs ${times.map((t) => t.toFixed(0)).join(', ')}) budget < ${RENDER_BUDGET_MS} ms`
    );
    if (median >= RENDER_BUDGET_MS) failures.push(`1000-event render ${median.toFixed(1)} ms`);
    await big.close();

    // --- per-surface WCAG audit, both themes ------------------------------
    const surfaces: Array<[string, string, { width: number; height: number }]> = [
      ['popup', 'popup/popup.html', { width: 380, height: 600 }],
      ['sidepanel', 'sidepanel/sidepanel.html', { width: 360, height: 760 }],
      ['settings', 'settings/settings.html', { width: 1000, height: 800 }],
    ];
    for (const [name, file, size] of surfaces) {
      const page = await openPage(ctx, id, file, size);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.waitForTimeout(150);
        const tag = `${name}/${scheme}`;
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        if (overflow > 0) failures.push(`${tag}: horizontal scroll ${overflow}px`);
        for (const p of await page.evaluate(audit)) failures.push(`${tag}: ${p}`);
        for (const p of await auditFocus(page)) failures.push(`${tag}: ${p}`);
        if (name === 'sidepanel') {
          await page.locator('#list [role=option][data-event-id]').first().click();
          await page.waitForSelector('#detail:not(.hidden)');
          for (const p of await page.evaluate(audit)) failures.push(`${tag}/detail: ${p}`);
          await page.keyboard.press('Escape');
        }
      }
      await page.close();
    }

    // --- keyboard flow (2.1.1) --------------------------------------------
    const sp = await openPage(ctx, id, 'sidepanel/sidepanel.html', { width: 360, height: 760 });
    const k = (msg: string) => failures.push(`keyboard: ${msg}`);
    const focused = () =>
      sp.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          role: el?.getAttribute('role') ?? '',
          id: el?.dataset.eventId ?? el?.dataset.clusterToggle ?? el?.id ?? '',
        };
      });
    const optionIds = await sp
      .locator('#list [role=option]')
      .evaluateAll((els) =>
        els.map(
          (e) =>
            (e as HTMLElement).dataset.eventId ?? (e as HTMLElement).dataset.clusterToggle ?? ''
        )
      );
    let stops = 0;
    let onList = false;
    for (; stops < 40 && !onList; stops++) {
      await sp.keyboard.press('Tab');
      onList = (await focused()).role === 'option';
    }
    if (!onList) k('Tab never reaches the event list');
    else {
      if ((await focused()).id !== optionIds[0])
        k('first Tab stop in the list is not the first row');
      await sp.keyboard.press('Tab');
      if ((await focused()).role === 'option') k('list has more than one Tab stop');
      await sp.keyboard.press('Shift+Tab');
      for (let i = 0; i < 3; i++) await sp.keyboard.press('ArrowDown');
      const fourth = (await focused()).id;
      if (fourth !== optionIds[3]) k(`↓×3 landed on ${fourth}, expected ${optionIds[3]}`);
      await sp.keyboard.press('Enter');
      const open = await sp.locator('#detail:not(.hidden)').count();
      if (fourth.startsWith('evt-') && !open) k('Enter did not open the detail view');
      await sp.keyboard.press('Escape');
      if ((await sp.locator('#detail:not(.hidden)').count()) > 0) k('Esc did not close the detail');
      if ((await focused()).id !== fourth) k('Esc did not return focus to the row');
      await sp.keyboard.press('End');
      if ((await focused()).id !== optionIds.at(-1)) k('End did not reach the last row');
      await sp.keyboard.press('Home');
      if ((await focused()).id !== optionIds[0]) k('Home did not reach the first row');
      await sp.keyboard.press('/');
      if ((await focused()).id !== 'search-input') k('`/` did not focus search');
      await sp.keyboard.press('Escape');
      await sp.locator('#list [role=option]').first().focus();
      await sp.keyboard.press('f');
      const pressed = await sp.getAttribute('[data-filter=failed]', 'aria-pressed');
      if (pressed !== 'true') k('`f` did not switch to the Failed filter');
    }
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`a11y: ${failures.length} problem(s)\n  ` + failures.join('\n  '));
    process.exit(1);
  }
  console.info('a11y: PASS — contrast, names, focus, keyboard, render budget');
}

void main();
