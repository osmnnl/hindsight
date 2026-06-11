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
import { BODY_CAP, capText, TRUNCATION_MARKER } from '@/lib/capture-limits';

export type Post = (capture: RawCapture) => void;

/** Detached body reads stop after this long even if the stream is still
 *  open (slow trickle below the size cap). Bounds both the capture
 *  latency and the tee-buffer memory for long-lived responses. */
const BODY_READ_TIMEOUT_MS = 10_000;

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
    let failed = false;
    let caughtError: unknown;
    let networkError: string | null = null;
    try {
      response = await originalFetch.apply(this, args);
    } catch (err) {
      failed = true;
      caughtError = err;
      networkError = String((err as Error)?.stack ?? (err as Error)?.message ?? err);
    }

    let responseHeaders: Record<string, string> = {};
    let status = 0;
    let statusText = '';
    if (response) {
      try {
        responseHeaders = headersToObject(response.headers);
        status = response.status;
        statusText = response.statusText;
      } catch {
        /* never break the page */
      }
    }

    const finish = (responseBody: string | null): void => {
      const data: NetworkFetchData = {
        request: {
          method,
          url,
          headers: requestHeaders,
          body: requestBody,
        } satisfies NetworkRequest,
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
    };

    // Body capture is DETACHED: the page gets its Response back
    // immediately (preserving time-to-first-byte and streaming), and the
    // capture posts whenever the capped clone read completes. The old
    // `await` here held every fetch hostage until the full body
    // downloaded — and never resolved at all for open streams (SSE).
    if (response) {
      captureResponseBody(response, finish);
    } else {
      finish(null);
    }

    // Re-throw the ORIGINAL error object — wrapping it in `new Error()`
    // broke `err.name === 'AbortError'` checks in page code, which fire
    // constantly as SPAs abort in-flight requests during navigation.
    if (failed) throw caughtError;
    return response as Response;
  } as typeof fetch;
}

/**
 * Decides whether/how to read the response body and posts the capture
 * via `finish` when done. Never blocks the caller: textual bodies are
 * read from a clone on a detached promise, capped at BODY_CAP bytes of
 * output and BODY_READ_TIMEOUT_MS of wall time; streams (SSE) and
 * binary bodies are never cloned at all, so they cost nothing.
 */
function captureResponseBody(response: Response, finish: (body: string | null) => void): void {
  let ct = '';
  try {
    ct = response.headers.get('content-type') ?? '';
  } catch {
    /* opaque response — fall through to the binary branch */
  }

  if (ct.includes('text/event-stream')) {
    finish('[stream: text/event-stream — body not captured]');
    return;
  }
  const isTextual =
    ct.includes('application/json') ||
    ct.startsWith('text/') ||
    ct.includes('xml') ||
    ct.includes('form-urlencoded');
  if (!isTextual) {
    finish(`[binary content: ${ct || 'unknown'}]`);
    return;
  }
  if (response.body == null) {
    // No body to read (204, HEAD, opaque) — capture headers only.
    finish('');
    return;
  }

  let cloned: Response;
  try {
    cloned = response.clone();
  } catch (e) {
    finish(`[error reading response: ${(e as Error).message}]`);
    return;
  }
  void readBodyCapped(cloned).then(finish, (e: unknown) => {
    finish(`[error reading response: ${(e as Error)?.message ?? String(e)}]`);
  });
}

/**
 * Reads at most BODY_CAP characters from the clone via a streaming
 * reader, then cancels. Cancelling releases the tee buffer — unlike
 * `text()`, which materialized the ENTIRE body (50 MB responses, open
 * streams) before the old code sliced it down.
 */
async function readBodyCapped(cloned: Response): Promise<string> {
  const body = cloned.body;
  if (!body) {
    return capText(await cloned.text());
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, BODY_READ_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
      if (out.length >= BODY_CAP) {
        void reader.cancel().catch(() => {});
        return out.slice(0, BODY_CAP) + TRUNCATION_MARKER;
      }
    }
    out += decoder.decode();
    return timedOut ? out + '\n…[stream still open — capture stopped]' : out;
  } finally {
    clearTimeout(timer);
  }
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
            // Same BODY_CAP as the fetch path — the XHR body previously
            // went through uncapped, so a multi-MB responseText was
            // copied 4× on the main thread (capture → postMessage →
            // runtime IPC → storage) per request.
            if (rt === '' || rt === 'text') responseBody = capText(xhr.responseText);
            else if (rt === 'json') responseBody = capJsonResponse(xhr, responseHeaders);
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

/**
 * Builds the capture string for `responseType === 'json'` XHRs without
 * paying an unbounded synchronous `JSON.stringify` on the page's main
 * thread: responses advertising a large content-length are summarized
 * instead of serialized, and the result is capped like every other body.
 */
export function capJsonResponse(
  xhr: Pick<XMLHttpRequest, 'response'>,
  responseHeaders: Record<string, string>
): string {
  let contentLength = NaN;
  for (const key of Object.keys(responseHeaders)) {
    if (key.toLowerCase() === 'content-length') {
      contentLength = Number(responseHeaders[key]);
      break;
    }
  }
  if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
    return `[json response: ~${contentLength} bytes — too large to capture]`;
  }
  try {
    const s: string | undefined = JSON.stringify(xhr.response);
    return s == null ? 'null' : capText(s);
  } catch {
    return '[unserializable json response]';
  }
}

export function serializeBody(body: BodyInit | Document | null | undefined): string | null {
  if (body == null) return null;
  // Request bodies are capped like response bodies — file-upload-sized
  // strings otherwise ride the full pipeline uncapped.
  if (typeof body === 'string') return capText(body);
  if (body instanceof FormData) {
    const obj: Record<string, string> = {};
    body.forEach((v, k) => {
      obj[k] = typeof v === 'string' ? capText(v) : '[File]';
    });
    return capText(JSON.stringify(obj));
  }
  if (body instanceof URLSearchParams) return capText(body.toString());
  if (body instanceof Blob) return `[Blob: ${body.size} bytes, ${body.type}]`;
  if (body instanceof ArrayBuffer) return `[ArrayBuffer: ${body.byteLength} bytes]`;
  try {
    return capText(JSON.stringify(body));
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
/** Frame summaries flush at most this often per socket. Chatty sockets
 *  (trading feeds, collaborative editors) push hundreds of frames/sec —
 *  one capture per frame meant one postMessage + one runtime IPC each. */
const WS_FLUSH_INTERVAL_MS = 1_000;

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

      // Per-socket frame coalescing: aggregate counts/bytes per
      // direction and emit ONE summary capture per flush window instead
      // of one capture per frame. Lifecycle phases (connect/open/close/
      // error) still emit immediately — they're rare and meaningful.
      const agg = {
        send: { frames: 0, bytes: 0 },
        recv: { frames: 0, bytes: 0 },
      };
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushFrames = (): void => {
        if (flushTimer != null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        for (const direction of ['send', 'recv'] as const) {
          const a = agg[direction];
          if (a.frames === 0) continue;
          emit({
            phase: 'message',
            url: wsUrl,
            direction,
            byteSize: a.bytes,
            frameCount: a.frames,
          });
          a.frames = 0;
          a.bytes = 0;
        }
      };
      const queueFrame = (direction: 'send' | 'recv', byteSize: number | undefined): void => {
        const a = agg[direction];
        a.frames += 1;
        a.bytes += byteSize ?? 0;
        if (flushTimer == null) flushTimer = setTimeout(flushFrames, WS_FLUSH_INTERVAL_MS);
      };

      emit({ phase: 'connect', url: wsUrl });

      this.addEventListener('open', () => {
        emit({ phase: 'open', url: wsUrl });
      });

      this.addEventListener('message', (e: MessageEvent) => {
        queueFrame('recv', wsByteSize(e.data));
      });

      this.addEventListener('error', () => {
        flushFrames();
        emit({ phase: 'error', url: wsUrl });
      });

      this.addEventListener('close', (e: CloseEvent) => {
        flushFrames();
        emit({
          phase: 'close',
          url: wsUrl,
          ...(typeof e.code === 'number' ? { code: e.code } : {}),
          ...(e.reason ? { reason: e.reason } : {}),
        });
      });

      // Instance-level wrap (not a prototype override) so `queueFrame`
      // stays reachable from the constructor closure.
      const originalSend = this.send.bind(this);
      this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
        try {
          queueFrame('send', wsByteSize(data));
        } catch {
          /* never break the page */
        }
        originalSend(data);
      };
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
