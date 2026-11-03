import { describe, expect, it, vi } from 'vitest';
import { createCommandHandler, type CommandDeps } from './commands';
import {
  bundleFileName,
  isFreshPendingAction,
  PENDING_ACTION_KEY,
  PENDING_ACTION_TTL_MS,
} from '@/lib/pending-action';
import type { CapturedEvent } from '@/types/events';

function deps(over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    openPanel: vi.fn(async () => {}),
    activeTabId: vi.fn(async () => 7),
    setLocal: vi.fn(async () => {}),
    toggleRecording: vi.fn(async () => ({ recording: true })),
    now: () => 1_000,
    ...over,
  };
}

describe('createCommandHandler', () => {
  it('open-side-panel opens the panel only', async () => {
    const d = deps();
    await createCommandHandler(d)('open-side-panel');
    expect(d.openPanel).toHaveBeenCalledOnce();
    expect(d.setLocal).not.toHaveBeenCalled();
  });

  it('capture-last-moment opens the panel before planting the download action', async () => {
    const order: string[] = [];
    const d = deps({
      openPanel: vi.fn(async () => {
        order.push('open');
      }),
      activeTabId: vi.fn(async () => {
        order.push('query');
        return 7;
      }),
    });
    await createCommandHandler(d)('capture-last-moment');
    expect(order).toEqual(['open', 'query']);
    expect(d.setLocal).toHaveBeenCalledWith({
      [PENDING_ACTION_KEY]: { action: 'download-bundle', tabId: 7, at: 1_000 },
    });
  });

  it('capture-last-moment plants nothing without an active tab', async () => {
    const d = deps({ activeTabId: vi.fn(async () => undefined) });
    await createCommandHandler(d)('capture-last-moment');
    expect(d.setLocal).not.toHaveBeenCalled();
  });

  it('toggle-recording toggles the active tab', async () => {
    const d = deps();
    await createCommandHandler(d)('toggle-recording');
    expect(d.toggleRecording).toHaveBeenCalledWith(7);
    expect(d.openPanel).not.toHaveBeenCalled();
  });

  it('ignores unknown commands', async () => {
    const d = deps();
    await createCommandHandler(d)('nope');
    expect(d.openPanel).not.toHaveBeenCalled();
    expect(d.toggleRecording).not.toHaveBeenCalled();
  });
});

describe('isFreshPendingAction', () => {
  const a = { action: 'download-bundle', tabId: 3, at: 100 };
  it('accepts a fresh action', () => {
    expect(isFreshPendingAction(a, 100 + PENDING_ACTION_TTL_MS)).toBe(true);
  });
  it('rejects stale, future and malformed values', () => {
    expect(isFreshPendingAction(a, 101 + PENDING_ACTION_TTL_MS)).toBe(false);
    expect(isFreshPendingAction(a, 50)).toBe(false);
    expect(isFreshPendingAction({ ...a, action: 'x' }, 100)).toBe(false);
    expect(isFreshPendingAction(null, 100)).toBe(false);
    expect(isFreshPendingAction('download-bundle', 100)).toBe(false);
  });
});

describe('bundleFileName', () => {
  it('uses the first parseable host', () => {
    const events = [{ url: 'not a url' }, { url: 'https://api.example.com/x' }] as CapturedEvent[];
    expect(bundleFileName(events, new Date('2026-11-03T10:00:00.000Z'))).toBe(
      'hindsight-api.example.com-2026-11-03T10-00-00-000Z.html'
    );
  });
  it('falls back to session', () => {
    expect(bundleFileName([], new Date('2026-11-03T10:00:00.000Z'))).toBe(
      'hindsight-session-2026-11-03T10-00-00-000Z.html'
    );
  });
});
