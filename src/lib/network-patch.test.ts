// Perf-hotfix (v0.6.2) behavior locks for the page-world network patch:
// the fetch wrapper must NEVER withhold the Response from the page while
// it reads the body, bodies are capped at the source, and WebSocket
// frames coalesce instead of emitting one capture per frame.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  capJsonResponse,
  createFetchPatch,
  createWebSocketPatch,
  serializeBody,
} from './network-patch';
import { BODY_CAP, TRUNCATION_MARKER } from './capture-limits';
import type { RawCapture } from '@/lib/runtime-messages';
import type { NetworkFetchData, NetworkWebSocketData } from '@/types/events';

function collector(): { posts: RawCapture[]; post: (c: RawCapture) => void } {
  const posts: RawCapture[] = [];
  return { posts, post: (c) => posts.push(c) };
}

function fetchData(c: RawCapture): NetworkFetchData {
  if (c.type !== 'network.fetch') throw new Error(`expected network.fetch, got ${c.type}`);
  return c.data;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createFetchPatch — detached body capture', () => {
  it('returns the original Response to the page and posts the capture detached', async () => {
    const { posts, post } = collector();
    const original = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const patched = createFetchPatch(async () => original, post);

    const result = await patched('https://api.test/x');
    expect(result).toBe(original);
    // The page can still consume its own body — the capture reads a clone.
    expect(result.bodyUsed).toBe(false);

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchData(posts[0]!).response.body).toBe('{"ok":true}');
    expect(fetchData(posts[0]!).response.status).toBe(200);
  });

  it('resolves for the page even while the response stream is still open', async () => {
    vi.useFakeTimers();
    const { posts, post } = collector();
    // A stream that delivers one chunk and never closes — the old code
    // awaited text() on the clone, so the page's fetch never resolved.
    const openStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        // intentionally never close()
      },
    });
    const original = new Response(openStream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const patched = createFetchPatch(async () => original, post);

    const result = await patched('https://api.test/stream');
    expect(result).toBe(original);
    expect(posts).toHaveLength(0); // capture still pending — page already unblocked

    // The detached reader gives up at the read deadline and posts what it has.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchData(posts[0]!).response.body).toContain('{"partial":');
    expect(fetchData(posts[0]!).response.body).toContain('[stream still open');
  });

  it('never clones or reads text/event-stream bodies (SSE)', async () => {
    const { posts, post } = collector();
    const original = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    const patched = createFetchPatch(async () => original, post);

    await patched('https://api.test/events');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchData(posts[0]!).response.body).toBe(
      '[stream: text/event-stream — body not captured]'
    );
    expect(original.bodyUsed).toBe(false);
  });

  it('never clones binary bodies', async () => {
    const { posts, post } = collector();
    const original = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const patched = createFetchPatch(async () => original, post);

    await patched('https://api.test/blob');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchData(posts[0]!).response.body).toBe('[binary content: application/octet-stream]');
    expect(original.bodyUsed).toBe(false);
  });

  it('caps captured bodies at BODY_CAP and cancels the rest of the stream', async () => {
    const { posts, post } = collector();
    const big = 'a'.repeat(BODY_CAP + 50_000);
    const original = new Response(big, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    const patched = createFetchPatch(async () => original, post);

    await patched('https://api.test/big');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const body = fetchData(posts[0]!).response.body!;
    expect(body.length).toBe(BODY_CAP + TRUNCATION_MARKER.length);
    expect(body.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('re-throws the ORIGINAL error object so AbortError identity survives', async () => {
    const { posts, post } = collector();
    const abortError = new DOMException('The user aborted a request.', 'AbortError');
    const patched = createFetchPatch(async () => {
      throw abortError;
    }, post);

    await expect(patched('https://api.test/aborted')).rejects.toBe(abortError);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(fetchData(posts[0]!).error).toContain('aborted');
  });
});

describe('capJsonResponse', () => {
  it('summarizes instead of stringifying when content-length is large', () => {
    const out = capJsonResponse({ response: { huge: true } }, { 'Content-Length': '5000000' });
    expect(out).toBe('[json response: ~5000000 bytes — too large to capture]');
  });

  it('stringifies and caps small json responses', () => {
    expect(capJsonResponse({ response: { a: 1 } }, { 'content-length': '7' })).toBe('{"a":1}');
  });
});

describe('serializeBody — request-side caps', () => {
  it('caps string bodies', () => {
    const out = serializeBody('z'.repeat(BODY_CAP + 1))!;
    expect(out.length).toBe(BODY_CAP + TRUNCATION_MARKER.length);
  });

  it('leaves small bodies untouched', () => {
    expect(serializeBody('{"q":1}')).toBe('{"q":1}');
  });
});

// ---------------------------------------------------------------------------
// WebSocket frame coalescing
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void;

class FakeWebSocket {
  url: string;
  sent: unknown[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatch(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }
}

function wsData(c: RawCapture): NetworkWebSocketData {
  if (c.type !== 'network.websocket') throw new Error(`expected network.websocket, got ${c.type}`);
  return c.data;
}

describe('createWebSocketPatch — frame coalescing', () => {
  it('coalesces recv frames into one summary per flush window', () => {
    vi.useFakeTimers();
    const { posts, post } = collector();
    const Patched = createWebSocketPatch(FakeWebSocket as unknown as typeof WebSocket, post);
    const ws = new Patched('ws://feed.test') as unknown as FakeWebSocket;

    expect(posts).toHaveLength(1); // connect
    ws.dispatch('message', { data: 'abcd' });
    ws.dispatch('message', { data: 'ef' });
    ws.dispatch('message', { data: 'ghi' });
    expect(posts).toHaveLength(1); // frames pending, no per-frame capture

    vi.advanceTimersByTime(1_000);
    expect(posts).toHaveLength(2);
    const summary = wsData(posts[1]!);
    expect(summary.phase).toBe('message');
    expect(summary.direction).toBe('recv');
    expect(summary.frameCount).toBe(3);
    expect(summary.byteSize).toBe(9);
  });

  it('flushes pending frames before emitting close', () => {
    vi.useFakeTimers();
    const { posts, post } = collector();
    const Patched = createWebSocketPatch(FakeWebSocket as unknown as typeof WebSocket, post);
    const ws = new Patched('ws://feed.test') as unknown as FakeWebSocket & {
      send: (d: string) => void;
    };

    ws.send('xy');
    ws.send('z');
    ws.dispatch('close', { code: 1000, reason: '' });

    expect(posts).toHaveLength(3); // connect, send-summary, close
    const summary = wsData(posts[1]!);
    expect(summary.direction).toBe('send');
    expect(summary.frameCount).toBe(2);
    expect(summary.byteSize).toBe(3);
    expect(wsData(posts[2]!).phase).toBe('close');
    expect(ws.sent).toEqual(['xy', 'z']); // frames still reached the socket
  });
});
