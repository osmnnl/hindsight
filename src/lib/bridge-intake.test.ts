import { describe, expect, it } from 'vitest';

import { WINDOW_INTAKE_GRACE_MS, createWindowIntakeGate } from './bridge-intake';

describe('window capture intake gate (1.0 A4)', () => {
  it('accepts window captures while the port has not carried any', () => {
    const gate = createWindowIntakeGate();
    expect(gate.acceptWindowCapture(0)).toBe(true);
    expect(gate.acceptWindowCapture(60_000)).toBe(true);
  });

  it('accepts in-flight broadcasts during the switch-over grace period', () => {
    const gate = createWindowIntakeGate();
    gate.notePortCapture(1_000);
    expect(gate.acceptWindowCapture(1_000 + WINDOW_INTAKE_GRACE_MS)).toBe(true);
  });

  it('drops a forged window capture after the port handshake', () => {
    const gate = createWindowIntakeGate();
    gate.notePortCapture(1_000);
    gate.notePortCapture(5_000); // later port traffic doesn't extend the grace
    expect(gate.acceptWindowCapture(1_001 + WINDOW_INTAKE_GRACE_MS)).toBe(false);
  });
});
