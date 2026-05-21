# M3 Smoke Test Checklist

Run before tagging `v0.3.0` and any time the side panel, detection
engine, or notifications layer changes substantially. Extends
`M2-SMOKE-TEST.md` with the M3 surfaces.

Prerequisite: `npm run build` clean, `npm test` 65/65, `npm run bench`
both gates green.

---

## 0. Load + popup launcher

1. `npm run build`
2. `chrome://extensions` → Load unpacked → `dist/`.
3. Click the toolbar icon — the **popup is now a launcher** (320 px
   wide, "X events" counter, "Open side panel" button, Settings
   link). It is no longer the full timeline.
4. Click "Open side panel" — the panel opens on the active tab.
5. Press Ctrl+Shift+H (Cmd+Shift+H on macOS) from any tab — the side
   panel opens for that tab. The popup is not involved.

---

## 1. Side panel timeline + scrubber (W9-2)

1. Open the side panel on a busy site (e.g. github.com).
2. Reproduce ~15 events: clicks, fetches, a console.error.
3. The list renders newest-first with all event families mixed.
4. A **density histogram** appears at the top with the time range
   labels (start → end).
5. Drag the range input. The list scrolls to the nearest event at
   that time percentile. Smooth, no flicker.
6. With > 1000 events queued (force via a script in DevTools), the
   panel still scrolls at 60 fps. Event delegation = one click
   listener regardless of row count.

---

## 2. Screenshot on error (W9-3)

1. On any site, open DevTools and run
   `fetch('/nonexistent-' + Math.random())` — a 404 fires.
2. Within 2 s, an additional `screenshot` event lands in the side
   panel right after the failed fetch row.
3. Open the failed fetch's detail view. A **"Screenshot at error
   moment"** section appears with the inline JPEG.
4. Run the same fetch within 2 s — only the first triggers a
   screenshot (rate limit).
5. Trigger `console.error('test')` from DevTools — screenshot
   fires the same way.

---

## 3. Detection rule engine + cluster banner (W9-4 + W10-1 + W11-2)

Force a cascade: 3 failed requests to the same host within 10 s
(DevTools console: a loop with `await fetch('https://example.com/x' +
Math.random())` against an endpoint returning 500).

1. Side panel shows a **🔴 cluster banner** above the events:
   "<status> cascade — <method> <path> · N failures in <Xs> · <host>".
2. The 3 events are hidden under the banner. The "▸ N" pill on the
   right shows the count.
3. Click the banner → it expands. All members + head render
   indented below.
4. Click again → collapses.
5. Trigger a **slow request** (> 3 s — use `setTimeout` + a long
   `await` mock). The row carries the `flag-slow` left border tint
   (yellow).
6. Trigger an **anomaly** (repeat the exact same failing URL twice).
   The second event carries `flag-anomaly` (pink left border).

---

## 4. Performance long-task + CLS (W10-3)

1. Visit a heavy SPA (e.g. a complex dashboard).
2. The side panel logs `PER · LT · Long task — <attribution> · <ms>`
   rows for tasks > 100 ms.
3. Trigger a layout shift (resize a hero image dynamically) — a
   `CLS · 0.NNNN` row appears.
4. Open Settings → Capture → uncheck "Capture performance long
   tasks + layout shifts". Reload the page; new performance rows
   stop landing. Existing ones stay in the buffer (OQ-M2-J
   "history preserved" behavior).

---

## 5. White-screen heuristic (W10-4)

1. Visit a page that loads no body content for > 5 s (e.g. a hung
   loader, or `<html><body></body></html>`).
2. Within 5 s of page load, an **`UNC · LOG`** event appears with
   the message "White-screen heuristic: only N visible elements 5
   s after load (PRD §6.2.1)".
3. The badge ticks red, screenshot fires.
4. SPA route changes that don't reload the page do **not** trigger
   the heuristic (it runs once per IIFE lifetime).

---

## 6. Detection settings + notifications (W10-2 + W11-4)

1. Open Settings → Detection.
2. Uncheck **Smart detection** — reload a tab and reproduce a
   cascade. No `flag-cascade` tints, no cluster banner. Raw events
   only.
3. Re-check smart detection.
4. Check **Show notifications**. Chrome asks for the notifications
   permission — grant it.
5. Trigger a cascade. A desktop notification appears:
   "Hindsight: failure cascade — 3+ failures on <origin> …".
6. Trigger another cascade within the same session →
   **no second notification** (first-per-session default).
7. Change frequency to "Every occurrence" → next cascade notifies
   again.
8. Trigger an anomaly (repeated identical failure) — separate
   notification fires ("Hindsight: repeated identical failure …").
9. Revoke the notifications permission via chrome://extensions →
   subsequent fires fail silently; no error logged, no UI break.

---

## 7. Severity-tiered badge (W10-5)

1. Clean page (Tier 1 only, no errors) → **no badge**.
2. Page with a slow request (no errors) → **yellow "!" badge**.
3. Page with one failed fetch → **red count badge ("1")**.
4. Page with cascade → still red, count = total errors.

---

## 8. Recent-archive viewer (W9-5)

1. Capture some events on Tab A.
2. Close Tab A.
3. Open the side panel on any other tab.
4. The "Closed sessions" panel at the top shows "1 closed session"
   with the origin + event count + archived date.
5. Expand it — the events list renders read-only.
6. Click "Clear archive" → panel hides.
7. Browser restart preserves the archive (storage.local persistence).

---

## 9. Theme sync (W9-1)

1. Settings → General → Theme = Dark → flash "Saved".
2. The settings page reskins immediately.
3. Open the side panel on the same tab → reskinned to dark.
4. Open the popup → reskinned to dark.
5. Switch Theme = Light. All three surfaces flip together.
6. Theme = Match system. data-theme attribute clears;
   prefers-color-scheme takes over.

---

## 10. Perf gates (CI parity)

1. `npm run bench` — fetch + XHR gates both PASS.
2. p95 deltas well under 0.5 ms (typically 0.01 ms fetch, 0.001 ms
   XHR on Apple Silicon).

---

## Sign-off

When all ten sections are green:

- [ ] Tag the build (`git tag v0.3.0`).
- [ ] Update `CHANGELOG.md` "Released" date if it drifted.
- [ ] CWS submission prep: re-upload the latest CI artifact to the
      unlisted listing per `docs/CWS-LISTING.md` (v0.3.0 carries
      meaningful new visible features — side panel + detection —
      that beta testers will want).
