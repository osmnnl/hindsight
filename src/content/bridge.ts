// Content-script bridge — ISOLATED world.
//
// Receives RawCapture envelopes posted by the page-world interceptor
// and forwards them to the service worker. Both halves agree on the
// shape via src/lib/runtime-messages.ts.

import {
  CAPTURE_BRIDGE_TAG,
  type CaptureRuntimeMessage,
  type PageBridgeMessage,
} from '@/lib/runtime-messages';

// ---------------------------------------------------------------------------
// MAIN-world interceptor bootstrap (Firefox).
//
// On Chrome the manifest declares the interceptor as a world: "MAIN" content
// script and crxjs injects it directly. Firefox can't use that path: crxjs's
// MAIN-world loader does `import("./interceptor…")`, a relative specifier that
// Firefox resolves against the PAGE origin (not the extension), so the module
// 404s and nothing gets patched. For the Firefox build we strip the MAIN
// content script (vite.config.ts) and inject the interceptor here instead — a
// <script src="moz-extension://…/interceptor.js"> whose module base IS the
// extension, so its relative sub-imports resolve correctly. The interceptor
// self-runs on evaluation, so no further call is needed.
// ---------------------------------------------------------------------------
function bootstrapMainWorldInterceptor(): void {
  try {
    const manifest = chrome.runtime.getManifest();
    const hasMainContentScript = (manifest.content_scripts ?? []).some(
      (cs) => (cs as { world?: string }).world === 'MAIN'
    );
    // Chrome path: the manifest already injects the interceptor.
    if (hasMainContentScript) return;

    const war = (manifest.web_accessible_resources ?? []) as Array<{ resources?: string[] }>;
    let file: string | undefined;
    for (const entry of war) {
      file = entry.resources?.find(
        (r) => /(^|\/)interceptor\.ts-[^/]*\.js$/.test(r) && !r.endsWith('.map')
      );
      if (file) break;
    }
    if (!file) return;

    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL(file);
    script.addEventListener('load', () => script.remove());
    (document.head ?? document.documentElement).prepend(script);
  } catch {
    /* best-effort — never break the page */
  }
}

bootstrapMainWorldInterceptor();

window.addEventListener('message', (event: MessageEvent<PageBridgeMessage>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== CAPTURE_BRIDGE_TAG) return;
  if (!data.capture) return;

  const message: CaptureRuntimeMessage = {
    kind: 'CAPTURE',
    capture: data.capture,
    pageUrl: window.location.href,
    pageTitle: document.title,
    ...(data.redactions ? { redactions: data.redactions } : {}),
  };

  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      /* service worker may be inactive — drop silently */
    });
  } catch {
    /* extension context invalidated during reload — ignore */
  }
});
