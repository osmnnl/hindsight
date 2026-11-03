// First-run onboarding (PRD §7.1).
//
// On a fresh install the service worker opens the local welcome page
// (no network) once. Updates and Chrome restarts never open it again.
// Until the user opens the side panel for the first time, the popup
// shows a one-line hint pointing at it; opening the panel or dismissing
// the hint clears it for good.

export const ONBOARDING_KEY = 'onboarding/state';

export const WELCOME_PATH = 'src/welcome/welcome.html';

export interface OnboardingState {
  /** Epoch ms of the install that showed the welcome page. */
  installedAt?: number;
  /** Side panel opened at least once, or the popup hint dismissed. */
  hintDone?: boolean;
}

export interface InstallDeps {
  openTab: (url: string) => Promise<unknown>;
  getURL: (path: string) => string;
  read: () => Promise<OnboardingState>;
  write: (state: OnboardingState) => Promise<void>;
  now: () => number;
}

/** chrome.runtime.onInstalled handler body, dependency-injected for tests. */
export async function handleInstalled(
  details: { reason: string },
  deps: InstallDeps
): Promise<void> {
  if (details.reason !== 'install') return;
  // Chrome re-reports 'install' for command-line (--load-extension) loads
  // on every launch while storage survives; a real uninstall wipes storage.
  if ((await deps.read()).installedAt != null) return;
  await deps.write({ installedAt: deps.now(), hintDone: false });
  await deps.openTab(deps.getURL(WELCOME_PATH));
}

export async function readOnboarding(): Promise<OnboardingState> {
  try {
    const stored = await chrome.storage.local.get(ONBOARDING_KEY);
    return (stored[ONBOARDING_KEY] as OnboardingState | undefined) ?? {};
  } catch {
    return {};
  }
}

export async function writeOnboarding(patch: OnboardingState): Promise<void> {
  const current = await readOnboarding();
  await chrome.storage.local.set({ [ONBOARDING_KEY]: { ...current, ...patch } });
}

/**
 * Popup hint visibility. Only installs that went through handleInstalled
 * (installedAt set) see it — users upgrading from 0.x already know the
 * side panel.
 */
export function shouldShowPanelHint(state: OnboardingState): boolean {
  return state.installedAt != null && state.hintDone !== true;
}

/** Called by the side panel on init and by the popup hint's dismiss button. */
export async function markPanelHintDone(): Promise<void> {
  const state = await readOnboarding();
  if (state.hintDone === true) return;
  await writeOnboarding({ hintDone: true });
}
