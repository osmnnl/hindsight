# Hindsight — CWS description (EN)

Copy-paste source for the **Chrome Web Store → Store listing →
Description** field (16,000 character limit, plain text; CWS does not
render Markdown here, but URLs auto-link). Total: ~3,500 characters.

The same text lives in [`store/cws/description-en.txt`](../store/cws/description-en.txt);
the Turkish listing is [`store/cws/description-tr.txt`](../store/cws/description-tr.txt).
Edit those files and regenerate this one, not the other way round.

Paste the text between `--- COPY BELOW ---` and `--- END COPY ---`,
without the markers.

Every claim below was checked against 1.0.0 behaviour. Two wordings are
deliberate:

- **Screenshots** are only attached on tabs where the user has invoked
  Hindsight (Chrome's `activeTab`), because the manifest requests no
  broad host permission. Do not write "a screenshot of every error".
- **Replay** asks for one origin the first time it is used on it
  (B2, `optional_host_permissions`).

---

--- COPY BELOW ---

Hindsight is the DevTools you forgot to open.

It records every network request, console error and user action in the background. When something breaks, you scrub back through what already happened and share a faithful bug report, without reproducing anything.

WHY IT EXISTS

You hit a bug. You open DevTools. You refresh. It doesn't happen again, and the request you needed is gone. Hindsight is always recording, so by the time you notice something went wrong, the evidence is already there.

WHAT IT RECORDS

• Network: fetch, XMLHttpRequest, WebSocket and Server-Sent Events, with request and response headers and bodies
• Console: errors and warnings, uncaught errors and unhandled promise rejections, with stack traces
• User actions: clicks, form input (passwords and card numbers are never stored), page loads and single-page-app route changes
• Performance signals: long tasks over 100 ms, layout shift, and a blank-page check
• Screenshots: attached to errors on tabs where you have opened Hindsight (toolbar icon, side panel or shortcut)
• Recording mode: press Record to add scroll, cursor and a screenshot every 2 seconds; press Stop for a bookended session

SHARE ONE FILE

Save the whole session as one self-contained HTML file. Whoever opens it sees the timeline, a plain-language narrative and every request and response, in any browser, offline, without installing anything.

Or send it straight to Slack, Microsoft Teams or Discord through your own webhook, open a pre-filled GitHub issue or email, or copy a single request as cURL, raw request and response, or a Markdown report. A preview shows exactly what will be sent before every send.

PRIVATE BY DESIGN

• Everything is stored on your computer. Hindsight has no server and makes no network requests of its own
• No telemetry, no analytics, no third-party code
• Authorization, Cookie, Set-Cookie, X-API-Key, X-Auth-Token and Proxy-Authorization headers are masked when they are captured, so the original values are never written to disk
• Card numbers (Luhn-checked), Turkish national IDs (checksum-validated) and your own regex patterns are masked in bodies
• Exclude any site entirely in Settings → Privacy

FIND IT FAST

• Timeline scrubber with a two-handle range to clip both ends
• Failed / API / All filters, full-text search and a per-site picker
• Repeated failures are grouped into one cluster row
• Replay a captured request: Hindsight asks for access to that one site the first time, and you can revoke it in Settings

FAST BY RULE

Every release must pass hard performance benchmarks in CI:
• fetch overhead: under 0.01 ms (p95)
• XMLHttpRequest overhead: under 0.002 ms (p95)
• filtering 1,000 events: 0.25 ms (p95)
• a bounded rolling buffer per tab (200 events / 2 MB), checked with 20+ real tabs

Install it, pin it, and browse as usual. English and Türkçe.

OPEN SOURCE (MIT)

Every privacy claim above can be checked in the source code.

Website: https://osmnnl.github.io/hindsight/
Source: https://github.com/osmnnl/hindsight
Privacy policy: https://osmnnl.github.io/hindsight/privacy.html
Report a problem: https://github.com/osmnnl/hindsight/issues
Changelog: https://github.com/osmnnl/hindsight/blob/main/CHANGELOG.md

MORE FROM THE SAME AUTHOR

StorageNinja: copy, paste and manage Local Storage, Session Storage, cookies, IndexedDB and Cache Storage of a tab. https://osmnnl.github.io/StorageNinja/
Data Helper: valid Turkish test data (TCKN, VKN, IBAN), consistent personas, one-click form fill. https://osmnnl.github.io/TestDataHelper/

--- END COPY ---

---

## Field reference (the form also asks for these)

| CWS field                 | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Package title             | `Hindsight` (from `_locales/*/messages.json` → `appName`)                                                            |
| Summary                   | Comes from the manifest: `DevTools you didn't open. Privacy-first passive capture for bug reports.` (73 / 132 chars) |
| Category                  | Developer Tools                                                                                                      |
| Language                  | English (default locale), Türkçe                                                                                     |
| Homepage URL              | https://osmnnl.github.io/hindsight/                                                                                  |
| Support URL               | https://github.com/osmnnl/hindsight/issues                                                                           |
| Privacy policy URL        | https://osmnnl.github.io/hindsight/privacy.html                                                                      |
| Single purpose            | See [`CWS-PRIVACY-FORM.md`](./CWS-PRIVACY-FORM.md) §1                                                                |
| Permission justifications | See [`CWS-PRIVACY-FORM.md`](./CWS-PRIVACY-FORM.md) §2 — matches the 1.0.0 manifest exactly                           |
| Data usage                | See [`CWS-PRIVACY-FORM.md`](./CWS-PRIVACY-FORM.md) §4–§5                                                             |

## Visual assets

Rendered from the real built extension by `scripts/store-shots.mjs`
(dev-only, not shipped). PNG, 24-bit, no alpha, flat colour only.

| Asset                   | Size       | File                                                                     |
| ----------------------- | ---------- | ------------------------------------------------------------------------ |
| Store icon              | 128 × 128  | `dist/icons/icon128.png`                                                 |
| Small promo tile        | 440 × 280  | `docs/promo/promo-440x280.png`                                           |
| Marquee promo tile      | 1400 × 560 | `docs/promo/promo-1400x560.png`                                          |
| Screenshots (5, 1 dark) | 1280 × 800 | `screenshot-{1..5}-*.png` in the script's `--out` folder (not committed) |
