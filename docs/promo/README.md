# Promo assets

Designer-ready SVG mockups for the Chrome Web Store listing.

## What's here

| File                 | Size       | CWS slot                                                                      |
| -------------------- | ---------- | ----------------------------------------------------------------------------- |
| `promo-440x280.svg`  | 440 × 280  | **Small promo tile — required.** Shows up in search results + featured grids. |
| `promo-1400x560.svg` | 1400 × 560 | **Marquee promo tile — optional.** Required only if you want to be featured.  |

The icons themselves (`icons/icon16.png`, `icon48.png`, `icon128.png`)
already ship inside the extension package at the repo root.

## Converting SVG → PNG

CWS accepts PNG and JPEG. Three ways to get there:

### 1. `rsvg-convert` (recommended — clean, scriptable)

```sh
brew install librsvg
cd docs/promo
rsvg-convert -w 440 -h 280 promo-440x280.svg -o promo-440x280.png
rsvg-convert -w 1400 -h 560 promo-1400x560.svg -o promo-1400x560.png
```

### 2. Chrome screenshot

1. Open the SVG file directly in Chrome (`file://...`).
2. Open DevTools → Cmd-Shift-P → "Capture full size screenshot".
3. Crop to exactly 440×280 / 1400×560 in any image editor (Preview's
   crop tool is fine).

### 3. Figma / Affinity Designer

Drop the SVG onto the canvas — both apps preserve the structure
and let you tweak the layout before exporting. The colours and font
stack already match the brand surface (popup / sidepanel / landing
page).

## What to replace before submission

The mockups are functional but a real product screenshot is
stronger. Once you have the extension loaded:

- Open the sidepanel mid-session with a few failed requests visible.
- Take a clean screenshot at 100% zoom.
- Drop it into the promo image where the mocked sidepanel currently
  sits (right column of `promo-1400x560`, lower half of
  `promo-440x280`).

The text block on the left is your hook — keep it short. CWS truncates
small-tile copy aggressively.
