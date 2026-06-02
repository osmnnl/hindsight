import { defineConfig } from 'vite';
import { crx, type ManifestV3Export } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
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

  // Side panel -> sidebar.
  delete m.side_panel;
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

// `vite build --mode firefox` selects the Firefox target; default is Chrome.
export default defineConfig(({ mode }) => {
  const isFirefox = mode === 'firefox';

  return {
    plugins: [
      crx({
        manifest: isFirefox ? toFirefoxManifest() : (baseManifest as ManifestV3Export),
        browser: isFirefox ? 'firefox' : 'chrome',
      }),
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
      outDir: isFirefox ? 'dist-firefox' : 'dist',
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
