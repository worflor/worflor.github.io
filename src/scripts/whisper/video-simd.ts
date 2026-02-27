/**
 * WASM SIMD accelerator for the Whisper Video Codec.
 *
 * All pixel-level hot-path functions run in hand-written WebAssembly
 * with v128 SIMD (where applicable). WASM is REQUIRED — no JS fallback.
 *
 * Zero external dependencies — the WASM binary is embedded in video-simd-bin.ts.
 */

import { VIDEO_SIMD_WASM } from "./video-simd-bin";

// ── WASM instance types ──────────────────────────────────────────────

interface VideoSimdExports {
    mem: WebAssembly.Memory;
    BUF_START: WebAssembly.Global;
    ensure_pages(pages: number): void;
    pq_forward(ptr: number, len: number): void;
    pq_inverse(ptr: number, len: number): void;
    compute_delta(src: number, prev: number, dst: number, len: number): void;
    apply_delta(delta: number, prev: number, dst: number, len: number): void;
    zigzag_encode(ptr: number, len: number): void;
    zigzag_decode(ptr: number, len: number): void;
    rgba_to_yuv420(rgba: number, yuv: number, w: number, h: number): void;
    yuv420_to_rgba_bilinear(yuv: number, rgba: number, w: number, h: number): void;
    quantize_chroma_f(src: number, dst: number, ySamples: number, totalLen: number, yInv: number, uvInv: number): void;
    dequantize_chroma_f(src: number, dst: number, ySamples: number, totalLen: number, yStep: number, uvStep: number): void;
    quantize_chroma_signed_f(src: number, dst: number, ySamples: number, totalLen: number, yInv: number, uvInv: number, yDZ: number, uvDZ: number): void;
    dequantize_chroma_signed_f(src: number, dst: number, ySamples: number, totalLen: number, yStep: number, uvStep: number): void;
    build_block_bitmap(yDelta: number, w: number, h: number, blockSize: number, threshold: number, bitmapPtr: number): number;
    extract_changed_blocks(data: number, planeW: number, planeH: number, bitmap: number, blocksX: number, blocksY: number, planeBlockSize: number, dst: number): number;
    reinsert_changed_blocks(blockData: number, readStart: number, planeW: number, planeH: number, bitmap: number, blocksX: number, blocksY: number, planeBlockSize: number, base: number): number;
    dither_plane(yuv: number, off: number, stride: number, rows: number, step: number): void;
    frc_dither(yuv: number, w: number, h: number, baseStrength: number, offX: number, offY: number): void;
}

// ── Singleton WASM instance ──────────────────────────────────────────

let wasm: VideoSimdExports | null = null;
let wasmMem: Uint8Array | null = null;
let bufStart = 576;

/** 4x4 Bayer ordered dithering matrix — written to WASM memory at offset 512
 *  for use by dither_plane() and frc_dither() (16 f32 = 64 bytes). */
const BAYER4 = new Float32Array([
    0 / 16, 8 / 16, 2 / 16, 10 / 16,
    12 / 16, 4 / 16, 14 / 16, 6 / 16,
    3 / 16, 11 / 16, 1 / 16, 9 / 16,
    15 / 16, 7 / 16, 13 / 16, 5 / 16,
]);

/** Instantiate the SIMD WASM module. Returns true on success. */
export function initVideoSimd(): boolean {
    if (wasm) return true;
    try {
        const mod = new WebAssembly.Module(VIDEO_SIMD_WASM);
        const inst = new WebAssembly.Instance(mod);
        wasm = inst.exports as unknown as VideoSimdExports;
        wasmMem = new Uint8Array(wasm.mem.buffer);
        bufStart = wasm.BUF_START.value as number;
        // Write Bayer table into WASM memory at offset 512 (16 f32 = 64 bytes)
        const bayerView = new Float32Array(wasm.mem.buffer, 512, 16);
        bayerView.set(BAYER4);
        return true;
    } catch {
        return false;
    }
}

export function hasVideoSimd(): boolean { return wasm !== null; }

// ── Memory helpers ───────────────────────────────────────────────────

function ensure(bytesNeeded: number): void {
    const totalNeeded = bufStart + bytesNeeded;
    const pagesNeeded = Math.ceil(totalNeeded / 65536);
    wasm!.ensure_pages(pagesNeeded);
    if (wasmMem!.buffer !== wasm!.mem.buffer) {
        wasmMem = new Uint8Array(wasm!.mem.buffer);
    }
}

function w(data: Uint8Array, offset: number): void { wasmMem!.set(data, offset); }
function r(offset: number, length: number): Uint8Array { return new Uint8Array(wasmMem!.buffer.slice(offset, offset + length)); }

// ── PQ table initialization ──────────────────────────────────────────

let pqInit = false;

export function initPqTables(pqFwd: Uint8Array, pqInv: Uint8Array): void {
    if (!wasm || pqInit) return;
    wasmMem!.set(pqFwd, 0);
    wasmMem!.set(pqInv, 256);
    pqInit = true;
}

// ── Exported WASM-accelerated functions ──────────────────────────────

export function pqForward(data: Uint8Array, offset: number, count: number): void {
    ensure(data.length);
    const p = bufStart;
    w(data, p);
    wasm!.pq_forward(p + offset, count);
    data.set(wasmMem!.subarray(p, p + data.length));
}

export function pqInverse(data: Uint8Array, offset: number, count: number): void {
    ensure(data.length);
    const p = bufStart;
    w(data, p);
    wasm!.pq_inverse(p + offset, count);
    data.set(wasmMem!.subarray(p, p + data.length));
}

export function computeDelta(current: Uint8Array, previous: Uint8Array): Uint8Array {
    const len = current.length;
    ensure(len * 3);
    const s = bufStart, pr = s + len, d = pr + len;
    w(current, s); w(previous, pr);
    wasm!.compute_delta(s, pr, d, len);
    return r(d, len);
}

export function applyDelta(delta: Uint8Array, previous: Uint8Array): Uint8Array {
    const len = delta.length;
    ensure(len * 3);
    const dp = bufStart, pr = dp + len, dst = pr + len;
    w(delta, dp); w(previous, pr);
    wasm!.apply_delta(dp, pr, dst, len);
    return r(dst, len);
}

export function zigzagEncode(data: Uint8Array): void {
    ensure(data.length);
    const p = bufStart;
    w(data, p);
    wasm!.zigzag_encode(p, data.length);
    data.set(wasmMem!.subarray(p, p + data.length));
}

export function zigzagDecode(data: Uint8Array): void {
    ensure(data.length);
    const p = bufStart;
    w(data, p);
    wasm!.zigzag_decode(p, data.length);
    data.set(wasmMem!.subarray(p, p + data.length));
}

export function rgbaToYuv420(rgba: Uint8Array, width: number, height: number): Uint8Array {
    const rgbaSize = width * height * 4;
    const yuvSize = width * height + (width >> 1) * (height >> 1) * 2;
    ensure(rgbaSize + yuvSize);
    const rp = bufStart, yp = rp + rgbaSize;
    w(rgba, rp);
    wasm!.rgba_to_yuv420(rp, yp, width, height);
    return r(yp, yuvSize);
}

export function yuv420ToRgba(yuv: Uint8Array, width: number, height: number): Uint8Array {
    const yuvSize = yuv.length;
    const rgbaSize = width * height * 4;
    ensure(yuvSize + rgbaSize);
    const yp = bufStart, rp = yp + yuvSize;
    w(yuv, yp);
    wasm!.yuv420_to_rgba_bilinear(yp, rp, width, height);
    return r(rp, rgbaSize);
}

export function quantizeChroma(data: Uint8Array, ySamples: number, yInv: number, uvInv: number): Uint8Array {
    ensure(data.length * 2);
    const s = bufStart, d = s + data.length;
    w(data, s);
    wasm!.quantize_chroma_f(s, d, ySamples, data.length, yInv, uvInv);
    return r(d, data.length);
}

export function dequantizeChroma(data: Uint8Array, ySamples: number, yStep: number, uvStep: number): Uint8Array {
    ensure(data.length * 2);
    const s = bufStart, d = s + data.length;
    w(data, s);
    wasm!.dequantize_chroma_f(s, d, ySamples, data.length, yStep, uvStep);
    return r(d, data.length);
}

export function quantizeChromaSigned(data: Uint8Array, ySamples: number, yInv: number, uvInv: number, yDZ: number, uvDZ: number): Uint8Array {
    ensure(data.length * 2);
    const s = bufStart, d = s + data.length;
    w(data, s);
    wasm!.quantize_chroma_signed_f(s, d, ySamples, data.length, yInv, uvInv, yDZ, uvDZ);
    return r(d, data.length);
}

export function dequantizeChromaSigned(data: Uint8Array, ySamples: number, yStep: number, uvStep: number): Uint8Array {
    ensure(data.length * 2);
    const s = bufStart, d = s + data.length;
    w(data, s);
    wasm!.dequantize_chroma_signed_f(s, d, ySamples, data.length, yStep, uvStep);
    return r(d, data.length);
}

export function buildBlockBitmap(
    yDelta: Uint8Array, width: number, height: number, blockSize: number, threshold: number
): { bitmap: Uint8Array; blocksX: number; blocksY: number; changedCount: number } {
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const bitmapSize = Math.ceil(blocksX * blocksY / 8);
    ensure(yDelta.length + bitmapSize);
    const dp = bufStart, bp = dp + yDelta.length;
    w(yDelta, dp);
    const changedCount = wasm!.build_block_bitmap(dp, width, height, blockSize, threshold, bp);
    return { bitmap: r(bp, bitmapSize), blocksX, blocksY, changedCount };
}

export function extractChangedBlocksPlane(
    data: Uint8Array, planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    planeBlockSize: number
): Uint8Array {
    const maxOut = blocksX * blocksY * planeBlockSize * planeBlockSize;
    ensure(data.length + bitmap.length + maxOut);
    const dp = bufStart, bp = dp + data.length, op = bp + bitmap.length;
    w(data, dp); w(bitmap, bp);
    const written = wasm!.extract_changed_blocks(dp, planeW, planeH, bp, blocksX, blocksY, planeBlockSize, op);
    return r(op, written);
}

export function reinsertChangedBlocksPlane(
    blockData: Uint8Array, readStart: number,
    planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    planeBlockSize: number, base: Uint8Array
): number {
    ensure(blockData.length + bitmap.length + base.length);
    const bdp = bufStart, bp = bdp + blockData.length, basep = bp + bitmap.length;
    w(blockData, bdp); w(bitmap, bp); w(base, basep);
    const newReadPos = wasm!.reinsert_changed_blocks(bdp, readStart, planeW, planeH, bp, blocksX, blocksY, planeBlockSize, basep);
    base.set(wasmMem!.subarray(basep, basep + base.length));
    return newReadPos;
}

export function ditherYUV(yuv: Uint8Array, width: number, height: number, yStep: number, uvStep: number): void {
    const ySize = width * height;
    const uvW = width >> 1, uvH = height >> 1;
    const uvSize = uvW * uvH;
    ensure(yuv.length);
    const p = bufStart;
    w(yuv, p);
    wasm!.dither_plane(p, 0, width, height, yStep);
    wasm!.dither_plane(p, ySize, uvW, uvH, uvStep);
    wasm!.dither_plane(p, ySize + uvSize, uvW, uvH, uvStep);
    yuv.set(wasmMem!.subarray(p, p + yuv.length));
}

const FRC_OFFSETS = [[0, 0], [2, 1], [1, 2], [3, 3]];

export function frcDither(yuv: Uint8Array, width: number, height: number, baseStrength: number, frameNum: number): void {
    if (baseStrength < 0.01) return;
    ensure(yuv.length);
    const p = bufStart;
    w(yuv, p);
    const [offX, offY] = FRC_OFFSETS[frameNum & 3];
    wasm!.frc_dither(p, width, height, baseStrength, offX, offY);
    yuv.set(wasmMem!.subarray(p, p + yuv.length));
}
