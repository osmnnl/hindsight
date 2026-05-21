// Vanilla ZIP archive writer — PRD §6.4.2.
//
// Single-purpose, dependency-free writer for the "Download ZIP" export
// surface in the sidepanel. Bundles the captured session's markdown
// report, JSON dump, HAR, replay-bundle HTML and any inline screenshot
// payloads into one .zip file the user can hand off to a teammate.
//
// Implementation notes
// --------------------
// 1. Compression method is 0 ("stored", uncompressed). Hindsight's
//    captures are already small-to-medium text; the simplicity payoff
//    (no DEFLATE state machine, no streaming-deflate runtime) is worth
//    the disk-size hit. PRD §5.4 only caps the *replay bundle* size.
// 2. UTF-8 filenames — bit 11 of the general-purpose flags is set so
//    legacy unzip implementations treat the filename as UTF-8 instead
//    of CP437.
// 3. No central-directory encryption, no Zip64, no spanning. Files up
//    to 4 GiB and archives up to 4 GiB are supported; replay sessions
//    are orders of magnitude smaller, so 32-bit fields suffice.
// 4. The DOS date/time fields encode the modification time per the
//    APPNOTE.TXT §4.4.6 layout (seconds/2 in low 5 bits, etc.).
//
// Tests: zip.test.ts.

export interface ZipEntry {
  /** Path inside the archive. Forward slashes only — no leading slash. */
  name: string;
  /** Raw bytes to store. Use new TextEncoder().encode(s) for text. */
  data: Uint8Array;
  /** Optional modification time. Defaults to Date.now(). */
  modified?: Date;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encodeUtf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const { dosDate, dosTime } = toDosDateTime(entry.modified ?? new Date());

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lh = new DataView(localHeader.buffer);
    lh.setUint32(0, 0x04034b50, true); // local file header signature
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0x0800, true); // general-purpose flags — bit 11 = UTF-8 names
    lh.setUint16(8, 0, true); // compression method — stored
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); // compressed
    lh.setUint32(22, size, true); // uncompressed
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra field length
    localHeader.set(nameBytes, 30);

    records.push(localHeader);
    records.push(entry.data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const ch = new DataView(centralHeader.buffer);
    ch.setUint32(0, 0x02014b50, true); // central file header signature
    ch.setUint16(4, 20, true); // version made by
    ch.setUint16(6, 20, true); // version needed
    ch.setUint16(8, 0x0800, true); // flags — UTF-8 names
    ch.setUint16(10, 0, true); // compression
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true); // extra length
    ch.setUint16(32, 0, true); // comment length
    ch.setUint16(34, 0, true); // disk number start
    ch.setUint16(36, 0, true); // internal attrs
    ch.setUint32(38, 0, true); // external attrs
    ch.setUint32(42, offset, true); // local header offset
    centralHeader.set(nameBytes, 46);
    central.push(centralHeader);

    offset += localHeader.length + entry.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir signature
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk where central starts
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let p = 0;
  for (const r of records) {
    out.set(r, p);
    p += r.length;
  }
  for (const c of central) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}

// ---------------------------------------------------------------------------
// CRC-32 (polynomial 0xEDB88320). Table is built once and reused; small
// archives don't need a streaming variant.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

export function crc32(bytes: Uint8Array): number {
  const t = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toDosDateTime(d: Date): { dosDate: number; dosTime: number } {
  // ZIP APPNOTE §4.4.6. Minimum year is 1980; clamp anything older so
  // tools that read the field don't underflow.
  const year = Math.max(1980, d.getFullYear());
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { dosDate, dosTime };
}
