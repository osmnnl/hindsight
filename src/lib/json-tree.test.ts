// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { buildJsonTree } from './json-tree';

describe('buildJsonTree', () => {
  it('renders an object with keys and values', () => {
    const root = buildJsonTree({ a: 1, b: 'hi' });
    expect(root.classList.contains('json-tree')).toBe(true);
    const keys = [...root.querySelectorAll('.jt-key')].map((e) => e.textContent);
    expect(keys).toContain('a');
    expect(keys).toContain('b');
    // String values are quoted; numbers are not.
    const values = [...root.querySelectorAll('.jt-value')].map((e) => e.textContent);
    expect(values).toContain('1');
    expect(values).toContain('"hi"');
  });

  it('marks objects/arrays as branches and primitives as leaves', () => {
    const root = buildJsonTree({ nested: { x: 1 }, list: [1, 2] });
    const branches = root.querySelectorAll('.jt-branch');
    // root object + nested object + list array = 3 branches
    expect(branches.length).toBe(3);
  });

  it('auto-expands to defaultExpandDepth and collapses deeper', () => {
    const root = buildJsonTree({ a: { b: { c: 1 } } }, { defaultExpandDepth: 1 });
    // The root node (depth 0) is expanded; the depth-1 child object collapsed.
    const nodes = root.querySelectorAll('.jt-branch');
    const collapsed = root.querySelectorAll('.jt-branch.jt-collapsed');
    expect(nodes.length).toBeGreaterThan(collapsed.length);
    expect(collapsed.length).toBeGreaterThan(0);
  });

  it('toggles collapse on row click', () => {
    const root = buildJsonTree({ a: { b: 1 } }, { defaultExpandDepth: 5 });
    const branch = root.querySelector('.jt-branch') as HTMLElement;
    const row = branch.querySelector('.jt-row') as HTMLElement;
    expect(branch.classList.contains('jt-collapsed')).toBe(false);
    row.click();
    expect(branch.classList.contains('jt-collapsed')).toBe(true);
    row.click();
    expect(branch.classList.contains('jt-collapsed')).toBe(false);
  });

  it('caps children with a "… N more" stub', () => {
    const big = Array.from({ length: 50 }, (_, i) => i);
    const root = buildJsonTree(big, { maxChildren: 10, defaultExpandDepth: 5 });
    const more = root.querySelector('.jt-more');
    expect(more?.textContent).toBe('… 40 more');
  });

  it('renders a bare primitive as a single leaf', () => {
    const root = buildJsonTree('just text');
    expect(root.querySelector('.jt-branch')).toBeNull();
    expect(root.querySelector('.jt-value')?.textContent).toBe('"just text"');
  });

  it('escapes nothing via innerHTML — uses textContent (no HTML injection)', () => {
    const root = buildJsonTree({ evil: '<img src=x onerror=alert(1)>' });
    expect(root.querySelector('img')).toBeNull();
    const val = root.querySelector('.jt-value')?.textContent;
    expect(val).toContain('<img src=x onerror=alert(1)>');
  });
});
