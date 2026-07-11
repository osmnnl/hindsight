# Hindsight — CWS description (EN)

Copy-paste source for the **Chrome Web Store → "Description"** field
(`16,000` char limit, plain text only — CWS does not render markdown
inside this field, but URLs auto-link). Total: ~2,800 characters.

The line between the `--- COPY BELOW ---` and `--- END COPY ---`
markers is the literal text to paste. Everything else in this file
is editor commentary.

---

--- COPY BELOW ---

Hindsight is the DevTools you forgot to open.

It runs quietly in the background and records every network request, console error, user action, and screenshot. When something breaks, you scrub back through time and ship a faithful bug report without re-running anything.

WHY IT EXISTS

You hit a bug. You jump to DevTools. You refresh. The error doesn't happen again. The XHR you needed has scrolled out of the panel. You couldn't open DevTools fast enough.

Hindsight is always on. By the time you realise something interesting happened, the evidence is already captured.

WHAT IT CAPTURES

• Network: fetch, XMLHttpRequest, WebSocket, SSE — full request and response with headers and bodies
• Console: error, warn, info, plus unhandled rejections and uncaught errors with stack traces
• User actions: clicks, form inputs (passwords always masked), SPA route changes
• Screenshots on error: a single JPEG at the moment of the failed request
• Performance signals: long tasks over 100 ms, cumulative layout shift, white-screen heuristic
• Recording mode: explicit Record / Stop adds cursor trail, scroll, and 2-second screenshots

THE KILLER FEATURE — SHARE WITHOUT SETUP

One click saves the entire session as a single self-contained HTML file. Your teammate drags it into any browser tab and sees the whole story — scrubber, narrative, request/response panels — with no extension, no service, no login. Works offline.

The same payload also flows into Slack, Discord, Microsoft Teams webhooks, GitHub Issues, mailto drafts, JSON downloads, HAR exports, cURL commands, and ZIP archives. Size-aware formatters truncate gracefully when the destination has paste limits.

PRIVACY-FIRST BY DESIGN

• Zero outbound network requests except ones you explicitly initiate
• No telemetry. No analytics. No tracking pixels. No third-party SDKs
• Sensitive headers (Authorization, Cookie, X-API-Key, X-Auth-Token, Proxy-Authorization, Set-Cookie) are masked at capture time, before being written to local storage — the original values are never persisted, so they cannot leak through a future bug or compromised machine
• Built-in body pattern masking for credit cards (Luhn-validated) and Turkish national IDs (TCKN with checksum)
• Form-field masking for password inputs and credit-card autocomplete
• Custom regex patterns you define in Settings → Privacy
• Disable individual rules per future capture when you genuinely need raw values for your own debugging

A privacy preview modal shows the exact event count, redaction summary, and destination identity before every send.

KEYBOARD-FIRST INSPECTION

• Side panel scrubber with a dual-handle range filter — clip both edges of the timeline
• Filter chips: Failed / API only / All
• Live full-text search across event type, URL, and body
• Host picker to focus on a single origin
• Cluster banners group repeated failures into one summary row
• "Replay this request" button re-fires a captured request from the extension context

ZERO SETUP

Install, pin the icon, browse normally. Defaults work the moment you load. Settings exist for power users.

Languages: English, Türkçe.

PERFORMANCE

The capture path is gated by hard CI benchmarks.
• fetch overhead p95: 0.012 ms
• XHR overhead p95: 0.001 ms
• Filter 1000 events: 0.25 ms p95
• Outbound requests: 0
• Bounded capture: a byte-capped per-tab rolling buffer keeps memory and
storage in check across 20+ active tabs — verified by a real-Chromium
multi-tab stress gate.

Your browser doesn't notice it's there.

OPEN SOURCE — MIT LICENSED

Every claim about privacy or behaviour is verifiable by reading the source. Issues, feature requests and contributions welcome.

LINKS

Website → https://osmnnl.github.io/hindsight/
GitHub → https://github.com/osmnnl/hindsight
Privacy → https://osmnnl.github.io/hindsight/privacy.html
Issues → https://github.com/osmnnl/hindsight/issues
Releases → https://github.com/osmnnl/hindsight/releases
Changelog → https://github.com/osmnnl/hindsight/blob/main/CHANGELOG.md

OTHER EXTENSIONS BY THE SAME AUTHOR

StorageNinja → https://osmnnl.github.io/StorageNinja/
TestDataHelper → https://osmnnl.github.io/TestDataHelper/

--- END COPY ---

---

## Field reference (the form will also ask for these)

| CWS field                 | Value                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package title             | `Hindsight`                                                                                                                                                                                                                                                               |
| Package summary           | `DevTools you didn't open. Privacy-first passive capture for bug reports.`                                                                                                                                                                                                |
| Category                  | Developer Tools                                                                                                                                                                                                                                                           |
| Language                  | English (primary), Türkçe (additional)                                                                                                                                                                                                                                    |
| Homepage URL              | https://osmnnl.github.io/hindsight/                                                                                                                                                                                                                                       |
| Privacy policy URL        | https://osmnnl.github.io/hindsight/privacy.html                                                                                                                                                                                                                           |
| Support URL               | https://github.com/osmnnl/hindsight/issues                                                                                                                                                                                                                                |
| Single purpose statement  | "Capture browser activity (network requests, console messages, user actions, screenshots) in the background so the user can review and share a faithful bug report when something breaks. All data stays on the user's device unless they explicitly hit a Share button." |
| Permission justifications | See [`CWS-MEDIA-CHECKLIST.md`](./CWS-MEDIA-CHECKLIST.md) — copy-paste table                                                                                                                                                                                               |
| Privacy practices         | "I have a clear and accurate privacy policy"                                                                                                                                                                                                                              |

## Visual assets

- Icon 128×128: `dist/icons/icon128.png`
- Small promo tile 440×280: `docs/promo/promo-440x280.png` (generated, not committed)
- Marquee tile 1400×560: `docs/promo/promo-1400x560.png` (generated, not committed)
- Product screenshots 1280×800: capture per `CWS-MEDIA-CHECKLIST.md` (4 surfaces)

## Notes for whoever pastes this

- Do NOT include the `--- COPY BELOW ---` / `--- END COPY ---` markers themselves.
- The bullet character is `•` (U+2022). CWS preserves it as-is.
- URLs at the end of the description become clickable in the listing.
- The "OTHER EXTENSIONS" section cross-promotes the author's other tools.
  Remove it if you'd rather keep the listing single-product.
