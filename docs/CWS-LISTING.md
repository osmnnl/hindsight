# Chrome Web Store listing — v0.2.0 (unlisted beta)

> **⚠️ Superseded / historical.** This is the original v0.2.0 beta-submission
> working draft; the app is now at v0.7.4 and its side-panel / replay-bundle /
> sharing-hub features have shipped. For current store copy use
> [CWS-DESCRIPTION.md](./CWS-DESCRIPTION.md). The CI zip-naming (§ near top)
> and permission-justification table below still match `manifest.json`; the
> feature/roadmap prose does not and should be rewritten before the next
> submission.

Working document for the first CWS submission. Unlisted means the
extension is installable by anyone with the link but won't surface
in store search results — the right mode for the closed beta per
OQ-3 and PRD §18.8.

The actual submission is a user-driven step (Chrome Web Store
developer dashboard, requires the developer account holder to
sign in). This file holds the copy + checklist so the submission
takes minutes, not hours.

---

## Submission package

CI produces `hindsight-${VERSION}-${SHORT_SHA}.zip` on every push as
the **`hindsight-cws-zip-${SHA}`** artifact. Download that, upload
to the developer dashboard. Don't zip `dist/` manually — the CI
artifact has the right shape (zip-of-contents, not zip-of-folder).

---

## Store listing — fields to fill

### Title

`Hindsight — Bug capture without DevTools`

### Short summary (132 char cap)

> DevTools you didn't open. Captures fetch/XHR, console errors,
> clicks, navigation — share a complete bug report in one click.

(Comes in just under the cap.)

### Detailed description

```
Hindsight silently records what happens in your browser — every
network request, console error, click, form input, and page
navigation — so when something breaks, you can scrub back through
exactly what happened and share a complete bug report with one
click.

Built for QA testers, developers, support agents, product managers,
and the rest of us who hit a bug at the worst possible moment.

WHY HINDSIGHT
• No SDK, no signup, no server. Works on any website.
• Open source under MIT — auditable end to end.
• Captures your past activity, not just the next bug.
• Single-file HTML replay export (coming in M4) — your recipient
  needs nothing installed.

WHAT IT CAPTURES
• Network requests (fetch, XMLHttpRequest, WebSocket frames)
• Console errors, warnings, unhandled rejections
• Page navigations (real + SPA / pushState / hashchange)
• Clicks and form input changes
• User-configurable custom regex masking + per-domain blocklist

PRIVACY-FIRST BY ARCHITECTURE
• No backend. No telemetry. The extension makes zero outbound
  requests of its own — webhook posts, web intents, and file
  downloads are always user-initiated.
• Sensitive headers (Authorization, Cookie, Set-Cookie, X-API-Key,
  X-Auth-Token, Proxy-Authorization) masked at capture time.
• Body patterns for credit-card numbers (Luhn-validated) and
  Turkish national IDs (checksum-validated) masked at capture time
  with no false-positive sprawl.
• Password and credit-card-autocomplete form fields masked at the
  DOM site — the value never leaves the page-world unmasked.
• The original value is never written to storage — masking is
  irreversible.

WHAT'S COMING
• M3: chrome.sidePanel migration, visual timeline scrubber,
  screenshot capture on error, detection rule engine.
• M4: standalone HTML replay bundle, recording mode, multi-
  destination sharing (Slack / Discord / Teams / GitHub / Linear /
  email / Notion).
• M5: Chrome Web Store full launch.

AI / LLM features are explicitly deferred to v2+. This release
ships zero AI calls.

Source code, full PRD, and roadmap:
[REPO URL — fill in when repo goes public]

License: MIT.
```

### Category

Primary: **Developer Tools**
Secondary: **Productivity**

### Language

English (primary). Turkish translation lands at v0.3+.

---

## Permissions — justification text

The CWS reviewer asks for a per-permission justification. Mirror
PRD §12.2 exactly so the audit trail is clean.

| Permission                   | Justification                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                    | Persist captured events across browser sessions in `chrome.storage.local`. Required for the per-tab event buffer and the closed-tab archive (7-day TTL). |
| `unlimitedStorage`           | Allow long captures and the closed-tab archive without hitting Chrome's 10 MB quota. Storage is local-only — see privacy policy.                         |
| `activeTab`                  | Inject content scripts only on the user-activated tab when host permissions are not granted.                                                             |
| `scripting`                  | Required API for Manifest V3 content-script injection.                                                                                                   |
| `sidePanel`                  | Primary UI surface for the M3 visual timeline (declared now, populated in v0.3).                                                                         |
| `notifications` (optional)   | Surface detected failures (network errors, console errors) via the system notification channel. Opt-in only.                                             |
| `downloads` (optional)       | Save HAR / JSON exports the user explicitly triggers.                                                                                                    |
| `tabs` (optional)            | Read tab metadata for the per-tab session model.                                                                                                         |
| `webNavigation` (optional)   | Detect page navigations to mark document boundaries.                                                                                                     |
| `<all_urls>` (optional host) | Capture on every site when the user enables "capture on all sites" in settings. Otherwise activeTab-only.                                                |

---

## Privacy policy

Required field. One-page text — hosted at `hindsight.dev/privacy`
after the repo + site go public, mirrored at the GitHub Pages
equivalent.

Working draft:

```
HINDSIGHT PRIVACY POLICY

Hindsight does not collect, transmit, store, or sell any user data
outside of the user's own browser.

WHAT WE CAPTURE
Hindsight captures network requests, console messages, user actions,
and navigation events from the tabs you visit while the extension
is active. All capture data is stored in chrome.storage.local on
your own machine.

WHAT WE DO NOT DO
• We do not have a backend. There is no server-side component to
  Hindsight.
• We do not send telemetry of any kind. The extension makes zero
  outbound network requests except those you explicitly initiate
  (webhook posts, web intents, file downloads).
• We do not have analytics. We learn how Hindsight is doing through
  Chrome Web Store metrics that Google provides — Google's terms
  govern that data, not us.
• We do not run AI / LLM features in v1. AI integration is deferred
  to a future major version and will be opt-in if it ships.

SENSITIVE DATA HANDLING
Sensitive request and response data is masked AT CAPTURE TIME —
before it is written to storage — using built-in patterns for
common auth headers, credit cards, and Turkish national ID
numbers, plus any custom regex patterns you configure. The original
value is irreversibly replaced with the literal string
"***MASKED***" and cannot be recovered.

YOUR RIGHTS
• Export everything: Settings → Privacy → "Export all my data"
  (lands in v0.3 alongside the side panel).
• Delete everything: chrome://extensions → Hindsight → Remove.
• Opt out of any specific origin: Settings → Privacy → "Never
  capture on these origins".

CONTACT
GitHub issues at [REPO URL] are the primary support channel. For
sensitive disclosures, email [PROJECT EMAIL].

Last updated: 2026-05-21
```

Repo URL and project email get filled in at public-push time.

---

## Screenshots — five at 1280×800

CWS requires up to five screenshots. Plan:

1. **Popup with mixed timeline** — a tab with 3-4 events (one
   failed network, one click, one console.error, one navigation),
   bulk-bar showing "X events · 1 error · 2 network".
2. **Detail view with Privacy panel** — failed network event with
   the redactions list expanded, showing "1 × Authorization
   masked".
3. **Settings → Privacy** — default rule chips visible, one
   custom pattern in the editor, two origins in the blocklist.
4. **Settings → Capture** — Tier 2 toggle, buffer cap dropdown.
5. **HAR export in DevTools** — a downloaded `.har` opened in
   Chrome DevTools Network panel, masked Authorization header
   visible.

All screenshots: light theme (broader appeal), Chrome on macOS
(canonical CWS aesthetic), no real-user data in any frame.

---

## Submission checklist

Before clicking "Submit for review":

- [ ] Bumped `manifest.json` `version`.
- [ ] CI green on the commit being submitted; downloaded the matching
      `hindsight-cws-zip-${SHA}` artifact.
- [ ] Privacy policy text published at a public URL.
- [ ] Five screenshots saved at 1280×800.
- [ ] Permissions justifications pasted in.
- [ ] Visibility set to **Unlisted** (not Public).
- [ ] Distribution: This item is not designed primarily for children.
- [ ] Single-purpose statement filled in
      ("Capture browser activity so users can share complete bug
      reports without DevTools").

After submission:

- Review SLA is "1–3 business days" but in practice ranges from
  hours to a couple of weeks. Don't promise a launch date until
  approval lands.
- Repo public-push timing per OQ-3: separate user-driven step,
  not bundled with this submission.

---

## When this graduates

The next iteration of this doc — for the v1.0 public launch (M5) —
flips visibility to **Public** and adds:

- A promotional video (60-second self-recorded; PRD §17.2).
- A 440×280 promotional tile (CWS featured-launch attempt).
- Updated screenshots covering the side panel + replay bundle UI
  introduced in M3/M4.
- Localized listings for English + Turkish.
