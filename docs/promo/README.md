# Promo assets

Store images for Chrome Web Store, Firefox Add-ons and Edge Add-ons.
Flat colours only (no gradients), 24-bit PNG (no alpha channel).

| File                 | Size       | Slot                                                               |
| -------------------- | ---------- | ------------------------------------------------------------------ |
| `promo-440x280.png`  | 440 × 280  | CWS / Edge small promo tile (CWS: required)                        |
| `promo-1400x560.png` | 1400 × 560 | CWS marquee / Edge large promo tile (optional, used for featuring) |

The 1280 × 800 screenshots are not committed; they change with the UI.

## Regenerating

Everything here is rendered from the real built extension, so the tiles
and screenshots always show the current UI:

```sh
npm run build
PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
  node scripts/store-shots.mjs --out ~/Desktop/Hindsight-store --lang en,tr
cp ~/Desktop/Hindsight-store/en/marquee-1400x560.png docs/promo/promo-1400x560.png
cp ~/Desktop/Hindsight-store/en/small-tile-440x280.png docs/promo/promo-440x280.png
```

`scripts/store-shots.mjs` starts a local, fictional demo shop
(127.0.0.1, random port), drives a failing checkout, and screenshots
the popup, side panel, request detail, settings and the saved HTML
replay file. Playwright is not a dependency of this repo; point
`PLAYWRIGHT` at any install. Nothing in `scripts/` is part of the
extension package.

Brand colours: ink `#15161a`, paper `#f1eee3`, red `#e53935` (from
`icons/icon128.png`).
