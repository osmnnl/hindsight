// Popup UI for the toolbar action.
//
// Reads CapturedEvent[] (PRD §6.1.2) from the service worker, renders
// network failures with status / method / URL / time / duration, and
// offers per-event + bulk copy / download / share actions. UI copy is
// generic — do not introduce vendor-specific strings (CLAUDE.md §5.1).

import type { CapturedEvent, NetworkFetchEvent, NetworkXhrEvent, Redaction } from '@/types/events';
import { isFailedNetwork } from '@/types/events';
import {
  type ClearEventsRuntimeMessage,
  type GetEventsRuntimeMessage,
} from '@/lib/runtime-messages';
import { toHar } from '@/lib/har';
import { DEFAULT_BODY_RULES, DEFAULT_FORM_RULES, DEFAULT_HEADER_RULES } from '@/lib/masking';

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

type FilterMode = 'failed' | 'all';

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
let events: NetworkRequestEvent[] = [];
let filterMode: FilterMode = 'failed';
let pollTimer: ReturnType<typeof setInterval> | null = null;

void init();

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  document.querySelectorAll<HTMLElement>('.filter').forEach((btn) => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter as FilterMode));
  });
  document.getElementById('clear')?.addEventListener('click', () => void clearAll());

  await refresh();
  pollTimer = setInterval(() => void refresh(), 1500);
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
}

async function refresh(): Promise<void> {
  if (tabId == null) return;
  try {
    const message: GetEventsRuntimeMessage = { kind: 'GET_EVENTS', tabId };
    const result = await chrome.runtime.sendMessage(message);
    const all = Array.isArray(result) ? (result as CapturedEvent[]) : [];
    events = all.filter(isRequestLike);
    render();
  } catch {
    /* service worker briefly inactive */
  }
}

function setFilter(mode: FilterMode): void {
  filterMode = mode;
  document.querySelectorAll<HTMLElement>('.filter').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === mode);
  });
  render();
}

async function clearAll(): Promise<void> {
  if (tabId == null) return;
  const message: ClearEventsRuntimeMessage = { kind: 'CLEAR_EVENTS', tabId };
  await chrome.runtime.sendMessage(message);
  await refresh();
}

function render(): void {
  const list = document.getElementById('list');
  const bulkBar = document.getElementById('bulk-bar');
  if (!list || !bulkBar) return;
  const data = filterMode === 'failed' ? events.filter(isFailedNetwork) : events;

  if (data.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-title">${filterMode === 'failed' ? 'No failed requests' : 'No requests yet'}</div>
        <div class="empty-sub">${filterMode === 'failed' ? 'Switch to "All" to see successful traffic.' : 'Reproduce the bug on this tab — requests will appear here.'}</div>
      </div>`;
    bulkBar.classList.add('hidden');
    return;
  }

  list.innerHTML = '';
  data
    .slice()
    .reverse()
    .forEach((e) => {
      const div = document.createElement('div');
      const failed = isFailedNetwork(e);
      div.className = `item ${failed ? 'failed' : 'success'}`;
      div.innerHTML = `
      <div class="status">${e.data.response.status || 'ERR'}</div>
      <div class="method">${escapeHtml(e.data.request.method)}</div>
      <div class="url" title="${escapeHtml(e.data.request.url)}">${escapeHtml(shortUrl(e.data.request.url))}</div>
      <div class="time">${fmtTime(e.data.timing.startedAt)}</div>
      <div class="duration">${e.data.timing.durationMs}ms</div>
    `;
      div.addEventListener('click', () => showDetail(e));
      list.appendChild(div);
    });

  renderBulkBar(data);
}

function renderBulkBar(data: NetworkRequestEvent[]): void {
  const bulkBar = document.getElementById('bulk-bar');
  if (!bulkBar) return;
  const combinedReport = buildBulkReport(data);
  const isOversize = combinedReport.length > SLACK_SAFE_THRESHOLD;
  const label = filterMode === 'failed' ? 'failed' : 'total';

  bulkBar.classList.remove('hidden');
  bulkBar.innerHTML = `
    <div class="bulk-count"><strong>${data.length}</strong> ${label} · ${fmtSize(combinedReport.length)}${isOversize ? ' · JSON auto-downloads' : ''}</div>
    <div class="bulk-actions">
      <button id="copy-all" class="${isOversize ? 'warning' : 'primary'}">📋 Copy all + screenshot</button>
      <button id="download-all">⤓ JSON</button>
      <button id="download-har">⤓ HAR</button>
    </div>
  `;

  document.getElementById('copy-all')?.addEventListener('click', async (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    btn.textContent = '… rendering';
    const r = await writeTextAndImage(combinedReport, data, { maxText: SLACK_SAFE_THRESHOLD });

    if (r.textSkipped && r.hasImage) {
      downloadAllAsFile(data);
      btn.textContent = `✓ Image · JSON ⤓ (text too long)`;
    } else if (r.hasImage && r.hasText) {
      btn.textContent = `✓ Copied ${data.length} + image`;
    } else if (r.hasText) {
      btn.textContent = `✓ Copied text only`;
    } else if (r.hasImage) {
      btn.textContent = `✓ Image copied`;
    } else {
      btn.textContent = 'Copy failed';
    }
    btn.classList.add('copied');
    setTimeout(
      () => renderBulkBar(filterMode === 'failed' ? events.filter(isFailedNetwork) : events),
      2200
    );
  });

  document.getElementById('download-all')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    downloadAllAsFile(data);
    btn.textContent = '✓ Downloaded';
    btn.classList.add('copied');
    setTimeout(
      () => renderBulkBar(filterMode === 'failed' ? events.filter(isFailedNetwork) : events),
      1800
    );
  });

  document.getElementById('download-har')?.addEventListener('click', (clickEvent) => {
    const btn = clickEvent.currentTarget as HTMLButtonElement;
    try {
      downloadAsHar(data);
      btn.textContent = '✓ HAR ⤓';
      btn.classList.add('copied');
    } catch {
      btn.textContent = 'No requests';
    }
    setTimeout(
      () => renderBulkBar(filterMode === 'failed' ? events.filter(isFailedNetwork) : events),
      1800
    );
  });
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

function showDetail(c: NetworkRequestEvent): void {
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
    </div>

    ${
      isOversize
        ? `
    <div class="size-warning">
      Bug report is <strong>${bugReportText.length.toLocaleString()} chars</strong> — over Slack's paste limit (${SLACK_SAFE_THRESHOLD.toLocaleString()}).
      Clicking <strong>Copy bug report</strong> will put the image on your clipboard and auto-download the JSON file. Paste the image into Slack, then drag the JSON file in as a snippet.
    </div>`
        : ''
    }

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
    const data = filterMode === 'failed' ? events.filter(isFailedNetwork) : events;
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
