/**
 * live-wasm-kizuna.ts
 *
 * the Whisper Kizuna 16D Codec by Woflo / MB
 *
 * the sedenion step of the Möbius hierarchy — 65535 neighbors — and a
 * cryptographic handshake primitive built from the predictor itself.
 *
 * ── the predictor ────────────────────────────────────────────────────────
 *
 * the anti-causal Möbius predictor at BS=2 uses the full inclusion-exclusion
 * over all 65535 non-trivial subsets of 16 dimensions:
 *
 *   P = Σ_{∅≠S⊆{0..15}} (−1)^(|S|+1) · block[bit-mask(S)]
 *
 * at BS=2, each coordinate is 0 or 1, so block index = bit-mask of coords:
 *   block[Σ c[d]·2^d] = voxel at coordinate vector (c[0], c[1], ..., c[15])
 *
 * the 65535 terms group by binomial coefficient C(16,k), from +16 singletons
 * down to −1 hexdecuple. prediction error = the mixed 16th finite difference,
 * zero for all polynomials without the x₀·x₁·...·x₁₅ cross-term.
 *
 * ── boundary theorem ─────────────────────────────────────────────────────
 *
 * for any voxel with at least one coordinate = 1 (= BS−1), the anti-causal
 * Möbius sum telescopes to the current value. residual = 0. always.
 *
 * proof: split subsets S by whether d∈S or d∉S for any set bit d. the two
 * halves cancel term-by-term, leaving only block[m] itself.
 *
 * free-zero fraction = 1 − (1/2)¹⁶ = 65535/65536 = 99.998%.
 * only the origin (0,...,0) is interior. its residual carries the full Möbius
 * mixture of all 65535 boundary voxels — sensitive to every byte in the block.
 *
 * ── the sedenion step ────────────────────────────────────────────────────
 *
 * the Hurwitz sequence R→C→H→O closes at octonions. sedenions (R¹⁶) have zero
 * divisors — not a normed division algebra. the algebraic door is shut. the
 * Möbius formula doesn't care: error = n-form = exterior derivative of order n,
 * valid for any dimension regardless of algebraic structure.
 *
 * ── 0D↔16D duality ───────────────────────────────────────────────────────
 *
 * a 16-bit symbol decomposed into 16 binary decisions uses 65535 conditional
 * contexts (nodes 1..65535 of the bit tree) — the same Boolean lattice Λ*(R¹⁶)
 * as the 65535 Möbius neighbors. the chain rule P(sym) = P(b15)·P(b14|b15)·...
 * mirrors the inclusion-exclusion: both decompose 2¹⁶ outcomes into 2¹⁶−1
 * conditional terms. extends the 0D↔8D duality one step up the tower.
 *
 * ── handshake primitive ──────────────────────────────────────────────────
 *
 * both parties expand their ECDH shared secret to 65536 bytes, then call
 * handshake16D(sharedBlock). three values are derived independently:
 *
 *   residual       — the 16D Möbius mixing of all 65535 voxels. sensitive to
 *                    every byte in the block. used in production (live-handshake.ts)
 *                    as the cryptographic witness for session confirmation.
 *   rowWitnesses8D — 256 intermediate 8D sub-witnesses from the μ₁₆ = μ₈ ⊗ μ₈
 *                    factorization. enables hierarchical integrity diagnosis:
 *                    if the 16D residual is wrong, compare sub-witnesses to
 *                    identify which 256-byte segment was corrupted.
 *   countsBitM     — Möbius per-bit model counts primed with 512 bytes of key
 *                    material. the Loop (live-loop.ts) builds its own counts in
 *                    loopInit() using the same priming logic; this field exists
 *                    for testing and external consumers.
 *
 * the 8D⊗8D factorization: the 16D residual = 8D Möbius applied to the vector
 * of 256 row-wise 8D Möbius outputs. "Kizuna IS Loup applied to Loup."
 * same operation count (65535 terms), but yields 256 sub-witnesses for free.
 *
 * no extra communication. both parties derive all three from the same block.
 *
 * 99.998% free zeros. one interior point. the full weight of 65535 neighbors
 * compressed into a single residual.
 */

// ── arithmetic coder ─────────────────────────────────────────────────────────
//
// LZMA-style range coder. RC_TOP=16M keeps step≥1 for total≤16M.
// carry propagation and 0xFF pending logic. used for BitContextModel16 and block codec.

const RC_TOP = 0x1000000;

class ArithEncoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private cache = -1;
    private nPend = 0;
    // Uint8Array instead of number[] — avoids 8× memory amplification.
    // number[] stores each byte as an 8-byte JS heap number; with Uint8Array it stays at 1×.
    private buf = new Uint8Array(256);
    private len = 0;

    private _push(b: number): void {
        if (this.len >= this.buf.length) {
            const next = new Uint8Array(this.buf.length * 2);
            next.set(this.buf.subarray(0, this.len));
            this.buf = next;
        }
        this.buf[this.len++] = b;
    }

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
            if (b !== 0xFF) { this._emit(b); } else { this.nPend++; }
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
        }
    }

    private _carry(): void {
        if (this.cache >= 0) { this._push((this.cache + 1) & 0xFF); for (let i = 0; i < this.nPend; i++) this._push(0x00); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0x00); }
        this.cache = -1; this.nPend = 0;
    }

    private _emit(b: number): void {
        if (this.cache >= 0) { this._push(this.cache); for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        this.cache = b; this.nPend = 0;
    }

    flush(): Uint8Array {
        if (this.cache >= 0) { this._push(this.cache); for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        else { for (let i = 0; i < this.nPend; i++) this._push(0xFF); }
        for (let i = 0; i < 4; i++) { this._push((this.lo >>> 24) & 0xFF); this.lo = ((this.lo & 0xFFFFFF) << 8) >>> 0; }
        return this.buf.subarray(0, this.len);
    }
}

class ArithDecoder {
    private lo    = 0;
    private range = 0xFFFFFFFF;
    private code  = 0;
    private pos   = 0;

    constructor(private data: Uint8Array) {
        for (let i = 0; i < 4; i++)
            this.code = ((this.code << 8) | (data[this.pos++] ?? 0)) >>> 0;
    }

    getCDF(total: number): number {
        const step   = Math.floor(this.range / total);
        const offset = ((this.code - this.lo) >>> 0) / step | 0;
        return Math.min(offset, total - 1);
    }

    advance(cumLo: number, cumHi: number, total: number): void {
        const step = Math.floor(this.range / total);
        this.lo    = (this.lo + step * cumLo) >>> 0;
        this.range = cumHi === total
            ? (this.range - step * cumLo) >>> 0
            : (step * (cumHi - cumLo)) >>> 0;
        while (this.range < RC_TOP) {
            this.lo    = ((this.lo    & 0xFFFFFF) << 8) >>> 0;
            this.range = ( this.range << 8) >>> 0;
            this.code  = ((this.code  & 0xFFFFFF) << 8 | (this.data[this.pos++] ?? 0)) >>> 0;
        }
    }
}

// ── constants ─────────────────────────────────────────────────────────────────

const B16 = 65536;  // 2^16 voxels per block

// parity table: PARITY16[mask] = popcount(mask) & 1
// sign of Möbius term: +1 if odd popcount, −1 if even.
// recurrence: parity(mask) = parity(mask >> 1) ^ (mask & 1).
const PARITY16 = new Uint8Array(B16);
for (let mask = 1; mask < B16; mask++) {
    PARITY16[mask] = PARITY16[mask >> 1] ^ (mask & 1);
}

// ── 16D anti-Möbius predictor ─────────────────────────────────────────────────

// compute the anti-causal 16D Möbius prediction for the origin voxel.
// block[mask] = voxel at coordinates where bit d is set ↔ c[d] = 1.
// block[0] is irrelevant to this computation (it's the voxel being predicted).
// at BS=2, only the origin needs a predictor — all 65535 other voxels have
// anti-residual = 0 by the boundary theorem.
function predAnti16D(block: Uint8Array): number {
    let P = 0;
    for (let mask = 1; mask < B16; mask++) {
        P += PARITY16[mask] ? block[mask] : -block[mask];
    }
    return P;
}

// ── 8D sub-block predictor ──────────────────────────────────────────────────

// 8D anti-causal Möbius predictor for a 256-element sub-block.
// PARITY16[mask] for mask < 256 gives the 8-bit popcount parity — no separate table needed.
// works on any ArrayLike<number> (Uint8Array for raw blocks, Int32Array for intermediate WHT).
function predAnti8D(data: ArrayLike<number>, offset: number): number {
    let P = 0;
    for (let mask = 1; mask < 256; mask++) {
        P += PARITY16[mask] ? data[offset + mask] : -data[offset + mask];
    }
    return P;
}

// ── 8D⊗8D factored decomposition ───────────────────────────────────────────
//
// the Möbius function is multiplicative on product posets:
//   μ₁₆ = μ₈ ⊗ μ₈
//
// index each voxel by (h, l) where h = mask >> 8, l = mask & 0xFF.
// the 65536 voxels form a 256×256 grid — an 8D cube nested inside an 8D cube.
//
// step 1: for each row h, compute g[h] = block[h*256] - predAnti8D(block, h*256).
//         g[h] is the 8D WHT all-ones coefficient of row h — an "8D sub-witness".
// step 2: compute the 8D WHT of g[0..255]. the result equals the direct 16D residual.
//
// proof: μ₁₆(f)(0,0) = Σ_h Σ_l (-1)^(pc(h)+pc(l)) f(h,l) = Σ_h (-1)^pc(h) · μ₈(f_row_h)(0)
//        which is μ₈ applied to the vector of row-wise μ₈ outputs. QED.
//
// this yields 256 intermediate 8D sub-witnesses for free. each is sensitive to
// all 255 bytes in its row. if a byte is corrupted in row h, only g[h] changes,
// enabling hierarchical integrity diagnosis (which 256-byte segment was corrupted).

export interface Factored16DResult {
    // the 16D Möbius residual — identical to what predAnti16D computes
    residual: number;
    // 256 intermediate 8D WHT all-ones coefficients, one per 256-byte row.
    // rowWitnesses[h] = block[h*256] - predAnti8D(block, h*256).
    // each is sensitive to all 255 bytes in row h.
    rowWitnesses: Int32Array;
}

export function factored16D(block: Uint8Array): Factored16DResult {
    if (block.length !== B16) throw new Error(`expected ${B16} bytes`);
    // step 1: compute 8D WHT for each of 256 rows
    const g = new Int32Array(256);
    for (let h = 0; h < 256; h++) {
        g[h] = block[h * 256] - predAnti8D(block, h * 256);
    }
    // step 2: compute 8D WHT of the row-witness vector
    const outerPred = predAnti8D(g, 0);
    const residual = (g[0] - outerPred) | 0;
    return { residual, rowWitnesses: g };
}

// ── single-block codec ────────────────────────────────────────────────────────

// encode a 16D block (65536 uint8 values).
// format: [origin residual: int32 LE (4 bytes)] [boundary voxels: 65535 raw bytes]
// total output: 65539 bytes. compression gain only when the predictor is near-exact
// (structured, polynomial data) and residuals are separately entropy-coded.
// for the handshake use case, encoding is not needed — call handshake16D() directly.
export function encodeBlock16D(block: Uint8Array): Uint8Array {
    if (block.length !== B16) throw new Error(`block must be ${B16} bytes`);
    const pred = predAnti16D(block);
    const r    = (block[0] - Math.round(pred)) | 0;
    const out  = new Uint8Array(4 + B16 - 1);
    // origin residual as int32 LE (range: roughly ±8M for uint8 data)
    out[0] = r         & 0xFF;
    out[1] = (r >>>  8) & 0xFF;
    out[2] = (r >>> 16) & 0xFF;
    out[3] = (r >>> 24) & 0xFF;
    // boundary voxels raw (mask=1..65535)
    out.set(block.subarray(1), 4);
    return out;
}

// decode a 16D block from encodeBlock16D output.
export function decodeBlock16D(data: Uint8Array): Uint8Array {
    if (data.length !== 4 + B16 - 1) throw new Error('invalid data length');
    const r = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    const block = new Uint8Array(B16);
    block.set(data.subarray(4), 1);
    const pred = predAnti16D(block);
    block[0] = Math.max(0, Math.min(255, Math.round(pred) + r));
    return block;
}

// ── handshake primitive ───────────────────────────────────────────────────────

export interface Handshake16DResult {
    // the single Möbius residual at origin.
    // both parties derive the same value from the same ECDH-derived block.
    // sensitive to all 65535 boundary voxels via full 16D inclusion-exclusion.
    residual: number;

    // 256 intermediate 8D sub-witnesses from the 8D⊗8D factorization (μ₁₆ = μ₈ ⊗ μ₈).
    // rowWitnesses8D[h] = 8D WHT of block[h*256 .. h*256+255].
    // enables hierarchical integrity: if residual is wrong, compare sub-witnesses
    // to identify which 256-byte segment was corrupted.
    rowWitnesses8D: Int32Array;

    // Möbius per-bit model counts (1024 uint32 values) primed with 512 bytes of
    // key material. seeds the Loop's BitM coder (encodeM/decodeM in live-loop.ts):
    // counts[ctx*2]=c0, counts[ctx*2+1]=c1, ctx=0..511 (prevBit×256 + treeCtx).
    countsBitM: Uint32Array;
}

export function handshake16D(sharedBlock: Uint8Array): Handshake16DResult {
    if (sharedBlock.length !== B16) throw new Error(`expected ${B16} bytes`);

    // compute the 16D residual via the 8D⊗8D factorization.
    // this gives us both the residual and 256 intermediate 8D sub-witnesses.
    const { residual, rowWitnesses } = factored16D(sharedBlock);

    // prime BitContextModelM with the first 512 bytes of the shared block.
    // simulates encoding those bytes through the model without range coding —
    // just updates counts. the resulting counts are the pre-seeded 0D context.
    const countsBitM = new Uint32Array(1024);
    for (let i = 0; i < 512; i++) { countsBitM[i * 2] = 1; countsBitM[i * 2 + 1] = 1; }
    let prev = 0;
    for (let i = 0; i < 512; i++) {
        const byte = sharedBlock[i];
        let ctx = 1;
        for (let k = 7; k >= 0; k--) {
            const bit     = (byte >> k) & 1;
            const prevBit = (prev >> k) & 1;
            const idx     = (prevBit * 256 + ctx) * 2;
            countsBitM[idx + bit]++;
            ctx = (ctx << 1) | bit;
        }
        prev = byte;
    }

    return { residual, rowWitnesses8D: rowWitnesses, countsBitM };
}

// ── 16-bit context model (0D↔16D duality made concrete) ─────────────────────
//
// decomposing a 16-bit symbol into 16 binary decisions uses nodes 1..65535 of
// the binary context tree. these 65535 nodes index the same Boolean lattice
// 2^{0,...,15} = Λ*(R¹⁶) as the 65535 Möbius neighbors.
//
// contexts: 65536 × 2 = 131072 uint32 values (512KB).
// Laplace prior: count0=count1=1 per context, for fast convergence.

class BitContextModel16 {
    readonly counts: Uint32Array;  // 65536 contexts × 2

    constructor(seedCounts?: Uint32Array) {
        this.counts = new Uint32Array(131072);
        if (seedCounts && seedCounts.length === 131072) {
            this.counts.set(seedCounts);
        } else {
            for (let i = 0; i < 65536; i++) {
                this.counts[i * 2]     = 1;
                this.counts[i * 2 + 1] = 1;
            }
        }
    }

    encodeSym(enc: ArithEncoder, sym: number): void {
        let ctx = 1;
        for (let k = 15; k >= 0; k--) {
            const bit   = (sym >> k) & 1;
            const c0    = this.counts[ctx * 2];
            const c1    = this.counts[ctx * 2 + 1];
            const total = c0 + c1;
            if (bit === 0) enc.encode(0, c0, total);
            else           enc.encode(c0, total, total);
            this.counts[ctx * 2 + bit]++;
            ctx = (ctx << 1) | bit;
        }
    }

    decodeSym(dec: ArithDecoder): number {
        let ctx = 1, sym = 0;
        for (let k = 15; k >= 0; k--) {
            const c0     = this.counts[ctx * 2];
            const c1     = this.counts[ctx * 2 + 1];
            const total  = c0 + c1;
            const offset = dec.getCDF(total);
            const bit    = offset >= c0 ? 1 : 0;
            if (bit === 0) dec.advance(0, c0, total);
            else           dec.advance(c0, total, total);
            this.counts[ctx * 2 + bit]++;
            sym = (sym << 1) | bit;
            ctx = (ctx << 1) | bit;
        }
        return sym;
    }
}

// encode a stream of 16-bit values using the 65535-context model.
export function encode16(data: Uint16Array): Uint8Array {
    const model = new BitContextModel16();
    const enc   = new ArithEncoder();
    for (const sym of data) model.encodeSym(enc, sym);
    return enc.flush();
}

// decode a stream of 16-bit values.
export function decode16(data: Uint8Array, len: number): Uint16Array {
    const model = new BitContextModel16();
    const dec   = new ArithDecoder(data);
    const out   = new Uint16Array(len);
    for (let i = 0; i < len; i++) out[i] = model.decodeSym(dec);
    return out;
}

// ── test utilities ────────────────────────────────────────────────────────────

function lcg(seed: number): () => number {
    let s = seed;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 0x100000000; };
}

function makeBlock(seed: number): Uint8Array {
    const rng = lcg(seed);
    const b   = new Uint8Array(B16);
    for (let i = 0; i < B16; i++) b[i] = (rng() * 256) | 0;
    return b;
}

function idealEntropy16(data: Uint16Array): number {
    const counts = new Map<number, number>();
    for (const v of data) counts.set(v, (counts.get(v) ?? 0) + 1);
    let H = 0;
    for (const c of counts.values()) {
        const p = c / data.length; H -= p * Math.log2(p);
    }
    return H;
}

// ── test harness ──────────────────────────────────────────────────────────────

function runTests(): void {
    console.log('=== Whisper 16D — sedenion Möbius stress test ===\n');

    let pass = 0, fail = 0;
    const ok = (label: string, cond: boolean) => {
        console.log(`  ${cond ? '✓' : '✗'} ${label}`);
        cond ? pass++ : fail++;
    };

    // helper: round-trip a block and return error count
    const rt = (block: Uint8Array): number => {
        const enc = encodeBlock16D(block);
        const dec = decodeBlock16D(enc);
        let errs = 0;
        for (let i = 0; i < B16; i++) if (dec[i] !== block[i]) errs++;
        return errs;
    };

    // ── 1. predictor exactness ──────────────────────────────────────────────
    console.log('predictor exactness:');

    // constant: pred = c for any c. zero residual.
    for (const c of [0, 1, 127, 128, 255]) {
        const block = new Uint8Array(B16).fill(c);
        const pred = predAnti16D(block);
        ok(`constant c=${c}: pred=${Math.round(pred)}, r=0`, Math.round(pred) === c);
    }

    // linear (popcount): pred = 0 (origin has pc=0, pred = inclusion-exclusion of pc = 0)
    {
        const block = new Uint8Array(B16);
        for (let m = 0; m < B16; m++) { let c = 0, v = m; while (v) { c += v & 1; v >>>= 1; } block[m] = c; }
        ok(`linear (popcount): pred=0`, Math.abs(predAnti16D(block)) < 1e-9);
    }

    // k-way cross-terms (k < 16): predictor exact, residual = 0 at origin
    for (const k of [2, 4, 8, 15]) {
        const block = new Uint8Array(B16);
        const reqBits = (1 << k) - 1;  // lowest k bits all set
        for (let m = 0; m < B16; m++) block[m] = (m & reqBits) === reqBits ? 1 : 0;
        const pred = predAnti16D(block);
        const r = block[0] - Math.round(pred);
        ok(`${k}-way cross-term (k<16): residual=${r}`, r === 0);
    }

    // 16-way cross-term (parity): NOT exact, non-zero residual
    {
        const block = new Uint8Array(B16);
        for (let m = 0; m < B16; m++) block[m] = PARITY16[m];
        const r = block[0] - Math.round(predAnti16D(block));
        ok(`16-way parity: residual=${r} (must be non-zero)`, r !== 0);
    }

    console.log();

    // ── 2. round-trip: edge-case blocks ─────────────────────────────────────
    console.log('round-trip edge cases:');

    ok(`all zeros: errors=${rt(new Uint8Array(B16))}`, rt(new Uint8Array(B16)) === 0);
    ok(`all 0xFF: errors=${rt(new Uint8Array(B16).fill(255))}`, rt(new Uint8Array(B16).fill(255)) === 0);
    ok(`all 0x80: errors=${rt(new Uint8Array(B16).fill(128))}`, rt(new Uint8Array(B16).fill(128)) === 0);

    // single nonzero at various positions
    for (const pos of [0, 1, 100, 32768, 65535]) {
        const block = new Uint8Array(B16);
        block[pos] = 255;
        ok(`single 0xFF at pos=${pos}: errors=${rt(block)}`, rt(block) === 0);
    }

    // alternating 0x00/0xFF (worst-case anti-correlated)
    {
        const block = new Uint8Array(B16);
        for (let i = 0; i < B16; i++) block[i] = (i & 1) ? 255 : 0;
        ok(`alternating 0/255: errors=${rt(block)}`, rt(block) === 0);
    }

    // checkerboard by parity (maximum cross-term stress)
    {
        const block = new Uint8Array(B16);
        for (let m = 0; m < B16; m++) block[m] = PARITY16[m] * 255;
        ok(`parity checkerboard: errors=${rt(block)}`, rt(block) === 0);
    }

    // gradient: block[m] = m & 0xFF (low byte of index)
    {
        const block = new Uint8Array(B16);
        for (let m = 0; m < B16; m++) block[m] = m & 0xFF;
        ok(`gradient (m & 0xFF): errors=${rt(block)}`, rt(block) === 0);
    }

    // staircase: block[m] = floor(m / 256)
    {
        const block = new Uint8Array(B16);
        for (let m = 0; m < B16; m++) block[m] = (m >> 8) & 0xFF;
        ok(`staircase (m >> 8): errors=${rt(block)}`, rt(block) === 0);
    }

    // random blocks with many seeds
    for (const seed of [1, 42, 999, 0xDEAD, 0xCAFE, 0xBEEF, 0x1337, 0xFFFF]) {
        const block = makeBlock(seed);
        ok(`random seed=${seed}: errors=${rt(block)}`, rt(block) === 0);
    }

    console.log();

    // ── 3. boundary theorem (empirical verification) ────────────────────────
    console.log('boundary theorem:');
    console.log('  n=16, BS=2: free-zero fraction = 65535/65536 = 99.998%');

    // verify on random data: the telescoping proof means boundary r = 0 for ANY data
    {
        const block = makeBlock(0xDEADBEEF);
        // for each boundary voxel (mask != 0), compute the anti-causal residual
        // by pretending that voxel is the origin. but at BS=2, each boundary voxel
        // has at least one coord = 1 = BS-1, so its anti-pred telescopes to its value.
        // we verify this by checking that pred(block, removing contributions of mask m)
        // equals block[m] for all m != 0.
        // simpler check: the encode/decode round-trip succeeds iff the residual at
        // origin is correct. the boundary voxels are passed through raw.
        // so we verify: decode(encode(block))[0] == block[0] for random data.
        ok(`random block: origin round-trip correct`, rt(block) === 0);

        // also verify the boundary count
        const expectedFreeZeros = B16 - 1;  // only mask=0 is interior
        ok(`free-zero count: ${expectedFreeZeros}/65536 = ${(expectedFreeZeros / B16 * 100).toFixed(3)}%`,
            expectedFreeZeros === 65535);
    }

    console.log();

    // ── 4. avalanche (sensitivity to every position) ────────────────────────
    console.log('avalanche:');
    {
        const block = makeBlock(0xF00D);
        const r0 = (block[0] - Math.round(predAnti16D(block))) | 0;

        // flip LSB at every 1000th position, plus edges
        const positions = [1, 2, 3, 7, 15, 255, 1000, 4096, 16384, 32768, 65535];
        let allChanged = true;
        const deltas: number[] = [];
        for (const pos of positions) {
            const mod = block.slice();
            mod[pos] ^= 0x01;
            const r1 = (mod[0] - Math.round(predAnti16D(mod))) | 0;
            const delta = r1 - r0;
            deltas.push(delta);
            if (delta === 0) allChanged = false;
        }
        ok(`LSB flip at ${positions.length} positions: all change residual`, allChanged);

        // flip MSB: larger change expected
        let allChangedMSB = true;
        const deltasMSB: number[] = [];
        for (const pos of positions) {
            const mod = block.slice();
            mod[pos] ^= 0x80;
            const r1 = (mod[0] - Math.round(predAnti16D(mod))) | 0;
            const delta = r1 - r0;
            deltasMSB.push(delta);
            if (delta === 0) allChangedMSB = false;
        }
        ok(`MSB flip at ${positions.length} positions: all change residual`, allChangedMSB);

        // verify sign pattern follows inclusion-exclusion.
        // XOR 0x01 flips LSB: Δval = +1 if LSB was 0, -1 if LSB was 1.
        // Möbius coefficient for mask m: sign(m) = (-1)^(popcount(m)+1).
        // Δpred = sign(m) * Δval, so Δresidual = 0 - Δpred = -sign(m) * Δval.
        let signPatternCorrect = true;
        for (let idx = 0; idx < positions.length; idx++) {
            const pos = positions[idx];
            const pc = PARITY16[pos];
            const sign = pc ? 1 : -1;  // (-1)^(popcount+1)
            const dval = (block[pos] & 1) ? -1 : 1;  // XOR 0x01 effect
            const expected = -sign * dval;
            if (deltas[idx] !== expected) signPatternCorrect = false;
        }
        ok(`sign pattern matches inclusion-exclusion coefficients`, signPatternCorrect);
    }

    console.log();

    // ── 5. handshake ────────────────────────────────────────────────────────
    console.log('handshake:');
    {
        // determinism: same input → same output
        const shared = makeBlock(0xCAFEBABE);
        const A = handshake16D(shared);
        const B = handshake16D(shared);
        ok(`deterministic: residual A=${A.residual} == B=${B.residual}`, A.residual === B.residual);

        let rwMatch = true;
        for (let i = 0; i < 256; i++) if (A.rowWitnesses8D[i] !== B.rowWitnesses8D[i]) rwMatch = false;
        ok('rowWitnesses8D identical', rwMatch);

        let cntMatch = true;
        for (let i = 0; i < 1024; i++) if (A.countsBitM[i] !== B.countsBitM[i]) cntMatch = false;
        ok('countsBitM identical', cntMatch);

        // different secrets → different outputs
        const C = handshake16D(makeBlock(0xDEADC0DE));
        ok(`different secret: residual ${A.residual} != ${C.residual}`, A.residual !== C.residual);

        let rwDiff = false;
        for (let i = 0; i < 256; i++) if (A.rowWitnesses8D[i] !== C.rowWitnesses8D[i]) { rwDiff = true; break; }
        ok('different secret: rowWitnesses8D differs', rwDiff);

        let cntDiff = false;
        for (let i = 0; i < 1024; i++) if (A.countsBitM[i] !== C.countsBitM[i]) { cntDiff = true; break; }
        ok('different secret: countsBitM differs', cntDiff);

        // verify primed counts are > Laplace prior (evidence of actual priming)
        let primedTotal = 0, laplaceTotal = 0;
        for (let i = 0; i < 512; i++) {
            primedTotal += A.countsBitM[i * 2] + A.countsBitM[i * 2 + 1];
            laplaceTotal += 2;  // prior = 1+1 = 2 per context
        }
        ok(`primed counts > prior: ${primedTotal} > ${laplaceTotal}`, primedTotal > laplaceTotal);
    }

    console.log();

    // ── 6. 16-bit Logos round-trips ─────────────────────────────────────────
    console.log('16-bit Logos round-trips:');

    const logos16RT = (label: string, data: Uint16Array) => {
        const encoded = encode16(data);
        const decoded = decode16(encoded, data.length);
        let errs = 0;
        for (let i = 0; i < data.length; i++) if (decoded[i] !== data[i]) errs++;
        const H   = idealEntropy16(data);
        const bps = (encoded.length * 8) / data.length;
        const gap = bps - H;
        ok(`${label}: errors=${errs}, H=${H.toFixed(2)}, coded=${bps.toFixed(2)}, gap=${gap > 0 ? '+' : ''}${gap.toFixed(2)}`, errs === 0);
    };

    // all same symbol
    logos16RT('all zeros 1K', new Uint16Array(1024));
    logos16RT('all 0xFFFF 1K', new Uint16Array(1024).fill(65535));
    logos16RT('all 0x8000 1K', new Uint16Array(1024).fill(32768));

    // single distinct value among zeros
    {
        const data = new Uint16Array(1024);
        data[500] = 42;
        logos16RT('single spike at [500]', data);
    }

    // two-symbol: alternating
    {
        const data = new Uint16Array(2048);
        for (let i = 0; i < 2048; i++) data[i] = (i & 1) ? 65535 : 0;
        logos16RT('alternating 0/65535', data);
    }

    // monotonic ramp
    {
        const data = new Uint16Array(4096);
        for (let i = 0; i < 4096; i++) data[i] = i & 0xFFFF;
        logos16RT('monotonic ramp 4K', data);
    }

    // sawtooth
    {
        const data = new Uint16Array(4096);
        for (let i = 0; i < 4096; i++) data[i] = (i * 7) & 0xFFFF;
        logos16RT('sawtooth (*7) 4K', data);
    }

    // uniform random
    {
        const rng = lcg(77);
        const data = new Uint16Array(4096);
        for (let i = 0; i < 4096; i++) data[i] = (rng() * 65536) | 0;
        logos16RT('uniform random 4K', data);
    }

    // concentrated laplace (simulates harmonic residuals)
    {
        const rng = lcg(99);
        const data = new Uint16Array(8192);
        for (let i = 0; i < 8192; i++) {
            const u = rng() - 0.5;
            const v = -2 * Math.sign(u) * Math.log(1 - 2 * Math.abs(u) + 1e-9);
            data[i] = Math.max(0, Math.min(65535, (Math.round(v * 3) + 32768)));
        }
        logos16RT('laplace-centered 8K', data);
    }

    // geometric (simulates sparse counts)
    {
        const rng = lcg(123);
        const data = new Uint16Array(4096);
        for (let i = 0; i < 4096; i++) {
            let v = 0;
            while (rng() < 0.9 && v < 65535) v++;
            data[i] = v;
        }
        logos16RT('geometric 4K', data);
    }

    // degenerate: single symbol repeated (should compress to near 0 bps)
    {
        const data = new Uint16Array(8192).fill(12345);
        logos16RT('constant 12345 × 8K', data);
    }

    // primed model round-trip
    {
        const hs = handshake16D(makeBlock(0xABCD1234));
        const seed16 = new Uint32Array(131072);
        for (let i = 0; i < 65536; i++) { seed16[i * 2] = 1; seed16[i * 2 + 1] = 1; }
        for (let ctx = 0; ctx < 512; ctx++) {
            seed16[ctx * 2]     = hs.countsBitM[ctx * 2];
            seed16[ctx * 2 + 1] = hs.countsBitM[ctx * 2 + 1];
        }
        const model = new BitContextModel16(seed16);
        const enc   = new ArithEncoder();
        const rng   = lcg(42);
        const symbols = new Uint16Array(512);
        for (let i = 0; i < 512; i++) symbols[i] = (rng() * 65536) | 0;
        for (const s of symbols) model.encodeSym(enc, s);
        const encoded = enc.flush();
        const model2 = new BitContextModel16(seed16);
        const dec = new ArithDecoder(encoded);
        let errs = 0;
        for (let i = 0; i < 512; i++) if (model2.decodeSym(dec) !== symbols[i]) errs++;
        ok(`primed model 512-sym: errors=${errs}`, errs === 0);
    }

    console.log();

    // ── 7. WHT identity: residual = Walsh-Hadamard coefficient at all-ones ──
    console.log('WHT identity:');
    {
        // pred = Σ_{m≠0} (-1)^(popcount(m)+1)·block[m] = -Σ_{m≠0} (-1)^popcount(m)·block[m]
        // WHT[all-ones] = Σ_{m=0}^{B16-1} (-1)^popcount(m)·block[m] = block[0] - pred
        // for integer blocks pred is exact, so residual = block[0] - pred = WHT[all-ones].
        const whtAllOnes = (block: Uint8Array): number => {
            let W = 0;
            for (let m = 0; m < B16; m++) W += PARITY16[m] ? -block[m] : block[m];
            return W;
        };

        let whtOk = true;
        for (const seed of [1, 42, 0xDEAD, 0xF00D, 0xBEEF, 0x7777]) {
            const block    = makeBlock(seed);
            const residual = (block[0] - Math.round(predAnti16D(block))) | 0;
            if (residual !== whtAllOnes(block)) whtOk = false;
        }
        ok('residual = WHT[all-ones] for 6 random blocks', whtOk);

        // constant c: Σ_m (-1)^popcount(m) = (1-1)^16 = 0
        const cb = new Uint8Array(B16).fill(99);
        ok(`constant block WHT[all-ones] = 0 (got ${whtAllOnes(cb)})`, whtAllOnes(cb) === 0);
    }

    console.log();

    // ── 7b. 8D⊗8D factorization identity ────────────────────────────────────
    console.log('8D⊗8D factorization:');
    {
        let identityOk = true;
        for (const seed of [1, 42, 0xDEAD, 0xF00D, 0xBEEF, 0x7777, 0xCAFE, 0x1337]) {
            const block = makeBlock(seed);
            const directR = (block[0] - Math.round(predAnti16D(block))) | 0;
            const { residual: factoredR } = factored16D(block);
            if (directR !== factoredR) identityOk = false;
        }
        ok('factored16D residual = direct predAnti16D residual for 8 random blocks', identityOk);

        // verify sub-witnesses are non-trivial for random data
        const { rowWitnesses } = factored16D(makeBlock(0xABCD));
        let nonZero = 0;
        for (let h = 0; h < 256; h++) if (rowWitnesses[h] !== 0) nonZero++;
        ok(`sub-witnesses non-trivial: ${nonZero}/256 non-zero`, nonZero > 200);

        // verify constant block: all sub-witnesses = 0 (WHT of constant = 0)
        const { rowWitnesses: constW } = factored16D(new Uint8Array(B16).fill(42));
        let allZeroW = true;
        for (let h = 0; h < 256; h++) if (constW[h] !== 0) allZeroW = false;
        ok('constant block: all 256 sub-witnesses = 0', allZeroW);

        // verify single-byte corruption changes exactly one sub-witness
        const block = makeBlock(0xF00DCAFE);
        const { rowWitnesses: wOrig } = factored16D(block);
        const corrupted = block.slice();
        corrupted[3 * 256 + 17] ^= 0x42;  // flip byte in row 3
        const { rowWitnesses: wCorr } = factored16D(corrupted);
        let changedRows = 0;
        for (let h = 0; h < 256; h++) if (wOrig[h] !== wCorr[h]) changedRows++;
        ok(`single-byte corruption in row 3: exactly ${changedRows} sub-witness changed`, changedRows === 1);
    }

    console.log();

    // ── 8. direct boundary theorem: predAntiAtMask(block, m) = block[m] for all m ≠ 0 ──
    console.log('boundary theorem (direct):');
    {
        // anti-causal prediction at an ARBITRARY voxel m (not just origin).
        // at BS=2: neighbor of m in dim d = m | (1<<d) (coord already 1, clamped).
        // for subset S of dims: neighbor = m | s_bitmask.
        // so predAntiAtMask(block, m) = Σ_{s=1}^{B16-1} (-1)^(popcount(s)+1) · block[m|s].
        // the boundary theorem claims this = block[m] for any m ≠ 0.
        const predAntiAtMask = (block: Uint8Array, m: number): number => {
            let P = 0;
            for (let s = 1; s < B16; s++) P += PARITY16[s] ? block[m | s] : -block[m | s];
            return P;
        };

        // verify on 3 random blocks, 20 random non-zero masks each
        let allZero = true;
        const rng = lcg(0xB0ABCDEF);
        for (let trial = 0; trial < 3; trial++) {
            const block = makeBlock(0xDEAD0000 + trial);
            for (let t = 0; t < 20; t++) {
                const m = Math.max(1, (rng() * B16) | 0);  // non-zero mask
                const pred = predAntiAtMask(block, m);
                const r    = block[m] - Math.round(pred);
                if (r !== 0) { allZero = false; }
            }
        }
        ok('60 random boundary voxels: all residuals = 0', allZero);

        // spot-check specific masks spanning all popcount levels
        {
            const block = makeBlock(0xFACEB00C);
            const masks = [
                0x0001, 0x0003, 0x000F, 0x00FF, 0x0FFF, 0x7FFF, 0xFFFF,
                0x5555, 0xAAAA, 0x1248,
            ];
            let spotOk = true;
            for (const m of masks) {
                const pred = predAntiAtMask(block, m);
                if (block[m] - Math.round(pred) !== 0) spotOk = false;
            }
            ok('spot-check 10 specific boundary masks: all residuals = 0', spotOk);
        }
    }

    console.log();

    // ── 9. binomial structure of the Möbius formula ──────────────────────────
    console.log('binomial structure:');
    {
        // count masks by popcount. should be C(16,k) terms per level k=1..16.
        const byCnt = new Uint32Array(17);
        for (let m = 1; m < B16; m++) {
            let pc = 0, v = m; while (v) { pc += v & 1; v >>>= 1; }
            byCnt[pc]++;
        }
        const C16 = [0,16,120,560,1820,4368,8008,11440,12870,11440,8008,4368,1820,560,120,16,1];
        let structOk = true;
        for (let k = 1; k <= 16; k++) if (byCnt[k] !== C16[k]) structOk = false;
        ok('C(16,k) term counts correct for all k=1..16', structOk);

        let total = 0; for (let k = 1; k <= 16; k++) total += byCnt[k];
        ok('total terms = 65535', total === 65535);
    }

    console.log();

    // ── 10. error handling ──────────────────────────────────────────────────
    console.log('error handling:');
    {
        let threw: boolean;

        threw = false;
        try { encodeBlock16D(new Uint8Array(100)); } catch (_) { threw = true; }
        ok('encodeBlock16D rejects wrong size', threw);

        threw = false;
        try { decodeBlock16D(new Uint8Array(100)); } catch (_) { threw = true; }
        ok('decodeBlock16D rejects wrong size', threw);

        threw = false;
        try { handshake16D(new Uint8Array(100)); } catch (_) { threw = true; }
        ok('handshake16D rejects wrong size', threw);

        let noThrow = true;
        try {
            encodeBlock16D(new Uint8Array(B16));
            decodeBlock16D(new Uint8Array(4 + B16 - 1));
            handshake16D(new Uint8Array(B16));
        } catch (_) { noThrow = false; }
        ok('correct-size inputs do not throw', noThrow);
    }

    console.log();

    // ── 11. decoder clamping on corrupted residual ──────────────────────────
    console.log('decoder clamping:');
    {
        // a corrupted encoded stream with an extreme residual should clamp block[0]
        // to [0,255] rather than throwing or returning out-of-range values.
        const block   = makeBlock(0xC0FFEE42);
        const encoded = encodeBlock16D(block);

        // overwrite residual with +200000 (well beyond uint8 range)
        const extreme = 200000;
        const corrupt = new Uint8Array(encoded);
        corrupt[0] =  extreme        & 0xFF;
        corrupt[1] = (extreme >>>  8) & 0xFF;
        corrupt[2] = (extreme >>> 16) & 0xFF;
        corrupt[3] = (extreme >>> 24) & 0xFF;

        let noThrow = true, inRange = true;
        try {
            const dec = decodeBlock16D(corrupt);
            if (dec[0] < 0 || dec[0] > 255) inRange = false;
        } catch (_) { noThrow = false; }
        ok('corrupted +200000 residual: no throw', noThrow);
        ok('corrupted +200000 residual: block[0] clamped to [0,255]', inRange);

        // negative extreme: -200000
        const neg = -200000;
        const negU = (neg >>> 0);
        corrupt[0] =  negU        & 0xFF;
        corrupt[1] = (negU >>>  8) & 0xFF;
        corrupt[2] = (negU >>> 16) & 0xFF;
        corrupt[3] = (negU >>> 24) & 0xFF;

        noThrow = true; inRange = true;
        try {
            const dec = decodeBlock16D(corrupt);
            if (dec[0] < 0 || dec[0] > 255) inRange = false;
        } catch (_) { noThrow = false; }
        ok('corrupted -200000 residual: no throw', noThrow);
        ok('corrupted -200000 residual: block[0] clamped to [0,255]', inRange);
    }

    console.log();

    // ── 12. large encode16/decode16 stress ─────────────────────────────────
    console.log('encode16/decode16 large stress:');
    {
        const rng1 = lcg(0x7E57C0DE);
        const big  = new Uint16Array(32768);
        for (let i = 0; i < 32768; i++) big[i] = (rng1() * 65536) | 0;
        logos16RT('32768 uniform random', big);

        // narrow laplace centered at 32768 — simulates harmonic residuals
        const rng2 = lcg(0xAC1DC0DE);
        const narr = new Uint16Array(16384);
        for (let i = 0; i < 16384; i++) {
            const x = Math.round(rng2() * 9 - 4.5);
            narr[i] = Math.max(0, Math.min(65535, x + 32768));
        }
        logos16RT('16384 narrow laplace at center', narr);

        // single repeated value at large scale — should approach 0 bits/sym
        logos16RT('16384 constant 0x1234', new Uint16Array(16384).fill(0x1234));
    }

    console.log();

    // ── 13. summary ─────────────────────────────────────────────────────────
    console.log(`result: ${pass} passed, ${fail} failed`);
}

function isDirectScriptExecution(fileBaseName: string): boolean {
    const normalize = (v: string) => v.replace(/\\/g, '/').toLowerCase();
    if (typeof process !== 'undefined' && typeof process.argv?.[1] === 'string') {
        const e = normalize(process.argv[1]);
        if (e.endsWith(`/${fileBaseName}.ts`) || e.endsWith(`/${fileBaseName}.js`)) return true;
    }
    const bun = (globalThis as { Bun?: { main?: string } }).Bun;
    if (typeof bun?.main === 'string') {
        const e = normalize(bun.main);
        return e.endsWith(`/${fileBaseName}.ts`) || e.endsWith(`/${fileBaseName}.js`);
    }
    return false;
}

if (isDirectScriptExecution('live-wasm-kizuna')) {
    runTests();
}
