// Locks the MAIN-world capture-routing contract: broadcast until a port
// round-trip is CONFIRMED, never lose a capture if the port never acks,
// and only drop Tier-4 at the source once recording state is authoritative.

import { describe, expect, it, vi } from 'vitest';

import { createMainCaptureChannel } from './capture-channel';
import type { PageBridgeMessage } from '@/lib/runtime-messages';

// Routing tests only care about the envelope object identity, not the
// payload shape — cast past the discriminated-union data type.
const CAPTURE = {
  source: 'hindsight:capture/v1',
  capture: { type: 'action.click', data: {} },
} as unknown as PageBridgeMessage;

describe('createMainCaptureChannel — port routing', () => {
  it('broadcasts before any port is adopted', () => {
    const broadcast = vi.fn();
    const ch = createMainCaptureChannel(broadcast);
    ch.post(CAPTURE);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps broadcasting after adopting a port but BEFORE ack (round-trip unconfirmed)', () => {
    const broadcast = vi.fn();
    const ch = createMainCaptureChannel(broadcast);
    const port = { postMessage: vi.fn() };
    ch.adoptPort(port);

    // adoptPort sends the syn handshake frame, not a capture.
    expect(port.postMessage).toHaveBeenCalledWith({ hs: 'syn' });
    ch.post(CAPTURE);
    // No ack yet → still broadcasting, NOT over the port.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledTimes(1); // only the syn
  });

  it('switches captures to the port only after ack, and stops broadcasting', () => {
    const broadcast = vi.fn();
    const ch = createMainCaptureChannel(broadcast);
    const port = { postMessage: vi.fn() };
    ch.adoptPort(port);
    ch.onControl({ hs: 'ack' });

    ch.post(CAPTURE);
    expect(broadcast).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenLastCalledWith(CAPTURE);
  });

  it('falls back to broadcast if posting on the port throws', () => {
    const broadcast = vi.fn();
    const ch = createMainCaptureChannel(broadcast);
    const port = {
      postMessage: vi.fn((m: unknown) => {
        if (m !== undefined && (m as { hs?: string }).hs !== 'syn') throw new Error('port dead');
      }),
    };
    ch.adoptPort(port);
    ch.onControl({ hs: 'ack' });
    ch.post(CAPTURE);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('ignores a second adoptPort (one-shot)', () => {
    const ch = createMainCaptureChannel(vi.fn());
    const a = { postMessage: vi.fn() };
    const b = { postMessage: vi.fn() };
    ch.adoptPort(a);
    ch.adoptPort(b);
    expect(b.postMessage).not.toHaveBeenCalled();
  });
});

describe('createMainCaptureChannel — Tier-4 source gate', () => {
  it('emits while recording state is unknown (bridge gate is the backstop)', () => {
    const ch = createMainCaptureChannel(vi.fn());
    expect(ch.shouldEmitTier4()).toBe(true);
  });

  it('drops once recording is known to be off', () => {
    const ch = createMainCaptureChannel(vi.fn());
    ch.onControl({ hs: 'recording', recording: false });
    expect(ch.shouldEmitTier4()).toBe(false);
  });

  it('emits when recording is on', () => {
    const ch = createMainCaptureChannel(vi.fn());
    ch.onControl({ hs: 'recording', recording: true });
    expect(ch.shouldEmitTier4()).toBe(true);
  });
});
