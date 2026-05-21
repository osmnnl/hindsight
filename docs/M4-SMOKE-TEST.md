# Hindsight M4 smoke test

Manual verification checklist for the v0.4.0 release. Run these in
Chrome (latest stable) against the load-unpacked `dist/` from
`npm run build`. Expected total runtime: 12–15 minutes.

## 0. Build + load

- [ ] `npm install` clean install on a node ≥ 20.10 machine.
- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`,
      `npm test`, `npm run bench`, `npm run build` all green.
- [ ] `chrome://extensions` → developer mode → Load unpacked → select
      the project's `dist/` directory.
- [ ] Pin Hindsight to the toolbar.

## 1. Tier 1 + Tier 2 capture sanity

- [ ] Browse to a site with at least one failing API request (e.g. an
      app that has a 401 / 500 endpoint somewhere).
- [ ] Open the side panel (Ctrl/Cmd+Shift+H or via the popup → Open
      side panel).
- [ ] Failed requests appear with a red status pill.
- [ ] Click a request — detail view shows headers, body, response,
      cURL button.

## 2. Replay this request (W14-2)

- [ ] On a `GET` request, click ↻ Replay — fires immediately, no
      confirm. Response status renders inline. If status matches the
      capture, badge is green; if different, yellow.
- [ ] On a `POST` request, ↻ Replay shows the destructive-method
      confirm() with the URL. Cancel — nothing happens. Accept —
      response renders.
- [ ] CORS-blocked replay surfaces the "Network error" red banner
      with the explainer about CORS / host permissions.

## 3. ZIP archive export (W14-1)

- [ ] Bulk bar → ⤓ ZIP — downloads `hindsight-<host>-<timestamp>.zip`.
- [ ] Unzip; verify the archive contains:
  - `report.md` — opens as a readable markdown bug report.
  - `session.json` — narrative + every captured event.
  - `session.har` — opens in Chrome DevTools Network panel "Import HAR".
  - `replay.html` — open in another browser tab; viewer loads.
  - `screenshots/NNN-<trigger>.jpg` for each captured screenshot.
- [ ] No sensitive value (Authorization, Cookie, password) is visible
      in any of the artifacts — every match should be `***MASKED***`.

## 4. Privacy preview modal (W14-3)

- [ ] In Settings → Sharing, paste any Slack webhook URL (or use a
      throwaway). Reload the side panel.
- [ ] Bulk bar → → Slack — the privacy modal pops with:
  - Event count + error count.
  - Webhook URL preview (truncated to 64 chars).
  - Per-rule redaction breakdown (if any).
- [ ] Esc cancels. Enter / Continue commits. Click outside the modal
      cancels.
- [ ] On success the button reads "✓ Sent" (or "✓ Sent (truncated)"
      when the report exceeded the destination cap).

## 5. Recording mode (W12-2, W12-3, W13-2)

- [ ] Side panel header → ● Record. Button switches to "■ Stop · 00:00"
      and pulses.
- [ ] Popup opens with a red "Recording · MM:SS" banner and a ■ Stop
      button — counter ticks.
- [ ] Move the cursor and scroll for ~5 seconds — cursor / scroll
      events accumulate in the All filter.
- [ ] Every 2 seconds a `screenshot` event with `trigger=recording-tick`
      gets queued.
- [ ] Click ■ Stop in either popup or side panel. A
      `hindsight-recording-<host>-<timestamp>.html` file downloads.

## 6. Replay bundle viewer polish (W14-4)

- [ ] Open the downloaded `.html` in a fresh tab.
- [ ] Failed / All chips toggle visible events; count chip on the right
      updates (`N / total`).
- [ ] Type a substring into the search box — events filter live across
      url + message + data.
- [ ] ←/→ (or ↑/↓) step through the visible events; the detail pane
      and scroll position follow.
- [ ] Scrubber drags the list to the matching time slice.

## 7. Settings → Advanced (W14-5)

- [ ] Settings (gear in popup footer) → Advanced tab opens (no more
      "M2+" badge).
- [ ] Toggle Debug logging → ✓ Saved flashes.
- [ ] Edit perf budget threshold → ✓ Saved flashes; reload and value
      sticks.
- [ ] Click Refresh → storage usage shows `local: X.X KB · sync: X.X KB`.
- [ ] Click "Reset all data" → confirm; sidepanel events / archive
      empty, settings revert to defaults, page reloads.

## 8. Popup ↔ sidepanel state sync (W15)

- [ ] Start a recording from the popup banner is not possible (popup
      only stops); start from the sidepanel.
- [ ] Open the popup mid-recording — banner is live, counter matches
      the sidepanel.
- [ ] Stop from the popup — sidepanel banner switches back to "● Record"
      on the next 1 s poll.

## 9. Screenshot click-to-zoom (W15)

- [ ] Open a failed network request that paired a screenshot.
- [ ] Click the screenshot thumbnail — opens at full pixel size in a
      new tab.

## 10. Esc closes detail view (W15)

- [ ] Open any event's detail view in the sidepanel.
- [ ] Press Esc — view collapses, bulk bar reappears.
- [ ] Click into the bundle viewer's search input, press Esc — search
      field stays focused; detail view (if any) is unaffected because
      Esc inside an input is consumed before the global handler.

## 11. Regression — M1 / M2 / M3 still work

- [ ] Settings → Privacy → add a custom regex pattern, test in
      sandbox.
- [ ] Settings → Privacy → blocklist an origin; events from that
      origin disappear from captures.
- [ ] Settings → Capture → disable Tier 2, click around — no
      action.click events appear in new captures.
- [ ] Settings → Detection → enable notifications. Trigger a cascade
      on a site with 3+ 4xx/5xx requests in 10 s — system notification
      fires once per session.
- [ ] Closed-tab archive panel appears when a tab with captures is
      closed.

## 12. Perf gates (CI guard)

- [ ] `npm run bench` exits 0; fetch p95 < 0.5 ms, XHR p95 < 0.5 ms.

## 13. No regressions

- [ ] No `console.error` in the SW console under normal capture.
- [ ] No outbound network requests originate from the extension
      (DevTools → Network → filter `chrome-extension://<id>`) — only
      the captured tab's own traffic.
- [ ] No `datasoft` string anywhere in `dist/`:
      `grep -ri datasoft dist/` returns nothing.

## Cut criteria

Every box checked → M4 is closeable. Any unchecked item that's not a
"won't fix" goes back into the loop before the v0.4.0 tag and CWS
resubmit.
