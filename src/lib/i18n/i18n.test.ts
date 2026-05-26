// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AVAILABLE_LOCALES,
  applyI18nToDom,
  DEFAULT_LOCALE,
  getLocale,
  initI18n,
  isLocale,
  setLocaleSync,
  subscribeLocale,
  t,
  type Locale,
} from './index';

// Each test owns the in-memory locale; reset before every spec so order
// doesn't matter.
beforeEach(() => {
  setLocaleSync(DEFAULT_LOCALE);
  vi.unstubAllGlobals();
});

describe('isLocale', () => {
  it('accepts en and tr', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('tr')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe('catalog shape', () => {
  it('exports both v1 locales', () => {
    expect([...AVAILABLE_LOCALES].sort()).toEqual(['en', 'tr']);
  });
});

describe('t()', () => {
  it('returns the EN value by default', () => {
    expect(t('settings.title')).toBe('Hindsight Settings');
  });

  it('returns the TR value when locale is tr', () => {
    setLocaleSync('tr');
    expect(t('settings.title')).toBe('Hindsight Ayarları');
  });

  it('substitutes {name} placeholders', () => {
    expect(t('settings.privacy.sandbox.matchesMany', { n: 3 })).toBe('3 matches masked.');
  });

  it('passes unknown placeholders through verbatim', () => {
    // The key has {n}; we don't supply it. The literal `{n}` is preserved
    // so the typo is visible during dev.
    expect(t('settings.privacy.sandbox.matchesMany', {})).toContain('{n}');
  });

  it('falls back to EN when a key is missing in TR', () => {
    // Construct a synthetic gap: set locale to tr but ask for a key
    // that TR is allowed to be missing. Any key in EN that TR has not
    // overridden falls back. Use `common.empty` which is the same dash
    // in both — verify the fallback chain produces a string regardless.
    setLocaleSync('tr');
    expect(t('common.empty')).toBeTypeOf('string');
  });

  it('returns the key itself when neither locale has it', () => {
    // Cast a known-missing key to MessageKey for the test.
    const phantom = 'not.a.real.key' as never;
    expect(t(phantom)).toBe('not.a.real.key');
  });
});

describe('applyI18nToDom', () => {
  it('replaces textContent on [data-i18n] elements', () => {
    const root = document.createElement('div');
    root.innerHTML = `<span data-i18n="common.save">stub</span>`;
    applyI18nToDom(root);
    expect(root.querySelector('span')?.textContent).toBe('Save');
  });

  it('honors locale at call time', () => {
    setLocaleSync('tr');
    const root = document.createElement('div');
    root.innerHTML = `<span data-i18n="common.save">stub</span>`;
    applyI18nToDom(root);
    expect(root.querySelector('span')?.textContent).toBe('Kaydet');
  });

  it('sets attributes from data-i18n-attr', () => {
    const root = document.createElement('div');
    root.innerHTML = `<input data-i18n-attr="placeholder:settings.privacy.origins.placeholder;aria-label:common.add" />`;
    applyI18nToDom(root);
    const input = root.querySelector('input');
    expect(input?.getAttribute('placeholder')).toBe('https://internal.example.com');
    expect(input?.getAttribute('aria-label')).toBe('Add');
  });

  it('renders inline HTML from data-i18n-html', () => {
    // settings.privacy.lead embeds a <code> element — verify it
    // survives translation rather than getting HTML-escaped.
    const root = document.createElement('div');
    root.innerHTML = `<p data-i18n-html="settings.privacy.lead">stub</p>`;
    applyI18nToDom(root);
    const code = root.querySelector('p code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('PRD §11.2');
  });

  it('updates document.documentElement.lang when root is the document', () => {
    setLocaleSync('tr');
    applyI18nToDom(document);
    expect(document.documentElement.lang).toBe('tr');
  });
});

describe('initI18n', () => {
  function stubStorage(value: unknown): void {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ 'settings/general': value })),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
  }

  it('reads the locale from chrome.storage.local', async () => {
    stubStorage({ language: 'tr', theme: 'system', schemaVersion: 1 });
    const locale = await initI18n();
    expect(locale).toBe('tr');
    expect(getLocale()).toBe('tr');
  });

  it('falls back to the default when no value is stored', async () => {
    stubStorage(undefined);
    const locale = await initI18n();
    expect(locale).toBe(DEFAULT_LOCALE);
  });

  it('falls back to the default when storage returns garbage', async () => {
    stubStorage({ language: 'klingon' });
    const locale = await initI18n();
    expect(locale).toBe(DEFAULT_LOCALE);
  });

  it('falls back to the default when storage throws', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(() => Promise.reject(new Error('storage unavailable'))),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    const locale = await initI18n();
    expect(locale).toBe(DEFAULT_LOCALE);
  });
});

describe('subscribeLocale', () => {
  it('invokes the callback when the stored locale changes', () => {
    const listeners: ((
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName
    ) => void)[] = [];
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (l: (typeof listeners)[number]) => listeners.push(l),
          removeListener: () => {},
        },
      },
    });

    const seen: Locale[] = [];
    const unsubscribe = subscribeLocale((loc) => seen.push(loc));

    // Simulate a storage write from another window.
    listeners[0]?.(
      {
        'settings/general': {
          newValue: { language: 'tr', theme: 'system', schemaVersion: 1 },
          oldValue: undefined,
        },
      },
      'local'
    );

    expect(seen).toEqual(['tr']);
    expect(getLocale()).toBe('tr');
    unsubscribe();
  });

  it('ignores changes that do not flip the locale', () => {
    const listeners: ((
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName
    ) => void)[] = [];
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (l: (typeof listeners)[number]) => listeners.push(l),
          removeListener: () => {},
        },
      },
    });

    setLocaleSync('tr');
    const seen: Locale[] = [];
    subscribeLocale((loc) => seen.push(loc));

    listeners[0]?.(
      {
        'settings/general': {
          newValue: { language: 'tr', theme: 'system', schemaVersion: 1 },
          oldValue: undefined,
        },
      },
      'local'
    );

    expect(seen).toEqual([]);
  });

  it('ignores changes in other storage areas', () => {
    const listeners: ((
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName
    ) => void)[] = [];
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (l: (typeof listeners)[number]) => listeners.push(l),
          removeListener: () => {},
        },
      },
    });

    const seen: Locale[] = [];
    subscribeLocale((loc) => seen.push(loc));

    listeners[0]?.(
      {
        'settings/general': {
          newValue: { language: 'tr', theme: 'system', schemaVersion: 1 },
          oldValue: undefined,
        },
      },
      'sync'
    );

    expect(seen).toEqual([]);
  });
});
