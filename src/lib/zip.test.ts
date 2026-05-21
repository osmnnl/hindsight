import { describe, expect, it } from 'vitest';
import { buildZip, crc32 } from './zip';

describe('crc32', () => {
  // Known-vector "123456789" → 0xCBF43926 per the standard CRC-32 catalog.
  it('matches the standard test vector', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('returns 0 for an empty buffer', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildZip', () => {
  it('returns bytes with the local-header and EOCD signatures', () => {
    const zip = buildZip([{ name: 'hello.txt', data: new TextEncoder().encode('hello world') }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Local file header signature.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // EOCD signature in the last 22 bytes.
    const eocdOffset = zip.length - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    // Total entries field — bytes 10..12 of EOCD.
    expect(view.getUint16(eocdOffset + 10, true)).toBe(1);
  });

  it('encodes multiple entries with correct central directory count', () => {
    const zip = buildZip([
      { name: 'a.txt', data: new TextEncoder().encode('a') },
      { name: 'b.txt', data: new TextEncoder().encode('bb') },
      { name: 'c.txt', data: new TextEncoder().encode('ccc') },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocdOffset = zip.length - 22;
    expect(view.getUint16(eocdOffset + 10, true)).toBe(3);
  });

  it('stores filenames as UTF-8 (general-purpose flag bit 11)', () => {
    const zip = buildZip([{ name: 'türkçe.txt', data: new TextEncoder().encode('payload') }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
  });

  it('writes file contents verbatim (no compression)', () => {
    const payload = new TextEncoder().encode('verbatim');
    const zip = buildZip([{ name: 'p.txt', data: payload }]);
    // After the 30-byte fixed local header + filename, the next N bytes
    // are the stored payload.
    const fileNameLen = 'p.txt'.length;
    const payloadStart = 30 + fileNameLen;
    const slice = zip.slice(payloadStart, payloadStart + payload.length);
    expect(new TextDecoder().decode(slice)).toBe('verbatim');
  });
});
