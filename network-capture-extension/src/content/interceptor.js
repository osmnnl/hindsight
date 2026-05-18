// src/content/interceptor.js
// Runs in MAIN world (page context). Patches fetch + XMLHttpRequest so we can
// observe requests including response bodies. Posts the captured payload to the
// ISOLATED content script bridge via window.postMessage.

(() => {
  const CAPTURE_EVENT = '__nc_capture__';

  // ---------- fetch patch ----------
  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(input, init) {
    const startedAt = Date.now();
    const requestId = (crypto.randomUUID && crypto.randomUUID()) || String(startedAt + Math.random());

    let url, method, requestHeaders, requestBody;
    try {
      if (input instanceof Request) {
        url = input.url;
        method = (init?.method || input.method || 'GET').toUpperCase();
        requestHeaders = headersToObject(init?.headers || input.headers);
        // Body of a Request is a ReadableStream — best effort
        requestBody = init?.body != null ? serializeBody(init.body) : '[Request body not captured]';
      } else {
        url = String(input);
        method = (init?.method || 'GET').toUpperCase();
        requestHeaders = headersToObject(init?.headers || {});
        requestBody = serializeBody(init?.body);
      }
    } catch (e) {
      url = String(input);
      method = 'UNKNOWN';
      requestHeaders = {};
      requestBody = null;
    }

    let response;
    let networkError = null;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (err) {
      networkError = String(err && (err.stack || err.message || err));
    }

    // Read response without consuming the original
    let responseBody = null;
    let responseHeaders = {};
    let status = 0;
    let statusText = '';
    if (response) {
      try {
        responseHeaders = headersToObject(response.headers);
        status = response.status;
        statusText = response.statusText;
        const cloned = response.clone();
        responseBody = await safeReadBody(cloned);
      } catch (e) {
        responseBody = `[error reading response: ${e.message}]`;
      }
    }

    post({
      id: requestId,
      type: 'fetch',
      url, method, status, statusText,
      startedAt,
      duration: Date.now() - startedAt,
      requestHeaders, requestBody,
      responseHeaders, responseBody,
      error: networkError,
    });

    if (networkError) throw new Error(networkError);
    return response;
  };

  // ---------- XHR patch ----------
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    const state = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      method: null,
      url: null,
      requestHeaders: {},
      requestBody: null,
      startedAt: null,
    };

    const originalOpen = xhr.open;
    xhr.open = function (method, url) {
      state.method = String(method).toUpperCase();
      state.url = String(url);
      return originalOpen.apply(xhr, arguments);
    };

    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (name, value) {
      state.requestHeaders[name] = value;
      return originalSetRequestHeader.apply(xhr, arguments);
    };

    const originalSend = xhr.send;
    xhr.send = function (body) {
      state.startedAt = Date.now();
      state.requestBody = serializeBody(body);

      xhr.addEventListener('loadend', () => {
        try {
          const responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
          let responseBody;
          try {
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') responseBody = xhr.responseText;
            else if (rt === 'json') responseBody = JSON.stringify(xhr.response);
            else responseBody = `[non-text responseType: ${rt}]`;
          } catch (e) {
            responseBody = `[error reading body: ${e.message}]`;
          }

          post({
            id: state.id,
            type: 'xhr',
            url: state.url,
            method: state.method,
            status: xhr.status,
            statusText: xhr.statusText,
            startedAt: state.startedAt,
            duration: Date.now() - state.startedAt,
            requestHeaders: state.requestHeaders,
            requestBody: state.requestBody,
            responseHeaders,
            responseBody,
            error: xhr.status === 0 ? 'Network error / aborted' : null,
          });
        } catch (e) {
          // never break the page
        }
      });

      return originalSend.apply(xhr, arguments);
    };

    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  // Preserve static constants (UNSENT, OPENED, ...)
  Object.getOwnPropertyNames(OriginalXHR).forEach((k) => {
    try { PatchedXHR[k] = OriginalXHR[k]; } catch (e) { /* readonly */ }
  });
  window.XMLHttpRequest = PatchedXHR;

  // ---------- helpers ----------
  function post(payload) {
    try {
      window.postMessage({ source: CAPTURE_EVENT, payload }, '*');
    } catch (e) { /* silent */ }
  }

  function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const obj = {};
      headers.forEach((v, k) => { obj[k] = v; });
      return obj;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    if (typeof headers === 'object') return { ...headers };
    return {};
  }

  async function safeReadBody(response) {
    try {
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json') || ct.startsWith('text/') || ct.includes('xml') || ct.includes('form-urlencoded')) {
        const text = await response.text();
        // Truncate gigantic payloads
        return text.length > 200_000 ? text.slice(0, 200_000) + '\n…[truncated]' : text;
      }
      return `[binary content: ${ct || 'unknown'}]`;
    } catch (e) {
      return `[error reading body: ${e.message}]`;
    }
  }

  function serializeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof FormData) {
      const obj = {};
      body.forEach((v, k) => { obj[k] = typeof v === 'string' ? v : '[File]'; });
      return JSON.stringify(obj);
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) return `[Blob: ${body.size} bytes, ${body.type}]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
    try { return JSON.stringify(body); } catch { return '[unserializable body]'; }
  }

  function parseRawHeaders(raw) {
    const obj = {};
    if (!raw) return obj;
    raw.trim().split(/[\r\n]+/).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return obj;
  }
})();
