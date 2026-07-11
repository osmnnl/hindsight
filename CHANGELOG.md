# Changelog

All notable changes to Hindsight. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [0.7.3] — 2026-07-11 — buffer-cap data-loss fixes + MIT LICENSE

Follow-up to 0.7.1/0.7.2 (Sonnet review). `maxEventsPerTab` — the
user-configurable buffer size — was threaded into the write path but not
the read/archive paths, so raising it above the 200 default was silently
ignored.

### Fixed

- **Live view and recording export honor `maxEventsPerTab`.** `readEvents`
  hard-coded the 200 default whenever the pending queue was non-empty (the
  steady state on an active tab). Since the sidepanel/popup and the
  recording→replay-bundle download read through this path, a multi-minute
  recording was silently truncated to 200 events in the exported bundle.
- **Archived (closed-tab) sessions honor `maxEventsPerTab`.**
  `archiveSession` flushed with the 200 default; `pagehide` fires the
  queue flush exactly at tab close (so the pending queue is full by
  design), so the archived copy was permanently truncated to 200 even at
  a larger configured cap (PRD §5.2, "no information loss").

### Added

- **`LICENSE`** — the MIT license file the README has always referenced
  but which was missing from the repo.
- **`bench:multitab BENCH_TABS=…`** — parametrized the storage bench;
  measured that the byte cap holds and the service worker survives at 60
  tabs (~104 MB), so cold-tab in-memory eviction stays deferred (measured,
  not extrapolated).

## [0.7.2] — 2026-07-11 — detection accuracy on body-heavy tabs

Follow-up to 0.7.1. The byte-capped buffer (0.7.1) could evict failure
events on a body-heavy tab, so cascade/anomaly detection and the badge —
which read that buffer — degraded: the badge could under-count errors
(false-green) and cascades could go undetected.

### Fixed

- **Detection and the badge now read a dedicated recent-failures ring**,
  decoupled from the byte-capped buffer. The ring is count-bounded
  (100 failures), body-stripped (detection only needs
  url/method/status/timestamp/meta), and hydrated from the persisted
  buffer on service-worker start so it survives SW eviction the way the
  old disk-backed read did. `detect()` runs against it (cascade/anomaly
  filter for failures anyway, so this is semantically identical and more
  robust) — which also drops the per-capture O(N) buffer scan from the
  detection path. Badge `failedCount` comes from the ring too.

## [0.7.1] — 2026-07-11 — M5: storage/memory crash fix (20-tab regime)

v0.7.0 fixed the renderer-main capture cost but the buffer's storage/memory
footprint was untouched — so with ~20 active tabs the browser still slowed
down and the extension crashed. Reproduced in a real-Chromium 20-tab bench
(measured: `chrome.storage.local` ~145 MB, SW dies under sustained load),
then fixed and re-measured (~37 MB, SW survives). The crash lived in the
layer the prior analysis under-weighted, not the renderer path.

### Fixed

- **Byte-bounded rolling buffer.** The per-tab buffer was capped by event
  count (200) only; a tab streaming large bodies or screenshots held tens
  of MB, mirrored in the SW heap and rewritten to `chrome.storage.local`
  every 250 ms. It is now also capped by BYTES (2 MB/tab), bounding SW
  memory and per-flush write size regardless of `maxEventsPerTab` (also
  neutralizes the 2000-cap footgun).
- **`action.input` value capped at the source** (10 KB). It was the only
  default-on capture with no cap; a large textarea streamed its full value
  through the pipeline on every keystroke and slipped past the byte cap.
- **Archive bounded + made atomic.** `archives/recent` grew unbounded
  (7-day TTL, no session-count cap); every tab close rewrote the whole
  blob. Capped to 30 sessions, and all archive writers
  (`archiveSession`/`sweepArchive`/`clearArchive`) are serialized on one
  promise chain — closing a window used to fire ~20 concurrent
  read-modify-writes that clobbered each other (lost-update race).
- **MessagePort leak.** The v0.7.0 handshake never closed superseded
  ports; up to 11 entangled pairs leaked per page load. Losers are now
  closed on connect, and the live port on `pagehide`.

### Added

- **`bench:multitab`** — real-Chromium 20-tab gate that asserts the SW
  survives and `chrome.storage.local` stays under a bounded ceiling.

### Known follow-ups (non-blocking, tracked in perf-plan.md)

- Detection/badge/export read the byte-capped buffer, so on a single
  body-heavy tab they may see fewer events (a small count-bounded
  recent-failure index is the planned fix).
- Adaptive flush interval and cold-tab in-memory eviction are further
  hardening for extreme tab counts, deferred pending measurement.

## [0.7.0] — 2026-06-30 — M5: capture-pipeline performance hardening

Closes the multi-tab × heavy-request page-freeze (jank) that disappeared
the instant the extension was removed. A root-cause analysis traced it to
five mechanisms on and around the capture hot path; all five are fixed.
The dominant one is verified in real Chromium. No user-facing feature
changes — capture fidelity and privacy are unchanged (one privacy
improvement, below).

### Performance

- **Captures ride a private `MessagePort`, not a `postMessage('*')`
  broadcast.** Every captured event used to wake the page's OWN `message`
  listeners (analytics SDKs, OAuth/wallet bridges, framework routers)
  once per fetch / XHR / click / keystroke — the dominant cost, paid on
  the page's main thread before the v0.6.2 batch/gate ever ran. The
  ISOLATED bridge now hands the MAIN interceptor a private port; captures
  flow over it and never touch the page's listeners. Safe by
  construction: the broadcast continues until a round-trip over the port
  is confirmed, so a browser that can't transfer the port simply keeps
  the old behavior (zero capture loss).
- **XHR response body read detached off the `loadend` turn** — the body
  materialization + cap + post no longer block the page's own load
  handler per request (mirrors the fetch path).
- **cursor/scroll dropped at the source** when recording is known to be
  off, instead of being emitted at ~20 Hz and discarded downstream.
- **Badge `chrome.action` IPCs skipped when the badge is unchanged** (the
  common case), instead of 2 awaited IPCs per capture.
- **`GET_EVENTS` poll skips the full-buffer clone** when nothing changed
  since the caller's last fetch — the side panel / popup no longer make
  the service worker re-clone the whole ≤200-event buffer (base64
  screenshots and all) every second.

### Added

- **`bench:fanout`** — a real-Chromium (Playwright) bench that loads the
  built extension and asserts captures no longer wake the page's own
  `message` listeners (0 wakeups vs ~N for the old broadcast) while still
  reaching the service worker. Not part of `npm run bench`; run on demand.

### Changed

- The `'*'` capture broadcast no longer leaks capture payloads to the
  page's own scripts — the private port closes that channel (privacy
  improvement, PRD §11.1).

## [0.6.2] — 2026-06-12 — perf hotfix: stop the capture pipeline janking the page

### Performance

- **fetch no longer blocks time-to-first-byte.** The body is read from a
  detached clone (capped 200 KB / 10 s); event-stream/binary bodies are
  never cloned, so fetch-based SSE streams resolve again.
- **Page-world payloads bounded at the source** — XHR `responseText`,
  request bodies, and console args are capped; WebSocket frames coalesce
  into one summary per second per direction; input events skip the
  per-keystroke forced reflow.
- **Capture IPC batched** (~250 ms window) into one `CAPTURE_BATCH`
  message, and Tier-4 cursor/scroll traffic gated at the bridge before
  the IPC instead of being shipped just to be dropped.
- **Session metadata cached in memory** — `getOrCreateSession` no longer
  does a `chrome.storage.local` round-trip per captured event.

## [0.6.1] — 2026-06-08

### Fixed

- **Firefox capture was dead** — the MAIN-world interceptor is now
  injected from the bridge (crxjs's relative loader 404'd on Firefox).
- **Firefox "Open side panel"** preserved the user gesture so the sidebar
  actually opens.

### Added

- **Side panel follows the active tab** (DevTools-style).
- **Popup network-only quick list** + author credit link.

## [0.6.0] — 2026-06-05

### Added

- **Eye logo** wired to the toolbar action and in-app headers.
- **Per-section copy buttons** in the network detail view.
- **Firefox / AMO build target** (`build:firefox`, sidebar port).
- **Per-tab category show/hide filter** + a global default in Settings.
- **Detail view: interactive JSON tree**, collapsible sections, and
  in-detail find with highlight + jump.

## [0.5.0] — 2026-05-25 — M5 W11-W12: scrubber range + mask opt-out

First minor bump in M5. Two user-facing capabilities land alongside
a markdown-render fix and the CLAUDE.md refactor.

### Added

- **Dual-handle timeline scrubber.** Two range inputs stacked over
  a shared track let the user clip both the left and right edges of
  the timeline. Bars outside the selected window dim to ~18%
  opacity. A "↺ reset" pill in the axis row appears whenever the
  range is non-default. Time labels show the SELECTED window's
  start/end (was: session boundaries). The range is a zoom on the
  current post-base-filter set — switching filter mode rebases the
  slider; handles enforce a 1% minimum gap so they can't swap.
- **Per-rule disable for built-in masking** (Settings → Privacy).
  Default header + body rule chips become clickable toggles. Click
  a chip to disable that rule for _future_ captures; disabled chips
  render with a dashed red border and a strikethrough label. A
  danger banner makes the trade-off explicit: "Captures recorded
  with a rule disabled will store the matched value verbatim on
  your machine and include it verbatim in any bug report you
  share." Form-field rules stay read-only — the page-world capture
  path doesn't yet honour `disabledDefaultRules`, and disabling
  password-input masking is a much bigger footgun.
  `PrivacySettings` gains `disabledDefaultRules: string[]`;
  `loadPrivacyConfig()` filters defaults before handing them to
  `applyMasking`. The existing `chrome.storage.onChanged` listener
  picks up the toggle without an SW restart.

### Fixed

- **`escapeMd()` now escapes `_`, `*`, `[`, `]`** (W11). Real
  captured paths like `/api/_internal/health` and titles like
  `failed: [POST] /api/orders` would otherwise render as italics
  or broken links on GitHub Issue / Slack / Discord destinations.
  Two new tests pin the escape contract. 125 tests total.

### Changed

- **CLAUDE.md adopts the Karpathy four-principle structure.**
  Behavioral guidelines (Think before coding · Simplicity first ·
  Surgical changes · Goal-driven execution) move to the top of the
  file; Hindsight-specific rules consolidate under §5; the multi-
  section status/release history collapses to a one-line pointer at
  this CHANGELOG. 380 → 254 lines, 14.5 kB → 8.6 kB.

### Why a minor bump

Two new user-facing capabilities (range filter + mask opt-out)
plus an architectural privacy contract addition
(`disabledDefaultRules`) is over the threshold for a patch tag.
v0.5.0 also gives v1.0.0 (CWS submission) some breathing room for
genuinely-major changes between now and then.

[0.5.0]: https://github.com/osmnnl/hindsight/releases/tag/v0.5.0

---

## [0.4.4] — 2026-05-25 — M5 W10 dep audit closure

Closes the `npm audit` finding deferred from v0.4.2. 7 advisories
(5 moderate + 2 high) → **0**. All clean.

### Changed

- **vitest 2.1.9 → 4.1.7**. Vitest 4 pulls a security-patched
  vite/esbuild chain that resolves the 5 moderate advisories
  (CVE-2024 esbuild dev-server SSRF chain via vite-node, vite,
  @vitest/mocker). API-compatible at the surface we use
  (`describe / it / expect / vi.fn`); 123 tests pass unchanged.
- **@crxjs/vite-plugin `^2.0.0-beta.34` → `^2.4.0`**. Latest
  stable in the 2.x line. Manifest/HMR contract unchanged.
- **Added npm `overrides` to force rollup `^2.80.0`** through
  the @crxjs/vite-plugin transitive chain. @crxjs 2.4.0 pins
  rollup@2.79.2, which still trips GHSA-mw96-cpmx-2vgc; the
  override bumps to the security-patched 2.80.0+. Only the
  patch level changed between 2.79.2 and 2.80.0, so no behavior
  delta in the build.

All dev-deps only — no runtime exposure shipped to users before
or after, but a clean `npm audit` removes friction from the CWS
submission checklist.

### Audited (clean)

- `npm audit` — 0 vulnerabilities, 258 packages.
- `npm run build` — 177 ms, output bytes unchanged within rounding.
- `npm test` — 123/123 in 197 ms (faster than v0.4.3 thanks to
  vitest 4's improved transform pipeline).
- All four perf benches green.

[0.4.4]: https://github.com/osmnnl/hindsight/releases/tag/v0.4.4

---

## [0.4.3] — 2026-05-25 — M5 W8-W9 SW robustness

Two small service-worker correctness fixes on top of v0.4.2. Both
are defensive — under happy-path use neither was visible — but
both close real failure modes that would have been hard to
diagnose in the wild.

### Fixed

- **readArchive() now TTL-filters at read time** (W8). The 7-day
  archive TTL (PRD §6.1.3) is normally enforced by `archiveSession()`
  on every write and by `sweepArchive()` lazily on SW boot. If the
  sidepanel requests the archive list immediately after a SW wake-
  up, the message handler can read raw storage before
  `sweepArchive()`'s async write lands — surfacing entries older
  than the TTL for one render cycle. Filtering at read time covers
  the race without removing the sweep.
- **chrome.runtime.onMessage handlers now catch rejections** (W9).
  The async branches (`GET_EVENTS`, `CLEAR_EVENTS`, `GET_ARCHIVE`,
  `CLEAR_ARCHIVE`, `TOGGLE_RECORDING`) paired `.then(sendResponse)`
  with no `.catch`. If storage threw (quota, corruption, mid-
  teardown), `sendResponse` never fired and the popup / sidepanel
  caller hung waiting until Chrome timed out the channel. Each
  branch now has a `.catch` that calls `sendResponse` with a safe-
  default fallback matching the expected shape (`[]`, `false`,
  `{ recording: false }`).

123 tests, all four perf gates green. Doc-only delta in CLAUDE.md.

[0.4.3]: https://github.com/osmnnl/hindsight/releases/tag/v0.4.3

---

## [0.4.2] — 2026-05-25 — M5 W1-W7 foundation: a11y · perf · real bugs

Pre-launch hygiene pass on top of v0.4.1. Seven small landings;
three of them are real production bug fixes that survived from M3
because nothing tested them. The other four are an a11y polish,
two new perf benchmarks, and one defense-in-depth security tweak.

### Fixed

- **Cascade detection one-shot signal was dead code** (W5). The
  `cascade-head` EventFlag was never stamped on any event because
  `detectCascade()` returned `isHead: false` in both branches. The
  SW desktop notification at service-worker.ts:585 and the
  sidepanel cluster banner at sidepanel.ts:1084 both keyed off
  this flag — neither actually fired before. Fix is a one-literal
  change in the no-inherited-head branch; new tests guard both
  the fire and the don't-re-fire-on-4th-failure paths.
- **SW Map leaks on tab close** (W6 + W7). Three in-memory Maps
  in the service worker grew unbounded over a browsing day:
  `notifiedThisSession` (synthetic key cleanup that never matched
  a real key), `screenshotLastShotAt` (no cleanup at all), and
  `sequenceCursor` (no cleanup at all). All three now flush on
  `chrome.tabs.onRemoved` — tabId-keyed maps drop synchronously,
  sessionId-keyed maps share one async lookup.

### Added

- **Full ARIA dialog for the privacy preview modal** (W1) —
  resolves OQ-M4-L. Adds `aria-describedby` pointing at a new
  summary wrapper, sets `inert` on `#app` while the dialog is
  open so screen readers and keyboard nav cannot reach the
  background side-panel UI. Drops the 10 ms setTimeout focus
  hack — the overlay is in the DOM after `appendChild`, focus
  works synchronously.
- **Reduced-motion support in the popup** (W1). The
  `recording-dot` pulse animation now honors
  `prefers-reduced-motion: reduce`. Sidepanel already had this;
  popup was missing it.
- **masking-cost benchmark** (W2) — `bench/masking-cost.bench.ts`
  guards a sub-slice of the PRD §13.1 fetch/XHR budget so a
  future PII rule addition can't silently eat the headroom.
  Budgets: header walk p95 < 0.05 ms, body scan p95 < 0.20 ms.
  Local measurement: ~3.6% and ~1.4% of budget respectively.
- **filter-1000 benchmark** (W4) — `bench/filter-1000.bench.ts`
  exercises `isApiRequest` / `isErrorEvent` over a synthetic
  1000-event session. Budget p95 < 2 ms (well under the 200 ms
  PRD §13.1 row 3 render budget). Both predicates in the gate.
- **`npm run bench:masking` + `npm run bench:filter`** standalone
  scripts. `npm run bench` chains all four benches.

### Changed

- **`isApiRequest()` is ~41% faster** (W4). Hoisted the
  `ASSET_EXTS` set from inside the function body to module scope —
  the per-call allocation was the dominant cost in the 1000-event
  filter pass (p95 0.42 ms → 0.25 ms).
- **`bindPatternEditor` uses `CSS.escape()`** (W3). Defense in
  depth: pattern ids are crypto.randomUUID() today, but a future
  import-settings flow or manually edited chrome.storage entry
  could otherwise break the selector or match an unintended
  sibling.

### Audited (no change needed)

- **innerHTML call sites** — 27 reviewed, every user-controlled
  value funnels through `escapeHtml` / `escapeAttr`. Two raw
  interpolations verified safe (numeric height in scrubber bars,
  literal-string WebhookDestination in popup quick-share).
- **CSP** — `script-src 'self'; object-src 'self'` (PRD §9.2
  baseline). Unchanged.
- **`npm audit`** — 7 vulnerabilities in dev-dep transitive chain
  (rollup, vite, vitest, vite-node, @crxjs/vite-plugin). Build-
  time only; none ship to the user. Fix requires breaking
  upgrades, deferred to the next M5 dep-bump sprint.

### Commits (7 on `main`)

```
feat(a11y):       privacy modal full ARIA dialog + popup reduced-motion — W1
perf(bench):      masking-cost benchmark — PRD §11.2 + §13.1 sub-budget — W2
chore(security):  CSS.escape dynamic selector — settings — W3
perf(filter):     hoist ASSET_EXTS + 1000-event filter bench — W4
fix(detection):   cascade-head fires on threshold-tripping event — W5
fix(sw):          notifiedThisSession leak on tab close — W6
fix(sw):          screenshotLastShotAt + sequenceCursor leak on tab close — W7
```

123 unit tests (121 → 123 via the two new cascade-head assertions),
all four perf gates green.

[0.4.2]: https://github.com/osmnnl/hindsight/releases/tag/v0.4.2

---

## [0.4.1] — 2026-05-21 — M4 post-closeout polish

Three sidepanel triage-noise killers landed on the M4 branch after
the v0.4.0 closeout commit. No new milestone, no PRD scope change —
just compounding quality-of-life wins on the surfaces shipped in M4.

### Added

- **API-only filter chip** alongside Failed / All. Reason: modern
  SPA frameworks (Next.js especially) emit tens-to-hundreds of
  internal requests per page — chunked JS, prefetched data, image
  optimizer, fonts — that drown out the actual API calls a user is
  debugging. `isApiRequest()` in `src/types/events.ts` is the shared
  heuristic: keeps `network.fetch` / `network.xhr` only, rejects
  framework internals (`/_next/`, `/__webpack`, `/__vite`, `/_hot/`,
  `/__nextjs`, `/sockjs-node`), rejects by URL extension and
  response content-type. Mirrored verbatim into the replay-bundle
  viewer so the bundle stays self-contained.
- **Persistent filter + host picker.** Last-used `filterMode` +
  `activeHost` survive reload via
  `chrome.storage.local['sidepanel/ui-state']` with a 200 ms
  write-side debounce. Default still `failed`; previous selection
  wins after the first run.
- **Free-text search bar** above the event list — case-insensitive
  substring across `event.type` + `url` + stringified `data`,
  debounced 120 ms. Intentionally transient (not persisted).
- **Host filter `<select>`** harvested from the current buffer.
  `eventHost()` picks request-URL host for network events, page-URL
  host for everything else.
- **17 new `isApiRequest` unit tests** covering the full matrix.
  **121 unit tests total**, both perf gates green
  (fetch p95 ~0.012 ms, XHR p95 ~0.001 ms).

### Fixed

- **Sidepanel bulk-bar flicker on poll** — the 1 s polling
  `refresh()` was calling `render()` unconditionally, so bulk bar
  buttons + share chips were rebuilt every cycle, causing visible
  flicker on the bottom action bar. `refresh()` now stamps an
  events signature (length | last id | last timestamp) and skips
  `render()` when it matches. `invalidateRenderCache()` clears the
  stamp so filter / host / search / cluster-toggle changes still
  force a fresh render.

### Changed

- Render pipeline reads `filteredEvents(all, mode, host, query)`
  with a single fixed order: filter mode → host pin → free-text
  search. Result count chip ("12 / 384") shows the narrowing live.
- Empty-state copy branches by which dimension is empty (search
  match vs host mismatch vs filter selection).
- Popup focus handshake validates `'api'` alongside `'failed'` /
  `'all'`.

### Commits (3 on `feature/m4-foundation`, on top of v0.4.0)

```
feat(filter):    API-only filter chip — hide framework chunks and static assets
feat(sidepanel): persistent filter + search bar + host picker
fix(sidepanel):  skip render when events haven't changed — stop bulk bar flicker
```

[0.4.1]: https://github.com/osmnnl/hindsight/releases/tag/v0.4.1

---

## [0.4.0] — 2026-05-21 — M4: Replay bundle + sharing hub

Fourth milestone. The PRD's killer-differentiator feature lands: a
standalone HTML replay bundle that a teammate can drag into any browser
tab and see the whole session, no extension, no service, no login.
Recording mode + Tier 4 captures (cursor, scroll, periodic screenshots)
fill out the explicit-record path. The sharing hub gains Slack /
Discord / Teams webhooks with size-aware step-down halving, GitHub
Issue + mailto web intents, a unified markdown bug-report formatter,
and a ZIP-everything export that bundles markdown + JSON + HAR + the
replay bundle + inline screenshots into one shareable artifact.

### Added

- **Standalone HTML replay bundle** (PRD §5) — `src/lib/replay-bundle.ts`
  emits a single `.html` document with the captured session embedded
  in `window.__HINDSIGHT__` and a vanilla-DOM viewer (no framework,
  no CDN). Scrubber, narrative panel, event list, detail pane,
  redactions panel — all in one self-contained file.
- **Bundle viewer filter / search / keyboard nav** — filter chips
  (failed / all), full-text search across `type` + `url` + `data`,
  `← → ↑ ↓` step through visible events.
- **Recording mode** (PRD §6.5) — ● Record / ■ Stop in the side
  panel and a recording banner in the popup. `recording.start` /
  `recording.stop` envelopes, periodic 2-second JPEG snapshots on
  the active tab, 10 Hz cursor + throttled scroll captures (Tier
  4 events, SW drops them unless the tab is in recording mode so
  non-recording sessions pay zero cost).
- **Bundle auto-download on Stop** — toggling off Recording fires a
  `hindsight-recording-<host>-<timestamp>.html` download.
- **Webhook pipeline** (Slack / Discord / Teams) —
  `src/lib/destinations/webhooks.ts` formats per-destination payloads
  (Slack Block Kit, Discord embed, Teams MessageCard) and runs a
  size-aware step-down halving loop when the report exceeds the
  destination's hard limit.
- **GitHub Issue + mailto web intents** —
  `src/lib/destinations/web-intents.ts` builds prefilled new-issue
  URLs and `mailto:` drafts with a truncation flag.
- **Unified markdown bug-report formatter** —
  `src/lib/formatters/markdown.ts` covers every event family,
  honours `maxDetailEvents` for size-aware destinations, and is
  reused by ZIP / webhook / web-intent / sidepanel copy paths.
- **ZIP archive export** — `src/lib/zip.ts` is a dependency-free
  vanilla writer (compression method 0, UTF-8 filenames, CRC-32).
  The new "⤓ ZIP" button in the sidepanel bundles `report.md`,
  `session.json`, `session.har`, `replay.html`, and inline
  screenshots under `screenshots/`.
- **"Replay this request" button** (PRD §6.3.5) — re-fires a
  captured network event from the extension context.
  Confirm-prompt for POST / PUT / PATCH / DELETE. Skips masked
  headers, shows status + response inline with a "diff vs original"
  badge. Surfaces CORS / host-permission errors clearly.
- **Privacy preview modal** (PRD §6.4.4) — replaces the M4·W12
  `confirm()` with an in-panel overlay that summarises event count,
  per-rule redaction breakdown, and destination identity before the
  payload leaves the user's machine. Esc cancels, Enter continues.
- **Settings → Advanced section** — debug logging toggle, perf
  budget soft-warning threshold, live storage usage stats, and a
  "Reset everything" factory-reset button.
- **Popup recording banner** — `00:00` timer + ■ Stop button so the
  user can end a recording without opening the side panel.
- **Sidepanel keyboard ergonomics** — Esc closes the detail view,
  screenshot click opens the full JPEG in a new tab.
- **6 ZIP-writer unit tests** — CRC-32 vector, multi-entry counts,
  UTF-8 filename flag, verbatim payload bytes.
- **92 unit tests total**, both perf gates green (fetch p95
  ~0.010 ms, XHR p95 ~0.001 ms).

### Changed

- Sharing settings UI ships GitHub default-repo + default-mailto
  recipient fields alongside the three webhook slots.
- Recording state survives a service-worker eviction round-trip;
  popup + sidepanel poll `GET_RECORDING` to stay in sync.
- Settings → Advanced no longer carries the "M2+" badge.

### Architecture

- New modules: `src/lib/replay-bundle.ts`, `src/lib/zip.ts`,
  `src/lib/formatters/markdown.ts`, `src/lib/destinations/webhooks.ts`,
  `src/lib/destinations/web-intents.ts`.
- `runtime-messages.ts` gains `ToggleRecordingRuntimeMessage`,
  `GetRecordingRuntimeMessage`, `RecordingState`.
- `service-worker.ts` learns Tier 4 gating, periodic screenshot
  timers, `recording.start` / `recording.stop` envelope minting,
  and per-tab recording state cleanup on `tabs.onRemoved`.
- `lib/settings.ts` adds `AdvancedSettings` + accessors.

### Commits (~16 on `feature/m4-foundation`)

```
feat(replay):       standalone HTML bundle generator — W12-1
feat(sidepanel):    Save as replay bundle button — W12-5
feat(recording):    Start/Stop UI + SW state — W12-2
feat(recording):    bundle download on stop — W12-3
feat(settings):     Sharing section + webhook URLs — W12-4
feat(formatters):   unified markdown bug report — W13-3
feat(destinations): Slack/Discord/Teams webhook pipeline — W13-1
feat(destinations): GitHub Issue + mailto web intents — W13-5
feat(recording):    Tier 4 captures — W13-2
feat(export):       ZIP archive everything — W14-1
feat(sidepanel):    Replay this request button — W14-2
feat(sidepanel):    Privacy preview modal — W14-3
feat(replay):       bundle viewer filter / search / keyboard nav — W14-4
feat(settings):     Advanced section live — W14-5
feat(popup):        recording banner + sidepanel UX polish — W15
chore(release):     M4 closeout — v0.4.0 — W16
```

[0.4.0]: https://github.com/osmnnl/hindsight/releases/tag/v0.4.0

---

## [0.3.0] — 2026-05-21 — M3: Side panel + visual timeline

Third milestone. The side panel takes over as the primary inspection
surface; the popup shrinks to a launcher. Detection rules grow from
hidden state into a real cluster banner with collapse / expand
behavior. Screenshots fire on errors, performance long tasks and
layout shifts get captured, white-screen-after-navigation gets a
heuristic, and chrome.notifications wire in behind a per-session
de-dup. The badge is finally severity-tiered.

### Added

- **chrome.sidePanel migration** — full M2 popup UI moves to
  `src/sidepanel/`. The popup becomes a 130-line launcher (latest
  failure card + Open side panel + Send quick report + Settings
  link). chrome.commands listener wires Ctrl+Shift+H to
  `chrome.sidePanel.open` so the keyboard shortcut works
  end-to-end.
- **Theme sync** — new src/lib/theme.ts applies the Settings →
  General theme to body[data-theme]. Popup, side panel, and
  settings page all listen to chrome.storage.onChanged and re-skin
  live.
- **Visual timeline scrubber** — CSS-only 40-bucket density
  histogram in the side panel header plus a range input that
  scrolls the list to the nearest event in time. Event delegation
  on the list container keeps the 1000-event budget in check.
- **Closed-tab archive viewer** — sidepanel surfaces
  archives/recent entries as a collapsible "Closed sessions"
  panel. Lazy-render keeps init time flat even with a full
  archive. Per-entry expand reveals a read-only event list. Clear
  Archive link wipes the lot on demand.
- **Screenshot capture on error** — chrome.tabs.captureVisibleTab
  fires within 2 s per tab when an isErrorEvent lands. Inline
  JPEG (quality 70) on the ScreenshotEvent so the side panel
  detail view can render without a second storage hop.
- **Detection rule engine** — new src/lib/detection.ts with 12
  unit tests. Rules: failed network / console.error, slow request
  (> 3 s), cascade (3+ failures to same origin within 10 s, with
  inherited heads), repeated identical failure ("anomaly"). Runs
  in the SW before persistence, stamps meta.flags + meta.cascadeOf.
- **Cluster collapse + banner UI** — cascades now render as a
  single banner above the events ("🔴 N-failure cascade — METHOD
  /path"). Click anywhere on the banner toggles. Members render
  indented when expanded. summarizeCluster picks dominant
  status / method / path / span.
- **Performance long-task + CLS** — PerformanceObserver in
  page-world emits performance.longtask (> 100 ms) and
  performance.cls. Per-type row rendering in the side panel.
  Tier 3 gate (off via Settings → Capture stops these from
  persisting; screenshot stays on regardless).
- **White-screen heuristic** — 5 s post-load element count check.
  < 5 visible elements → synthetic console.unhandled flows
  through the existing error path. Per IIFE-lifetime once so
  SPA routes don't false-positive.
- **Detection settings section** — Smart detection master toggle,
  chrome.notifications opt-in with runtime permission request,
  notification frequency (first-per-session vs every). Detection
  events fire notifications for cascade-head AND anomaly with
  separate dedup keys.
- **Severity-tiered badge** — empty bubble (healthy), yellow "!"
  (slow / long task / CLS present), red count (errors). PRD
  §6.2.2 color semantics.
- **Tier 3 toggle in Settings → Capture** — performance observers
  opt-out without disabling screenshot.
- **Per-type row rendering** — formatRow learns performance.longtask
  / performance.cls / screenshot first-class layouts.

### Changed

- Popup completely rewritten as a minimal launcher (1.1 kB).
- renderBadge uses isErrorEvent + warn-class flags for color
  selection instead of always red.
- Cluster collapse UI replaces the M2 per-row toggle.
- M3-aware capture table in README; M2 row flips to ✅.

### Commits (15 on M3 branch)

```
feat(sidepanel):  chrome.sidePanel migration + theme sync — W9-1
feat(sidepanel):  visual timeline scrubber + event delegation — W9-2
feat(capture):    screenshot capture on error — W9-3
feat(detection):  rule engine + cluster grouping — W9-4
feat(sidepanel):  recent-archive viewer — W9-5
feat(sidepanel):  cluster collapse UI — W10-1
feat(capture):    performance long-task + CLS — W10-3
feat(detection):  white-screen heuristic — W10-4
feat(settings):   Detection section + notifications — W10-2
feat(sw):         severity-tiered badge — W10-5
feat(sidepanel):  per-type row rendering — W11-1
feat(sidepanel):  cluster banner UI — W11-2
feat(settings):   Tier 3 toggle — W11-3
feat(sw):         notification anomaly rule — W11-4
chore(release):   M3 closeout — v0.3.0 — W11-5
```

[0.3.0]: https://github.com/osmnnl/hindsight/releases/tag/v0.3.0

---

## [0.2.0] — 2026-05-21 — M2: Context capture

Second milestone. The capture pipeline now covers every PRD §6.1.1
Tier 1 and Tier 2 event family — clicks, form inputs (with
page-world masking), console.error / warn / info / unhandled,
navigation (both real and SPA), and WebSocket frames. The popup
renders a mixed timeline; closed tabs move to a 7-day archive;
storage writes batch at 250 ms; both fetch and XHR overhead are
hard-gated in CI.

### Added

- **Click + form input capture** (PRD §6.1.1 Tier 2). New
  src/lib/dom-descriptor.ts builds an accessibility-leaning
  TargetDescriptor (aria-label → aria-labelledby → text/value →
  placeholder → title chain). Input events apply
  shouldMaskFormField page-world because FormFieldMeta only exists
  in the DOM — the value lands in storage already masked when a
  field matches a default rule.
- **Console capture broadened** — error / warn / info / unhandled
  via a single wrapConsoleMethod factory. Window-level 'error' and
  'unhandledrejection' listeners cover uncaught paths. Full stacks
  preserved (PRD §4.1 no information loss).
- **Navigation events** — chrome.webNavigation.onCommitted in the
  service worker emits NavigationEvent on every non-reload
  top-frame commit. fromUrl tracked via in-memory lastUrlPerTab.
- **SPA route detection** — page-world wraps history.pushState /
  replaceState and listens to hashchange. popstate intentionally
  not wrapped (overlaps with webNav back/forward).
- **WebSocket frame metadata** — createWebSocketPatch subclass
  emits connect / open / message (both directions) / close / error
  with byteSize. Frame content stays opt-in (deferred to v3+).
- **Mixed timeline rendering** — popup.ts dispatches on event.type
  for the five-column row + per-type detail view. JSON download
  carries every event; HAR export stays network-only.
- **Batched storage writes** — queueEvent + 250 ms flush window
  (PRD §13.1 / §13.2). SessionMetadata.lastSequence rides along on
  the same chrome.storage.local.set. Projected buffer reads keep
  the popup gap-free.
- **Closed-tab archive** — archives/recent key, 7-day TTL. Tab
  close moves session into archive; reload + user Clear stay
  delete-only. Lazy sweep on SW boot.
- **Capture settings** — Settings → Capture section live with
  Tier 2 toggle + per-tab buffer cap (50 / 200 / 500 / 2000). SW
  caches the config and invalidates on chrome.storage.onChanged.
  OQ-M2-J: toggle off filters new captures only, history stays.
- **Narrative engine v1** — src/lib/narrative.ts template-based
  CapturedEvent[] → markdown summary (Overview / Failures /
  Actions / Navigation). Wired into popup bug report and JSON
  download. NO LLM (PRD §22.1 explicitly v2+).
- **XHR perf benchmark** — bench/xhr-overhead.bench.ts mirrors the
  fetch bench. PRD §13.1 row 2 hard gate (< 0.5 ms p95). Observed
  delta ≈ 0.001 ms.
- **53 unit tests** — masking (29) + HAR (13) + narrative (11).

### Changed

- Badge counter now uses isErrorEvent (failed network +
  console.error + console.unhandled) instead of only failed
  network (PRD §6.2.1 detection-rule fanout).
- Settings General section's Capture tab no longer carries an
  "M1·W4" badge; it's live.
- README capture table refreshed: Tier 1 + Tier 2 marked ✅ for M2.

### Architecture

- New module src/lib/dom-descriptor.ts (TargetDescriptor builder).
- New module src/lib/narrative.ts (template renderer + tests).
- PageBridgeMessage + CaptureRuntimeMessage envelope gain optional
  redactions[] — page-world form masking ships its redactions to
  the service worker where they merge with SW-applied header / body
  redactions.

### Commits (16 on M2 branch)

```
feat(capture):   click event capture — W5-1
feat(capture):   form input capture + page-world form masking — W5-2
feat(capture):   console.error + window.error + unhandledrejection — W5-3
feat(capture):   navigation event in service worker — W5-4
feat(popup):     mixed timeline rendering — W5-5
feat(storage):   batched writes — 250 ms flush window — W6-1
feat(capture):   WebSocket frame metadata — W6-2
feat(capture):   console.warn + console.info — W6-3
feat(narrative): template-based narrative engine v1 — W6-4
feat(bench):     XHR overhead benchmark — W6-5
feat(storage):   closed-tab archive — 7-day TTL — W7-1
feat(capture):   SPA route change detection — W7-2
feat(settings):  Capture section UI + Tier 2 toggle + buffer cap — W7-3
chore(release):  M2 audit + CHANGELOG + README + version 0.2.0 — W7-4
chore(release):  CWS submission prep — W7-5
```

[0.2.0]: https://github.com/osmnnl/hindsight/releases/tag/v0.2.0

---

## [0.1.0] — 2026-05-18 — M1: Foundation

First milestone. The extension now installs, captures fetch + XHR
traffic faithfully, masks sensitive data at capture time, ships a
Settings UI for privacy controls, and exports captured sessions as
HAR 1.2 or JSON. Performance is gated in CI.

### Added

- **Capture pipeline** — Manifest V3 MV3 baseline, TypeScript end-to-end,
  CRXJS + Vite build. `network.fetch` and `network.xhr` events captured
  via page-world `createFetchPatch` / `createXhrPatch` and forwarded
  through an ISOLATED-world bridge to the service worker.
- **Unified event model** — `CapturedEvent` discriminated union covering
  20 EventType values across PRD §6.1.1 Tiers 1–4. Service worker is the
  central envelope minter (`id`, `sessionId`, `sequenceNumber`,
  `timestamp`, `tabId`, `url`).
- **Storage** — `chrome.storage.local` under PRD §6.1.3 keys
  (`sessions/{tabId}`, `sessions/{tabId}/events`); rolling 200-event
  buffer per tab; closed-tab cleanup on `tabs.onRemoved` and on full
  reload. Sequence counter persisted in `SessionMetadata.lastSequence`
  so a service-worker eviction never restarts at 1 mid-session.
- **Capture-time PII masking** (PRD §11.2) — engine in `src/lib/masking.ts`
  with default header / body / form rules: `Authorization`, `Cookie`,
  `Set-Cookie`, `X-API-Key`, `X-Auth-Token`, `Proxy-Authorization`,
  plus TCKN (with checksum) and credit card (with Luhn). Applied in
  the service worker before each event lands in storage;
  `meta.redactions` records every fired rule.
- **Settings UI** — `chrome.storage.sync`-backed options page with two
  live sections:
  - **General** — Theme preference (system / light / dark).
  - **Privacy** — Default rule chips (read-only), custom body regex
    CRUD with live compile-error feedback, per-domain blocklist
    (origins are dropped before reaching storage), and a live test
    sandbox that previews matches against arbitrary input.
- **Popup UI** — Filtered list (failed / all), per-event detail view
  with masked-headers projection, Copy bug report + image to
  clipboard, Download JSON, Download HAR, cURL formatter, server-error
  signal summary. New **Privacy panel** in the detail view surfaces
  `meta.redactions` so users see what was masked before sharing
  (PRD §11.4).
- **Exports** — HAR 1.2 mapper (`src/lib/har.ts`): query-string parse,
  Cookie / Set-Cookie name-value extraction, `_hindsight` envelope
  carrying eventId / sessionId / sequenceNumber. Reads as a normal HAR
  in Chrome DevTools, Firefox DevTools, Postman, Charles.
- **Performance gate** — `bench/fetch-overhead.bench.ts` runs in CI
  via `npm run bench`. 10,000 iterations with 500-iteration warmup;
  reports baseline / patched p50 / p95 / p99. Hard exit non-zero if
  p95 patch overhead > 0.5 ms (PRD §13.1). Observed locally: ≈0.01 ms
  delta p95 — about 50× under budget.
- **Test infrastructure** — Vitest 2 with 42 unit tests across the
  masking engine and HAR mapper. CI runs `npm test` on every push.
- **CI** — GitHub Actions: lint (ESLint 9 flat config), Prettier check,
  TypeScript --noEmit, build (Vite + CRXJS), test, bench, artifact
  upload of `dist/` per commit.

### Audited

- **Cookie leak via HAR `request.cookies` / `response.cookies`** (W4-5
  OQ-W4-C) — proven safe via unit tests:
  `extractCookies('***MASKED***')` returns `[]` because the masked
  placeholder has no `=`. Case-variant headers also covered.

### Deferred

- AI / LLM features — v2+ (PRD §22.1).
- Side panel UI, scrubber, detection rule engine, screenshot capture
  — M3.
- Recording mode (Tier 4), replay bundle, multi-destination sharing —
  M4.
- Header / form custom regex (UI schema supports it; engine wired
  only for body scopes today) — M2.
- Replay request, batched writes (PRD §13.1 perf strategy), closed-tab
  archive — M2/M3.

### Commits (16 on `feature/m1-foundation`)

```
docs:      add CLAUDE.md with conventions and PRD anchors
build:     scaffold TypeScript + Vite + CRXJS toolchain
refactor:  port capture extension to TypeScript under src/ and de-brand
feat:      add unified CapturedEvent type model per PRD §6.1.2
chore:     align manifest with PRD §9.2 baseline
ci:        add GitHub Actions build, lint, and type-check workflow
chore(deps): add package-lock.json from initial install
fix(m1):   pass strict lint and typecheck locally
style:     enforce Prettier across non-PRD files
feat(capture): end-to-end CapturedEvent pipeline on chrome.storage.local
feat(settings): Settings UI shell on chrome.storage.sync
build(test): add Vitest infrastructure
feat(masking): capture-time PII masking engine + 29 unit tests
feat(capture): apply masking engine in service worker (W3-1 part 2)
feat(settings): Privacy section UI — W3-3
feat(export): HAR 1.2 export — W3-2
refactor(interceptor): extract createFetchPatch + createXhrPatch
feat(bench): fetch overhead perf benchmark + CI gate
feat(storage): persist sequence counter in SessionMetadata
feat(popup): redactions panel in detail view (W4-3)
test(har): audit — masked Cookie / Set-Cookie do not leak (W4-5)
chore(release): M1 closeout
```

[0.1.0]: https://github.com/osmnnl/hindsight/releases/tag/v0.1.0
