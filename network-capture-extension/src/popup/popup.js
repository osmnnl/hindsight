// src/popup/popup.js

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token']);

// Practical paste limit observed in Slack's rich-text editor. Slack docs
// quote 40k for messages, but the in-editor paste warning fires far below
// that (often ~3-4k chars). Above this we put image-only on the clipboard
// and trigger a JSON download so the receiver gets both pieces.
const SLACK_SAFE_THRESHOLD = 3000;

function fmtSize(n) {
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

// HH:MM:SS.mmm — local time with millisecond precision.
// Testers correlate this with server logs / their own actions.
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

// Render the captured failures as a self-contained PNG image. This is what
// "screenshot" means to a tester reporting bugs — a visual "look, these
// requests failed" they can paste into Slack. We draw it ourselves instead
// of using chrome.tabs.captureVisibleTab because:
//   1. Popups aren't tabs, so captureVisibleTab can't see the popup UI.
//   2. We have the structured data — rendering it ourselves is sharper and
//      can be wider than the 580px popup constraint.
// Returns a PNG Blob or null on failure.
async function renderFailureListImage(items) {
  if (!items || items.length === 0) return null;

  const DPR = 2;
  const W = 760;
  const PAD = 22;
  const HEADER_H = 78;
  const ROW_H = 38;
  const FOOTER_H = 32;
  const H = HEADER_H + (items.length * ROW_H) + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // Background — matches popup theme
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, W, H);

  // --- Header ---
  // Amber dot
  ctx.beginPath();
  ctx.arc(PAD + 5, PAD + 12, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();

  // Title
  ctx.font = '600 15px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#e7ecf5';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const failedCount = items.filter((c) => isFailed(c)).length;
  ctx.fillText(`Network Capture · ${failedCount} failed`, PAD + 18, PAD + 12);

  // Subtitle (host + capture time)
  ctx.font = '12px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#8b94b3';
  const host = (() => { try { return new URL(items[0].pageUrl || '').host; } catch { return ''; } })();
  const captureTs = new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const subtitle = host ? `${host} · ${captureTs}` : captureTs;
  ctx.fillText(subtitle, PAD + 18, PAD + 34);

  // Header bottom divider
  ctx.fillStyle = '#2a335a';
  ctx.fillRect(0, HEADER_H, W, 1);

  // --- Rows ---
  // Right-edge fixed columns
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

    // Row divider (between rows, skip first)
    if (i > 0) {
      ctx.fillStyle = '#1a2340';
      ctx.fillRect(PAD, y, W - PAD * 2, 1);
    }

    // Status badge
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
    ctx.fillText(String(c.status || 'ERR'), PAD + STATUS_W / 2, mid);

    // Method
    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'left';
    ctx.fillText((c.method || '?').toUpperCase(), PAD + STATUS_W + COL_GAP, mid);

    // URL (truncate to available width)
    ctx.font = '12px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#e7ecf5';
    const urlPath = (() => { try { return new URL(c.url).pathname; } catch { return c.url; } })();
    ctx.fillText(fitText(ctx, urlPath, urlMaxW), urlX, mid);

    // Time (right-aligned to its column)
    ctx.font = '11px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#8b94b3';
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(c.startedAt), timeX, mid);

    // Duration (right-aligned to right edge)
    ctx.fillText(`${c.duration ?? 0}ms`, W - PAD, mid);
  });

  // --- Footer ---
  const footerY = HEADER_H + items.length * ROW_H;
  ctx.fillStyle = '#2a335a';
  ctx.fillRect(0, footerY, W, 1);
  ctx.font = '10.5px ui-sans-serif, system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#8b94b3';
  ctx.textAlign = 'left';
  ctx.fillText('QA Network Capture · datasoftcloud HR', PAD, footerY + 16);

  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Trim text with an ellipsis until it fits within maxWidth in the current font.
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

// Put a bug report on the clipboard. If the text is over `maxText`, we
// SKIP the text entirely — Slack rejects oversized pastes even when an
// image is also present (it picks the text). With image-only on clipboard
// the paste works; the caller can pair this with a JSON download so the
// receiver still gets full payload data via drag-drop.
async function writeTextAndImage(text, itemsForImage, opts = {}) {
  const maxText = opts.maxText ?? Infinity;
  const skipText = text.length > maxText;

  let imageBlob = null;
  try {
    imageBlob = await renderFailureListImage(itemsForImage);
  } catch (e) {
    console.warn('Image render failed:', e);
  }

  const formats = {};
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
      } catch (_) {}
    }
    return { hasText: false, hasImage: false, textSkipped: skipText };
  }
}

let tabId = null;
let captures = [];
let filterMode = 'failed'; // 'failed' | 'all'
let pollTimer = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;

  document.querySelectorAll('.filter').forEach((btn) => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });
  document.getElementById('clear').addEventListener('click', clearAll);

  await refresh();
  pollTimer = setInterval(refresh, 1500);
  window.addEventListener('unload', () => clearInterval(pollTimer));
}

async function refresh() {
  if (tabId == null) return;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_CAPTURES', tabId });
    captures = Array.isArray(result) ? result : [];
    render();
  } catch (e) { /* service worker briefly inactive */ }
}

function setFilter(mode) {
  filterMode = mode;
  document.querySelectorAll('.filter').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === mode);
  });
  render();
}

async function clearAll() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CAPTURES', tabId });
  await refresh();
}

function isFailed(c) { return c.status >= 400 || c.status === 0 || c.error; }

function render() {
  const list = document.getElementById('list');
  const bulkBar = document.getElementById('bulk-bar');
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
  // Newest first
  data.slice().reverse().forEach((c) => {
    const div = document.createElement('div');
    const failed = isFailed(c);
    div.className = `item ${failed ? 'failed' : 'success'}`;
    div.innerHTML = `
      <div class="status">${c.status || 'ERR'}</div>
      <div class="method">${escapeHtml(c.method || '?')}</div>
      <div class="url" title="${escapeHtml(c.url)}">${escapeHtml(shortUrl(c.url))}</div>
      <div class="time">${fmtTime(c.startedAt)}</div>
      <div class="duration">${c.duration ?? 0}ms</div>
    `;
    div.addEventListener('click', () => showDetail(c));
    list.appendChild(div);
  });

  renderBulkBar(data);
}

// Sticky bottom bar with bulk actions over the currently filtered set.
function renderBulkBar(data) {
  const bulkBar = document.getElementById('bulk-bar');
  // Pre-compute combined report size so we can warn if it won't fit in Slack
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

  document.getElementById('copy-all').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.textContent = '… rendering';
    const r = await writeTextAndImage(combinedReport, data, { maxText: SLACK_SAFE_THRESHOLD });

    if (r.textSkipped && r.hasImage) {
      // Text too big for Slack — image is on clipboard for paste,
      // auto-download JSON so the receiver gets full payload too.
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
    setTimeout(() => renderBulkBar(filterMode === 'failed' ? captures.filter(isFailed) : captures), 2200);
  });

  document.getElementById('download-all').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    downloadAllAsFile(data);
    btn.textContent = '✓ Downloaded';
    btn.classList.add('copied');
    setTimeout(() => renderBulkBar(filterMode === 'failed' ? captures.filter(isFailed) : captures), 1800);
  });
}

// Combined markdown report for N captures — each section is the same
// full-fidelity bug report shape as a single capture.
function buildBulkReport(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return toBugReport(items[0]);

  const lines = [
    `## ${items.length} API hatası`,
    '',
    `Captured: ${new Date().toISOString()}`,
    `Page: ${items[0].pageUrl || '-'}`,
    '',
    '### Summary',
    ...items.map((c, i) => {
      const path = (() => { try { return new URL(c.url).pathname; } catch { return c.url; }})();
      return `${i + 1}. \`${c.status || 'ERR'}\` ${c.method} ${path} · ${fmtTime(c.startedAt)} · ${c.duration}ms`;
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

function downloadAllAsFile(items) {
  const payload = items.map(c => ({ ...c, requestHeaders: maskHeaders(c.requestHeaders) }));
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
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function showDetail(c) {
  const detail = document.getElementById('detail');
  const failed = isFailed(c);

  // Pre-compute everything so we can show byte counts on each button.
  // No truncation, no denoise — full fidelity, every field as it was sent/received.
  const bugReportText = toBugReport(c);
  const curlText = toCurl(c);
  const respText = c.responseBody || '';
  const isOversize = bugReportText.length > SLACK_SAFE_THRESHOLD;

  detail.classList.remove('hidden');
  detail.innerHTML = `
    <div class="detail-top">
      <div class="detail-back">
        <button id="back" class="secondary">← Back</button>
        <span class="time">${new Date(c.startedAt).toLocaleTimeString()}</span>
      </div>
      <div class="detail-heading ${failed ? 'failed' : 'success'}">
        <span class="pill">${c.status || 'ERR'}</span>
        <strong>${escapeHtml(c.method || '?')}</strong>
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

    ${isOversize ? `
    <div class="size-warning">
      Bug report is <strong>${bugReportText.length.toLocaleString()} chars</strong> — over Slack's paste limit (${SLACK_SAFE_THRESHOLD.toLocaleString()}).
      Clicking <strong>Copy bug report</strong> will put the image on your clipboard and auto-download the JSON file. Paste the image into Slack, then drag the JSON file in as a snippet.
    </div>` : ''}

    <div class="section">
      <h3>Request headers</h3>
      <pre>${escapeHtml(JSON.stringify(maskHeaders(c.requestHeaders), null, 2))}</pre>
    </div>

    ${c.requestBody ? `
    <div class="section">
      <h3>Request body</h3>
      <pre>${escapeHtml(formatJson(c.requestBody))}</pre>
    </div>` : ''}

    <div class="section">
      <h3>Response headers</h3>
      <pre>${escapeHtml(JSON.stringify(c.responseHeaders || {}, null, 2))}</pre>
    </div>

    <div class="section" style="padding-bottom: 16px;">
      <h3>Response body</h3>
      <pre>${escapeHtml(formatJson(c.responseBody || ''))}</pre>
    </div>
  `;

  document.getElementById('back').addEventListener('click', () => {
    detail.classList.add('hidden');
    detail.innerHTML = '';
    // Re-show bulk bar when leaving detail
    const data = filterMode === 'failed' ? captures.filter(isFailed) : captures;
    if (data.length > 0) document.getElementById('bulk-bar').classList.remove('hidden');
  });

  // Hide bulk bar while in detail view
  document.getElementById('bulk-bar').classList.add('hidden');

  detail.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const format = btn.dataset.copy;
      const text = formatForCopy(c, format);
      const original = btn.textContent;
      try {
        // Only the main bug report carries a screenshot — cURL/response are
        // for pasting into terminals/editors where the image is unhelpful.
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
      } catch (err) {
        btn.textContent = 'Copy failed';
      }
    });
  });

  detail.querySelectorAll('[data-action="download"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      downloadAsFile(c);
      const original = btn.textContent;
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

function formatForCopy(c, format) {
  if (format === 'curl') return toCurl(c);
  if (format === 'response') return c.responseBody || '';
  return toBugReport(c);
}

function toCurl(c) {
  const lines = [`curl -X ${c.method} '${c.url}'`];
  for (const [k, v] of Object.entries(maskHeaders(c.requestHeaders || {}))) {
    lines.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (c.requestBody) {
    const body = String(c.requestBody).replace(/'/g, "'\\''");
    lines.push(`  --data '${body}'`);
  }
  return lines.join(' \\\n');
}

function toBugReport(c) {
  const errorSignals = extractErrorSignal(c.responseBody);

  return `## API Hatası — ${c.method} ${c.url.split('?')[0]}

**Page:** ${c.pageUrl || '-'}
**Endpoint:** \`${c.method} ${c.url}\`
**Status:** ${c.status || 'ERR'} ${c.statusText || ''}
**Duration:** ${c.duration ?? 0}ms
**Captured at:** ${new Date(c.startedAt).toISOString()}
${c.error ? `**Network error:** ${c.error}\n` : ''}${errorSignals ? `
### Server error signals (summary — full body is below)
${errorSignals.map(e => `- ${e}`).join('\n')}
` : ''}
### Request headers
\`\`\`json
${JSON.stringify(maskHeaders(c.requestHeaders || {}), null, 2)}
\`\`\`
${c.requestBody ? `
### Request body
\`\`\`json
${formatJson(c.requestBody)}
\`\`\`` : ''}

### Response headers
\`\`\`json
${JSON.stringify(c.responseHeaders || {}, null, 2)}
\`\`\`

### Response body
\`\`\`json
${formatJson(c.responseBody || '')}
\`\`\`

### cURL
\`\`\`bash
${toCurl(c)}
\`\`\`
`;
}

// Extract validation/error info from a JSON response body. Returns null if
// the body isn't JSON or no error-shaped fields are found.
// This is ADDITIVE — surfaces error info at the top of the report as a
// summary; the full response body still appears verbatim below it.
function extractErrorSignal(jsonStr) {
  if (!jsonStr) return null;
  let obj;
  try { obj = JSON.parse(jsonStr); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const out = [];

  // .NET ModelState style: { errors: { field: ["msg"] } }
  if (obj.errors && typeof obj.errors === 'object' && !Array.isArray(obj.errors)) {
    for (const [field, msgs] of Object.entries(obj.errors)) {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      list.forEach(m => out.push(`${field}: ${typeof m === 'string' ? m : JSON.stringify(m)}`));
    }
  }
  // Array errors: { errors: [{ field, message }] }
  if (Array.isArray(obj.errors)) {
    obj.errors.forEach(e => {
      if (typeof e === 'string') out.push(e);
      else if (e?.field && e?.message) out.push(`${e.field}: ${e.message}`);
      else if (e?.message) out.push(e.message);
      else out.push(JSON.stringify(e));
    });
  }
  // Old ASP.NET: ModelState
  if (obj.ModelState && typeof obj.ModelState === 'object') {
    for (const [field, msgs] of Object.entries(obj.ModelState)) {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      list.forEach(m => out.push(`${field}: ${m}`));
    }
  }
  // Top-level signal fields
  if (typeof obj.message === 'string') out.push(`message: ${obj.message}`);
  if (typeof obj.error === 'string') out.push(`error: ${obj.error}`);
  if (obj.error && typeof obj.error === 'object' && obj.error.message) out.push(`error: ${obj.error.message}`);
  if (typeof obj.detail === 'string') out.push(`detail: ${obj.detail}`);
  if (typeof obj.title === 'string' && obj.title !== obj.message) out.push(`title: ${obj.title}`);
  if (typeof obj.traceId === 'string') out.push(`traceId: ${obj.traceId}`);

  return out.length ? out : null;
}

// Trigger a JSON file download with the full capture (no truncation).
// Drag-drop the file into Slack and it'll attach as a snippet — bypasses
// every text-length limit Slack imposes.
function downloadAsFile(c) {
  const payload = { ...c, requestHeaders: maskHeaders(c.requestHeaders) };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date(c.startedAt).toISOString().replace(/[:.]/g, '-');
  const path = (() => { try { return new URL(c.url).pathname.replace(/\//g, '_'); } catch { return 'request'; }})();
  const filename = `bug-${c.status || 'ERR'}-${c.method}${path}-${ts}.json`;
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

function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '***MASKED***' : v;
  }
  return out;
}

function formatJson(str) {
  if (!str) return '';
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return String(str); }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch { return url; }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
