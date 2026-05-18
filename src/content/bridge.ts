// Content-script bridge — ISOLATED world.
//
// Listens for postMessage from the page-world interceptor and forwards each
// capture to the service worker.
//
// TODO(m1-w2): align CAPTURE_EVENT tag with src/types/events.ts envelope.

const CAPTURE_EVENT = '__nc_capture__';

interface CaptureMessage {
  source: typeof CAPTURE_EVENT;
  payload: unknown;
}

window.addEventListener('message', (event: MessageEvent<CaptureMessage>) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== CAPTURE_EVENT) return;

  try {
    void chrome.runtime
      .sendMessage({
        type: 'CAPTURE',
        payload: data.payload,
        pageUrl: window.location.href,
        pageTitle: document.title,
      })
      .catch(() => {
        /* service worker may be inactive — drop silently */
      });
  } catch {
    /* extension context invalidated during reload — ignore */
  }
});
