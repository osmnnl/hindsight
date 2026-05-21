// Settings page — General + Privacy + Capture sections (PRD §6.6.1).

import {
  readCaptureSettings,
  readDetectionSettings,
  readGeneralSettings,
  readPrivacySettings,
  writeCaptureSettings,
  writeDetectionSettings,
  writeGeneralSettings,
  writePrivacySettings,
  type CustomPatternSetting,
  type MaxEventsPerTab,
  type NotificationFrequency,
  type PrivacySettings,
  type ThemePreference,
} from '@/lib/settings';
import {
  DEFAULT_BODY_RULES,
  DEFAULT_FORM_RULES,
  DEFAULT_HEADER_RULES,
  maskBody,
  tryCompilePattern,
  type BodyPatternRule,
} from '@/lib/masking';
import { applyTheme, listenForThemeChanges } from '@/lib/theme';

const SAVE_FLASH_MS = 1400;

void init();

async function init(): Promise<void> {
  await applyTheme();
  listenForThemeChanges();
  setupSectionNav();
  await initGeneral();
  await initPrivacy();
  await initCapture();
  await initDetection();
}

// ---------------------------------------------------------------------------
// Section nav
// ---------------------------------------------------------------------------

function setupSectionNav(): void {
  const links = document.querySelectorAll<HTMLButtonElement>('.section-link:not(.disabled)');
  links.forEach((link) => {
    link.addEventListener('click', () => {
      const target = link.dataset.section;
      if (!target) return;
      links.forEach((l) => l.classList.toggle('active', l === link));
      document.querySelectorAll<HTMLElement>('.section').forEach((s) => {
        s.classList.toggle('active', s.id === `section-${target}`);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// General — Theme
// ---------------------------------------------------------------------------

async function initGeneral(): Promise<void> {
  const themeSelect = document.getElementById('theme');
  if (!(themeSelect instanceof HTMLSelectElement)) return;
  const status = document.getElementById('save-status');

  const current = await readGeneralSettings();
  themeSelect.value = current.theme;

  themeSelect.addEventListener('change', () => {
    const next = themeSelect.value as ThemePreference;
    void writeGeneralSettings({ theme: next }).then(() => {
      flashSaved(status);
    });
  });
}

// ---------------------------------------------------------------------------
// Privacy — default rules, custom patterns, blocklist, sandbox
// ---------------------------------------------------------------------------

let privacyState: PrivacySettings = {
  customPatterns: [],
  blocklistedOrigins: [],
  schemaVersion: 1,
};

async function initPrivacy(): Promise<void> {
  privacyState = await readPrivacySettings();

  renderDefaultRuleChips();
  renderCustomPatterns();
  renderOriginList();
  renderSandboxRules();

  document.getElementById('add-pattern')?.addEventListener('click', addCustomPattern);
  document.getElementById('origin-add')?.addEventListener('click', addOrigin);
  document.getElementById('origin-input')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && e.key === 'Enter') {
      e.preventDefault();
      addOrigin();
    }
  });

  document.getElementById('sandbox-rule')?.addEventListener('change', runSandbox);
  document.getElementById('sandbox-scope')?.addEventListener('change', runSandbox);
  document.getElementById('sandbox-input')?.addEventListener('input', runSandbox);
}

function renderDefaultRuleChips(): void {
  renderRuleGroup(
    'default-headers',
    'Headers',
    DEFAULT_HEADER_RULES.map((r) => ({ label: r.label, scope: r.scope.join(', ') }))
  );
  renderRuleGroup(
    'default-bodies',
    'Bodies',
    DEFAULT_BODY_RULES.map((r) => ({ label: r.label, scope: r.scope.join(', ') }))
  );
  renderRuleGroup(
    'default-forms',
    'Form fields',
    DEFAULT_FORM_RULES.map((r) => ({ label: r.label, scope: r.scope.join(', ') }))
  );
}

function renderRuleGroup(
  containerId: string,
  heading: string,
  items: { label: string; scope: string }[]
): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `
    <div class="chip-heading">${heading}</div>
    <div class="chips">
      ${items
        .map(
          (i) =>
            `<span class="chip" title="scope: ${escapeHtml(i.scope)}">${escapeHtml(i.label)}</span>`
        )
        .join('')}
    </div>
  `;
}

// ----- Custom patterns ------------------------------------------------------

function renderCustomPatterns(): void {
  const container = document.getElementById('custom-patterns');
  if (!container) return;

  if (privacyState.customPatterns.length === 0) {
    container.innerHTML = `<p class="empty-row">No custom patterns yet. Click <strong>Add pattern</strong> to start.</p>`;
    return;
  }

  container.innerHTML = privacyState.customPatterns
    .map((p, idx) => renderPatternEditor(p, idx))
    .join('');

  privacyState.customPatterns.forEach((p, idx) => {
    bindPatternEditor(p.id, idx);
  });
}

function renderPatternEditor(p: CustomPatternSetting, idx: number): string {
  const compiles = tryCompilePattern(p.source) !== null || p.source.trim() === '';
  return `
    <div class="pattern-card" data-pattern-id="${escapeHtml(p.id)}">
      <div class="pattern-row">
        <label>
          <span>Label</span>
          <input type="text" data-bind="label" value="${escapeHtml(p.label)}" placeholder="My API token" />
        </label>
        <label>
          <span>Regex</span>
          <input type="text" data-bind="source" value="${escapeHtml(p.source)}" placeholder="\\\\bsk_live_[A-Za-z0-9]+\\\\b" spellcheck="false" />
          ${compiles ? '' : `<span class="regex-error">invalid regex — saved but not applied</span>`}
        </label>
      </div>
      <div class="pattern-row scopes">
        <label class="scope-check">
          <input type="checkbox" data-bind="scope-request" ${p.scope.includes('request.body') ? 'checked' : ''} />
          Apply to request bodies
        </label>
        <label class="scope-check">
          <input type="checkbox" data-bind="scope-response" ${p.scope.includes('response.body') ? 'checked' : ''} />
          Apply to response bodies
        </label>
        <button type="button" class="btn-remove" data-action="remove" data-idx="${idx}">Remove</button>
      </div>
    </div>
  `;
}

function bindPatternEditor(patternId: string, idx: number): void {
  const card = document.querySelector<HTMLElement>(`[data-pattern-id="${patternId}"]`);
  if (!card) return;

  const inputLabel = card.querySelector<HTMLInputElement>('[data-bind="label"]');
  const inputSource = card.querySelector<HTMLInputElement>('[data-bind="source"]');
  const cbReq = card.querySelector<HTMLInputElement>('[data-bind="scope-request"]');
  const cbResp = card.querySelector<HTMLInputElement>('[data-bind="scope-response"]');
  const removeBtn = card.querySelector<HTMLButtonElement>('[data-action="remove"]');

  const persist = (): void => {
    const pattern = privacyState.customPatterns[idx];
    if (!pattern) return;
    pattern.label = inputLabel?.value ?? '';
    pattern.source = inputSource?.value ?? '';
    const scope: CustomPatternSetting['scope'] = [];
    if (cbReq?.checked) scope.push('request.body');
    if (cbResp?.checked) scope.push('response.body');
    pattern.scope = scope;
    void writePrivacySettings({ customPatterns: [...privacyState.customPatterns] }).then(
      flashPrivacy
    );
    renderSandboxRules();
  };

  const debounced = debounce(persist, 250);

  inputLabel?.addEventListener('input', debounced);
  inputSource?.addEventListener('input', () => {
    debounced();
    renderCustomPatterns(); // rebind to update the regex-error badge
  });
  cbReq?.addEventListener('change', persist);
  cbResp?.addEventListener('change', persist);

  removeBtn?.addEventListener('click', () => {
    privacyState.customPatterns.splice(idx, 1);
    void writePrivacySettings({ customPatterns: [...privacyState.customPatterns] }).then(
      flashPrivacy
    );
    renderCustomPatterns();
    renderSandboxRules();
  });
}

function addCustomPattern(): void {
  const fresh: CustomPatternSetting = {
    id: crypto.randomUUID(),
    label: '',
    source: '',
    scope: ['request.body', 'response.body'],
  };
  privacyState.customPatterns.push(fresh);
  void writePrivacySettings({ customPatterns: [...privacyState.customPatterns] }).then(
    flashPrivacy
  );
  renderCustomPatterns();
  renderSandboxRules();
}

// ----- Origin blocklist -----------------------------------------------------

function renderOriginList(): void {
  const container = document.getElementById('origin-list');
  if (!container) return;
  if (privacyState.blocklistedOrigins.length === 0) {
    container.innerHTML = `<p class="empty-row">No origins blocked.</p>`;
    return;
  }
  container.innerHTML = privacyState.blocklistedOrigins
    .map(
      (o, idx) =>
        `<span class="chip removable" data-origin="${escapeHtml(o)}">
          <code>${escapeHtml(o)}</code>
          <button type="button" data-idx="${idx}" aria-label="Remove ${escapeHtml(o)}">✕</button>
        </span>`
    )
    .join('');

  container.querySelectorAll<HTMLButtonElement>('button[data-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      if (Number.isNaN(idx)) return;
      privacyState.blocklistedOrigins.splice(idx, 1);
      void writePrivacySettings({
        blocklistedOrigins: [...privacyState.blocklistedOrigins],
      }).then(flashPrivacy);
      renderOriginList();
    });
  });
}

function addOrigin(): void {
  const input = document.getElementById('origin-input');
  if (!(input instanceof HTMLInputElement)) return;
  const raw = input.value.trim();
  if (!raw) return;
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    // Treat as host-only entry; surface a tiny inline hint.
    input.setCustomValidity('Enter a full URL (https://host:port).');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  if (privacyState.blocklistedOrigins.includes(origin)) {
    input.value = '';
    return;
  }
  privacyState.blocklistedOrigins.push(origin);
  void writePrivacySettings({
    blocklistedOrigins: [...privacyState.blocklistedOrigins],
  }).then(flashPrivacy);
  input.value = '';
  renderOriginList();
}

// ----- Sandbox --------------------------------------------------------------

interface SandboxRuleOption {
  key: string;
  label: string;
  rule: BodyPatternRule;
}

function listSandboxRules(): SandboxRuleOption[] {
  const opts: SandboxRuleOption[] = DEFAULT_BODY_RULES.map((r) => ({
    key: r.id,
    label: `Default · ${r.label}`,
    rule: r,
  }));
  for (const p of privacyState.customPatterns) {
    const compiled = tryCompilePattern(p.source);
    if (!compiled) continue;
    opts.push({
      key: `user.${p.id}`,
      label: `Custom · ${p.label || '(no label)'}`,
      rule: {
        id: `user.${p.id}`,
        label: p.label || 'Custom pattern',
        scope: p.scope.length > 0 ? p.scope : ['request.body', 'response.body'],
        kind: 'body-pattern',
        pattern: compiled,
      },
    });
  }
  return opts;
}

function renderSandboxRules(): void {
  const select = document.getElementById('sandbox-rule');
  if (!(select instanceof HTMLSelectElement)) return;
  const previous = select.value;
  const options = listSandboxRules();
  select.innerHTML = options
    .map((o) => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`)
    .join('');
  if (options.some((o) => o.key === previous)) {
    select.value = previous;
  }
  runSandbox();
}

function runSandbox(): void {
  const select = document.getElementById('sandbox-rule');
  const scopeSelect = document.getElementById('sandbox-scope');
  const input = document.getElementById('sandbox-input');
  const output = document.getElementById('sandbox-output');
  const meta = document.getElementById('sandbox-meta');
  if (
    !(select instanceof HTMLSelectElement) ||
    !(scopeSelect instanceof HTMLSelectElement) ||
    !(input instanceof HTMLTextAreaElement) ||
    !output ||
    !meta
  ) {
    return;
  }

  const rules = listSandboxRules();
  const chosen = rules.find((r) => r.key === select.value);
  const scope = scopeSelect.value as 'request.body' | 'response.body';
  const sample = input.value;

  if (!chosen || !sample) {
    output.textContent = '—';
    meta.textContent = '';
    return;
  }

  if (!chosen.rule.scope.includes(scope)) {
    output.textContent = sample;
    meta.textContent = `Rule does not apply to ${scope} (scope is ${chosen.rule.scope.join(', ')}).`;
    return;
  }

  const result = maskBody(sample, scope, [chosen.rule]);
  output.textContent = result.body ?? '';
  meta.textContent =
    result.redactions.length === 0
      ? 'No matches.'
      : `${result.redactions.length} match${result.redactions.length === 1 ? '' : 'es'} masked.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let generalFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved(target: HTMLElement | null): void {
  if (!target) return;
  target.textContent = '✓ Saved';
  if (generalFlashTimer) clearTimeout(generalFlashTimer);
  generalFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

// ---------------------------------------------------------------------------
// Capture — Tier 2 toggle, buffer cap
// ---------------------------------------------------------------------------

async function initCapture(): Promise<void> {
  const tier2 = document.getElementById('tier2-toggle');
  const tier3 = document.getElementById('tier3-toggle');
  const maxEvents = document.getElementById('max-events');
  if (
    !(tier2 instanceof HTMLInputElement) ||
    !(tier3 instanceof HTMLInputElement) ||
    !(maxEvents instanceof HTMLSelectElement)
  ) {
    return;
  }

  const current = await readCaptureSettings();
  tier2.checked = current.tier2Enabled;
  tier3.checked = current.tier3Enabled;
  maxEvents.value = String(current.maxEventsPerTab);

  tier2.addEventListener('change', () => {
    void writeCaptureSettings({ tier2Enabled: tier2.checked }).then(flashCapture);
  });
  tier3.addEventListener('change', () => {
    void writeCaptureSettings({ tier3Enabled: tier3.checked }).then(flashCapture);
  });
  maxEvents.addEventListener('change', () => {
    const v = Number(maxEvents.value) as MaxEventsPerTab;
    void writeCaptureSettings({ maxEventsPerTab: v }).then(flashCapture);
  });
}

// ---------------------------------------------------------------------------
// Detection — smart-detection master switch, notifications
// ---------------------------------------------------------------------------

async function initDetection(): Promise<void> {
  const smart = document.getElementById('smart-detection-toggle');
  const notif = document.getElementById('notifications-toggle');
  const freq = document.getElementById('notification-frequency');
  if (
    !(smart instanceof HTMLInputElement) ||
    !(notif instanceof HTMLInputElement) ||
    !(freq instanceof HTMLSelectElement)
  ) {
    return;
  }

  const current = await readDetectionSettings();
  smart.checked = current.smartDetectionEnabled;
  notif.checked = current.notificationsEnabled;
  freq.value = current.notificationFrequency;

  smart.addEventListener('change', () => {
    void writeDetectionSettings({ smartDetectionEnabled: smart.checked }).then(flashDetection);
  });

  // chrome.notifications is an optional permission — request it the
  // first time the user enables the toggle. If the user denies,
  // bounce the checkbox back to false.
  notif.addEventListener('change', () => {
    void (async () => {
      if (notif.checked) {
        const granted = await chrome.permissions
          .request({ permissions: ['notifications'] })
          .catch(() => false);
        if (!granted) {
          notif.checked = false;
          return;
        }
      }
      await writeDetectionSettings({ notificationsEnabled: notif.checked });
      flashDetection();
    })();
  });

  freq.addEventListener('change', () => {
    void writeDetectionSettings({
      notificationFrequency: freq.value as NotificationFrequency,
    }).then(flashDetection);
  });
}

let detectionFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashDetection(): void {
  const target = document.getElementById('detection-status');
  if (!target) return;
  target.textContent = '✓ Saved';
  if (detectionFlashTimer) clearTimeout(detectionFlashTimer);
  detectionFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

let captureFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCapture(): void {
  const target = document.getElementById('capture-status');
  if (!target) return;
  target.textContent = '✓ Saved';
  if (captureFlashTimer) clearTimeout(captureFlashTimer);
  captureFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

let privacyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashPrivacy(): void {
  const target = document.getElementById('privacy-status');
  if (!target) return;
  target.textContent = '✓ Saved';
  if (privacyFlashTimer) clearTimeout(privacyFlashTimer);
  privacyFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

function debounce<F extends () => void>(fn: F, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
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
