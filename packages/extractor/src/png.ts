/**
 * Just enough PNG to read a mod's textures and write a rendered sprite back out.
 *
 * The extractor has no dependencies and this is not a reason to take one: resource-pack textures
 * are small, non-interlaced and almost always 8-bit RGBA or palette, and `node:zlib` does the
 * only hard part. Anything outside that — interlacing, 16-bit channels — decodes to `undefined`
 * and the caller treats the texture as missing.
 */

import { deflateSync, inflateSync } from "node:zlib";

export type Image = { width: number; height: number; /** RGBA, row-major. */ data: Uint8Array };

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(bytes: Buffer): Image | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const idat: Buffer[] = [];

  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (width === 0 || height === 0 || interlace !== 0) return undefined;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) return undefined;
  if (colorType === 3 ? ![1, 2, 4, 8].includes(bitDepth) : bitDepth !== 8) return undefined;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, (channels * bitDepth) / 8);
  if (raw.length < (stride + 1) * height) return undefined;

  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[out + x - bpp]! : 0;
      const b = y > 0 ? rows[out - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? rows[out - stride + x - bpp]! : 0;
      let value = raw[src + x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[out + x] = value & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = y * stride + x * channels;
      if (colorType === 6) data.set(rows.subarray(i, i + 4), o);
      else if (colorType === 2) {
        data.set(rows.subarray(i, i + 3), o);
        data[o + 3] = 255;
      } else if (colorType === 0 || colorType === 4) {
        data[o] = data[o + 1] = data[o + 2] = rows[i]!;
        data[o + 3] = colorType === 4 ? rows[i + 1]! : 255;
      } else {
        const bit = x * bitDepth;
        const index = (rows[y * stride + (bit >> 3)]! >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
        if (palette === undefined || index * 3 + 2 >= palette.length) return undefined;
        data[o] = palette[index * 3]!;
        data[o + 1] = palette[index * 3 + 1]!;
        data[o + 2] = palette[index * 3 + 2]!;
        data[o + 3] = transparency !== undefined && index < transparency.length ? transparency[index]! : 255;
      }
    }
  }
  return { width, height, data };
}

export function encodePng(image: Image): Buffer {
  const { width, height, data } = image;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
