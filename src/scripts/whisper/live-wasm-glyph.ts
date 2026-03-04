/**
 * live-wasm-glyph.ts
 *
 * THE WHISPER GLYPH CODEC: Production-Grade Kinetic Stroke Engine.
 */

export const GLYPH_BLOCK_SIZE = 16;
export const Q14 = 16384;

export enum GlyphMode {
    HARMONIC = 0,
    LINEAR = 1
}

export interface GlyphBlock {
    mode: GlyphMode;
    kR: number; // Q14 i32
    kI: number;
    gR: number;
    gI: number;
    wPos: number; // Bit-width for X,Y 
    wPre: number; // Bit-width for P
    residuals: Int32Array; // [zr, zi, zp, ...]
}

class BitBuffer {
    data: Uint8Array;
    bitOff: number = 0;
    constructor(size: number = 4096) { this.data = new Uint8Array(size); }
    private ensureCapacity(extraBits: number) {
        const requiredBits = this.bitOff + extraBits;
        const requiredBytes = (requiredBits + 7) >> 3;
        if (requiredBytes <= this.data.length) return;
        let nextSize = this.data.length;
        while (nextSize < requiredBytes) nextSize <<= 1;
        const grown = new Uint8Array(nextSize);
        grown.set(this.data);
        this.data = grown;
    }
    write(val: number, bits: number) {
        this.ensureCapacity(bits);
        for (let i = bits - 1; i >= 0; i--) {
            if ((val >> i) & 1) this.data[this.bitOff >> 3] |= (1 << (7 - (this.bitOff & 7)));
            this.bitOff++;
        }
    }
    read(bits: number): number {
        if (bits < 0) throw new RangeError("invalid bit width");
        if (this.bitOff + bits > this.data.length * 8) {
            throw new RangeError("bit buffer underflow");
        }
        let val = 0;
        for (let i = 0; i < bits; i++) {
            const bit = (this.data[this.bitOff >> 3] >> (7 - (this.bitOff & 7))) & 1;
            val = (val << 1) | bit;
            this.bitOff++;
        }
        return val;
    }
    bytes() { return this.data.slice(0, (this.bitOff + 7) >> 3); }
}

export class GlyphCodec {
    private static estimateBlockBits(mode: GlyphMode, wPos: number, wPre: number, pointCount: number): number {
        // Serialized layout:
        // mode(1) + wPos(5) + wPre(5) + [harmonic coeffs 64] + count(5) + residual payload.
        return 1 + 5 + 5 + (mode === GlyphMode.HARMONIC ? 64 : 0) + 5 + pointCount * (wPos + wPos + wPre);
    }

    private static clampI16(v: number): number {
        if (v < -32768) return -32768;
        if (v > 32767) return 32767;
        return v;
    }

    private static q14Floor(v: number): number {
        return Math.floor(v / Q14);
    }

    private static zigZagEncode(v: number): number {
        return v >= 0 ? v * 2 : (-v * 2) - 1;
    }

    private static zigZagDecode(v: number): number {
        return (v & 1) === 0 ? (v >>> 1) : -((v >>> 1) + 1);
    }

    static encode(points: Int32Array): GlyphBlock[] {
        const blocks: GlyphBlock[] = [];
        const n = points.length / 3;
        for (let i = 2; i < n; i += GLYPH_BLOCK_SIZE) {
            const blockSize = Math.min(GLYPH_BLOCK_SIZE, n - i);
            if (blockSize < 1) break;
            const harmonic = this.processBlock(points, i, blockSize, GlyphMode.HARMONIC);
            const linear = this.processBlock(points, i, blockSize, GlyphMode.LINEAR);
            // Choose predictor by expected packed bit-cost, not residual sum alone.
            // Tie-break toward lower error sum, then LINEAR (smaller header).
            const chooseLinear =
                linear.bitCost < harmonic.bitCost
                || (linear.bitCost === harmonic.bitCost
                    && linear.errorSum <= harmonic.errorSum);
            blocks.push(chooseLinear ? linear.block : harmonic.block);
        }
        return blocks;
    }

    private static processBlock(points: Int32Array, start: number, len: number, mode: GlyphMode) {
        let kR = 0, kI = 0, gR = 0, gI = 0;
        if (mode === GlyphMode.HARMONIC) ({ kR, kI, gR, gI } = this.fit(points, start - 2, len + 2));
        let errorSum = 0, maxPos = 0, maxPre = 0;
        const residuals = new Int32Array(len * 3);
        for (let j = 0; j < len; j++) {
            const idx = (start + j) * 3, p1 = (start + j - 1) * 3, p2 = (start + j - 2) * 3;
            let pr, pi;
            const pp = (points[p1 + 2] * 2) - points[p2 + 2];
            if (mode === GlyphMode.HARMONIC) {
                pr = this.q14Floor(kR * points[p1] - kI * points[p1 + 1] - (gR * points[p2] - gI * points[p2 + 1]));
                pi = this.q14Floor(kR * points[p1 + 1] + kI * points[p1] - (gR * points[p2 + 1] + gI * points[p2]));
            } else {
                pr = (points[p1] * 2) - points[p2];
                pi = (points[p1 + 1] * 2) - points[p2 + 1];
            }
            const dr = points[idx] - pr, di = points[idx + 1] - pi, dp = points[idx + 2] - pp;
            const zr = this.zigZagEncode(dr), zi = this.zigZagEncode(di), zp = this.zigZagEncode(dp);
            residuals[j * 3] = zr; residuals[j * 3 + 1] = zi; residuals[j * 3 + 2] = zp;
            maxPos = Math.max(maxPos, zr, zi);
            maxPre = Math.max(maxPre, zp);
            errorSum += Math.abs(dr) + Math.abs(di) + Math.abs(dp);
        }
        const wPos = 32 - Math.clz32(maxPos);
        const wPre = 32 - Math.clz32(maxPre);
        const bitCost = this.estimateBlockBits(mode, wPos, wPre, len);
        return { errorSum, bitCost, block: { mode, kR, kI, gR, gI, wPos, wPre, residuals } as GlyphBlock };
    }

    static decode(blocks: GlyphBlock[], seed1: [number, number, number], seed2: [number, number, number]): Int32Array {
        let total = 2;
        for (const b of blocks) total += b.residuals.length / 3;
        const out = new Int32Array(total * 3);
        out[0] = seed2[0]; out[1] = seed2[1]; out[2] = seed2[2];
        out[3] = seed1[0]; out[4] = seed1[1]; out[5] = seed1[2];
        this.decodeBlocks(blocks, out, 2);
        return out;
    }

    static decodeBlocks(blocks: GlyphBlock[], points: Int32Array, startIdx: number): void {
        let cursor = startIdx;
        const maxPoints = Math.floor(points.length / 3);
        for (const b of blocks) {
            const { mode, kR, kI, gR, gI, residuals } = b;
            for (let j = 0; j < residuals.length; j += 3) {
                if (cursor >= maxPoints) return;
                const p1 = (cursor - 1) * 3, p2 = (cursor - 2) * 3;
                let pr, pi;
                const pp = (points[p1 + 2] * 2) - points[p2 + 2];
                if (mode === GlyphMode.HARMONIC) {
                    pr = this.q14Floor(kR * points[p1] - kI * points[p1 + 1] - (gR * points[p2] - gI * points[p2 + 1]));
                    pi = this.q14Floor(kR * points[p1 + 1] + kI * points[p1] - (gR * points[p2 + 1] + gI * points[p2]));
                } else {
                    pr = (points[p1] * 2) - points[p2];
                    pi = (points[p1 + 1] * 2) - points[p2 + 1];
                }
                const dr = this.zigZagDecode(residuals[j]);
                const di = this.zigZagDecode(residuals[j + 1]);
                const dp = this.zigZagDecode(residuals[j + 2]);
                points[cursor * 3] = pr + dr; points[cursor * 3 + 1] = pi + di; points[cursor * 3 + 2] = pp + dp;
                cursor++;
            }
        }
    }

    static pack(blocks: GlyphBlock[]): Uint8Array {
        const bb = new BitBuffer();
        for (const b of blocks) {
            bb.write(b.mode, 1);
            bb.write(b.wPos, 5); bb.write(b.wPre, 5);
            if (b.mode === GlyphMode.HARMONIC) {
                bb.write(b.kR + 32768, 16); bb.write(b.kI + 32768, 16);
                bb.write(b.gR + 32768, 16); bb.write(b.gI + 32768, 16);
            }
            const count = b.residuals.length / 3;
            bb.write(count, 5);
            for (let i = 0; i < b.residuals.length; i += 3) {
                bb.write(b.residuals[i], b.wPos);
                bb.write(b.residuals[i + 1], b.wPos);
                bb.write(b.residuals[i + 2], b.wPre);
            }
        }
        return bb.bytes();
    }

    static unpack(bytes: Uint8Array): GlyphBlock[] {
        const bb = new BitBuffer(); bb.data = bytes;
        const blocks: GlyphBlock[] = [];
        try {
            while (bb.bitOff <= (bytes.length * 8) - 11) {
                const mode = bb.read(1);
                const wPos = bb.read(5);
                const wPre = bb.read(5);
                if (wPos < 0 || wPos > 31 || wPre < 0 || wPre > 31) break;
                let kR = 0, kI = 0, gR = 0, gI = 0;
                if (mode === GlyphMode.HARMONIC) {
                    kR = bb.read(16) - 32768; kI = bb.read(16) - 32768;
                    gR = bb.read(16) - 32768; gI = bb.read(16) - 32768;
                }
                const count = bb.read(5);
                if (count < 0 || count > GLYPH_BLOCK_SIZE) break;
                const residuals = new Int32Array(count * 3);
                for (let i = 0; i < count * 3; i += 3) {
                    residuals[i] = bb.read(wPos);
                    residuals[i + 1] = bb.read(wPos);
                    residuals[i + 2] = bb.read(wPre);
                }
                blocks.push({ mode, kR, kI, gR, gI, wPos, wPre, residuals });
            }
        } catch { }
        return blocks;
    }

    private static fit(points: Int32Array, start: number, len: number) {
        let sAA = 0, sABr = 0, sABi = 0, sBB = 0, sTAr = 0, sTAi = 0, sTBr = 0, sTBi = 0;
        for (let j = 2; j < len; j++) {
            const t = (start + j) * 3, a = (start + j - 1) * 3, b = (start + j - 2) * 3;
            const Tr = points[t], Ti = points[t + 1], Ar = points[a], Ai = points[a + 1], Br = points[b], Bi = points[b + 1];
            sAA += Ar * Ar + Ai * Ai; sABr += Ar * Br + Ai * Bi; sABi += Ai * Br - Ar * Bi; sBB += Br * Br + Bi * Bi;
            sTAr += Tr * Ar + Ti * Ai; sTAi += Ti * Ar - Tr * Ai; sTBr += Tr * Br + Ti * Bi; sTBi += Ti * Br - Tr * Bi;
        }
        const det = sAA * sBB - (sABr * sABr + sABi * sABi);
        if (Math.abs(det) < 1e-6) return { kR: 2 * Q14, kI: 0, gR: 1 * Q14, gI: 0 };
        const kR = (sTAr * sBB - (sABr * sTBr + sABi * sTBi)) / det;
        const kI = (sTAi * sBB - (sABr * sTBi - sABi * sTBr)) / det;
        const gR = -(sAA * sTBr - (sTAr * sABr - sTAi * sABi)) / det;
        const gI = -(sAA * sTBi - (sTAr * sABi + sTAi * sABr)) / det;
        return {
            kR: this.clampI16(Math.round(kR * Q14)),
            kI: this.clampI16(Math.round(kI * Q14)),
            gR: this.clampI16(Math.round(gR * Q14)),
            gI: this.clampI16(Math.round(gI * Q14)),
        };
    }
}

export class GlyphStreamEncoder {
    private buffer = new Int32Array(GLYPH_BLOCK_SIZE * 3 + 6);
    private head = 2;
    constructor(s1: [number, number, number], s2: [number, number, number]) {
        this.buffer[0] = s2[0]; this.buffer[1] = s2[1]; this.buffer[2] = s2[2];
        this.buffer[3] = s1[0]; this.buffer[4] = s1[1]; this.buffer[5] = s1[2];
    }
    push(x: number, y: number, p: number): Uint8Array | null {
        this.buffer[this.head * 3] = x; this.buffer[this.head * 3 + 1] = y; this.buffer[this.head * 3 + 2] = p;
        this.head++;
        if (this.head === GLYPH_BLOCK_SIZE + 2) {
            const bytes = GlyphCodec.pack(GlyphCodec.encode(this.buffer));
            const s1 = this.buffer.slice((this.head - 1) * 3, this.head * 3);
            const s2 = this.buffer.slice((this.head - 2) * 3, (this.head - 1) * 3);
            this.buffer[0] = s2[0]; this.buffer[1] = s2[1]; this.buffer[2] = s2[2];
            this.buffer[3] = s1[0]; this.buffer[4] = s1[1]; this.buffer[5] = s1[2];
            this.head = 2; return bytes;
        }
        return null;
    }
    /** Encode any buffered points that haven't filled a full block yet. Call before stroke END. */
    flush(): Uint8Array | null {
        if (this.head <= 2) return null;
        return GlyphCodec.pack(GlyphCodec.encode(this.buffer.slice(0, this.head * 3)));
    }
}

export class GlyphStreamDecoder {
    private points = new Int32Array(GLYPH_BLOCK_SIZE * 3 + 6);
    constructor(s1: [number, number, number], s2: [number, number, number]) {
        this.points[0] = s2[0]; this.points[1] = s2[1]; this.points[2] = s2[2];
        this.points[3] = s1[0]; this.points[4] = s1[1]; this.points[5] = s1[2];
    }
    decode(bytes: Uint8Array): Int32Array {
        const blocks = GlyphCodec.unpack(bytes);
        if (blocks.length === 0) return new Int32Array(0);
        GlyphCodec.decodeBlocks(blocks, this.points, 2);
        let pointCount = 0;
        for (const block of blocks) pointCount += block.residuals.length / 3;
        const endPoint = 2 + pointCount;
        const result = this.points.slice(6, endPoint * 3);
        const s1 = this.points.slice((endPoint - 1) * 3, endPoint * 3);
        const s2 = this.points.slice((endPoint - 2) * 3, (endPoint - 1) * 3);
        this.points[0] = s2[0]; this.points[1] = s2[1]; this.points[2] = s2[2];
        this.points[3] = s1[0]; this.points[4] = s1[1]; this.points[5] = s1[2];
        return result;
    }
}
