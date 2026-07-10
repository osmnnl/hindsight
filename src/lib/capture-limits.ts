// Capture-time size limits — single owner of "how much of a payload do
// we keep" so the fetch/XHR patches, the console wrapper, and any future
// capture site share the same bounds.
//
// Why this exists (perf hotfix, v0.6.2): the capture pipeline copies
// every payload several times on the page's main thread (postMessage
// structured clone → runtime IPC → storage write). Unbounded strings
// turn each of those copies into a multi-MB main-thread stall, so every
// payload is capped at the source before it enters the pipeline.

/** Max characters kept from a request/response body. Matches the
 *  long-standing fetch response cap (PRD §13.2 storage budget). */
export const BODY_CAP = 200_000;

/** Max characters kept from a single console argument. Console spam is
 *  frequent and low-value past the first few KB. */
export const CONSOLE_ARG_CAP = 10_000;

/** Max characters kept from a form-field value on an `action.input`
 *  capture. `input` fires on every keystroke and each event carries the
 *  field's FULL current value, so a large textarea (a code/description
 *  field) otherwise streams its entire uncapped contents through the
 *  pipeline on every keystroke — the one default-on capture that had no
 *  source cap, and a byte-cap blind spot (perf review). */
export const INPUT_VALUE_CAP = 10_000;

export const TRUNCATION_MARKER = '\n…[truncated]';

/** Caps `text` at `cap` characters, appending a marker when cut. */
export function capText(text: string, cap: number = BODY_CAP): string {
  return text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text;
}

/**
 * JSON.stringify with a work budget. A plain `JSON.stringify(huge)` pays
 * the full serialization cost before any cap can apply; the replacer
 * here aborts once roughly `2 × cap` characters of output have been
 * produced, so the cost of stringifying a 100 MB object is bounded by
 * the cap, not the object.
 */
export function stringifyCapped(value: unknown, cap: number): string {
  let budget = cap * 2;
  try {
    const s = JSON.stringify(value, (_key, v: unknown) => {
      if (budget <= 0) throw new Error('cap');
      if (typeof v === 'string') {
        budget -= v.length;
        return v.length > cap ? v.slice(0, cap) : v;
      }
      budget -= 8; // rough per-node overhead (key, punctuation, number)
      return v;
    });
    if (s == null) return String(value);
    return s.length > cap ? s.slice(0, cap) + TRUNCATION_MARKER : s;
  } catch {
    // Budget exhausted or value not serializable (cycles, BigInt).
    try {
      return capText(String(value), cap);
    } catch {
      return '[uncapturable value]';
    }
  }
}
