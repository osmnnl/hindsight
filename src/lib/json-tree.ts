// Interactive collapsible JSON tree — the side panel's detail view renders
// request/response bodies and header maps as an expandable tree (à la
// DevTools "Preview") instead of a flat <pre> blob.
//
// Vanilla DOM, CSP-safe: nodes are built with createElement and text goes
// through textContent (never innerHTML), so no escaping and no inline
// handlers. Expand/collapse is one delegated click listener on the root.
//
// Tests: json-tree.test.ts.

export interface JsonTreeOptions {
  /** Levels auto-expanded on first render; deeper nodes start collapsed.
   *  Default 1 (root's immediate children visible). */
  defaultExpandDepth?: number;
  /** Max children rendered per object/array before a "… N more" stub.
   *  Guards against a 10k-element array building 10k DOM nodes. */
  maxChildren?: number;
}

type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function kindOf(v: unknown): JsonKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'object') return 'object';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

/** Short one-line preview shown next to a collapsed object/array. */
function previewOf(v: unknown): string {
  if (Array.isArray(v)) return `Array(${v.length})`;
  const keys = Object.keys(v as Record<string, unknown>);
  return keys.length === 0 ? '{}' : `{ ${keys.length} ${keys.length === 1 ? 'key' : 'keys'} }`;
}

function leafText(v: unknown, kind: JsonKind): string {
  if (kind === 'string') return JSON.stringify(v); // quoted + escaped
  if (kind === 'null') return 'null';
  return String(v);
}

/**
 * Build the tree for `value`. Returns a root <div class="json-tree"> with a
 * delegated toggle listener already attached. If `value` is a primitive the
 * tree is just a single leaf row.
 */
export function buildJsonTree(value: unknown, opts: JsonTreeOptions = {}): HTMLElement {
  const expandDepth = opts.defaultExpandDepth ?? 1;
  const maxChildren = opts.maxChildren ?? 1000;
  const root = document.createElement('div');
  root.className = 'json-tree';
  root.appendChild(buildNode(value, undefined, 0, expandDepth, maxChildren));

  // One delegated listener: a click on a toggle (or its row) flips the
  // nearest node's collapsed state.
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const row = target.closest('.jt-row');
    if (!row || !root.contains(row)) return;
    const node = row.parentElement;
    if (node?.classList.contains('jt-branch')) {
      node.classList.toggle('jt-collapsed');
    }
  });

  return root;
}

function buildNode(
  value: unknown,
  key: string | undefined,
  depth: number,
  expandDepth: number,
  maxChildren: number
): HTMLElement {
  const kind = kindOf(value);
  const node = document.createElement('div');
  node.className = 'jt-node';

  const row = document.createElement('div');
  row.className = 'jt-row';
  node.appendChild(row);

  const isBranch = kind === 'object' || kind === 'array';

  if (isBranch) {
    node.classList.add('jt-branch');
    if (depth >= expandDepth) node.classList.add('jt-collapsed');

    const toggle = document.createElement('span');
    toggle.className = 'jt-toggle';
    toggle.setAttribute('aria-hidden', 'true');
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'jt-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    row.appendChild(spacer);
  }

  if (key !== undefined) {
    const keyEl = document.createElement('span');
    keyEl.className = 'jt-key';
    keyEl.textContent = key;
    row.appendChild(keyEl);
    const colon = document.createElement('span');
    colon.className = 'jt-colon';
    colon.textContent = ': ';
    row.appendChild(colon);
  }

  if (isBranch) {
    // Collapsed preview (shown via CSS only when .jt-collapsed).
    const preview = document.createElement('span');
    preview.className = 'jt-preview';
    preview.textContent = previewOf(value);
    row.appendChild(preview);

    const children = document.createElement('div');
    children.className = 'jt-children';

    const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value as Record<string, unknown>);

    const shown = entries.slice(0, maxChildren);
    for (const [childKey, childVal] of shown) {
      children.appendChild(buildNode(childVal, childKey, depth + 1, expandDepth, maxChildren));
    }
    if (entries.length > maxChildren) {
      const more = document.createElement('div');
      more.className = 'jt-more';
      more.textContent = `… ${entries.length - maxChildren} more`;
      children.appendChild(more);
    }
    node.appendChild(children);
  } else {
    const leaf = document.createElement('span');
    leaf.className = `jt-value jt-${kind}`;
    leaf.textContent = leafText(value, kind);
    row.appendChild(leaf);
  }

  return node;
}
