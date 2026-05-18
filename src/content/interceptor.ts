// Content-script interceptor — MAIN world (page context).
//
// Patches window.fetch and XMLHttpRequest so we can observe requests
// including response bodies. Posts each capture to the ISOLATED-world
// bridge via window.postMessage. Has no access to chrome.* APIs by design.
//
// TODO(m1-w2): re-emit captures as CapturedEvent (PRD §6.1.2) once the
// canonical model is wired through src/types/events.ts. This file is a
// like-for-like .js → .ts port; logic is unchanged.

interface LegacyCapturePayload {
  id: string;
  type: 'fetch' | 'xhr';
  url: string;
  method: string;
  status: number;
  statusText: string;
  startedAt: number;
  duration: number;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  error: string | null;
}

(() => {
  const CAPTURE_EVENT = '__nc_capture__';

  // ---------- fetch patch ----------
  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(
    this: typeof window,
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const startedAt = Date.now();
    const requestId =
      (crypto.randomUUID && crypto.randomUUID()) || String(startedAt + Math.random());

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
      // eslint-disable-next-line prefer-rest-params
      response = await originalFetch.apply(this, arguments as unknown as Parameters<typeof fetch>);
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

    post({
      id: requestId,
      type: 'fetch',
      url,
      method,
      status,
      statusText,
      startedAt,
      duration: Date.now() - startedAt,
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBody,
      error: networkError,
    });

    if (networkError) throw new Error(networkError);
    return response as Response;
  };

  // ---------- XHR patch ----------
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR(this: XMLHttpRequest): XMLHttpRequest {
    const xhr = new OriginalXHR();
    const state = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
      method: '' as string,
      url: '' as string,
      requestHeaders: {} as Record<string, string>,
      requestBody: null as string | null,
      startedAt: 0 as number,
    };

    const originalOpen = xhr.open;
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL): void {
      state.method = String(method).toUpperCase();
      state.url = String(url);
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(xhr, arguments as unknown as Parameters<XMLHttpRequest['open']>);
    } as XMLHttpRequest['open'];

    const originalSetRequestHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      state.requestHeaders[name] = value;
      // eslint-disable-next-line prefer-rest-params
      return originalSetRequestHeader.apply(
        xhr,
        arguments as unknown as Parameters<XMLHttpRequest['setRequestHeader']>
      );
    };

    const originalSend = xhr.send;
    xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
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
        } catch {
          /* never break the page */
        }
      });

      // eslint-disable-next-line prefer-rest-params
      return originalSend.apply(xhr, arguments as unknown as Parameters<XMLHttpRequest['send']>);
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
  function post(payload: LegacyCapturePayload): void {
    try {
      window.postMessage({ source: CAPTURE_EVENT, payload }, '*');
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
