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
