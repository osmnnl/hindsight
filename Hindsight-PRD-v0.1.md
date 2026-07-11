# Hindsight — Product Requirements Document

**Version:** 0.1 (Foundation Draft)
**Date:** May 2026
**Status:** Ready for development planning
**Author:** Osman (product) + iterative spec work

---

## 0. Executive Summary

Hindsight is a privacy-first, open-source Chrome extension that silently records browser activity — network requests, console messages, user actions, and visual snapshots — so that when something breaks, users can scrub back through time and capture a complete, shareable record of what happened. No SDK, no signup, no server, no cost.

The product targets the moment that's universal across QA testers, developers, customer support agents, product managers, and end-users alike: *"Something just broke. I wish I had DevTools open."* Hindsight is the DevTools you didn't open.

The killer differentiator is a **standalone HTML replay bundle**: every captured session can be exported as a single, self-contained HTML file that, when opened in any browser, presents an interactive scrubbing timeline with synchronized network, console, action, and screenshot panels. No login, no service, no installation required by the recipient. This is genuinely novel in the free, no-SDK category.

This PRD defines the v1.0 scope, technical architecture, privacy commitments, and roadmap. AI/LLM integration is intentionally deferred to v2+ (separate plan exists).

---

## Part A — Product Vision

## 1. Problem Statement

### 1.1 The Bug Reporting Gap

When something goes wrong in a web application, the people most likely to encounter it — non-technical end users, QA testers, customer support agents — are the least equipped to capture useful diagnostic information. They cannot open DevTools, cannot inspect network calls, cannot read console errors. The result is the well-worn user-vs-engineer dance:

- User: *"It just didn't work."*
- Engineer: *"Can you reproduce it?"*
- User: *"I don't know what I did."*
- Engineer: *"Did you see any errors?"*
- User: *"There was a popup, I think."*

This loop is expensive. According to common industry estimates, the average cost of resolving a bug increases 5–10x for each stage of context loss. By the time a bug report reaches engineering, critical context has evaporated.

### 1.2 Why Existing Solutions Fall Short

| Category | Examples | Why they don't solve this |
|---|---|---|
| Built-in DevTools | Chrome DevTools | Requires technical knowledge, must be open *before* the bug, output not shareable |
| SDK-based session replay | LogRocket, FullStory, Sentry | Requires SDK install on every site; cost-prohibitive for individuals; captures only sites with SDK integrated |
| Paid bug reporters | Bird Eats Bug, Userback, BugHerd | Subscription model ($29–$99/user/month); SDK on target site required; vendor lock-in |
| Manual screenshots | OS screenshot tools | No network/console/action context; no time dimension |
| HAR file export | DevTools "Save all as HAR" | Requires DevTools to have been open during the bug; HAR is verbose and hard to read; static |

There is no tool that is simultaneously: free, requires no SDK, works on any website, captures past activity passively, and produces shareable artifacts without requiring the recipient to use the same tool.

### 1.3 The Specific Moment We Serve

Hindsight serves a precise moment: **the 30 seconds after a user realizes something is wrong**. In that window, the user wants to:

1. Confirm what they saw was real
2. Capture evidence of what happened
3. Send it to someone who can help
4. Stop thinking about it and move on

Every design decision in Hindsight is optimized for that 30-second window.

## 2. Solution & Vision

### 2.1 What Hindsight Is

Hindsight is a Chrome extension that:

1. **Passively records** browser activity in the background — every fetch/XHR, every console error, every user click, every form change, every page navigation, plus periodic page screenshots at moments of interest.
2. **Detects anomalies** automatically (failed requests, errors, slow operations, error cascades) and surfaces them via a non-intrusive badge and optional notification.
3. **Provides a time-travel UI** through a side panel: a scrubbable timeline that, at any point, shows the synchronized state of network, console, user actions, and visual page state.
4. **Exports to multiple destinations** with zero configuration: clipboard, Slack/Discord/Teams via webhooks, GitHub/GitLab/Linear via web intents, email via `mailto:`, files via download.
5. **Produces self-contained replay bundles**: a single HTML file containing the entire recorded session plus an embedded interactive viewer.

### 2.2 Vision Statement

Within two years, Hindsight will be the default tool that anyone — technical or not — reaches for when they need to report a bug, complete with all the context engineers actually need, without compromising privacy or requiring any account, server, or subscription.

### 2.3 What Success Looks Like

- A non-technical user reports a bug to a vendor's support team and includes a Hindsight bundle. The vendor's engineer opens the HTML file, scrubs to the failure moment, and immediately understands the issue without follow-up questions.
- A QA tester at any company replaces ad-hoc screenshot-and-describe workflows with structured Hindsight reports that reduce bug-resolution cycles by 50%+.
- An open-source developer receives a perfect bug report — with network traces, console errors, and reproduction steps — from a user they've never met, against a website they don't control.

---

## 3. Target Users & Personas

### 3.1 Primary Personas

**Persona A — Aylin, the QA Tester** *(Datasoft-style enterprise QA)*
- Role: Tests internal SaaS applications daily, files dozens of bugs per week.
- Pain: Engineering frequently asks for "more info" because her bug reports lack network/console context.
- Adoption trigger: A colleague shows her how Hindsight auto-captures the failed request.
- Daily usage: 5–20 captures, 3–8 sends to Slack/Jira.

**Persona B — Mehmet, the Developer** *(integration debugging)*
- Role: Backend dev debugging frontend-reported issues.
- Pain: Frontend says "the API is broken," but he can't reproduce until he gets the actual request.
- Adoption trigger: Tired of asking frontend devs to "open Network tab and try again."
- Daily usage: Occasional but high-value — usually when integration-debugging.

**Persona C — Selin, the Product Manager** *(quality bridge)*
- Role: Triages customer-reported bugs, reproduces them, files engineering tickets.
- Pain: Customers describe bugs in plain English; she translates to engineering specifications.
- Adoption trigger: Tired of being a slow human translator between users and engineers.
- Daily usage: 2–5 captures per day during triage sessions.

**Persona D — Defne, the Power User** *(reporting to vendors)*
- Role: A non-engineer who uses many SaaS products and occasionally hits bugs.
- Pain: Vendor support asks for "browser console screenshot" — she doesn't know what that is.
- Adoption trigger: A tweet about how to file better bug reports.
- Daily usage: Occasional — once a week or less, but each use is high-value.

**Persona E — Volkan, the Customer Support Agent** *(reproducing user reports)*
- Role: Tier-1 support, escalates technical bugs to engineering.
- Pain: Can't always reproduce the bug himself; engineering closes tickets as "cannot reproduce."
- Adoption trigger: Manager mandates better technical context in escalations.
- Daily usage: Per-ticket basis, sometimes 10+ uses per shift.

### 3.2 Excluded Personas (v1 Non-Targets)

- **Production monitoring engineers** — they need server-side instrumentation, not browser extensions.
- **Security researchers / penetration testers** — they need request modification, not capture; different tool category.
- **Marketing/UX researchers** — they need session replay with video; Hindsight is more diagnostic than behavioral.

---

## 4. Brand Promises

Hindsight makes three explicit commitments. Every feature, every design decision, every line of code is testable against these. If a feature violates one of these, it should be reconsidered, deferred, or made opt-in with prominent disclosure.

### 4.1 "No lossy cleanup"

Captured data is stored as-is. We do not denoise, re-order, or "smartly summarize" captures, and the only value altered on the way in is a masked field (§11.2).

We do, however, apply **explicit, documented size caps at capture time** — required for pipeline stability, bounded local storage, and to keep a single service worker from crashing under many active tabs (see §13.2). These are not "smart" truncation: a value above a cap is cut at a fixed length with a visible `…[truncated]` marker (never silently dropped or altered), and the per-tab buffer is a bounded **rolling window** — the oldest events age out, they are not summarized. Exports report how many earlier events the window omitted, and may truncate further only for hard destination limits (e.g., Slack's paste cap).

**Capture-time caps (v0.7.x):**

| Cap                       | Value                                     | Applies to                          |
| ------------------------- | ----------------------------------------- | ----------------------------------- |
| Body cap                  | 200 KB (`BODY_CAP`)                       | each request / response body        |
| Input value cap           | 10 KB (`INPUT_VALUE_CAP`)                 | a form field's value per keystroke  |
| Console arg cap           | 10 KB (`CONSOLE_ARG_CAP`)                 | each console argument               |
| Per-tab rolling buffer    | 200 events (configurable → 2000) **and** 2 MB (`BYTE_CAP_PER_TAB`), whichever hits first | live buffer per tab |
| Closed-tab archive        | 30 sessions (`ARCHIVE_MAX_SESSIONS`), 7-day TTL | archived (closed) sessions      |

**Why this matters:** A bug report that hides a field makes engineers waste time hunting a phantom, so caps are generous (a 200 KB body is far larger than almost any real payload) and always visibly marked — never a silent edit that creates a false debugging signal. The rolling window means very long sessions keep their most recent activity; the export's "N earlier events omitted" note keeps that honest.

### 4.2 "Your data does not leave your machine unless you choose"

Hindsight has no backend. All data is stored in `chrome.storage.local`. No telemetry, no analytics, no error reporting, no "phone home." Outbound network traffic from the extension itself is exclusively user-initiated (webhooks, web intents, file downloads).

**Why this matters:** Privacy claims are credible only when they are architecturally enforced. Hindsight cannot spy on users because it has no server to spy *to*.

### 4.3 "Zero setup, zero config, useful from minute one"

A new installation is immediately functional. Default settings provide value without any configuration. Settings exist for power users but never gate basic usefulness.

**Why this matters:** The user opening Hindsight for the first time has a bug to report *right now*. They will not tolerate a 10-step setup wizard.

---

## 5. The Killer Differentiator: Portable Replay Bundle

This is the single feature that no competitor offers in the free, no-SDK category. It deserves dedicated specification.

### 5.1 What It Is

When a user exports a captured session as a "replay bundle," Hindsight produces **a single `.html` file** that contains:

- The complete recorded event timeline (network, console, user actions, page metadata)
- All captured page screenshots, embedded as base64 data URIs
- An embedded viewer application (HTML/CSS/JS) that renders the timeline interactively
- No external dependencies whatsoever

The file is typically 1–10 MB depending on session length and screenshot count.

### 5.2 The Recipient's Experience

The recipient receives the file via any channel — email attachment, Slack file, Linear attachment, USB stick. They double-click. Their default browser opens it. They see:

```
┌─ Timeline scrubber ─────────────────────────────────────┐
│ 14:30 ────●──────────●────────●●●●─────────────── 14:35 │
│           ↑          ↑        ↑                         │
│        page load   click    errors                      │
└─────────────────────────────────────────────────────────┘

┌─ Screenshot ──────────────┐ ┌─ Network ──────────────────┐
│                           │ │ POST /api/save 400 ⚠       │
│ [page at current scrub    │ │ GET  /api/list 200          │
│  position]                │ │ ...                         │
│                           │ │                             │
└───────────────────────────┘ └─────────────────────────────┘

┌─ Console ────────────────┐ ┌─ Actions ────────────────────┐
│ Error: Invalid date      │ │ 14:32:15 click "Save"        │
│ at ValidationForm.js:42  │ │ 14:32:14 input discharge_date│
│                          │ │ 14:32:00 navigate /edit/123  │
└──────────────────────────┘ └──────────────────────────────┘
```

The recipient drags the scrubber. All four panels update synchronously to show state at the scrubbed moment. They press `→` arrow keys to step through events. They search, filter, expand request bodies.

This works offline. It works on a coworker's laptop with no extension installed. It works in 10 years on whatever browser exists then, because it's pure static HTML.

### 5.3 Why This Is Defensible

- **SDK-based competitors** can show similar replay UI but require the recipient to log into their service. Hindsight requires nothing.
- **HAR file exports** are static and unreadable without specialized tools.
- **Video recordings** are large, non-interactive, and don't expose structured data.
- **Screenshot collections** lack temporal and causal context.

The portable HTML replay bundle is the simplest possible delivery mechanism — a single file — for the maximum diagnostic context. It is the format every team can adopt with zero friction.

### 5.4 Technical Constraints on the Bundle

- Total size budget: 10 MB max for typical session, 50 MB for "long recording" mode.
- Screenshots are JPEG-compressed at quality 0.7, max 1200×800.
- Bundle generation should complete in under 3 seconds for a 5-minute session.
- The embedded viewer JS must be self-contained, no CDN references.
- The viewer must work in Chrome, Firefox, Safari, and Edge (current stable versions).
- The viewer must be accessible (keyboard nav, screen reader compatible).

---

## Part B — Specification

## 6. Feature Specification

### 6.1 Capture System

The capture system is the foundation. It is the only feature that runs continuously, on every page, for every user. Performance and reliability are paramount.

#### 6.1.1 Capture Tiers

Captures are organized into tiers by overhead and value. Tier 1 and 2 are default-on; tiers 3 and 4 require explicit activation.

**Tier 1 — Essential (default on, cannot be disabled)**

| Event type | Mechanism | Notes |
|---|---|---|
| `fetch()` calls | Page-world content script monkey-patches `window.fetch` | Captures request URL, method, headers, body, response status, headers, body, timing |
| `XMLHttpRequest` calls | Page-world content script wraps the XHR prototype | Same fields as fetch |
| Console errors | Page-world `window.addEventListener('error', ...)` and `unhandledrejection` | Captures error message, stack trace, source location |
| Page navigations | Background `chrome.webNavigation.onCommitted` | Marks document boundaries |

**Tier 2 — Important (default on, user-toggleable)**

| Event type | Mechanism | Notes |
|---|---|---|
| Click events | Page-world `document.addEventListener('click', ...)` capture phase | Records target descriptor: tag name, accessible name (`aria-label`, text content), id, name, classes (limited), bounding rect |
| Form input changes | Page-world `input` event on `input`, `textarea`, `select` | Records field identity + value (with PII masking, see §11.2) |
| WebSocket frames | Page-world wraps `WebSocket` constructor | Captures connect, message direction + size, close — frame *content* is metadata-only unless user opts in |
| Console logs (info/warn) | `console.warn`, `console.info` wrapping | Default off; some users want, most don't |

**Tier 3 — Conditional (triggered, not continuous)**

| Event type | Mechanism | Notes |
|---|---|---|
| Page screenshots | `chrome.tabs.captureVisibleTab` from background | Triggered automatically on error/failure events; rate-limited to 1 per 2 seconds |
| Performance marks | Page-world `PerformanceObserver` | Long tasks (>50ms), layout shifts (CLS), navigation timing |
| Server-Sent Events | Page-world wraps `EventSource` | Connect/message/error events |

**Tier 4 — Recording Mode (explicit user opt-in)**

When the user clicks "Start Recording," additional heavy capture activates:

| Event type | Mechanism | Notes |
|---|---|---|
| Periodic screenshots | Every 2 seconds + on significant DOM changes | Higher frequency |
| Cursor position trail | `mousemove` throttled to 10Hz | Visualized in replay |
| Scroll position | Throttled `scroll` event | Reconstructs viewport over time |
| DOM mutation snapshots | `MutationObserver` on document body, diff-encoded | Heaviest; enables "see what changed" |
| Tab focus/blur | `visibilitychange` event | Knows when user was looking at page |

#### 6.1.2 Unified Event Model

All captures produce events conforming to this schema:

```typescript
interface CapturedEvent {
  id: string;                    // unique within session
  type: EventType;               // discriminator
  timestamp: number;             // unix ms, monotonic per session
  sessionId: string;             // per-tab session UUID
  sequenceNumber: number;        // ordering within session
  tabId: number;
  url: string;                   // page URL at time of event
  data: unknown;                 // type-specific payload, see below
  meta?: {
    redactions?: Redaction[];    // what was masked, where
    cascadeOf?: string;          // if this event is part of a detected cascade
    flags?: string[];            // e.g., "slow", "failed", "anomaly"
  };
}

type EventType =
  | 'network.fetch' | 'network.xhr' | 'network.websocket' | 'network.sse'
  | 'console.error' | 'console.warn' | 'console.info' | 'console.unhandled'
  | 'action.click' | 'action.input' | 'action.scroll' | 'action.focus'
  | 'navigation' | 'screenshot' | 'performance.longtask' | 'performance.cls'
  | 'recording.start' | 'recording.stop' | 'mutation' | 'cursor';
```

This uniformity enables:
- Single timeline rendering loop
- Unified filtering and search
- Single export format derivation
- Future plugin extensibility (third parties add new `EventType` values)

#### 6.1.3 Per-Tab Storage Model

Each tab has its own session and its own storage namespace.

- Key format: `session:{tabId}:events` → array of `CapturedEvent`
- Key format: `session:{tabId}:meta` → session metadata (start time, origin, user agent)
- Key format: `recording:{recordingId}` → user-initiated recordings (persisted independently from session buffer)
- Rolling buffer: 200 events per tab by default, configurable in settings up to 2000
- On tab close: session moved to "recent sessions" archive (kept for 7 days then evicted)
- On browser restart: archive persists; live session resets

Storage write strategy: events are batched and flushed every 250ms (or on tab close) to minimize I/O.

#### 6.1.4 Out-of-Scope Capture Sources (v1)

The following are deliberately not captured in v1:

- Service Worker fetches (different execution context; would require `chrome.webRequest` API with limited body access)
- Cross-origin iframe activity beyond what the top frame sees
- Browser extension traffic (other extensions' requests should not appear in user captures — this is correct behavior)
- WebRTC traffic (audio/video peer connections)
- Native messaging traffic

### 6.2 Detection System

Hindsight surfaces "moments of interest" via a rule engine. v1 ships built-in rules; v2 may expose user-configurable rules.

#### 6.2.1 Built-In Detection Rules

| Rule | Trigger | Surface |
|---|---|---|
| Failed request | `network.fetch` or `network.xhr` with status 0 or ≥400 | Red badge, optional notification |
| Console error | `console.error` or `console.unhandled` | Red badge |
| Slow request | Request duration > 3000ms | Yellow badge |
| Cascade auth failure | 3+ requests with status 401 within 10 seconds | Notification + cluster grouping |
| Generic cascade | 3+ failed requests to same origin within 10 seconds | Cluster grouping |
| Repeated identical failure | Same `method+url+status` failed 2+ times | Cluster grouping |
| Long task | Performance long task >100ms | Yellow badge (subtle) |
| White screen heuristic | After navigation, page body has <5 visible elements after 3s | Yellow badge, auto-screenshot |

#### 6.2.2 Surface Mechanisms

- **Toolbar icon badge**: number = count of "flagged" events not yet reviewed. Color reflects severity (green = none, yellow = warnings, red = errors).
- **Desktop notifications**: only for high-severity events (cascade, repeated failure). User can disable in settings. Default: on, but only first occurrence per session (de-duplicated).
- **Side panel highlights**: flagged events have a colored left border in the timeline.

#### 6.2.3 Cluster Grouping

When multiple events match a "cascade" pattern, the timeline displays them as a single grouped entry with an expand affordance. Example:

```
🔴 401 cascade — POST /Token/auth — 3 failures in 5s   [expand 3 →]
```

Expanding reveals the individual events. Sharing a cluster shares all events in it.

### 6.3 Timeline & Review UX

#### 6.3.1 Side Panel Layout

The side panel uses the `chrome.sidePanel` API (Chrome 114+) and is the primary interaction surface for sustained use. The popup is a quick-access surface.

The side panel is divided into four regions:

```
┌─ Header ─────────────────────────────────────────────┐
│  Hindsight  [●●●] [Filter] [All / Failed] [Clear]    │
├──────────────────────────────────────────────────────┤
│ Timeline (vertical, scrubber on left edge)            │
│  ▼ 14:32:18 🔴 POST /api/save 400 (412ms)             │
│      Body: { ... }    [details] [share]              │
│  ▼ 14:32:14 ⚪ click "Save" button                    │
│  ▼ 14:32:00 ⚪ navigate /employee/edit/123            │
│  ...                                                  │
├──────────────────────────────────────────────────────┤
│ Footer (sticky)                                       │
│  3 failed · 12 total · [Start Recording] [Send All]  │
└──────────────────────────────────────────────────────┘
```

#### 6.3.2 Detail View

Clicking a timeline entry opens a detail view for that event. For network events, this shows:

- Request: method, URL, headers (masked), body (faithfully preserved)
- Response: status, headers, body (faithfully preserved)
- Timing waterfall (request, response, total)
- Replay button (re-fire the request — see §6.3.5)
- Share button (per-event sharing)
- Annotate field (add a note)

For console errors: stack trace with source mapping if available.

For user actions: target element descriptor, value (if input), surrounding context.

#### 6.3.3 Visual Timeline Scrubber (v1.x — Milestone 3)

A visual timeline at the top of the side panel shows event density over time:

```
   ▁▁▂▃█▄▂▁▁▁▁▁▃▂▁▁▁▁▁▁▁█▆▃▁
   |________|_______|_______|
  -5m      -3m     -1m     now
```

- Hover: tooltip with summary at that moment
- Click: timeline list scrolls to that moment, "playhead" marker shows scrubbed position
- Drag: continuous scrub; multiple panels (screenshot, network, console, actions) update synchronously

Keyboard navigation:
- `←` / `→`: previous/next event
- `Shift+←` / `Shift+→`: jump 10 events
- `,` / `.`: frame-by-frame (each event individually)
- `Space`: play/pause auto-scroll forward at 1x real-time

#### 6.3.4 Filtering & Search

- Toggle chips: [Network] [Errors] [Actions] [Console] [Screenshots] [Recording-only]
- Status filters: [All] [Failed (4xx/5xx)] [Errors only]
- Text search: substring match on URL, error message, action target
- URL pattern filter: regex or glob (power user)

Filters persist across side panel opens within a session.

#### 6.3.5 Replay Request

For any captured `network.fetch` or `network.xhr` event, the detail view offers "Replay this request." This re-fires the request with the same method, headers (including originally masked ones — they are sent from local storage but never displayed), and body, against the live origin.

Result: success/failure status, response body shown side-by-side with the original. Useful for verifying fixes, testing flaky bugs, exploring "what if I retry."

Safety:
- Replay only fires from the side panel UI, never automatically.
- A confirmation toast precedes destructive HTTP methods (POST/PUT/DELETE/PATCH) by default; can be disabled in advanced settings.
- The user's current auth context is used (browser cookies); the original request's auth context is not preserved unless headers are explicitly included.

### 6.4 Sharing & Export

#### 6.4.1 Destinations

All destinations require zero infrastructure on Hindsight's part. They use one of three mechanisms:

**Mechanism 1 — Web Intent (zero setup)**

The destination service exposes a URL that pre-fills a creation form. Hindsight opens this URL; the user reviews and submits.

| Destination | URL pattern |
|---|---|
| GitHub Issue | `https://github.com/{owner}/{repo}/issues/new?title=...&body=...` |
| GitLab Issue | `https://gitlab.com/{owner}/{repo}/-/issues/new?issue[title]=...&issue[description]=...` |
| Linear Issue | `https://linear.app/team/{team}/issue/new?title=...&description=...` |
| Email | `mailto:?subject=...&body=...` (opens default mail client) |

Setup: user configures default org/team in settings. Zero credentials needed.

**Mechanism 2 — Webhook (one-time setup)**

User pastes a webhook URL into Hindsight settings. Hindsight POSTs structured payloads.

| Destination | Payload format |
|---|---|
| Slack | Incoming webhook with formatted message + image attachment |
| Discord | Webhook with embed + file attachment |
| Microsoft Teams | Adaptive Card with attachments |
| Custom | User-defined; ships as raw JSON POST |

Setup: 5–10 minutes per destination to create webhook in the target service.

**Mechanism 3 — Clipboard + Download (always works)**

For destinations without convenient automation:

- Clipboard: formatted markdown for the destination (e.g., Notion-flavored markdown)
- Download: file the user manually attaches (e.g., HAR for Postman, ZIP for archival)

#### 6.4.2 Export Formats

| Format | Use case | Content |
|---|---|---|
| Markdown (bug report) | Generic sharing | Header, summary, request/response sections, links |
| cURL | Engineering debugging | Single-line `curl` command to replay |
| HAR | Standards-based archival | Standard HAR 1.2 format, opens in Chrome DevTools, Postman, Charles |
| JSON dump | Full fidelity | Raw event array, no transformation |
| Image (PNG) | Visual sharing | Canvas-rendered table of events (existing feature, generalized) |
| Replay bundle (HTML) | Killer feature | See §5 |
| ZIP archive | Comprehensive | All formats above bundled together |

#### 6.4.3 Per-Destination Adaptation

Each destination has different content limits and conventions. Hindsight adapts:

- **Slack**: rich text editor caps near 3000 chars in practice. Hindsight detects this and switches to image-only + auto-download of JSON file pattern (existing behavior, validated).
- **Discord**: similar paste limits, similar fallback.
- **GitHub/GitLab**: generous limits (~65k chars), full markdown body fits.
- **Linear**: ~50k chars, full markdown body fits.
- **Email**: 2 MB total practical limit; large bundles attach as files.
- **Notion**: clipboard-paste, Notion handles markdown well.

Each destination has a "max comfortable size" threshold. When exceeded, Hindsight degrades gracefully — image-only paste plus file attachment.

#### 6.4.4 Privacy Confirmation

For destinations that send data to third parties (webhook destinations, email, web intents), Hindsight displays a one-line preview of what's about to be sent with redaction count: *"Sending: 1 capture, 1 image. 3 fields masked (1 Authorization header, 2 email addresses). Continue?"*

Cancel always available. Power users can disable the prompt per-destination in settings after first confirmation.

### 6.5 Recording Mode

Recording mode is an explicit, heavy-capture mode for high-value evidence (complex bugs, intermittent issues, formal QA documentation).

#### 6.5.1 Entering Recording Mode

User clicks "Start Recording" in the side panel footer or presses configured keyboard shortcut. A red dot appears on the toolbar icon. The side panel shows a "RECORDING" banner.

During recording:
- All Tier 4 captures activate (DOM mutations, cursor trail, periodic screenshots)
- Screenshot frequency increases (every 2s + on significant change)
- A timer shows recording duration

#### 6.5.2 Stopping & Bundling

User clicks "Stop Recording" or presses the shortcut. Hindsight processes the recording (compresses screenshots, dedupes DOM mutations) and presents an export dialog:

- Save as: HTML replay bundle / ZIP archive / JSON / HAR / discard
- Annotate: title, description, tags
- Share immediately: list of configured destinations

#### 6.5.3 Recording Storage

Recordings are stored separately from the rolling event buffer. They persist until explicitly deleted by the user (no automatic eviction).

Storage budget: 100 MB per recording max. Hindsight warns at 80% and stops recording at 100% with a clear message.

### 6.6 Settings & Configuration

The settings page is opened from the side panel header (gear icon) or via `chrome://extensions` options.

#### 6.6.1 Settings Sections

**General**
- Theme: System / Light / Dark
- Language: Auto / English / Turkish / [community-contributed]
- Side panel auto-open on icon click: yes/no
- Keyboard shortcuts (customize)

**Capture**
- Tier toggles (Tier 2 events on/off)
- Per-domain capture rules: capture / ignore / always-record
- Max buffer size per tab (50 / 200 / 500 / 2000 events)
- Screenshot quality (low/medium/high)
- Recording mode features (Tier 4 toggles)

**Detection**
- Smart detection on/off
- Notification preferences (which event types)
- Notification frequency (every / once per session)

**Sharing**
- Default destination
- Per-destination configuration (webhook URLs, default org/repo)
- Privacy confirmation prompt: always / first-time only / never

**Privacy**
- Sensitive field masking patterns (default list + custom regex)
- Default header masking (Authorization, Cookie, etc. — editable)
- "Clear all captures" (with confirmation)
- "Export all my data" (settings + captures as ZIP)
- Per-domain "never capture here" list

**Advanced**
- Developer mode (show extension internals, event raw JSON)
- Performance profiler (overhead measurement on current tab)
- Feature flags (experimental features)

#### 6.6.2 Settings Storage

Settings stored in `chrome.storage.sync` (102 KB limit, syncs across devices for the same user account). Captures stay in `chrome.storage.local` (not synced — they're large and tab-specific).

---

## 7. User Flows

### 7.1 First-Run Onboarding

**Goal:** Get the user from "just installed" to "first useful capture" in under 60 seconds.

1. User installs from Chrome Web Store.
2. Toolbar icon appears with a small "1" badge indicating welcome content.
3. Clicking the icon opens a popup with three things:
   - "I'm capturing what happens in your browser. When something breaks, click here to see what I caught."
   - Big "Open side panel" button
   - Small "Customize" link to settings
4. No modal, no forced tour, no permission re-request. The user goes back to their work.
5. As they browse, captures accumulate silently.
6. First time a Tier 1 event triggers a detection rule (e.g., a 404), a single one-time toast appears: *"Caught a failure on this page. Click the icon to see."*
7. The user clicks. They see their first captured failure. They share it.

This flow respects the user's time. No pre-emptive education; just-in-time hints when they're needed.

### 7.2 Catch a Bug (Passive Path)

**Trigger:** A failure happens while user is browsing.

1. User is on `example.com/checkout`. They submit a payment form.
2. The form returns a generic error ("Something went wrong"). User has no DevTools open.
3. The Hindsight badge turns red with "1" in the corner.
4. User clicks the toolbar icon.
5. Popup shows: *"POST /api/payment failed (500). Captured at 14:32. [Open in side panel] [Send quick report]"*
6. User clicks "Send quick report."
7. Destination picker appears: their pre-configured Slack workspace + manual options.
8. User picks Slack. Hindsight opens Slack in a new tab with a draft message containing image + markdown summary. The user pastes (or it auto-pastes if focused) and sends.
9. Done. Total time from "I see a bug" to "bug reported": ~10 seconds.

### 7.3 Look Back at Past Activity

**Trigger:** User realizes a bug occurred minutes ago.

1. User opens side panel.
2. Timeline shows last 200 events.
3. They scroll (or use the visual scrubber when available).
4. They spot a red entry from 4 minutes ago: a 500 error.
5. They click it. Detail view opens. They review request/response.
6. They add an annotation: "This happened right after I clicked Save."
7. They click "Send" and choose Linear.
8. A new browser tab opens at Linear with a pre-filled issue. They review, click Submit.

### 7.4 Record a Reproduction Session

**Trigger:** User needs to provide thorough evidence of a complex bug.

1. User opens the side panel and clicks "Start Recording."
2. They reproduce the bug, taking 3 minutes.
3. They click "Stop Recording."
4. A dialog asks: "What do you want to call this recording?" They enter "Discharge date format bug." They confirm.
5. Hindsight processes (2 seconds) and produces a 3.4 MB replay bundle HTML file.
6. They download the bundle.
7. They drag the file into Slack (or Jira, or email, or Linear). It uploads as an attachment.
8. The recipient receives the file. They double-click. Their browser opens an interactive timeline. They scrub. They understand the bug.

### 7.5 Power User Customization

**Trigger:** User wants to fine-tune behavior.

1. User opens Settings.
2. They navigate to Privacy → Sensitive field masking.
3. They add a custom regex pattern: `\b\d{11}\b` (Turkish ID number) with label "TCKN."
4. They save. From now on, any field value or response body matching that pattern is masked at capture time.
5. They navigate to Sharing → Slack webhook. They paste their team's webhook URL. They save.
6. They navigate to Detection → Rules. They disable the "long task" notification because they find it noisy.

All settings persist via `chrome.storage.sync`.

---

## 8. Non-Goals (Anti-Features)

Hindsight v1 explicitly will not include the following. Each is excluded with a specific rationale.

| Anti-feature | Rationale |
|---|---|
| **Telemetry or analytics of any kind** | Violates Promise 2 (privacy). No exceptions, including "anonymous usage stats." |
| **Cloud sync of captures** | Requires backend infrastructure; violates zero-cost constraint and Promise 2. |
| **User accounts / signup** | Inconsistent with Promise 3 (zero setup). Also unnecessary given local-only architecture. |
| **AI/LLM-based analysis** | Deferred to v2+ per separate plan. Excluded from v1 for scope discipline. |
| **Video recording** | Storage cost (10–50x screenshots), processing cost, mobile-style "session replay" is a different product. |
| **Audio capture / voice notes** | Privacy nightmare; users may inadvertently capture sensitive audio. |
| **Real-time team collaboration** | Requires backend; v3+ consideration if Hindsight finds traction. |
| **Bug tracking / ticketing features** | We capture moments. Linear/Jira track bugs. We integrate, we don't compete. |
| **Production monitoring / alerting** | Different category (Sentry, Datadog). Hindsight is a dev/QA tool, not a SRE tool. |
| **Request modification / mocking** | Different category (ModHeader, Requestly). Adds complexity and security risk. |
| **Anti-bot / fingerprinting detection** | Ethical concerns. |
| **Replay attacks (auth token replay)** | Security risk; replay request feature is bounded to live auth context only. |
| **Browser support beyond Chromium + Firefox** | Safari Web Extensions are different platform, low ROI for v1. |
| **Mobile capture** | Chrome on Android doesn't support extensions; iOS is even more restricted. |
| **Plugin marketplace UI** | v1 may ship plugin *architecture* but not a marketplace; that's v3+. |

---

## Part C — Technical Specification

## 9. Architecture Overview

### 9.1 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          Chrome Browser                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Web Page (any origin)                                     │ │
│  │  ┌─────────────────────────────┐  ┌──────────────────────┐ │ │
│  │  │ Page-world content script   │  │ Isolated content     │ │ │
│  │  │ (MAIN world)                │  │ script (ISOLATED)    │ │ │
│  │  │                             │  │                      │ │ │
│  │  │ • fetch/XHR patches         │──▶ • postMessage bridge │ │ │
│  │  │ • Click/input capture       │  │ • runtime.sendMsg    │ │ │
│  │  │ • Console error capture     │  │                      │ │ │
│  │  │ • WebSocket wraps           │  │                      │ │ │
│  │  └─────────────────────────────┘  └──────────┬───────────┘ │ │
│  └────────────────────────────────────────────────┼───────────┘ │
│                                                   │             │
│  ┌────────────────────────────────────────────────▼───────────┐ │
│  │  Service Worker (background)                                │ │
│  │  • Event aggregation                                        │ │
│  │  • Storage management (chrome.storage.local)                │ │
│  │  • Badge state machine                                      │ │
│  │  • Detection rule engine                                    │ │
│  │  • Notification triggers                                    │ │
│  │  • Screenshot capture (chrome.tabs.captureVisibleTab)       │ │
│  │  • Tab lifecycle (cleanup on close)                         │ │
│  └────────────────────┬────────────────────┬──────────────────┘ │
│                       │                    │                     │
│  ┌────────────────────▼────────┐  ┌────────▼──────────────────┐ │
│  │  Side Panel (sidePanel API) │  │  Popup (action.popup)     │ │
│  │  • Timeline view             │  │  • Quick summary          │ │
│  │  • Detail view               │  │  • Quick share            │ │
│  │  • Recording controls        │  │  • Open side panel        │ │
│  │  • Settings                  │  │                           │ │
│  └─────────────────────────────┘  └───────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 9.2 Manifest V3 Configuration

```json
{
  "manifest_version": 3,
  "name": "Hindsight",
  "version": "1.0.0",
  "description": "DevTools you didn't open. Bug reporting for everyone.",
  "permissions": [
    "storage",
    "unlimitedStorage",
    "activeTab",
    "scripting",
    "sidePanel"
  ],
  "optional_permissions": [
    "notifications",
    "downloads",
    "tabs",
    "webNavigation"
  ],
  "host_permissions": [],
  "optional_host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/bridge.js"],
      "world": "ISOLATED",
      "run_at": "document_start"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content/interceptor.js"],
      "world": "MAIN",
      "run_at": "document_start"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html"
  },
  "side_panel": {
    "default_path": "sidepanel/sidepanel.html"
  },
  "options_ui": {
    "page": "settings/settings.html",
    "open_in_tab": true
  },
  "commands": {
    "open-side-panel": {
      "suggested_key": { "default": "Ctrl+Shift+H", "mac": "Command+Shift+H" },
      "description": "Open Hindsight side panel"
    },
    "capture-last-moment": {
      "suggested_key": { "default": "Ctrl+Shift+B", "mac": "Command+Shift+B" },
      "description": "Quick capture last 30 seconds"
    },
    "toggle-recording": {
      "description": "Start/stop recording mode"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

Key decisions:
- **No host permissions on install** — users grant `<all_urls>` only when they enable "capture on all sites." Default is `activeTab` (works only on click).
- **Optional permissions** — `notifications`, `downloads`, `tabs`, `webNavigation` requested at feature activation time, not install.
- **Strict CSP** — no inline scripts, no remote code, no `eval`. Protects against XSS and supply-chain attacks.
- **Module service worker** — modern ES modules, smaller bundles via tree-shaking.

### 9.3 Build & Distribution

- **Source language**: TypeScript
- **Bundler**: Vite or esbuild for fast HMR during development, optimized production builds
- **Build outputs**: `dist/` folder ready for `chrome://extensions` load-unpacked or CWS zip
- **CI**: GitHub Actions builds on every PR, lints, runs unit tests
- **Reproducible builds**: deterministic bundle via locked dependencies and pinned tooling versions
- **Release artifacts**: GitHub Releases publishes the production-built ZIP for each version

---

## 10. Data Model

### 10.1 Storage Schema

**`chrome.storage.local`** (per-tab data, large)

```
sessions/{tabId}            → SessionMetadata
sessions/{tabId}/events     → CapturedEvent[]   (max N per tab)
recordings/{recordingId}    → Recording          (persists until deleted)
archives/recent             → ArchivedSession[]  (last 7 days of closed tabs)
```

**`chrome.storage.sync`** (settings, small)

```
settings/general            → GeneralSettings
settings/capture            → CaptureSettings
settings/detection          → DetectionSettings
settings/sharing            → SharingSettings
settings/privacy            → PrivacySettings
settings/destinations/{id}  → Destination (webhook URL, default org, etc.)
```

### 10.2 Eviction Policy

- Per-tab event buffer: FIFO at configured max (default 200)
- Closed-tab archive: TTL 7 days, then removed
- Recordings: never auto-evicted; user must explicitly delete
- Settings: only deleted by user action

### 10.3 Migration Strategy

Each storage key includes a `schemaVersion`. On extension upgrade, service worker runs a migration script if version is older than current. Migrations are idempotent and reversible (best effort).

---

## 11. Privacy & Security Commitments

### 11.1 Architectural Privacy

Hindsight's privacy is enforced by architecture, not policy.

1. **No backend infrastructure exists.** Hindsight cannot upload data because there is no destination.
2. **No telemetry, ever.** The extension itself makes zero outbound network requests except those explicitly user-initiated (webhook POSTs, web intent navigations, file downloads).
3. **All storage is local.** `chrome.storage.local` and `chrome.storage.sync` (the latter is Chrome's account sync, encrypted in transit, controlled by the user's Google account — not Hindsight infrastructure).
4. **Open source under MIT license.** The codebase is fully auditable. Reproducible builds enable verification that the published binary matches the source.

### 11.2 PII Redaction (Capture-Time)

Sensitive data is masked at capture time, not at export time. This prevents accidental exposure: even if the user's machine is compromised, the stored data does not contain unmasked secrets.

**Default header masking:**
- `Authorization`
- `Cookie` / `Set-Cookie`
- `X-API-Key`
- `X-Auth-Token`
- `Proxy-Authorization`

**Default form input masking** (based on heuristic field identification):
- `<input type="password">` — always masked
- `<input autocomplete="cc-*">` — credit card patterns masked
- Field `name` or `id` matching pattern `password|secret|token|ssn|pin` — masked
- Field `name` containing `email` — optional (off by default; some users want masked)

**Default body content masking** (regex applied to request/response bodies):
- TCKN (Turkish ID): `\b\d{11}\b` (with checksum validation to reduce false positives)
- Credit card: Luhn-valid 13–19 digit sequences
- Optionally: email addresses (off by default)

**User-customizable patterns:**
- Settings → Privacy → Custom masking patterns
- Each pattern: regex + label + scope (headers / bodies / form values / all)

**Masking representation:**
- Masked values appear as `***MASKED***` in stored data
- Metadata records *that* a field was masked, *what* pattern matched (for transparency)
- Mask cannot be reversed — the original value is never written to storage

### 11.3 Code-Level Security

- **Strict CSP**: no inline scripts, no remote code, no `eval`, no `Function()`.
- **No `innerHTML` with untrusted data**: all user-controlled strings are escaped via `textContent` or a vetted escaping utility.
- **Minimal permissions**: progressive permission requests; defaults to least-privilege.
- **Input validation**: all stored data is validated against schema before use; corrupted data is logged and discarded, never executed.
- **Dependency hygiene**: `npm audit` clean as release criterion; weekly automated dep update PRs.
- **No native messaging hosts in v1**: removes a class of attack surface.

### 11.4 Transparency Commitments

- **Pre-share preview**: every share action shows the user exactly what will be sent, including a redaction count, before sending.
- **Capture log**: settings → developer mode → "Show extension activity log" displays every outbound action taken by Hindsight, ever.
- **No silent updates of behavior**: feature changes that affect data handling are explicitly documented in release notes.

### 11.5 Threat Model

What Hindsight protects against:
- Casual eavesdropping (no backend means no central honeypot)
- Vendor data harvesting (no vendor)
- Accidental sharing of credentials (capture-time masking)
- Malicious extension supply chain (open source + reproducible builds + strict CSP)

What Hindsight does NOT protect against:
- Compromised user machines (if attacker has filesystem access, they have everything)
- Targeted state-level adversaries (not the design goal)
- The user willingly sharing sensitive data via the share feature (we can warn but not prevent)
- Browser-level zero-days (out of scope for any extension)

---

## 12. Permissions Model

### 12.1 Permission Strategy

Hindsight uses Chrome's optional permissions model to minimize the install-time permission prompt and maximize CWS approval likelihood.

**Install-time (required, in `permissions`)**
- `storage` — to save captures (essential)
- `unlimitedStorage` — to support recordings without hitting quota
- `activeTab` — to inject content script in the currently active tab only
- `scripting` — to inject content scripts via the API
- `sidePanel` — to open the side panel

**Runtime-requested (optional, in `optional_permissions`)**
- `notifications` — requested when user enables detection notifications
- `downloads` — requested when user first exports a file
- `tabs` — requested when user enables cross-tab session features
- `webNavigation` — requested when user enables navigation tracking

**Host permissions (optional)**
- `<all_urls>` (in `optional_host_permissions`) — requested when user enables "capture on all sites." Without this, Hindsight works only on the actively clicked tab.

### 12.2 Justifications for CWS Review

The Chrome Web Store requires justification for each permission. Hindsight's:

| Permission | Justification |
|---|---|
| `storage` | Persist captured events across browser sessions |
| `unlimitedStorage` | Allow long recordings without hitting 10 MB quota |
| `activeTab` | Inject content script only on user-activated tab |
| `scripting` | Required API for MV3 content script injection |
| `sidePanel` | Primary UI surface |
| `notifications` | Alert user to detected bugs (opt-in) |
| `downloads` | Save bundle/HAR/JSON exports |
| `<all_urls>` | Capture on all sites the user wants (opt-in via settings) |

### 12.3 Privacy Policy

A privacy policy is required for CWS submission. Hindsight's privacy policy is one page and includes:

- Statement: "Hindsight does not collect, transmit, store, or sell any user data outside of the user's own browser."
- Permissions section: each permission explained
- Data handling: where data is stored, how long, how to delete
- User rights: export all data, delete all data, opt-out (trivially, by uninstall)
- Contact: GitHub issues + project email

This document lives at `hindsight.dev/privacy` (or the GitHub Pages equivalent).

---

## 13. Performance Budget

### 13.1 Targets

Per-capture overhead must be imperceptible to the user.

| Metric | Target | Measurement |
|---|---|---|
| `fetch()` patch overhead per call | < 0.5 ms | Synthetic benchmark: 10k fetches, measure overhead distribution |
| `XMLHttpRequest` patch overhead per call | < 0.5 ms | Same |
| Click event capture overhead | < 0.2 ms per click | Page-world benchmark |
| Content script injection time | < 50 ms | Lighthouse measurement |
| Memory footprint per tab (idle, 200 events buffered) | < 30 MB | Chrome Task Manager |
| Storage I/O latency (batched flush) | < 100 ms | Service worker timing |
| Side panel initial render (with 1000 events) | < 200 ms | Performance API |
| Lighthouse score impact on host page | < 5 points | Lighthouse with/without extension |

### 13.2 Strategies to Hit Targets

- **Batched writes**: events queued in service worker memory, flushed every 250ms
- **Lazy serialization**: bodies stored as references until needed for view/export
- **Virtualized rendering**: side panel uses windowed virtual scrolling for long lists
- **JPEG compression**: screenshots quality 0.7, max 1200×800
- **Throttled events**: scroll/mousemove throttled to 60Hz max, 10Hz in recording mode
- **Debounced detection**: detection rules run on event-batch boundary, not per-event

### 13.3 Performance Test Suite

CI runs synthetic benchmarks on every PR:

1. Fetch overhead test: 10,000 fetches with and without extension, measure p50/p95/p99 delta
2. Memory leak test: 1-hour browsing simulation, measure memory growth
3. Side panel stress test: render 5,000 events, measure FPS during scroll
4. Real-world test: 30 minutes on a heavy SPA, capture metrics

Failing performance tests block merge.

---

## 14. Internationalization

### 14.1 Approach

Hindsight uses Chrome's native i18n via `chrome.i18n.getMessage()`. All user-facing strings are stored in `_locales/{lang}/messages.json`.

### 14.2 v1 Languages

- English (`en`) — primary, fully maintained
- Turkish (`tr`) — fully maintained by Osman

### 14.3 Community Languages

Other languages are accepted as community contributions via PRs. The repo contains a `LOCALES.md` document explaining how to contribute a translation. Untranslated keys fall back to English.

### 14.4 Language Detection

Default: `chrome.i18n.getUILanguage()` is used to pick the initial language. Settings override available in General settings.

### 14.5 RTL Considerations

For languages like Arabic and Hebrew, the side panel layout adapts. Logical CSS properties (`margin-inline-start`, etc.) are used throughout to support RTL with minimal changes. Detailed RTL support deferred to v1.1.

---

## 15. Accessibility

### 15.1 Compliance Target

Hindsight aims for **WCAG 2.1 Level AA** compliance for all user-facing UI.

### 15.2 Specific Commitments

- **Keyboard navigation**: every action accessible via keyboard
- **Screen reader support**: ARIA labels on all interactive elements, semantic HTML throughout
- **Color contrast**: minimum 4.5:1 for text, 3:1 for UI elements
- **No color-only signals**: red/yellow/green status also conveyed via icons and text
- **Focus indicators**: visible focus rings, never `outline: none` without replacement
- **Motion**: respect `prefers-reduced-motion` for animations
- **Font scaling**: UI scales with browser font size up to 200%

### 15.3 Replay Bundle Accessibility

The standalone HTML replay bundle is itself accessibility-compliant:
- Keyboard navigable
- Screen reader friendly
- Works without JavaScript for static viewing of summary (timeline interaction requires JS)

### 15.4 Testing

- Automated: axe-core in CI on every PR for extension UI and bundle viewer
- Manual: monthly screen reader testing (NVDA on Windows, VoiceOver on Mac)
- Community: explicit issue label for a11y reports

---

## Part D — Execution

## 16. Distribution Strategy

### 16.1 Primary Channel: Chrome Web Store

Hindsight's primary distribution is the Chrome Web Store. Osman holds the developer account (subscription confirmed).

**Listing strategy:**
- Listing title: "Hindsight — Bug capture without DevTools"
- Description: emphasizes privacy, no SDK, universal compatibility
- Screenshots: 5 high-quality screenshots showing core flows (timeline, detail view, replay bundle, share, settings)
- Promotional video: 30–60 second demo
- Categories: Developer Tools (primary), Productivity (secondary)
- Featured-launch attempt: submit for editor review

### 16.2 Secondary Channels

**Microsoft Edge Add-ons**: free submission, same codebase with minor manifest adjustments. Target: launch within 2 weeks of CWS launch.

**Firefox Add-ons (AMO)**: Manifest V2/V3 differences require some adaptation. Side panel API has Firefox equivalent. Target: v1.x post-launch (deferred 3–6 months).

**GitHub Releases**: every version published as a ZIP artifact for "load unpacked" users. Maintains an open-source ethos and serves pre-release testers.

### 16.3 Open Source Repository

Hosted on GitHub under MIT license. Repository contains:
- Source code
- Documentation (README, ARCHITECTURE, CONTRIBUTING, CODE_OF_CONDUCT)
- Localization templates
- CI workflows
- Release scripts

Issue tracker is the primary support channel. Discussions tab for community Q&A.

---

## 17. Marketing & Launch

### 17.1 Pre-Launch (Months 1–4)

- Build in public: monthly progress posts (Twitter/X, blog)
- Beta program: invite-only via project landing page, recruit 50 testers from Twitter/HN networks
- Documentation: complete user docs at `hindsight.dev`
- Demo video: 90-second product overview

### 17.2 Launch Day

- Chrome Web Store live
- Edge Add-ons live (within 1 week)
- Product Hunt launch (coordinated; aim for Featured)
- Hacker News "Show HN" post
- Reddit posts: r/webdev, r/chrome, r/programming, r/QualityAssurance
- Twitter/X announcement thread
- LinkedIn post targeting PM/QA audience
- Blog post: "Why I built Hindsight"

### 17.3 Post-Launch (Months 4–12)

- Quarterly feature releases with public changelogs
- Community engagement: respond to issues within 7 days, PRs within 14 days
- Conference submissions: lightning talks at front-end / developer conferences
- Cross-promotion: partner with privacy-focused open-source projects

### 17.4 Marketing Budget

$0. All channels are organic.

---

## 18. Roadmap & Milestones

### 18.1 Overview

Five milestones, each producing a shippable artifact. Designed for solo part-time development (5–8 hours/week).

### 18.2 M1: Foundation (Weeks 1–4)

**Goal:** Universalize the existing extension and prepare it for the new architecture.

- Remove Datasoft-specific branding and copy
- Implement generic theme system (light/dark/system)
- Set up settings infrastructure (`chrome.storage.sync`, settings UI shell)
- Set up i18n infrastructure (en + tr stubs)
- Refactor existing capture code to use unified `CapturedEvent` model
- Add privacy controls UI (default masking patterns, custom regex support)
- Add HAR export
- Polish existing image rendering for canvas timeline

**Exit criteria:** Extension installable, fully Datasoft-free, settings page functional, HAR export works.

### 18.3 M2: Context Capture (Weeks 5–8)

**Goal:** Expand beyond network captures to user actions and console.

- Click event capture with target descriptors
- Form input change capture with PII masking
- Page navigation tracking
- Console error and `unhandledrejection` capture
- WebSocket frame metadata capture
- Unified timeline view in popup and (basic) side panel
- Narrative engine v1 (template-based summary generation)
- Tier-based capture settings

**Exit criteria:** All Tier 1 and Tier 2 events captured. Timeline shows mixed event types. Auto-generated narrative appears in exports.

### 18.4 M3: Side Panel + Visual Timeline (Weeks 9–13)

**Goal:** Build the time-travel UX.

- Migrate primary UI to `chrome.sidePanel`
- Visual timeline scrubber with event density visualization
- Synchronized panel updates (network, console, actions, screenshot)
- Page screenshot capture at error moments (via `chrome.tabs.captureVisibleTab`)
- Smart detection rules engine (built-in rules)
- Desktop notifications (opt-in)
- Cluster detection for cascades

**Exit criteria:** Side panel is functional and pleasant. Timeline scrubbing works. Screenshots appear in detail view. Detection rules surface issues to the badge.

### 18.5 M4: Replay Bundle + Sharing Hub (Weeks 14–18)

**Goal:** Ship the killer feature and complete the sharing ecosystem.

- Standalone HTML replay bundle generator (the killer feature)
- Embedded viewer application (separate codebase, self-contained)
- Recording mode (explicit start/stop, Tier 4 captures)
- Multi-destination sharing:
  - Slack/Discord/Teams via webhooks
  - GitHub/GitLab/Linear via web intents
  - Email via mailto:
  - Notion via clipboard
  - Custom webhook
- Per-destination formatters with character-limit-aware degradation
- ZIP archive export

**Exit criteria:** User can record a session, export as HTML, send to any major destination. Replay bundle works in all major browsers.

### 18.6 M5: Pre-Launch Polish (Weeks 19–21)

**Goal:** Production-ready for Chrome Web Store launch.

- Performance optimization (hit all targets in §13.1)
- Accessibility audit (WCAG AA compliance)
- Security audit (CSP, input validation, dependency review)
- Documentation site at hindsight.dev
- Marketing landing page
- Demo video production
- Chrome Web Store submission and review
- Edge Add-ons submission

**Exit criteria:** Extension live on Chrome Web Store. Documentation complete. Launch announcement drafted.

### 18.7 Total Timeline

21 weeks at 5–8 hours/week ≈ **5 months from start to v1.0 launch**.

### 18.8 Public Beta Strategy

After M2 (end of week 8), publish a CWS *unlisted* release for closed beta testers. Iterate on feedback during M3–M5. This catches major UX issues early without exposing rough edges to public CWS visitors.

---

## 19. Success Metrics

### 19.1 Adoption Metrics

These are measured **only via Chrome Web Store dashboard** (Google-provided, not Hindsight-collected).

| Metric | 6-month target | 12-month target |
|---|---|---|
| Total installs | 5,000 | 25,000 |
| Active weekly users | 1,500 | 10,000 |
| CWS rating | ≥ 4.5 stars | ≥ 4.7 stars |
| CWS review count | 50 | 250 |

### 19.2 Engagement Metrics

We do not collect these directly (privacy commitment). We infer via:
- GitHub issue volume and quality
- Community PRs
- Discussion forum activity
- Mentioned in third-party content (blog posts, tweets)

### 19.3 Quality Metrics

| Metric | Target |
|---|---|
| Critical bugs (P0/P1) per release | 0 at release, < 3 within 7 days |
| Issue response time | < 7 days median |
| Performance budget compliance | 100% (failing PRs blocked) |
| CWS suspension events | 0 |

### 19.4 Sustainability Indicators

| Indicator | Healthy |
|---|---|
| Active maintainer time per week | 2–8 hours sustained |
| Community contributors per quarter | 1+ new contributors |
| Issue backlog age | < 90 days median |
| Days since last release | < 60 |

---

## 20. Risks & Mitigations

### 20.1 Technical Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Performance overhead unacceptable on heavy sites | High | Performance budget enforced in CI; opt-out per-domain available |
| CSP violations break injection on strict sites | Medium | Graceful degradation; "this site doesn't support capture" message |
| Chrome MV4 changes breaking architecture | Medium | Stick to documented stable APIs; track Chromium roadmap |
| `chrome.tabs.captureVisibleTab` rate limits | Low | Already rate-limited internally; fallback to no-screenshot mode |
| Storage exhaustion on power users | Medium | Automatic eviction policy; warning at 80% |
| Side panel API behavior changes | Low | Side panel is stable since Chrome 114; popup as fallback |

### 20.2 Product Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Users don't understand the value | High | Strong onboarding messaging; demo video; positioning ("DevTools you didn't open") |
| Competitor launches similar tool first | Medium | Move quickly to v1; killer feature (replay bundle) is genuinely defensible |
| Privacy claim isn't credible to users | Medium | Open source + reproducible builds + clear documentation |
| Settings overwhelm new users | Medium | Progressive disclosure; settings only for power users |
| Replay bundle viewer breaks on some browsers | Medium | Cross-browser testing in CI; fallback to static view |

### 20.3 Maintenance Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Maintainer burnout | High | Realistic time commitment; community contributor pipeline; willingness to slow releases |
| Chrome Web Store policy violation / suspension | High | Conservative permission model; explicit privacy policy; engage with CWS reviewers |
| Security vulnerability discovered post-launch | Medium | Security policy with responsible disclosure; rapid release pipeline |
| Open source community conflicts | Low | Clear CODE_OF_CONDUCT; documented governance |

### 20.4 Strategic Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Product doesn't gain traction | High | Acceptable: this is a portfolio/community project, not revenue-dependent |
| LLM features become table-stakes before v2 | Medium | Have v2 plan ready; could accelerate AI integration if needed |
| Browser landscape shifts (Arc, Brave priorities) | Low | Cross-browser compatibility via Edge/Firefox versions |

---

## Part E — Open Items

## 21. Open Questions / Pending Decisions

These are items requiring decisions before or during development. Tagged with required-by milestone.

### 21.1 Pre-Development Decisions

**OQ-1: Final product name** *(blocking M1)*
- Candidates: Hindsight, Rewind, Echo, Witness, Lookback
- Considerations: domain availability, trademark conflicts, memorability
- Decision needed before any branding work begins

**OQ-2: License choice** *(blocking public repo)*
- Recommendation: MIT (maximum adoption, simple)
- Alternative: GPL-3 (forces fork openness)
- Decision needed before pushing to public GitHub

**OQ-3: Beta program scope** *(impacts M2 exit)*
- Closed beta via unlisted CWS after M2, or only after M5?
- Recommendation: M2 closed beta to catch UX issues early

### 21.2 Mid-Development Decisions

**OQ-4: Plugin architecture in v1?** *(blocking M4)*
- Build extension-point infrastructure now (event handlers, custom rules) even without UI for management?
- Recommendation: yes — small effort, future-proof for v2 plugin marketplace

**OQ-5: Recording mode UX** *(blocking M4)*
- Button-based vs keyboard-only vs both?
- Recommendation: both — discoverable button + power-user shortcut

**OQ-6: Webhook security model** *(blocking M4)*
- Should webhook URLs be validated against allowlist? Hashed? Signed?
- Recommendation: simple URL validation; warn on non-HTTPS; no signing in v1

### 21.3 Launch Decisions

**OQ-7: Pricing/monetization stance** *(non-blocking, public commitment)*
- Free forever vs eventual Pro tier?
- Current stance: 100% free, no Pro
- Could be revisited if community demands it post-launch

**OQ-8: Telemetry stance** *(non-blocking, public commitment)*
- Zero telemetry, ever, vs opt-in anonymous usage stats?
- Current stance: zero, as marketing asset
- Trade-off: harder to measure product health

**OQ-9: Translation strategy** *(impacts M5)*
- Maintain only English + Turkish, accept community PRs for others?
- Or actively recruit translators for top-10 languages pre-launch?
- Recommendation: minimal scope (en + tr); community PRs welcome

**OQ-10: Demo video production** *(blocking M5)*
- Self-recorded vs commission a freelancer?
- Length: 30s, 60s, 90s?
- Recommendation: self-recorded 60s, low budget but authentic

---

## 22. Future Vision (v2+)

These features are intentionally out of scope for v1 but inform v1 architectural decisions.

### 22.1 v2: AI/LLM Integration

Documented separately. Four-mode design:
- A: Clipboard handoff to user's AI service (default, zero setup)
- B: BYOK API key in local storage
- C: Local LLM via Ollama/etc.
- D: Native Messaging to Claude Code CLI

Architectural impact on v1: ensure capture data structures are LLM-friendly (well-structured, easily serialized).

### 22.2 v2: Plugin Marketplace

Allow third parties to publish "plugins" that extend Hindsight with:
- New detection rules (e.g., "Stripe API failure patterns")
- Custom share destinations
- Domain-specific narrative engines (e.g., "Datasoft HR knowledge")
- Field masking pattern libraries

Architectural impact on v1: define plugin contract early; expose extension points internally even before UI exists.

### 22.3 v3: Optional Cloud Sync (BYO Cloud)

Allow users to sync captures across devices via *their own* cloud storage (Google Drive, Dropbox, S3 buckets). No Hindsight backend; user provides credentials and bucket.

### 22.4 v3: Mobile Companion

A companion app that receives captures from Chrome via a local web service running on the user's network. Allows viewing captures on a phone while testing on desktop.

### 22.5 v3: Team Mode

Multi-user features for organizations: shared destinations, team libraries of detection rules, federated bug history. Requires careful design to maintain privacy commitments — likely opt-in per-team with explicit infrastructure choice.

---

## Appendix A — Glossary

| Term | Definition |
|---|---|
| **Capture** | A single recorded event (network call, click, error, etc.) |
| **Session** | All captures from a single tab from open to close |
| **Recording** | An explicit user-initiated capture session with Tier 4 events |
| **Replay bundle** | A standalone HTML file containing a session/recording plus an embedded viewer |
| **Detection rule** | A pattern matcher that flags certain captures as "noteworthy" |
| **Cascade** | A sequence of related failures (e.g., one auth failure causing many dependent failures) |
| **Web intent** | A URL pattern exposed by a service for pre-filling creation forms (e.g., GitHub `?title=...&body=...`) |
| **Tier (1–4)** | Capture priority level; Tier 1 is essential and always on, Tier 4 is heavy and recording-mode only |
| **PII** | Personally Identifiable Information; subject to capture-time masking |
| **MV3** | Manifest V3, the current Chrome Extension API version |
| **CWS** | Chrome Web Store |

---

## Appendix B — Inspirations & References

### Inspirations
- **Wayback Machine**: time-travel as a core metaphor
- **Aircraft black boxes**: passive, always-on, valuable only after incidents
- **Obsidian**: plugin ecosystem model
- **Linear**: clean UX, opinionated defaults

### Related tools (studied for differentiation)
- LogRocket, FullStory, Sentry (session replay leaders)
- Bird Eats Bug, Userback, BugHerd (bug reporters)
- Chrome DevTools, Firefox DevTools (built-in)
- ModHeader, Requestly (request modification)
- HAR Replay viewers (various)

### Technical references
- Chrome Extensions documentation: `developer.chrome.com/docs/extensions`
- Manifest V3 migration guide
- Web Extensions WG specifications
- OWASP guidance on extension security

---

## Document Maintenance

- This PRD is a living document. Material changes are versioned (v0.1 → v0.2 etc.) with a changelog at the top.
- Changes should be PR'd against the source repo and reviewed before merge.
- Implementation deviation from the PRD is expected and acceptable when justified; significant deviations should update the PRD post-hoc.

**End of PRD v0.1**
