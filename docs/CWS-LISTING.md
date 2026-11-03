# Store submission runbook — 1.0.0 (public)

One page for publishing Hindsight 1.0.0 on the Chrome Web Store,
Firefox Add-ons (AMO) and Microsoft Edge Add-ons. The paste-ready text
lives in [`store/`](../store/) and the two CWS form docs; this file
says which file goes where and in what order.

A Turkish, field-by-field walkthrough of the same steps is generated
next to the store images as `YAYIN-ADIMLARI.html`.

| What                                             | Source                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| CWS description (EN / TR)                        | [`store/cws/description-en.txt`](../store/cws/description-en.txt), [`-tr.txt`](../store/cws/description-tr.txt) |
| CWS privacy tab (purpose, permissions, data use) | [`CWS-PRIVACY-FORM.md`](./CWS-PRIVACY-FORM.md)                                                                  |
| AMO listing, reviewer notes, source build        | [`store/amo/`](../store/amo/)                                                                                   |
| Edge listing (EN / TR)                           | [`store/edge/`](../store/edge/)                                                                                 |
| Images                                           | `node scripts/store-shots.mjs` — see [`promo/README.md`](./promo/README.md)                                     |
| Release checklist with evidence                  | [`M5-CHECKLIST.md`](./M5-CHECKLIST.md)                                                                          |
| 60-second demo                                   | [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md)                                                                            |

---

## 1. Package

CI builds `hindsight-${VERSION}-${SHORT_SHA}.zip` on every push and
uploads it as the **`hindsight-cws-zip-${SHA}`** artifact. Use that
zip for Chrome and Edge. Don't zip `dist/` by hand — the artifact is a
zip of the contents, not of the folder.

Firefox: `npm run build:firefox && npm run lint:firefox && npm run
package:firefox` → `release/hindsight-firefox-v1.0.0.zip`, plus a
source archive (`git archive --format=zip -o
hindsight-1.0.0-source.zip v1.0.0`).

## 2. Manifest the reviewers will see (1.0.0)

| Field                       | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| `permissions`               | `storage`, `unlimitedStorage`, `activeTab`, `sidePanel` |
| `optional_permissions`      | `notifications`                                         |
| `host_permissions`          | none                                                    |
| `optional_host_permissions` | `<all_urls>` — requested one origin at a time by Replay |
| `content_scripts.matches`   | `<all_urls>` (MAIN interceptor + ISOLATED bridge)       |

Removed in 1.0.0: `scripting`, optional `downloads`, `tabs`,
`webNavigation`. If the CWS dashboard still shows justification boxes
for them, they disappear after the new zip is uploaded; don't fill them.

## 3. Chrome Web Store

1. Developer Dashboard → Hindsight → **Package** → Upload new package.
2. **Store listing**: description from `store/cws/description-en.txt`;
   add Türkçe and paste `description-tr.txt`. Category Developer Tools.
   Upload the 128 icon, `small-tile-440x280.png`,
   `marquee-1400x560.png` and the five screenshots (per language: `en/`,
   `tr/`).
3. **Privacy**: follow `CWS-PRIVACY-FORM.md` §1–§6 top to bottom.
4. **Distribution**: Public, all regions.
5. Submit for review. Review takes hours to a couple of weeks; don't
   announce a date before approval.

## 4. Firefox Add-ons

1. Developer Hub → Hindsight → **Upload new version** → the Firefox zip.
2. Answer "yes" to "Do you need to submit source code?" and upload the
   source archive. Paste the reviewer notes from
   `store/amo/listing-en.md`.
3. Edit product page with the EN and TR texts from `store/amo/`.

## 5. Microsoft Edge Add-ons

1. Partner Center → Edge → Hindsight (or **Create new extension**) →
   Packages → upload the Chrome zip.
2. Properties, store listings (EN + TR) and certification notes from
   `store/edge/`. Edge needs a 300 × 300 store logo:
   `store-logo-300x300.png`.
3. Publish.

## 6. After approval

- Tag `v1.0.0`, publish the GitHub release with the CHANGELOG entry and
  the three zips.
- Update the store links on the website and in the README.
