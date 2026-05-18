// Content-script interceptor — MAIN world (page context).
//
// Wires window.fetch and window.XMLHttpRequest through the patch
// factories from src/lib/network-patch.ts. Has no access to chrome.*
// APIs by design — emits RawCapture envelopes over window.postMessage
// to the ISOLATED-world bridge.

import { createFetchPatch, createXhrPatch } from '@/lib/network-patch';
import {
  CAPTURE_BRIDGE_TAG,
  type PageBridgeMessage,
  type RawCapture,
} from '@/lib/runtime-messages';

(() => {
  function post(capture: RawCapture): void {
    const message: PageBridgeMessage = { source: CAPTURE_BRIDGE_TAG, capture };
    try {
      window.postMessage(message, '*');
    } catch {
      /* silent */
    }
  }

  window.fetch = createFetchPatch(window.fetch, post);
  window.XMLHttpRequest = createXhrPatch(window.XMLHttpRequest, post);
})();
