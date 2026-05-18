// Content-script interceptor — MAIN world (page context).
//
// Patches window.fetch and XMLHttpRequest so we can observe requests
// including response bodies. Emits RawCapture envelopes shaped per
// PRD §6.1.2 (NetworkFetchData / NetworkXhrData) to the ISOLATED-world
// bridge via window.postMessage. Has no access to chrome.* APIs by
// design — the service worker is the central authority that wraps each
// RawCapture into a full CapturedEvent (id, sessionId, sequenceNumber).

import type {
  NetworkFetchData,
  NetworkRequest,
  NetworkResponse,
  NetworkTiming,
  NetworkXhrData,
} from '@/types/events';
import {
  CAPTURE_BRIDGE_TAG,
  type PageBridgeMessage,
  type RawCapture,
} from '@/lib/runtime-messages';

(() => {
  // ---------- fetch patch ----------
  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(
    this: typeof window,
    ...args: Parameters<typeof fetch>
  ): Promise<Response> {
    const [input, init] = args;
    const startedAt = Date.now();

    let url: string;
    let method: string;
    let requestHeaders: Record<string, string>;
    let requestBody: string | null;
    try {
      if (input instanceof Request) {
        url = input.url;
        method = (init?.method ?? input.method ?? 'GET').toUpperCase();
        requestHeaders = headersToObject(init?.headers ?? input.headers);
        requestBody = init?.body != null ? serializeBody(init.body) : '[Request body not captured]';
      } else {
        url = String(input);
        method = (init?.method ?? 'GET').toUpperCase();
        requestHeaders = headersToObject(init?.headers ?? {});
        requestBody = serializeBody(init?.body);
      }
    } catch {
      url = String(input);
      method = 'UNKNOWN';
      requestHeaders = {};
      requestBody = null;
    }

    let response: Response | undefined;
    let networkError: string | null = null;
    try {
      response = await originalFetch.apply(this, args);
    } catch (err) {
      networkError = String((err as Error)?.stack ?? (err as Error)?.message ?? err);
    }

    let responseBody: string | null = null;
    let responseHeaders: Record<string, string> = {};
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
        responseBody = `[error reading response: ${(e as Error).message}]`;
      }
    }

    const data: NetworkFetchData = {
      request: { method, url, headers: requestHeaders, body: requestBody },
      response: {
        status,
        statusText,
        headers: responseHeaders,
        body: responseBody,
      } satisfies NetworkResponse,
      timing: { startedAt, durationMs: Date.now() - startedAt } satisfies NetworkTiming,
      error: networkError,
    };
    post({ type: 'network.fetch', data });

    if (networkError) throw new Error(networkError);
    return response as Response;
  };

  // ---------- XHR patch ----------
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR(this: XMLHttpRequest): XMLHttpRequest {
    const xhr = new OriginalXHR();
    const state = {
      method: '' as string,
      url: '' as string,
      requestHeaders: {} as Record<string, string>,
      requestBody: null as string | null,
      startedAt: 0 as number,
    };

    const originalOpen = xhr.open;
    xhr.open = function (
      this: XMLHttpRequest,
      ...openArgs: Parameters<XMLHttpRequest['open']>
    ): void {
      const [method, url] = openArgs;
      state.method = String(method).toUpperCase();
      state.url = String(url);
      return originalOpen.apply(xhr, openArgs);
    } as XMLHttpRequest['open'];

    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (
      this: XMLHttpRequest,
      ...headerArgs: Parameters<XMLHttpRequest['setRequestHeader']>
    ): void {
      const [name, value] = headerArgs;
      state.requestHeaders[name] = value;
      return originalSetRequestHeader.apply(xhr, headerArgs);
    };

    const originalSend = xhr.send;
    xhr.send = function (
      this: XMLHttpRequest,
      ...sendArgs: Parameters<XMLHttpRequest['send']>
    ): void {
      const [body] = sendArgs;
      state.startedAt = Date.now();
      state.requestBody = serializeBody(body ?? null);

      xhr.addEventListener('loadend', () => {
        try {
          const responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders());
          let responseBody: string;
          try {
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') responseBody = xhr.responseText;
            else if (rt === 'json') responseBody = JSON.stringify(xhr.response);
            else responseBody = `[non-text responseType: ${rt}]`;
          } catch (e) {
            responseBody = `[error reading body: ${(e as Error).message}]`;
          }

          const data: NetworkXhrData = {
            request: {
              method: state.method,
              url: state.url,
              headers: state.requestHeaders,
              body: state.requestBody,
            } satisfies NetworkRequest,
            response: {
              status: xhr.status,
              statusText: xhr.statusText,
              headers: responseHeaders,
              body: responseBody,
            },
            timing: { startedAt: state.startedAt, durationMs: Date.now() - state.startedAt },
            error: xhr.status === 0 ? 'Network error / aborted' : null,
          };
          post({ type: 'network.xhr', data });
        } catch {
          /* never break the page */
        }
      });

      return originalSend.apply(xhr, sendArgs);
    };

    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  Object.getOwnPropertyNames(OriginalXHR).forEach((k) => {
    try {
      (PatchedXHR as unknown as Record<string, unknown>)[k] = (
        OriginalXHR as unknown as Record<string, unknown>
      )[k];
    } catch {
      /* readonly */
    }
  });
  window.XMLHttpRequest = PatchedXHR as unknown as typeof XMLHttpRequest;

  // ---------- helpers ----------
  function post(capture: RawCapture): void {
    const message: PageBridgeMessage = { source: CAPTURE_BRIDGE_TAG, capture };
    try {
      window.postMessage(message, '*');
    } catch {
      /* silent */
    }
  }

  function headersToObject(
    headers: HeadersInit | Headers | Record<string, string> | undefined | null
  ): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) {
      const obj: Record<string, string> = {};
      headers.forEach((v, k) => {
        obj[k] = v;
      });
      return obj;
    }
    if (Array.isArray(headers)) return Object.fromEntries(headers as [string, string][]);
    if (typeof headers === 'object') return { ...(headers as Record<string, string>) };
    return {};
  }

  async function safeReadBody(response: Response): Promise<string> {
    try {
      const ct = response.headers.get('content-type') ?? '';
      if (
        ct.includes('application/json') ||
        ct.startsWith('text/') ||
        ct.includes('xml') ||
        ct.includes('form-urlencoded')
      ) {
        const text = await response.text();
        return text.length > 200_000 ? text.slice(0, 200_000) + '\n…[truncated]' : text;
      }
      return `[binary content: ${ct || 'unknown'}]`;
    } catch (e) {
      return `[error reading body: ${(e as Error).message}]`;
    }
  }

  function serializeBody(body: BodyInit | Document | null | undefined): string | null {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof FormData) {
      const obj: Record<string, string> = {};
      body.forEach((v, k) => {
        obj[k] = typeof v === 'string' ? v : '[File]';
      });
      return JSON.stringify(obj);
    }
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof Blob) return `[Blob: ${body.size} bytes, ${body.type}]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
    try {
      return JSON.stringify(body);
    } catch {
      return '[unserializable body]';
    }
  }

  function parseRawHeaders(raw: string | null): Record<string, string> {
    const obj: Record<string, string> = {};
    if (!raw) return obj;
    raw
      .trim()
      .split(/[\r\n]+/)
      .forEach((line) => {
        const i = line.indexOf(':');
        if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
    return obj;
  }
})();
