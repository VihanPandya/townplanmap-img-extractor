/**
 * A minimal streaming ZIP writer.
 *
 * Entries are stored uncompressed (STORE, method 0). That is the right choice
 * here: almost everything downloaded is already-compressed image data, where
 * deflate would burn CPU for no gain, and STORE lets each entry be handed to
 * the client as it is produced without buffering the archive in memory.
 *
 * ZIP64 is deliberately not implemented. The download route caps both the entry
 * count and the total size well below the 4 GiB / 65535-entry thresholds where
 * ZIP64 becomes necessary, and `assertWithinZipLimits` enforces that.
 */

import { createHash } from 'node:crypto';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;

/** Limits above which a plain (non-ZIP64) archive is no longer valid. */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_TOTAL_BYTES = 3.5 * 1024 * 1024 * 1024;

export interface ZipEntryInput {
  /** Path inside the archive. Produced by `reserveName`. */
  name: string;
  data: Uint8Array;
  /** Modification time recorded in the entry. Defaults to now. */
  modifiedAt?: Date;
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** CRC-32, as required by the ZIP format. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime:
      (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Characters that are unsafe or reserved in a filename on common platforms. */
const UNSAFE_FILENAME_CHARS = new RegExp('[\\u0000-\\u001f\\u007f<>:"|?*]', 'g');

/**
 * Make a filename safe to write inside an archive.
 *
 * Only the final path segment is kept, and traversal segments, absolute paths,
 * control characters and reserved characters are removed, so extracting the
 * archive cannot write outside the directory the user chose.
 */
export function safeEntryName(raw: string, fallback: string): string {
  let name = (raw ?? '').trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw form when it is not valid percent-encoding.
  }
  name =
    name
      .replace(/\\/g, '/')
      .split('/')
      .filter((segment) => segment && segment !== '.' && segment !== '..')
      .pop() ?? '';
  name = name.replace(UNSAFE_FILENAME_CHARS, '_').replace(/^\.+/, '');
  if (!name) name = fallback;
  return name.length > 180 ? name.slice(0, 180) : name;
}

/** Ensure names are unique within the archive by adding " (2)", " (3)", ... */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const unique = `${stem}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}${extension}`;
  taken.add(unique);
  return unique;
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

export function assertWithinZipLimits(entryCount: number, totalBytes: number): void {
  if (entryCount > ZIP_MAX_ENTRIES) {
    throw new ZipLimitError(`An archive cannot hold more than ${ZIP_MAX_ENTRIES} files.`);
  }
  if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
    throw new ZipLimitError('The selected files exceed the maximum archive size.');
  }
}

/**
 * Builds a ZIP incrementally. Call `add` per file and `end` once; each returns
 * the bytes to push to the client, so nothing beyond a single entry is held.
 */
export class ZipBuilder {
  private readonly central: CentralRecord[] = [];
  private readonly taken = new Set<string>();
  private offset = 0;

  get entryCount(): number {
    return this.central.length;
  }

  get bytesWritten(): number {
    return this.offset;
  }

  /** Reserve a unique, safe name without writing anything yet. */
  reserveName(raw: string, fallback: string): string {
    return uniqueName(safeEntryName(raw, fallback), this.taken);
  }

  add(entry: ZipEntryInput): Buffer {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(entry.modifiedAt ?? new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed to extract
    header.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    header.writeUInt16LE(0, 8); // method: store
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); // compressed size
    header.writeUInt32LE(data.length, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    this.central.push({ name, crc, size: data.length, offset: this.offset, dosTime, dosDate });
    this.offset += header.length + name.length + data.length;

    return Buffer.concat([header, name, data]);
  }

  /** Central directory plus end record. Must be the last bytes written. */
  end(): Buffer {
    const parts: Buffer[] = [];
    let directorySize = 0;

    for (const record of this.central) {
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
      entry.writeUInt16LE(20, 4); // version made by
      entry.writeUInt16LE(20, 6); // version needed
      entry.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
      entry.writeUInt16LE(0, 10); // method: store
      entry.writeUInt16LE(record.dosTime, 12);
      entry.writeUInt16LE(record.dosDate, 14);
      entry.writeUInt32LE(record.crc, 16);
      entry.writeUInt32LE(record.size, 20);
      entry.writeUInt32LE(record.size, 24);
      entry.writeUInt16LE(record.name.length, 28);
      entry.writeUInt16LE(0, 30); // extra field length
      entry.writeUInt16LE(0, 32); // comment length
      entry.writeUInt16LE(0, 34); // disk number
      entry.writeUInt16LE(0, 36); // internal attributes
      entry.writeUInt32LE(0, 38); // external attributes
      entry.writeUInt32LE(record.offset, 42);

      parts.push(entry, record.name);
      directorySize += entry.length + record.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
    end.writeUInt16LE(0, 4); // this disk number
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20); // archive comment length

    parts.push(end);
    return Buffer.concat(parts);
  }
}
