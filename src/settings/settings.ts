// Settings page — General section.
//
// Loads current values from chrome.storage.sync, persists on change,
// and renders a transient confirmation. Other sections (Capture,
// Detection, Sharing, Privacy, Advanced) are placeholder tabs until
// their respective sprints land — see PRD §6.6.1.

import { readGeneralSettings, writeGeneralSettings, type ThemePreference } from '@/lib/settings';

const SAVE_FLASH_MS = 1400;

void init();

async function init(): Promise<void> {
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

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function flashSaved(target: HTMLElement | null): void {
  if (!target) return;
  target.textContent = '✓ Saved';
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    target.textContent = '';
  }, SAVE_FLASH_MS);
}
