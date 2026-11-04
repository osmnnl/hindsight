// Store assets from the real built extension (dev-only, never shipped).
//
// Renders the CWS / AMO / Edge listing images by loading dist/ into
// Chromium with Playwright, driving a local demo shop, and screenshotting
// the actual popup, side panel, settings page and HTML replay bundle.
// Every image is composed on a flat navy stage (no gradients) and written
// as 24-bit PNG (no alpha).
//
//   npm run build
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node scripts/store-shots.mjs [--out DIR] [--ext dist] [--lang en,tr]
//   node scripts/store-shots.mjs --serve   # demo shop only, for the video
//
// Output (per language): screenshot-1..5-*.png (1280×800),
// marquee-1400x560.png, small-tile-440x280.png, store-logo-300x300.png (Edge).
// Playwright is not a dependency of this repo; point PLAYWRIGHT at any
// install (default: resolve 'playwright' from the cwd).

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((a) => a.trim().split(/\s+/))
    .map(([k, ...v]) => [k, v.join(' ')])
);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EXT = path.resolve(ROOT, args.ext || 'dist');
const OUT = path.resolve((args.out || path.join(ROOT, 'store-shots')).replace(/^~/, os.homedir()));
const LANGS = (args.lang || 'en').split(',');

// Brand palette — same values as icons/icon128.png and the welcome page.
const INK = '#15161a';
const PAPER = '#f1eee3';
const RED = '#e53935';
// Store frame: same navy stage as the StorageNinja and Data Helper listings.
const NAVY = '#131a29';
const NAVY_SUB = '#b6bfce';

const COPY = {
  en: {
    tagline: 'The DevTools you forgot to open.',
    sub: 'Every request, console error and click, already recorded when something breaks.',
    bullets: ['Stays on your computer', 'Secrets masked at capture', 'Share one HTML file'],
    tile: 'Bug reports from what already happened.',
    shots: [
      [
        'Everything that happened, already recorded',
        'Requests, console errors and clicks, in order, for every tab.',
      ],
      ['Every request in full', 'Headers, bodies, timing and the exact error, one click away.'],
      [
        'Share one HTML file',
        'Timeline, narrative and every request. Opens in any browser, offline.',
      ],
      [
        'Secrets are masked before anything is saved',
        'Auth headers, cookies, card numbers and your own patterns.',
      ],
      [
        'Light or dark, it follows your system',
        'The toolbar popup shows what failed on this tab at a glance.',
      ],
    ],
  },
  tr: {
    tagline: 'Açmayı unuttuğunuz DevTools.',
    sub: 'Bir şey bozulduğunda her istek, konsol hatası ve tıklama zaten kayıtlı.',
    bullets: [
      'Bilgisayarınızda kalır',
      'Gizli bilgiler yakalanırken maskelenir',
      'Tek HTML dosyası paylaşın',
    ],
    tile: 'Olmuş olandan hata raporu.',
    shots: [
      [
        'Olan her şey zaten kayıtlı',
        'İstekler, konsol hataları ve tıklamalar; her sekme için, sırasıyla.',
      ],
      ['Her istek eksiksiz', 'Başlıklar, gövdeler, süre ve hatanın kendisi; bir tık uzakta.'],
      [
        'Tek HTML dosyası paylaşın',
        'Zaman çizelgesi, anlatım ve her istek. Her tarayıcıda, çevrimdışı açılır.',
      ],
      [
        'Gizli bilgiler kaydedilmeden maskelenir',
        'Yetki başlıkları, çerezler, kart numaraları ve kendi desenleriniz.',
      ],
      [
        'Açık ya da koyu, sisteminizi izler',
        'Araç çubuğu penceresi bu sekmede neyin bozulduğunu hemen gösterir.',
      ],
    ],
  },
};

// ---------- demo shop (local, fictional) ----------

const SHOP = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lumen Supply · Checkout</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf7;--card:#fff;--text:#1b1c20;--muted:#61636b;--line:#e3e1d9;--btn:#1b1c20;--btnt:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141519;--card:#1c1d22;--text:#ecebe6;--muted:#a3a4aa;--line:#2f3138;--btn:#ecebe6;--btnt:#141519}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 32px;border-bottom:1px solid var(--line)}
header b{font-size:18px;letter-spacing:.02em}nav{display:flex;gap:20px;color:var(--muted);font-size:14px}
main{display:grid;grid-template-columns:1fr 260px;gap:28px;padding:28px 32px}
h1{margin:0 0 16px;font-size:24px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}input,select{width:100%;height:40px;border:1px solid var(--line);border-radius:7px;padding:0 12px;font:inherit;background:var(--card);color:var(--text)}
.row{display:grid;grid-template-columns:3fr 2fr;gap:12px}button{margin-top:18px;width:100%;height:44px;border:0;border-radius:8px;background:var(--btn);color:var(--btnt);font:600 15px system-ui}
.item{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}.item:last-of-type{border:0}.tot{display:flex;justify-content:space-between;font-weight:600;margin-top:12px}
.err{margin-top:14px;padding:10px 12px;border-radius:7px;border:1px solid #d33;color:#d33;font-size:14px;display:none}
</style></head><body>
<header><b>LUMEN SUPPLY</b><nav><span>Shop</span><span>Journal</span><span>Cart (2)</span></nav></header>
<main><section><h1>Checkout</h1><div class="card"><form onsubmit="return false">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
<label for="pw">Password</label><input id="pw" name="password" type="password">
<div class="row"><div><label for="card">Card number</label><input id="card" name="card" autocomplete="cc-number"></div>
<div><label for="country">Country</label><select id="country" name="country"><option>Portugal</option><option>Türkiye</option><option>Canada</option></select></div></div>
<button id="pay" type="button">Pay €118.00</button><div class="err" id="err">Payment failed. Please try again.</div></form></div></section>
<aside class="card"><div class="item"><span>Linen overshirt</span><span>€74.00</span></div><div class="item"><span>Wool beanie</span><span>€32.00</span></div>
<div class="item"><span>Shipping</span><span>€12.00</span></div><div class="tot"><span>Total</span><span>€118.00</span></div></aside></main>
<script>
const j=(u,o)=>fetch(u,o).then(r=>r.json()).catch(()=>null);const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
j('/api/cart');j('/api/products?ids=114,207');
document.getElementById('pay').addEventListener('click',async()=>{
  await j('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer eyJhbGciOiJIUzI1NiJ9.demo.sig'},
    body:JSON.stringify({email:document.getElementById('email').value,card:'4242424242424242',amount:11800,currency:'EUR'})});
  await wait(500);for(let i=0;i<3;i++){await j('/api/session');await wait(150);}await wait(400);
  await new Promise(r=>{const x=new XMLHttpRequest();x.open('GET','/api/recommendations?for=checkout');x.onloadend=r;x.send();});
  document.getElementById('err').style.display='block';
  console.error('Checkout failed: payment_intent is missing (HTTP 500)');
  setTimeout(()=>Promise.reject(new TypeError("Cannot read properties of undefined (reading 'clientSecret')")),20);
});
</script></body></html>`;

function startShop() {
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/cart')
      return json(res, 200, {
        items: [
          { sku: 114, qty: 1 },
          { sku: 207, qty: 1 },
        ],
        currency: 'EUR',
      });
    if (u.pathname === '/api/products')
      return json(res, 200, [
        { id: 114, name: 'Linen overshirt' },
        { id: 207, name: 'Wool beanie' },
      ]);
    if (u.pathname === '/api/checkout') {
      req.resume();
      return req.on('end', () =>
        json(res, 500, {
          error: 'payment_intent is missing',
          code: 'PI_MISSING',
          requestId: 'req_8f2c41',
        })
      );
    }
    if (u.pathname === '/api/session') return json(res, 401, { error: 'session expired' });
    if (u.pathname === '/api/recommendations') return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHOP);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- helpers ----------

const W = 1280;
const H = 800;
const CAP = 96; // caption band height
const PANEL_W = 500;

const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function render(ctx, html, width, height, file) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width, height });
  await p.setContent(html, { waitUntil: 'load' });
  await p.screenshot({ path: file, type: 'png', omitBackground: false });
  await p.close();
  console.info('wrote', path.relative(process.cwd(), file));
}

// Left: kicker, headline, one line. Right: real screenshots as cards.
// cards: [{ png, w, h, x, y, scale }] in stage coordinates.
function frame({ kicker, title, sub, cards }) {
  const imgs = cards
    .map(
      (c) =>
        `<div class="card" style="left:${c.x}px;top:${c.y}px;width:${Math.round(c.w * c.scale)}px;height:${Math.round(c.h * c.scale)}px">` +
        `<img src="${dataUrl(c.png)}" style="width:100%;height:100%"></div>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${NAVY};color:#f3f4f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.l{position:absolute;left:64px;top:0;bottom:0;width:410px;display:flex;flex-direction:column;justify-content:center}
.k{font-size:15px;font-weight:700;letter-spacing:.12em;color:${RED};text-transform:uppercase}
h1{margin:16px 0 18px;font-size:46px;line-height:1.1;letter-spacing:-.02em;text-wrap:balance}
p{margin:0;font-size:20px;line-height:1.5;color:${NAVY_SUB}}
.card{position:absolute;border-radius:12px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08)}
.card img{display:block}
</style></head><body><div class="l"><div class="k">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${imgs}</body></html>`;
}

// ---------- main ----------

const shop = await startShop();
const SHOP_URL = `http://127.0.0.1:${shop.address().port}/`;
if ('serve' in args) {
  // Demo shop only (for recording the store video by hand). Ctrl+C to stop.
  console.info(`Demo shop: ${SHOP_URL}`);
  await new Promise(() => {});
}
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`No build at ${EXT}. Run npm run build first.`);
  process.exit(1);
}
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
fs.mkdirSync(OUT, { recursive: true });

for (const lang of LANGS) {
  const copy = COPY[lang];
  if (!copy) throw new Error(`unknown --lang ${lang}`);
  const outDir = LANGS.length > 1 ? path.join(OUT, lang) : OUT;
  fs.mkdirSync(outDir, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-shots-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: W, height: H },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const id = sw.url().split('/')[2];
    const ext = (p) => `chrome-extension://${id}/${p}`;
    await sw.evaluate(
      (l) => chrome.storage.local.set({ 'settings/general': { language: l } }),
      lang
    );
    // Onboarding hint off so the popup looks like a normal day.
    await sw.evaluate(() =>
      chrome.storage.local.set({ 'onboarding/state': { installedAt: 1, hintDone: true } })
    );
    await new Promise((r) => setTimeout(r, 800));
    for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close();

    // Drive the shop at the size it will appear next to the panel.
    const shopPage = await ctx.newPage();
    await shopPage.setViewportSize({ width: W - PANEL_W, height: H - CAP });
    await shopPage.goto(SHOP_URL);
    // Spread over a few seconds so the timeline histogram has a shape.
    await shopPage.waitForTimeout(1500);
    await shopPage.fill('#email', 'ada@example.com');
    await shopPage.waitForTimeout(700);
    await shopPage.fill('#pw', 'correct-horse-battery');
    await shopPage.waitForTimeout(600);
    await shopPage.fill('#card', '4242 4242 4242 4242');
    await shopPage.waitForTimeout(500);
    await shopPage.selectOption('#country', 'Portugal');
    await shopPage.waitForTimeout(900);
    await shopPage.click('#pay');
    await shopPage.waitForTimeout(2500);
    await shopPage.bringToFront();
    const tabId = await sw.evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id
    );
    // Extension pages opened as normal tabs: point "the active tab" at the shop.
    await ctx.addInitScript(`(() => { if (location.protocol !== 'chrome-extension:') return;
      const q = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (o) => (o && o.active ? [await chrome.tabs.get(${tabId})] : q(o)); })();`);

    const shopShot = async (dark) => {
      await shopPage.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await shopPage.waitForTimeout(150);
      return shopPage.screenshot({ type: 'png' });
    };
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: PANEL_W, height: H - CAP });
    await panel.goto(ext('src/sidepanel/sidepanel.html'));
    await panel.waitForTimeout(1200);
    await panel.click('button[data-filter=all]').catch(() => {});
    await panel.waitForTimeout(300);
    const panelShot = async (dark) => {
      await panel.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
      await panel.waitForTimeout(200);
      return panel.screenshot({ type: 'png' });
    };

    // The side panel follows the active tab, and every new page (popup,
    // viewer, even render()) activates a tab, so take all panel shots first.
    const listLight = await panelShot(false);
    const listDark = await panelShot(true);
    await panel.emulateMedia({ colorScheme: 'light' });
    await panel.locator('#list').getByText('/api/checkout').first().click();
    await panel.waitForTimeout(600);
    const detail = await panelShot(false);
    await panel
      .click('#detail button:has-text("Back"), #detail [data-action=back]')
      .catch(() => {});
    await panel.waitForTimeout(300);
    const [download] = await Promise.all([
      panel.waitForEvent('download', { timeout: 10000 }),
      panel.click('#download-bundle'),
    ]);
    const bundlePath = path.join(profile, 'hindsight-bundle.html');
    await download.saveAs(bundlePath);
    const shopLight = await shopShot(false);

    const pop = await ctx.newPage();
    await pop.setViewportSize({ width: 360, height: 560 });
    await pop.emulateMedia({ colorScheme: 'dark' });
    await pop.goto(ext('src/popup/popup.html'));
    await pop.waitForTimeout(1000);
    const popH = Math.min(await pop.evaluate(() => document.body.scrollHeight), H - CAP - 24);
    const popPng = await pop.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: 360, height: popH },
    });
    await pop.close();

    const viewer = await ctx.newPage();
    await viewer.setViewportSize({ width: W, height: H - CAP });
    await viewer.goto(`file://${bundlePath}`);
    await viewer.waitForTimeout(800);
    const bundlePng = await viewer.screenshot({ type: 'png' });
    await viewer.close();

    const settings = await ctx.newPage();
    await settings.setViewportSize({ width: W, height: H - CAP });
    await settings.goto(ext('src/settings/settings.html'));
    await settings.waitForTimeout(600);
    await settings.click('[data-section="privacy"], a[href="#privacy"]').catch(() => {});
    await settings.waitForTimeout(400);
    const settingsPng = await settings.screenshot({ type: 'png' });
    await settings.close();

    const kicker = `Hindsight ${VERSION}`;
    const PH = H - CAP; // panel and page screenshot height
    const shots = [
      [
        'screenshot-1-timeline.png',
        [
          { png: shopLight, w: W - PANEL_W, h: PH, x: 500, y: 150, scale: 0.6 },
          { png: listLight, w: PANEL_W, h: PH, x: 770, y: 56, scale: 0.97 },
        ],
      ],
      [
        'screenshot-2-request.png',
        [
          { png: listLight, w: PANEL_W, h: PH, x: 500, y: 90, scale: 0.88 },
          { png: detail, w: PANEL_W, h: PH, x: 770, y: 56, scale: 0.97 },
        ],
      ],
      ['screenshot-3-share.png', [{ png: bundlePng, w: W, h: PH, x: 500, y: 190, scale: 0.6 }]],
      ['screenshot-4-privacy.png', [{ png: settingsPng, w: W, h: PH, x: 500, y: 190, scale: 0.6 }]],
      [
        'screenshot-5-dark.png',
        [
          { png: listDark, w: PANEL_W, h: PH, x: 770, y: 56, scale: 0.97 },
          { png: popPng, w: 360, h: popH, x: 500, y: 120, scale: 0.9 },
        ],
      ],
    ];
    for (const [i, [file, cards]] of shots.entries()) {
      const [title, sub] = copy.shots[i];
      await render(ctx, frame({ kicker, title, sub, cards }), W, H, path.join(outDir, file));
    }

    // Promo tiles — brand block plus a real crop of the side panel.
    const icon = dataUrl(fs.readFileSync(path.join(EXT, 'icons/icon128.png')));
    await render(
      ctx,
      `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:1400px;height:560px;overflow:hidden;background:${NAVY};color:#f3f4f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .l{position:absolute;left:80px;top:0;bottom:0;width:640px;display:flex;flex-direction:column;justify-content:center}
      .b{display:flex;align-items:center;gap:18px}.b img{width:72px;height:72px;border-radius:14px;background:${PAPER};padding:6px}.b span{font-size:54px;font-weight:700;letter-spacing:-.02em}
      h2{margin:26px 0 12px;font-size:40px;line-height:1.15;letter-spacing:-.01em}p{margin:0;font-size:21px;line-height:1.45;color:${NAVY_SUB};max-width:600px}
      .c{position:absolute;overflow:hidden;border-radius:12px 12px 0 0;box-shadow:0 18px 48px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.08);border-bottom:0}.c img{display:block}
      </style></head><body><div class="l"><div class="b"><img src="${icon}"><span>Hindsight</span></div>
      <h2>${esc(copy.tagline)}</h2><p>${esc(copy.sub)}</p></div>
      <div class="c" style="left:800px;top:70px;width:430px;height:490px"><img src="${dataUrl(listLight)}" width="430"></div>
      <div class="c" style="left:960px;top:20px;width:400px;height:540px"><img src="${dataUrl(listDark)}" width="400"></div></body></html>`,
      1400,
      560,
      path.join(outDir, 'marquee-1400x560.png')
    );

    await render(
      ctx,
      `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;width:440px;height:280px;overflow:hidden;background:${NAVY};color:#f3f4f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .w{position:absolute;inset:0;padding:0 36px;display:flex;flex-direction:column;justify-content:center}
      .b{display:flex;align-items:center;gap:14px}.b img{width:60px;height:60px;border-radius:12px;background:${PAPER};padding:5px}.b span{font-size:42px;font-weight:700;letter-spacing:-.02em}
      p{margin:18px 0 0;font-size:21px;line-height:1.3;font-weight:600;color:${NAVY_SUB}}</style></head><body><div class="w">
      <div class="b"><img src="${icon}"><span>Hindsight</span></div><p>${esc(copy.tile)}</p></div></body></html>`,
      440,
      280,
      path.join(outDir, 'small-tile-440x280.png')
    );

    // Edge Add-ons store logo (300 × 300). Vector redraw of icons/icon128.png
    // so it stays sharp at this size.
    await render(
      ctx,
      `<!doctype html><html><body style="margin:0;width:300px;height:300px;background:${PAPER}">
      <svg width="300" height="300" viewBox="0 0 300 300"><path d="M28 150 Q150 46 272 150 Q150 254 28 150 Z" fill="#fbfaf5" stroke="${INK}" stroke-width="14" stroke-linejoin="round"/>
      <circle cx="150" cy="150" r="56" fill="${INK}"/><circle cx="150" cy="150" r="27" fill="${RED}"/></svg></body></html>`,
      300,
      300,
      path.join(outDir, 'store-logo-300x300.png')
    );
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
shop.close();
console.info(`Hindsight ${VERSION} store assets → ${OUT}`);
