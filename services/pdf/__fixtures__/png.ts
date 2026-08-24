import { deflateSync } from "node:zlib";

/**
 * Minimal, dependency-free PNG encoder used ONLY to build small, deterministic
 * raster-image fixtures for Phase 3.1 compression tests (scanned/image-only,
 * image-heavy, mixed, and high-resolution fixtures). This intentionally does
 * NOT use `document.createElement("canvas")` — canvas/DOM APIs are not
 * available in the Node/vitest environment this project's test suite runs
 * in (no `jsdom`/`canvas` package is installed; see
 * docs/PHASE_3_1_COMPRESSION_BASELINE.md). Node's built-in `zlib` module is
 * used for the required PNG DEFLATE stream instead.
 *
 * Output is a standard 8-bit RGB, non-interlaced, filter-type-0 PNG. This is
 * test-fixture infrastructure only and is never imported by application
 * code under services/pdf/*.ts (excluding this __fixtures__ directory).
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Standard CRC-32 (ISO 3309 / ITU-T V.42) used by every PNG chunk.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

export type PixelFn = (x: number, y: number) => [number, number, number];

/**
 * Encodes an 8-bit RGB PNG of the given dimensions. `pixel(x, y)` returns
 * the `[r, g, b]` triple (0-255) for that coordinate. For solid-color or
 * simple-gradient fixtures this compresses to a very small buffer via
 * zlib, keeping generated fixtures cheap even at "high-resolution scan"
 * dimensions.
 */
export function encodePng(
  width: number,
  height: number,
  pixel: PixelFn,
): Buffer {
  if (width <= 0 || height <= 0) {
    throw new Error("PNG width/height must be positive.");
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: 2 = truecolor (RGB)
  ihdr.writeUInt8(0, 10); // compression method
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace method: none

  // Raw scanlines: each row prefixed with filter-type byte 0 (None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None

    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Solid-color PNG — the common case for these fixtures (compresses to a few hundred bytes). */
export function solidColorPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  return encodePng(width, height, () => rgb);
}

/** Simple diagonal-banded gradient PNG, for fixtures that shouldn't be flat-uniform. */
export function bandedGradientPng(width: number, height: number): Buffer {
  return encodePng(width, height, (x, y) => {
    const band = Math.floor(((x + y) / (width + height)) * 6) % 6;
    const palette: [number, number, number][] = [
      [220, 60, 60],
      [60, 160, 220],
      [60, 200, 120],
      [230, 200, 60],
      [160, 90, 210],
      [240, 140, 60],
    ];
    return palette[band];
  });
}
