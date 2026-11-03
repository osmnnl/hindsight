# Microsoft Edge Add-ons — listing, EN

Partner Center → Microsoft Edge → Extensions → Hindsight. Upload the
same zip as Chrome (`hindsight-1.0.0-<sha>.zip` from CI): Edge runs
Chrome MV3 packages unchanged, including `chrome.sidePanel`.

## Properties

| Field                   | Value                                                 |
| ----------------------- | ----------------------------------------------------- |
| Category                | Developer tools                                       |
| Privacy policy required | Yes — https://osmnnl.github.io/hindsight/privacy.html |
| Website                 | https://osmnnl.github.io/hindsight/                   |
| Support contact         | https://github.com/osmnnl/hindsight/issues            |
| Mature content          | No                                                    |

## Store listing (English)

**Description** (250 – 10,000 characters): paste
[`../cws/description-en.txt`](../cws/description-en.txt) unchanged.

**Short description:**

```
DevTools you didn't open. Privacy-first passive capture for bug reports.
```

**Search terms** (up to 7, each ≤ 30 characters):

```
bug report
network logger
console errors
devtools
session replay
qa testing
har export
```

**Images:** store logo `store-logo-300x300.png`, small promotional tile
`small-tile-440x280.png`, large promotional tile `marquee-1400x560.png`,
screenshots `screenshot-1` … `screenshot-5` (1280 × 800).

## Notes for certification

```
Hindsight is a passive, local-only bug recorder. No account or test credentials are needed.

To test: open any website that makes network requests (for example https://httpbin.org/status/500 in one tab and any news site in another), click the Hindsight toolbar icon, then "Open side panel". Click a request to see headers and bodies. Press "Bundle" to save a single HTML replay file and open it.

Permissions: content scripts match all sites because recording must already be running when a page breaks; they make no requests. The optional host permission is requested for one origin only when the user presses Replay. No remote code, no telemetry.
```
