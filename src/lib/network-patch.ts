// Page-world fetch and XHR patch factories.
//
// Pure functions used by the content-script interceptor and by the
// perf benchmark suite. No window / chrome dependencies — every IO is
// passed in (originalFetch, the post callback, and the XHR constructor).
// That separation is what lets the benchmark exercise the same logic
// outside of a Chrome MV3 content script (PRD §13.3).

import type {
  NetworkFetchData,
  NetworkRequest,
  NetworkResponse,
  NetworkTiming,
  NetworkWebSocketData,
  NetworkXhrData,
} from '@/types/events';
import type { RawCapture } from '@/lib/runtime-messages';

export type Post = (capture: RawCapture) => void;

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * Returns a fetch wrapper that proxies through `originalFetch` and emits a
 * `network.fetch` RawCapture for every call (success or failure). Errors
 * are re-thrown after the capture so the page sees the same behavior as
 * an unwrapped fetch.
 */
export function createFetchPatch(originalFetch: typeof fetch, post: Post): typeof fetch {
  return async function patchedFetch(
    this: typeof globalThis,
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
      request: { method, url, headers: requestHeaders, body: requestBody } satisfies NetworkRequest,
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
  } as typeof fetch;
}

// ---------------------------------------------------------------------------
// XMLHttpRequest
// ---------------------------------------------------------------------------

/**
 * Returns a constructor that wraps the supplied XHR class. Each instance
 * captures method / URL / headers / body / status / timings via the same
 * RawCapture envelope as `createFetchPatch`. Static constants
 * (UNSENT / OPENED / ...) are copied across so existing code that
 * references `XMLHttpRequest.DONE` keeps working.
 */
export function createXhrPatch(
  OriginalXHR: typeof XMLHttpRequest,
  post: Post
): typeof XMLHttpRequest {
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
  return PatchedXHR as unknown as typeof XMLHttpRequest;
}

// ---------------------------------------------------------------------------
// Shared helpers — exported for the benchmark suite and any future tests.
// ---------------------------------------------------------------------------

export function headersToObject(
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

export async function safeReadBody(response: Response): Promise<string> {
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

export function serializeBody(body: BodyInit | Document | null | undefined): string | null {
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

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/**
 * Returns a WebSocket constructor that emits NetworkWebSocketData on
 * connect / open / message (both directions) / close / error. Frame
 * content is intentionally not captured — PRD §6.1.1 Tier 2 says
 * "metadata-only unless user opts in"; the opt-in path lands later.
 *
 * Implementation note: we subclass the real WebSocket so the new
 * instance preserves every native behavior (binaryType, extensions,
 * protocol, etc.). The captured OriginalWebSocket reference is the
 * pre-patch class — assigning the subclass back to window.WebSocket
 * does not introduce recursion because `super(...)` resolves through
 * the captured class.
 */
export function createWebSocketPatch(
  OriginalWebSocket: typeof WebSocket,
  post: Post
): typeof WebSocket {
  class PatchedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const wsUrl = typeof url === 'string' ? url : url.toString();

      const emit = (data: NetworkWebSocketData): void => {
        post({ type: 'network.websocket', data });
      };

      emit({ phase: 'connect', url: wsUrl });

      this.addEventListener('open', () => {
        emit({ phase: 'open', url: wsUrl });
      });

      this.addEventListener('message', (e: MessageEvent) => {
        const byteSize = wsByteSize(e.data);
        emit({
          phase: 'message',
          url: wsUrl,
          direction: 'recv',
          ...(byteSize != null ? { byteSize } : {}),
        });
      });

      this.addEventListener('error', () => {
        emit({ phase: 'error', url: wsUrl });
      });

      this.addEventListener('close', (e: CloseEvent) => {
        emit({
          phase: 'close',
          url: wsUrl,
          ...(typeof e.code === 'number' ? { code: e.code } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        });
      });
    }

    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      try {
        const byteSize = wsByteSize(data);
        post({
          type: 'network.websocket',
          data: {
            phase: 'message',
            url: this.url,
            direction: 'send',
            ...(byteSize != null ? { byteSize } : {}),
          },
        });
      } catch {
        /* never break the page */
      }
      super.send(data);
    }
  }

  return PatchedWebSocket as unknown as typeof WebSocket;
}

function wsByteSize(data: unknown): number | undefined {
  if (data == null) return undefined;
  if (typeof data === 'string') return data.length;
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return undefined;
}

// ---------------------------------------------------------------------------
// Header parsing (XHR / fetch)
// ---------------------------------------------------------------------------

export function parseRawHeaders(raw: string | null): Record<string, string> {
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
