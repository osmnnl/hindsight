// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildTargetDescriptor } from './dom-descriptor';

function nameOf(html: string, selector: string): string | undefined {
  document.body.innerHTML = html;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return buildTargetDescriptor(el, { rect: false }).accessibleName;
}

describe('accessible name for form controls', () => {
  it('uses <label for>', () => {
    expect(nameOf('<label for="e">Work email</label><input id="e" name="em">', 'input')).toBe(
      'Work email'
    );
  });

  it('uses a wrapping label without the nested control text', () => {
    expect(
      nameOf(
        '<label>Country <select><option>Spain</option><option>Peru</option></select></label>',
        'select'
      )
    ).toBe('Country');
  });

  it('prefers aria-label over the label', () => {
    expect(nameOf('<label for="q">Q</label><input id="q" aria-label="Search">', 'input')).toBe(
      'Search'
    );
  });

  it('falls back to placeholder, then name', () => {
    expect(nameOf('<input placeholder="Your city" name="city">', 'input')).toBe('Your city');
    expect(nameOf('<input name="zip">', 'input')).toBe('zip');
  });

  it('never uses a select’s option text', () => {
    expect(
      nameOf('<select><option>A</option><option>B</option></select>', 'select')
    ).toBeUndefined();
  });
});
