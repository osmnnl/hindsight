// Popup UI for the toolbar action.
//
// TODO(m1-w2): rebuild against the canonical CapturedEvent model
// (PRD §6.1.2). This file is a like-for-like .js → .ts port; logic is
// unchanged. UI copy is generic — do not introduce vendor-specific
// strings (see CLAUDE.md §5.1).

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

interface LegacyCapture {
  id?: string;
  type?: 'fetch' | 'xhr';
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  startedAt?: number;
  duration?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  error?: string | null;
  pageUrl?: string;
  pageTitle?: string;
  capturedAt?: number;
}

type FilterMode = 'failed' | 'all';

function fmtSize(n: number): string {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

// HH:MM:SS.mmm — local time with millisecond precision.
function fmtTime(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

// Render the captured failures as a self-contained PNG image.
async function renderFailureListImage(items: LegacyCapture[]): Promise<Blob | null> {
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
  const failedCount = items.filter((c) => isFailed(c)).length;
  ctx.fillText(`Hindsight · ${failedCount} failed`, PAD + 18, PAD + 12);

  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#8b94b3';
  const host = (() => {
    try {
      return new URL(items[0]?.pageUrl ?? '').host;
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
    const failed = isFailed(c);

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
    ctx.fillText(String(c.status ?? 'ERR'), PAD + STATUS_W / 2, mid);

    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'left';
    ctx.fillText((c.method ?? '?').toUpperCase(), PAD + STATUS_W + COL_GAP, mid);

    ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#e7ecf5';
    const urlPath = (() => {
      try {
        return new URL(c.url).pathname;
      } catch {
        return c.url;
      }
    })();
    ctx.fillText(fitText(ctx, urlPath, urlMaxW), urlX, mid);

    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(c.startedAt), timeX, mid);

    ctx.fillText(`${c.duration ?? 0}ms`, W - PAD, mid);
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
  itemsForImage: LegacyCapture[],
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
let captures: LegacyCapture[] = [];
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
    const result = await chrome.runtime.sendMessage({ type: 'GET_CAPTURES', tabId });
    captures = Array.isArray(result) ? (result as LegacyCapture[]) : [];
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
  await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURES', tabId });
  await refresh();
}

function isFailed(c: LegacyCapture): boolean {
  return (c.status ?? 0) >= 400 || c.status === 0 || !!c.error;
}

function render(): void {
  const list = document.getElementById('list');
  const bulkBar = document.getElementById('bulk-bar');
  if (!list || !bulkBar) return;
  const data = filterMode === 'failed' ? captures.filter(isFailed) : captures;

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
    .forEach((c) => {
      const div = document.createElement('div');
      const failed = isFailed(c);
      div.className = `item ${failed ? 'failed' : 'success'}`;
      div.innerHTML = `
      <div class="status">${c.status ?? 'ERR'}</div>
      <div class="method">${escapeHtml(c.method ?? '?')}</div>
      <div class="url" title="${escapeHtml(c.url)}">${escapeHtml(shortUrl(c.url))}</div>
      <div class="time">${fmtTime(c.startedAt)}</div>
      <div class="duration">${c.duration ?? 0}ms</div>
    `;
      div.addEventListener('click', () => showDetail(c));
      list.appendChild(div);
    });

  renderBulkBar(data);
}

function renderBulkBar(data: LegacyCapture[]): void {
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
      <button id="download-all">⤓ Download all</button>
    </div>
  `;

  document.getElementById('copy-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
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
      () => renderBulkBar(filterMode === 'failed' ? captures.filter(isFailed) : captures),
      2200
    );
  });

  document.getElementById('download-all')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    downloadAllAsFile(data);
    btn.textContent = '✓ Downloaded';
    btn.classList.add('copied');
    setTimeout(
      () => renderBulkBar(filterMode === 'failed' ? captures.filter(isFailed) : captures),
      1800
    );
  });
}

function buildBulkReport(items: LegacyCapture[]): string {
  if (items.length === 0) return '';
  if (items.length === 1 && items[0]) return toBugReport(items[0]);

  const first = items[0];
  const lines = [
    `## ${items.length} API errors`,
    '',
    `Captured: ${new Date().toISOString()}`,
    `Page: ${first?.pageUrl ?? '-'}`,
    '',
    '### Summary',
    ...items.map((c, i) => {
      const path = (() => {
        try {
          return new URL(c.url).pathname;
        } catch {
          return c.url;
        }
      })();
      return `${i + 1}. \`${c.status ?? 'ERR'}\` ${c.method} ${path} · ${fmtTime(c.startedAt)} · ${c.duration}ms`;
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

function downloadAllAsFile(items: LegacyCapture[]): void {
  const payload = items.map((c) => ({ ...c, requestHeaders: maskHeaders(c.requestHeaders) }));
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

function showDetail(c: LegacyCapture): void {
  const detail = document.getElementById('detail');
  if (!detail) return;
  const failed = isFailed(c);

  const bugReportText = toBugReport(c);
  const curlText = toCurl(c);
  const respText = c.responseBody ?? '';
  const isOversize = bugReportText.length > SLACK_SAFE_THRESHOLD;

  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="detail-top">
      <div class="detail-back">
        <button id="back" class="secondary">← Back</button>
        <span class="time">${c.startedAt ? new Date(c.startedAt).toLocaleTimeString() : ''}</span>
      </div>
      <div class="detail-heading ${failed ? 'failed' : 'success'}">
        <span class="pill">${c.status ?? 'ERR'}</span>
        <strong>${escapeHtml(c.method ?? '?')}</strong>
        ${c.statusText ? `<span style="color:var(--muted)">${escapeHtml(c.statusText)}</span>` : ''}
      </div>
      <div class="detail-url">${escapeHtml(c.url)}</div>
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

    <div class="section">
      <h3>Request headers</h3>
      <pre>${escapeHtml(JSON.stringify(maskHeaders(c.requestHeaders), null, 2))}</pre>
    </div>

    ${
      c.requestBody
        ? `
    <div class="section">
      <h3>Request body</h3>
      <pre>${escapeHtml(formatJson(c.requestBody))}</pre>
    </div>`
        : ''
    }

    <div class="section">
      <h3>Response headers</h3>
      <pre>${escapeHtml(JSON.stringify(c.responseHeaders ?? {}, null, 2))}</pre>
    </div>

    <div class="section" style="padding-bottom: 16px;">
      <h3>Response body</h3>
      <pre>${escapeHtml(formatJson(c.responseBody ?? ''))}</pre>
    </div>
  `;

  document.getElementById('back')?.addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    const data = filterMode === 'failed' ? captures.filter(isFailed) : captures;
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

function formatForCopy(c: LegacyCapture, format: 'report' | 'curl' | 'response'): string {
  if (format === 'curl') return toCurl(c);
  if (format === 'response') return c.responseBody ?? '';
  return toBugReport(c);
}

function toCurl(c: LegacyCapture): string {
  const lines = [`curl -X ${c.method} '${c.url}'`];
  for (const [k, v] of Object.entries(maskHeaders(c.requestHeaders) ?? {})) {
    lines.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (c.requestBody) {
    const body = String(c.requestBody).replace(/'/g, "'\\''");
    lines.push(`  --data '${body}'`);
  }
  return lines.join(' \\\n');
}

function toBugReport(c: LegacyCapture): string {
  const errorSignals = extractErrorSignal(c.responseBody ?? null);

  return `## API Error — ${c.method} ${c.url.split('?')[0]}

**Page:** ${c.pageUrl ?? '-'}
**Endpoint:** \`${c.method} ${c.url}\`
**Status:** ${c.status ?? 'ERR'} ${c.statusText ?? ''}
**Duration:** ${c.duration ?? 0}ms
**Captured at:** ${c.startedAt ? new Date(c.startedAt).toISOString() : '-'}
${c.error ? `**Network error:** ${c.error}\n` : ''}${
    errorSignals
      ? `
### Server error signals (summary — full body is below)
${errorSignals.map((e) => `- ${e}`).join('\n')}
`
      : ''
  }
### Request headers
\`\`\`json
${JSON.stringify(maskHeaders(c.requestHeaders) ?? {}, null, 2)}
\`\`\`
${
  c.requestBody
    ? `
### Request body
\`\`\`json
${formatJson(c.requestBody)}
\`\`\``
    : ''
}

### Response headers
\`\`\`json
${JSON.stringify(c.responseHeaders ?? {}, null, 2)}
\`\`\`

### Response body
\`\`\`json
${formatJson(c.responseBody ?? '')}
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

function downloadAsFile(c: LegacyCapture): void {
  const payload = { ...c, requestHeaders: maskHeaders(c.requestHeaders) };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = c.startedAt
    ? new Date(c.startedAt).toISOString().replace(/[:.]/g, '-')
    : new Date().toISOString().replace(/[:.]/g, '-');
  const path = (() => {
    try {
      return new URL(c.url).pathname.replace(/\//g, '_');
    } catch {
      return 'request';
    }
  })();
  const filename = `bug-${c.status ?? 'ERR'}-${c.method}${path}-${ts}.json`;
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

function maskHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined;
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
