/**
 * live-wasm-glyph.ts
 *
 * the Whisper Glyph 7D Kinetic Stroke Engine... 'Codec' by Woflo / MB
 *
 * models human pen strokes as a damped harmonic oscillator in the complex
 * plane. (x, y) coordinates form a single complex number z = x + iy.
 * the predictor for sample n:
 *
 *   z[n] = K · z[n-1] − G · z[n-2]
 *
 * K, G are complex coefficients fitted per 16-sample block via complex
 * least-squares (2×2 Hermitian normal equation, Cramer solution) with
 * Tikhonov regularization on the diagonal. the regularization scales
 * with the data magnitude, preventing ill-conditioned fits from producing
 * wild coefficients regardless of coordinate range. after quantization,
 * the eigenvalue product and sum are clamped to the stability manifold
 * (|G| <= 1, |K| <= 2) so the oscillator never diverges.
 *
 * sidecar channels ride alongside with their own linear predictors:
 *   c[n] = 2·c[n-1] − c[n-2]
 *
 * the seven dimensions:
 *   x  (explicit)  horizontal position, complex real part
 *   y  (explicit)  vertical position, complex imaginary part
 *   p  (explicit)  pressure / force, real sidecar
 *   θ  (explicit)  tilt / altitude angle, real sidecar
 *   φ  (explicit)  azimuth angle, real sidecar
 *   t  (implicit)  time = sample index
 *   s  (implicit)  stroke identity = stream instance
 *
 * a circle has K = e^{iθ}, G = 0. a spiral has K = r·e^{iθ}. an ellipse
 * needs both K and G. curvature and damping live in the same algebraic
 * object: the eigenvalues λ₁, λ₂ of the characteristic equation
 * λ² − Kλ + G = 0 give the natural frequencies of the stroke segment.
 * the residuals are where intent departs from the hand's dynamics.
 *
 * tilt and azimuth capture the pen's orientation in space: altitude
 * angle (0 = parallel to surface, π/2 = perpendicular) and compass
 * direction the pen barrel points. these affect brush shape in rendering
 * and encode the hand's posture, not just its path.
 *
 * ── implementation ────────────────────────────────────────────────────
 *
 * the predictor core (fit, encode, decode, zigzag, stability clamp)
 * is hand-written WebAssembly (glyph.wat → glyph.wasm, 2001 bytes).
 * the WASM binary is inlined below as base64. zero dependencies beyond
 * Logos.
 *
 * WASM memory layout (1 page = 64KB):
 *   POINTS  0x0000  i32[10240]  2048 pts × 5 channels
 *   RESID   0xA000  i32[80]     16 pts × 5 channels
 *
 * WASM globals: kR, kI, gR, gI (Q14 i32), errSum (i32).
 * WASM functions: fit, encodeBlock, decodeBlock.
 * prediction uses f64 internally (overflow-safe for any coordinate range).
 * Q14 division uses f64.nearest (round-to-even) for unbiased residuals.
 *
 * ── mode selection ──────────────────────────────────────────────────────
 *
 * per-block choice between three predictors, by estimated byte cost:
 *   HARMONIC : complex oscillator (4 Q14 coefficients, 8 bytes header).
 *              wins for curves, arcs, spirals, anything with rotation.
 *   LINEAR   : z[n] = 2·z[n-1] − z[n-2] (constant-velocity extrapolation).
 *              degenerate case K=2, G=1. wins for straight segments.
 *   REPEAT   : same oscillator coefficients as the previous block (0 bytes
 *              header). wins when curvature is stable across consecutive
 *              blocks, which is the common case for smooth arcs and curves
 *              in handwriting and vector art.
 *
 * ── residual coding (Logos tower) ───────────────────────────────────────
 *
 * residuals are zigzag-encoded and serialized as LEB128 varints, then
 * the full byte stream goes through Logos (encode0D) for entropy coding.
 * same tower pattern as the spatial codecs:
 *
 *   Glyph (complex oscillator) → residuals → Logos (0D entropy)
 *
 * Logos picks up the peaked-around-zero distribution via L-axis
 * crystallization, inter-residual correlation via U-axis AR(2), x/y/p
 * interleaving structure via X-axis magnitude conditioning, and repeated
 * gesture patterns via M-axis exact matching. that last one means Logos
 * learns handwriting vocabulary with zero font knowledge.
 *
 * ── wire format ─────────────────────────────────────────────────────────
 *
 *   [rawLen:2 LE] [encode0D(serialized blocks)]
 *
 * block serialization:
 *   [header:1 byte]  mode(bit 0) | (count-1)(bits 1-4) | repeat(bit 5)
 *                    | chMask(bits 6-7)
 *   [coeffs:8 bytes] kR, kI, gR, gI as u16 LE (harmonic only, not repeat)
 *   [residuals]      zigzag LEB128 varints, N per point where N depends on chMask
 *
 * chMask (dimensional collapse):
 *   0b00: 5 channels (x, y, p, tilt, azimuth) — full stylus
 *   0b01: 3 channels (x, y, p) — basic stylus, no orientation
 *   0b10: 2 channels (x, y) — mouse/finger, position only
 *   0b11: reserved
 *
 * when entire dimensions are inactive (zero residuals across the whole block),
 * they collapse out of the wire format. this is the same anti-causal boundary
 * physics as the spatial codecs: known-zero values need not be transmitted.
 * mouse-mode Glyph gets 60% free zeros from dimensional collapse, comparable
 * to 16D Kizuna's 64% from Mobius boundary faces.
 *
 * ── streaming ───────────────────────────────────────────────────────────
 *
 * GlyphStreamEncoder accumulates points and emits compressed blocks of 16.
 * GlyphStreamDecoder reconstructs points from each block. since time IS
 * the sample index, decoding is playback. the receiver watches the stroke
 * unfold point by point, as a gesture in time.
 *
 * the wire carries oscillator eigenvalues. the decoder reconstructs
 * trajectories through 7D phase space from intent residuals.
 */

import { encode0D, decode0D } from './live-wasm-logos';

export const GLYPH_BLOCK_SIZE = 16;

// channel layout: the codec is N-dimensional, these names are just the
// physical interpretation. everything else indexes by position, not name.
export const GLYPH_CHANNEL_NAMES = ['x', 'y', 'p', 'tilt', 'azimuth'] as const;
export const GLYPH_CHANNELS = GLYPH_CHANNEL_NAMES.length;

export type GlyphChannelName = typeof GLYPH_CHANNEL_NAMES[number];

export enum GlyphMode {
    HARMONIC = 0,
    LINEAR = 1,
    REPEAT = 2
}

export interface GlyphCoeffs {
    kR: number;
    kI: number;
    gR: number;
    gI: number;
}

export interface GlyphBlock {
    mode: GlyphMode;
    kR: number;
    kI: number;
    gR: number;
    gI: number;
    residuals: Int32Array;
}

// seed is just GLYPH_CHANNELS values in channel order
export type GlyphSeed = number[];

// ── inlined WASM binary (glyph.wasm, 1788 bytes) ────────────────────────────

const WASM_B64 = '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';

// ── WASM module singleton ─────────────────────────────────────────────────────

interface GlyphWasm {
    mem: WebAssembly.Memory;
    POINTS: WebAssembly.Global;
    RESID: WebAssembly.Global;
    kR: WebAssembly.Global;
    kI: WebAssembly.Global;
    gR: WebAssembly.Global;
    gI: WebAssembly.Global;
    errSum: WebAssembly.Global;
    fit: (start: number, len: number) => void;
    encodeBlock: (start: number, len: number, mode: number) => number;
    decodeBlock: (cursor: number, count: number, mode: number,
                  kR: number, kI: number, gR: number, gI: number) => void;
}

let _w: GlyphWasm | null = null;

function b64decode(s: string): Uint8Array {
    if (typeof atob === 'function') {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
}

function w(): GlyphWasm {
    if (_w) return _w;
    const bytes = b64decode(WASM_B64);
    const mod = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    const inst = new WebAssembly.Instance(mod);
    _w = inst.exports as unknown as GlyphWasm;
    return _w;
}

function gval(g: WebAssembly.Global): number { return (g as any).value as number; }

// ── codec ─────────────────────────────────────────────────────────────────────

const CH = GLYPH_CHANNELS;  // shorthand for channel arithmetic

export class GlyphCodec {

    // ── varint (LEB128 unsigned, for serialization) ───────────────────────

    private static pushVarint(buf: number[], v: number): void {
        v >>>= 0;
        while (v >= 0x80) { buf.push((v & 0x7F) | 0x80); v >>>= 7; }
        buf.push(v & 0x7F);
    }

    private static readVarint(data: Uint8Array, off: { v: number }): number {
        let result = 0, shift = 0;
        while (off.v < data.length) {
            const b = data[off.v++];
            result |= (b & 0x7F) << shift;
            if (!(b & 0x80)) return result >>> 0;
            shift += 7;
            if (shift >= 35) break;
        }
        return result >>> 0;
    }

    private static push16(buf: number[], v: number): void {
        buf.push(v & 0xFF, (v >> 8) & 0xFF);
    }

    private static read16(data: Uint8Array, off: { v: number }): number {
        const lo = data[off.v++], hi = data[off.v++];
        return lo | (hi << 8);
    }

    // ── encode (WASM predictor, 3-mode trial) ─────────────────────────────

    static encode(points: Int32Array, prev?: GlyphCoeffs): GlyphBlock[] {
        const m = w();
        // cap to WASM POINTS capacity (2048 pts × 5ch)
        const maxPts = 2048;
        const nPts = Math.min(Math.floor(points.length / CH), maxPts);
        const pointsOff = gval(m.POINTS) >> 2;
        const residOff = gval(m.RESID) >> 2;
        const heap = new Int32Array(m.mem.buffer);

        heap.set(points.subarray(0, nPts * CH), pointsOff);

        const blocks: GlyphBlock[] = [];
        let prevKR = prev?.kR ?? 0, prevKI = prev?.kI ?? 0;
        let prevGR = prev?.gR ?? 0, prevGI = prev?.gI ?? 0;
        let hasPrev = !!prev;

        for (let i = 2; i < nPts; i += GLYPH_BLOCK_SIZE) {
            const len = Math.min(GLYPH_BLOCK_SIZE, nPts - i);
            if (len < 1) break;

            // trial all modes, collect cost + error only (no residual copy).
            // re-encode the winner once to get residuals.

            // harmonic: fit + encode
            m.fit(i - 2, len + 2);
            const hCost = m.encodeBlock(i, len, GlyphMode.HARMONIC);
            const hErr = gval(m.errSum);
            const hKR = gval(m.kR), hKI = gval(m.kI);
            const hGR = gval(m.gR), hGI = gval(m.gI);

            // linear: encode
            const lCost = m.encodeBlock(i, len, GlyphMode.LINEAR);
            const lErr = gval(m.errSum);

            // repeat: encode with previous block's coefficients
            let rCost = Infinity, rErr = Infinity;
            if (hasPrev) {
                (m.kR as any).value = prevKR;
                (m.kI as any).value = prevKI;
                (m.gR as any).value = prevGR;
                (m.gI as any).value = prevGI;
                rCost = m.encodeBlock(i, len, GlyphMode.REPEAT);
                rErr = gval(m.errSum);
            }

            // pick cheapest mode (break ties on error sum, then prefer simpler modes)
            let bestCost = hCost, bestErr = hErr, bestMode = GlyphMode.HARMONIC;
            if (lCost < bestCost || (lCost === bestCost && lErr <= bestErr)) {
                bestCost = lCost; bestErr = lErr; bestMode = GlyphMode.LINEAR;
            }
            if (rCost < bestCost || (rCost === bestCost && rErr <= bestErr)) {
                bestCost = rCost; bestErr = rErr; bestMode = GlyphMode.REPEAT;
            }

            // re-encode the winner to populate RESID, then copy once
            if (bestMode === GlyphMode.HARMONIC) {
                (m.kR as any).value = hKR;
                (m.kI as any).value = hKI;
                (m.gR as any).value = hGR;
                (m.gI as any).value = hGI;
                m.encodeBlock(i, len, GlyphMode.HARMONIC);
            } else if (bestMode === GlyphMode.REPEAT) {
                (m.kR as any).value = prevKR;
                (m.kI as any).value = prevKI;
                (m.gR as any).value = prevGR;
                (m.gI as any).value = prevGI;
                m.encodeBlock(i, len, GlyphMode.REPEAT);
            } else {
                m.encodeBlock(i, len, GlyphMode.LINEAR);
            }

            // single residual copy for the winning mode
            const residuals = new Int32Array(len * CH);
            for (let j = 0; j < len * CH; j++) residuals[j] = heap[residOff + j];

            if (bestMode === GlyphMode.LINEAR) {
                blocks.push({ mode: GlyphMode.LINEAR, kR: 0, kI: 0, gR: 0, gI: 0, residuals });
                hasPrev = false;
            } else if (bestMode === GlyphMode.REPEAT) {
                blocks.push({ mode: GlyphMode.REPEAT, kR: prevKR, kI: prevKI, gR: prevGR, gI: prevGI, residuals });
                // prevK/G unchanged
            } else {
                blocks.push({ mode: GlyphMode.HARMONIC, kR: hKR, kI: hKI, gR: hGR, gI: hGI, residuals });
                prevKR = hKR; prevKI = hKI; prevGR = hGR; prevGI = hGI;
                hasPrev = true;
            }
        }
        return blocks;
    }

    // ── decode (WASM predictor) ──────────────────────────────────────────

    static decode(blocks: GlyphBlock[], seed1: GlyphSeed, seed2: GlyphSeed): Int32Array {
        let total = 2;
        for (const b of blocks) total += b.residuals.length / CH;
        const out = new Int32Array(total * CH);
        out[0] = seed2[0]; out[1] = seed2[1]; out[2] = seed2[2]; out[3] = seed2[3]; out[4] = seed2[4];
        out[5] = seed1[0]; out[6] = seed1[1]; out[7] = seed1[2]; out[8] = seed1[3]; out[9] = seed1[4];
        this.decodeBlocks(blocks, out, 2);
        return out;
    }

    static decodeBlocks(blocks: GlyphBlock[], points: Int32Array, startIdx: number): void {
        const m = w();
        const pointsOff = gval(m.POINTS) >> 2;
        const residOff = gval(m.RESID) >> 2;
        const heap = new Int32Array(m.mem.buffer);

        // cap to WASM POINTS capacity (2048 pts × 5ch = 10240 i32s)
        const maxPts = 2048;
        const nExisting = Math.min(Math.floor(points.length / CH), maxPts);
        heap.set(points.subarray(0, nExisting * CH), pointsOff);

        let cursor = startIdx;
        for (const b of blocks) {
            const count = b.residuals.length / CH;
            if (cursor + count > nExisting) break;

            for (let j = 0; j < count * CH; j++) heap[residOff + j] = b.residuals[j];

            // repeat and harmonic both use oscillator prediction (mode 0 or 2).
            // linear uses mode 1. the WASM treats 0 and 2 identically (both
            // use the provided kR/kI/gR/gI).
            m.decodeBlock(cursor, count, b.mode, b.kR, b.kI, b.gR, b.gI);
            cursor += count;
        }

        for (let i = startIdx * CH; i < cursor * CH; i++) {
            points[i] = heap[pointsOff + i];
        }
    }

    // ── dimensional collapse detection ──────────────────────────────────
    // auto-detect which channels have all-zero residuals in a block.
    // inactive dimensions collapse out of the wire format (anti-causal
    // free zeros). returns the channel mask for header bits 6-7.

    private static detectChMask(residuals: Int32Array, count: number): number {
        // check tilt (ch 3) and azimuth (ch 4)
        for (let i = 0; i < count; i++) {
            if (residuals[i * CH + 3] !== 0 || residuals[i * CH + 4] !== 0) return 0b00;
        }
        // tilt and azimuth are zero. check pressure (ch 2).
        for (let i = 0; i < count; i++) {
            if (residuals[i * CH + 2] !== 0) return 0b01; // x, y, p only
        }
        return 0b10; // x, y only
    }

    // wire channel count from mask: 0b00→5, 0b01→3, 0b10→2
    private static maskChannels(mask: number): number {
        return mask === 0b10 ? 2 : mask === 0b01 ? 3 : CH;
    }

    // ── pack / unpack (serialization + Logos entropy coding) ─────────────

    static pack(blocks: GlyphBlock[]): Uint8Array {
        const buf: number[] = [];
        for (const b of blocks) {
            const count = b.residuals.length / CH;
            const chMask = this.detectChMask(b.residuals, count);
            const wireCh = this.maskChannels(chMask);

            // header byte: mode(bit 0) | (count-1)(bits 1-4) | repeat(bit 5) | chMask(bits 6-7)
            const isRepeat = b.mode === GlyphMode.REPEAT;
            const modeBit = isRepeat ? 0 : b.mode;
            const repeatBit = isRepeat ? (1 << 5) : 0;
            buf.push(modeBit | ((count - 1) << 1) | repeatBit | (chMask << 6));
            if (b.mode === GlyphMode.HARMONIC) {
                // bias Q14 i16 [-32768,32767] → u16 [0,65535] for unsigned wire format
                this.push16(buf, b.kR + 32768);
                this.push16(buf, b.kI + 32768);
                this.push16(buf, b.gR + 32768);
                this.push16(buf, b.gI + 32768);
            }
            // serialize only active channels (collapsed dimensions are free zeros)
            for (let i = 0; i < count; i++) {
                for (let c = 0; c < wireCh; c++) {
                    this.pushVarint(buf, b.residuals[i * CH + c]);
                }
            }
        }
        if (buf.length === 0) return new Uint8Array(0);
        const raw = new Uint8Array(buf);
        const compressed = encode0D(raw);
        const out = new Uint8Array(2 + compressed.length);
        out[0] = raw.length & 0xFF;
        out[1] = (raw.length >> 8) & 0xFF;
        out.set(compressed, 2);
        return out;
    }

    static unpack(bytes: Uint8Array): GlyphBlock[] {
        if (bytes.length < 3) return [];
        const rawLen = bytes[0] | (bytes[1] << 8);
        if (rawLen === 0) return [];
        const raw = decode0D(bytes.subarray(2), rawLen);
        const blocks: GlyphBlock[] = [];
        const off = { v: 0 };
        let prevKR = 0, prevKI = 0, prevGR = 0, prevGI = 0;
        try {
            while (off.v < raw.length) {
                const header = raw[off.v++];
                const modeBit = header & 1;
                const count = ((header >> 1) & 0xF) + 1;
                const isRepeat = (header & 0x20) !== 0;
                const chMask = (header >> 6) & 3;
                const wireCh = this.maskChannels(chMask);
                if (count > GLYPH_BLOCK_SIZE) break;
                let kR = 0, kI = 0, gR = 0, gI = 0;
                let mode: GlyphMode;
                if (isRepeat) {
                    mode = GlyphMode.REPEAT;
                    kR = prevKR; kI = prevKI; gR = prevGR; gI = prevGI;
                } else if (modeBit === GlyphMode.HARMONIC) {
                    mode = GlyphMode.HARMONIC;
                    if (off.v + 8 > raw.length) break;
                    // unbias u16 → Q14 i16
                    kR = this.read16(raw, off) - 32768;
                    kI = this.read16(raw, off) - 32768;
                    gR = this.read16(raw, off) - 32768;
                    gI = this.read16(raw, off) - 32768;
                    prevKR = kR; prevKI = kI; prevGR = gR; prevGI = gI;
                } else {
                    mode = GlyphMode.LINEAR;
                }
                // reconstruct full 5-channel residuals; collapsed channels stay zero
                const residuals = new Int32Array(count * CH);
                for (let i = 0; i < count; i++) {
                    for (let c = 0; c < wireCh; c++) {
                        residuals[i * CH + c] = this.readVarint(raw, off);
                    }
                }
                blocks.push({ mode, kR, kI, gR, gI, residuals });
            }
        } catch { }
        return blocks;
    }
}

// ── streaming ─────────────────────────────────────────────────────────────────

export class GlyphStreamEncoder {
    private buffer = new Int32Array(GLYPH_BLOCK_SIZE * CH + CH * 2);
    private head = 2;
    private prev: GlyphCoeffs | undefined;
    constructor(seed: GlyphSeed) {
        for (let c = 0; c < CH; c++) {
            this.buffer[c] = seed[c];
            this.buffer[CH + c] = seed[c];
        }
    }
    push(values: ArrayLike<number>): Uint8Array | null {
        const base = this.head * CH;
        for (let c = 0; c < CH; c++) this.buffer[base + c] = values[c];
        this.head++;
        if (this.head === GLYPH_BLOCK_SIZE + 2) {
            const blocks = GlyphCodec.encode(this.buffer, this.prev);
            const last = blocks[blocks.length - 1];
            if (last && last.mode !== GlyphMode.LINEAR) {
                this.prev = { kR: last.kR, kI: last.kI, gR: last.gR, gI: last.gI };
            } else {
                this.prev = undefined;
            }
            const bytes = GlyphCodec.pack(blocks);
            // carry last two points as seeds for next emission
            const s1off = (this.head - 1) * CH;
            const s2off = (this.head - 2) * CH;
            for (let c = 0; c < CH; c++) {
                this.buffer[c] = this.buffer[s2off + c];
                this.buffer[CH + c] = this.buffer[s1off + c];
            }
            this.head = 2; return bytes;
        }
        return null;
    }
    /** flush partial block. call on stroke end. */
    flush(): Uint8Array | null {
        if (this.head <= 2) return null;
        return GlyphCodec.pack(GlyphCodec.encode(this.buffer.slice(0, this.head * CH), this.prev));
    }
}

export class GlyphStreamDecoder {
    private points = new Int32Array(GLYPH_BLOCK_SIZE * CH + CH * 2);
    constructor(seed: GlyphSeed) {
        for (let c = 0; c < CH; c++) {
            this.points[c] = seed[c];
            this.points[CH + c] = seed[c];
        }
    }
    decode(bytes: Uint8Array): Int32Array {
        const blocks = GlyphCodec.unpack(bytes);
        if (blocks.length === 0) return new Int32Array(0);
        GlyphCodec.decodeBlocks(blocks, this.points, 2);
        // count only blocks that fit within the buffer (matches decodeBlocks bounds check)
        const bufferPts = Math.floor(this.points.length / CH);
        let pointCount = 0;
        for (const block of blocks) {
            const blockPts = block.residuals.length / CH;
            if (2 + pointCount + blockPts > bufferPts) break;
            pointCount += blockPts;
        }
        if (pointCount === 0) return new Int32Array(0);
        const endPoint = 2 + pointCount;
        const result = this.points.slice(CH * 2, endPoint * CH);
        // carry last two points as seeds for next decode
        const s1off = (endPoint - 1) * CH;
        const s2off = (endPoint - 2) * CH;
        for (let c = 0; c < CH; c++) {
            this.points[c] = this.points[s2off + c];
            this.points[CH + c] = this.points[s1off + c];
        }
        return result;
    }
}
