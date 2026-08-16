/**
 * Minimal ZIP reader for jars and resource packs.
 *
 * Deliberately dependency-free and range-based: resources.zip in Craft to Exile 2 is
 * ~160 MB, so entries are read by offset rather than by slurping the archive. That also
 * keeps the Electron bundle free of native zip bindings.
 *
 * Supports the two compression methods jars actually use (stored + deflate) and ZIP64
 * end-of-central-directory records. Anything else fails loud.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Max size of the trailing region scanned for the end-of-central-directory record. */
const EOCD_SEARCH_LIMIT = 0xffff + 22;

export type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export class ZipArchive {
  readonly path: string;
  private readonly fd: number;
  private readonly entries: Map<string, ZipEntry>;

  private constructor(path: string, fd: number, entries: Map<string, ZipEntry>) {
    this.path = path;
    this.fd = fd;
    this.entries = entries;
  }

  static open(path: string): ZipArchive {
    const fd = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const { centralOffset, centralEntries } = readEndOfCentralDirectory(fd, size, path);
      const entries = readCentralDirectory(fd, centralOffset, centralEntries, path);
      return new ZipArchive(path, fd, entries);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  close(): void {
    closeSync(this.fd);
  }

  /** Entry names, in central-directory order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Entry names under `prefix` that end in `suffix`. Directory entries (trailing `/`)
   * are excluded, so callers never see the zero-length placeholders jars contain.
   */
  find(prefix: string, suffix = ""): string[] {
    const out: string[] = [];
    for (const name of this.entries.keys()) {
      if (name.endsWith("/")) continue;
      if (!name.startsWith(prefix)) continue;
      if (suffix && !name.endsWith(suffix)) continue;
      out.push(name);
    }
    return out;
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`${this.path}: no such zip entry: ${name}`);

    // The central directory's name/extra lengths need not match the local header's, so
    // the data offset is resolved from the local header rather than assumed.
    const local = readAt(this.fd, entry.localHeaderOffset, 30, this.path);
    if (local.readUInt32LE(0) !== SIG_LOCAL) {
      throw new Error(`${this.path}: bad local header for ${name}`);
    }
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLen + extraLen;

    const raw = readAt(this.fd, dataOffset, entry.compressedSize, this.path);

    switch (entry.compressionMethod) {
      case METHOD_STORED:
        return raw;
      case METHOD_DEFLATE:
        return inflateRawSync(raw);
      default:
        throw new Error(
          `${this.path}: unsupported compression method ${entry.compressionMethod} for ${name}`,
        );
    }
  }

  readText(name: string): string {
    // Minecraft data and lang files are UTF-8; strip a BOM so JSON.parse doesn't choke.
    return this.read(name).toString("utf8").replace(/^﻿/, "");
  }
}

function readAt(fd: number, offset: number, length: number, path: string): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) throw new Error(`${path}: unexpected EOF at ${offset + read}`);
    read += n;
  }
  return buf;
}

function readEndOfCentralDirectory(
  fd: number,
  size: number,
  path: string,
): { centralOffset: number; centralEntries: number } {
  const tailLength = Math.min(size, EOCD_SEARCH_LIMIT);
  const tail = readAt(fd, size - tailLength, tailLength, path);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path}: not a zip archive (no end-of-central-directory record)`);

  let centralEntries = tail.readUInt16LE(eocd + 10);
  let centralOffset = tail.readUInt32LE(eocd + 16);

  // 0xffff/0xffffffff are ZIP64 sentinels. Craft to Exile 2's archives are under the
  // limits today, but resources.zip is already 160 MB and growing, so handle it.
  const needsZip64 = centralEntries === 0xffff || centralOffset === 0xffffffff;
  if (needsZip64) {
    const locatorOffset = size - tailLength + eocd - 20;
    if (locatorOffset < 0) throw new Error(`${path}: ZIP64 sentinel but no locator`);
    const locator = readAt(fd, locatorOffset, 20, path);
    if (locator.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) {
      throw new Error(`${path}: ZIP64 sentinel but bad locator signature`);
    }
    const eocd64Offset = Number(locator.readBigUInt64LE(8));
    const eocd64 = readAt(fd, eocd64Offset, 56, path);
    if (eocd64.readUInt32LE(0) !== SIG_EOCD64) {
      throw new Error(`${path}: bad ZIP64 end-of-central-directory signature`);
    }
    centralEntries = Number(eocd64.readBigUInt64LE(32));
    centralOffset = Number(eocd64.readBigUInt64LE(48));
  }

  return { centralOffset, centralEntries };
}

function readCentralDirectory(
  fd: number,
  centralOffset: number,
  centralEntries: number,
  path: string,
): Map<string, ZipEntry> {
  const size = statSync(path).size;
  const central = readAt(fd, centralOffset, size - centralOffset, path);
  const entries = new Map<string, ZipEntry>();

  let p = 0;
  for (let i = 0; i < centralEntries; i++) {
    if (central.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`${path}: bad central directory entry ${i} at ${centralOffset + p}`);
    }
    const compressionMethod = central.readUInt16LE(p + 10);
    let compressedSize = central.readUInt32LE(p + 20);
    let uncompressedSize = central.readUInt32LE(p + 24);
    const nameLen = central.readUInt16LE(p + 28);
    const extraLen = central.readUInt16LE(p + 30);
    const commentLen = central.readUInt16LE(p + 32);
    let localHeaderOffset = central.readUInt32LE(p + 42);
    const name = central.toString("utf8", p + 46, p + 46 + nameLen);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      const extra = central.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      const zip64 = findZip64Extra(extra);
      if (!zip64) throw new Error(`${path}: ${name} has ZIP64 sentinel but no 0x0001 extra field`);
      let q = 0;
      if (uncompressedSize === 0xffffffff) uncompressedSize = Number(zip64.readBigUInt64LE(q)), (q += 8);
      if (compressedSize === 0xffffffff) compressedSize = Number(zip64.readBigUInt64LE(q)), (q += 8);
      if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(zip64.readBigUInt64LE(q));
    }

    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function findZip64Extra(extra: Buffer): Buffer | null {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) return extra.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  return null;
}
