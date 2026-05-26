// PRD §14 — UI locale type. v1 ships English (default) and Turkish;
// other locales accepted as community PRs and added by extending the
// MESSAGES tables in ./messages.ts.

export type Locale = 'en' | 'tr';

export const DEFAULT_LOCALE: Locale = 'en';

export const AVAILABLE_LOCALES: readonly Locale[] = ['en', 'tr'] as const;

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'tr';
}
