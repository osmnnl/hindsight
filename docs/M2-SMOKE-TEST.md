# M2 Smoke Test Checklist

Run before tagging `v0.2.0` and any time the capture pipeline,
masking engine, batching layer, or settings round-trip changes
substantially. Extends `M1-SMOKE-TEST.md` with the M2 surfaces.

Prerequisite: `npm run build` clean, `npm test` 53/53, `npm run bench`
both gates green.

---

## 0. Load the extension

1. `npm run build`
2. `chrome://extensions` → Developer mode on → **Load unpacked** →
   select `dist/`.
3. Service worker console (DevTools → Service worker) has no red
   entries on boot.

---

## 1. Tier 1 capture (network + console + navigation)

1. Visit `https://httpbin.org/status/500` — badge ticks red, popup
   shows `500 GET /status/500`.
2. Visit `wikipedia.org` → click an article → search. Network +
   navigation events both appear in the popup.
3. Browser DevTools console → `console.error('boom')` → Hindsight
   popup shows a red ERR row with message "boom".
4. Trigger an uncaught error (e.g. `setTimeout(() => { throw new Error('uncaught'); })`)
   → `UNC` row appears.

---

## 2. Tier 2 capture (click + input + WebSocket + console.warn/info)

1. Click any button on any page → `CLK` row, target column shows
   `<button> <accessible-name>`.
2. Type into a form `<input type="text">` → `INP` row with value
   visible in detail view.
3. Type into a `<input type="password">` → `INP🛡` row, value is
   `***MASKED***` (verify in detail view + JSON download).
4. Open a WebSocket (any chat / live site, or DevTools console:
   `const w = new WebSocket('wss://echo.websocket.events'); w.onopen = () => w.send('hi');`)
   → rows for connect / open / message (send + recv) / close.
5. `console.warn('soft')` → `WRN` row. `console.info('news')` →
   `INF` row.

---

## 3. SPA route change

1. Visit any React Router / Next.js / Vue Router site (e.g.
   GitHub navigation across repos).
2. Click links that don't trigger full page loads.
3. Each route change produces a `NAV` row with `fromHost → toHost`
   in the URL column. Detail view shows `transitionType:
'pushState'` (or 'replaceState' / 'hashchange').
4. Browser back/forward across full nav: webNav navigation event
   fires once — **not** doubled by popstate (we don't wrap
   popstate).

---

## 4. Masking (Tier 2 form fields + Tier 1 body content)

1. Page with a password field — type. Value lands as
   `***MASKED***`, redactions list shows `form.password-type`.
2. Submit a form that sends `application/json` body with a
   Luhn-valid card number `4242424242424242` — request body in
   storage shows `***MASKED***`, redactions list shows
   `pattern.creditcard`.
3. Submit a Luhn-invalid 16-digit string — passes through unmasked.
4. Cookie audit (production check for `har.test.ts` audit):
   - Log into any site so a Cookie header gets sent.
   - Make a fetch from DevTools. Detail view → Request headers
     shows `Cookie: ***MASKED***`.
   - Download HAR. `entries[].request.cookies` MUST be `[]`.
   - If `cookies` ever shows real name=value pairs → P0 fix in
     `har.ts:extractCookies`.

---

## 5. Settings — Capture section (W7-3)

1. Settings → Capture → uncheck "Capture Tier 2 events".
2. Reload a test page; click around, type into inputs.
3. Popup: only Tier 1 events appear (no CLK, INP, WS rows).
4. Re-check the toggle → next interactions show up again.
5. Change buffer cap from 200 to 50; reload and capture > 50
   events; verify oldest event drops (popup list length caps at 50).
6. **OQ-M2-J check**: toggle Tier 2 off mid-session; existing CLK/INP
   rows stay in the popup. Only NEW events are filtered.

---

## 6. Closed-tab archive (W7-1)

1. Capture some events on Tab A.
2. Close Tab A.
3. SW console: read storage. `archives/recent` array contains the
   session with `archivedAt`, `meta`, `events`. Live keys
   `sessions/{closedTabId}` are gone.
4. Reload extension → `sweepArchive` runs on boot. Entries newer
   than 7 days survive.
5. Reload a tab (Cmd+Shift+R): session deleted from live storage,
   **not** added to archive (reload is explicit live reset per PRD
   §6.1.3).

---

## 7. Batched writes (W6-1)

1. Type rapidly into a form (20+ chars in a second).
2. SW console: chrome.storage.local writes occur ≈4 times per
   second (~250 ms intervals), not per keystroke.
3. Popup updates ≈ in real-time — projected buffer makes pending
   events visible before they flush.
4. If the SW is evicted between flush windows, the pending events
   are lost (acceptable per PRD §6.1.3).

---

## 8. Export — narrative banner

1. Capture a mixed session (network + actions + nav).
2. Popup → bulk bar → "📋 Copy network" → paste somewhere.
   - Output begins with `## Session narrative` block (Overview,
     Failures, Actions, Navigation sections as relevant).
   - Followed by `---` separator then the per-request bodies.
3. Popup → "⤓ JSON" → open the file.
   - Top-level key `_narrative` (string) precedes the `events`
     array.
4. Popup → "⤓ HAR" → open the file.
   - **No** `_narrative` field at log or entry level (HAR consumers
     don't tolerate it — OQ-M2-F).

---

## 9. Perf gates (CI parity)

1. `npm run bench` — both fetch and XHR gates PASS.
2. Observed delta p95 well under 0.5 ms (typically 0.01 ms fetch,
   0.001 ms XHR on Apple Silicon).
3. If either gate fails locally on a slow machine, run twice — JIT
   warmup or thermal throttle can cause one-off spikes.

---

## Sign-off

When all nine sections are green:

- [ ] Tag the build (`git tag v0.2.0`).
- [ ] Update `CHANGELOG.md` "Released" date if it drifted.
- [ ] Hand off to CWS submission prep (`docs/CWS-LISTING.md`).
