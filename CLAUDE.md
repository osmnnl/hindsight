# CLAUDE.md — Hindsight

Working guidance for Claude (and humans) contributing to this repo.

> **Source of truth:** [`Hindsight-PRD-v0.1.md`](./Hindsight-PRD-v0.1.md).
> When the PRD and this file disagree, the PRD wins. Update both in the
> same PR when the disagreement is real.

---

## 1. What this project is

Hindsight is a privacy-first, open-source Chrome MV3 extension that
passively records browser activity (network, console, actions,
screenshots) so users can scrub back through time and export a
shareable bug report. No backend, no telemetry, no signup. See PRD §0.

**Killer differentiator** (PRD §5): single self-contained HTML replay
bundle — works offline, no recipient setup.

**Three brand promises** (PRD §4) — every architectural choice must
defend these:

1. **No information loss** — never silently truncate, denoise, or
   "smart summarize" captures in storage.
2. **Your data does not leave your machine unless you choose** — no
   outbound traffic from the extension except user-initiated.
3. **Zero setup, useful from minute one** — defaults work, settings
   are for power users.

---

## 2. Stack

- **Language:** TypeScript (strict)
- **Bundler:** Vite + [`@crxjs/vite-plugin`](https://crxjs.dev/vite-plugin) for MV3 HMR
- **Lint/format:** ESLint flat config + Prettier
- **Git hooks:** Husky + lint-staged (pre-commit lint + type-check)
- **CI:** GitHub Actions — build, lint, type-check on every PR
- **Target browsers (v1):** Chromium (Chrome, Edge). Firefox post-launch.
- **No frameworks in capture path.** Popup/side panel UI is currently
  vanilla DOM; React/Vue adoption is a deliberate later decision, not
  a default.

---

## 3. Repo layout

```
/                              repo root
├── Hindsight-PRD-v0.1.md      product spec (read this first)
├── CLAUDE.md                  this file
├── manifest.json              MV3 manifest (PRD §9.2 baseline)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .github/workflows/         CI pipelines
├── src/
│   ├── types/                 shared type definitions
│   │   └── events.ts          CapturedEvent + EventType (PRD §6.1.2)
│   ├── background/            MV3 service worker
│   ├── content/               content scripts (MAIN + ISOLATED)
│   ├── popup/                 toolbar popup UI
│   └── sidepanel/             chrome.sidePanel UI (added in M3)
└── dist/                      build output — load-unpacked target
```

---

## 4. PRD anchors — the load-bearing references

When in doubt, open these:

| Topic | Anchor |
|---|---|
| Unified event model (`CapturedEvent`, `EventType`) | PRD **§6.1.2** |
| MV3 manifest baseline (permissions, optional perms, CSP, commands) | PRD **§9.2** |
| Capture tiers (what's default-on vs opt-in vs recording-only) | PRD §6.1.1 |
| Per-tab storage model (keys, eviction, batching) | PRD §6.1.3 |
| Privacy & PII redaction (capture-time, not export-time) | PRD §11.2 |
| Performance budget (must pass in CI) | PRD §13.1 |
| Roadmap (M1–M5) | PRD §18 |

`src/types/events.ts` is the canonical implementation of §6.1.2.
`manifest.json` is the canonical implementation of §9.2. Both files
should cite the section in a header comment.

---

## 5. House rules (non-negotiable)

### 5.1 Do NOT introduce Datasoft references

The codebase was forked from a Datasoft-internal QA tool. **All
Datasoft branding, copy, hostnames, and HR-specific examples are
being removed.** Do not re-introduce them — not in code, not in
strings, not in comments, not in test fixtures, not in commit
messages. Brand name is **Hindsight**. UI copy is generic.

If you grep for `datasoft`, `Datasoft`, `DATASOFT`, or `HR` in a
domain-specific sense and find a hit, it's a bug.

### 5.2 Privacy is architectural, not aspirational

- The extension makes **zero** outbound network requests except
  ones the user explicitly initiated (webhook POST, web intent
  navigation, file download).
- No telemetry. Ever. Not even "anonymous usage stats." See PRD §4.2,
  §11.1, §19.1.
- PII masking happens at **capture time**, not export time
  (PRD §11.2). The masked value is never written to storage.

### 5.3 No information loss in storage

Truncation may happen at *export time* for hard destination limits
(Slack paste), but the local capture is always faithful and
recoverable. Don't "clean up" payloads on the way in.

### 5.4 MV3 best practices

- Service worker is event-driven — never assume it's alive between
  events. Persist state to `chrome.storage`, not module globals.
- Strict CSP — no `eval`, no `Function()`, no inline scripts, no
  remote code, no `innerHTML` with untrusted data (use
  `textContent` or a vetted escaper).
- Permissions are progressive. Only `storage`, `unlimitedStorage`,
  `activeTab`, `scripting`, `sidePanel` are install-time required.
  Everything else is in `optional_permissions` /
  `optional_host_permissions` and requested at feature activation.
- Content scripts: page-world (MAIN) does the patching;
  isolated-world (ISOLATED) is the bridge to the service worker via
  `chrome.runtime.sendMessage`. They communicate via
  `window.postMessage` with a namespaced source tag.

### 5.5 Performance is a release criterion

PRD §13.1 sets hard targets (fetch overhead < 0.5ms, side-panel
render with 1000 events < 200ms, etc.). Failing perf benchmarks
block merge once the benchmark suite lands.

---

## 6. Coding conventions

- TypeScript strict mode on. No `any` without a `// reason:`
  comment. Prefer discriminated unions over enums for event types.
- File naming: `kebab-case.ts` for modules, `PascalCase.ts` only
  if the file's default export is a class/component.
- Imports: relative within a feature folder, alias-rooted across
  features once the path alias is set up (`@/types/events`).
- Don't add comments that restate the code. Do add a one-line
  *why* when a non-obvious constraint, workaround, or PRD anchor
  is involved. Reference sections like `// PRD §6.1.2`.
- Error handling: at system boundaries only. Trust internal
  invariants; don't defensively wrap your own code.

---

## 7. Git workflow

- Branch from `main`, never commit to `main` directly during M1.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`,
  `chore:`, `build:`, `ci:`, `test:`, `perf:`.
- One logical change per commit. Big-bang refactors are forbidden.
- PRs reference the milestone (e.g. `[M1]`) and the PRD sections
  touched.
- Repo stays **private** through M2; first public push is the
  M2-end unlisted CWS beta (per OQ-3).

---

## 8. What's deferred (don't build these in M1)

Per PRD §8 (Non-Goals) and §18 (Roadmap):

- AI/LLM features — deferred to v2 entirely.
- Backend, cloud sync, user accounts — never.
- Side panel UI — arrives in M3.
- Recording mode + Tier 4 captures — arrives in M4.
- Replay bundle generator — arrives in M4.
- Plugin marketplace UI — v3+.

If a request would build any of the above, say so and stop.
