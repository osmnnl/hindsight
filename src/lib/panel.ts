// Cross-browser "open the capture panel" entry point.
//
// Chrome (and Chromium) expose the Side Panel API (chrome.sidePanel),
// which opens per-tab. Firefox has no Side Panel API at all — the same
// surface ships as a sidebar (sidebar_action in the manifest) and is
// driven by the sidebarAction API, which opens window-globally and takes
// no tabId. Both must be called from within a user gesture.
//
// We feature-detect at runtime so a single bundle works for either build
// target; the manifest is what differs per browser (see vite.config.ts).

interface SidebarAction {
  open(): Promise<void>;
}

function getSidebarAction(): SidebarAction | undefined {
  const g = globalThis as unknown as {
    browser?: { sidebarAction?: SidebarAction };
    chrome?: { sidebarAction?: SidebarAction };
  };
  // Firefox exposes sidebarAction under both `browser` (promise-based) and
  // `chrome`; prefer the promise flavour when available.
  return g.browser?.sidebarAction ?? g.chrome?.sidebarAction;
}

/**
 * Open the Hindsight capture panel for the given tab.
 *
 * Must be invoked synchronously inside a user gesture (button click,
 * keyboard command) or the browser will reject the request.
 *
 * @param tabId - the tab to open the Chrome side panel against. Ignored on
 *   Firefox, whose sidebar is window-global.
 */
export async function openCapturePanel(tabId: number | undefined): Promise<void> {
  if (chrome.sidePanel?.open && tabId != null) {
    await chrome.sidePanel.open({ tabId });
    return;
  }
  const sidebar = getSidebarAction();
  if (sidebar) {
    await sidebar.open();
  }
}
