# CLAUDE.md — Hindsight

Behavioral guidelines + Hindsight-specific rules. Inspired by
[Karpathy's observations](https://x.com/karpathy/status/2015883857489522876)
on LLM coding pitfalls.

> **Source of truth:** [`Hindsight-PRD-v0.1.md`](./Hindsight-PRD-v0.1.md).
> When the PRD and this file disagree, the PRD wins. Update both
> in the same PR when the disagreement is real.

**Tradeoff:** these guidelines bias toward caution over speed. For
trivial tasks, use judgment.

---

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- Read the PRD section that governs the area you're touching
  before proposing a change.

---

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios. Trust internal
  invariants; validate only at system boundaries.
- If you write 200 lines and it could be 50, rewrite it.

**The test:** would a senior engineer say this is overcomplicated?
If yes, simplify.

---

## 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

**The test:** every changed line should trace directly to the
user's request or to the PRD anchor that justifies it.

---

## 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add masking rule" → "Write a masking test that fails, then
  make it pass."
- "Fix the cascade banner" → "Write a detection test that
  asserts the new flag, then make it pass."
- "Refactor X" → "All 125+ tests still pass; bench gates still
  green."

For any multi-step task, state a brief plan before code:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

CI gates that count as verification:

```
npm run typecheck    npm run lint         npm run format:check
npm test             npm run build        npm run bench
```

All six must pass before a merge. `npm run bench` is the hard
PRD §13.1 perf gate (fetch + XHR + masking + filter, p95 budgets).

---

## 5. Hindsight-specific rules

### 5.1 Privacy is architectural, not aspirational

- **Zero outbound network requests** except ones the user
  explicitly initiated (webhook POST, web intent navigation,
  file download). See PRD §4.2, §11.1, §19.1.
- **No telemetry. Ever.** Not even "anonymous usage stats."
- **PII masking happens at capture time**, not export time
  (PRD §11.2). The masked value is never written to storage.

### 5.2 No information loss in storage

Truncation may happen at _export time_ for hard destination
limits (e.g. Slack 3000 chars). The local capture is always
faithful and recoverable. Don't "clean up" payloads on the
way in.

### 5.3 MV3 best practices

- Service worker is event-driven — never assume it's alive
  between events. Persist state to `chrome.storage`, not
  module globals.
- Strict CSP — no `eval`, no `Function()`, no inline scripts,
  no remote code, no `innerHTML` with untrusted data (use
  `textContent` or the existing `escapeHtml` / `escapeAttr`
  helpers).
- Permissions are progressive. Only `storage`,
  `unlimitedStorage`, `activeTab`, `scripting`, `sidePanel`
  are install-time required. Everything else goes in
  `optional_permissions` / `optional_host_permissions` and
  is requested at feature activation.
- Content scripts: page-world (`MAIN`) does the patching;
  isolated-world (`ISOLATED`) is the bridge to the service
  worker. They communicate via `window.postMessage` with a
  namespaced source tag.

### 5.4 Performance is a release criterion

PRD §13.1 sets hard targets (fetch overhead p95 < 0.5 ms,
1000-event side-panel render < 200 ms, etc.). Benches block
merge. Don't add allocations on the capture hot path without
re-running `npm run bench:fetch` + `bench:xhr` + `bench:masking`.

### 5.5 No Datasoft references

The codebase was forked from a Datasoft-internal QA tool. **All
Datasoft branding, copy, hostnames, and HR-specific examples
were removed.** Do not re-introduce them — not in code,
strings, comments, test fixtures, or commit messages.

If you grep `datasoft` / `Datasoft` / `DATASOFT` and find a
hit, it's a bug.

---

## 6. Stack at a glance

- **Language:** TypeScript (strict). No `any` without a
  `// reason:` comment. Discriminated unions over enums.
- **Bundler:** Vite + [`@crxjs/vite-plugin`](https://crxjs.dev/vite-plugin)
  for MV3 HMR.
- **Tests:** Vitest 4. **Benches:** tsx-driven scripts under
  `bench/` (CI-gated).
- **Lint/format:** ESLint flat config + Prettier; Husky +
  lint-staged on pre-commit.
- **Target browsers (v1):** Chromium (Chrome, Edge). Firefox
  post-launch.
- **No frameworks in the capture path.** Popup / side panel UI
  is vanilla DOM; React/Vue adoption is a deliberate later
  decision, not a default.

---

## 7. Repo layout

```
/                            repo root
├── Hindsight-PRD-v0.1.md    product spec — read this first
├── CLAUDE.md                this file
├── CHANGELOG.md             release-by-release history
├── manifest.json            MV3 manifest (PRD §9.2 baseline)
├── vite.config.ts
├── .github/workflows/       CI pipelines
├── bench/                   tsx perf benches (CI gates)
├── src/
│   ├── types/events.ts      CapturedEvent + EventType (PRD §6.1.2)
│   ├── background/          MV3 service worker
│   ├── content/             MAIN + ISOLATED content scripts
│   ├── lib/                 storage, masking, detection,
│   │                        narrative, formatters/, destinations/
│   ├── popup/               toolbar popup UI
│   ├── settings/            options page
│   └── sidepanel/           chrome.sidePanel UI
└── dist/                    build output — load-unpacked target
```

---

## 8. PRD anchors — load-bearing references

When in doubt, open these:

| Topic                                                | Anchor         |
| ---------------------------------------------------- | -------------- |
| Unified event model (`CapturedEvent`, `EventType`)   | PRD **§6.1.2** |
| MV3 manifest baseline                                | PRD **§9.2**   |
| Capture tiers (default-on / opt-in / recording-only) | PRD §6.1.1     |
| Per-tab storage model                                | PRD §6.1.3     |
| Privacy & PII redaction (capture-time)               | PRD §11.2      |
| Performance budget (CI-gated)                        | PRD §13.1      |
| Roadmap (M1–M5)                                      | PRD §18        |

`src/types/events.ts` is the canonical implementation of §6.1.2.
`manifest.json` is the canonical implementation of §9.2. Both
files should cite the section in a header comment.

---

## 9. Git workflow

- Branch from `main`. Never commit to `main` directly.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`,
  `chore:`, `build:`, `ci:`, `test:`, `perf:`.
- One logical change per commit. Big-bang refactors are
  forbidden.
- PR / commit body references the milestone (e.g. `M5 W11`)
  and the PRD sections touched.

---

## 10. What's deferred

Per PRD §8 (Non-Goals) and §18 (Roadmap):

- AI/LLM features — v2+.
- Backend, cloud sync, user accounts — never.
- Plugin marketplace UI — v3+.

If a request would build any of the above, say so and stop.

---

## 11. Where we are now

See [CHANGELOG.md](./CHANGELOG.md) for the full release history.
Current state: **v0.7.3**. M5 (pre-launch polish) in flight; next
milestone is CWS public submission → `v1.0.0`.

---

**These guidelines are working if:** diffs are surgical, fewer
rewrites due to overcomplication, and clarifying questions come
before implementation rather than after mistakes.
