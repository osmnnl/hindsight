// Theme application — single owner for the Settings → General theme
// preference (PRD §6.6.1 General). Each surface (popup, side panel,
// settings page) calls applyTheme() on init and listenForThemeChanges()
// to stay in sync with chrome.storage.sync edits.
//
// CSS uses :root[data-theme='light'] / :root[data-theme='dark']
// selectors layered on top of prefers-color-scheme; theme === 'system'
// leaves data-theme unset so the media query takes over.

import { readGeneralSettings, SettingsKeys } from './settings';

export async function applyTheme(): Promise<void> {
  const { theme } = await readGeneralSettings();
  const root = document.documentElement;
  if (theme === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = theme;
  }
}

export function listenForThemeChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && SettingsKeys.general in changes) {
      void applyTheme();
    }
  });
}
