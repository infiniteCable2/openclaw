import { promisify } from "node:util";
import { crc32, deflate, deflateSync } from "node:zlib";

const deflateAsync = promisify(deflate);

/** Keep chunk parts separate so final assembly copies compressed data only once. */
function pngChunkParts(type: string, data: Buffer): Buffer[] {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(data, crc32(header.subarray(4))), 0);
  return [header, data, crcBuf];
}

/**
 * Writes one RGBA pixel into a width-strided buffer.
 * Out-of-bounds coordinates are ignored so fixture drawing code can clip shapes cheaply.
 */
export function fillPixel(
  buf: Buffer,
  x: number,
  y: number,
  width: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  if (x < 0 || y < 0 || x >= width) {
    return;
  }
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx + 3 >= buf.length) {
    return;
  }
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function buildScanlines(buffer: Buffer, width: number, height: number, channels: 3 | 4): Buffer {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 25_000_000 / height ||
    buffer.byteLength !== width * height * channels
  ) {
    throw new Error("PNG requires bounded, tightly packed RGB/RGBA pixels");
  }
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    // Each scanline starts with PNG filter byte 0 so raw RGB/RGBA rows stay literal.
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  return raw;
}

function assemblePng(compressed: Buffer, width: number, height: number, channels: 3 | 4): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type RGB/RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    ...pngChunkParts("IHDR", ihdr),
    ...pngChunkParts("IDAT", compressed),
    ...pngChunkParts("IEND", Buffer.alloc(0)),
  ]);
}

/** Encodes tightly packed RGB bytes (`width * height * 3`) as a PNG image. */
export function encodePngRgb(buffer: Buffer, width: number, height: number): Buffer {
  return assemblePng(deflateSync(buildScanlines(buffer, width, height, 3)), width, height, 3);
}

/** Encodes tightly packed RGBA bytes (`width * height * 4`) as a PNG image. */
export function encodePngRgba(buffer: Buffer, width: number, height: number): Buffer {
  return assemblePng(deflateSync(buildScanlines(buffer, width, height, 4)), width, height, 4);
}

/** Live capture compresses on libuv workers instead of blocking the audio event loop. */
export async function encodePngRgbaAsync(
  buffer: Buffer,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const compressed = await deflateAsync(buildScanlines(buffer, width, height, 4));
  signal?.throwIfAborted();
  return assemblePng(compressed, width, height, 4);
}
