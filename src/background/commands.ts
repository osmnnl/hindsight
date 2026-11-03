// Keyboard command dispatch (manifest.commands — PRD §9.2). Kept free of
// chrome.* globals so it can be unit-tested; the service worker injects
// the real implementations.

import { makePendingAction, PENDING_ACTION_KEY } from '@/lib/pending-action';

export interface CommandDeps {
  /** Opens the side panel for the active tab. On Firefox it must run
   *  before any await (sidebarAction.open needs the live gesture). */
  openPanel: () => Promise<void>;
  activeTabId: () => Promise<number | undefined>;
  setLocal: (items: Record<string, unknown>) => Promise<void>;
  toggleRecording: (tabId: number) => Promise<unknown>;
  now: () => number;
}

export function createCommandHandler(deps: CommandDeps): (command: string) => Promise<void> {
  return async (command) => {
    if (command === 'open-side-panel') {
      await deps.openPanel();
      return;
    }
    if (command === 'capture-last-moment') {
      // Open first so the gesture is still live, then plant the action —
      // the panel reacts on boot or via storage.onChanged.
      const opening = deps.openPanel();
      const tabId = await deps.activeTabId();
      if (tabId != null) {
        await deps.setLocal({ [PENDING_ACTION_KEY]: makePendingAction(tabId, deps.now()) });
      }
      await opening;
      return;
    }
    if (command === 'toggle-recording') {
      const tabId = await deps.activeTabId();
      if (tabId != null) await deps.toggleRecording(tabId);
    }
  };
}
