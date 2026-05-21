# Hindsight

> DevTools you didn't open. Privacy-first passive capture for bug reports.

A Chrome (MV3) extension that silently records browser activity in the
background — network requests, console errors, user actions — so when
something breaks, you can scrub back through what just happened and
share a complete, faithful bug report.

No backend, no signup, no telemetry. Open source under MIT.

**Status:** M4 milestone shipped at `v0.4.0` (May 2026). The
killer-differentiator standalone HTML replay bundle, recording mode
with Tier 4 captures, multi-destination sharing hub (Slack / Discord /
Teams webhooks + GitHub Issue / mailto web intents), ZIP-everything
export, "Replay this request" and a privacy preview modal are all
live. M5 is pre-launch polish (perf + a11y + security audits, CWS
public submission).

---

## What this captures

The capture system is organized into four tiers (PRD §6.1.1). The
extension's M1 build only activates Tier 1; the rest light up as their
respective milestones land.

| Tier                   | Events                                                                               | Default | M1             | M2              | M3     | M4     |
| ---------------------- | ------------------------------------------------------------------------------------ | ------- | -------------- | --------------- | ------ | ------ |
| **1 — Essential**      | `fetch`, `XMLHttpRequest`, page navigations, console errors / unhandled rejections   | on      | ✅ fetch / XHR | + console + nav | refine | refine |
| **2 — Important**      | Clicks, form input changes, WebSocket frames, console warn/info                      | on      | —              | ✅              | refine | refine |
| **3 — Conditional**    | Page screenshots on error, performance long tasks, layout shifts, Server-Sent Events | trigger | —              | —               | ✅     | refine |
| **4 — Recording mode** | Periodic screenshots, cursor trail, scroll, DOM mutations, tab focus                 | opt-in  | —              | —               | —      | ✅     |

Captured events are stored per tab in `chrome.storage.local` under
`sessions/{tabId}/events` (PRD §6.1.3). The buffer holds the most recent
200 events per tab by default (50 / 200 / 500 / 2000 user-selectable in
Settings → Capture); FIFO eviction past that. Closing a tab moves its
session into `archives/recent` with a 7-day TTL. Storage writes batch
at 250 ms (PRD §13.2). The Tier 2 capture families can be turned off
collectively in Settings → Capture; Tier 1 cannot.

---

## Privacy

Three architectural commitments (PRD §4):

1. **No information loss** — captures are stored verbatim. Truncation
   happens only at export time for hard destination limits (e.g.
   Slack's paste cap), never in storage.
2. **Your data does not leave your machine unless you choose** — the
   extension makes zero outbound requests of its own. Webhooks, web
   intents, and file downloads are user-initiated only.
3. **Zero setup, useful from minute one** — defaults work; settings
   exist for power users.

### How masking works (PRD §11.2)

Sensitive values are replaced with `***MASKED***` **at capture time**,
inside the service worker, before anything is written to storage. The
original value is never persisted and cannot be recovered.

Default rules:

- **Headers** — `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`,
  `X-Auth-Token`, `Proxy-Authorization` (case-insensitive).
- **Body content** — TCKN (Turkish national ID with checksum
  validation), credit card numbers (with Luhn validation; 13–19 digit
  runs).
- **Form fields** _(active when Tier 2 input capture ships in M2)_ —
  `<input type="password">`, `autocomplete^="cc-"`, and names matching
  `password|secret|token|ssn|pin`.

Custom regex patterns and a per-domain blocklist are configured under
**Settings → Privacy**. Both ship in M1.

Every event in the popup detail view shows a **Privacy** panel
summarising what was masked. The HAR / JSON export reflects the same
masked values — there is no second pass at export time, because there
is nothing to mask: the data was already clean when it landed in
storage.

---

## Quick start (development build)

The extension is not yet on the Chrome Web Store. For now:

```sh
# 1. Install deps
nvm use            # picks up Node 20 from .nvmrc (Node ≥20 works)
npm install

# 2. Produce a load-unpackable build
npm run build      # writes dist/

# 3. Load in Chrome
#    chrome://extensions → Developer mode → Load unpacked → select dist/
```

Useful scripts during development:

```sh
npm run dev        # Vite + CRXJS with HMR for the popup / settings UIs
npm run lint
npm run format:check
npm run typecheck
npm test           # Vitest — currently 42 unit tests
npm run bench      # PRD §13.1 fetch overhead gate (CI-blocking)
```

CI (.github/workflows/ci.yml) runs all of the above on every push and
PR to `main`, plus uploads the built `dist/` as an artifact for each
commit so reviewers can load-unpack a PR build without checking out.

---

## Roadmap

The full plan lives in [`Hindsight-PRD-v0.1.md`](./Hindsight-PRD-v0.1.md)
§18. M1 has just closed.

| Milestone                             | Theme                                                                                                                               | Status    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **M1 — Foundation**                   | TS port, CapturedEvent model, manifest §9.2 baseline, masking engine, Settings + Privacy UI, HAR export, perf gate                  | ✅ v0.1.0 |
| **M2 — Context capture**              | Tier 2 events (clicks, inputs, console, nav, WebSocket, SPA routes), narrative engine v1, batched writes, archive, Capture settings | ✅ v0.2.0 |
| **M3 — Side panel + visual timeline** | `chrome.sidePanel` migration, scrubber, screenshot capture, detection rule engine, cluster grouping, recent-archive viewer          | ✅ v0.3.0 |
| **M4 — Replay bundle + sharing hub**  | Standalone HTML viewer, recording mode, multi-destination sharing (Slack / Discord / Teams / GitHub / Linear / email / Notion)      | next      |
| **M5 — Pre-launch polish**            | Performance optimization, WCAG AA audit, security audit, CWS submission                                                             | —         |

AI / LLM integration is **explicitly deferred to v2+** (PRD §22.1).

---

## Architecture

```
┌─ Page world (MAIN) ──────────────┐
│  interceptor.ts                  │
│  • createFetchPatch              │ window.postMessage
│  • createXhrPatch                │──────────────────┐
│  (src/lib/network-patch.ts)      │                  │
└──────────────────────────────────┘                  ▼
                                      ┌─ Isolated world ─┐
                                      │  bridge.ts       │
                                      └─────────┬────────┘
                                                │ chrome.runtime
                                                ▼
┌─ Service worker ──────────────────────────────────────┐
│  service-worker.ts                                    │
│  • Privacy: maskHeaders + maskBody + origin blocklist │
│  • Envelope minter: id / sessionId / sequence / ts    │
│  • Storage: appendEvent → chrome.storage.local        │
│  (src/lib/storage.ts · src/lib/masking.ts)            │
└────────────────────┬──────────────────┬───────────────┘
                     │                  │
                     ▼                  ▼
┌─ Popup ──────────────────┐  ┌─ Settings (options_ui) ─┐
│  • Filtered list         │  │  • General (theme)      │
│  • Detail view           │  │  • Privacy              │
│  • Privacy panel         │  │    — default chips      │
│  • Copy / Download /     │  │    — custom patterns    │
│    HAR export            │  │    — origin blocklist   │
└──────────────────────────┘  │    — test sandbox       │
                              └─────────────────────────┘
```

The PRD anchors used most often:

- `src/types/events.ts` implements **PRD §6.1.2** (CapturedEvent model)
- `manifest.json` matches **PRD §9.2** baseline
- `src/lib/storage.ts` is **PRD §6.1.3** (per-tab keys, eviction)
- `src/lib/masking.ts` is **PRD §11.2** (capture-time PII masking)
- `bench/fetch-overhead.bench.ts` enforces **PRD §13.1** (perf budget)

See [`CLAUDE.md`](./CLAUDE.md) for contributor conventions.

---

## License

MIT. See [LICENSE](./LICENSE) (added at first public push).

---

## Author

Osman Unal · solo project · built part-time at 5–8 hours/week.
