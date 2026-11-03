# M5 pre-launch checklist — evidence for 1.0.0

PRD §18.6 line by line. Status: ✅ done with evidence · 🟡 partly ·
⬜ open / owned elsewhere. Rows marked **(integrator)** are filled in
when the A, C, D and F workstream branches are merged.

Measured on branch `ws/b-release` (2026-11-03, Node 24, Apple Silicon).

## 1. Performance optimization (PRD §13.1)

| Target                                                   | Budget            | Measured (p95)     | Evidence                                | Status             |
| -------------------------------------------------------- | ----------------- | ------------------ | --------------------------------------- | ------------------ |
| `fetch()` patch overhead per call                        | < 0.5 ms          | 0.0066 ms          | `npm run bench:fetch`                   | ✅                 |
| `XMLHttpRequest` patch overhead                          | < 0.5 ms          | 0.0012 ms          | `npm run bench:xhr`                     | ✅                 |
| Header / body masking                                    | < 0.05 / 0.2 ms   | 0.0013 / 0.0029 ms | `npm run bench:masking`                 | ✅                 |
| Filter 1,000 events                                      | < 2 ms            | 0.25 ms            | `npm run bench:filter`                  | ✅                 |
| 20+ tabs, bounded storage                                | no SW crash       | pass               | `npm run bench:multitab`                | ✅ (0.7.x gate)    |
| Side panel first render, 1,000 events                    | < 200 ms          | not measured       | needs a Playwright timing bench         | ⬜ (integrator, C) |
| Click capture, injection time, memory, Lighthouse impact | §13.1 rows 3–5, 8 | not measured       | manual: Chrome Task Manager, Lighthouse | ⬜                 |

## 2. Accessibility audit (WCAG AA)

| Item                                                                | Evidence                                        | Status             |
| ------------------------------------------------------------------- | ----------------------------------------------- | ------------------ |
| Popup, side panel, settings: axe 0 serious                          | `tests/a11y/*` + CI axe job                     | ⬜ (integrator, C) |
| Replay viewer keyboard + focus                                      | D2                                              | ⬜ (integrator, D) |
| Welcome page: 44 px targets, visible focus, both themes, `lang` set | `src/welcome/welcome.css`, Playwright run below | ✅                 |
| Input rows read as "Email = …", not "<input> = …"                   | `src/lib/dom-descriptor.test.ts` (5 tests)      | ✅                 |

## 3. Security audit (CSP, input validation, dependencies)

| Item                                                                       | Evidence                                                                                                       | Status             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| Bundle payload escaping (stored XSS)                                       | A1                                                                                                             | ⬜ (integrator, A) |
| Other A items (detection, timestamps, lockfile / `npm ci`)                 | A2–A\*                                                                                                         | ⬜ (integrator, A) |
| Install permissions minimal: no `scripting`; optional only `notifications` | `manifest.json`, `grep -rn chrome.scripting src` → 0                                                           | ✅                 |
| Host access only per origin, on user action, revocable                     | `src/lib/permissions.ts` + 8 unit tests; Playwright: granted origin → Replay shows `500 Internal Server Error` | ✅                 |
| Replay of relative URLs no longer hits the extension origin                | `absoluteUrl` tests                                                                                            | ✅                 |
| CSP `script-src 'self'`, no remote code                                    | `manifest.json`, web-ext lint                                                                                  | ✅                 |
| Zero outbound requests of our own                                          | PRD §11.1; welcome page is local-only                                                                          | ✅                 |

## 4. Documentation site

| Item                                                                                                   | Status                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Site at https://osmnnl.github.io/hindsight/ (PRD says hindsight.dev; GitHub Pages is the decided host) | ✅ live                                          |
| Privacy page updated for 1.0.0 permissions                                                             | ✅ `docs/privacy.html`, `docs/PRIVACY-POLICY.md` |
| No gradients, cross-links between the three extension sites                                            | ⬜ (integrator, F)                               |

## 5. Marketing landing page

⬜ (integrator, F) — same site.

## 6. Demo video

🟡 Script ready: [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md). Recording is a
manual step.

## 7. Chrome Web Store submission

| Item                                                                         | Evidence                                                | Status    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------- | --------- |
| Description EN + TR, claims match 1.0.0 behaviour                            | `store/cws/description-*.txt`                           | ✅        |
| Permission justifications match the manifest                                 | `CWS-PRIVACY-FORM.md` §2 (6 entries, all < 1,000 chars) | ✅        |
| Images: 440×280, 1400×560, 5× 1280×800 (1 dark), RGB, no alpha, no gradients | `scripts/store-shots.mjs`                               | ✅        |
| Submitted / approved                                                         | dashboard                                               | ⬜ manual |

## 8. Edge Add-ons submission

| Item                                 | Evidence                 | Status    |
| ------------------------------------ | ------------------------ | --------- |
| Listing EN + TR, certification notes | `store/edge/`            | ✅        |
| 300×300 store logo                   | `store-logo-300x300.png` | ✅        |
| Submitted                            | Partner Center           | ⬜ manual |

## Firefox (not in PRD §18.6, shipped since 0.7.0)

| Item                                              | Evidence                                                                                              | Status |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| `browser_specific_settings.gecko`, sidebar_action | `dist-firefox/manifest.json`: gecko id, min 128, `data_collection_permissions: none`, no `side_panel` | ✅     |
| `web-ext lint`                                    | 0 errors, 29 warnings (26 innerHTML with escaped values, 3 `sidePanel.open` guarded)                  | ✅     |
| Listing, reviewer notes, source build steps       | `store/amo/`                                                                                          | ✅     |

## First-run onboarding (PRD §7.1)

Playwright, fresh Chromium profile with the built extension:

- launch 1: exactly one `welcome.html` tab; popup shows the side-panel
  hint; after the side panel is opened once the hint is gone.
- launch 2, same profile: no welcome tab (`onboarding/state` unchanged).

## Exit criteria

- [ ] Extension live on Chrome Web Store
- [ ] Documentation complete
- [ ] Launch announcement drafted

## Known gap found during this pass

**Error screenshots need `activeTab`.** `tabs.captureVisibleTab`
requires `<all_urls>` or `activeTab`; content-script matches don't
count. Without either it fails silently, so screenshots are only
attached on tabs where the user has clicked the icon, opened the panel
or used a shortcut (until that tab navigates). Store and privacy copy
now say exactly that. To make "screenshot on every error" true, add an
opt-in Settings toggle that requests `<all_urls>` from
`optional_host_permissions`; it is already declared.
