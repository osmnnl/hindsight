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

CWS lets you upload up to 5 screenshots. **One** is mandatory.
Recommendation: ship 4, in this order (CWS shows them as a
carousel):

| #   | Surface                     | What it shows                                                             |
| --- | --------------------------- | ------------------------------------------------------------------------- |
| 1   | Side panel — failed cascade | The "moment of value" — three red 400 rows, cluster banner, scrubber lit. |
| 2   | Popup                       | Compact toolbar surface — event count, failure list, Open side panel CTA. |
| 3   | Replay bundle viewer        | Single-file HTML opened in a different browser, narrative panel visible.  |
| 4   | Settings → Privacy          | Default rules + per-rule disable chips + the danger banner.               |

#### How to capture each

For each screenshot:

1. Open Chrome at 1280 × 800 viewport (DevTools → Toggle device toolbar → "Responsive" set 1280×800).
2. Load the extension (`chrome://extensions` → Load unpacked → `dist/`).
3. Set up the surface you want to capture:
   - **Screenshot 1**: navigate to a site with a few real failures
     (e.g. a dev environment that returns 500s). Hit ● Record once
     to seed Tier 4 captures, then trigger the failures. Open the
     side panel.
   - **Screenshot 2**: same session, popup view.
   - **Screenshot 3**: side panel → ⤓ Save as replay bundle → open
     the downloaded `.html` in a new tab.
   - **Screenshot 4**: settings page, Privacy section, scroll so
     the danger banner is visible.
4. macOS: `Cmd-Shift-4` then space-bar to capture the window. The
   resulting PNG will have the system shadow — keep it, it reads
   well on the CWS gallery.
5. If the screenshot is wider than 1280 px (Retina), open it in
   Preview → Tools → Adjust Size → set width 1280, keep aspect.

Save them in `docs/screenshots/`:

```
docs/screenshots/
├── 1-sidepanel-cascade.png
├── 2-popup-summary.png
├── 3-replay-bundle.png
└── 4-settings-privacy.png
```

That directory is `.gitignore`d by default (binary blobs).

### Detailed description

Up to 16 000 characters, markdown supported. There's a starting
draft in [`CWS-LISTING.md`](./CWS-LISTING.md) — refine as needed.

### Privacy policy URL

✅ `docs/PRIVACY-POLICY.md` (also as `docs/privacy.html` for hosted
serving via GitHub Pages).

If you publish the site as `https://osmanunal.github.io/hindsight/`
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

CWS asks for one line per permission. Boilerplate:

| Permission         | Justification                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `storage`          | Persist captured events to the local per-tab buffer.                                            |
| `unlimitedStorage` | Allow > 5 MB buffers on long browsing sessions; pure local, never synced.                       |
| `activeTab`        | Inject the content script on the user's active tab to observe its network and console activity. |
| `scripting`        | Required by Manifest V3 to inject content scripts.                                              |
| `sidePanel`        | Primary inspection UI lives in chrome.sidePanel.                                                |
| `notifications`    | Optional. Surface "failure cascade" desktop notifications when the user enables that feature.   |
| `downloads`        | Optional. Save the replay bundle HTML and ZIP exports to disk.                                  |
| `tabs`             | Optional. Read tab metadata (URL, title) for sidepanel display.                                 |
| `webNavigation`    | Optional. Detect SPA route changes and full reloads to draw navigation lines.                   |
| `<all_urls>`       | Optional. Run the network/console interceptor on whatever page the user visits.                 |

---

## Optional — strengthens the listing

### Marquee promo tile, 1400 × 560

SVG mockup ready at `docs/promo/promo-1400x560.svg`. Convert to PNG
via `rsvg-convert` (see `docs/promo/README.md`). CWS only shows
marquee on featured listings — skippable for initial submission.

### Small promo tile, 440 × 280

SVG mockup ready at `docs/promo/promo-440x280.svg`. CWS uses this
in search-result thumbnails — worth shipping with v1.

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
# Then it's live at https://osmanunal.github.io/hindsight/
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
