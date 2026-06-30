// Popup — minimal toolbar launcher.
//
// PRD §6.3.1 designates the side panel as the primary surface; the
// popup is the quick-access entry point. M4·W15-extra (v0.4.1)
// upgrades it from "single latest failure" to a clickable list of
// the last 3 failures, adds a one-click replay-bundle download,
// surfaces configured webhook destinations as quick-share chips,
// and lets the user jump directly to a specific event in the side
// panel via the chrome.storage focus-event channel.

import { applyI18nToDom, initI18n, subscribeLocale, t } from '@/lib/i18n';
import type { CapturedEvent } from '@/types/events';
import { isFailedNetwork } from '@/types/events';
import { dispatchToWebhook, type WebhookDestination } from '@/lib/destinations/webhooks';
import { openCapturePanel } from '@/lib/panel';
import { generateBundle } from '@/lib/replay-bundle';
import type {
  ClearEventsRuntimeMessage,
  EventsUnchanged,
  GetEventsRuntimeMessage,
  GetRecordingRuntimeMessage,
  RecordingState,
  ToggleRecordingRuntimeMessage,
} from '@/lib/runtime-messages';
import { readSharingSettings } from '@/lib/settings';
import { applyTheme, listenForThemeChanges } from '@/lib/theme';

declare const __APP_VERSION__: string;

// Storage key the side panel reads on init to scroll/focus a specific
// event picked from the popup. Cleared by the side panel right after.
const FOCUS_EVENT_KEY = 'sidepanel/focus-event';
// When set, side panel boots into the "failed" filter regardless of
// its last in-memory state.
const FOCUS_FILTER_KEY = 'sidepanel/focus-filter';

const MAX_POPUP_FAILURES = 3;

let activeTabId: number | undefined;
let latestEvents: CapturedEvent[] = [];
/** Highest sequenceNumber fetched, sent on the next poll so the SW can
 *  skip re-cloning an unchanged buffer. -1 forces a full fetch. */
let lastKnownSequence = -1;

void init();

async function init(): Promise<void> {
  await initI18n();
  applyI18nToDom();
  await applyTheme();
  listenForThemeChanges();
  subscribeLocale(() => {
    applyI18nToDom();
    renderSummary(latestEvents);
    void renderQuickShare();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;

  document.getElementById('open-panel')?.addEventListener('click', () => {
    if (activeTabId == null) return;
    void openSidePanel({ focusFailed: true });
  });

  document.getElementById('summary-counts')?.addEventListener('click', () => {
    if (activeTabId == null) return;
    void openSidePanel({ focusFailed: true });
  });

  document.getElementById('open-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('download-bundle')?.addEventListener('click', () => {
    downloadReplayBundle(latestEvents);
  });

  document.getElementById('recording-stop')?.addEventListener('click', () => {
    if (activeTabId == null) return;
    void stopRecording(activeTabId);
  });

  const reload = (bypassCache: boolean): void => {
    if (activeTabId == null) return;
    void chrome.tabs.reload(activeTabId, { bypassCache });
    // Close the popup after the reload kick so the user sees the
    // fresh page — same affordance as Cmd+R from the toolbar.
    window.close();
  };
  document.getElementById('reload-page')?.addEventListener('click', () => reload(false));
  document.getElementById('reload-hard')?.addEventListener('click', () => reload(true));

  document.getElementById('clear-events')?.addEventListener('click', () => {
    if (activeTabId == null) return;
    const ok = confirm(
      latestEvents.length === 1
        ? t('popup.confirmClearOne')
        : t('popup.confirmClear', { n: latestEvents.length })
    );
    if (!ok) return;
    const msg: ClearEventsRuntimeMessage = { kind: 'CLEAR_EVENTS', tabId: activeTabId };
    void chrome.runtime.sendMessage(msg).then(() => {
      latestEvents = [];
      lastKnownSequence = -1;
      renderSummary([]);
    });
  });

  if (activeTabId == null) return;
  await refresh(activeTabId);
  await refreshRecording(activeTabId);
  await renderQuickShare();
  // Slow poll — the popup is short-lived and the side panel is the
  // surface that actually needs reactive updates.
  const pollTimer = setInterval(() => {
    void refresh(activeTabId!);
    void refreshRecording(activeTabId!);
    updateRecordingTimer();
  }, 1000);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

// ---------------------------------------------------------------------------
// Event summary
// ---------------------------------------------------------------------------

async function refresh(tabId: number): Promise<void> {
  let events: CapturedEvent[];
  try {
    const message: GetEventsRuntimeMessage = {
      kind: 'GET_EVENTS',
      tabId,
      knownLastSequence: lastKnownSequence,
    };
    const result = await chrome.runtime.sendMessage(message);
    // Buffer unchanged since the last poll — skip the clone and re-render.
    if (result && (result as EventsUnchanged).unchanged === true) return;
    events = Array.isArray(result) ? (result as CapturedEvent[]) : [];
  } catch {
    return;
  }
  lastKnownSequence = events.length > 0 ? (events[events.length - 1]!.sequenceNumber ?? -1) : -1;
  latestEvents = events;
  renderSummary(events);
}

function renderSummary(events: CapturedEvent[]): void {
  const totalEl = document.querySelector('.count-total strong');
  if (totalEl) totalEl.textContent = String(events.length);

  // Popup quick-list focuses on failed network requests only — console /
  // unhandled-error noise (white-screen heuristics etc.) lives in the side
  // panel, not this at-a-glance view.
  const errors = events.filter(isFailedNetwork);
  const errorsEl = document.querySelector<HTMLElement>('.count-errors');
  if (errorsEl) {
    if (errors.length === 0) {
      errorsEl.classList.add('hidden');
      errorsEl.textContent = '';
    } else {
      errorsEl.classList.remove('hidden');
      errorsEl.textContent =
        errors.length === 1
          ? t('popup.summary.errorsSuffixOne')
          : t('popup.summary.errorsSuffix', { n: errors.length });
    }
  }

  const listEl = document.getElementById('failure-list');
  const bundleBtn = document.getElementById('download-bundle');
  if (!listEl) return;

  if (errors.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
  } else {
    // Show the N most recent failures; newest first.
    const recent = errors.slice(-MAX_POPUP_FAILURES).reverse();
    listEl.classList.remove('hidden');
    listEl.innerHTML = recent
      .map((e) => {
        const summary = describeError(e);
        const time = new Date(e.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `
          <button class="failure-row" type="button" data-event-id="${escapeAttr(e.id)}" role="listitem">
            <span class="failure-status">${escapeHtml(summary.status)}</span>
            <span class="failure-line">${escapeHtml(summary.line)}</span>
            <span class="failure-time">${escapeHtml(time)}</span>
          </button>
        `;
      })
      .join('');

    listEl.querySelectorAll<HTMLButtonElement>('.failure-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.eventId;
        if (!id) return;
        void openSidePanel({ focusEventId: id, focusFailed: true });
      });
    });
  }

  // Bundle button stays enabled whenever there's anything to bundle.
  if (bundleBtn instanceof HTMLButtonElement) {
    bundleBtn.disabled = events.length === 0;
  }
}

function describeError(e: CapturedEvent): { status: string; line: string } {
  if (isFailedNetwork(e)) {
    const path = (() => {
      try {
        return new URL(e.data.request.url).pathname;
      } catch {
        return e.data.request.url;
      }
    })();
    return {
      status: String(e.data.response.status || 'ERR'),
      line: `${e.data.request.method} ${path}`,
    };
  }
  if (e.type === 'console.error' || e.type === 'console.unhandled') {
    return {
      status: e.type === 'console.unhandled' ? 'UNC' : 'ERR',
      line: e.data.message.length > 60 ? e.data.message.slice(0, 60) + '…' : e.data.message,
    };
  }
  return { status: e.type.split('.')[0]?.toUpperCase().slice(0, 3) ?? 'EVT', line: e.type };
}

// ---------------------------------------------------------------------------
// Side panel jump — focus a specific event via chrome.storage handshake
// ---------------------------------------------------------------------------

async function openSidePanel(opts: {
  focusEventId?: string;
  focusFailed?: boolean;
}): Promise<void> {
  if (activeTabId == null) return;
  // Open FIRST, before any await — Firefox's sidebarAction.open() (and
  // Chrome's sidePanel.open()) must fire synchronously inside the click's
  // user gesture; an awaited storage write beforehand consumes the gesture
  // and the open is rejected. The focus keys are written after; the side
  // panel reacts to them via storage.onChanged.
  const opening = openCapturePanel(activeTabId).catch(() => {
    /* may fail if user gesture expired */
  });
  const writes: Record<string, unknown> = {};
  if (opts.focusEventId) writes[FOCUS_EVENT_KEY] = opts.focusEventId;
  if (opts.focusFailed) writes[FOCUS_FILTER_KEY] = 'failed';
  if (Object.keys(writes).length > 0) {
    try {
      await chrome.storage.local.set(writes);
    } catch {
      /* swallow */
    }
  }
  await opening;
  window.close();
}

// ---------------------------------------------------------------------------
// Replay bundle download
// ---------------------------------------------------------------------------

function downloadReplayBundle(events: CapturedEvent[]): void {
  if (events.length === 0) return;
  const html = generateBundle(events, { appVersion: __APP_VERSION__ });
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const host = (() => {
    for (const e of events) {
      try {
        const h = new URL(e.url).host;
        if (h) return h;
      } catch {
        /* keep looking */
      }
    }
    return 'session';
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

  // Flash the button so the user knows something happened.
  const btn = document.getElementById('download-bundle');
  if (btn instanceof HTMLButtonElement) {
    const original = btn.textContent ?? '';
    btn.textContent = t('popup.actions.bundleDownloaded');
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1600);
  }
}

// ---------------------------------------------------------------------------
// Quick-share chips (Slack / Discord / Teams) — only render when the
// user has wired a webhook URL in Settings → Sharing.
// ---------------------------------------------------------------------------

async function renderQuickShare(): Promise<void> {
  const wrap = document.getElementById('quick-share');
  const list = document.getElementById('quick-share-buttons');
  if (!wrap || !list) return;
  let sharing;
  try {
    sharing = await readSharingSettings();
  } catch {
    return;
  }
  const destinations: { dest: WebhookDestination; url: string; label: string }[] = [];
  if (sharing.slackWebhook)
    destinations.push({ dest: 'slack', url: sharing.slackWebhook, label: 'Slack' });
  if (sharing.discordWebhook)
    destinations.push({ dest: 'discord', url: sharing.discordWebhook, label: 'Discord' });
  if (sharing.teamsWebhook)
    destinations.push({ dest: 'teams', url: sharing.teamsWebhook, label: 'Teams' });

  if (destinations.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  list.innerHTML = destinations
    .map(
      (d) =>
        `<button class="quick-share-btn" type="button" data-dest="${d.dest}">${escapeHtml(t('popup.share.button', { label: d.label }))}</button>`
    )
    .join('');

  list.querySelectorAll<HTMLButtonElement>('.quick-share-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dest = btn.dataset.dest as WebhookDestination | undefined;
      if (!dest) return;
      const entry = destinations.find((d) => d.dest === dest);
      if (!entry) return;
      if (latestEvents.length === 0) return;
      const totalRedactions = latestEvents.reduce(
        (n, e) => n + (e.meta?.redactions?.length ?? 0),
        0
      );
      const baseConfirm =
        latestEvents.length === 1
          ? t('popup.share.confirmOne', { destination: entry.label })
          : t('popup.share.confirm', { n: latestEvents.length, destination: entry.label });
      const maskNote =
        totalRedactions === 0
          ? ''
          : totalRedactions === 1
            ? t('popup.share.confirmMaskedOne')
            : t('popup.share.confirmMasked', { n: totalRedactions });
      const confirmed = confirm(baseConfirm + maskNote);
      if (!confirmed) return;
      const original = btn.textContent ?? '';
      btn.disabled = true;
      btn.textContent = t('popup.share.sending');
      const result = await dispatchToWebhook(dest, entry.url, latestEvents);
      btn.textContent = result.ok
        ? result.truncated
          ? t('popup.share.sentTruncated')
          : t('popup.share.sent')
        : result.error
          ? t('popup.share.failed', { error: result.error })
          : t('popup.share.failedFallback');
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = original;
      }, 2400);
    });
  });
}

// ---------------------------------------------------------------------------
// Recording state
// ---------------------------------------------------------------------------

let recordingState: RecordingState = { recording: false };

async function refreshRecording(tabId: number): Promise<void> {
  try {
    const msg: GetRecordingRuntimeMessage = { kind: 'GET_RECORDING', tabId };
    const result = await chrome.runtime.sendMessage(msg);
    recordingState = (result as RecordingState | undefined) ?? { recording: false };
  } catch {
    return;
  }
  const banner = document.getElementById('recording-banner');
  if (!banner) return;
  if (recordingState.recording) {
    banner.classList.remove('hidden');
    updateRecordingTimer();
  } else {
    banner.classList.add('hidden');
  }
}

function updateRecordingTimer(): void {
  if (!recordingState.recording || !recordingState.startedAt) return;
  const out = document.getElementById('recording-time');
  if (!out) return;
  const elapsed = Math.floor((Date.now() - recordingState.startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  out.textContent = `${mm}:${ss}`;
}

async function stopRecording(tabId: number): Promise<void> {
  try {
    const msg: ToggleRecordingRuntimeMessage = { kind: 'TOGGLE_RECORDING', tabId };
    await chrome.runtime.sendMessage(msg);
  } catch {
    /* swallow */
  }
  await refreshRecording(tabId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}
