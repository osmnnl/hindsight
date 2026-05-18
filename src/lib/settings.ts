// User-facing settings — chrome.storage.sync owner (PRD §6.6.2).
//
// Settings are tiny and stable, so they live on chrome.storage.sync
// (102 KB quota, synced across the user's Chrome profiles per the same
// Google account — encrypted in transit; Hindsight has no server). They
// are intentionally not co-located with the per-tab capture buffer,
// which is large and stays on chrome.storage.local.
//
// Sections follow PRD §6.6.1 — General / Capture / Detection / Sharing /
// Privacy / Advanced. This module ships the schema and the General
// section today; later sprints fill in the others as their UIs land.

// ---------------------------------------------------------------------------
// Schema
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
