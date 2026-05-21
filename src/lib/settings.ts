// User-facing settings — chrome.storage.sync owner (PRD §6.6.2).
//
// Settings are tiny and stable, so they live on chrome.storage.sync
// (102 KB quota, synced across the user's Chrome profiles per the same
// Google account — encrypted in transit; Hindsight has no server). They
// are intentionally not co-located with the per-tab capture buffer,
// which is large and stays on chrome.storage.local.
//
// Sections follow PRD §6.6.1 — General / Capture / Detection / Sharing /
// Privacy / Advanced. This module ships General + Privacy today; Capture
// / Detection / Sharing / Advanced sprouts as those UIs land.

import type { RuleScope } from '@/lib/masking';

// ---------------------------------------------------------------------------
// Schema — General
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'light' | 'dark';

export interface GeneralSettings {
  theme: ThemePreference;
  /** Schema version for this slice; bumped on breaking changes. */
  schemaVersion: number;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  theme: 'system',
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
  schemaVersion: number;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  customPatterns: [],
  blocklistedOrigins: [],
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
  /** Per-tab rolling buffer cap. */
  maxEventsPerTab: MaxEventsPerTab;
  schemaVersion: number;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  tier2Enabled: true,
  maxEventsPerTab: 200,
  schemaVersion: SETTINGS_SCHEMA_VERSION,
};

export const SettingsKeys = {
  general: 'settings/general',
  capture: 'settings/capture',
  detection: 'settings/detection',
  sharing: 'settings/sharing',
  privacy: 'settings/privacy',
} as const;

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export async function readGeneralSettings(): Promise<GeneralSettings> {
  const stored = await chrome.storage.sync.get(SettingsKeys.general);
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
  await chrome.storage.sync.set({ [SettingsKeys.general]: next });
}

export async function readPrivacySettings(): Promise<PrivacySettings> {
  const stored = await chrome.storage.sync.get(SettingsKeys.privacy);
  const value = stored[SettingsKeys.privacy] as Partial<PrivacySettings> | undefined;
  if (!value || value.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { ...DEFAULT_PRIVACY_SETTINGS };
  }
  return {
    ...DEFAULT_PRIVACY_SETTINGS,
    ...value,
    customPatterns: Array.isArray(value.customPatterns) ? value.customPatterns : [],
    blocklistedOrigins: Array.isArray(value.blocklistedOrigins) ? value.blocklistedOrigins : [],
  };
}

export async function writePrivacySettings(patch: Partial<PrivacySettings>): Promise<void> {
  const current = await readPrivacySettings();
  const next: PrivacySettings = {
    ...current,
    ...patch,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.sync.set({ [SettingsKeys.privacy]: next });
}

export async function readCaptureSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.sync.get(SettingsKeys.capture);
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
  await chrome.storage.sync.set({ [SettingsKeys.capture]: next });
}
