// Bridge (ISOLATED world) capture-intake gate.
//
// Captures reach the bridge over window.postMessage until the private
// MessagePort is confirmed (capture-channel.ts), then over the port only.
// The window path is shared with the page, so once the port is carrying
// captures any further window "capture" is either a stray in-flight
// broadcast from the switch-over or a page forging events into the
// recording. Accept the former for a short grace period, drop the rest.
//
// Pure so it can be unit-tested outside a content script.

/** In-flight broadcasts posted just before MAIN saw the `ack` can land
 *  after the first port capture; they're delivered within a task or two.
 *  Generous so a busy main thread never drops a genuine capture. */
export const WINDOW_INTAKE_GRACE_MS = 2_000;

export interface WindowIntakeGate {
  /** Record that a capture arrived over the private port. */
  notePortCapture(now: number): void;
  /** Whether a capture that arrived over window should be accepted. */
  acceptWindowCapture(now: number): boolean;
}

export function createWindowIntakeGate(): WindowIntakeGate {
  let firstPortCaptureAt: number | null = null;
  return {
    notePortCapture(now) {
      if (firstPortCaptureAt == null) firstPortCaptureAt = now;
    },
    acceptWindowCapture(now) {
      return firstPortCaptureAt == null || now - firstPortCaptureAt <= WINDOW_INTAKE_GRACE_MS;
    },
  };
}
