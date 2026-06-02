// Content-script interceptor — MAIN world (page context).
//
// Wires window.fetch and window.XMLHttpRequest through the patch
// factories from src/lib/network-patch.ts and listens to user-action
// events. Has no access to chrome.* APIs by design — emits RawCapture
// envelopes over window.postMessage to the ISOLATED-world bridge.

import { createFetchPatch, createWebSocketPatch, createXhrPatch } from '@/lib/network-patch';
import { buildTargetDescriptor } from '@/lib/dom-descriptor';
import {
  CAPTURE_BRIDGE_TAG,
  type PageBridgeMessage,
  type RawCapture,
} from '@/lib/runtime-messages';
import { MASKED, shouldMaskFormField } from '@/lib/masking';
import type {
  ActionClickData,
  ActionInputData,
  ActionScrollData,
  ConsoleData,
  CursorData,
  NavigationData,
  Redaction,
} from '@/types/events';

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

  // ---------- Network (Tier 1 — fetch/XHR; Tier 2 — WebSocket) ----------
  window.fetch = createFetchPatch(window.fetch, post);
  window.XMLHttpRequest = createXhrPatch(window.XMLHttpRequest, post);
  if (typeof window.WebSocket !== 'undefined') {
    window.WebSocket = createWebSocketPatch(window.WebSocket, post);
  }

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

  // ---------- Console errors + warn + info + unhandled rejections ----------
  //   error / unhandled — Tier 1 (PRD §6.1.1 default-on, always)
  //   warn / info       — Tier 2 (PRD §6.1.1 default-on, user-toggleable;
  //                       toggle UI lands with the Settings Capture
  //                       section)
  console.error = wrapConsoleMethod('console.error', console.error, 'error');
  console.warn = wrapConsoleMethod('console.warn', console.warn, 'warn');
  console.info = wrapConsoleMethod('console.info', console.info, 'info');
  // Verbose levels — always posted from page-world; the service worker
  // drops them unless CaptureSettings.verboseConsoleEnabled is on. We're
  // intentionally wrapping console.log / console.debug to capture them.
  /* eslint-disable no-console -- wrapping these methods is the whole point */
  console.log = wrapConsoleMethod('console.log', console.log, 'log');
  console.debug = wrapConsoleMethod('console.debug', console.debug, 'debug');
  /* eslint-enable no-console */

  function wrapConsoleMethod(
    eventType: 'console.error' | 'console.warn' | 'console.info' | 'console.log' | 'console.debug',
    original: (...args: unknown[]) => void,
    level: ConsoleData['level']
  ): (...args: unknown[]) => void {
    const boundOriginal = original.bind(console);
    return function patchedConsole(...args: unknown[]): void {
      try {
        const data: ConsoleData = {
          level,
          message: formatConsoleArgs(args),
          ...extractStackFromArgs(args),
        };
        post({ type: eventType, data });
      } catch {
        /* never break the page */
      }
      boundOriginal(...args);
    };
  }

  window.addEventListener('error', (e) => {
    try {
      const data: ConsoleData = {
        level: 'unhandled',
        message: e.message || String(e.error ?? '[unknown error]'),
        ...(e.error instanceof Error && e.error.stack ? { stack: e.error.stack } : {}),
        ...(e.filename
          ? {
              source: {
                file: e.filename,
                line: e.lineno || 0,
                ...(e.colno ? { column: e.colno } : {}),
              },
            }
          : {}),
      };
      post({ type: 'console.unhandled', data });
    } catch {
      /* never break the page */
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    try {
      const reason = e.reason;
      let message: string;
      let stack: string | undefined;
      if (reason instanceof Error) {
        message = reason.message;
        stack = reason.stack;
      } else if (typeof reason === 'string') {
        message = reason;
      } else {
        try {
          message = JSON.stringify(reason);
        } catch {
          message = String(reason);
        }
      }
      const data: ConsoleData = {
        level: 'unhandled',
        message,
        ...(stack ? { stack } : {}),
      };
      post({ type: 'console.unhandled', data });
    } catch {
      /* never break the page */
    }
  });

  // Cap a single console message so a dumped megabyte-sized object can't
  // bloat storage. console.log is opt-in and high-volume; the per-tab
  // buffer bounds the count, this bounds each entry's size.
  const MAX_CONSOLE_MESSAGE_LEN = 8192;

  function formatConsoleArgs(args: unknown[]): string {
    const joined = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    return joined.length > MAX_CONSOLE_MESSAGE_LEN
      ? joined.slice(0, MAX_CONSOLE_MESSAGE_LEN) + '…[truncated]'
      : joined;
  }

  function extractStackFromArgs(args: unknown[]): { stack?: string } {
    for (const a of args) {
      if (a instanceof Error && a.stack) return { stack: a.stack };
    }
    return {};
  }

  // ---------- SPA route changes (Tier 1) ----------
  // Modern SPAs change the URL via history.pushState/replaceState (or
  // the hash) without triggering chrome.webNavigation.onCommitted — so
  // the SW-side navigation handler from W5-4 misses them entirely.
  // Wrap the History API in page-world to plug the gap. popstate is
  // intentionally NOT listened-for: browser back/forward fires both
  // popstate AND webNavigation.onCommitted(transitionType='auto_subframe'
  // | 'back_forward'), and we don't want to double-count.
  const originalPushState = history.pushState.bind(history);
  history.pushState = function (state: unknown, title: string, url?: string | URL | null): void {
    const fromUrl = window.location.href;
    originalPushState(state, title, url ?? null);
    emitSpaNavigation(fromUrl, window.location.href, 'pushState');
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (state: unknown, title: string, url?: string | URL | null): void {
    const fromUrl = window.location.href;
    originalReplaceState(state, title, url ?? null);
    emitSpaNavigation(fromUrl, window.location.href, 'replaceState');
  };

  window.addEventListener('hashchange', (e) => {
    emitSpaNavigation(e.oldURL, e.newURL, 'hashchange');
  });

  function emitSpaNavigation(fromUrl: string, toUrl: string, transitionType: string): void {
    if (fromUrl === toUrl) return;
    try {
      const data: NavigationData = { fromUrl, toUrl, transitionType };
      post({ type: 'navigation', data });
    } catch {
      /* never break the page */
    }
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

  // ---------- White-screen heuristic (PRD §6.2.1) ----------
  // Once per IIFE-lifetime (i.e. per top-frame load), check 5 s after
  // window.load whether the page has fewer than 5 visible elements.
  // SPA route changes don't re-run the IIFE so this only fires on a
  // genuine fresh page — OQ-M3-F resolution. The synthetic
  // console.unhandled re-uses the existing SW error path: badge ticks
  // red, screenshot fires via the standard isErrorEvent trigger.
  let whiteScreenChecked = false;
  function scheduleWhiteScreenCheck(): void {
    if (whiteScreenChecked) return;
    whiteScreenChecked = true;
    setTimeout(() => {
      const all = document.body?.querySelectorAll('*');
      if (!all) return;
      let visible = 0;
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visible++;
          if (visible >= 5) return; // healthy page — bail
        }
      }
      const data: ConsoleData = {
        level: 'unhandled',
        message: `White-screen heuristic: only ${visible} visible element${visible === 1 ? '' : 's'} 5 s after load (PRD §6.2.1).`,
      };
      post({ type: 'console.unhandled', data });
    }, 5000);
  }
  if (document.readyState === 'complete') {
    scheduleWhiteScreenCheck();
  } else {
    window.addEventListener('load', scheduleWhiteScreenCheck, { once: true });
  }

  // ---------- Performance long-task + CLS (Tier 3) ----------
  // PRD §6.1.1 Tier 3 "Conditional (triggered, not continuous)" — these
  // observers don't fire on idle pages. Long-task threshold mirrors the
  // PRD §6.2.1 badge rule (> 100 ms).
  const LONG_TASK_MIN_MS = 100;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration <= LONG_TASK_MIN_MS) continue;
          post({
            type: 'performance.longtask',
            data: { durationMs: Math.round(entry.duration), attribution: entry.name || undefined },
          });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* environment doesn't support longtask — silent */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (typeof shift.value !== 'number') continue;
          post({
            type: 'performance.cls',
            data: {
              value: Math.round(shift.value * 10_000) / 10_000,
              hadRecentInput: shift.hadRecentInput === true,
            },
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* layout-shift not supported (Firefox) — silent */
    }
  }

  // ---------- Cursor trail + scroll (Tier 4 — recording-only) ----------
  // We always run these listeners (cost is one timestamp compare per
  // event) and let the SW drop them when the tab isn't recording.
  // PRD §6.1.1 Tier 4: mousemove throttled to 10 Hz; scroll throttled.
  const CURSOR_INTERVAL_MS = 100; // 10 Hz
  const SCROLL_INTERVAL_MS = 100;
  let lastCursorAt = 0;
  let lastScrollAt = 0;

  window.addEventListener(
    'mousemove',
    (e) => {
      const now = Date.now();
      if (now - lastCursorAt < CURSOR_INTERVAL_MS) return;
      lastCursorAt = now;
      const data: CursorData = { x: e.clientX, y: e.clientY };
      post({ type: 'cursor', data });
    },
    { passive: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      const now = Date.now();
      if (now - lastScrollAt < SCROLL_INTERVAL_MS) return;
      lastScrollAt = now;
      const data: ActionScrollData = {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
      post({ type: 'action.scroll', data });
    },
    { passive: true }
  );
})();
