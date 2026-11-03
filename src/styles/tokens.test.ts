// WCAG AA guard for the shared design tokens (1.0 workstream C2): every
// text/background pair the UI paints must reach 4.5:1 in both themes, and
// no stylesheet may use a gradient.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const dark = block(':root {');
const light = block(":root[data-theme='light']");

const FOREGROUNDS = ['text', 'muted', 'accent', 'danger', 'success', 'warn'];
const SURFACES = ['bg', 'surface', 'surface-2'];
const PAIRS: Array<[string, string]> = [
  ...FOREGROUNDS.flatMap((fg) => SURFACES.map((bg): [string, string] => [fg, bg])),
  ['accent-text', 'accent'],
  ['accent', 'accent-soft'],
  ['text', 'accent-soft'],
  ['danger', 'danger-soft'],
  ['text', 'danger-soft'],
  ['success', 'success-soft'],
  ['warn', 'warn-soft'],
];

describe('design tokens', () => {
  for (const [name, theme] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    it(`${name}: every text pair is ≥ 4.5:1`, () => {
      const failing = PAIRS.filter(([fg, bg]) => contrast(theme[fg]!, theme[bg]!) < 4.5).map(
        ([fg, bg]) => `${fg}/${bg} ${contrast(theme[fg]!, theme[bg]!).toFixed(2)}`
      );
      expect(failing).toEqual([]);
    });
  }

  it('the prefers-color-scheme light block matches the explicit light theme', () => {
    expect(block(":root:not([data-theme='dark'])")).toEqual(light);
  });

  it('no stylesheet under src uses a gradient', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(css|html)$/.test(f) && /gradient\(/i.test(readFileSync(p, 'utf8')))
          hits.push(p);
      }
    };
    walk(join(__dirname, '..'));
    expect(hits).toEqual([]);
  });
});
