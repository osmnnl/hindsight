// User-facing settings — chrome.storage.local owner.
//
// Originally on chrome.storage.sync (cross-device, 102 KB quota) but
// switched to local because sync silently fails when the user's
// Chrome doesn't have profile sync turned on — write returns no
// error but nothing persists, so the W12 per-rule mask disable
// wasn't being honoured in the wild. Local has 5 MB quota, no rate
// limit, no profile dependency. The trade-off is settings no longer
// follow the user across devices — acceptable for a privacy-first
// tool where the user is configuring their local environment.
//
// Sections follow PRD §6.6.1 — General / Capture / Detection / Sharing /
// Privacy / Advanced. This module ships General + Privacy today; Capture
// / Detection / Sharing / Advanced sprouts as those UIs land.

import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/types';
import type { RuleScope } from '@/lib/masking';

// ---------------------------------------------------------------------------
// Schema — General
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark';

export interface GeneralSettings {
  theme: ThemePreference;
  /** UI language (PRD §14). 'en' or 'tr'. Settings UI override of the
   *  browser locale — see src/lib/i18n for runtime resolution.
   *  Stored at schemaVersion 1: read functions tolerate missing fields
   *  via DEFAULT_GENERAL_SETTINGS spread, so existing users get 'en'
   *  by default without a schema bump. */
  language: Locale;
  /** Schema version for this slice; bumped on breaking changes. */
  schemaVersion: number;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  theme: 'system',
  language: DEFAULT_LOCALE,
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Schema — Privacy (PRD §6.6.1 Privacy + §11.2)
// ---------------------------------------------------------------------------

/**
 * One user-defined body pattern. `source` is the raw regex source the
 * user typed in the Privacy settings sandbox; the masking engine
 * compiles it with the global flag via tryCompilePattern(). Patterns
 * that fail to compile are kept in storage so the user can fix them —
 * the engine just skips them.
 */
export interface CustomPatternSetting {
  id: string;
  label: string;
  source: string;
  scope: RuleScope[];
}

export interface PrivacySettings {
  customPatterns: CustomPatternSetting[];
  /** Origins (scheme + host + port) for which Hindsight never stores
   *  events. Match is exact string equality on the request page's
   *  origin — wildcard support is a later UI affordance. */
  blocklistedOrigins: string[];
  /** IDs of built-in masking rules (header / body / form) the user has
   *  explicitly opted out of. PRD §11.2 enforces capture-time masking,
   *  and disabled rules mean *future* captures will store the matched
   *  values verbatim — opt-in mechanism for dev workflows where the
   *  user genuinely wants to see Authorization tokens or TCKN values
   *  in their own bug reports. Already-captured masked values are
   *  unrecoverable; see masking.ts §masking-representation. */
  disabledDefaultRules: string[];
  schemaVersion: number;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  customPatterns: [],
  blocklistedOrigins: [],
  disabledDefaultRules: [],
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Schema — Capture (PRD §6.6.1 Capture)
// ---------------------------------------------------------------------------

/** Valid buffer-cap options surfaced in the dropdown. PRD §6.6.1 lists
 *  these four; the schema enforces the literal type so the UI and the
 *  storage layer can't disagree. */
export type MaxEventsPerTab = 50 | 200 | 500 | 2000;

export interface CaptureSettings {
  /** When false, the service worker drops Tier 2 events
   *  (network.websocket, console.warn / info, action.click / input).
   *  Tier 1 cannot be disabled per PRD §6.1.1. OQ-M2-J: turning this
   *  off only stops new captures — existing event buffers stay intact. */
  tier2Enabled: boolean;
  /** When false, the service worker drops Tier 3 performance events
   *  (performance.longtask, performance.cls). Screenshot-on-error
   *  stays on regardless — OQ-M3-J: screenshot is essential triage
   *  data, not a performance-observer artifact. */
  tier3Enabled: boolean;
  /** Per-tab rolling buffer cap. */
  maxEventsPerTab: MaxEventsPerTab;
  schemaVersion: number;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  tier2Enabled: true,
  tier3Enabled: true,
  maxEventsPerTab: 200,
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Schema — Detection (PRD §6.6.1 Detection + §6.2)
// ---------------------------------------------------------------------------

export type NotificationFrequency = 'first-per-session' | 'every';

export interface DetectionSettings {
  /** Master switch for the detection rule engine (PRD §6.6.1 "Smart
   *  detection on/off"). When false, detect() is skipped and no
   *  meta.flags / meta.cascadeOf gets stamped. */
  smartDetectionEnabled: boolean;
  /** When true, the service worker calls chrome.notifications.create
   *  on detection.cascade-head fires (PRD §6.2.2 "Desktop
   *  notifications"). Requires the `notifications` runtime permission;
   *  the toggle in the Settings UI requests it the first time it's
   *  enabled. */
  notificationsEnabled: boolean;
  /** PRD §6.2.2: "every" means fire on each detection event; the
   *  default "first-per-session" suppresses duplicates so a 20-failure
   *  cascade only notifies once. OQ-M3-G resolution. */
  notificationFrequency: NotificationFrequency;
  schemaVersion: number;
}

export const DEFAULT_DETECTION_SETTINGS: DetectionSettings = {
  smartDetectionEnabled: true,
  notificationsEnabled: false,
  notificationFrequency: 'first-per-session',
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Schema — Sharing (PRD §6.4 + §6.6.1)
// ---------------------------------------------------------------------------

/**
 * One webhook destination. URLs are kept verbatim — they're already
 * the user's secret to manage. M4·W13 wires the actual POST pipeline;
 * this schema lands now so the Settings UI can persist user input
 * during W12.
 */
export interface SharingSettings {
  slackWebhook: string;
  discordWebhook: string;
  teamsWebhook: string;
  /** GitHub web-intent destination — owner + repo prefill the
   *  `github.com/<owner>/<repo>/issues/new` URL. Optional; the
   *  "Send to GitHub" button is hidden when either is empty
   *  (OQ-M4-G resolution). */
  githubOwner: string;
  githubRepo: string;
  /** Default mailto: recipient. Empty = the user's mail client
   *  prompts for one. */
  emailTo: string;
  schemaVersion: number;
}

export const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  slackWebhook: '',
  discordWebhook: '',
  teamsWebhook: '',
  githubOwner: '',
  githubRepo: '',
  emailTo: '',
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// Schema — Advanced (PRD §15.3)
// ---------------------------------------------------------------------------

export interface AdvancedSettings {
  /** When true, the service worker emits verbose console logs for
   *  every captured event. Off by default — keeps the SW console
   *  clean for normal use; engineers debugging Hindsight itself flip
   *  this on. */
  debugLogging: boolean;
  /** Perf-budget warning threshold in milliseconds. PRD §13.1 hard
   *  ceiling is 0.5 ms (CI bench-gate). Users on low-end hardware or
   *  with bursty traffic may want a higher threshold before in-app
   *  warnings fire. The CI gate is independent — this only affects
   *  user-visible nudges in the side panel. */
  perfBudgetMs: number;
  schemaVersion: number;
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  debugLogging: false,
  perfBudgetMs: 0.5,
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

export const SettingsKeys = {
  general: 'settings/general',
  capture: 'settings/capture',
  detection: 'settings/detection',
  sharing: 'settings/sharing',
  privacy: 'settings/privacy',
  advanced: 'settings/advanced',
} as const;

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export async function readGeneralSettings(): Promise<GeneralSettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.general);
  const value = stored[SettingsKeys.general] as Partial<GeneralSettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_GENERAL_SETTINGS };
  }
  return { ...DEFAULT_GENERAL_SETTINGS, ...value };
}

export async function writeGeneralSettings(patch: Partial<GeneralSettings>): Promise<void> {
  const current = await readGeneralSettings();
  const next: GeneralSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.general]: next });
}

export async function readPrivacySettings(): Promise<PrivacySettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.privacy);
  const value = stored[SettingsKeys.privacy] as Partial<PrivacySettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }
  return {
    ...DEFAULT_PRIVACY_SETTINGS,
    ...value,
    customPatterns: Array.isArray(value.customPatterns) ? value.customPatterns : [],
    blocklistedOrigins: Array.isArray(value.blocklistedOrigins) ? value.blocklistedOrigins : [],
    disabledDefaultRules: Array.isArray(value.disabledDefaultRules)
      ? value.disabledDefaultRules
      : [],
  };
}

export async function writePrivacySettings(patch: Partial<PrivacySettings>): Promise<void> {
  const current = await readPrivacySettings();
  const next: PrivacySettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.privacy]: next });
}

export async function readCaptureSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.capture);
  const value = stored[SettingsKeys.capture] as Partial<CaptureSettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_CAPTURE_SETTINGS };
  }
  return { ...DEFAULT_CAPTURE_SETTINGS, ...value };
}

export async function writeCaptureSettings(patch: Partial<CaptureSettings>): Promise<void> {
  const current = await readCaptureSettings();
  const next: CaptureSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.capture]: next });
}

export async function readDetectionSettings(): Promise<DetectionSettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.detection);
  const value = stored[SettingsKeys.detection] as Partial<DetectionSettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_DETECTION_SETTINGS };
  }
  return { ...DEFAULT_DETECTION_SETTINGS, ...value };
}

export async function writeDetectionSettings(patch: Partial<DetectionSettings>): Promise<void> {
  const current = await readDetectionSettings();
  const next: DetectionSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.detection]: next });
}

export async function readSharingSettings(): Promise<SharingSettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.sharing);
  const value = stored[SettingsKeys.sharing] as Partial<SharingSettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_SHARING_SETTINGS };
  }
  return { ...DEFAULT_SHARING_SETTINGS, ...value };
}

export async function writeSharingSettings(patch: Partial<SharingSettings>): Promise<void> {
  const current = await readSharingSettings();
  const next: SharingSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.sharing]: next });
}

export async function readAdvancedSettings(): Promise<AdvancedSettings> {
  const stored = await chrome.storage.local.get(SettingsKeys.advanced);
  const value = stored[SettingsKeys.advanced] as Partial<AdvancedSettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_ADVANCED_SETTINGS };
  }
  return { ...DEFAULT_ADVANCED_SETTINGS, ...value };
}

export async function writeAdvancedSettings(patch: Partial<AdvancedSettings>): Promise<void> {
  const current = await readAdvancedSettings();
  const next: AdvancedSettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set({ [SettingsKeys.advanced]: next });
}
