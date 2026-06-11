// Page-world DOM → TargetDescriptor helpers.
//
// One owner of "how do we identify an element a user just acted on"
// so click / input / focus capture sites all produce equivalent shapes.
// Lives in @/lib so the page-world interceptor and (later) the
// side-panel timeline can both import it.

import type { TargetDescriptor } from '@/types/events';

/** Hard cap on the classlist we capture per element. Avoids tailwind-y
 *  pages turning every click into a 200-class blob in storage. */
const MAX_CLASSES = 6;

/** Hard cap on accessible-name length. Long aria-labels happen
 *  (paragraph-long announcements) but they're noise in a bug report. */
const MAX_ACCESSIBLE_NAME = 120;

export interface DescriptorOptions {
  /** Capture the bounding rect (default true). High-frequency callers
   *  (per-keystroke input capture) pass false — getBoundingClientRect
   *  forces a synchronous style/layout pass on the page. */
  rect?: boolean;
}

/**
 * Build a stable, accessibility-leaning descriptor for the given
 * element. Returns the descriptor regardless of how the event got here
 * (click, input, focus); callers attach action-specific fields on top.
 */
export function buildTargetDescriptor(el: Element, opts?: DescriptorOptions): TargetDescriptor {
  const tag = el.tagName.toUpperCase();
  const descriptor: TargetDescriptor = { tag };

  const accessibleName = computeAccessibleName(el);
  if (accessibleName) descriptor.accessibleName = accessibleName;

  if (el.id) descriptor.id = el.id;

  const name = el.getAttribute('name');
  if (name) descriptor.name = name;

  const classes = classListSample(el);
  if (classes.length > 0) descriptor.classes = classes;

  if (opts?.rect !== false) {
    const rect = boundingRect(el);
    if (rect) descriptor.rect = rect;
  }

  return descriptor;
}

/**
 * Accessibility-first name resolution. Order:
 *   1. aria-label
 *   2. aria-labelledby (resolved via getElementById)
 *   3. Visible text (textContent or value for inputs)
 *   4. placeholder / title fallbacks
 * Returns undefined if nothing usable found.
 */
function computeAccessibleName(el: Element): string | undefined {
  const aria = el.getAttribute('aria-label');
  if (aria) return clamp(aria);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const refs = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument?.getElementById(id))
      .filter((n): n is HTMLElement => n != null)
      .map((n) => n.textContent?.trim())
      .filter((s): s is string => !!s);
    if (refs.length > 0) return clamp(refs.join(' '));
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return clamp(placeholder);
  }

  const text = (el.textContent ?? '').trim();
  if (text) return clamp(text);

  const title = el.getAttribute('title');
  if (title) return clamp(title);

  return undefined;
}

function classListSample(el: Element): string[] {
  if (!el.classList || el.classList.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < el.classList.length && out.length < MAX_CLASSES; i++) {
    const c = el.classList.item(i);
    if (c) out.push(c);
  }
  return out;
}

function boundingRect(el: Element): TargetDescriptor['rect'] {
  try {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  } catch {
    return undefined;
  }
}

function clamp(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX_ACCESSIBLE_NAME) return trimmed;
  return trimmed.slice(0, MAX_ACCESSIBLE_NAME) + '…';
}
