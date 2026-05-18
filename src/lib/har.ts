// HAR 1.2 export — PRD §6.4.2.
//
// Maps Hindsight's CapturedEvent[] to the W3C HAR 1.2 log format so the
// file can be opened directly in Chrome DevTools, Firefox DevTools,
// Postman, Charles, etc. Only network.fetch and network.xhr events are
// represented today — non-network events are skipped (HAR has no
// equivalent slot for console.error / action.click / etc.).
//
// Spec reference: http://www.softwareishard.com/blog/har-12-spec/
//
// We honor PRD §4.1 "no information loss": HAR is a faithful projection
// of what's in storage, including masked values. There is no extra
// transform at export time — capture-time masking already happened
// upstream (PRD §11.2).

import type {
  CapturedEvent,
  NetworkFetchEvent,
  NetworkRequest,
  NetworkResponse,
  NetworkXhrEvent,
} from '@/types/events';

type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;

// ---------------------------------------------------------------------------
// HAR types — subset we emit. Field names match the spec verbatim.
// ---------------------------------------------------------------------------

export interface HarLog {
  version: '1.2';
  creator: { name: string; version: string };
  browser?: { name: string; version: string };
  pages: HarPage[];
  entries: HarEntry[];
}

export interface HarPage {
  id: string;
  startedDateTime: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
}

export interface HarEntry {
  pageref: string;
  startedDateTime: string;
  /** Total elapsed time of the request in ms. */
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
  /** Hindsight-specific: not part of the HAR spec but tolerated by every
   *  HAR consumer we've tested. Helps round-trip the sessionId. */
  _hindsight?: { eventId: string; sessionId: string; sequenceNumber: number };
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarNameValue[];
  queryString: HarNameValue[];
  cookies: HarNameValue[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarNameValue[];
  cookies: HarNameValue[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
}

export interface HarTimings {
  send: number;
  wait: number;
  receive: number;
  /** Optional but defaulted to -1 (unknown) for clarity. */
  blocked: number;
  connect: number;
  dns: number;
  ssl: number;
}

export interface HarNameValue {
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToHarOptions {
  /** The version string emitted as log.creator.version. */
  creatorVersion: string;
  /** Browser identification — usually navigator.userAgent's parsed form.
   *  Optional; if omitted the `browser` field is dropped from the HAR. */
  browser?: { name: string; version: string };
  /** Defaults to "Hindsight Session". */
  pageTitle?: string;
}

/**
 * Builds a HAR 1.2 log object from a list of captured events. Non-network
 * events are filtered out silently — they have no HAR representation.
 * Throws on an empty entry set so callers don't accidentally produce an
 * empty HAR file (catch and degrade if you'd rather download nothing).
 */
export function toHar(events: CapturedEvent[], opts: ToHarOptions): HarLog {
  const entries: HarEntry[] = events.filter(isNetworkRequestEvent).map((e) => toHarEntry(e));
  if (entries.length === 0) {
    throw new Error('toHar: no network events to export');
  }

  const first = entries[0];
  const pageStart = first?.startedDateTime ?? new Date().toISOString();

  return {
    version: '1.2',
    creator: { name: 'Hindsight', version: opts.creatorVersion },
    ...(opts.browser ? { browser: opts.browser } : {}),
    pages: [
      {
        id: 'page_0',
        startedDateTime: pageStart,
        title: opts.pageTitle ?? 'Hindsight Session',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      },
    ],
    entries,
  };
}

function isNetworkRequestEvent(e: CapturedEvent): e is NetworkRequestEvent {
  return e.type === 'network.fetch' || e.type === 'network.xhr';
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

function toHarEntry(e: NetworkRequestEvent): HarEntry {
  return {
    pageref: 'page_0',
    startedDateTime: new Date(e.data.timing.startedAt).toISOString(),
    time: e.data.timing.durationMs,
    request: toHarRequest(e.data.request),
    response: toHarResponse(e.data.response),
    cache: {},
    timings: {
      send: -1,
      wait: e.data.timing.durationMs >= 0 ? e.data.timing.durationMs : -1,
      receive: -1,
      blocked: -1,
      connect: -1,
      dns: -1,
      ssl: -1,
    },
    _hindsight: {
      eventId: e.id,
      sessionId: e.sessionId,
      sequenceNumber: e.sequenceNumber,
    },
  };
}

function toHarRequest(req: NetworkRequest): HarRequest {
  const queryString = parseQueryString(req.url);
  const body = req.body ?? null;
  return {
    method: req.method,
    url: req.url,
    httpVersion: 'HTTP/1.1',
    headers: toNameValue(req.headers),
    queryString,
    cookies: extractCookies(req.headers, 'cookie'),
    headersSize: -1,
    bodySize: body == null ? 0 : byteLength(body),
    ...(body == null ? {} : { postData: { mimeType: mimeOf(req.headers), text: body } }),
  };
}

function toHarResponse(resp: NetworkResponse): HarResponse {
  const body = resp.body ?? null;
  return {
    status: resp.status,
    statusText: resp.statusText,
    httpVersion: 'HTTP/1.1',
    headers: toNameValue(resp.headers),
    cookies: extractCookies(resp.headers, 'set-cookie'),
    content: {
      size: body == null ? 0 : byteLength(body),
      mimeType: mimeOf(resp.headers),
      ...(body == null ? {} : { text: body }),
    },
    redirectURL: findHeader(resp.headers, 'location') ?? '',
    headersSize: -1,
    bodySize: body == null ? 0 : byteLength(body),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNameValue(headers: Record<string, string>): HarNameValue[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function mimeOf(headers: Record<string, string>): string {
  return findHeader(headers, 'content-type') ?? '';
}

/**
 * Pulls cookies out of a Cookie / Set-Cookie header into HAR's name/value
 * shape. Set-Cookie may carry attributes (Path, HttpOnly, ...) — we keep
 * only the leading name=value pair per cookie.
 */
function extractCookies(
  headers: Record<string, string>,
  kind: 'cookie' | 'set-cookie'
): HarNameValue[] {
  const raw = findHeader(headers, kind);
  if (!raw) return [];
  // Cookie header: name=value; name=value
  // Set-Cookie:   name=value; Path=/; HttpOnly  (one cookie per header value)
  const cookies: HarNameValue[] = [];
  const pairs = kind === 'cookie' ? raw.split(';') : [raw.split(';')[0] ?? ''];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value });
  }
  return cookies;
}

/** Returns a parsed queryString[] (HAR shape) for a request URL, or empty
 *  if the URL has no search component or fails to parse. */
function parseQueryString(rawUrl: string): HarNameValue[] {
  try {
    const u = new URL(rawUrl);
    const out: HarNameValue[] = [];
    u.searchParams.forEach((value, name) => {
      out.push({ name, value });
    });
    return out;
  } catch {
    return [];
  }
}

/** Approximate UTF-8 byte length without allocating a TextEncoder per call
 *  for environments that don't expose it (some service-worker shims). */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  // Fallback: count code units and adjust for non-ASCII.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
