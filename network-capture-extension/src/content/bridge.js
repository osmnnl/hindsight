// src/content/bridge.js
// Runs in ISOLATED world. Listens for postMessage from the page-world
// interceptor and forwards each capture to the service worker.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== '__nc_capture__') return;

  try {
    chrome.runtime.sendMessage({
      type: 'CAPTURE',
      payload: data.payload,
      pageUrl: window.location.href,
      pageTitle: document.title,
    }).catch(() => { /* service worker may be inactive — drop silently */ });
  } catch (e) {
    // Extension context invalidated during reload — ignore.
  }
});
