/**
 * Minimal ZIP reader, used to open KMZ archives.
 *
 * Reads the central directory rather than scanning for local headers, and
 * supports the only two methods that occur in practice: STORE (0) and
 * DEFLATE (8). Everything is bounded so a hostile archive cannot exhaust
 * memory: entry count, per-entry size and total inflated size are all capped.
 */

import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_SIG = 0x06054b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;

const MAX_ENTRIES = 512;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  size: number;
  read: () => Buffer;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/** Locate the end-of-central-directory record, which sits at the tail. */
function findEndRecord(buffer: Buffer): number {
  const minimum = 22;
  if (buffer.length < minimum) throw new ZipReadError('The archive is too small to be a zip file.');
  // The comment may be up to 64 KiB, so scan backwards over that window.
  const start = Math.max(0, buffer.length - (minimum + 0xffff));
  for (let offset = buffer.length - minimum; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_SIG) return offset;
  }
  throw new ZipReadError('No zip central directory was found.');
}

export function readZipEntries(buffer: Buffer): ZipEntry[] {
  const endOffset = findEndRecord(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);

  if (entryCount > MAX_ENTRIES) {
    throw new ZipReadError(`The archive declares ${entryCount} entries, more than the ${MAX_ENTRIES} allowed.`);
  }
  if (directoryOffset >= buffer.length) throw new ZipReadError('The zip directory offset is out of range.');

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // directory entry
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipReadError(`"${name}" is larger than the ${MAX_ENTRY_BYTES / 1024 / 1024} MB per-entry limit.`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      throw new ZipReadError('The archive expands to more data than the reader will hold.');
    }

    entries.push({
      name,
      size: uncompressedSize,
      read: () => readEntryData(buffer, localOffset, method, compressedSize, uncompressedSize, name),
    });
  }

  return entries;
}

function readEntryData(
  buffer: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  name: string,
): Buffer {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
    throw new ZipReadError(`The local header for "${name}" is missing or malformed.`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (end > buffer.length) throw new ZipReadError(`"${name}" extends past the end of the archive.`);

  const raw = buffer.subarray(start, end);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    // maxOutputLength caps the inflated size inside zlib itself.
    return inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1024) + 1024 });
  }
  throw new ZipReadError(`"${name}" uses compression method ${method}, which is not supported.`);
}

/** The KML document inside a KMZ: doc.kml by convention, else the first .kml. */
export function findKmlInKmz(buffer: Buffer): { name: string; xml: string } | null {
  const entries = readZipEntries(buffer);
  const preferred =
    entries.find((entry) => entry.name.toLowerCase() === 'doc.kml') ??
    entries.find((entry) => entry.name.toLowerCase().endsWith('.kml'));
  if (!preferred) return null;
  return { name: preferred.name, xml: preferred.read().toString('utf8') };
}
