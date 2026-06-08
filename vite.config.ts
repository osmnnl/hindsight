import { defineConfig, type Plugin } from 'vite';
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import baseManifest from './manifest.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

// Permanent Firefox add-on identity. Required by addons.mozilla.org; do not
// change once the listing exists or AMO treats it as a different add-on.
const GECKO_ID = 'hindsight@osmnnl.github.io';

// Firefox has no Side Panel API and no MV3 service-worker background. Reshape
// the Chrome manifest into the gecko-flavoured equivalent at build time so the
// single source of truth stays in manifest.json.
function toFirefoxManifest(): ManifestV3Export {
  const m = structuredClone(baseManifest) as Record<string, unknown>;

  // MV3 background runs as an event-page script bundle, not a service worker.
  m.background = { scripts: ['src/background/service-worker.ts'], type: 'module' };

  // Side panel -> sidebar. We KEEP side_panel here so crxjs still treats
  // sidepanel.html as an HTML entry to bundle (its htmlFiles() scanner knows
  // side_panel.default_path but not sidebar_action.default_panel). The
  // Chrome-only side_panel key is then stripped from the emitted manifest by
  // dropSidePanelKey() below, so Firefox ships only sidebar_action.
  m.sidebar_action = {
    default_panel: 'src/sidepanel/sidepanel.html',
    default_title: 'Hindsight',
    default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' },
  };

  // sidePanel permission does not exist in Firefox.
  m.permissions = (m.permissions as string[]).filter((p) => p !== 'sidePanel');

  // gecko id + floor for content_scripts world:"MAIN" (Firefox 128+).
  // Hindsight is local-only with no telemetry, so it collects no user data
  // in Mozilla's sense (soon-mandatory data_collection_permissions key).
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  };

  return m as ManifestV3Export;
}

// Remove the Chrome-only side_panel key that we kept solely so crxjs would
// bundle sidepanel.html. Runs after the build is written to disk, so it edits
// the final emitted manifest regardless of crxjs's internal hook ordering.
function firefoxManifestFixups(outDir: string): Plugin {
  return {
    name: 'hindsight:firefox-manifest-fixups',
    apply: 'build',
    writeBundle() {
      const manifestPath = resolve(outDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      let changed = false;

      // 1. Drop the Chrome-only side_panel key (kept only so crxjs would
      //    bundle sidepanel.html). Firefox ships sidebar_action instead.
      if (manifest.side_panel) {
        delete manifest.side_panel;
        changed = true;
      }

      // 2. Remove the world: "MAIN" content script. crxjs has already built
      //    the interceptor chunk + listed it in web_accessible_resources;
      //    the MAIN-world LOADER it generates uses a relative dynamic import
      //    (`import("./interceptor…")`) that Firefox resolves against the
      //    PAGE origin, not the extension, so the module 404s and capture
      //    silently breaks. Instead the ISOLATED bridge injects the
      //    interceptor via a moz-extension <script> (see bridge.ts), where
      //    relative sub-imports resolve correctly.
      if (Array.isArray(manifest.content_scripts)) {
        const next = manifest.content_scripts.filter(
          (cs: { world?: string }) => cs.world !== 'MAIN'
        );
        if (next.length !== manifest.content_scripts.length) {
          manifest.content_scripts = next;
          changed = true;
        }
      }

      if (changed) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}

// `vite build --mode firefox` selects the Firefox target; default is Chrome.
export default defineConfig(({ mode }) => {
  const isFirefox = mode === 'firefox';
  const outDir = isFirefox ? 'dist-firefox' : 'dist';

  return {
    plugins: [
      crx({
        manifest: isFirefox ? toFirefoxManifest() : (baseManifest as ManifestV3Export),
        browser: isFirefox ? 'firefox' : 'chrome',
      }),
      ...(isFirefox ? [firefoxManifestFixups(outDir)] : []),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Surfaced in TS via `declare const __APP_VERSION__: string;`
      // Single source of truth: package.json version field.
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // Keep the two builds in separate trees so they never clobber.
      outDir,
      rollupOptions: {
        output: {
          // CRXJS handles entry/chunk naming; we just want deterministic asset names.
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
