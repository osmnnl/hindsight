# Changelog

All notable changes to Hindsight. Format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

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

[0.2.0]: https://github.com/osmanunal/hindsight/releases/tag/v0.2.0

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

[0.1.0]: https://github.com/osmanunal/hindsight/releases/tag/v0.1.0
