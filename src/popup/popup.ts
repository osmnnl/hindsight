// Popup — minimal toolbar launcher.
//
// PRD §6.3.1 designates the side panel as the primary surface; the
// popup is the quick-access entry point. Shows a one-glance summary
// of the active tab's capture state, surfaces the latest failure for
// instant "see what just broke" context, and routes the user to
// either the side panel (sustained inspection) or the JSON download
// (quick report).

import { applyTheme, listenForThemeChanges } from '@/lib/theme';
import type { CapturedEvent } from '@/types/events';
import { isErrorEvent, isFailedNetwork } from '@/types/events';
import type { GetEventsRuntimeMessage } from '@/lib/runtime-messages';

void init();

async function init(): Promise<void> {
  await applyTheme();
  listenForThemeChanges();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;

  document.getElementById('open-panel')?.addEventListener('click', () => {
    if (tabId != null) {
      void chrome.sidePanel
        .open({ tabId })
        .then(() => window.close())
        .catch(() => {});
    }
  });

  document.getElementById('open-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const quickReportBtn = document.getElementById('quick-report');
  if (quickReportBtn instanceof HTMLButtonElement) {
    quickReportBtn.addEventListener('click', () => {
      if (tabId != null) {
        downloadLatestErrorReport(tabId);
      }
    });
  }

  if (tabId == null) return;
  await refresh(tabId);
  // Slow poll — the popup is short-lived and the side panel is the
  // surface that actually needs reactive updates.
  const pollTimer = setInterval(() => void refresh(tabId), 1500);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

async function refresh(tabId: number): Promise<void> {
  let events: CapturedEvent[];
  try {
    const message: GetEventsRuntimeMessage = { kind: 'GET_EVENTS', tabId };
    const result = await chrome.runtime.sendMessage(message);
    events = Array.isArray(result) ? (result as CapturedEvent[]) : [];
  } catch {
    return;
  }
  renderSummary(events);
}

function renderSummary(events: CapturedEvent[]): void {
  const totalEl = document.querySelector('.count-total strong');
  if (totalEl) totalEl.textContent = String(events.length);

  const errors = events.filter(isErrorEvent);
  const errorsEl = document.querySelector<HTMLElement>('.count-errors');
  if (errorsEl) {
    if (errors.length === 0) {
      errorsEl.classList.add('hidden');
      errorsEl.textContent = '';
    } else {
      errorsEl.classList.remove('hidden');
      errorsEl.textContent = `· ${errors.length} error${errors.length === 1 ? '' : 's'}`;
    }
  }

  const latest = errors[errors.length - 1];
  const latestEl = document.getElementById('latest-error');
  const quickReportBtn = document.getElementById('quick-report');
  if (!latestEl) return;
  if (!latest) {
    latestEl.classList.add('hidden');
    latestEl.innerHTML = '';
    if (quickReportBtn instanceof HTMLButtonElement) quickReportBtn.disabled = true;
    return;
  }

  latestEl.classList.remove('hidden');
  latestEl.innerHTML = `
    <div class="latest-error-label">Latest failure</div>
    <div class="latest-error-line">${escapeHtml(describeError(latest))}</div>
    <div class="latest-error-time">${new Date(latest.timestamp).toLocaleTimeString()}</div>
  `;
  if (quickReportBtn instanceof HTMLButtonElement) quickReportBtn.disabled = false;
}

function describeError(e: CapturedEvent): string {
  if (isFailedNetwork(e)) {
    const path = (() => {
      try {
        return new URL(e.data.request.url).pathname;
      } catch {
        return e.data.request.url;
      }
    })();
    return `${e.data.response.status || 'ERR'} ${e.data.request.method} ${path}`;
  }
  if (e.type === 'console.error' || e.type === 'console.unhandled') {
    const msg = e.data.message;
    return msg.length > 80 ? msg.slice(0, 80) + '…' : msg;
  }
  return e.type;
}

async function downloadLatestErrorReport(tabId: number): Promise<void> {
  try {
    const message: GetEventsRuntimeMessage = { kind: 'GET_EVENTS', tabId };
    const result = await chrome.runtime.sendMessage(message);
    const events = Array.isArray(result) ? (result as CapturedEvent[]) : [];
    const json = JSON.stringify({ events }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `hindsight-quick-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  } catch {
    /* swallow — popup is a best-effort launcher */
  }
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}
