// PRD §14 — runtime i18n helpers.
//
// EN is the canonical source. The picker priority is:
//   1. Locale set in GeneralSettings.language (chrome.storage.local)
//   2. DEFAULT_LOCALE ('en') — PRD §14 user override, not browser locale.
//
// Service workers, popup, side panel and settings each call initI18n()
// at entrypoint and then drive the DOM with applyI18nToDom() +
// subscribe to live language switches via subscribeLocale().

import { MESSAGES, type MessageKey } from './messages';
import { DEFAULT_LOCALE, isLocale, type Locale } from './types';

export { AVAILABLE_LOCALES, DEFAULT_LOCALE, isLocale } from './types';
export type { Locale } from './types';
export type { MessageKey } from './messages';

const GENERAL_KEY = 'settings/general';

let currentLocale: Locale = DEFAULT_LOCALE;

/** Current in-memory locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Read the user's chosen locale from chrome.storage.local. Falls back
 * to DEFAULT_LOCALE on any failure (storage error, missing key, invalid
 * value). Safe to call multiple times.
 */
export async function initI18n(): Promise<Locale> {
  try {
    const stored = await chrome.storage.local.get(GENERAL_KEY);
    const value = stored[GENERAL_KEY] as { language?: unknown } | undefined;
    if (value && isLocale(value.language)) {
      currentLocale = value.language;
      return currentLocale;
    }
  } catch {
    // storage unavailable (test env, fresh install) — fall through
  }
  currentLocale = DEFAULT_LOCALE;
  return currentLocale;
}

/**
 * In-memory override used by tests and by subscribers reacting to a
 * storage change. Does not persist on its own — call
 * writeGeneralSettings({ language }) to persist.
 */
export function setLocaleSync(locale: Locale): void {
  currentLocale = locale;
}

/**
 * Translate a key. Variable substitution uses literal `{name}` tokens.
 * Lookup order: current locale → EN → key. Unknown placeholders pass
 * through verbatim so a typo in the call site is visible during dev.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const localized = MESSAGES[currentLocale]?.[key];
  const fallback = MESSAGES[DEFAULT_LOCALE]?.[key];
  const msg = localized ?? fallback ?? key;
  if (!vars) return msg;
  return msg.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined ? match : String(v);
  });
}

/**
 * Walks the DOM under `root` and applies translations.
 *
 *   <span data-i18n="settings.title">Hindsight Settings</span>
 *   <input data-i18n-attr="placeholder:settings.search.placeholder" />
 *
 * `data-i18n` replaces textContent (overwriting whatever stub was in
 * the HTML so view-source still reads as English).
 *
 * `data-i18n-attr` takes one or more `attr:key` pairs separated by `;`,
 * e.g. `placeholder:foo;title:bar;aria-label:baz`.
 */
export function applyI18nToDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key as MessageKey);
  });
  // `data-i18n-html` opts into innerHTML so inline `<code>`, `<strong>`
  // and `<em>` survive translation. Only safe because translation
  // strings are author-controlled at build time — never user input.
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (key) el.innerHTML = t(key as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    spec.split(';').forEach((pair) => {
      const [rawAttr, rawKey] = pair.split(':');
      const attr = rawAttr?.trim();
      const key = rawKey?.trim();
      if (attr && key) el.setAttribute(attr, t(key as MessageKey));
    });
  });
  // `<html lang>` keeps assistive tech in sync with the user's choice.
  // Duck-type the document rather than `instanceof Document` so we work
  // in happy-dom test runs where the class identity differs from this
  // module's compile-time reference.
  if ('documentElement' in root && (root as Document).documentElement) {
    (root as Document).documentElement.lang = currentLocale;
  }
}

/**
 * Subscribe to live language changes via chrome.storage.onChanged.
 * Returns an unsubscribe function. The callback runs only when the
 * locale actually changes value.
 */
export function subscribeLocale(onChange: (locale: Locale) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName
  ): void => {
    if (area !== 'local') return;
    const change = changes[GENERAL_KEY];
    if (!change) return;
    const newVal = change.newValue as { language?: unknown } | undefined;
    if (newVal && isLocale(newVal.language) && newVal.language !== currentLocale) {
      currentLocale = newVal.language;
      onChange(currentLocale);
    }
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
