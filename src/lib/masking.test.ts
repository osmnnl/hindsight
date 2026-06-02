import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HEADER_RULES,
  MASKED,
  isValidLuhn,
  isValidTckn,
  maskBody,
  maskConsoleMessage,
  maskHeaders,
  shouldMaskFormField,
  tryCompilePattern,
  type BodyPatternRule,
  type HeaderMaskingRule,
} from './masking';

// 12345678950 is constructed to satisfy the TCKN checksum:
//   odd  = 1+3+5+7+9 = 25, even = 2+4+6+8 = 20
//   d10  = (25*7 - 20) % 10 = 155 % 10 = 5
//   d11  = (1+2+3+4+5+6+7+8+9+5) % 10 = 50 % 10 = 0
const VALID_TCKN = '12345678950';
// Stripe test card — canonical Luhn-valid 16-digit number.
const VALID_CC_16 = '4242424242424242';
// American Express 15-digit test card — different length, Luhn-valid.
const VALID_AMEX_15 = '378282246310005';

describe('isValidTckn', () => {
  it('accepts a checksum-correct TCKN', () => {
    expect(isValidTckn(VALID_TCKN)).toBe(true);
  });

  it('rejects an 11-digit string that fails the checksum', () => {
    expect(isValidTckn('12345678901')).toBe(false);
  });

  it('rejects a leading-zero string', () => {
    // Even with otherwise valid digits, a leading zero is illegal.
    expect(isValidTckn('02345678950')).toBe(false);
  });

  it('rejects wrong-length inputs', () => {
    expect(isValidTckn('1234567')).toBe(false);
    expect(isValidTckn('123456789012')).toBe(false);
  });

  it('rejects non-digit input', () => {
    expect(isValidTckn('1234567890A')).toBe(false);
  });
});

describe('isValidLuhn', () => {
  it('accepts a known 16-digit test card', () => {
    expect(isValidLuhn(VALID_CC_16)).toBe(true);
  });

  it('accepts a 15-digit Amex test card', () => {
    expect(isValidLuhn(VALID_AMEX_15)).toBe(true);
  });

  it('accepts spaced / dashed forms of a valid card', () => {
    expect(isValidLuhn('4242 4242 4242 4242')).toBe(true);
    expect(isValidLuhn('4242-4242-4242-4242')).toBe(true);
  });

  it('rejects a card with a single flipped digit', () => {
    expect(isValidLuhn('4242424242424241')).toBe(false);
  });

  it('rejects shorter-than-13 and longer-than-19 strings', () => {
    expect(isValidLuhn('424242424242')).toBe(false); // 12 digits
    expect(isValidLuhn('42424242424242424242')).toBe(false); // 20 digits
  });
});

describe('maskHeaders', () => {
  it('masks Authorization in request scope', () => {
    const { headers, redactions } = maskHeaders(
      { Authorization: 'Bearer abc.def.ghi', 'Content-Type': 'application/json' },
      'request.headers'
    );
    expect(headers.Authorization).toBe(MASKED);
    expect(headers['Content-Type']).toBe('application/json');
    expect(redactions).toEqual([
      { scope: 'request.headers', path: 'Authorization', rule: 'header.authorization' },
    ]);
  });

  it('is case-insensitive on the header name', () => {
    const { headers } = maskHeaders({ AUTHORIZATION: 'x', cookie: 'y' }, 'request.headers');
    expect(headers.AUTHORIZATION).toBe(MASKED);
    expect(headers.cookie).toBe(MASKED);
  });

  it('honors scope — Set-Cookie only fires in response.headers', () => {
    const inRequest = maskHeaders({ 'Set-Cookie': 'session=abc' }, 'request.headers');
    expect(inRequest.headers['Set-Cookie']).toBe('session=abc');
    expect(inRequest.redactions).toEqual([]);

    const inResponse = maskHeaders({ 'Set-Cookie': 'session=abc' }, 'response.headers');
    expect(inResponse.headers['Set-Cookie']).toBe(MASKED);
    expect(inResponse.redactions[0]?.rule).toBe('header.set-cookie');
  });

  it('accepts custom header rules and applies them alongside defaults', () => {
    const custom: HeaderMaskingRule[] = [
      ...DEFAULT_HEADER_RULES,
      {
        id: 'header.x-debug',
        label: 'X-Debug',
        scope: ['request.headers'],
        kind: 'header',
        headerName: 'x-debug',
      },
    ];
    const { headers } = maskHeaders({ 'X-Debug': 'secret' }, 'request.headers', custom);
    expect(headers['X-Debug']).toBe(MASKED);
  });
});

describe('maskBody — TCKN', () => {
  it('masks a valid TCKN appearing inside a JSON body', () => {
    const { body, redactions } = maskBody(`{"tckn":"${VALID_TCKN}","name":"X"}`, 'request.body');
    expect(body).toBe(`{"tckn":"${MASKED}","name":"X"}`);
    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.rule).toBe('pattern.tckn');
  });

  it('does not mask an 11-digit number that fails the TCKN checksum', () => {
    // false-positive guard — random 11 digits should stay
    const body = '{"phone":"12345678901"}';
    const result = maskBody(body, 'request.body');
    expect(result.body).toBe(body);
    expect(result.redactions).toEqual([]);
  });

  it('masks multiple TCKNs in one body', () => {
    const { body, redactions } = maskBody(
      `${VALID_TCKN} and another ${VALID_TCKN}`,
      'response.body'
    );
    expect(body).toBe(`${MASKED} and another ${MASKED}`);
    expect(redactions).toHaveLength(2);
  });
});

describe('maskBody — credit card', () => {
  it('masks a Luhn-valid 16-digit card', () => {
    const { body, redactions } = maskBody(`card: ${VALID_CC_16}`, 'request.body');
    expect(body).toBe(`card: ${MASKED}`);
    expect(redactions[0]?.rule).toBe('pattern.creditcard');
  });

  it('masks a spaced card', () => {
    const { body } = maskBody('card: 4242 4242 4242 4242 end', 'request.body');
    expect(body).toBe(`card: ${MASKED} end`);
  });

  it('leaves a Luhn-invalid 16-digit string alone', () => {
    const body = 'order: 4242424242424241 ok';
    expect(maskBody(body, 'request.body').body).toBe(body);
  });

  it('returns input unchanged for null and empty body', () => {
    expect(maskBody(null, 'request.body')).toEqual({ body: null, redactions: [] });
    expect(maskBody('', 'request.body')).toEqual({ body: '', redactions: [] });
  });

  it('accepts custom body patterns with a custom validator', () => {
    const upperHex: BodyPatternRule = {
      id: 'pattern.upper-hex',
      label: 'Upper-hex token',
      scope: ['request.body'],
      kind: 'body-pattern',
      pattern: /\b[A-F0-9]{16}\b/g,
    };
    const { body, redactions } = maskBody('token: DEADBEEFCAFEBABE rest', 'request.body', [
      upperHex,
    ]);
    expect(body).toBe(`token: ${MASKED} rest`);
    expect(redactions[0]?.rule).toBe('pattern.upper-hex');
  });
});

describe('maskConsoleMessage', () => {
  it('masks a TCKN in a log line', () => {
    const { message, redactions } = maskConsoleMessage(`user logged in: ${VALID_TCKN}`);
    expect(message).toBe(`user logged in: ${MASKED}`);
    expect(redactions[0]?.scope).toBe('console.message');
    expect(redactions[0]?.rule).toBe('pattern.tckn');
  });

  it('masks a credit card dumped into the console', () => {
    const { message } = maskConsoleMessage(`payment card ${VALID_CC_16} charged`);
    expect(message).toBe(`payment card ${MASKED} charged`);
  });

  it('applies all body rules regardless of their scope opt-in', () => {
    // A body rule scoped only to response.body still fires on a console
    // message, because a log line has no scope of its own.
    const responseOnly: BodyPatternRule = {
      id: 'pattern.upper-hex',
      label: 'Upper-hex token',
      scope: ['response.body'],
      kind: 'body-pattern',
      pattern: /\b[A-F0-9]{16}\b/g,
    };
    const { message } = maskConsoleMessage('token DEADBEEFCAFEBABE', [responseOnly]);
    expect(message).toBe(`token ${MASKED}`);
  });

  it('returns empty input unchanged', () => {
    expect(maskConsoleMessage('')).toEqual({ message: '', redactions: [] });
  });

  it('leaves a Luhn-invalid number alone', () => {
    const msg = 'request id 4242424242424241';
    expect(maskConsoleMessage(msg).message).toBe(msg);
  });
});

describe('shouldMaskFormField', () => {
  it('masks an <input type="password">', () => {
    expect(shouldMaskFormField({ type: 'password' }).masked).toBe(true);
  });

  it('masks autocomplete="cc-number"', () => {
    expect(shouldMaskFormField({ autocomplete: 'cc-number' }).masked).toBe(true);
  });

  it('matches sensitive name/id heuristics', () => {
    expect(shouldMaskFormField({ name: 'user-token' }).masked).toBe(true);
    expect(shouldMaskFormField({ id: 'login-pin' }).masked).toBe(true);
  });

  it('leaves a regular text field alone', () => {
    expect(shouldMaskFormField({ type: 'text', name: 'description' }).masked).toBe(false);
  });
});

describe('tryCompilePattern', () => {
  it('compiles a valid regex with the g flag forced', () => {
    const re = tryCompilePattern('foo+');
    expect(re).not.toBeNull();
    expect(re?.flags).toContain('g');
  });

  it('returns null for an invalid pattern', () => {
    expect(tryCompilePattern('([')).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(tryCompilePattern('')).toBeNull();
    expect(tryCompilePattern('   ')).toBeNull();
  });
});
