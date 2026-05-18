# M1 Smoke Test Checklist

Run this before tagging `v0.1.0` and any time the capture pipeline,
masking engine, or storage layer changes substantially. Roughly 15–20
minutes if everything is healthy; longer if something needs digging.

Prerequisite: clean `npm run build` (CI green is necessary but not
sufficient — these tests verify behavior in a real browser).

---

## 0. Load the extension

1. `npm run build`
2. `chrome://extensions` → Developer mode on → **Load unpacked** →
   select the `dist/` directory.
3. Confirm the toolbar icon appears and the popup opens without errors
   (DevTools → Service worker → no red entries).

---

## 1. Capture sanity (fetch + XHR)

Test on at least three site categories so we exercise different
ecosystems:

| Category                | Suggested site                                                      | What to look for                                                          |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| SPA                     | github.com (logged out is fine)                                     | Hover repos → JSON fetches show up; clicking through routes adds entries. |
| Traditional MPA         | wikipedia.org → any article → search                                | Initial nav + search fetch show up; durations look reasonable.            |
| Auth-heavy / API-driven | any internal app you can reach, or httpbin.org with custom requests | POSTs land with full request body; 401/500 fixtures turn the badge red.   |

Per site, verify:

- Toolbar badge shows the failed-request count.
- Popup list is sorted newest-first.
- Detail view renders request / response / headers / body in full
  fidelity (no truncation in storage).
- Time-of-day column reads correctly (HH:MM:SS.mmm local time).

---

## 2. Masking engine (TCKN false-positive guard)

Test page: a simple form or a small fetch you control. Two TCKN
fixtures:

- **Luhn-invalid 11-digit string** — e.g. `12345678901`. Expected:
  appears verbatim in the captured body (no mask).
- **Luhn-valid TCKN** — e.g. `12345678950` (checksum-valid; see
  masking.test.ts for derivation). Expected: replaced with
  `***MASKED***` in the captured body, and the detail view shows the
  Privacy panel: "1 field masked — TCKN".

Repeat for credit card with a known test PAN
(`4242 4242 4242 4242`) — should mask.

Confirm that the **Privacy panel** in the detail view groups by rule
and lists scope correctly.

---

## 3. Headers & cookies

Use a request that sends an `Authorization` header (any logged-in
site works). Verify:

- Detail view → Request headers shows `Authorization: ***MASKED***`.
- HAR export — open the downloaded `.har` in DevTools → Network →
  Import. Verify `request.headers` shows `Authorization` masked AND
  `request.cookies` is empty (no leak through the cookie parser).
  This is the production check that backs the `har.test.ts` audit.

If `request.cookies` ever shows real name=value pairs after a
masked Cookie header, **stop and file a P0** — fix in `har.ts`
`extractCookies` to skip when the source value is `***MASKED***`.

---

## 4. Settings persistence

1. Open settings (extension icon → right-click → Options, or
   `chrome://extensions` → Hindsight → Details → Extension options).
2. Change theme to **Dark**. Confirm "✓ Saved" flash.
3. Switch to Privacy → add a custom pattern (label "My token", regex
   `\bsk_test_[A-Za-z0-9]+\b`, both scopes). Confirm it persists.
4. Add an origin to the blocklist: `https://example.com`.
5. **Quit and restart Chrome.** Reopen settings.
   - Theme is still Dark.
   - Custom pattern is still present and editable.
   - Blocklist still contains `https://example.com`.

If anything resets, suspect `schemaVersion` mismatch or a missing
defensive default in `readPrivacySettings` / `readGeneralSettings`.

---

## 5. Blocklist effect

1. With `https://example.com` in the blocklist, visit
   `https://example.com` and reload a few times.
2. Open the Hindsight popup.
3. Expected: empty state. **Zero** captures from example.com.
4. Visit a non-blocked site → captures appear normally.

Then remove the origin from the blocklist; new visits should capture
again.

---

## 6. HAR export — round-trip readability

1. Generate a few captures on any site.
2. Popup → bulk bar → **⤓ HAR**. Download saves
   `hindsight-{host}-{ISO-ts}.har`.
3. Open the `.har` in Chrome DevTools (Network panel → drag the file
   into it). Verify:
   - All entries appear with correct status / method / URL.
   - Request and response bodies are preserved.
   - Masked headers stay masked.
   - Timings show the expected duration.
4. Optional: open the same HAR in Postman or
   [softwareishard.com HAR viewer](http://www.softwareishard.com/har/viewer/)
   for cross-tool sanity.

---

## 7. Tab lifecycle

- Close a tab with captures → reopen popup on a different tab →
  closed-tab captures are gone (M1 behavior; PRD §6.1.3 archive lands
  in M3).
- Full reload (Cmd+Shift+R) on a tab → previous captures cleared,
  badge resets.

---

## 8. Sequence counter persistence

Service workers are evicted aggressively. To force one:

1. Capture a few events.
2. `chrome://serviceworker-internals` → find Hindsight → **Stop**.
3. Trigger another fetch on the same tab (the SW wakes back up).
4. Inspect the new event's `sequenceNumber` — it must be **larger**
   than the previous one, not 1.
   - Find the events via `chrome.storage.local.get` in DevTools
     → Application → Storage → Extension storage, key
     `sessions/{tabId}/events`.

---

## Sign-off

When all eight sections are green:

- [ ] Tag the build (`git tag v0.1.0`).
- [ ] Update `CHANGELOG.md` "Released" date if it drifted.
- [ ] Move the next sprint's tasks to "in progress".
