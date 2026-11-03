# CWS media checklist

What Chrome Web Store requires versus what's strictly mandatory.
This document is for the human (you) — it covers the assets I can't
generate from a code editor (screenshots, demo video) and the
exact CWS form field they map to.

---

## Required by CWS — must have all of these

### 1× icon, 128 × 128 PNG

✅ Already in the package — `dist/icons/icon128.png`. No action needed.

### 1+ screenshot, 1280 × 800 **or** 640 × 400 PNG/JPEG

CWS lets you upload up to 5 screenshots; one is mandatory. Ship all 5,
in this order (the store shows them as a carousel). They are rendered
from the real built extension, not mocked:

```sh
npm run build
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  node scripts/store-shots.mjs --out ~/Desktop/Hindsight-store --lang en,tr
```

| #   | File                        | What it shows                                                           |
| --- | --------------------------- | ----------------------------------------------------------------------- |
| 1   | `screenshot-1-timeline.png` | Demo shop with a failed checkout next to the side panel timeline.       |
| 2   | `screenshot-2-request.png`  | The failed `POST /api/checkout` in full, Authorization and card masked. |
| 3   | `screenshot-3-share.png`    | The saved single-file HTML replay, opened as a recipient sees it.       |
| 4   | `screenshot-4-privacy.png`  | Settings → Privacy: default masking rules.                              |
| 5   | `screenshot-5-dark.png`     | Dark theme: side panel plus the toolbar popup over the page.            |

Each is 1280 × 800, 24-bit PNG without alpha, on a flat caption band
(no gradients). `--lang tr` renders the Turkish UI and captions for the
Turkish listing. Re-run after any UI change; the files are not
committed.

### Detailed description

Up to 16 000 characters, markdown supported. There's a starting
draft in [`CWS-LISTING.md`](./CWS-LISTING.md) — refine as needed.

### Privacy policy URL

✅ `docs/PRIVACY-POLICY.md` (also as `docs/privacy.html` for hosted
serving via GitHub Pages).

If you publish the site as `https://osmnnl.github.io/hindsight/`
the policy lives at `…/hindsight/privacy.html`.

### Single purpose statement

Required by CWS to justify permissions. Suggested text:

> "Capture browser activity (network requests, console messages,
> user actions, screenshots) in the background so the user can
> review and share a faithful bug report when something breaks. All
> data stays on the user's device unless they explicitly hit a
> Share button."

Paste verbatim into the "Single purpose description" field.

### Permission justifications

Full paste-ready text (EN, ≤ 1,000 chars each) is in
[`CWS-PRIVACY-FORM.md`](./CWS-PRIVACY-FORM.md) §2. One-line summary of
the 1.0.0 manifest:

| Permission                   | Justification                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `storage`                    | Keep each tab's captured events and the user's settings in chrome.storage.local.                  |
| `unlimitedStorage`           | Avoid quota errors before Hindsight's own caps (200 events / 2 MB per tab, 30 archived sessions). |
| `activeTab`                  | Screenshot the tab (tabs.captureVisibleTab) after the user invokes Hindsight on it.               |
| `sidePanel`                  | Main inspection UI.                                                                               |
| `notifications` (optional)   | Desktop alert on failure cascades; requested when the user enables it in Settings → Detection.    |
| content scripts `<all_urls>` | Observe each page's own fetch / XHR / console / user actions; no requests of their own.           |
| `<all_urls>` (optional host) | Replay only: one origin is requested at a time on first use; revocable in Settings → Privacy.     |

---

## Optional — strengthens the listing

### Marquee promo tile, 1400 × 560

`docs/promo/promo-1400x560.png`, rendered by `scripts/store-shots.mjs`
(see `docs/promo/README.md`). CWS only shows the marquee on featured
listings, but upload it anyway.

### Small promo tile, 440 × 280

`docs/promo/promo-440x280.png`, rendered by `scripts/store-shots.mjs`.
CWS uses it in search results and category grids.

### Demo video, 60–90 seconds

YouTube unlisted, embeddable in the CWS listing. Recommended flow:

1. **0:00–0:10 — Hook.** "How many times have you wished you could
   scroll back through time to see what your browser was doing
   before the bug?"
2. **0:10–0:30 — Install & forget.** Show install, toolbar icon
   appears, user browses normally for a few seconds. Counter ticks
   up silently.
3. **0:30–0:50 — Something breaks.** A 500 error fires on a dev
   site. User opens the side panel — scrubber, cluster banner,
   detail pane with masked auth header. Highlight the privacy
   modal.
4. **0:50–1:10 — Share.** Click ⤓ Save as replay bundle. Drag the
   downloaded `.html` into a fresh browser window — full session
   replays, no extension needed.
5. **1:10–1:30 — Brand close.** Three promises on screen, "no
   backend, no telemetry, MIT-licensed, install free."

Tools: macOS screen recording (`Cmd-Shift-5`), edited in iMovie or
ScreenFlow. Keep cursor visible. No music; soft voiceover ok.

### Landing page

✅ `docs/index.html` ready to serve. Publish to GitHub Pages:

```sh
# In repo settings → Pages → Source → main branch → /docs folder
# Then it's live at https://osmnnl.github.io/hindsight/
```

Point the CWS "Homepage URL" field at that URL.

---

## Pre-submit smoke test

Before clicking "Submit for review":

- [ ] Load the unpacked `dist/` once more, verify popup + sidepanel + settings + replay bundle all open
- [ ] Trigger a request, confirm Authorization is masked
- [ ] Disable Authorization rule in Settings → Privacy, re-trigger, confirm it's clear
- [ ] Save a replay bundle, open it in a separate browser profile (no extension installed), confirm it plays
- [ ] Open the ZIP — verify `report.md`, `session.json`, `session.har`, `replay.html` all present
- [ ] Disable verbose SW logs in Settings → Advanced (release default)

If any step fails, fix before submission. CWS rejections for "doesn't
do what it says" can take a week to re-review.
