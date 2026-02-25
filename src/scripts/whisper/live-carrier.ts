/**
 * Whisper Live — PNG carrier generation for Dressed mode.
 *
 * Creates a small 8x8 transparent PNG as a carrier for dressed messages.
 * This is used when the user doesn't provide their own carrier file.
 */

import { concatBytes } from "./wasm";
import { TE } from "./live-crypto";

const PNG_WIDTH = 8;
const PNG_HEIGHT = 8;
const PNG_CHANNELS = 4;
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_TYPE_RGBA = 6;
const PNG_COMPRESSION_DEFLATE = 0;
const PNG_FILTER_ADAPTIVE = 0;
const PNG_INTERLACE_NONE = 0;

const ZLIB_CMF = 0x78;
const ZLIB_FLG = 0x01;
const ADLER_MOD = 65521;

export function createMinimalPNGCarrier(): Uint8Array {
  // 8x8 RGBA transparent PNG
  // Pre-built minimal valid PNG bytes
  const header = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
  ]);

  // IHDR chunk: 8x8, 8-bit RGBA
  const ihdr = pngChunk("IHDR", (() => {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, PNG_WIDTH); // width
    view.setUint32(4, PNG_HEIGHT); // height
    data[8] = PNG_BIT_DEPTH;
    data[9] = PNG_COLOR_TYPE_RGBA;
    data[10] = PNG_COMPRESSION_DEFLATE;
    data[11] = PNG_FILTER_ADAPTIVE;
    data[12] = PNG_INTERLACE_NONE;
    return data;
  })());

  // IDAT chunk: 8 rows of 8 pixels, all zero (transparent)
  // Each row: filter byte (0) + 32 bytes (8 pixels * 4 channels)
  const rawData = new Uint8Array(PNG_HEIGHT * (1 + PNG_WIDTH * PNG_CHANNELS)); // all zeros = transparent

  // Compress with deflate (store block, no compression for simplicity)
  const deflated = deflateStore(rawData);

  const idat = pngChunk("IDAT", deflated);
  const iend = pngChunk("IEND", new Uint8Array(0));

  return concatBytes(header, ihdr, idat, iend);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = TE.encode(type);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);

  // Length
  view.setUint32(0, data.length);

  // Type
  chunk.set(typeBytes, 4);

  // Data
  chunk.set(data, 8);

  // CRC32 over type + data
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);

  return chunk;
}

function deflateStore(data: Uint8Array): Uint8Array {
  // Zlib wrapper with store (no compression) deflate blocks
  // Header: CMF=0x78, FLG=0x01
  const maxBlock = 65535;
  const blocks: Uint8Array[] = [];
  let offset = 0;

  while (offset < data.length) {
    const remaining = data.length - offset;
    const blockSize = Math.min(maxBlock, remaining);
    const isLast = offset + blockSize >= data.length;

    const blockHeader = new Uint8Array(5);
    blockHeader[0] = isLast ? 0x01 : 0x00;
    blockHeader[1] = blockSize & 0xFF;
    blockHeader[2] = (blockSize >> 8) & 0xFF;
    blockHeader[3] = ~blockSize & 0xFF;
    blockHeader[4] = (~blockSize >> 8) & 0xFF;

    blocks.push(blockHeader);
    blocks.push(data.subarray(offset, offset + blockSize));
    offset += blockSize;
  }

  // Adler-32 checksum
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % ADLER_MOD;
    b = (b + a) % ADLER_MOD;
  }
  const adler = new Uint8Array(4);
  const adlerView = new DataView(adler.buffer);
  adlerView.setUint32(0, (b << 16) | a);

  return concatBytes(new Uint8Array([ZLIB_CMF, ZLIB_FLG]), ...blocks, adler);
}

// CRC32 lookup table
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
