// Side panel UI — primary inspection surface (PRD §6.3.1).
//
// Migrated from the popup in M3·W9-1. Reads CapturedEvent[] (PRD §6.1.2)
// from the service worker, renders a mixed timeline (network + console +
// action + navigation), and offers per-event + bulk copy / download /
// HAR-export actions. The popup is now a minimal launcher; sustained
// inspection happens here.

import type {
  ArchivedSession,
  CapturedEvent,
  NetworkFetchEvent,
  NetworkXhrEvent,
  Redaction,
} from '@/types/events';
import { isApiRequest, isErrorEvent, isFailedNetwork } from '@/types/events';
import {
  type ClearArchiveRuntimeMessage,
  type ClearEventsRuntimeMessage,
  type GetArchiveRuntimeMessage,
  type GetEventsRuntimeMessage,
  type GetRecordingRuntimeMessage,
  type RecordingState,
  type ToggleRecordingRuntimeMessage,
} from '@/lib/runtime-messages';
import { toHar } from '@/lib/har';
import { DEFAULT_BODY_RULES, DEFAULT_FORM_RULES, DEFAULT_HEADER_RULES } from '@/lib/masking';
import { narrate } from '@/lib/narrative';
import { generateBundle } from '@/lib/replay-bundle';
import { readSharingSettings, type SharingSettings } from '@/lib/settings';
import { dispatchToWebhook, type WebhookDestination } from '@/lib/destinations/webhooks';
import { buildGithubIssueUrl, buildMailtoUrl } from '@/lib/destinations/web-intents';
import { toMarkdownReport } from '@/lib/formatters/markdown';
import { buildZip, type ZipEntry } from '@/lib/zip';
import { applyTheme, listenForThemeChanges } from '@/lib/theme';

declare const __APP_VERSION__: string;

// A "request-like" event — what the popup renders today. Side panel
// will broaden to console + actions in M3.
type NetworkRequestEvent = NetworkFetchEvent | NetworkXhrEvent;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

// Practical paste limit observed in Slack's rich-text editor. Slack docs
// quote 40k for messages, but the in-editor paste warning fires far below
// that (often ~3-4k chars). Above this we put image-only on the clipboard
// and trigger a JSON download so the receiver gets both pieces.
const SLACK_SAFE_THRESHOLD = 3000;

type FilterMode = 'failed' | 'api' | 'all';

interface UiState {
  filterMode: FilterMode;
  activeHost: string | null;
}

const UI_STATE_KEY = 'sidepanel/ui-state';

/** Page-URL host for non-network events, request-URL host for network.
 *  Lets the host picker filter both 3rd-party analytics requests and
 *  user actions on a given page with one selection. */
function eventHost(e: CapturedEvent): string {
  try {
    if (e.type === 'network.fetch' || e.type === 'network.xhr') {
      return new URL(e.data.request.url).host;
    }
    if (e.type === 'network.websocket' || e.type === 'network.sse') {
      return new URL(e.data.url).host;
    }
  } catch {
    /* fall through to page URL */
  }
  try {
    return new URL(e.url).host;
  } catch {
    return '';
  }
}

let searchQuery = '';
/** Time range filter as [start%, end%] over the post-base-filter set's
 *  min/max timestamps. Default [0, 100] means "no time clipping". The
 *  range is a zoom on what the user currently sees, not on the full
 *  session — so changing filter mode rebases the slider. Transient
 *  (not persisted) like search. */
let timeRangePct: [number, number] = [0, 100];

/** Centralised filter pipeline used by render, bulk bar, scrubber,
 *  Esc-back and refresh. Order: mode → host → free-text search →
 *  time range. The time range step is last so the scrubber can pass
 *  rangePct=[0,100] to get the pre-time-range set for its histogram. */
function filteredEvents(
  all: CapturedEvent[],
  mode: FilterMode,
  host: string | null = activeHost,
  query: string = searchQuery,
  rangePct: [number, number] = timeRangePct
): CapturedEvent[] {
  let out: CapturedEvent[];
  if (mode === 'failed') out = all.filter(isErrorEvent);
  else if (mode === 'api') out = all.filter(isApiRequest);
  else out = all;
  if (host) out = out.filter((e) => eventHost(e) === host);
  const q = query.trim().toLowerCase();
  if (q) {
    out = out.filter((e) => {
      const hay = e.type + ' ' + (e.url || '') + ' ' + JSON.stringify(e.data || {});
      return hay.toLowerCase().includes(q);
    });
  }
  if (rangePct[0] > 0 || rangePct[1] < 100) {
    const [startMs, endMs] = timeBoundsForPct(out, rangePct);
    if (endMs > startMs) {
      out = out.filter((e) => e.timestamp >= startMs && e.timestamp <= endMs);
    }
  }
  return out;
}

/** Convert a [start%, end%] range over `events`' min/max timestamps
 *  into absolute [startMs, endMs] for direct comparison. */
function timeBoundsForPct(events: CapturedEvent[], pct: [number, number]): [number, number] {
  let tFirst = Infinity;
  let tLast = -Infinity;
  for (const e of events) {
    if (e.timestamp < tFirst) tFirst = e.timestamp;
    if (e.timestamp > tLast) tLast = e.timestamp;
  }
  if (!isFinite(tFirst) || !isFinite(tLast) || tLast <= tFirst) return [0, 0];
  const span = tLast - tFirst;
  return [tFirst + (span * pct[0]) / 100, tFirst + (span * pct[1]) / 100];
}

function isRequestLike(e: CapturedEvent): e is NetworkRequestEvent {
  return e.type === 'network.fetch' || e.type === 'network.xhr';
}

function fmtSize(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

function fmtTime(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

async function renderFailureListImage(items: NetworkRequestEvent[]): Promise<Blob | null> {
  if (!items || items.length === 0) return null;

  const DPR = 2;
  const W = 760;
  const PAD = 22;
  const HEADER_H = 78;
  const ROW_H = 38;
  const FOOTER_H = 32;
  const H = HEADER_H + items.length * ROW_H + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(DPR, DPR);

  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  ctx.arc(PAD + 5, PAD + 12, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();

  ctx.font = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#e7ecf5';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const failedCount = items.filter((c) => isFailedNetwork(c)).length;
  ctx.fillText(`Hindsight · ${failedCount} failed`, PAD + 18, PAD + 12);

  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#8b94b3';
  const host = (() => {
    try {
      return new URL(items[0]?.url ?? '').host;
    } catch {
      return '';
    }
  })();
  const captureTs = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const subtitle = host ? `${host} · ${captureTs}` : captureTs;
  ctx.fillText(subtitle, PAD + 18, PAD + 34);

  ctx.fillStyle = '#2a335a';
  ctx.fillRect(0, HEADER_H, W, 1);

  const DURATION_W = 56;
  const TIME_W = 90;
  const STATUS_W = 50;
  const METHOD_W = 54;
  const COL_GAP = 12;
  const urlX = PAD + STATUS_W + COL_GAP + METHOD_W + COL_GAP;
  const timeX = W - PAD - DURATION_W - COL_GAP;
  const urlMaxW = timeX - TIME_W - COL_GAP - urlX;

  items.forEach((c, i) => {
    const y = HEADER_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    const failed = isFailedNetwork(c);

    if (i > 0) {
      ctx.fillStyle = '#1a2340';
      ctx.fillRect(PAD, y, W - PAD * 2, 1);
    }

    const badgeH = 22;
    const badgeY = mid - badgeH / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(PAD, badgeY, STATUS_W, badgeH, 4);
    else ctx.rect(PAD, badgeY, STATUS_W, badgeH);
    ctx.fillStyle = failed ? 'rgba(239, 68, 68, 0.14)' : 'rgba(34, 197, 94, 0.12)';
    ctx.fill();
    ctx.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = failed ? '#ef4444' : '#22c55e';
    ctx.textAlign = 'center';
    ctx.fillText(String(c.data.response.status || 'ERR'), PAD + STATUS_W / 2, mid);

    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'left';
    ctx.fillText(c.data.request.method.toUpperCase(), PAD + STATUS_W + COL_GAP, mid);

    ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#e7ecf5';
    const urlPath = (() => {
      try {
        return new URL(c.data.request.url).pathname;
      } catch {
        return c.data.request.url;
      }
    })();
    ctx.fillText(fitText(ctx, urlPath, urlMaxW), urlX, mid);

    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(c.data.timing.startedAt), timeX, mid);

    ctx.fillText(`${c.data.timing.durationMs}ms`, W - PAD, mid);
  });

  const footerY = HEADER_H + items.length * ROW_H;
  ctx.fillStyle = '#2a335a';
  ctx.fillRect(0, footerY, W, 1);
  ctx.font = '10.5px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#8b94b3';
  ctx.textAlign = 'left';
  ctx.fillText('Hindsight · privacy-first bug capture', PAD, footerY + 16);

  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

interface WriteResult {
  hasText: boolean;
  hasImage: boolean;
  textSkipped: boolean;
}

async function writeTextAndImage(
  text: string,
  itemsForImage: NetworkRequestEvent[],
  opts: { maxText?: number } = {}
): Promise<WriteResult> {
  const maxText = opts.maxText ?? Infinity;
  const skipText = text.length > maxText;

  let imageBlob: Blob | null = null;
  try {
    imageBlob = await renderFailureListImage(itemsForImage);
  } catch (e) {
    console.warn('Image render failed:', e);
  }

  const formats: Record<string, Blob> = {};
  if (imageBlob) formats['image/png'] = imageBlob;
  if (!skipText) formats['text/plain'] = new Blob([text], { type: 'text/plain' });

  if (Object.keys(formats).length === 0) {
    return { hasText: false, hasImage: false, textSkipped: skipText };
  }

  try {
    await navigator.clipboard.write([new ClipboardItem(formats)]);
    return { hasText: !skipText, hasImage: !!imageBlob, textSkipped: skipText };
  } catch (e) {
    console.warn('Clipboard write failed, trying writeText fallback:', e);
    if (!skipText) {
      try {
        await navigator.clipboard.writeText(text);
        return { hasText: true, hasImage: false, textSkipped: false };
      } catch {
        /* fall through */
      }
    }
    return { hasText: false, hasImage: false, textSkipped: skipText };
  }
}

let tabId: number | undefined;
let events: CapturedEvent[] = [];
let filterMode: FilterMode = 'failed';
let activeHost: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadUiState(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(UI_STATE_KEY);
    const value = stored[UI_STATE_KEY] as Partial<UiState> | undefined;
    if (!value) return;
    if (value.filterMode === 'failed' || value.filterMode === 'api' || value.filterMode === 'all') {
      filterMode = value.filterMode;
    }
    if (typeof value.activeHost === 'string' && value.activeHost.length > 0) {
      activeHost = value.activeHost;
    }
  } catch {
    /* defaults remain */
  }
}

let uiStatePersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistUiState(): void {
  // Debounce to avoid hitting storage on every keystroke; UI state is
  // a comfort feature, not a correctness one.
  if (uiStatePersistTimer) clearTimeout(uiStatePersistTimer);
  uiStatePersistTimer = setTimeout(() => {
    void chrome.storage.local
      .set({
        [UI_STATE_KEY]: { filterMode, activeHost } as UiState,
      })
      .catch(() => {});
  }, 200);
}

void init();

async function init(): Promise<void> {
  await applyTheme();
  listenForThemeChanges();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  await loadUiState();
  syncFilterChipsToState();

  document.querySelectorAll<HTMLElement>('.filter').forEach((btn) => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter as FilterMode));
  });
  document.getElementById('clear')?.addEventListener('click', () => void clearAll());
  document.getElementById('archive-clear')?.addEventListener('click', (e) => {
    e.preventDefault();
    void clearArchiveAndRefresh();
  });
  document.getElementById('record-toggle')?.addEventListener('click', () => {
    void toggleRecording();
  });

  // Search bar — debounce 120 ms so each keystroke doesn't rebuild the
  // entire 1000-event list. Search state is intentionally not persisted.
  const searchEl = document.getElementById('search-input');
  if (searchEl instanceof HTMLInputElement) {
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    searchEl.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = searchEl.value;
        invalidateRenderCache();
        render();
      }, 120);
    });
  }

  // Host filter — picker is rebuilt on every render() because the
  // distinct-host set grows as new events arrive. Wire change + clear
  // here so the handlers persist across rebuilds.
  const hostSelect = document.getElementById('host-select');
  if (hostSelect instanceof HTMLSelectElement) {
    hostSelect.addEventListener('change', () => {
      activeHost = hostSelect.value || null;
      persistUiState();
      invalidateRenderCache();
      render();
    });
  }
  document.getElementById('host-clear')?.addEventListener('click', () => {
    activeHost = null;
    persistUiState();
    invalidateRenderCache();
    render();
  });

  // M4·W15-extra: popup may have planted a focus-event / focus-filter
  // key in chrome.storage.local so the side panel boots into the right
  // filter and selects the right row immediately.
  await consumePopupFocus();

  await refresh();
  await refreshArchive();
  await refreshRecordingState();
  await applyPopupFocus();
  pollTimer = setInterval(() => {
    void refresh();
    updateRecordTimer();
  }, 1000);

  // Screenshot click-to-zoom: open the JPEG data URL in a new tab so the
  // user can inspect at full pixel size. Delegated because screenshot
  // panels are rendered dynamically inside the detail view.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLElement>('[data-screenshot-url]');
    if (!link) return;
    const url = link.dataset.screenshotUrl;
    if (!url) return;
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // Esc closes the detail view — keyboard ergonomics for back-and-forth
  // inspection. Skip when typing into an input or the privacy modal is
  // open (the modal owns its own Esc handler).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.privacy-modal-overlay')) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const detail = document.getElementById('detail');
    if (!detail || detail.classList.contains('hidden')) return;
    detail.classList.add('hidden');
    detail.innerHTML = '';
    const data = filteredEvents(events, filterMode);
    if (data.length > 0) document.getElementById('bulk-bar')?.classList.remove('hidden');
  });

  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
}

// ---------------------------------------------------------------------------
// Recording mode (PRD §6.5)
// ---------------------------------------------------------------------------

let recordingState: RecordingState = { recording: false };

async function refreshRecordingState(): Promise<void> {
  if (tabId == null) return;
  try {
    const msg: GetRecordingRuntimeMessage = { kind: 'GET_RECORDING', tabId };
    const result = await chrome.runtime.sendMessage(msg);
    if (result && typeof result === 'object') {
      recordingState = result as RecordingState;
      renderRecordingButton();
    }
  } catch {
    /* SW briefly inactive */
  }
}

async function toggleRecording(): Promise<void> {
  if (tabId == null) return;
  try {
    const msg: ToggleRecordingRuntimeMessage = { kind: 'TOGGLE_RECORDING', tabId };
    const result = await chrome.runtime.sendMessage(msg);
    const next = (result as RecordingState | undefined) ?? { recording: false };
    const wasRecording = recordingState.recording;
    recordingState = next;
    renderRecordingButton();
    if (wasRecording && !next.recording) {
      // Stop fired — download the bundle. Wired in C55 (W12-3).
      await onRecordingStopped();
    }
  } catch {
    /* swallow — sidepanel is best-effort */
  }
}

function renderRecordingButton(): void {
  const btn = document.getElementById('record-toggle');
  if (!(btn instanceof HTMLButtonElement)) return;
  if (recordingState.recording) {
    btn.classList.add('recording');
    btn.textContent = '■ Stop · 00:00';
    updateRecordTimer();
  } else {
    btn.classList.remove('recording');
    btn.textContent = '● Record';
  }
}

function updateRecordTimer(): void {
  if (!recordingState.recording || !recordingState.startedAt) return;
  const btn = document.getElementById('record-toggle');
  if (!(btn instanceof HTMLButtonElement)) return;
  const elapsed = Math.floor((Date.now() - recordingState.startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  btn.textContent = `■ Stop · ${mm}:${ss}`;
}

/** Called when toggleRecording observes the transition true → false.
 *  Fetches the current event buffer (which already includes the
 *  recording.start / .stop bookends) and downloads a replay bundle
 *  named after the recording rather than the live session.
 *  PRD §6.5.2 "Stopping & Bundling". */
async function onRecordingStopped(): Promise<void> {
  if (tabId == null) return;
  try {
    const msg: GetEventsRuntimeMessage = { kind: 'GET_EVENTS', tabId };
    const result = await chrome.runtime.sendMessage(msg);
    const recordedEvents = Array.isArray(result) ? (result as CapturedEvent[]) : [];
    if (recordedEvents.length === 0) return;

    const html = generateBundle(recordedEvents, { appVersion: __APP_VERSION__ });
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const host = (() => {
      try {
        return new URL(recordedEvents[0]?.url ?? '').host || 'session';
      } catch {
        return 'session';
      }
    })();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `hindsight-recording-${host}-${ts}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  } catch {
    /* swallow — best-effort */
  }
}

// ---------------------------------------------------------------------------
// Popup ↔ sidepanel handoff (M4·W15-extra)
// ---------------------------------------------------------------------------

const FOCUS_EVENT_KEY = 'sidepanel/focus-event';
const FOCUS_FILTER_KEY = 'sidepanel/focus-filter';

let pendingFocusEventId: string | null = null;

/** Reads any focus hint the popup planted and clears it so a later
 *  re-open of the panel doesn't re-trigger. Sets filterMode if the
 *  popup asked for one. */
async function consumePopupFocus(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([FOCUS_EVENT_KEY, FOCUS_FILTER_KEY]);
    const filter = stored[FOCUS_FILTER_KEY];
    const eventId = stored[FOCUS_EVENT_KEY];
    if (
      typeof filter === 'string' &&
      (filter === 'failed' || filter === 'api' || filter === 'all')
    ) {
      filterMode = filter;
    }
    if (typeof eventId === 'string' && eventId.length > 0) {
      pendingFocusEventId = eventId;
    }
    await chrome.storage.local.remove([FOCUS_EVENT_KEY, FOCUS_FILTER_KEY]);
  } catch {
    /* swallow — handoff is best-effort */
  }
  syncFilterChipsToState();
}

/** Reflects the in-memory filterMode onto the toolbar chip DOM. Shared
 *  by init (load-from-storage), consumePopupFocus, and the storage.
 *  onChanged listener so all three converge on the same UI. */
function syncFilterChipsToState(): void {
  document.querySelectorAll<HTMLElement>('.filter').forEach((b) => {
    const isActive = b.dataset.filter === filterMode;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

/** Once `events` has been populated by the first refresh, open the
 *  detail view for the focused event (if any) and scroll its row
 *  into the visible list. */
async function applyPopupFocus(): Promise<void> {
  if (!pendingFocusEventId) return;
  const target = events.find((e) => e.id === pendingFocusEventId);
  pendingFocusEventId = null;
  if (!target) return;
  showDetail(target);
}

/** When the side panel is already open and the user clicks a failure
 *  in the popup, the popup's chrome.sidePanel.open() doesn't re-init
 *  the page — the in-memory state stays. Listen for writes to the
 *  focus-event key so the running sidepanel reacts. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const filterChange = changes[FOCUS_FILTER_KEY];
  const eventChange = changes[FOCUS_EVENT_KEY];
  if (!filterChange && !eventChange) return;

  const nextFilter = filterChange?.newValue;
  if (
    typeof nextFilter === 'string' &&
    (nextFilter === 'failed' || nextFilter === 'api' || nextFilter === 'all')
  ) {
    setFilter(nextFilter);
  }
  const nextEventId = eventChange?.newValue;
  if (typeof nextEventId === 'string' && nextEventId.length > 0) {
    void (async () => {
      await refresh();
      const target = events.find((e) => e.id === nextEventId);
      if (target) showDetail(target);
    })();
  }
  // Clear the keys so a tab-switch that re-opens the panel doesn't
  // re-trigger this focus.
  void chrome.storage.local.remove([FOCUS_EVENT_KEY, FOCUS_FILTER_KEY]).catch(() => {});
});

// Signature of the last events array we rendered. Cheap stamp — length
// + last id + last timestamp catches every meaningful mutation without
// walking the whole buffer. Used to skip render() on poll cycles where
// nothing changed, which is the common case once the user stops
// interacting with the page. Pre-fix, every 1 s poll re-built the bulk
// bar's innerHTML and triggered a visible flicker on the buttons.
let lastEventsSignature = '';

function eventsSignature(list: CapturedEvent[]): string {
  if (list.length === 0) return '0';
  const last = list[list.length - 1]!;
  return `${list.length}|${last.id}|${last.timestamp}`;
}

/** Forces the next render() to run even if the events signature is
 *  stable — used when filter, host, or search inputs change because
 *  those affect rendering without touching the events array. */
function invalidateRenderCache(): void {
  lastEventsSignature = '';
}

async function refresh(): Promise<void> {
  if (tabId == null) return;
  try {
    const message: GetEventsRuntimeMessage = { kind: 'GET_EVENTS', tabId };
    const result = await chrome.runtime.sendMessage(message);
    events = Array.isArray(result) ? (result as CapturedEvent[]) : [];
    const sig = eventsSignature(events);
    if (sig === lastEventsSignature) return;
    lastEventsSignature = sig;
    render();
  } catch {
    /* service worker briefly inactive */
  }
}

// ---------------------------------------------------------------------------
// Archive viewer (PRD §6.1.3 archives/recent — populated by tab close).
// ---------------------------------------------------------------------------

async function refreshArchive(): Promise<void> {
  let archive: ArchivedSession[] = [];
  try {
    const message: GetArchiveRuntimeMessage = { kind: 'GET_ARCHIVE' };
    const result = await chrome.runtime.sendMessage(message);
    archive = Array.isArray(result) ? (result as ArchivedSession[]) : [];
  } catch {
    return;
  }
  renderArchive(archive);
}

function renderArchive(archive: ArchivedSession[]): void {
  const panel = document.getElementById('archive-panel');
  const countEl = document.getElementById('archive-count');
  const listEl = document.getElementById('archive-list');
  const clearLink = document.getElementById('archive-clear');
  if (!panel || !countEl || !listEl || !clearLink) return;

  if (archive.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  clearLink.classList.remove('hidden');
  countEl.textContent = `${archive.length} closed session${archive.length === 1 ? '' : 's'}`;

  listEl.innerHTML = archive
    .map((a, i) => {
      const host = (() => {
        try {
          return new URL(a.meta.origin).host;
        } catch {
          return a.meta.origin;
        }
      })();
      const when = new Date(a.archivedAt).toLocaleString();
      return `
        <details class="archive-entry" data-archive-idx="${i}">
          <summary>
            <strong>${escapeHtml(host)}</strong>
            <span class="muted">· ${a.events.length} event${a.events.length === 1 ? '' : 's'}</span>
            <span class="muted">· ${escapeHtml(when)}</span>
          </summary>
          <div class="archive-events"></div>
        </details>
      `;
    })
    .join('');

  // Lazy-render the inner event list when an entry expands — avoids
  // building thousands of rows up front for users with a full archive.
  listEl.querySelectorAll<HTMLDetailsElement>('details.archive-entry').forEach((details, i) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const inner = details.querySelector('.archive-events');
      if (!inner || inner.childNodes.length > 0) return;
      const session = archive[i];
      if (!session) return;
      inner.innerHTML = session.events
        .map((e) => {
          const row = formatRow(e);
          return `<div class="item ${row.className}">
            <div class="status">${escapeHtml(row.statusBadge)}</div>
            <div class="method">${escapeHtml(row.method)}</div>
            <div class="url" title="${escapeHtml(row.urlTitle)}">${escapeHtml(row.urlText)}</div>
            <div class="time">${fmtTime(row.timestamp)}</div>
            <div class="duration">${escapeHtml(row.duration)}</div>
          </div>`;
        })
        .join('');
    });
  });
}

async function clearArchiveAndRefresh(): Promise<void> {
  const message: ClearArchiveRuntimeMessage = { kind: 'CLEAR_ARCHIVE' };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* swallow */
  }
  await refreshArchive();
}

function setFilter(mode: FilterMode): void {
  filterMode = mode;
  syncFilterChipsToState();
  persistUiState();
  invalidateRenderCache();
  render();
}

async function clearAll(): Promise<void> {
  if (tabId == null) return;
  const message: ClearEventsRuntimeMessage = { kind: 'CLEAR_EVENTS', tabId };
  await chrome.runtime.sendMessage(message);
  await refresh();
}

// Map of rendered row id → event, populated each render() pass. Used by
// the delegated click handler on #list and by the scrubber's "scroll to
// nearest event" logic. Keying by event.id (which is a UUID minted in
// the SW) lets us round-trip from a DOM data-attr without re-walking the
// event list.
const renderedById = new Map<string, CapturedEvent>();
let listDelegationWired = false;

/** Rebuilds the host-picker option list (preserving the active
 *  selection across refreshes), the result-count hint, and the
 *  clear-host button visibility. The query bar itself is hidden until
 *  at least 2 events have arrived so the empty-state stays clean. */
function renderQueryBar(): void {
  const bar = document.getElementById('query-bar');
  const hostSelect = document.getElementById('host-select');
  const hostClear = document.getElementById('host-clear');
  const resultCount = document.getElementById('result-count');
  if (!bar || !(hostSelect instanceof HTMLSelectElement) || !hostClear || !resultCount) return;

  if (events.length < 2) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // Distinct hosts across the current buffer, alphabetized for stable
  // ordering. activeHost is preserved even if no events from it are
  // currently captured, so the user can switch tabs without losing the
  // pin.
  const distinct = new Set<string>();
  for (const e of events) {
    const h = eventHost(e);
    if (h) distinct.add(h);
  }
  const hosts = [...distinct].sort();
  if (activeHost && !distinct.has(activeHost)) hosts.unshift(activeHost);

  const prev = hostSelect.value;
  hostSelect.innerHTML =
    `<option value="">Any</option>` +
    hosts.map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
  hostSelect.value = activeHost ?? '';
  // Restore prev only when activeHost is empty AND the prev option
  // still exists — covers select-blur races during refresh.
  if (!activeHost && prev && hosts.includes(prev)) hostSelect.value = prev;

  hostClear.classList.toggle('hidden', !activeHost);

  const filteredCount = filteredEvents(events, filterMode).length;
  resultCount.textContent = `${filteredCount} / ${events.length}`;
}

function render(): void {
  const list = document.getElementById('list');
  const bulkBar = document.getElementById('bulk-bar');
  if (!list || !bulkBar) return;

  // Query bar visible whenever we have at least 2 events — same gate
  // as the scrubber. Avoids the awkward "empty panel + search box"
  // first impression.
  renderQueryBar();

  // beforeTime: filtered by mode/host/search but NOT by the time range
  // — that's the histogram the scrubber visualises, with bars outside
  // the [start, end] handles dimmed. `data` is the final view that
  // honours every filter dimension including the time range.
  const beforeTime = filteredEvents(events, filterMode, activeHost, searchQuery, [0, 100]);
  const data = filteredEvents(events, filterMode);

  renderScrubber(beforeTime);

  if (data.length === 0) {
    const reason = searchQuery.trim() ? 'search' : activeHost ? 'host' : filterMode;
    const empties: Record<string, { title: string; sub: string }> = {
      failed: {
        title: 'No errors yet',
        sub: 'Switch to "All" to see every captured event.',
      },
      api: {
        title: 'No API calls yet',
        sub: 'Framework chunks, static assets, and prefetches are hidden — browse the page and trigger a data fetch.',
      },
      all: {
        title: 'No events yet',
        sub: 'Browse the page — clicks, requests, navigations, console errors appear here.',
      },
      search: {
        title: 'No matches',
        sub: 'Nothing in the current filter matches your search. Try clearing it or switch to "All".',
      },
      host: {
        title: 'No events from that host',
        sub: `Clear the host filter (× next to the picker) to see events from other origins.`,
      },
    };
    const e = empties[reason] ?? empties.all;
    list.innerHTML = `
      <div class="empty">
        <div class="empty-title">${escapeHtml(e!.title)}</div>
        <div class="empty-sub">${escapeHtml(e!.sub)}</div>
      </div>`;
    bulkBar.classList.add('hidden');
    return;
  }

  renderedById.clear();
  list.innerHTML = renderListHtml(data);

  // One delegated click listener on the list — independent of how many
  // rows are in the DOM. Also handles cluster expand/collapse via
  // [data-cluster-head] toggle.
  if (!listDelegationWired) {
    list.addEventListener('click', (clickEvent) => {
      const target = clickEvent.target;
      if (!(target instanceof Element)) return;
      const clusterToggle = target.closest<HTMLElement>('[data-cluster-toggle]');
      if (clusterToggle) {
        const headId = clusterToggle.dataset.clusterToggle;
        if (headId) toggleCluster(headId);
        return;
      }
      const row = target.closest<HTMLElement>('[data-event-id]');
      if (!row) return;
      const id = row.dataset.eventId;
      if (!id) return;
      const evt = renderedById.get(id);
      if (evt) showDetail(evt);
    });
    listDelegationWired = true;
  }

  renderBulkBar(data);
}

// Set of cluster heads currently expanded. Persists across renders.
const expandedClusters = new Set<string>();

function toggleCluster(headId: string): void {
  if (expandedClusters.has(headId)) expandedClusters.delete(headId);
  else expandedClusters.add(headId);
  invalidateRenderCache();
  render();
}

/** Returns the HTML for the visible event list. Newest-first, with
 *  cascade clusters collapsed under their head (PRD §6.2.3). */
function renderListHtml(data: CapturedEvent[]): string {
  // Build cluster index: headId → members (excluding head itself).
  const membersByHead = new Map<string, CapturedEvent[]>();
  for (const e of data) {
    const head = e.meta?.cascadeOf;
    if (!head) continue;
    const arr = membersByHead.get(head) ?? [];
    arr.push(e);
    membersByHead.set(head, arr);
  }

  const headIds = new Set(membersByHead.keys());
  const memberIds = new Set<string>();
  for (const arr of membersByHead.values()) {
    for (const e of arr) memberIds.add(e.id);
  }

  const reversed = data.slice().reverse();
  const parts: string[] = [];

  for (const e of reversed) {
    // Skip members — they render inside their cluster head's expansion.
    if (memberIds.has(e.id)) continue;
    renderedById.set(e.id, e);

    if (headIds.has(e.id)) {
      const members = membersByHead.get(e.id) ?? [];
      // Register members so click → detail still works when expanded.
      for (const m of members) renderedById.set(m.id, m);
      const expanded = expandedClusters.has(e.id);
      parts.push(renderClusterBanner(e, members, expanded));
      if (expanded) {
        // Render every member of the cluster (newest-first) plus the
        // head itself, all indented. The banner stays at the top.
        const all = [e, ...members].sort((a, b) => b.timestamp - a.timestamp);
        for (const m of all) parts.push(renderEventRow(m, true));
      }
    } else {
      parts.push(renderEventRow(e, false));
    }
  }
  return parts.join('');
}

function renderEventRow(e: CapturedEvent, indented: boolean): string {
  const row = formatRow(e);
  return `<div class="item ${row.className}${indented ? ' cluster-member' : ''}" data-event-id="${escapeHtml(e.id)}">
    <div class="status">${escapeHtml(row.statusBadge)}</div>
    <div class="method">${escapeHtml(row.method)}</div>
    <div class="url" title="${escapeHtml(row.urlTitle)}">${escapeHtml(row.urlText)}</div>
    <div class="time">${fmtTime(row.timestamp)}</div>
    <div class="duration">${escapeHtml(row.duration)}</div>
  </div>`;
}

/** Renders one banner per cluster summarizing all members at a glance
 *  (PRD §6.2.3 example: "🔴 401 cascade — POST /Token/auth — 3 failures
 *  in 5s [expand 3 →]"). The banner is itself the toggle target. */
function renderClusterBanner(
  head: CapturedEvent,
  members: CapturedEvent[],
  expanded: boolean
): string {
  const all = [head, ...members];
  const summary = summarizeCluster(all);
  const arrow = expanded ? '▾' : '▸';
  const totalCount = all.length;
  return `<div class="cluster-banner ${summary.severity}" data-cluster-toggle="${escapeHtml(head.id)}" aria-expanded="${expanded ? 'true' : 'false'}" role="button" tabindex="0">
    <span class="cluster-banner-icon" aria-hidden="true">${summary.icon}</span>
    <span class="cluster-banner-title"><strong>${escapeHtml(summary.title)}</strong></span>
    <span class="cluster-banner-meta">${escapeHtml(summary.subtitle)}</span>
    <span class="cluster-banner-toggle"><span aria-hidden="true">${arrow}</span> ${totalCount}</span>
  </div>`;
}

interface ClusterSummary {
  title: string;
  subtitle: string;
  icon: string;
  severity: 'severity-error' | 'severity-warn' | 'severity-info';
}

function summarizeCluster(all: CapturedEvent[]): ClusterSummary {
  const networkMembers = all.filter(isRequestLike);
  const failingMembers = all.filter(isErrorEvent);
  const consoleMembers = all.filter(
    (e): e is CapturedEvent => e.type === 'console.error' || e.type === 'console.unhandled'
  );

  const earliest = Math.min(...all.map((e) => e.timestamp));
  const latest = Math.max(...all.map((e) => e.timestamp));
  const spanSec = Math.max(1, Math.round((latest - earliest) / 1000));

  // Network-dominant cascade: pull origin + dominant status/method/path.
  if (networkMembers.length > 0) {
    const dominantStatus = mode(networkMembers.map((e) => e.data.response.status || 0));
    const dominantMethod = mode(networkMembers.map((e) => e.data.request.method));
    const samePath = networkMembers.every(
      (e) => safePath(e.data.request.url) === safePath(networkMembers[0]!.data.request.url)
    );
    const pathLabel = samePath ? safePath(networkMembers[0]!.data.request.url) : 'various';
    const host = (() => {
      try {
        return new URL(networkMembers[0]!.data.request.url).host;
      } catch {
        return '';
      }
    })();
    return {
      title: `${dominantStatus} cascade — ${dominantMethod} ${pathLabel}`,
      subtitle: `${failingMembers.length} failure${failingMembers.length === 1 ? '' : 's'} in ${spanSec}s${host ? ` · ${host}` : ''}`,
      icon: '🔴',
      severity: 'severity-error',
    };
  }

  // Console-only cluster.
  if (consoleMembers.length > 0) {
    return {
      title: `console cluster — ${consoleMembers.length} error${consoleMembers.length === 1 ? '' : 's'}`,
      subtitle: `${consoleMembers.length} in ${spanSec}s`,
      icon: '🔴',
      severity: 'severity-error',
    };
  }

  return {
    title: `cluster — ${all.length} events`,
    subtitle: `${all.length} in ${spanSec}s`,
    icon: '⚠️',
    severity: 'severity-warn',
  };
}

function mode<T>(values: T[]): T | string {
  if (values.length === 0) return '?';
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T = values[0]!;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// (legacy renderClusterHead removed in M3·W11-2 — renderClusterBanner
// is the successor surface; M2's per-row toggle is gone.)

// ---------------------------------------------------------------------------
// Visual timeline scrubber (PRD §6.3.3)
// ---------------------------------------------------------------------------

const SCRUBBER_BUCKETS = 40;

/** Appends class names derived from detection flags so CSS can paint
 *  cascade members / slow requests / anomalies distinctly. */
function classNameFromFlags(base: string, e: CapturedEvent): string {
  const flags = e.meta?.flags;
  if (!flags || flags.length === 0) return base;
  const extras: string[] = [];
  if (flags.includes('slow')) extras.push('flag-slow');
  if (flags.includes('cascade-member') || flags.includes('cascade-head'))
    extras.push('flag-cascade');
  if (flags.includes('anomaly')) extras.push('flag-anomaly');
  return [base, ...extras].join(' ');
}

/** Renders the timeline scrubber from the post-base-filter set (i.e.
 *  events filtered by mode/host/search but NOT yet by the time range).
 *  The two range inputs let the user clip a [start, end] sub-window;
 *  bars whose bucket falls outside the window are dimmed via CSS. */
function renderScrubber(beforeTime: CapturedEvent[]): void {
  const wrap = document.getElementById('scrubber');
  const bars = document.getElementById('scrubber-bars');
  const startInput = document.getElementById('scrubber-start-input');
  const endInput = document.getElementById('scrubber-end-input');
  const trackSelected = document.getElementById('scrubber-track-selected');
  const startLabel = document.getElementById('scrubber-start');
  const endLabel = document.getElementById('scrubber-end');
  const resetBtn = document.getElementById('scrubber-reset');
  if (
    !wrap ||
    !bars ||
    !(startInput instanceof HTMLInputElement) ||
    !(endInput instanceof HTMLInputElement) ||
    !trackSelected ||
    !startLabel ||
    !endLabel ||
    !(resetBtn instanceof HTMLButtonElement)
  ) {
    return;
  }

  if (beforeTime.length < 2) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  const sorted = [...beforeTime].sort((a, b) => a.timestamp - b.timestamp);
  const tFirst = sorted[0]!.timestamp;
  const tLast = sorted[sorted.length - 1]!.timestamp;
  const span = Math.max(1, tLast - tFirst);

  // Density histogram — count events per bucket.
  const counts = new Array<number>(SCRUBBER_BUCKETS).fill(0);
  for (const e of sorted) {
    const idx = Math.min(
      SCRUBBER_BUCKETS - 1,
      Math.floor(((e.timestamp - tFirst) / span) * SCRUBBER_BUCKETS)
    );
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const peak = Math.max(...counts, 1);
  const [startPct, endPct] = timeRangePct;
  const startBucket = Math.floor((startPct / 100) * SCRUBBER_BUCKETS);
  const endBucket = Math.ceil((endPct / 100) * SCRUBBER_BUCKETS);

  bars.innerHTML = counts
    .map((c, i) => {
      const h = Math.round((c / peak) * 100);
      const dim = i < startBucket || i >= endBucket ? ' out-of-range' : '';
      return `<div class="scrubber-bar${dim}" style="height:${h}%" aria-hidden="true"></div>`;
    })
    .join('');

  // Labels show the SELECTED window's start/end — not the session
  // boundaries — so the user can read off exactly what they're filtering.
  const startMs = tFirst + (span * startPct) / 100;
  const endMs = tFirst + (span * endPct) / 100;
  startLabel.textContent = fmtTime(startMs);
  endLabel.textContent = fmtTime(endMs);

  // Sync input values to current state on each render (after a non-user
  // mutation, e.g. switching filter mode, the inputs would otherwise
  // drift from timeRangePct).
  startInput.value = String(startPct);
  endInput.value = String(endPct);
  trackSelected.style.left = `${startPct}%`;
  trackSelected.style.right = `${100 - endPct}%`;
  resetBtn.classList.toggle('hidden', startPct === 0 && endPct === 100);

  if (!startInput.dataset.wired) {
    const onChange = (): void => {
      let s = Number(startInput.value);
      let e = Number(endInput.value);
      // Enforce a 1% minimum gap so handles can't swap.
      if (s >= e) {
        if (document.activeElement === startInput) s = e - 1;
        else e = s + 1;
      }
      s = Math.max(0, Math.min(99, s));
      e = Math.max(s + 1, Math.min(100, e));
      timeRangePct = [s, e];
      invalidateRenderCache();
      render();
    };
    startInput.addEventListener('input', onChange);
    endInput.addEventListener('input', onChange);
    resetBtn.addEventListener('click', () => {
      timeRangePct = [0, 100];
      invalidateRenderCache();
      render();
    });
    startInput.dataset.wired = '1';
  }
}

/** Dispatch on event.type to populate the five-column row layout shared
 *  across all event families. Network keeps the existing semantics; other
 *  types repurpose the columns so the table stays visually consistent. */
function formatRow(e: CapturedEvent): {
  className: string;
  statusBadge: string;
  method: string;
  urlText: string;
  urlTitle: string;
  timestamp: number;
  duration: string;
} {
  if (e.type === 'network.fetch' || e.type === 'network.xhr') {
    const failed = isFailedNetwork(e);
    return {
      className: classNameFromFlags(failed ? 'failed' : 'success', e),
      statusBadge: String(e.data.response.status || 'ERR'),
      method: e.data.request.method,
      urlText: shortUrl(e.data.request.url),
      urlTitle: e.data.request.url,
      timestamp: e.data.timing.startedAt,
      duration: `${e.data.timing.durationMs}ms`,
    };
  }
  if (e.type === 'console.error' || e.type === 'console.unhandled') {
    return {
      className: 'failed',
      statusBadge: e.type === 'console.unhandled' ? 'UNC' : 'ERR',
      method: 'LOG',
      urlText: e.data.message,
      urlTitle: e.data.message,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'console.warn' || e.type === 'console.info') {
    return {
      className: 'success',
      statusBadge: e.type === 'console.warn' ? 'WRN' : 'INF',
      method: 'LOG',
      urlText: e.data.message,
      urlTitle: e.data.message,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'action.click') {
    const name = e.data.target.accessibleName ?? e.data.target.tag.toLowerCase();
    return {
      className: 'success',
      statusBadge: 'CLK',
      method: '',
      urlText: `<${e.data.target.tag.toLowerCase()}> ${name}`,
      urlTitle: name,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'action.input') {
    const name = e.data.target.accessibleName ?? e.data.target.tag.toLowerCase();
    const masked = e.meta?.redactions?.some((r) => r.scope === 'form.value');
    return {
      className: 'success',
      statusBadge: masked ? 'INP🛡' : 'INP',
      method: '',
      urlText: `${name} = ${e.data.value}`,
      urlTitle: name,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'navigation') {
    const fromHost = (() => {
      try {
        return e.data.fromUrl ? new URL(e.data.fromUrl).host : null;
      } catch {
        return null;
      }
    })();
    const toHost = (() => {
      try {
        return new URL(e.data.toUrl).host;
      } catch {
        return e.data.toUrl;
      }
    })();
    const text = fromHost ? `${fromHost} → ${toHost}` : `→ ${toHost}`;
    return {
      className: 'success',
      statusBadge: 'NAV',
      method: '',
      urlText: text,
      urlTitle: e.data.toUrl,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'performance.longtask') {
    return {
      className: 'success flag-slow',
      statusBadge: 'PER',
      method: 'LT',
      urlText: e.data.attribution ? `Long task · ${e.data.attribution}` : 'Long task',
      urlTitle: e.data.attribution ?? 'long task',
      timestamp: e.timestamp,
      duration: `${e.data.durationMs}ms`,
    };
  }
  if (e.type === 'performance.cls') {
    return {
      className: 'success',
      statusBadge: 'CLS',
      method: e.data.hadRecentInput ? 'usr' : '',
      urlText: `Layout shift · ${e.data.value.toFixed(4)}`,
      urlTitle: `cls=${e.data.value.toFixed(4)}`,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  if (e.type === 'screenshot') {
    return {
      className: 'success',
      statusBadge: '📷',
      method: e.data.trigger,
      urlText: 'Screenshot at error moment',
      urlTitle: e.data.storageRef,
      timestamp: e.timestamp,
      duration: '',
    };
  }
  // Fallback for the remaining event types (network.websocket,
  // network.sse, recording.*, mutation, cursor) — picked up by name.
  return {
    className: 'success',
    statusBadge: e.type.split('.')[0]?.toUpperCase().slice(0, 3) ?? 'EVT',
    method: '',
    urlText: e.type,
    urlTitle: e.type,
    timestamp: e.timestamp,
    duration: '',
  };
}

function renderBulkBar(data: CapturedEvent[]): void {
  const bulkBar = document.getElementById('bulk-bar');
  if (!bulkBar) return;
  const networkItems = data.filter(isRequestLike);
  const failedCount = data.filter(isErrorEvent).length;
  const narrative = data.length >= 2 ? narrate(data) : '';
  const networkBody = buildBulkReport(networkItems);
  const networkReport = narrative ? `${narrative}\n\n---\n\n${networkBody}` : networkBody;
  const isOversize = networkReport.length > SLACK_SAFE_THRESHOLD;
  const hasNetwork = networkItems.length > 0;

  bulkBar.classList.remove('hidden');
  bulkBar.innerHTML = `
    <div class="bulk-count">
      <strong>${data.length}</strong> events
      ${failedCount > 0 ? `· <span class="error-count">${failedCount} error${failedCount === 1 ? '' : 's'}</span>` : ''}
      ${hasNetwork ? `· ${networkItems.length} network` : ''}
    </div>
    <div class="bulk-actions">
      ${hasNetwork ? `<button id="copy-all" class="${isOversize ? 'warning' : 'primary'}" title="Copy ${networkItems.length} network request${networkItems.length === 1 ? '' : 's'} + screenshot">📋 Copy network</button>` : ''}
      <button id="download-all" title="Download every captured event as JSON">⤓ JSON</button>
      <button id="download-har" ${hasNetwork ? '' : 'disabled title="No network requests in scope — HAR has nothing to export"'}>⤓ HAR</button>
      <button id="download-bundle" title="Download as a self-contained HTML replay bundle (PRD §5)">⤓ Bundle</button>
      <button id="download-zip" title="Download everything as one ZIP — markdown, JSON, HAR, bundle, screenshots">⤓ ZIP</button>
      <span id="share-buttons" class="share-buttons"></span>
    </div>
  `;
  // Async-populate the share buttons after the bulk-bar HTML lands so
  // the render() function stays synchronous. Sharing config lives in
  // chrome.storage.sync and is rarely changed mid-session.
  void renderShareButtons(data);

  document.getElementById('copy-all')?.addEventListener('click', async (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    btn.textContent = '… rendering';
    const r = await writeTextAndImage(networkReport, networkItems, {
      maxText: SLACK_SAFE_THRESHOLD,
    });

    if (r.textSkipped && r.hasImage) {
      downloadAllAsFile(networkItems);
      btn.textContent = `✓ Image · JSON ⤓ (text too long)`;
    } else if (r.hasImage && r.hasText) {
      btn.textContent = `✓ Copied ${networkItems.length} + image`;
    } else if (r.hasText) {
      btn.textContent = `✓ Copied text only`;
    } else if (r.hasImage) {
      btn.textContent = `✓ Image copied`;
    } else {
      btn.textContent = 'Copy failed';
    }
    btn.classList.add('copied');
    setTimeout(() => renderBulkBar(filteredEvents(events, filterMode)), 2200);
  });

  document.getElementById('download-all')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    downloadEventsAsJson(data);
    btn.textContent = '✓ Downloaded';
    btn.classList.add('copied');
    setTimeout(() => renderBulkBar(filteredEvents(events, filterMode)), 1800);
  });

  document.getElementById('download-har')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    if (networkItems.length === 0) return;
    try {
      downloadAsHar(networkItems);
      btn.textContent = '✓ HAR ⤓';
      btn.classList.add('copied');
    } catch {
      btn.textContent = 'No requests';
    }
    setTimeout(() => renderBulkBar(filteredEvents(events, filterMode)), 1800);
  });

  document.getElementById('download-bundle')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    downloadAsBundle(data);
    btn.textContent = '✓ Bundle ⤓';
    btn.classList.add('copied');
    setTimeout(() => renderBulkBar(filteredEvents(events, filterMode)), 1800);
  });

  document.getElementById('download-zip')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    btn.textContent = '… packing';
    try {
      downloadAsZip(data);
      btn.textContent = '✓ ZIP ⤓';
      btn.classList.add('copied');
    } catch {
      btn.textContent = 'ZIP failed';
    }
    setTimeout(() => renderBulkBar(filteredEvents(events, filterMode)), 1800);
  });
}

/** Generates and downloads a standalone HTML replay bundle (PRD §5).
 *  Works on the full mixed event list; the viewer inside the bundle
 *  handles per-type rendering itself. */
/** Renders Send-to-<destination> buttons for every webhook URL the
 *  user has configured. Privacy preview before send (PRD §6.4.4):
 *  the user gets a confirm() dialog summarizing event count + the
 *  destination before any network request fires. */
async function renderShareButtons(data: CapturedEvent[]): Promise<void> {
  const container = document.getElementById('share-buttons');
  if (!container) return;
  let sharing: SharingSettings;
  try {
    sharing = await readSharingSettings();
  } catch {
    return;
  }
  const configured: Array<{ dest: WebhookDestination; url: string; label: string }> = [];
  if (sharing.slackWebhook)
    configured.push({ dest: 'slack', url: sharing.slackWebhook, label: 'Slack' });
  if (sharing.discordWebhook)
    configured.push({ dest: 'discord', url: sharing.discordWebhook, label: 'Discord' });
  if (sharing.teamsWebhook)
    configured.push({ dest: 'teams', url: sharing.teamsWebhook, label: 'Teams' });

  const webhookHtml = configured
    .map((c) => `<button class="share-btn" data-dest="${c.dest}">→ ${escapeHtml(c.label)}</button>`)
    .join('');
  const githubAvailable = sharing.githubOwner && sharing.githubRepo;
  const intentHtml = `
    ${githubAvailable ? '<button class="share-btn" data-intent="github">→ GitHub</button>' : ''}
    <button class="share-btn" data-intent="email">→ Email</button>
  `;
  container.innerHTML = webhookHtml + intentHtml;

  container.querySelectorAll<HTMLButtonElement>('[data-intent]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const intent = btn.dataset.intent;
      let result: { url: string; truncated: boolean } | null = null;
      if (intent === 'github') {
        result = buildGithubIssueUrl(data, {
          owner: sharing.githubOwner,
          repo: sharing.githubRepo,
        });
      } else if (intent === 'email') {
        result = buildMailtoUrl(data, { to: sharing.emailTo || undefined });
      }
      if (!result) return;
      window.open(result.url, '_blank', 'noopener,noreferrer');
      const original = btn.textContent ?? '';
      btn.textContent = result.truncated ? '✓ Opened (truncated)' : '✓ Opened';
      setTimeout(() => {
        btn.textContent = original;
      }, 2200);
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.share-btn[data-dest]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dest = btn.dataset.dest as WebhookDestination;
      const entry = configured.find((c) => c.dest === dest);
      if (!entry) return;
      const confirmed = await showPrivacyPreview({
        destinationLabel: entry.label,
        destinationDetail: entry.url,
        events: data,
      });
      if (!confirmed) return;
      const original = btn.textContent ?? '';
      btn.disabled = true;
      btn.textContent = '… sending';
      const result = await dispatchToWebhook(dest, entry.url, data);
      if (result.ok) {
        btn.textContent = `✓ Sent${result.truncated ? ' (truncated)' : ''}`;
      } else {
        btn.textContent = `✗ ${result.error ?? 'failed'}`;
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = original;
      }, 2400);
    });
  });
}

/** Packs the full session into a single .zip with markdown / JSON / HAR
 *  / replay-bundle / inline screenshots. PRD §6.4.2 — one shareable
 *  artifact when the user wants every representation at once. */
function downloadAsZip(items: CapturedEvent[]): void {
  const encoder = new TextEncoder();
  const networkItems = items.filter(isRequestLike);
  const entries: ZipEntry[] = [];

  const markdown = toMarkdownReport(items, { title: deriveSessionTitle(items) });
  if (markdown) entries.push({ name: 'report.md', data: encoder.encode(markdown) });

  const jsonPayload = items.map((e) => (isRequestLike(e) ? maskedEventForExport(e) : e));
  const narrative = items.length >= 2 ? narrate(items) : '';
  const sessionJson = narrative
    ? { _narrative: narrative, events: jsonPayload }
    : { events: jsonPayload };
  entries.push({
    name: 'session.json',
    data: encoder.encode(JSON.stringify(sessionJson, null, 2)),
  });

  if (networkItems.length > 0) {
    const maskedItems = networkItems.map(maskedEventForExport);
    const har = toHar(maskedItems, {
      creatorVersion: __APP_VERSION__,
      browser: parseBrowser(navigator.userAgent),
      pageTitle: items[0]?.url ?? 'Hindsight Session',
    });
    entries.push({
      name: 'session.har',
      data: encoder.encode(JSON.stringify({ log: har }, null, 2)),
    });
  }

  entries.push({
    name: 'replay.html',
    data: encoder.encode(generateBundle(items, { appVersion: __APP_VERSION__ })),
  });

  // Inline screenshot payloads — strip the `data:image/...;base64,`
  // prefix and stash one .jpg per event so the recipient can browse
  // them without a viewer. Files are numbered by their position in the
  // chronological event list.
  let shotIdx = 0;
  for (const e of items) {
    if (e.type !== 'screenshot') continue;
    const url = e.data.dataUrl;
    if (!url) continue;
    const decoded = decodeDataUrlToBytes(url);
    if (!decoded) continue;
    const name = `screenshots/${String(++shotIdx).padStart(3, '0')}-${e.data.trigger}.${decoded.ext}`;
    entries.push({ name, data: decoded.bytes });
  }

  const zip = buildZip(entries);
  // Slice() returns a Uint8Array<ArrayBuffer> regardless of the source
  // buffer kind, which satisfies Blob's BlobPart constraint without
  // forcing a SharedArrayBuffer cast at the call site.
  const blob = new Blob([zip.slice().buffer], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const host = deriveSessionHost(items);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `hindsight-${host}-${ts}.zip`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function deriveSessionTitle(items: CapturedEvent[]): string {
  const host = deriveSessionHost(items);
  return `Hindsight session · ${host}`;
}

function deriveSessionHost(items: CapturedEvent[]): string {
  for (const e of items) {
    try {
      const h = new URL(e.url).host;
      if (h) return h;
    } catch {
      /* keep looking */
    }
  }
  return 'session';
}

function decodeDataUrlToBytes(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = (match[1] ?? 'application/octet-stream').toLowerCase();
  const payload = match[2] ?? '';
  const isBase64 = /;base64/i.test(dataUrl);
  let bytes: Uint8Array;
  try {
    if (isBase64) {
      const bin = atob(payload);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
  } catch {
    return null;
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { bytes, ext };
}

function downloadAsBundle(items: CapturedEvent[]): void {
  const html = generateBundle(items, { appVersion: __APP_VERSION__ });
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const host = (() => {
    try {
      return new URL(items[0]?.url ?? '').host || 'session';
    } catch {
      return 'session';
    }
  })();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `hindsight-${host}-${ts}.html`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/** Downloads every event currently in scope as a single JSON file.
 *  Distinct from downloadAllAsFile (network-only) — this is the full
 *  session dump. Network request bodies pass through maskedEventForExport
 *  as a defense-in-depth net; non-network events ship as-is (already
 *  meta.redactions-annotated where applicable). */
function downloadEventsAsJson(items: CapturedEvent[]): void {
  const events = items.map((e) => {
    if (isRequestLike(e)) return maskedEventForExport(e);
    return e;
  });
  const narrative = narrate(items);
  // Narrative under a `_narrative` key so JSON consumers can spot the
  // synthetic field by convention; events stays the canonical payload.
  const payload = narrative ? { _narrative: narrative, events } : { events };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `hindsight-session-${items.length}-events-${ts}.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/** Triggers a HAR 1.2 file download for the given events. Mapper lives
 *  in src/lib/har.ts; this function just handles the Blob + anchor dance. */
function downloadAsHar(items: NetworkRequestEvent[]): void {
  const maskedItems = items.map(maskedEventForExport);
  const har = toHar(maskedItems, {
    creatorVersion: __APP_VERSION__,
    browser: parseBrowser(navigator.userAgent),
    pageTitle: items[0]?.url ?? 'Hindsight Session',
  });
  const json = JSON.stringify({ log: har }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const host = (() => {
    try {
      return new URL(items[0]?.url ?? '').host || 'session';
    } catch {
      return 'session';
    }
  })();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `hindsight-${host}-${ts}.har`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function parseBrowser(ua: string): { name: string; version: string } | undefined {
  // Lightweight UA sniff — sufficient for the optional HAR `browser` block.
  const m = /(Edg|Chrome|Firefox|Safari)\/([\d.]+)/.exec(ua);
  if (!m || !m[1] || !m[2]) return undefined;
  const name = m[1] === 'Edg' ? 'Edge' : m[1];
  return { name, version: m[2] };
}

function buildBulkReport(items: NetworkRequestEvent[]): string {
  if (items.length === 0) return '';
  if (items.length === 1 && items[0]) return toBugReport(items[0]);

  const first = items[0];
  const lines = [
    `## ${items.length} API errors`,
    '',
    `Captured: ${new Date().toISOString()}`,
    `Page: ${first?.url ?? '-'}`,
    '',
    '### Summary',
    ...items.map((c, i) => {
      const path = (() => {
        try {
          return new URL(c.data.request.url).pathname;
        } catch {
          return c.data.request.url;
        }
      })();
      return `${i + 1}. \`${c.data.response.status || 'ERR'}\` ${c.data.request.method} ${path} · ${fmtTime(c.data.timing.startedAt)} · ${c.data.timing.durationMs}ms`;
    }),
    '',
    '---',
    '',
  ];
  items.forEach((c, i) => {
    lines.push(`# Request ${i + 1} of ${items.length}`);
    lines.push('');
    lines.push(toBugReport(c));
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function downloadAllAsFile(items: NetworkRequestEvent[]): void {
  const payload = items.map((c) => maskedEventForExport(c));
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `bugs-${items.length}-items-${ts}.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

function showDetail(e: CapturedEvent): void {
  if (isRequestLike(e)) {
    showNetworkDetail(e);
  } else {
    showSimpleDetail(e);
  }
}

/** Detail view for non-network event families. Smaller surface than the
 *  network view (no Request/Response panels, no HAR/cURL) but still wired
 *  to the redactions panel and the bulk-bar restore on Back. */
function showSimpleDetail(e: CapturedEvent): void {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const row = formatRow(e);
  const body = renderSimpleDetailBody(e);

  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="detail-top">
      <div class="detail-back">
        <button id="back" class="secondary">← Back</button>
        <span class="time">${new Date(e.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="detail-heading ${row.className}">
        <span class="pill">${escapeHtml(row.statusBadge)}</span>
        <strong>${escapeHtml(e.type)}</strong>
      </div>
    </div>
    ${renderScreenshotPanel(findPairedScreenshot(e.id))}
    ${renderRedactionsPanel(e.meta?.redactions)}
    ${body}
  `;

  document.getElementById('back')?.addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    const data = filteredEvents(events, filterMode);
    if (data.length > 0) document.getElementById('bulk-bar')?.classList.remove('hidden');
  });
  document.getElementById('bulk-bar')?.classList.add('hidden');
}

function renderSimpleDetailBody(e: CapturedEvent): string {
  if (
    e.type === 'console.error' ||
    e.type === 'console.unhandled' ||
    e.type === 'console.warn' ||
    e.type === 'console.info'
  ) {
    const source = e.data.source
      ? `<div class="hint">${escapeHtml(e.data.source.file)}:${e.data.source.line}${e.data.source.column != null ? ':' + e.data.source.column : ''}</div>`
      : '';
    return `
      <div class="section">
        <h3>Message</h3>
        <pre>${escapeHtml(e.data.message)}</pre>
        ${source}
      </div>
      ${
        e.data.stack
          ? `<div class="section" style="padding-bottom: 16px;">
              <h3>Stack</h3>
              <pre>${escapeHtml(e.data.stack)}</pre>
             </div>`
          : ''
      }
    `;
  }
  if (e.type === 'action.click') {
    return `
      <div class="section">
        <h3>Target</h3>
        <pre>${escapeHtml(JSON.stringify(e.data.target, null, 2))}</pre>
      </div>
      <div class="section" style="padding-bottom: 16px;">
        <h3>Modifiers</h3>
        <pre>${escapeHtml(JSON.stringify(e.data.modifiers, null, 2))} · button=${e.data.button}</pre>
      </div>
    `;
  }
  if (e.type === 'action.input') {
    return `
      <div class="section">
        <h3>Target</h3>
        <pre>${escapeHtml(JSON.stringify(e.data.target, null, 2))}</pre>
      </div>
      <div class="section" style="padding-bottom: 16px;">
        <h3>Value</h3>
        <pre>${escapeHtml(e.data.value)}</pre>
        ${e.data.inputType ? `<div class="hint">input type: ${escapeHtml(e.data.inputType)}</div>` : ''}
      </div>
    `;
  }
  if (e.type === 'navigation') {
    return `
      <div class="section" style="padding-bottom: 16px;">
        <h3>Transition</h3>
        <pre>${escapeHtml(e.data.fromUrl ?? '(initial)')}\n  →\n${escapeHtml(e.data.toUrl)}</pre>
        ${e.data.transitionType ? `<div class="hint">transitionType: ${escapeHtml(e.data.transitionType)}</div>` : ''}
      </div>
    `;
  }
  // Other event types — fall back to a raw JSON view.
  return `
    <div class="section" style="padding-bottom: 16px;">
      <h3>Raw event</h3>
      <pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre>
    </div>
  `;
}

function showNetworkDetail(c: NetworkRequestEvent): void {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const failed = isFailedNetwork(c);

  const bugReportText = toBugReport(c);
  const curlText = toCurl(c);
  const respText = c.data.response.body ?? '';
  const isOversize = bugReportText.length > SLACK_SAFE_THRESHOLD;

  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="detail-top">
      <div class="detail-back">
        <button id="back" class="secondary">← Back</button>
        <span class="time">${new Date(c.data.timing.startedAt).toLocaleTimeString()}</span>
      </div>
      <div class="detail-heading ${failed ? 'failed' : 'success'}">
        <span class="pill">${c.data.response.status || 'ERR'}</span>
        <strong>${escapeHtml(c.data.request.method)}</strong>
        ${c.data.response.statusText ? `<span style="color:var(--muted)">${escapeHtml(c.data.response.statusText)}</span>` : ''}
      </div>
      <div class="detail-url">${escapeHtml(c.data.request.url)}</div>
    </div>

    <div class="copy-row">
      <button data-copy="report" class="${isOversize ? 'warning' : ''}">
        Copy bug report · ${fmtSize(bugReportText.length)}${isOversize ? ' ⚠' : ''}
      </button>
      <button data-action="download" class="${isOversize ? '' : 'secondary'}">⤓ Download JSON</button>
      <button data-copy="curl" class="secondary">cURL · ${fmtSize(curlText.length)}</button>
      <button data-copy="response" class="secondary">Response · ${fmtSize(respText.length)}</button>
      <button data-action="replay" class="secondary" title="Re-fire this request from the extension context (PRD §6.3.5)">↻ Replay</button>
    </div>
    <div id="replay-result" class="replay-result hidden" aria-live="polite"></div>

    ${
      isOversize
        ? `
    <div class="size-warning">
      Bug report is <strong>${bugReportText.length.toLocaleString()} chars</strong> — over Slack's paste limit (${SLACK_SAFE_THRESHOLD.toLocaleString()}).
      Clicking <strong>Copy bug report</strong> will put the image on your clipboard and auto-download the JSON file. Paste the image into Slack, then drag the JSON file in as a snippet.
    </div>`
        : ''
    }

    ${renderScreenshotPanel(findPairedScreenshot(c.id))}
    ${renderRedactionsPanel(c.meta?.redactions)}

    <div class="section">
      <h3>Request headers</h3>
      <pre>${escapeHtml(JSON.stringify(maskHeaders(c.data.request.headers), null, 2))}</pre>
    </div>

    ${
      c.data.request.body
        ? `
    <div class="section">
      <h3>Request body</h3>
      <pre>${escapeHtml(formatJson(c.data.request.body))}</pre>
    </div>`
        : ''
    }

    <div class="section">
      <h3>Response headers</h3>
      <pre>${escapeHtml(JSON.stringify(c.data.response.headers, null, 2))}</pre>
    </div>

    <div class="section" style="padding-bottom: 16px;">
      <h3>Response body</h3>
      <pre>${escapeHtml(formatJson(c.data.response.body ?? ''))}</pre>
    </div>
  `;

  document.getElementById('back')?.addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    const data = filteredEvents(events, filterMode);
    if (data.length > 0) document.getElementById('bulk-bar')?.classList.remove('hidden');
  });

  document.getElementById('bulk-bar')?.classList.add('hidden');

  detail.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const format = btn.dataset.copy as 'report' | 'curl' | 'response';
      const text = formatForCopy(c, format);
      const original = btn.textContent ?? '';
      try {
        if (format === 'report') {
          btn.textContent = '… rendering';
          const r = await writeTextAndImage(text, [c], { maxText: SLACK_SAFE_THRESHOLD });
          if (r.textSkipped && r.hasImage) {
            downloadAsFile(c);
            btn.textContent = '✓ Image · JSON ⤓';
          } else if (r.hasImage && r.hasText) {
            btn.textContent = '✓ Copied + image';
          } else if (r.hasText) {
            btn.textContent = '✓ Copied (text only)';
          } else if (r.hasImage) {
            btn.textContent = '✓ Image copied';
          } else {
            btn.textContent = 'Copy failed';
          }
        } else {
          await navigator.clipboard.writeText(text);
          btn.textContent = '✓ Copied';
        }
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1800);
      } catch {
        btn.textContent = 'Copy failed';
      }
    });
  });

  detail.querySelectorAll<HTMLButtonElement>('[data-action="download"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      downloadAsFile(c);
      const original = btn.textContent ?? '';
      btn.textContent = '✓ Downloaded';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1600);
    });
  });

  detail.querySelectorAll<HTMLButtonElement>('[data-action="replay"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void replayRequest(c, btn);
    });
  });
}

/** Methods that mutate server state — gated behind an explicit confirm()
 *  before firing. PRD §6.3.5; OQ-M4-K resolution: destructive only. */
const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function replayRequest(c: NetworkRequestEvent, btn: HTMLButtonElement): Promise<void> {
  const method = c.data.request.method.toUpperCase();
  if (DESTRUCTIVE_METHODS.has(method)) {
    const ok = confirm(
      `Replay ${method} ${c.data.request.url}?\n\nThis re-fires a state-changing request. Make sure you understand what it will do on the target server.`
    );
    if (!ok) return;
  }
  const result = document.getElementById('replay-result');
  if (!result) return;
  result.classList.remove('hidden');
  result.innerHTML = '<div class="replay-status">… replaying</div>';
  const original = btn.textContent ?? '↻ Replay';
  btn.disabled = true;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.data.request.headers)) {
    // Skip masked headers — sending the literal `***MASKED***` string is
    // worse than letting the browser/extension context attach its own
    // value where applicable.
    if (v === '***MASKED***') continue;
    headers[k] = v;
  }

  const start = performance.now();
  try {
    const resp = await fetch(c.data.request.url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (c.data.request.body ?? undefined),
      credentials: 'omit',
    });
    const durationMs = Math.round(performance.now() - start);
    const text = await resp.text().catch(() => '');
    const sameStatus = resp.status === c.data.response.status;
    const className = sameStatus ? 'replay-ok' : 'replay-diff';
    result.innerHTML = `
      <div class="replay-status ${className}">
        <strong>${resp.status} ${escapeHtml(resp.statusText)}</strong>
        · ${durationMs}ms
        ${sameStatus ? '' : `<span class="hint">(original was ${c.data.response.status})</span>`}
      </div>
      ${
        text
          ? `<details class="replay-body" open>
              <summary>Response body · ${fmtSize(text.length)}</summary>
              <pre>${escapeHtml(text.slice(0, 8000))}${text.length > 8000 ? '\n…(truncated)' : ''}</pre>
            </details>`
          : ''
      }
      <p class="hint">Replayed from the extension context — cookies/credentials may differ from the original session.</p>
    `;
  } catch (err) {
    result.innerHTML = `
      <div class="replay-status replay-fail">
        <strong>Network error</strong> — ${escapeHtml((err as Error).message ?? String(err))}
      </div>
      <p class="hint">CORS or host-permission restriction is the usual cause. The captured request is unchanged in storage.</p>
    `;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------- formatters ----------

function formatForCopy(c: NetworkRequestEvent, format: 'report' | 'curl' | 'response'): string {
  if (format === 'curl') return toCurl(c);
  if (format === 'response') return c.data.response.body ?? '';
  return toBugReport(c);
}

function toCurl(c: NetworkRequestEvent): string {
  const lines = [`curl -X ${c.data.request.method} '${c.data.request.url}'`];
  for (const [k, v] of Object.entries(maskHeaders(c.data.request.headers))) {
    lines.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (c.data.request.body) {
    const body = String(c.data.request.body).replace(/'/g, "'\\''");
    lines.push(`  --data '${body}'`);
  }
  return lines.join(' \\\n');
}

function toBugReport(c: NetworkRequestEvent): string {
  const errorSignals = extractErrorSignal(c.data.response.body);

  return `## API Error — ${c.data.request.method} ${c.data.request.url.split('?')[0]}

**Page:** ${c.url}
**Endpoint:** \`${c.data.request.method} ${c.data.request.url}\`
**Status:** ${c.data.response.status || 'ERR'} ${c.data.response.statusText}
**Duration:** ${c.data.timing.durationMs}ms
**Captured at:** ${new Date(c.data.timing.startedAt).toISOString()}
${c.data.error ? `**Network error:** ${c.data.error}\n` : ''}${
    errorSignals
      ? `
### Server error signals (summary — full body is below)
${errorSignals.map((e) => `- ${e}`).join('\n')}
`
      : ''
  }
### Request headers
\`\`\`json
${JSON.stringify(maskHeaders(c.data.request.headers), null, 2)}
\`\`\`
${
  c.data.request.body
    ? `
### Request body
\`\`\`json
${formatJson(c.data.request.body)}
\`\`\``
    : ''
}

### Response headers
\`\`\`json
${JSON.stringify(c.data.response.headers, null, 2)}
\`\`\`

### Response body
\`\`\`json
${formatJson(c.data.response.body ?? '')}
\`\`\`

### cURL
\`\`\`bash
${toCurl(c)}
\`\`\`
`;
}

function extractErrorSignal(jsonStr: string | null): string[] | null {
  if (!jsonStr) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const out: string[] = [];

  if (o.errors && typeof o.errors === 'object' && !Array.isArray(o.errors)) {
    for (const [field, msgs] of Object.entries(o.errors as Record<string, unknown>)) {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      list.forEach((m: unknown) =>
        out.push(`${field}: ${typeof m === 'string' ? m : JSON.stringify(m)}`)
      );
    }
  }
  if (Array.isArray(o.errors)) {
    (o.errors as unknown[]).forEach((e) => {
      if (typeof e === 'string') out.push(e);
      else if (
        e &&
        typeof e === 'object' &&
        'field' in e &&
        'message' in e &&
        typeof (e as { field: unknown }).field === 'string'
      ) {
        out.push(`${(e as { field: string }).field}: ${(e as { message: string }).message}`);
      } else if (e && typeof e === 'object' && 'message' in e) {
        out.push((e as { message: string }).message);
      } else {
        out.push(JSON.stringify(e));
      }
    });
  }
  if (o.ModelState && typeof o.ModelState === 'object') {
    for (const [field, msgs] of Object.entries(o.ModelState as Record<string, unknown>)) {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      list.forEach((m: unknown) => out.push(`${field}: ${m as string}`));
    }
  }
  if (typeof o.message === 'string') out.push(`message: ${o.message}`);
  if (typeof o.error === 'string') out.push(`error: ${o.error}`);
  if (o.error && typeof o.error === 'object' && 'message' in o.error) {
    out.push(`error: ${(o.error as { message: string }).message}`);
  }
  if (typeof o.detail === 'string') out.push(`detail: ${o.detail}`);
  if (typeof o.title === 'string' && o.title !== o.message) out.push(`title: ${o.title}`);
  if (typeof o.traceId === 'string') out.push(`traceId: ${o.traceId}`);

  return out.length ? out : null;
}

function downloadAsFile(c: NetworkRequestEvent): void {
  const payload = maskedEventForExport(c);
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date(c.data.timing.startedAt).toISOString().replace(/[:.]/g, '-');
  const path = (() => {
    try {
      return new URL(c.data.request.url).pathname.replace(/\//g, '_');
    } catch {
      return 'request';
    }
  })();
  const filename = `bug-${c.data.response.status || 'ERR'}-${c.data.request.method}${path}-${ts}.json`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/** Returns a copy of the event with sensitive request headers masked.
 *  Stored data is unchanged — this is an export-side projection only.
 *  Capture-time masking (PRD §11.2) lands with the regex engine. */
/**
 * Renders the optional Privacy panel above the request/response detail.
 * Surfaces what the capture-time masker (PRD §11.2) did to the data
 * before it was stored — fulfills the PRD §11.4 "Pre-share preview"
 * transparency commitment at the per-event level.
 */
/** Returns the most recent 'screenshot' event whose meta.cascadeOf
 *  matches `triggerId`, or null. The SW emits one screenshot per
 *  triggering error within the 2-second rate-limit window, so at most
 *  one paired screenshot exists per triggering event. */
function findPairedScreenshot(triggerId: string): CapturedEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === 'screenshot' && e.meta?.cascadeOf === triggerId) return e;
  }
  return null;
}

function renderScreenshotPanel(shot: CapturedEvent | null): string {
  if (!shot || shot.type !== 'screenshot') return '';
  const dataUrl = shot.data.dataUrl;
  if (!dataUrl) return '';
  return `
    <div class="section">
      <h3>Screenshot at error moment</h3>
      <a class="screenshot-link" data-screenshot-url="${escapeHtml(dataUrl)}" title="Click to open full size in a new tab">
        <img class="screenshot" src="${escapeHtml(dataUrl)}" alt="Page screenshot captured when this error fired" />
      </a>
      <p class="hint">Captured by chrome.tabs.captureVisibleTab — JPEG quality 0.7. Click to enlarge.</p>
    </div>
  `;
}

function renderRedactionsPanel(redactions: Redaction[] | undefined): string {
  if (!redactions || redactions.length === 0) return '';

  type Group = { ruleId: string; label: string; count: number; scopes: Set<string> };
  const groups = new Map<string, Group>();
  for (const r of redactions) {
    const existing = groups.get(r.rule);
    if (existing) {
      existing.count++;
      existing.scopes.add(r.scope);
    } else {
      groups.set(r.rule, {
        ruleId: r.rule,
        label: lookupRuleLabel(r.rule),
        count: 1,
        scopes: new Set([r.scope]),
      });
    }
  }

  const groupArr = Array.from(groups.values());
  const summary = groupArr.map((g) => `${g.count} × ${g.label}`).join(' · ');
  const total = redactions.length;
  const noun = `field${total === 1 ? '' : 's'}`;

  const rows = groupArr
    .map(
      (g) =>
        `<li><strong>${escapeHtml(g.label)}</strong> <span class="muted">(${escapeHtml(
          [...g.scopes].join(', ')
        )})</span> — ${g.count}×</li>`
    )
    .join('');

  return `
    <details class="redactions">
      <summary>
        <span class="redactions-icon" aria-hidden="true">🛡️</span>
        <strong>${total} ${noun} masked at capture time</strong>
        <span class="muted"> — ${escapeHtml(summary)}</span>
      </summary>
      <ul class="redactions-list">${rows}</ul>
      <p class="hint">
        Capture-time masking is irreversible — the original values were never written to storage
        (PRD §11.2).
      </p>
    </details>
  `;
}

const RULE_LABELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const r of [...DEFAULT_HEADER_RULES, ...DEFAULT_BODY_RULES, ...DEFAULT_FORM_RULES]) {
    map[r.id] = r.label;
  }
  return map;
})();

function lookupRuleLabel(ruleId: string): string {
  if (RULE_LABELS[ruleId]) return RULE_LABELS[ruleId];
  if (ruleId.startsWith('user.')) return 'Custom pattern';
  return ruleId;
}

function maskedEventForExport(c: NetworkRequestEvent): NetworkRequestEvent {
  return {
    ...c,
    data: {
      ...c.data,
      request: { ...c.data.request, headers: maskHeaders(c.data.request.headers) },
    },
  } as NetworkRequestEvent;
}

function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '***MASKED***' : v;
  }
  return out;
}

function formatJson(str: string): string {
  if (!str) return '';
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return String(str);
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Privacy preview modal — PRD §6.4.4 + M5 a11y pass.
//
// Replaces the M4·W12 confirm() with an in-panel overlay that surfaces
// exactly what's about to leave the user's machine: event count,
// per-rule redaction summary, and the destination identity.
//
// Full ARIA dialog contract (M5 OQ-M4-L closeout):
//   - role="dialog" + aria-modal="true"
//   - aria-labelledby (title) + aria-describedby (summary block)
//   - Focus trap cycling Cancel / Continue on Tab / Shift+Tab
//   - Esc cancels; Enter commits (when focus is not on a button)
//   - #app is `inert` while the dialog is open so screen readers and
//     keyboard navigation cannot reach the background side-panel UI
//   - Focus is restored to the element that opened the dialog on close
// ---------------------------------------------------------------------------

interface PrivacyPreviewOptions {
  destinationLabel: string;
  destinationDetail: string;
  events: CapturedEvent[];
}

function showPrivacyPreview(opts: PrivacyPreviewOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById('app');
    const overlay = document.createElement('div');
    overlay.className = 'privacy-modal-overlay';

    const redactionGroups = summarizeRedactions(opts.events);
    const failedCount = opts.events.filter(isErrorEvent).length;
    const detailShort = opts.destinationDetail
      ? opts.destinationDetail.length > 64
        ? opts.destinationDetail.slice(0, 64) + '…'
        : opts.destinationDetail
      : '';

    overlay.innerHTML = `
      <div
        class="privacy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-modal-title"
        aria-describedby="privacy-modal-body"
      >
        <h2 id="privacy-modal-title">Send to ${escapeHtml(opts.destinationLabel)}?</h2>
        <div id="privacy-modal-body">
          <ul class="privacy-modal-summary">
            <li><strong>${opts.events.length}</strong> event${opts.events.length === 1 ? '' : 's'}${failedCount > 0 ? ` · <span class="muted">${failedCount} error${failedCount === 1 ? '' : 's'}</span>` : ''}</li>
            ${detailShort ? `<li class="muted"><code>${escapeHtml(detailShort)}</code></li>` : ''}
          </ul>
          ${
            redactionGroups.total > 0
              ? `<div class="privacy-modal-redactions">
                  <strong>${redactionGroups.total} field${redactionGroups.total === 1 ? '' : 's'} masked at capture time</strong>
                  <ul>${redactionGroups.rows
                    .map(
                      (g) =>
                        `<li><strong>${escapeHtml(g.label)}</strong> <span class="muted">— ${g.count}×</span></li>`
                    )
                    .join('')}</ul>
                  <p class="muted">Masked values were never written to storage (PRD §11.2) — they leave masked.</p>
                </div>`
              : `<p class="privacy-modal-noredactions muted">No fields matched a masking rule in this session.</p>`
          }
        </div>
        <div class="privacy-modal-actions">
          <button data-action="cancel" class="secondary">Cancel</button>
          <button data-action="continue" class="primary">Continue</button>
        </div>
      </div>
    `;

    // Background goes inert: keyboard focus + a11y tree skip #app while
    // the dialog is up. Restored on cleanup.
    appRoot?.setAttribute('inert', '');
    document.body.appendChild(overlay);

    const cleanup = (result: boolean): void => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      appRoot?.removeAttribute('inert');
      previouslyFocused?.focus?.();
      resolve(result);
    };
    // Focus trap: cycle Tab / Shift+Tab between Cancel and Continue so
    // keyboard users can't escape into the surrounding side-panel UI.
    const focusables = (): HTMLButtonElement[] =>
      Array.from(overlay.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
        return;
      }
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        cleanup(true);
        return;
      }
      if (e.key === 'Tab') {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0]!;
        const last = list[list.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    overlay
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.addEventListener('click', () => cleanup(false));
    overlay
      .querySelector<HTMLButtonElement>('[data-action="continue"]')
      ?.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // Focus the Continue button so Enter immediately commits. Synchronous
    // — the overlay is already in the DOM after appendChild, so no
    // timer is needed (the old 10 ms setTimeout was a leftover guess).
    overlay.querySelector<HTMLButtonElement>('[data-action="continue"]')?.focus();
  });
}

function summarizeRedactions(items: CapturedEvent[]): {
  total: number;
  rows: { label: string; count: number }[];
} {
  const counts = new Map<string, number>();
  let total = 0;
  for (const e of items) {
    for (const r of e.meta?.redactions ?? []) {
      total++;
      counts.set(r.rule, (counts.get(r.rule) ?? 0) + 1);
    }
  }
  const rows = Array.from(counts.entries())
    .map(([rule, count]) => ({ label: lookupRuleLabel(rule), count }))
    .sort((a, b) => b.count - a.count);
  return { total, rows };
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c
  );
}
