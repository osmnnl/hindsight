// First-run welcome page (PRD §7.1). Opened once by the service worker
// on install; fully local, no network. Copy lives here rather than in
// the shared catalog because no other surface reuses it.

import { SettingsKeys } from '@/lib/settings';
import { applyTheme } from '@/lib/theme';

declare const __APP_VERSION__: string;

type Copy = Record<string, string>;

const EN: Copy = {
  eyebrow: 'Installed · v{v}',
  title: 'Hindsight is recording.',
  lead: 'It keeps a rolling record of each tab in the background, so when something breaks the evidence is already there.',
  's1.title': 'Pin it and browse normally',
  's1.body':
    'Open the puzzle-piece menu in the toolbar and pin Hindsight. The badge counts failed requests on the current tab.',
  's2.title': 'When something breaks, scrub back',
  's2.body':
    'Open the side panel to see every request, console error and click in order, with full headers and bodies.',
  's3.title': 'Share one file',
  's3.body':
    'Save the session as a single HTML replay file that opens in any browser, or send it to Slack, Teams, Discord or a GitHub issue.',
  'keys.title': 'Keyboard shortcuts',
  'keys.hint': 'Change them at',
  'keys.unset': 'Set in chrome://extensions/shortcuts',
  'privacy.title': 'What stays private',
  'privacy.1': 'Everything is stored on this computer. Hindsight has no server.',
  'privacy.2': 'Authorization, Cookie and API-key headers are masked before anything is written.',
  'privacy.3': 'Password fields and card numbers are never stored.',
  'privacy.4': 'Nothing is sent anywhere unless you press Send or Save.',
  'actions.settings': 'Open settings',
  'actions.close': 'Start browsing',
  'cmd.open-side-panel': 'Open the side panel',
  'cmd.capture-last-moment': 'Capture last moment',
  'cmd.toggle-recording': 'Start or stop recording mode',
};

const TR: Copy = {
  eyebrow: 'Kuruldu · v{v}',
  title: 'Hindsight kayıtta.',
  lead: 'Her sekmenin son olaylarını arka planda tutar; bir şey bozulduğunda kanıt zaten elinizde olur.',
  's1.title': 'Sabitleyin ve normal gezinin',
  's1.body':
    'Araç çubuğundaki yapboz menüsünden Hindsight’ı sabitleyin. Rozet, açık sekmedeki başarısız istekleri sayar.',
  's2.title': 'Bir şey bozulunca geri sarın',
  's2.body':
    'Yan panelde her istek, konsol hatası ve tıklama sırasıyla, başlıkları ve gövdeleriyle birlikte görünür.',
  's3.title': 'Tek dosya paylaşın',
  's3.body':
    'Oturumu her tarayıcıda açılan tek bir HTML kayıt dosyası olarak kaydedin ya da Slack, Teams, Discord veya GitHub issue’ya gönderin.',
  'keys.title': 'Klavye kısayolları',
  'keys.hint': 'Değiştirmek için:',
  'keys.unset': 'chrome://extensions/shortcuts adresinden atayın',
  'privacy.title': 'Ne gizli kalır',
  'privacy.1': 'Her şey bu bilgisayarda saklanır. Hindsight’ın sunucusu yoktur.',
  'privacy.2': 'Authorization, Cookie ve API anahtarı başlıkları kaydedilmeden önce maskelenir.',
  'privacy.3': 'Parola alanları ve kart numaraları hiç saklanmaz.',
  'privacy.4': 'Siz Gönder ya da Kaydet’e basmadıkça hiçbir şey hiçbir yere gitmez.',
  'actions.settings': 'Ayarları aç',
  'actions.close': 'Gezinmeye başla',
  'cmd.open-side-panel': 'Yan paneli aç',
  'cmd.capture-last-moment': 'Son anı yakala',
  'cmd.toggle-recording': 'Kayıt modunu başlat / durdur',
};

async function pickCopy(): Promise<{ copy: Copy; lang: string }> {
  // Same locale as the rest of the UI (initI18n): the Settings choice, else EN.
  let lang = 'en';
  try {
    const stored = await chrome.storage.local.get(SettingsKeys.general);
    const language = (stored[SettingsKeys.general] as { language?: unknown } | undefined)?.language;
    if (language === 'tr') lang = 'tr';
  } catch {
    /* fresh profile: EN */
  }
  return { copy: lang === 'tr' ? TR : EN, lang };
}

async function renderShortcuts(copy: Copy): Promise<void> {
  const body = document.getElementById('shortcuts');
  if (!body) return;
  const commands = await chrome.commands.getAll();
  for (const cmd of commands) {
    const label = cmd.name ? copy[`cmd.${cmd.name}`] : undefined;
    if (!label) continue;
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = label;
    const keys = document.createElement('td');
    if (cmd.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = cmd.shortcut;
      keys.append(kbd);
    } else {
      keys.textContent = copy['keys.unset'] ?? '';
    }
    row.append(name, keys);
    body.append(row);
  }
}

async function init(): Promise<void> {
  await applyTheme();
  const { copy, lang } = await pickCopy();
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => {
    const text = copy[el.dataset.w ?? ''];
    if (text) el.textContent = text.replace('{v}', __APP_VERSION__);
  });
  document.title = lang === 'tr' ? 'Hindsight’a hoş geldiniz' : 'Welcome to Hindsight';
  await renderShortcuts(copy);

  document.getElementById('open-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('close')?.addEventListener('click', () => {
    window.close();
  });
}

void init();
