// Content-script bridge — ISOLATED world.
//
// Receives RawCapture envelopes posted by the page-world interceptor
// and forwards them to the service worker. Both halves agree on the
// shape via src/lib/runtime-messages.ts.

import {
  CAPTURE_BRIDGE_TAG,
  type CaptureBatchRuntimeMessage,
  type PageBridgeMessage,
  type QueuedCapture,
  type RecordingState,
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

// ---------------------------------------------------------------------------
// Tier 4 gate (v0.6.2 perf fix). The page-world interceptor emits cursor
// and scroll captures unconditionally (cheap throttled listeners); the SW
// drops them when the tab isn't recording — but each one still cost a
// full runtime IPC + SW wake-up just to be discarded. Mirror the
// recording state here and drop them BEFORE the IPC instead.
// ---------------------------------------------------------------------------
let recording = false;

try {
  void chrome.runtime
    .sendMessage({ kind: 'GET_RECORDING' })
    .then((state: RecordingState | undefined) => {
      recording = state?.recording === true;
    })
    .catch(() => {
      /* SW asleep or unreachable — default stays false */
    });
} catch {
  /* extension context invalidated — ignore */
}

chrome.runtime.onMessage.addListener((msg: { kind?: string; recording?: boolean }) => {
  if (msg && msg.kind === 'RECORDING_STATE') recording = msg.recording === true;
});

// ---------------------------------------------------------------------------
// Capture batching (v0.6.2 perf fix). One chrome.runtime.sendMessage per
// capture meant one full serialization pass + SW wake-up per fetch,
// click, keystroke, and console call. Coalesce a flush window into a
// single CAPTURE_BATCH IPC; order within the batch is preserved.
// ---------------------------------------------------------------------------
const BATCH_FLUSH_MS = 250;
/** Bursts flush early so a busy page never builds a huge in-memory
 *  batch (and an error capture is never far behind its screenshot). */
const BATCH_MAX = 50;

let queue: QueuedCapture[] = [];
let flushTimer: number | null = null;

function flushQueue(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;

  const message: CaptureBatchRuntimeMessage = {
    kind: 'CAPTURE_BATCH',
    captures: queue,
    pageUrl: window.location.href,
    pageTitle: document.title,
  };
  queue = [];

  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      /* service worker may be inactive — drop silently */
    });
  } catch {
    /* extension context invalidated during reload — ignore */
  }
}

window.addEventListener('message', (event: MessageEvent<PageBridgeMessage>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== CAPTURE_BRIDGE_TAG) return;
  if (!data.capture) return;

  const type = data.capture.type;
  if (!recording && (type === 'cursor' || type === 'action.scroll')) return;

  queue.push({
    capture: data.capture,
    ...(data.redactions ? { redactions: data.redactions } : {}),
  });

  if (queue.length >= BATCH_MAX) {
    flushQueue();
    return;
  }
  if (flushTimer == null) flushTimer = window.setTimeout(flushQueue, BATCH_FLUSH_MS);
});

// Don't lose the tail of a session: flush pending captures when the page
// is being navigated away from or backgrounded.
window.addEventListener('pagehide', flushQueue);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushQueue();
});
