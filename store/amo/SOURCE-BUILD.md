# Building the Firefox package from source

Reviewers: these steps reproduce `hindsight-firefox-v1.0.0.zip`
byte-for-byte apart from zip timestamps.

Requirements: Node.js 20 or newer, npm 10 or newer, macOS or Linux.

```sh
npm ci
npm run build:firefox          # tsc --noEmit && vite build --mode firefox → dist-firefox/
npm run lint:firefox           # web-ext lint: 0 errors expected
npm run package:firefox        # → release/hindsight-firefox-v1.0.0.zip
```

- Bundler: Vite 6 with `@crxjs/vite-plugin`; TypeScript sources in
  `src/`, entry points declared in `manifest.json`, one extra page
  (`src/welcome/welcome.html`) in `vite.config.ts`.
- The Firefox build rewrites the manifest at build time
  (`vite.config.ts` → `firefoxManifestFixups`): `side_panel` becomes
  `sidebar_action`, `browser_specific_settings.gecko` is added
  (`strict_min_version` 128, `data_collection_permissions: none`).
- No code is downloaded at build or run time. All dependencies are
  pinned in `package-lock.json`.
