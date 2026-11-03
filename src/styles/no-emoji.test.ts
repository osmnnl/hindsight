// 1.0 C5: UI chrome uses inline SVG (lib/icons.ts), never emoji — emoji
// render differently per platform and screen readers announce them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILES = [
  'popup/popup.html',
  'popup/popup.ts',
  'sidepanel/sidepanel.html',
  'sidepanel/sidepanel.ts',
  'settings/settings.html',
  'settings/settings.ts',
  'lib/i18n/messages.ts',
];
// ↔ (U+2194) is Extended_Pictographic but reads as plain typography.
const EMOJI = /(?!↔)\p{Extended_Pictographic}/gu;

describe('no emoji in UI sources', () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src.match(EMOJI) ?? []).toEqual([]);
    });
  }
});
