// Settings page — General + Privacy + Capture sections (PRD §6.6.1).

import { applyI18nToDom, initI18n, isLocale, setLocaleSync, subscribeLocale, t } from '@/lib/i18n';
import {
  DEFAULT_BODY_RULES,
  DEFAULT_FORM_RULES,
  DEFAULT_HEADER_RULES,
  maskBody,
  tryCompilePattern,
  type BodyPatternRule,
} from '@/lib/masking';
import {
  readAdvancedSettings,
  readCaptureSettings,
  readDetectionSettings,
  readGeneralSettings,
  readPrivacySettings,
  readSharingSettings,
  writeAdvancedSettings,
  writeCaptureSettings,
  writeDetectionSettings,
  writeGeneralSettings,
  writePrivacySettings,
  writeSharingSettings,
  type CustomPatternSetting,
  type MaxEventsPerTab,
  type NotificationFrequency,
  type PrivacySettings,
  type SharingSettings,
  type ThemePreference,
} from '@/lib/settings';
import { EVENT_CATEGORIES, type EventCategory } from '@/types/events';
import { applyTheme, listenForThemeChanges } from '@/lib/theme';

const SAVE_FLASH_MS = 1400;

void init();

async function init(): Promise<void> {
  await initI18n();
  applyI18nToDom();
  await applyTheme();
  listenForThemeChanges();
  setupSectionNav();
  await initGeneral();
  await initPrivacy();
  await initCapture();
  await initDetection();
  await initSharing();
  await initAdvanced();

  // Live language switch from any window — re-apply static markup and
  // re-render the dynamic chip/pattern/origin lists so they pick up the
  // new locale without a page reload. Theme/checkbox values are read
  // from storage so they don't need rebinding.
  subscribeLocale(() => {
    applyI18nToDom();
    renderDefaultRuleChips();
    renderCustomPatterns();
    renderOriginList();
    renderSandboxRules();
    runSandbox();
    relabelBufferOptions();
  });
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
// General — Theme + Language
// ---------------------------------------------------------------------------

async function initGeneral(): Promise<void> {
  const themeSelect = document.getElementById('theme');
  const languageSelect = document.getElementById('language');
  if (!(themeSelect instanceof HTMLSelectElement) || !(languageSelect instanceof HTMLSelectElement))
    return;
  const status = document.getElementById('save-status');

  const current = await readGeneralSettings();
  themeSelect.value = current.theme;
  languageSelect.value = current.language;

  themeSelect.addEventListener('change', () => {
    const next = themeSelect.value as ThemePreference;
    void writeGeneralSettings({ theme: next }).then(() => flashSaved(status));
  });

  languageSelect.addEventListener('change', () => {
    const next = languageSelect.value;
    if (!isLocale(next)) return;
    // Update the in-memory locale before persistence so this tab
    // re-renders immediately. subscribeLocale() ignores writes that
    // don't actually flip the value, so the storage.onChanged echo
    // from our own write is a no-op here.
    setLocaleSync(next);
    applyI18nToDom();
    renderDefaultRuleChips();
    renderCustomPatterns();
    renderOriginList();
    renderSandboxRules();
    runSandbox();
    relabelBufferOptions();
    void writeGeneralSettings({ language: next }).then(() => flashSaved(status));
  });
}

// ---------------------------------------------------------------------------
// Privacy — default rules, custom patterns, blocklist, sandbox
// ---------------------------------------------------------------------------

let privacyState: PrivacySettings = {
  customPatterns: [],
  blocklistedOrigins: [],
  disabledDefaultRules: [],
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
    t('settings.privacy.defaultRules.groupHeaders'),
    DEFAULT_HEADER_RULES.map((r) => ({
      id: r.id,
      label: r.label,
      scope: r.scope.join(', '),
    }))
  );
  renderRuleGroup(
    'default-bodies',
    t('settings.privacy.defaultRules.groupBodies'),
    DEFAULT_BODY_RULES.map((r) => ({
      id: r.id,
      label: r.label,
      scope: r.scope.join(', '),
    }))
  );
  // Form-field rules stay always-on for now — disabling password-input
  // masking is a much bigger footgun than disabling header/body rules,
  // and the page-world capture path doesn't yet honour the
  // disabledDefaultRules list. Show them read-only for transparency.
  renderRuleGroup(
    'default-forms',
    t('settings.privacy.defaultRules.groupFormFields'),
    DEFAULT_FORM_RULES.map((r) => ({
      id: r.id,
      label: r.label,
      scope: r.scope.join(', '),
    })),
    { readonly: true }
  );
}

function renderRuleGroup(
  containerId: string,
  heading: string,
  items: { id: string; label: string; scope: string }[],
  opts: { readonly?: boolean } = {}
): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  const disabled = new Set(privacyState.disabledDefaultRules);
  const readonly = opts.readonly ?? false;
  container.innerHTML = `
    <div class="chip-heading">${escapeHtml(heading)}</div>
    <div class="chips">
      ${items
        .map((i) => {
          const off = disabled.has(i.id);
          if (readonly) {
            const tooltip = t('settings.privacy.defaultRules.tooltipScope', { scope: i.scope });
            return `<span class="chip" title="${escapeHtml(tooltip)}">${escapeHtml(i.label)}</span>`;
          }
          const action = off
            ? t('settings.privacy.defaultRules.actionEnable')
            : t('settings.privacy.defaultRules.actionDisable');
          const tooltip = t('settings.privacy.defaultRules.tooltipToggle', {
            scope: i.scope,
            action,
          });
          return `<button
            type="button"
            class="chip toggle${off ? ' off' : ''}"
            data-rule-id="${escapeHtml(i.id)}"
            title="${escapeHtml(tooltip)}"
            aria-pressed="${off ? 'false' : 'true'}"
          >${off ? '✗' : '✓'} ${escapeHtml(i.label)}</button>`;
        })
        .join('')}
    </div>
  `;
  if (readonly) return;
  container.querySelectorAll<HTMLButtonElement>('.chip.toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.ruleId;
      if (!id) return;
      const next = new Set(privacyState.disabledDefaultRules);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      privacyState.disabledDefaultRules = Array.from(next);
      const status = document.getElementById('save-status');
      void writePrivacySettings({
        disabledDefaultRules: privacyState.disabledDefaultRules,
      }).then(() => {
        renderDefaultRuleChips();
        flashSaved(status);
      });
    });
  });
}

// ----- Custom patterns ------------------------------------------------------

function renderCustomPatterns(): void {
  const container = document.getElementById('custom-patterns');
  if (!container) return;

  if (privacyState.customPatterns.length === 0) {
    container.innerHTML = `<p class="empty-row">${t('settings.privacy.customPatterns.empty')}</p>`;
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
  const labelPh = t('settings.privacy.customPatterns.labelPlaceholder');
  const regexPh = t('settings.privacy.customPatterns.regexPlaceholder');
  const invalid = t('settings.privacy.customPatterns.invalidRegex');
  const labelHdr = t('settings.privacy.customPatterns.labelPlaceholder');
  return `
    <div class="pattern-card" data-pattern-id="${escapeHtml(p.id)}">
      <div class="pattern-row">
        <label>
          <span>${escapeHtml(t('settings.privacy.sandbox.rule'))}</span>
          <input type="text" data-bind="label" value="${escapeHtml(p.label)}" placeholder="${escapeHtml(labelPh)}" aria-label="${escapeHtml(labelHdr)}" />
        </label>
        <label>
          <span>Regex</span>
          <input type="text" data-bind="source" value="${escapeHtml(p.source)}" placeholder="${escapeHtml(regexPh)}" spellcheck="false" />
          ${compiles ? '' : `<span class="regex-error">${escapeHtml(invalid)}</span>`}
        </label>
      </div>
      <div class="pattern-row scopes">
        <label class="scope-check">
          <input type="checkbox" data-bind="scope-request" ${p.scope.includes('request.body') ? 'checked' : ''} />
          ${escapeHtml(t('settings.privacy.customPatterns.applyRequest'))}
        </label>
        <label class="scope-check">
          <input type="checkbox" data-bind="scope-response" ${p.scope.includes('response.body') ? 'checked' : ''} />
          ${escapeHtml(t('settings.privacy.customPatterns.applyResponse'))}
        </label>
        <button type="button" class="btn-remove" data-action="remove" data-idx="${idx}">${escapeHtml(t('common.remove'))}</button>
      </div>
    </div>
  `;
}

function bindPatternEditor(patternId: string, idx: number): void {
  // Defense in depth: patternId is currently always a crypto.randomUUID()
  // generated at "Add pattern" time, so this selector is safe by
  // construction today. Wrap in CSS.escape so a future import-settings
  // path or a manually edited chrome.storage entry can't break the
  // selector (or match an unintended sibling).
  const card = document.querySelector<HTMLElement>(`[data-pattern-id="${CSS.escape(patternId)}"]`);
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
    container.innerHTML = `<p class="empty-row">${escapeHtml(t('settings.privacy.origins.empty'))}</p>`;
    return;
  }
  container.innerHTML = privacyState.blocklistedOrigins
    .map((o, idx) => {
      const aria = t('settings.privacy.origins.removeAria', { origin: o });
      return `<span class="chip removable" data-origin="${escapeHtml(o)}">
          <code>${escapeHtml(o)}</code>
          <button type="button" data-idx="${idx}" aria-label="${escapeHtml(aria)}">✕</button>
        </span>`;
    })
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
    input.setCustomValidity(t('settings.privacy.origins.invalid'));
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
    label: t('settings.privacy.sandbox.defaultOption', { label: r.label }),
    rule: r,
  }));
  for (const p of privacyState.customPatterns) {
    const compiled = tryCompilePattern(p.source);
    if (!compiled) continue;
    const labelDisplay = p.label || t('settings.privacy.sandbox.customNoLabel');
    opts.push({
      key: `user.${p.id}`,
      label: t('settings.privacy.sandbox.customOption', { label: labelDisplay }),
      rule: {
        id: `user.${p.id}`,
        label: p.label || t('settings.privacy.sandbox.customFallback'),
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
    meta.textContent = t('settings.privacy.sandbox.scopeMismatch', {
      scope,
      ruleScope: chosen.rule.scope.join(', '),
    });
    return;
  }

  const result = maskBody(sample, scope, [chosen.rule]);
  output.textContent = result.body ?? '';
  meta.textContent =
    result.redactions.length === 0
      ? ''
      : result.redactions.length === 1
        ? t('settings.privacy.sandbox.matchesOne', { n: result.redactions.length })
        : t('settings.privacy.sandbox.matchesMany', { n: result.redactions.length });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let generalFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved(target: HTMLElement | null): void {
  if (!target) return;
  target.textContent = t('settings.status.saved');
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

  relabelBufferOptions();

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

  // Category defaults — the show/hide set a newly-opened side panel starts with.
  const categoryBoxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('#category-defaults input[data-category]')
  );
  const visible = new Set(current.visibleCategories);
  for (const box of categoryBoxes) {
    box.checked = visible.has(box.dataset.category as EventCategory);
    box.addEventListener('change', () => {
      const selected = categoryBoxes
        .filter((b) => b.checked)
        .map((b) => b.dataset.category as EventCategory)
        // Keep canonical order so storage stays stable.
        .filter((c) => EVENT_CATEGORIES.includes(c));
      void writeCaptureSettings({ visibleCategories: selected }).then(flashCapture);
    });
  }

  maxEvents.addEventListener('change', () => {
    const v = Number(maxEvents.value) as MaxEventsPerTab;
    void writeCaptureSettings({ maxEventsPerTab: v }).then(flashCapture);
  });
}

function relabelBufferOptions(): void {
  const opt = document.querySelector<HTMLOptionElement>('#max-events option[value="200"]');
  if (opt) opt.textContent = `200 ${t('settings.capture.buffer.defaultSuffix')}`;
}

// ---------------------------------------------------------------------------
// Sharing — webhook URLs (PRD §6.4 + §6.6.1)
// ---------------------------------------------------------------------------

async function initSharing(): Promise<void> {
  const slack = document.getElementById('slack-webhook');
  const discord = document.getElementById('discord-webhook');
  const teams = document.getElementById('teams-webhook');
  const githubOwner = document.getElementById('github-owner');
  const githubRepo = document.getElementById('github-repo');
  const emailTo = document.getElementById('email-to');
  if (
    !(slack instanceof HTMLInputElement) ||
    !(discord instanceof HTMLInputElement) ||
    !(teams instanceof HTMLInputElement) ||
    !(githubOwner instanceof HTMLInputElement) ||
    !(githubRepo instanceof HTMLInputElement) ||
    !(emailTo instanceof HTMLInputElement)
  ) {
    return;
  }

  const current = await readSharingSettings();
  slack.value = current.slackWebhook;
  discord.value = current.discordWebhook;
  teams.value = current.teamsWebhook;
  githubOwner.value = current.githubOwner;
  githubRepo.value = current.githubRepo;
  emailTo.value = current.emailTo;

  const wire = (input: HTMLInputElement, key: keyof SharingSettings): void => {
    const persist = debounce(() => {
      void writeSharingSettings({ [key]: input.value.trim() }).then(flashSharing);
    }, 350);
    input.addEventListener('input', persist);
    input.addEventListener('blur', persist);
  };
  wire(slack, 'slackWebhook');
  wire(discord, 'discordWebhook');
  wire(teams, 'teamsWebhook');
  wire(githubOwner, 'githubOwner');
  wire(githubRepo, 'githubRepo');
  wire(emailTo, 'emailTo');
}

let sharingFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSharing(): void {
  const target = document.getElementById('sharing-status');
  if (!target) return;
  target.textContent = t('settings.status.saved');
  if (sharingFlashTimer) clearTimeout(sharingFlashTimer);
  sharingFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
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
  target.textContent = t('settings.status.saved');
  if (detectionFlashTimer) clearTimeout(detectionFlashTimer);
  detectionFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

let captureFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCapture(): void {
  const target = document.getElementById('capture-status');
  if (!target) return;
  target.textContent = t('settings.status.saved');
  if (captureFlashTimer) clearTimeout(captureFlashTimer);
  captureFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

// ---------------------------------------------------------------------------
// Advanced — debug logging, perf threshold, storage stats, factory reset
// ---------------------------------------------------------------------------

async function initAdvanced(): Promise<void> {
  const debug = document.getElementById('debug-logging-toggle');
  const perfBudget = document.getElementById('perf-budget');
  const refreshBtn = document.getElementById('storage-refresh');
  const resetBtn = document.getElementById('reset-everything');
  if (
    !(debug instanceof HTMLInputElement) ||
    !(perfBudget instanceof HTMLInputElement) ||
    !(refreshBtn instanceof HTMLButtonElement) ||
    !(resetBtn instanceof HTMLButtonElement)
  ) {
    return;
  }

  const current = await readAdvancedSettings();
  debug.checked = current.debugLogging;
  perfBudget.value = String(current.perfBudgetMs);

  debug.addEventListener('change', () => {
    void writeAdvancedSettings({ debugLogging: debug.checked }).then(flashAdvanced);
  });
  perfBudget.addEventListener('change', () => {
    const v = Number(perfBudget.value);
    if (!Number.isFinite(v) || v <= 0) {
      perfBudget.value = String(current.perfBudgetMs);
      return;
    }
    void writeAdvancedSettings({ perfBudgetMs: v }).then(flashAdvanced);
  });

  refreshBtn.addEventListener('click', () => {
    void refreshStorageStats();
  });
  resetBtn.addEventListener('click', () => {
    void resetEverything();
  });

  await refreshStorageStats();
}

async function refreshStorageStats(): Promise<void> {
  const out = document.getElementById('storage-stats');
  if (!out) return;
  try {
    const local = await chrome.storage.local.getBytesInUse?.(null);
    const formatKb = (n: number | undefined): string =>
      n == null ? '—' : `${(n / 1024).toFixed(1)} KB`;
    out.textContent = `local: ${formatKb(local)}`;
  } catch (e) {
    out.textContent = t('settings.advanced.storage.error', {
      error: (e as Error).message ?? String(e),
    });
  }
}

async function resetEverything(): Promise<void> {
  const confirmed = confirm(t('settings.advanced.reset.confirm'));
  if (!confirmed) return;
  try {
    // Both areas cleared even though settings live on local now — old
    // installs may still have sync entries from before W14; sweep them.
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear().catch(() => {
      /* sync may be unavailable; not fatal */
    });
  } catch (e) {
    alert(t('settings.advanced.reset.failed', { error: (e as Error).message ?? String(e) }));
    return;
  }
  flashAdvanced();
  // Reload the page so every section reflects the reset defaults.
  window.location.reload();
}

let advancedFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashAdvanced(): void {
  const target = document.getElementById('advanced-status');
  if (!target) return;
  target.textContent = t('settings.status.saved');
  if (advancedFlashTimer) clearTimeout(advancedFlashTimer);
  advancedFlashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}

let privacyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashPrivacy(): void {
  const target = document.getElementById('privacy-status');
  if (!target) return;
  target.textContent = t('settings.status.saved');
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
