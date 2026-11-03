import { describe, expect, it, vi } from 'vitest';
import {
  handleInstalled,
  shouldShowPanelHint,
  WELCOME_PATH,
  type OnboardingState,
} from './onboarding';

function deps() {
  return {
    openTab: vi.fn(async () => undefined),
    getURL: (p: string) => `chrome-extension://id/${p}`,
    read: vi.fn(async (): Promise<OnboardingState> => ({})),
    write: vi.fn(async () => undefined),
    now: () => 1000,
  };
}

describe('handleInstalled', () => {
  it('opens the welcome page once on a fresh install', async () => {
    const d = deps();
    await handleInstalled({ reason: 'install' }, d);
    expect(d.openTab).toHaveBeenCalledTimes(1);
    expect(d.openTab).toHaveBeenCalledWith(`chrome-extension://id/${WELCOME_PATH}`);
    expect(d.write).toHaveBeenCalledWith({ installedAt: 1000, hintDone: false });
  });

  it('does not reopen it when onboarding already ran on this profile', async () => {
    const d = deps();
    d.read.mockResolvedValue({ installedAt: 1, hintDone: true });
    await handleInstalled({ reason: 'install' }, d);
    expect(d.openTab).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it.each(['update', 'chrome_update', 'shared_module_update'])(
    'does nothing on %s',
    async (reason) => {
      const d = deps();
      await handleInstalled({ reason }, d);
      expect(d.openTab).not.toHaveBeenCalled();
      expect(d.write).not.toHaveBeenCalled();
    }
  );
});

describe('shouldShowPanelHint', () => {
  it('shows only for fresh installs that have not opened the panel', () => {
    expect(shouldShowPanelHint({ installedAt: 1, hintDone: false })).toBe(true);
    expect(shouldShowPanelHint({ installedAt: 1, hintDone: true })).toBe(false);
    expect(shouldShowPanelHint({})).toBe(false);
  });
});
