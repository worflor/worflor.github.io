/**
 * live-wasm-loup.ts
 *
 * the Whisper Loup 8D Codec by Woflo / MB
 *
 * the Möbius predictor hierarchy runs parallel to the Hurwitz sequence:
 *
 *   Logos    (0D) :              no neighbors. pure probability.
 *   Harmonic (1D) : R            1 neighbor.
 *   Lumen    (2D) : C            3 neighbors.
 *   Spatial  (3D) : (R→H gap)    7 neighbors.
 *   Akasha   (4D) : H            15 neighbors.
 *   Kū       (5D) : (no algebra) 31 neighbors.
 *   6D, 7D        : (no algebra) 63, 127 neighbors.
 *   Loup     (8D) : O            255 neighbors.
 *
 * Hurwitz's theorem (1898): the only normed division algebras over R are R,
 * C, H, and O. the sequence closes at 8D. sedenions break the norm.
 *
 * ── the 255-neighbor predictor ───────────────────────────────────────────
 *
 *   P = Σ_{∅≠S⊆{0..7}} (−1)^(|S|+1) · f(corner_S)
 *
 * 255 terms, grouped by binomial coefficient:
 *   +C(8,1)= +8   −C(8,2)=−28   +C(8,3)=+56   −C(8,4)=−70
 *   +C(8,5)=+56   −C(8,6)=−28   +C(8,7)= +8   −C(8,8)= −1
 *
 * total: 8−28+56−70+56−28+8−1 = 1. unbiased.
 *
 *   error = Δx₀·Δx₁·...·Δx₇·f  (the discrete 8-form)
 *
 * zero for all monomials of degree ≤ 7 and all degree-8 monomials except the
 * full product x₀x₁x₂x₃x₄x₅x₆x₇.
 *
 * ── boundary theorem ─────────────────────────────────────────────────────
 *
 * anti-causal predictor: +1 offsets, clamped at BS-1. when any coordinate
 * equals BS-1, the clamped neighbor equals the current voxel → P = current →
 * residual = 0. always exact, by construction.
 *
 * free-zero fraction at BS=4: 1 − (3/4)⁸ = 89.99%.
 * only 3⁸ = 6561 interior voxels out of 65536 need predictor computation.
 *
 * ── the Logos duality ────────────────────────────────────────────────────
 *
 * 255 spatial neighbors of the 8D Möbius predictor. 255 context tree nodes
 * of the Logos bit coder. both index the Boolean lattice Λ*(R⁸); spatial
 * inclusion-exclusion and probabilistic chain rule are the same structure
 * from opposite ends of the tower.
 *
 * Adams/Bott periodicity: S⁷ is the last sphere with trivial normal bundle.
 * the Hurwitz sequence closes here. the last algebra.
 */
export {};

const BS = 4;
const B8 = BS ** 8;  // 65536
const CS = BS + 1;   // 5
const C8 = CS ** 8;  // 390625

// ── precomputed tables ──────────────────────────────────────────────────────

// context array strides (dim 0 fastest, row-major)
const CTX_STRIDE = new Int32Array(8);
CTX_STRIDE[0] = 1;
for (let d = 1; d < 8; d++) CTX_STRIDE[d] = CTX_STRIDE[d - 1] * CS;

// block array strides
const BLK_STRIDE = new Int32Array(8);
BLK_STRIDE[0] = 1;
for (let d = 1; d < 8; d++) BLK_STRIDE[d] = BLK_STRIDE[d - 1] * BS;

function popcount(n: number): number {
    let c = 0;
    while (n) { c += n & 1; n >>= 1; }
    return c;
}

// for each of the 255 non-empty subsets S ⊆ {0..7}:
// causal delta  = Σ_{d∈S} (−CTX_STRIDE[d])  (neighbor at -1 in each dim of S)
// anti delta    = Σ_{d∈S} (+CTX_STRIDE[d])   (neighbor at +1 in each dim of S)
// sign          = (−1)^(|S|+1)
const CAUSAL_DELTA = new Int32Array(255);
const ANTI_DELTA   = new Int32Array(255);
const SIGN         = new Float64Array(255);  // +1 or -1
for (let mask = 1; mask <= 255; mask++) {
    let cd = 0, ad = 0;
    for (let d = 0; d < 8; d++) {
        if (mask & (1 << d)) { cd -= CTX_STRIDE[d]; ad += CTX_STRIDE[d]; }
    }
    CAUSAL_DELTA[mask - 1] = cd;
    ANTI_DELTA[mask - 1]   = ad;
    SIGN[mask - 1]         = popcount(mask) % 2 === 1 ? 1 : -1;
}

// precompute: for each flat voxel index, its corresponding context index
const VOXEL_TO_CTX = new Int32Array(B8);
for (let vi = 0; vi < B8; vi++) {
    let tmp = vi, ctxIdx = 0;
    for (let d = 0; d < 8; d++) {
        const x = tmp % BS;
        ctxIdx += (x + 1) * CTX_STRIDE[d];
        tmp = (tmp - x) / BS;
    }
    VOXEL_TO_CTX[vi] = ctxIdx;
}

// precompute: interior voxel indices (all coords in 0..BS-2, anti-causal r = nonzero)
const INTERIOR: Int32Array = (() => {
    const list: number[] = [];
    for (let vi = 0; vi < B8; vi++) {
        let tmp = vi, inside = true;
        for (let d = 0; d < 8; d++) {
            if (tmp % BS === BS - 1) { inside = false; break; }
            tmp = (tmp - tmp % BS) / BS;
        }
        if (inside) list.push(vi);
    }
    return new Int32Array(list);
})();
// INTERIOR.length should be (BS-1)^8 = 3^8 = 6561

// ── context extraction ──────────────────────────────────────────────────────

function vi8(coords: Int32Array, W: number): number {
    let idx = 0;
    for (let d = 7; d >= 0; d--) idx = idx * W + coords[d];
    return idx;
}

function extractContext8D(
    vol: Uint8Array, origin: Int32Array, W: number, ctx: Float32Array,
): void {
    ctx.fill(0);
    const gcoords = new Int32Array(8);
    for (let ci = 0; ci < C8; ci++) {
        let tmp = ci, valid = true;
        for (let d = 0; d < 8; d++) {
            const local = tmp % CS - 1;  // -1..BS-1
            gcoords[d] = origin[d] + local;
            if (gcoords[d] < 0 || gcoords[d] >= W) { valid = false; break; }
            tmp = (tmp - (local + 1)) / CS;
        }
        if (valid) ctx[ci] = vol[vi8(gcoords, W)];
    }
}

// ── predictors ──────────────────────────────────────────────────────────────

function predCausal(ctx: Float32Array, ctxIdx: number): number {
    let pred = 0;
    for (let m = 0; m < 255; m++) pred += SIGN[m] * ctx[ctxIdx + CAUSAL_DELTA[m]];
    return pred;
}

function predAnti(ctx: Float32Array, ctxIdx: number): number {
    let pred = 0;
    for (let m = 0; m < 255; m++) pred += SIGN[m] * ctx[ctxIdx + ANTI_DELTA[m]];
    return pred;
}

// ── coding strategies ────────────────────────────────────────────────────────
// all position fields use 16 bits (B8=65536 positions, 0..65535).

const zz  = (r: number): number => r >= 0 ? r * 2 : (-r) * 2 - 1;
const uzz = (z: number): number => (z & 1) ? -((z + 1) >> 1) : z >> 1;

function fixedPayload(res: Float32Array): number {
    let maxZ = 0;
    for (let i = 0; i < res.length; i++) {
        const r = Math.round(res[i]);
        const z = r >= 0 ? r * 2 : (-r) * 2 - 1;
        if (z > maxZ) maxZ = z;
    }
    const W = maxZ === 0 ? 0 : 32 - Math.clz32(maxZ);
    return 6 + W * B8;
}

function sparsePayload(res: Float32Array): number {
    let n = 0, maxZ = 0;
    for (let i = 0; i < res.length; i++) {
        const r = Math.round(res[i]);
        if (r !== 0) {
            n++;
            const z = r >= 0 ? r * 2 : (-r) * 2 - 1;
            if (z > maxZ) maxZ = z;
        }
    }
    const valBits = maxZ === 0 ? 0 : 32 - Math.clz32(maxZ);
    return 16 + 4 + n * (16 + valBits);
}

function ricePayload(res: Float32Array): number {
    let best = Infinity;
    for (let k = 0; k <= 8; k++) {
        let bits = 4;
        for (let i = 0; i < res.length; i++) {
            const r = Math.round(res[i]);
            const z = r >= 0 ? r * 2 : (-r) * 2 - 1;
            bits += (z >> k) + 1 + k;
        }
        if (bits < best) best = bits;
    }
    return best;
}

const rawPayload = (): number => 8 * B8;

function dualPayload(res: Float32Array): number {
    let s0 = NaN, s1 = NaN, unique = 0;
    for (let i = 0; i < res.length; i++) {
        const r = Math.round(res[i]);
        if      (unique === 0)                         { s0 = r; unique = 1; }
        else if (unique === 1 && r !== s0)             { s1 = r; unique = 2; }
        else if (unique === 2 && r !== s0 && r !== s1)   return Infinity;
    }
    if (unique !== 2) return Infinity;
    let maxZ = 0;
    for (const r of [s0, s1]) {
        const z = r >= 0 ? r * 2 : (-r) * 2 - 1;
        if (z > maxZ) maxZ = z;
    }
    const valBits = maxZ === 0 ? 0 : 32 - Math.clz32(maxZ);
    return 4 + 2 * valBits + res.length;
}

// ── logos entropy backend ────────────────────────────────────────────────────

const RC_TOP = 1 << 24;

class LogosEncoder {
    private lo = 0; private range = 0xFFFFFFFF;
    private cache = -1; private nPend = 0;
    private buf: number[] = [];
    encode(cumLo: number, cumHi: number, total: number): void {
        const step  = Math.floor(this.range / total);
        const newLo = (this.lo + step * cumLo) >>> 0;
        this.range  = cumHi === total
            ? (this.range - step * cumLo) >>> 0
            : (step * (cumHi - cumLo)) >>> 0;
        if (newLo < this.lo) this._carry();
        this.lo = newLo;
        while (this.range < RC_TOP) {
            const b = (this.lo >>> 24) & 0xFF;
            if (b !== 0xFF) this._emitByte(b); else this.nPend++;
            this.lo    = ((this.lo & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
        }
    }
    private _carry(): void {
        if (this.cache >= 0) {
            this.buf.push((this.cache + 1) & 0xFF);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0x00);
        } else {
            for (let i = 0; i < this.nPend; i++) this.buf.push(0x00);
        }
        this.cache = -1; this.nPend = 0;
    }
    private _emitByte(b: number): void {
        if (this.cache >= 0) {
            this.buf.push(this.cache);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        } else {
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        }
        this.cache = b; this.nPend = 0;
    }
    flush(): Uint8Array {
        if (this.cache >= 0) {
            this.buf.push(this.cache);
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        } else {
            for (let i = 0; i < this.nPend; i++) this.buf.push(0xFF);
        }
        for (let i = 0; i < 4; i++) {
            this.buf.push((this.lo >>> 24) & 0xFF);
            this.lo = ((this.lo & 0xFFFFFF) << 8) >>> 0;
        }
        return new Uint8Array(this.buf);
    }
}

class LogosBitModel {
    private counts: Uint32Array;
    constructor() {
        this.counts = new Uint32Array(1024);
        for (let i = 0; i < 512; i++) {
            this.counts[i * 2]     = 1;
            this.counts[i * 2 + 1] = 1;
        }
    }
    encodeByte(enc: LogosEncoder, byte: number, prev: number): void {
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit     = (byte >> k) & 1;
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            const c0      = this.counts[idx];
            const c1      = this.counts[idx + 1];
            const total   = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }
}

function logosEncodeResiduals(res: Float32Array): Uint8Array {
    const data = new Uint8Array(res.length);
    for (let i = 0; i < res.length; i++) data[i] = zz(Math.round(res[i])) & 0xFF;
    const model = new LogosBitModel();
    const enc   = new LogosEncoder();
    let prev = 0;
    for (let i = 0; i < data.length; i++) {
        model.encodeByte(enc, data[i], prev);
        prev = data[i];
    }
    return enc.flush();
}

function logosPayload(res: Float32Array): number {
    for (let i = 0; i < res.length; i++) {
        const z = zz(Math.round(res[i]));
        if (z > 255) return Infinity;
    }
    const encoded = logosEncodeResiduals(res);
    return 16 + encoded.length * 8;
}

// ── mode selection ──────────────────────────────────────────────────────────

const MODES = ['fixed', 'sparse', 'rice', 'raw', 'dual', 'rawsparse', 'binarysurf', 'logos'] as const;

function bestCoder(res: Float32Array, rawSparse: number, binarySurf: number): { bits: number; mode: number } {
    const costs = [fixedPayload(res), sparsePayload(res), ricePayload(res), rawPayload(), dualPayload(res), rawSparse, binarySurf, logosPayload(res)];
    let best = 0;
    for (let i = 1; i < costs.length; i++) if (costs[i] < costs[best]) best = i;
    return { bits: 3 + costs[best], mode: best };
}

// ── block encoder ───────────────────────────────────────────────────────────

interface BlockResult8D {
    bitsCausal: number;
    bitsAnti: number;
    modeCausal: number;
    modeAnti: number;
}

function encodeBlock8D(
    vol: Uint8Array, origin: Int32Array, W: number, ctx: Float32Array,
): BlockResult8D {
    extractContext8D(vol, origin, W, ctx);

    const resCausal = new Float32Array(B8);
    const resAnti   = new Float32Array(B8);
    let nRawC = 0, maxRawC = 0, nBinaryC = 0, allBinaryC = true;
    let nRawA = 0, maxRawA = 0, nBinaryA = 0, allBinaryA = true;

    // causal residuals: all voxels
    for (let vi = 0; vi < B8; vi++) {
        const ctxIdx = VOXEL_TO_CTX[vi];
        const val = ctx[ctxIdx];
        resCausal[vi] = val - predCausal(ctx, ctxIdx);

        if (val !== 0 && val !== 255) allBinaryC = false;
        if (val !== 0) { nRawC++; if (val > maxRawC) maxRawC = val; }
        const predThreshC = predCausal(ctx, ctxIdx) >= 128 ? 255 : 0;
        if (predThreshC !== val) nBinaryC++;
    }

    // anti-causal: raw counts from all voxels, residuals from interior only
    // boundary voxels have resAnti[vi] = 0 (initialized), pred = val (boundary theorem)
    // so boundary voxels never count as binary misclassifications
    for (let vi = 0; vi < B8; vi++) {
        const ctxIdx = VOXEL_TO_CTX[vi];
        const val = ctx[ctxIdx];
        if (val !== 0 && val !== 255) allBinaryA = false;
        if (val !== 0) { nRawA++; if (val > maxRawA) maxRawA = val; }
    }
    for (let ii = 0; ii < INTERIOR.length; ii++) {
        const vi = INTERIOR[ii];
        const ctxIdx = VOXEL_TO_CTX[vi];
        const val = ctx[ctxIdx];
        const pa = predAnti(ctx, ctxIdx);
        resAnti[vi] = val - pa;
        if ((pa >= 128 ? 255 : 0) !== val) nBinaryA++;
    }

    // rawSparse: bypass prediction, encode raw values directly
    const rawSparseValBitsC = nRawC === 0 ? 0 : 32 - Math.clz32(maxRawC);
    const rawSparseC = 16 + 4 + nRawC * (16 + rawSparseValBitsC);
    const rawSparseValBitsA = nRawA === 0 ? 0 : 32 - Math.clz32(maxRawA);
    const rawSparseA = 16 + 4 + nRawA * (16 + rawSparseValBitsA);

    // binarysurf
    const binarySurfC = allBinaryC && nBinaryC < B8 ? 16 + 16 * nBinaryC : Infinity;
    const binarySurfA = allBinaryA && nBinaryA < B8 ? 16 + 16 * nBinaryA : Infinity;

    const cCausal = bestCoder(resCausal, rawSparseC, binarySurfC);
    const cAnti   = bestCoder(resAnti,   rawSparseA, binarySurfA);

    return {
        bitsCausal: cCausal.bits,
        bitsAnti:   cAnti.bits,
        modeCausal: cCausal.mode,
        modeAnti:   cAnti.mode,
    };
}

// ── test volumes ────────────────────────────────────────────────────────────

function makeGradient8D(W: number): Uint8Array {
    const vol = new Uint8Array(W ** 8);
    const coords = new Int32Array(8);
    for (let i = 0; i < vol.length; i++) {
        let tmp = i, sum = 0;
        for (let d = 0; d < 8; d++) { coords[d] = tmp % W; sum += coords[d]; tmp = (tmp - coords[d]) / W; }
        vol[i] = Math.round(sum / (8 * Math.max(W - 1, 1)) * 255);
    }
    return vol;
}

function makeHypersphere8D(W: number): Uint8Array {
    const vol = new Uint8Array(W ** 8);
    const center = (W - 1) / 2;
    const r2 = (W * 0.4) ** 2;
    for (let i = 0; i < vol.length; i++) {
        let tmp = i, dist2 = 0;
        for (let d = 0; d < 8; d++) {
            const x = tmp % W;
            dist2 += (x - center) ** 2;
            tmp = (tmp - x) / W;
        }
        vol[i] = dist2 <= r2 ? 255 : 0;
    }
    return vol;
}

function makeSlerp8D(W: number): Uint8Array {
    const vol = new Uint8Array(W ** 8);
    const center = (W - 1) / 2;
    const r2 = (W * 0.25) ** 2;
    for (let i = 0; i < vol.length; i++) {
        let tmp = i, dist2 = 0;
        const coords = new Int32Array(8);
        for (let d = 0; d < 8; d++) { coords[d] = tmp % W; tmp = (tmp - coords[d]) / W; }
        // sphere translates along dim 0, driven by dim 7 as "time"
        const cx = W * 0.25 + coords[7] / Math.max(W - 1, 1) * W * 0.5;
        dist2 = (coords[0] - cx) ** 2;
        for (let d = 1; d < 7; d++) dist2 += (coords[d] - center) ** 2;
        vol[i] = dist2 <= r2 ? 255 : 0;
    }
    return vol;
}

function makeNoise8D(W: number): Uint8Array {
    const vol = new Uint8Array(W ** 8);
    let s = 12345;
    for (let i = 0; i < vol.length; i++) {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        vol[i] = (s >>> 0) & 0xFF;
    }
    return vol;
}

function makeZeros8D(W: number): Uint8Array {
    return new Uint8Array(W ** 8);
}

// ── test runner ─────────────────────────────────────────────────────────────

function runTest8D(label: string, vol: Uint8Array, W: number) {
    const origin = new Int32Array(8);
    const ctx = new Float32Array(C8);
    const blocksPerDim = W / BS;
    const nBlocks = blocksPerDim ** 8;
    let totalBitsCausal = 0, totalBitsAnti = 0;
    const modeCountsC = [0, 0, 0, 0, 0, 0, 0, 0];
    const modeCountsA = [0, 0, 0, 0, 0, 0, 0, 0];

    for (let bi = 0; bi < nBlocks; bi++) {
        let tmp = bi;
        for (let d = 0; d < 8; d++) {
            const bc = tmp % blocksPerDim;
            origin[d] = bc * BS;
            tmp = (tmp - bc) / blocksPerDim;
        }
        const r = encodeBlock8D(vol, origin, W, ctx);
        totalBitsCausal += r.bitsCausal;
        totalBitsAnti   += r.bitsAnti;
        modeCountsC[r.modeCausal]++;
        modeCountsA[r.modeAnti]++;
    }

    const raw = vol.length;
    const rCausal = raw / (totalBitsCausal / 8);
    const rAnti   = raw / (totalBitsAnti / 8);
    const pad = (n: number) => n.toFixed(1).padStart(8);
    const modeStr = (counts: number[]) => MODES
        .map((m, i) => counts[i] ? `${m} ${(counts[i] / nBlocks * 100).toFixed(0)}%` : '')
        .filter(Boolean).join('  ');

    console.log(`\n  ${label}`);
    console.log(`  ${'─'.repeat(label.length)}`);
    console.log(`  causal       : ${pad(rCausal)}×`);
    console.log(`    modes      : ${modeStr(modeCountsC)}`);
    console.log(`  anti-causal  : ${pad(rAnti)}×`);
    console.log(`    modes      : ${modeStr(modeCountsA)}`);
    if (rCausal > 0 && rAnti > 0 && Math.abs(rAnti - rCausal) > 0.01) {
        console.log(`  anti/causal  : ${(rAnti / rCausal).toFixed(2)}×`);
    }
}

// ── boundary theorem verification ───────────────────────────────────────────

function verifyBoundaryTheorem() {
    // for any data, anti-causal residual at boundary voxels must be exactly 0
    const W = BS;
    const vol = makeNoise8D(W);  // worst case: random data
    const ctx = new Float32Array(C8);
    const origin = new Int32Array(8);
    extractContext8D(vol, origin, W, ctx);

    let maxBoundaryR = 0;
    let boundaryCount = 0;
    const coords = new Int32Array(8);

    for (let vi = 0; vi < B8; vi++) {
        let tmp = vi, onBoundary = false;
        for (let d = 0; d < 8; d++) {
            coords[d] = tmp % BS;
            if (coords[d] === BS - 1) onBoundary = true;
            tmp = (tmp - coords[d]) / BS;
        }
        if (!onBoundary) continue;
        boundaryCount++;

        const ctxIdx = VOXEL_TO_CTX[vi];
        const val = ctx[ctxIdx];

        // anti-causal with clamping: for boundary voxels, at least one +1 offset
        // is clamped, causing the inclusion-exclusion to telescope to val.
        // compute full anti-causal predictor with clamped offsets
        let pred = 0;
        for (let mask = 1; mask <= 255; mask++) {
            const bits = popcount(mask);
            const sign = bits % 2 === 1 ? 1 : -1;
            let nIdx = ctxIdx;
            for (let d = 0; d < 8; d++) {
                if (mask & (1 << d)) {
                    const clampedOff = coords[d] < BS - 1 ? CTX_STRIDE[d] : 0;
                    nIdx += clampedOff;
                }
            }
            pred += sign * ctx[nIdx];
        }
        const r = Math.abs(Math.round(val - pred));
        if (r > maxBoundaryR) maxBoundaryR = r;
    }

    const expectedBoundary = B8 - (BS - 1) ** 8;
    const frac = ((expectedBoundary / B8) * 100).toFixed(2);
    console.log(`\n  boundary theorem verification (random noise, BS=${BS})`);
    console.log(`  ${'─'.repeat(52)}`);
    console.log(`  boundary voxels : ${boundaryCount} / ${B8} = ${frac}%`);
    console.log(`  expected        : ${expectedBoundary} / ${B8} = ${frac}%`);
    console.log(`  max |r_anti|    : ${maxBoundaryR}  (must be 0)`);
    console.log(`  theorem holds   : ${maxBoundaryR === 0 ? 'YES' : 'FAIL'}`);
}

// ── main ────────────────────────────────────────────────────────────────────

console.log('Whisper Octonion — 8D codec stress test');
console.log('========================================');
console.log(`block           : ${BS}⁸ = ${B8} voxels`);
console.log(`context         : ${CS}⁸ = ${C8} floats`);
console.log(`free-zero bound : 1 − (${BS - 1}/${BS})⁸ = ${((1 - ((BS - 1) / BS) ** 8) * 100).toFixed(2)}%`);
console.log(`interior voxels : ${INTERIOR.length} / ${B8} = ${(INTERIOR.length / B8 * 100).toFixed(2)}%`);
console.log('');
console.log('error = Δx₀·Δx₁·...·Δx₇·f  (the 8-form)');

console.log('\n── boundary theorem ────────────────────────────────────────────');
verifyBoundaryTheorem();

console.log('\n── single block (W=4) ──────────────────────────────────────────');
console.log('(causal = anti for single block, no inter-block context)');

runTest8D('gradient (linear)', makeGradient8D(BS), BS);
runTest8D('all zeros', makeZeros8D(BS), BS);
runTest8D('binary hypersphere', makeHypersphere8D(BS), BS);
runTest8D('noise (xorshift32)', makeNoise8D(BS), BS);

console.log('\n── multi-block (W=8) ───────────────────────────────────────────');
console.log('(anti-causal uses within-block future, causal imports inter-block past)');

const t0 = Date.now();
runTest8D('gradient (linear)', makeGradient8D(2 * BS), 2 * BS);
runTest8D('binary hypersphere', makeHypersphere8D(2 * BS), 2 * BS);
runTest8D('SLERP (translating)', makeSlerp8D(2 * BS), 2 * BS);
runTest8D('noise (xorshift32)', makeNoise8D(2 * BS), 2 * BS);
console.log(`\n  multi-block time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('\n── Hurwitz free-zero fractions (BS=4) ──────────────────────────');
for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const fz = (1 - ((BS - 1) / BS) ** n) * 100;
    console.log(`  n=${n}: ${fz.toFixed(1)}%`);
}

console.log('\n── Hurwitz free-zero fractions (BS=8) ──────────────────────────');
for (const n of [1, 2, 3, 4, 5, 8]) {
    const fz = (1 - ((8 - 1) / 8) ** n) * 100;
    console.log(`  n=${n}: ${fz.toFixed(1)}%`);
}
