// Content-script interceptor — MAIN world (page context).
//
// Wires window.fetch and window.XMLHttpRequest through the patch
// factories from src/lib/network-patch.ts and listens to user-action
// events. Has no access to chrome.* APIs by design — emits RawCapture
// envelopes over window.postMessage to the ISOLATED-world bridge.

import { createFetchPatch, createXhrPatch } from '@/lib/network-patch';
import { buildTargetDescriptor } from '@/lib/dom-descriptor';
import {
  CAPTURE_BRIDGE_TAG,
  type PageBridgeMessage,
  type RawCapture,
} from '@/lib/runtime-messages';
import { MASKED, shouldMaskFormField } from '@/lib/masking';
import type { ActionClickData, ActionInputData, Redaction } from '@/types/events';

(() => {
  function post(capture: RawCapture, redactions?: Redaction[]): void {
    const message: PageBridgeMessage = {
      source: CAPTURE_BRIDGE_TAG,
      capture,
      ...(redactions && redactions.length > 0 ? { redactions } : {}),
    };
    try {
      window.postMessage(message, '*');
    } catch {
      /* silent */
    }
  }

  // ---------- Network (Tier 1) ----------
  window.fetch = createFetchPatch(window.fetch, post);
  window.XMLHttpRequest = createXhrPatch(window.XMLHttpRequest, post);

  // ---------- Clicks (Tier 2) ----------
  // Capture phase so `stopPropagation()` further down the page can't
  // hide a click from us (PRD §6.1.1 Tier 2 — clicks are user-driven,
  // low frequency, no throttling needed).
  document.addEventListener(
    'click',
    (e) => {
      try {
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        const data: ActionClickData = {
          target: buildTargetDescriptor(target),
          button: normalizeButton(e.button),
          modifiers: {
            alt: e.altKey,
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            shift: e.shiftKey,
          },
        };
        post({ type: 'action.click', data });
      } catch {
        /* never break the page */
      }
    },
    true
  );

  function normalizeButton(b: number): 0 | 1 | 2 {
    if (b === 1) return 1;
    if (b === 2) return 2;
    return 0;
  }

  // ---------- Form input (Tier 2) ----------
  // `input` events fire on every keystroke; we accept that volume since
  // PRD §6.1.1 lists this in Tier 2 default-on. Masking happens here in
  // page-world because FormFieldMeta is only visible from the DOM —
  // the service worker can't see <input type="password"> attributes.
  document.addEventListener(
    'input',
    (e) => {
      try {
        const el = e.target;
        if (
          !(el instanceof HTMLInputElement) &&
          !(el instanceof HTMLTextAreaElement) &&
          !(el instanceof HTMLSelectElement)
        ) {
          return;
        }
        const field = {
          name: el.getAttribute('name') ?? undefined,
          id: el.id || undefined,
          type: el instanceof HTMLInputElement ? el.type : undefined,
          autocomplete: el.getAttribute('autocomplete') ?? undefined,
        };
        const { masked, rule } = shouldMaskFormField(field);
        const value = masked ? MASKED : el.value;

        const data: ActionInputData = {
          target: buildTargetDescriptor(el),
          value,
          ...(el instanceof HTMLInputElement ? { inputType: el.type } : {}),
        };
        const redactions: Redaction[] | undefined =
          masked && rule
            ? [{ scope: 'form.value', path: field.name ?? field.id ?? el.tagName, rule: rule.id }]
            : undefined;
        post({ type: 'action.input', data }, redactions);
      } catch {
        /* never break the page */
      }
    },
    true
  );
})();
