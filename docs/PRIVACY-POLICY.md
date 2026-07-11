# Hindsight — Privacy Policy

**Last updated:** 2026-05-25
**Applies to:** Hindsight Chrome extension v0.5.x and later

---

## Plain-English summary

Hindsight is a Chrome extension that records what happens in your
browser — network requests, console messages, clicks, screenshots —
so you can scrub back through time and share a faithful bug report
when something breaks.

- **Everything stays on your machine** by default. The extension has
  no backend. It does not phone home, does not collect telemetry,
  does not contain analytics SDKs, and does not run a marketing
  pixel.
- **No data leaves your device until you explicitly choose to share
  it** — by clicking "Send to Slack," typing a webhook URL,
  downloading a JSON file, or pasting a report into another app.
- **Sensitive data is masked at capture time, not at export time.**
  Authorization tokens, cookies, passwords, credit-card numbers,
  Turkish national IDs, and any pattern you configure are replaced
  with `***MASKED***` _before_ they're written to your local
  storage. The original values are never written down, so they
  cannot leak through a future bug or a compromised machine.
- **You can disable individual masking rules** if you genuinely want
  the raw value in your own captures (e.g. you're debugging an auth
  flow on your own system). Disabling is per-rule, per-future-
  capture, and clearly warned about.

That's the whole story. The sections below spell it out in detail
for compliance, legal, and security reviewers.

---

## 1. What we collect

When Hindsight is installed and enabled, the extension's content
scripts run inside the web pages you visit and the service worker
processes the resulting events. Hindsight captures:

| Category              | Default      | Detail                                                                                                                                                  |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network requests      | On           | Method, URL, request headers, request body, response status, response headers, response body, timing. Sensitive headers and bodies are masked (see §3). |
| Console messages      | On           | Level (error / warn / info / unhandled), message, stack trace.                                                                                          |
| Navigation events     | On           | From-URL, to-URL, transition type.                                                                                                                      |
| Clicks                | On (Tier 2)  | Element tag, accessible name, position. Not the actual click coordinates of every cursor move.                                                          |
| Form input changes    | On (Tier 2)  | Field name and type. Password inputs and credit-card autocomplete fields are always masked.                                                             |
| Screenshots on error  | On (Tier 3)  | JPEG of the visible tab at the moment of error capture. At most one screenshot per tab per 2 seconds.                                                   |
| Performance signals   | On (Tier 3)  | Long tasks > 100 ms, cumulative layout shift.                                                                                                           |
| Cursor / scroll trail | Off (Tier 4) | Captured only while Recording Mode is explicitly active. Stops the moment you stop recording.                                                           |
| Periodic screenshots  | Off (Tier 4) | 2-second JPEGs, recording mode only.                                                                                                                    |

All categories above are toggleable in **Settings → Capture**
(except Tier 1, which is the bare minimum for the extension to
function).

## 2. Where it goes

**Everything is stored in `chrome.storage.local` on your own
device.** That's it. There is no Hindsight server. The repository
that builds the extension is public and you can verify this
yourself — every line of code that touches `fetch()` or
`chrome.runtime.sendMessage` is in the open.

Specifically:

- The extension has **no `host_permissions` for any analytics or
  CDN endpoint** — only `<all_urls>` as an _optional_ permission,
  requested at feature activation time, used to intercept the
  network requests of pages _you_ visit.
- The service worker makes **zero outbound HTTP requests** of its
  own. The only fetch() calls originate from explicit user actions:
  - You configured a Slack / Discord / Teams webhook URL in
    Settings → Sharing **and** clicked "→ Send" on a captured
    event, OR
  - You clicked the "↻ Replay this request" button in the side
    panel, which re-fires _that specific captured request_ from
    the extension context (without your real cookies — see §3).

## 3. Sensitive data — capture-time masking

Hindsight's first brand promise is "your data does not leave your
machine unless you choose." Its second is "no lossy cleanup" — we
never denoise or summarize captures, though explicit size caps do
apply (see §4). Masking and the caps are in tension when a captured
request contains an
`Authorization: Bearer …` header — the user wants to know the
request happened but doesn't want the bearer token sitting on disk.

We resolve the tension by masking sensitive values **at capture
time, before the event is written to storage**:

- Built-in header masking: `Authorization`, `Cookie`, `Set-Cookie`,
  `X-API-Key`, `X-Auth-Token`, `Proxy-Authorization`.
- Built-in body pattern masking: Turkish national ID (TCKN, with
  checksum), credit-card numbers (Luhn-validated 13–19 digit
  sequences).
- Built-in form-field masking: `<input type="password">`,
  `<input autocomplete="cc-*">`, fields named `password` /
  `secret` / `token` / `ssn` / `pin`.
- User-defined body patterns: any regex you add in **Settings →
  Privacy → Custom body patterns**.

When a rule matches, the value is replaced with the literal string
`***MASKED***` before being persisted. The original value is
**never** written to `chrome.storage.local`, never written to the
event JSON, never embedded in the screenshot, never copied into the
HAR export, and never included in any share payload.

Mask cannot be reversed — there is nothing to reverse to. If you
notice after the fact that you wish you had captured the raw
Authorization token (e.g. while debugging your own application),
you can disable the relevant rule in **Settings → Privacy → Default
rules** and re-capture the request. The disable is per-rule,
per-future-capture, and the Settings page warns explicitly:
"Captures recorded with a rule disabled will store the matched
value verbatim on your machine and include it verbatim in any bug
report you share."

## 4. Capture limits and the archive

Everything is stored on your machine, so Hindsight bounds how much it
keeps — an unbounded buffer across many tabs would slow the browser and
crash the extension. These are stability/storage limits, separate from
masking (§3): a value over a cap is cut at a fixed length with a visible
`…[truncated]` marker (never silently dropped), and the per-tab buffer is
a **rolling window** — the oldest events age out, and any report or replay
bundle you export notes how many earlier events were omitted.

- **Request/response body:** 200 KB each.
- **Form-input value / console argument:** 10 KB each.
- **Per-tab live buffer:** the most recent 200 events (raise to 2000 in
  Settings) and 2 MB, whichever is reached first.
- **Closed-tab archive:** when you close a tab, its captures move into a
  rolling archive (`chrome.storage.local`) of the **30 most recent
  sessions**, each kept for **7 days**. Entries past either bound are
  swept at service-worker startup. You can clear it manually (sidepanel →
  recents → Clear archive) or reset everything (Settings → Advanced →
  Reset everything).

## 5. Sharing — what we send when you click "Send"

When you explicitly hit a share button:

- **Webhook destinations (Slack / Discord / Teams):** the configured
  HTTPS URL is contacted with a JSON payload containing the
  formatted bug report (markdown text). The payload comes
  from the already-masked event stored locally — no extra data is
  collected at send time.
- **Web intents (GitHub Issue, mailto):** a new browser tab is
  opened to the destination URL with a pre-filled body. The browser
  itself navigates; Hindsight does not POST anything. Once the tab
  opens, you control what's submitted.
- **Replay bundle download:** a single `.html` file is written to
  your computer via `chrome.downloads`. Nothing is uploaded.
- **ZIP export:** same — local file write only.
- **Copy to clipboard:** the formatted report is placed on your
  system clipboard. Nothing leaves the machine until you paste.

You see a confirmation dialog ("Privacy preview modal") before
every send. The dialog shows the exact event count, the per-rule
redaction summary, and the destination identity, so you can
verify what's about to leave the machine.

## 6. Replay requests

The "↻ Replay this request" button in the network detail view
re-fires a captured request from the extension's own context. We
explicitly call `fetch(..., { credentials: 'omit' })` and skip any
header whose stored value is `***MASKED***`. This is deliberate:
the page's cookies are not Hindsight's to send, and we won't
forward a literal `***MASKED***` string as a token. Replayed
requests often return 401 / 403 — that's the expected behaviour
and the result panel labels it clearly.

## 7. Permissions — why we ask for each one

| Permission               | Reason                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                | Read and write the local capture buffer.                                                                                             |
| `unlimitedStorage`       | Allow buffers larger than 5 MB on heavy-browsing days.                                                                               |
| `activeTab`              | Inspect the tab the user is actively looking at without a permanent broad permission grant.                                          |
| `scripting`              | Inject the content scripts that observe `fetch` / `XMLHttpRequest` / `console`.                                                      |
| `sidePanel`              | Open the primary inspection UI.                                                                                                      |
| `notifications` (opt-in) | Surface "failure cascade" desktop notifications. Requested only when the user enables that toggle in Settings → Detection.           |
| `downloads` (opt-in)     | Save the replay-bundle `.html` and ZIP exports to disk.                                                                              |
| `tabs` (opt-in)          | Read tab metadata for sidepanel + popup display.                                                                                     |
| `webNavigation` (opt-in) | Detect SPA route changes and reload events to draw navigation lines on the timeline.                                                 |
| `<all_urls>` (opt-in)    | Run the content script on the user's page so request interception works. Without this, the only captures available are console logs. |

Permissions marked "opt-in" are listed in `optional_permissions` /
`optional_host_permissions` in the manifest and are requested only
when you enable the corresponding feature.

## 8. Telemetry — none

Hindsight collects no usage data, no error reports, no diagnostic
pings. There is no Sentry, no Google Analytics, no Mixpanel, no
Amplitude, no Segment, no in-house event pipeline. The codebase
contains zero `fetch()` calls to any Hindsight-owned domain.

If we ever change this — for any reason — we will require explicit
opt-in via a new Settings checkbox before any data leaves your
device, and we will update this policy first.

## 9. Cookies — none

Hindsight does not set cookies. It does not store cookies on any
external site. It reads the `Cookie` request header of pages you
visit only to mask its value (see §3) before persisting the network
event locally.

## 10. Third-party services

The extension itself ships with no third-party services bundled.
At runtime, optional features touch the URLs you configure:

- A webhook URL **you typed** in Settings → Sharing. The data
  Hindsight sends to that URL is identical to what you see in the
  Privacy preview modal. We do not share your webhook URL with
  anyone; it lives in `chrome.storage.local`.
- A `mailto:` URI **you typed**, opened by your operating system's
  default mail handler. Hindsight does not have access to the email
  draft once it leaves the browser.

## 11. Children's privacy

Hindsight is a developer tool. It is not marketed to children and
does not knowingly capture data from children. If you are using it
on a device shared with a minor, the extension's behaviour is
identical regardless of who's typing — but you should disable it
while the device is in their hands.

## 12. Changes to this policy

We will update this document in the same Git commit that lands the
behavioural change. The "Last updated" date at the top reflects the
most recent edit. Material changes will also be called out in the
extension's CHANGELOG.

## 13. Contact

Hindsight is open source. Bug reports, privacy questions, and
disclosure of vulnerabilities should go to the project's GitHub
repository.

---

_Hindsight is published under the MIT license. The source code is
the canonical proof of what the extension does — every claim in
this policy is verifiable by reading it._
