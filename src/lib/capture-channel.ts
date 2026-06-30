// MAIN-world capture routing state machine (perf hot path).
//
// Pure logic, no window / MessagePort construction of its own — the
// interceptor injects the broadcast sink and wires the real port's
// onmessage to onControl(). Same separation as network-patch.ts: it lets
// the handshake/gate decisions be unit-tested outside a content script,
// where the cross-world MessagePort transfer can't be exercised.
//
// Contract: captures broadcast over window.postMessage('*') until a
// round-trip over the private port is CONFIRMED (the bridge's `ack`).
// Only then do they switch to the port — so a browser where the transfer
// silently fails keeps broadcasting and never loses a capture.

import type { PageBridgeMessage, PortControlMessage } from '@/lib/runtime-messages';

/** The single method the channel needs from a MessagePort — narrowed so
 *  tests can pass a plain stub. */
type PortLike = Pick<MessagePort, 'postMessage'>;

export interface MainCaptureChannel {
  /** Route a capture: over the private port once confirmed, else broadcast. */
  post(message: PageBridgeMessage): void;
  /** Adopt the port offered by the bridge and send `syn`. The caller must
   *  wire `port.onmessage` to onControl() BEFORE calling this so the
   *  bridge's `ack`/`recording` replies are caught. Idempotent. */
  adoptPort(port: PortLike): void;
  /** Handle a control frame received over the port. */
  onControl(data: PortControlMessage): void;
  /** Tier-4 (cursor / scroll) source gate. Returns false ⇒ drop. Only
   *  drops once authoritative recording state says "off"; while the state
   *  is unknown (no port yet) it returns true and the bridge's own gate
   *  does the dropping, so cursor/scroll are never under-captured. */
  shouldEmitTier4(): boolean;
}

export function createMainCaptureChannel(
  broadcast: (message: PageBridgeMessage) => void
): MainCaptureChannel {
  let port: PortLike | null = null;
  let portReady = false;
  let recording = false;
  let recordingKnown = false;

  return {
    post(message) {
      if (portReady && port) {
        try {
          port.postMessage(message);
          return;
        } catch {
          /* port died — fall back to the broadcast */
        }
      }
      broadcast(message);
    },
    adoptPort(p) {
      if (port) return;
      port = p;
      try {
        p.postMessage({ hs: 'syn' } satisfies PortControlMessage);
      } catch {
        /* ignore — stays on the broadcast path */
      }
    },
    onControl(data) {
      if (data.hs === 'ack') {
        portReady = true;
      } else if (data.hs === 'recording') {
        recording = data.recording === true;
        recordingKnown = true;
      }
    },
    shouldEmitTier4() {
      return !(recordingKnown && !recording);
    },
  };
}
