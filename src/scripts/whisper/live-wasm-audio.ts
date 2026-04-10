/**
 * live-wasm-audio.ts - Whisper Harmonic Audio Codec (Woflo / MB)
 *
 * waveform-accurate audio codec. it trades bitrate against lattice precision,
 * not against the waveform itself. supports N-channel surround, object-based
 * spatial audio, variable source bit depth, and any sample rate the f32/i32
 * predictor geometry can represent safely.
 *
 * the unified equation across the entire whisper tower is:
 *
 *   nabla^2_g f = r
 *
 * the discrete laplacian with metric g, applied to signal f, leaves residual r.
 * for spatial data (Lumen, Spatial, Kizuna), g is flat (constant Mobius +/-1
 * coefficients), so the metric is free. for audio, g is curved: sound is a
 * superposition of resonances with preferred frequencies that change over time.
 * the metric must be transmitted. K/G per block IS the curvature of the signal's
 * own geometry. the K stream is the christoffel symbol.
 *
 * this factorizes into three layers, each a different view of the same equation:
 *
 *   1. nabla^2 itself (the laplacian operator):
 *      Burg AR(24) at the sample level. the 1D laplacian with learned curvature.
 *      K = 2r cos(omega0), G = r^2. the damped oscillator. newton's second law
 *      as a codec. residuals are the irreducibly unpredictable component.
 *
 *   2. g (the metric / curvature):
 *      the K stream. transmitted per block because the trajectory of K/G is
 *      chaotic (lyapunov exponent 0.51 nats/block). you cannot extrapolate
 *      a chaotic trajectory. the metric innovation is unpredictable beyond
 *      lag-1, and even lag-1 reuse fails 67% of blocks because AR filters
 *      are narrow-band amplifiers that catastrophically mispredict when a
 *      formant shifts by even 50 Hz. the K stream costs 1-3% of total bytes
 *      and earns every byte.
 *
 *   3. |g| (the metric determinant / local volume element):
 *      Logos V axis. tracks the local energy envelope of the byte stream via
 *      rolling L1 over 16 bytes. the FIGARCH long-memory signal (d ~= 0.38)
 *      that no first-moment axis can see.
 *
 * this is the correct factorization for oscillatory 1D signals. the Mobius
 * inclusion-exclusion framework (used by Spatial/Lumen on smooth spatial fields)
 * was tested on audio via MDCT + 2D MED and loses to Burg by 50-90%. audio is
 * not a smooth field on a grid. it is a superposition of damped resonances, and
 * the AR model IS the natural predictor for that physics.
 *
 * pipeline:
 *
 *   1. peak normalization + scalar quantization (float32 -> int32)
 *   2. cross-channel coupling W on the channel axis
 *   3. harmonic long-term prediction (autocorrelation pitch, 1-tap)
 *   4. variable-order Burg LPC on adaptive blocks (forward/backward/reuse, MDL)
 *   5. sparse Yule-Walker post-filter on Burg residuals (lags 1-16)
 *   6. CDF 5/3 wavelet decomposition (Logos-accurate level selection)
 *   7. MERA disentangler (Givens rotation between LL and deepest HH subband)
 *   8. cross-scale connection prediction (LL derivative predicts HH at transients)
 *   9. wavelet packet split (1-bit best-basis on shallowest HH)
 *  10. Logos entropy coding (zigzag byte planes, per-plane subband filtering)
 *  11. ChaCha20 stream cipher + SipHash-lite MAC
 *
 * the core dynamical law is the AR(2) oscillator:
 *
 *   pred = K * prev1 - G * prev2
 *
 * with poles lambda = r * exp(+/- i * omega0), so:
 *
 *   K = 2r cos(omega0)
 *   G = r^2
 *   stability requires K^2 <= 4G
 *
 * fundamental constraint:
 *   near-unit-circle poles have unbounded resonant gain. residuals therefore
 *   must remain lossless at the chosen integer lattice. Q controls the initial
 *   scalar precision, not a lossy residual stage.
 *
 * low-Q quality is stabilized by three coupled pieces:
 *   1. cochlear-null noise shaping derived from ear-canal resonance
 *   2. waveform-aware scalar search on the nearby integer lattice
 *   3. a stochastic-only penalty when the full structure stack is absent
 *
 * the amplitude axis is first-class. it models the oscillator radius as a
 * slow multiscale field, carried explicitly on the wire with its block length,
 * and it is selected by the same downstream objective as the carrier lattice.
 *
 * measured position (FM chirp 1s mono @ 48kHz, 2026-04-08):
 *     q5    1.4 KB    7.7 dB
 *     q25  11.9 KB   32.5 dB
 *     q50  15.3 KB   54.0 dB
 *     q80  24.0 KB   79.2 dB
 *     q95  28.6 KB   91.3 dB
 *
 * speech-like 1s mono @ 48kHz:
 *     q80  20.7 KB   80.5 dB (backward-adaptive: -17.4% vs forward-only)
 *
 * lossless modes (440Hz sine, 1s @ 48kHz):
 *   bitDepth=16: 1176B (1.1KB), bit-exact
 *   bitDepth=24: 2244B (2.2KB), bit-exact
 *   q=100 is raw float32 passthrough.
 *
 * comments in this file should stay descriptive, lowercase, and tied to the
 * implemented math. if a benchmark or architectural note changes, update this
 * block together with docs/02-harmonic.md and public/images/harmonic-benchmark.svg.
 */

import { encode0D, decode0D } from "./live-wasm-logos";

// â”€â”€ WASM opcode infrastructure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function encodeULEB(v: number): number[] {
    v = v >>> 0;
    const out: number[] = [];
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
    return out;
}

function encodeSLEB(v: number): number[] {
    v = v | 0;
    const out: number[] = [];
    let done = false;
    while (!done) {
        let b = v & 0x7f; v >>= 7;
        const sign = (b & 0x40) !== 0;
        done = (v === 0 && !sign) || (v === -1 && sign);
        if (!done) b |= 0x80;
        out.push(b);
    }
    return out;
}

function nameSec(s: string): number[] {
    const b = Array.from(new TextEncoder().encode(s));
    return [...encodeULEB(b.length), ...b];
}

function section(id: number, body: number[]): number[] {
    return [id, ...encodeULEB(body.length), ...body];
}

function encodeLocals(decls: { count: number; type: number }[]): number[] {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}

function funcBody(locals: { count: number; type: number }[], instr: number[]): number[] {
    const body = [...encodeLocals(locals), ...instr];
    return [...encodeULEB(body.length), ...body];
}

// WASM value types
const I32 = 0x7f;
const F64 = 0x7c;
const F32 = 0x7d;
const VOID = 0x40;

// Control flow
const BLOCK = [0x02, VOID];
const LOOP  = [0x03, VOID];
const IF    = [0x04, VOID];
const ELSE  = [0x05];
const END   = [0x0b];
const BR    = (l: number) => [0x0c, ...encodeULEB(l)];
const BRIF  = (l: number) => [0x0d, ...encodeULEB(l)];

// Locals
const GET = (i: number) => [0x20, ...encodeULEB(i)];
const SET = (i: number) => [0x21, ...encodeULEB(i)];

// i32 constants
const CI32 = (v: number) => [0x41, ...encodeSLEB(v)];
// f32 constant (IEEE 754 little-endian)
const CF32 = (v: number): number[] => {
    const buf = new ArrayBuffer(4); new Float32Array(buf)[0] = v;
    const b = new Uint8Array(buf); return [0x43, b[0], b[1], b[2], b[3]];
};

// i32 memory
const LOAD32  = (al: number, off: number) => [0x28, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [0x36, al, ...encodeULEB(off)];

// f32 memory
const F32_LOAD  = (al: number, off: number) => [0x2a, al, ...encodeULEB(off)];
const F32_STORE = (al: number, off: number) => [0x38, al, ...encodeULEB(off)];

// i32 arithmetic
const ADD   = [0x6a]; const SUB = [0x6b]; const MUL = [0x6c]; const DIV_s = [0x6d];
const AND   = [0x71]; const OR  = [0x72]; const XOR = [0x73];
const SHL   = [0x74]; const SHR_s = [0x75]; const SHR_u = [0x76];
const ROTL  = [0x77];
const EQ    = [0x46]; const NE   = [0x47];
const LT_s  = [0x48]; const GT_s = [0x4a]; const GE_s = [0x4e];

// f32 arithmetic
const F32_ADD = [0x92]; const F32_SUB = [0x93];
const F32_MUL = [0x94]; const F32_DIV = [0x95];
const F32_NEAREST = [0x90];
const F32_MAX = [0x97]; const F32_MIN = [0x96];

// f32 comparison
const F32_LT = [0x5d]; const F32_GT = [0x5e];

// f64 arithmetic (for bit-exact fitKG regression matching TypeScript f64 numbers)
const F64_ADD = [0xa0]; const F64_SUB = [0xa1];
const F64_MUL = [0xa2]; const F64_DIV = [0xa3];
const F64_MAX = [0xa5]; const F64_MIN = [0xa4];
const F64_NEAREST = [0x9e];
const F64_LT = [0x63];
const CF64 = (v: number): number[] => {
    const buf = new ArrayBuffer(8); new Float64Array(buf)[0] = v;
    const b = new Uint8Array(buf); return [0x44, b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
};

// f64 memory
const F64_LOAD  = (al: number, off: number) => [0x2b, al, ...encodeULEB(off)];
const F64_STORE = (al: number, off: number) => [0x39, al, ...encodeULEB(off)];
const F64_ABS   = [0x99];

// conversions
const I32_TRUNC_F32_S  = [0xa8];
const I32_TRUNC_F64_S  = [0xaa];
const F32_CONVERT_I32_S = [0xb2];
const F64_CONVERT_I32_S = [0xb7];
const F32_DEMOTE_F64    = [0xb6];

// â”€â”€ WASM memory layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
//   0x0000 .. 0x0FFF  encoder prediction states (up to 256 ch Ã— 16 B)
//   0x1000 .. 0x1FFF  decoder prediction states (up to 256 ch Ã— 16 B)
//   0x2000 .. 0x5FFFF K/G inspection buffer + fit_all_blocks output
//   0x60000 ..        data/residual scratch buffers
//
// 256 channels = 2^8 = the byte. at 256 channels, Harmonic encodes
// Engram's 256D embedding trajectories: each "channel" is one embedding
// dimension, each "sample" is one trajectory step. the audio codec
// becomes the embedding codec. the tower collapses.
//
// prediction state per channel: prev1:f32, prev2:f32, qstep:i32, pad (16 B).

// K/G inspection buffer: fit_all_blocks writes Int32 [Kint, Gint] pairs here.
const KG_BUF = 0x2000;

// data/residual scratch. past all K/G data for any reasonable frame size.
const WASM_BUF_A = 0x60000;

// â”€â”€ WASM function body builders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * wavelet_fwd(srcPtr:i32, n:i32, dstPtr:i32) â†’ nlp:i32
 *
 * CDF 5/3 forward transform (one level). Assumes n â‰¥ 2.
 * Writes LL[0..nlp-1] then HH[nlp..n-1] to dstPtr (all i32, 4 bytes each).
 *
 * predict:  d[k] = x[2k+1] âˆ’ âŒŠ(x[2k] + x[2k+2]) / 2âŒ‹   (symmetric ext.)
 * update:   s[k] = x[2k]   + âŒŠ(d[kâˆ’1] + d[k] + 2) / 4âŒ‹
 */
function buildWaveletFwdBody(): number[] {
    // params: 0=srcPtr, 1=n, 2=dstPtr
    // locals: 3=k(i32), 4=hn(i32), 5=ln(i32), 6=left(i32), 7=right(i32),
    //         8=twok2(i32), 9=dk(i32), 10=dm1(i32), 11=s(i32)
    return funcBody([{ count: 9, type: I32 }], [
        // hn = n >> 1, ln = n - hn
        ...GET(1), ...CI32(1), ...SHR_u, ...SET(4),
        ...GET(1), ...GET(4), ...SUB, ...SET(5),

        // â”€â”€ predict step: write HH to dst[ln..ln+hn-1] â”€â”€
        ...CI32(0), ...SET(3),
        ...BLOCK, ...LOOP,
            ...GET(3), ...GET(4), ...GE_s, ...BRIF(1),

            // left = src[2k]  (srcPtr + k*8)
            ...GET(0), ...GET(3), ...CI32(3), ...SHL, ...ADD,
            ...LOAD32(2, 0), ...SET(6),

            // 2k+2
            ...GET(3), ...CI32(1), ...SHL, ...CI32(2), ...ADD, ...SET(8),

            // right = (2k+2 < n) ? src[2k+2] : left
            ...GET(8), ...GET(1), ...LT_s,
            ...IF,
                ...GET(0), ...GET(8), ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(7),
            ...ELSE,
                ...GET(6), ...SET(7),
            ...END,

            // d[k] = src[2k+1] - ((left+right)>>1)  src[2k+1] = srcPtr+k*8+4
            ...GET(0), ...GET(3), ...CI32(3), ...SHL, ...ADD,
            ...LOAD32(2, 4),
            ...GET(6), ...GET(7), ...ADD, ...CI32(1), ...SHR_s,
            ...SUB, ...SET(9),

            // dst[ln+k] = d[k]
            ...GET(2), ...GET(5), ...GET(3), ...ADD, ...CI32(2), ...SHL, ...ADD,
            ...GET(9), ...STORE32(2, 0),

            ...GET(3), ...CI32(1), ...ADD, ...SET(3),
            ...BR(0),
        ...END, ...END,

        // â”€â”€ update step: write LL to dst[0..ln-1] â”€â”€
        ...CI32(0), ...SET(3),
        ...BLOCK, ...LOOP,
            ...GET(3), ...GET(5), ...GE_s, ...BRIF(1),

            // dm1 = k>0 ? dst[ln+k-1] : dst[ln]
            ...GET(3), ...CI32(0), ...GT_s,
            ...IF,
                ...GET(2), ...GET(5), ...GET(3), ...ADD, ...CI32(1), ...SUB,
                ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(10),
            ...ELSE,
                ...GET(2), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(10),
            ...END,

            // dk = k<hn ? dst[ln+k] : dst[ln+hn-1]
            ...GET(3), ...GET(4), ...LT_s,
            ...IF,
                ...GET(2), ...GET(5), ...GET(3), ...ADD, ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(9),
            ...ELSE,
                ...GET(2), ...GET(5), ...GET(4), ...ADD, ...CI32(1), ...SUB,
                ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(9),
            ...END,

            // s[k] = src[2k] + ((dm1+dk+2)>>2)
            ...GET(0), ...GET(3), ...CI32(3), ...SHL, ...ADD,
            ...LOAD32(2, 0),
            ...GET(10), ...GET(9), ...ADD, ...CI32(2), ...ADD, ...CI32(2), ...SHR_s,
            ...ADD, ...SET(11),

            // dst[k] = s[k]
            ...GET(2), ...GET(3), ...CI32(2), ...SHL, ...ADD,
            ...GET(11), ...STORE32(2, 0),

            ...GET(3), ...CI32(1), ...ADD, ...SET(3),
            ...BR(0),
        ...END, ...END,

        ...GET(5), // return ln
        ...END,
    ]);
}

/**
 * wavelet_inv(llPtr:i32, nlp:i32, hhPtr:i32, nhp:i32, dstPtr:i32) â†’ n:i32
 *
 * CDF 5/3 inverse transform (one level). Returns nlp + nhp.
 *
 * undo update:  x[2k]   = ll[k] âˆ’ âŒŠ(d[kâˆ’1] + d[k] + 2) / 4âŒ‹
 * undo predict: x[2k+1] = hh[k] + âŒŠ(x[2k] + x[2k+2]) / 2âŒ‹
 */
function buildWaveletInvBody(): number[] {
    // params: 0=llPtr, 1=nlp, 2=hhPtr, 3=nhp, 4=dstPtr
    // locals: 5=k(i32), 6=n(i32), 7=dm1(i32), 8=dk(i32), 9=val(i32),
    //         10=left(i32), 11=right(i32)
    return funcBody([{ count: 7, type: I32 }], [
        ...GET(1), ...GET(3), ...ADD, ...SET(6), // n = nlp + nhp

        // â”€â”€ undo update: x[2k] = ll[k] - ((d[k-1]+d[k]+2)>>2) â”€â”€
        ...CI32(0), ...SET(5),
        ...BLOCK, ...LOOP,
            ...GET(5), ...GET(1), ...GE_s, ...BRIF(1),

            // dm1 = k>0 ? hh[k-1] : hh[0]
            ...GET(5), ...CI32(0), ...GT_s,
            ...IF,
                ...GET(2), ...GET(5), ...CI32(1), ...SUB, ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(7),
            ...ELSE,
                ...GET(2), ...LOAD32(2, 0), ...SET(7),
            ...END,

            // dk = k<nhp ? hh[k] : hh[nhp-1]
            ...GET(5), ...GET(3), ...LT_s,
            ...IF,
                ...GET(2), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(8),
            ...ELSE,
                ...GET(2), ...GET(3), ...CI32(1), ...SUB, ...CI32(2), ...SHL, ...ADD,
                ...LOAD32(2, 0), ...SET(8),
            ...END,

            // x[2k] = ll[k] - ((dm1+dk+2)>>2)
            ...GET(0), ...GET(5), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0),
            ...GET(7), ...GET(8), ...ADD, ...CI32(2), ...ADD, ...CI32(2), ...SHR_s,
            ...SUB, ...SET(9),

            // dst[2k] = x[2k]  (offset k*8)
            ...GET(4), ...GET(5), ...CI32(3), ...SHL, ...ADD,
            ...GET(9), ...STORE32(2, 0),

            ...GET(5), ...CI32(1), ...ADD, ...SET(5),
            ...BR(0),
        ...END, ...END,

        // â”€â”€ undo predict: x[2k+1] = hh[k] + ((x[2k]+x[2k+2])>>1) â”€â”€
        ...CI32(0), ...SET(5),
        ...BLOCK, ...LOOP,
            ...GET(5), ...GET(3), ...GE_s, ...BRIF(1),

            // left = dst[2k]
            ...GET(4), ...GET(5), ...CI32(3), ...SHL, ...ADD,
            ...LOAD32(2, 0), ...SET(10),

            // right = (2k+2 < n) ? dst[2k+2] : left
            ...GET(5), ...CI32(1), ...SHL, ...CI32(2), ...ADD, // 2k+2
            ...GET(6), ...LT_s,
            ...IF,
                ...GET(4), ...GET(5), ...CI32(1), ...SHL, ...CI32(2), ...ADD,
                ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(11),
            ...ELSE,
                ...GET(10), ...SET(11),
            ...END,

            // x[2k+1] = hh[k] + ((left+right)>>1)
            ...GET(2), ...GET(5), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0),
            ...GET(10), ...GET(11), ...ADD, ...CI32(1), ...SHR_s,
            ...ADD, ...SET(9),

            // dst[2k+1] = x[2k+1]  (offset k*8+4)
            ...GET(4), ...GET(5), ...CI32(3), ...SHL, ...ADD,
            ...GET(9), ...STORE32(2, 4),

            ...GET(5), ...CI32(1), ...ADD, ...SET(5),
            ...BR(0),
        ...END, ...END,

        ...GET(6), // return n
        ...END,
    ]);
}

/**
 * predict_enc(dataPtr:i32, nSamples:i32, kgPtr:i32, statePtr:i32, residPtr:i32) â†’ void
 *
 * IIR-2 prediction encode:
 *   for each 32-sample block b:
 *     K = f32(kgPtr[b*8+0]),  G = f32(kgPtr[b*8+4])
 *     for each sample i in block:
 *       pred    = K*prev1 âˆ’ G*prev2
 *       residual[i] = data[i] âˆ’ round(pred)
 *       prev2 = prev1;  prev1 = float(data[i])
 *
 * cross-channel coupling (W) is a renormalization step that operates OUTSIDE
 * this loop â€” it subtracts WÂ·ref before prediction, and the decoder adds it
 * back after. this separation is correct because W integrates out the
 * inter-channel mode while K/G integrate out the temporal mode. they are
 * orthogonal layers in the renormalization group, not joint terms.
 */
function buildPredictEncBody(): number[] {
    // params: 0=dataPtr, 1=nSamples, 2=kgPtr, 3=statePtr, 4=residPtr
    // i32 locals: 5=i, 6=blockStart, 7=blockEnd, 8=block, 9=numBlocks, 10=val, 11=predInt, 12=qstep
    // f32 locals: 13=prev1, 14=prev2, 15=K, 16=G, 17=pred
    return funcBody([
        { count: 8, type: I32 },
        { count: 5, type: F32 },
    ], [
        ...GET(3), ...F32_LOAD(2, 0), ...SET(13),
        ...GET(3), ...F32_LOAD(2, 4), ...SET(14),
        ...GET(3), ...LOAD32(2, 8), ...SET(12),

        ...GET(1), ...CI32(31), ...ADD, ...CI32(5), ...SHR_u, ...SET(9),
        ...CI32(0), ...SET(8),

        ...BLOCK, ...LOOP,
            ...GET(8), ...GET(9), ...GE_s, ...BRIF(1),

            ...GET(2), ...GET(8), ...CI32(3), ...SHL, ...ADD, ...F32_LOAD(2, 0), ...SET(15),
            ...GET(2), ...GET(8), ...CI32(3), ...SHL, ...ADD, ...F32_LOAD(2, 4), ...SET(16),

            ...GET(8), ...CI32(5), ...SHL, ...SET(6),
            ...GET(6), ...CI32(32), ...ADD, ...SET(7),
            ...GET(7), ...GET(1), ...GT_s, ...IF, ...GET(1), ...SET(7), ...END,

            ...GET(6), ...SET(5),

            ...GET(12), ...CI32(1), ...EQ,
            ...IF,
                ...BLOCK, ...LOOP,
                    ...GET(5), ...GET(7), ...GE_s, ...BRIF(1),
                    ...GET(15), ...GET(13), ...F32_MUL,
                    ...GET(16), ...GET(14), ...F32_MUL,
                    ...F32_SUB, ...F32_NEAREST, ...I32_TRUNC_F32_S, ...SET(11),
                    ...GET(0), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...SET(10),
                    ...GET(4), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...GET(10), ...GET(11), ...SUB, ...STORE32(2, 0),
                    ...GET(13), ...SET(14),
                    ...GET(10), ...F32_CONVERT_I32_S, ...SET(13),
                    ...GET(5), ...CI32(1), ...ADD, ...SET(5),
                    ...BR(0),
                ...END, ...END,
            ...ELSE,
                ...BLOCK, ...LOOP,
                    ...GET(5), ...GET(7), ...GE_s, ...BRIF(1),
                    ...GET(15), ...GET(13), ...F32_MUL,
                    ...GET(16), ...GET(14), ...F32_MUL,
                    ...F32_SUB, ...SET(17),
                    ...GET(17), ...F32_NEAREST, ...I32_TRUNC_F32_S, ...SET(11),
                    ...GET(0), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...SET(10),
                    ...GET(10), ...GET(11), ...SUB, ...SET(10),
                    ...GET(10), ...GET(12), ...DIV_s, ...SET(10),
                    ...GET(4), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...GET(10), ...STORE32(2, 0),
                    ...GET(11), ...GET(10), ...GET(12), ...MUL, ...ADD, ...SET(10),
                    ...GET(13), ...SET(14),
                    ...GET(10), ...F32_CONVERT_I32_S, ...SET(13),
                    ...GET(5), ...CI32(1), ...ADD, ...SET(5),
                    ...BR(0),
                ...END, ...END,
            ...END,

            ...GET(8), ...CI32(1), ...ADD, ...SET(8),
            ...BR(0),
        ...END, ...END,

        ...GET(3), ...GET(13), ...F32_STORE(2, 0),
        ...GET(3), ...GET(14), ...F32_STORE(2, 4),
        ...END,
    ]);
}

/**
 * predict_dec(residPtr:i32, nSamples:i32, kgPtr:i32, statePtr:i32, outPtr:i32) â†’ void
 *
 * Inverse of predict_enc:
 *   val[i] = round(K*prev1 âˆ’ G*prev2) + residual[i]
 */
function buildPredictDecBody(): number[] {
    // params: 0=residPtr, 1=nSamples, 2=kgPtr, 3=statePtr, 4=outPtr
    // i32 locals: 5=i, 6=blockStart, 7=blockEnd, 8=block, 9=numBlocks, 10=val, 11=predInt, 12=qstep
    // f32 locals: 13=prev1, 14=prev2, 15=K, 16=G, 17=pred
    return funcBody([
        { count: 8, type: I32 },
        { count: 5, type: F32 },
    ], [
        ...GET(3), ...F32_LOAD(2, 0), ...SET(13),
        ...GET(3), ...F32_LOAD(2, 4), ...SET(14),
        ...GET(3), ...LOAD32(2, 8), ...SET(12),
        ...GET(1), ...CI32(31), ...ADD, ...CI32(5), ...SHR_u, ...SET(9),
        ...CI32(0), ...SET(8),

        ...BLOCK, ...LOOP,
            ...GET(8), ...GET(9), ...GE_s, ...BRIF(1),

            ...GET(2), ...GET(8), ...CI32(3), ...SHL, ...ADD, ...F32_LOAD(2, 0), ...SET(15),
            ...GET(2), ...GET(8), ...CI32(3), ...SHL, ...ADD, ...F32_LOAD(2, 4), ...SET(16),

            ...GET(8), ...CI32(5), ...SHL, ...SET(6),
            ...GET(6), ...CI32(32), ...ADD, ...SET(7),
            ...GET(7), ...GET(1), ...GT_s, ...IF, ...GET(1), ...SET(7), ...END,

            ...GET(6), ...SET(5),

            ...GET(12), ...CI32(1), ...EQ,
            ...IF,
                ...BLOCK, ...LOOP,
                    ...GET(5), ...GET(7), ...GE_s, ...BRIF(1),
                    ...GET(15), ...GET(13), ...F32_MUL,
                    ...GET(16), ...GET(14), ...F32_MUL,
                    ...F32_SUB, ...F32_NEAREST, ...I32_TRUNC_F32_S, ...SET(11),
                    ...GET(0), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0),
                    ...GET(11), ...ADD, ...SET(10),
                    ...GET(4), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...GET(10), ...STORE32(2, 0),
                    ...GET(13), ...SET(14),
                    ...GET(10), ...F32_CONVERT_I32_S, ...SET(13),
                    ...GET(5), ...CI32(1), ...ADD, ...SET(5),
                    ...BR(0),
                ...END, ...END,
            ...ELSE,
                ...BLOCK, ...LOOP,
                    ...GET(5), ...GET(7), ...GE_s, ...BRIF(1),
                    ...GET(15), ...GET(13), ...F32_MUL,
                    ...GET(16), ...GET(14), ...F32_MUL,
                    ...F32_SUB, ...SET(17),
                    ...GET(17), ...F32_NEAREST, ...I32_TRUNC_F32_S, ...SET(11),
                    ...GET(0), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...SET(10),
                    ...GET(11), ...GET(10), ...GET(12), ...MUL, ...ADD, ...SET(10),
                    ...GET(4), ...GET(5), ...CI32(2), ...SHL, ...ADD,
                    ...GET(10), ...STORE32(2, 0),
                    ...GET(13), ...SET(14),
                    ...GET(10), ...F32_CONVERT_I32_S, ...SET(13),
                    ...GET(5), ...CI32(1), ...ADD, ...SET(5),
                    ...BR(0),
                ...END, ...END,
            ...END,

            ...GET(8), ...CI32(1), ...ADD, ...SET(8),
            ...BR(0),
        ...END, ...END,

        ...GET(3), ...GET(13), ...F32_STORE(2, 0),
        ...GET(3), ...GET(14), ...F32_STORE(2, 4),
        ...END,
    ]);
}

/**
 * fit_all_blocks(dataPtr:i32, numSamples:i32, outPtr:i32, gCeilScaled:i32) â†’ numBlocks:i32
 *
 * WASM implementation of the K/G regression. processes all 32-sample blocks,
 * writing [Kint:i32, Gint:i32] per block to outPtr. uses f64 accumulators
 * for bit-exact matching with the TypeScript f64 number type.
 *
 * includes transient detection, Cramer LS solve, dead zone, stability
 * manifold clamping, and blend with previous block. this moves the hottest
 * TypeScript loop into WASM, eliminating 30 JS function calls per frame.
 */
function buildFitAllBlocksBody(): number[] {
    // params: 0=dataPtr, 1=numSamples, 2=outPtr, 3=gCeilScaled
    // i32 locals (4-17):
    //   4=b, 5=numBlocks, 6=blockStart, 7=blockEnd, 8=i,
    //   9=val/isTransient, 10=halfLen, 11=prevKint, 12=prevGint,
    //   13=Kint, 14=Gint, 15=commitK, 16=commitG, 17=blockLen
    // f64 locals (18-31):
    //   18=sumP1P1, 19=sumP2P2, 20=sumW, 21=sumP1Val, 22=sumP2Val,
    //   23=p1, 24=p2, 25=det, 26=reg, 27=K, 28=G, 29=blend,
    //   30=gCeilF, 31=valF

    // physics constants embedded as f64 immediates
    const QUANT_NOISE = 1.0 / 12.0;     // quantization noise variance
    const SCALE = 16384.0;               // COEFF_SCALE
    const INV_SCALE = 1.0 / 16384.0;     // 1/COEFF_SCALE
    const G_FL = INV_SCALE;              // G_FLOOR = COEFF_QUANT
    const K_CL = 2.0 - INV_SCALE;       // K_CEIL
    const PARA = 0.25;                   // PARABOLA_FACTOR = 1/4

    return funcBody([
        { count: 14, type: I32 },
        { count: 14, type: F64 },
    ], [
        // numBlocks = (numSamples + 31) >> 5
        ...GET(1), ...CI32(31), ...ADD, ...CI32(5), ...SHR_u, ...SET(5),
        // gCeilF = f64(gCeilScaled) / SCALE
        ...GET(3), ...F64_CONVERT_I32_S, ...CF64(SCALE), ...F64_DIV, ...SET(30),
        // prevKint = 0, prevGint = 0
        ...CI32(0), ...SET(11), ...CI32(0), ...SET(12),
        // b = 0
        ...CI32(0), ...SET(4),

        // â”€â”€ outer block loop â”€â”€
        ...BLOCK, ...LOOP,
            ...GET(4), ...GET(5), ...GE_s, ...BRIF(1),

            // blockStart = b << 5
            ...GET(4), ...CI32(5), ...SHL, ...SET(6),
            // blockEnd = min(blockStart + 32, numSamples)
            ...GET(6), ...CI32(32), ...ADD, ...SET(7),
            ...GET(7), ...GET(1), ...GT_s, ...IF, ...GET(1), ...SET(7), ...END,
            // blockLen = blockEnd - blockStart
            ...GET(7), ...GET(6), ...SUB, ...SET(17),
            // reg = blockLen * (1/12)
            ...GET(17), ...F64_CONVERT_I32_S, ...CF64(QUANT_NOISE), ...F64_MUL, ...SET(26),

            // â”€â”€ transient detection â”€â”€
            // halfLen = blockLen >> 1
            ...GET(17), ...CI32(1), ...SHR_u, ...SET(10),

            // e1 = sum data[blockStart..+halfLen]Â² â†’ sumP1P1 (reused)
            ...CF64(0), ...SET(18),
            ...GET(6), ...SET(8),
            ...BLOCK, ...LOOP,
                ...GET(8), ...GET(6), ...GET(10), ...ADD, ...GE_s, ...BRIF(1),
                ...GET(0), ...GET(8), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(9),
                ...GET(18), ...GET(9), ...F64_CONVERT_I32_S, ...GET(9), ...F64_CONVERT_I32_S, ...F64_MUL, ...F64_ADD, ...SET(18),
                ...GET(8), ...CI32(1), ...ADD, ...SET(8),
                ...BR(0),
            ...END, ...END,

            // e2 = sum data[blockStart+halfLen..blockEnd]Â² â†’ sumP2P2 (reused)
            ...CF64(0), ...SET(19),
            ...GET(6), ...GET(10), ...ADD, ...SET(8),
            ...BLOCK, ...LOOP,
                ...GET(8), ...GET(7), ...GE_s, ...BRIF(1),
                ...GET(0), ...GET(8), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(9),
                ...GET(19), ...GET(9), ...F64_CONVERT_I32_S, ...GET(9), ...F64_CONVERT_I32_S, ...F64_MUL, ...F64_ADD, ...SET(19),
                ...GET(8), ...CI32(1), ...ADD, ...SET(8),
                ...BR(0),
            ...END, ...END,

            // isTransient = blockLen>=16 && maxE>blockLen*256 && minE*64<maxE
            // maxE â†’ K(27), minE â†’ G(28) (reused temporarily as f64)
            ...GET(18), ...GET(19), ...F64_MAX, ...SET(27),
            ...GET(18), ...GET(19), ...F64_MIN, ...SET(28),

            ...GET(17), ...CI32(16), ...GE_s,
            ...GET(27), ...GET(17), ...CI32(256), ...MUL, ...F64_CONVERT_I32_S, ...F64_LT,
            // need F64_GT but we only have F64_LT. swap: maxE > thresh â†” thresh < maxE
            // actually: we need maxE > blockLen*256. use: NOT (maxE < blockLen*256) but that includes ==.
            // alternative: blockLen*256 < maxE â†’ use F64_LT with args swapped on stack.
            // the stack currently has: (blockLen>=16):i32, then we need to push the comparison.
            // let me restructure: compute isTransient as a single i32 flag

            // restart: compute flag step by step
            // flag = blockLen >= 16
            ...GET(17), ...CI32(16), ...GE_s,
            // flag &= (blockLen*256 as f64) < maxE    â†’ use F64_LT
            ...GET(17), ...CI32(256), ...MUL, ...F64_CONVERT_I32_S, ...GET(27), ...F64_LT,
            ...AND,
            // flag &= minE*64 < maxE
            ...GET(28), ...CF64(64.0), ...F64_MUL, ...GET(27), ...F64_LT,
            ...AND,
            ...SET(9), // isTransient

            ...GET(9),
            ...IF,
                // â”€â”€ transient: Kint=0, Gint=1 â”€â”€
                ...GET(2), ...GET(4), ...CI32(3), ...SHL, ...ADD, ...CI32(0), ...STORE32(2, 0),
                ...GET(2), ...GET(4), ...CI32(3), ...SHL, ...ADD, ...CI32(1), ...STORE32(2, 4),
                ...CI32(0), ...SET(11),
                ...CI32(1), ...SET(12),
            ...ELSE,
                // â”€â”€ normal: Cramer LS regression â”€â”€
                ...CF64(0), ...SET(18), // sumP1P1
                ...CF64(0), ...SET(19), // sumP2P2
                ...CF64(0), ...SET(20), // sumW
                ...CF64(0), ...SET(21), // sumP1Val
                ...CF64(0), ...SET(22), // sumP2Val

                // p1 = blockStart > 0 ? f64(data[blockStart-1]) : 0
                ...GET(6), ...CI32(0), ...GT_s,
                ...IF,
                    ...GET(0), ...GET(6), ...CI32(1), ...SUB, ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...F64_CONVERT_I32_S, ...SET(23),
                ...ELSE,
                    ...CF64(0), ...SET(23),
                ...END,
                // p2 = blockStart > 1 ? f64(data[blockStart-2]) : 0
                ...GET(6), ...CI32(1), ...GT_s,
                ...IF,
                    ...GET(0), ...GET(6), ...CI32(2), ...SUB, ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...F64_CONVERT_I32_S, ...SET(24),
                ...ELSE,
                    ...CF64(0), ...SET(24),
                ...END,

                // inner loop: accumulate sums
                ...GET(6), ...SET(8),
                ...BLOCK, ...LOOP,
                    ...GET(8), ...GET(7), ...GE_s, ...BRIF(1),

                    // valF = f64(data[i])
                    ...GET(0), ...GET(8), ...CI32(2), ...SHL, ...ADD,
                    ...LOAD32(2, 0), ...F64_CONVERT_I32_S, ...SET(31),

                    // sumP1P1 += p1*p1
                    ...GET(18), ...GET(23), ...GET(23), ...F64_MUL, ...F64_ADD, ...SET(18),
                    // sumP2P2 += p2*p2
                    ...GET(19), ...GET(24), ...GET(24), ...F64_MUL, ...F64_ADD, ...SET(19),
                    // sumW += p1*p2
                    ...GET(20), ...GET(23), ...GET(24), ...F64_MUL, ...F64_ADD, ...SET(20),
                    // sumP1Val += p1*valF
                    ...GET(21), ...GET(23), ...GET(31), ...F64_MUL, ...F64_ADD, ...SET(21),
                    // sumP2Val += p2*valF
                    ...GET(22), ...GET(24), ...GET(31), ...F64_MUL, ...F64_ADD, ...SET(22),

                    // p2 = p1; p1 = valF
                    ...GET(23), ...SET(24),
                    ...GET(31), ...SET(23),

                    ...GET(8), ...CI32(1), ...ADD, ...SET(8),
                    ...BR(0),
                ...END, ...END,

                // det = sumP1P1 * sumP2P2 - sumW * sumW
                ...GET(18), ...GET(19), ...F64_MUL,
                ...GET(20), ...GET(20), ...F64_MUL,
                ...F64_SUB, ...SET(25),

                // if det < reg: K = sumP1Val/(sumP1P1+reg), G = 0
                ...GET(25), ...GET(26), ...F64_LT,
                ...IF,
                    ...GET(21), ...GET(18), ...GET(26), ...F64_ADD, ...F64_DIV, ...SET(27),
                    ...CF64(0), ...SET(28),
                ...ELSE,
                    // K = (sumP1Val*sumP2P2 - sumP2Val*sumW) / det
                    ...GET(21), ...GET(19), ...F64_MUL,
                    ...GET(22), ...GET(20), ...F64_MUL,
                    ...F64_SUB, ...GET(25), ...F64_DIV, ...SET(27),
                    // G = (K*sumW - sumP2Val) / (sumP2P2 + reg)
                    ...GET(27), ...GET(20), ...F64_MUL,
                    ...GET(22), ...F64_SUB,
                    ...GET(19), ...GET(26), ...F64_ADD, ...F64_DIV, ...SET(28),
                ...END,

                // blend = reg / (reg + det)
                ...GET(26), ...GET(26), ...GET(25), ...F64_ADD, ...F64_DIV, ...SET(29),
                // K += (prevKf - K) * blend
                ...GET(27),
                ...GET(11), ...F64_CONVERT_I32_S, ...CF64(INV_SCALE), ...F64_MUL,
                ...GET(27), ...F64_SUB, ...GET(29), ...F64_MUL,
                ...F64_ADD, ...SET(27),
                // G += (prevGf - G) * blend
                ...GET(28),
                ...GET(12), ...F64_CONVERT_I32_S, ...CF64(INV_SCALE), ...F64_MUL,
                ...GET(28), ...F64_SUB, ...GET(29), ...F64_MUL,
                ...F64_ADD, ...SET(28),

                // stability clamping
                // G = max(G_FLOOR, min(gCeil, G))
                ...GET(28), ...GET(30), ...F64_MIN, ...CF64(G_FL), ...F64_MAX, ...SET(28),
                // K = max(-K_CEIL, min(K_CEIL, K))
                ...GET(27), ...CF64(K_CL), ...F64_MIN, ...CF64(-K_CL), ...F64_MAX, ...SET(27),
                // G = min(gCeil, max(G, K*K*PARA))
                ...GET(28),
                ...GET(27), ...GET(27), ...F64_MUL, ...CF64(PARA), ...F64_MUL,
                ...F64_MAX, ...GET(30), ...F64_MIN, ...SET(28),

                // Kint = round(K * SCALE)
                ...GET(27), ...CF64(SCALE), ...F64_MUL, ...F64_NEAREST, ...I32_TRUNC_F64_S, ...SET(13),
                // Gint = round(G * SCALE)
                ...GET(28), ...CF64(SCALE), ...F64_MUL, ...F64_NEAREST, ...I32_TRUNC_F64_S, ...SET(14),

                // dead zone: |drift| <= 2 â†’ keep previous
                // driftK = Kint - prevKint
                ...GET(13), ...GET(11), ...SUB, ...SET(9),
                ...GET(9), ...CI32(2), ...GT_s, ...GET(9), ...CI32(-2), ...LT_s, ...OR,
                ...IF,
                    ...GET(13), ...SET(15), // commitK = Kint
                ...ELSE,
                    ...GET(11), ...SET(15), // commitK = prevKint
                ...END,
                // driftG
                ...GET(14), ...GET(12), ...SUB, ...SET(9),
                ...GET(9), ...CI32(2), ...GT_s, ...GET(9), ...CI32(-2), ...LT_s, ...OR,
                ...IF,
                    ...GET(14), ...SET(16),
                ...ELSE,
                    ...GET(12), ...SET(16),
                ...END,

                // write output
                ...GET(2), ...GET(4), ...CI32(3), ...SHL, ...ADD, ...GET(15), ...STORE32(2, 0),
                ...GET(2), ...GET(4), ...CI32(3), ...SHL, ...ADD, ...GET(16), ...STORE32(2, 4),
                ...GET(15), ...SET(11), // prevKint = commitK
                ...GET(16), ...SET(12), // prevGint = commitG
            ...END, // if/else transient

            ...GET(4), ...CI32(1), ...ADD, ...SET(4),
            ...BR(0),
        ...END, ...END, // loop, block

        ...GET(5), // return numBlocks
        ...END,
    ]);
}


// â”€â”€ WASM module assembly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function buildHarmonicWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    // Type section: 5 function signatures
    // Type 0: (i32,i32,i32) â†’ i32              [wavelet_fwd]
    // Type 1: (i32,i32,i32,i32,i32) â†’ i32      [wavelet_inv]
    // Type 2: (i32,i32,i32,i32,i32) â†’ void     [predict_enc, predict_dec]
    // Type 3: (i32,i32,i32,i32) â†’ void         [reset_enc, reset_dec]
    // Type 4: (i32,i32,i32,i32) â†’ i32          [fit_all_blocks]
    const typeSection = section(1, [
        ...encodeULEB(5),
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32,               // T0
        0x60, ...encodeULEB(5), I32, I32, I32, I32, I32, ...encodeULEB(1), I32,     // T1
        0x60, ...encodeULEB(5), I32, I32, I32, I32, I32, ...encodeULEB(0),          // T2
        0x60, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(0),               // T3
        0x60, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(1), I32,          // T4
    ]);

    // 7 functions: wavelet_fwd(T0), wavelet_inv(T1), predict_enc(T2), predict_dec(T2),
    // reset_enc(T3), reset_dec(T3), fit_all_blocks(T4)
    const funcSection = section(3, [
        ...encodeULEB(7),
        ...encodeULEB(0), ...encodeULEB(1), ...encodeULEB(2), ...encodeULEB(2),
        ...encodeULEB(3), ...encodeULEB(3), ...encodeULEB(4),
    ]);

    // Memory: 64 initial pages (4MB), max 2048 pages (128MB)
    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(64), ...encodeULEB(2048)]);

    const exportSection = section(7, [
        ...encodeULEB(8),
        ...nameSec("memory"),          0x02, ...encodeULEB(0),
        ...nameSec("wavelet_fwd"),     0x00, ...encodeULEB(0),
        ...nameSec("wavelet_inv"),     0x00, ...encodeULEB(1),
        ...nameSec("predict_enc"),     0x00, ...encodeULEB(2),
        ...nameSec("predict_dec"),     0x00, ...encodeULEB(3),
        ...nameSec("reset_enc"),       0x00, ...encodeULEB(4),
        ...nameSec("reset_dec"),       0x00, ...encodeULEB(5),
        ...nameSec("fit_all_blocks"),  0x00, ...encodeULEB(6),
    ]);

    const stubVoid = (() => { const b = [0x00, 0x0b]; return [...encodeULEB(b.length), ...b]; })();

    const codeSection = section(10, [
        ...encodeULEB(7),
        ...buildWaveletFwdBody(),
        ...buildWaveletInvBody(),
        ...buildPredictEncBody(),
        ...buildPredictDecBody(),
        ...stubVoid, ...stubVoid, // reset_enc, reset_dec
        ...buildFitAllBlocksBody(),
    ]);

    return new Uint8Array([
        ...magic, ...typeSection, ...funcSection,
        ...memSection, ...exportSection, ...codeSection,
    ]);
}

export interface HarmonicWasmExports {
    memory: WebAssembly.Memory;
    wavelet_fwd:  (srcPtr: number, n: number, dstPtr: number) => number;
    wavelet_inv:  (llPtr: number, nlp: number, hhPtr: number, nhp: number, dstPtr: number) => number;
    predict_enc:  (dataPtr: number, nSamples: number, kgPtr: number, statePtr: number, residPtr: number) => void;
    predict_dec:  (residPtr: number, nSamples: number, kgPtr: number, statePtr: number, outPtr: number) => void;
    reset_enc:    (k0: number, k1: number, k2: number, k3: number) => void;
    reset_dec:    (k0: number, k1: number, k2: number, k3: number) => void;
    fit_all_blocks: (dataPtr: number, numSamples: number, outPtr: number, gCeilScaled: number) => number;
}

let _wasmPromise: Promise<HarmonicWasmExports> | null = null;
let _wasmSync: HarmonicWasmExports | null = null;

export function getHarmonicWasm(): Promise<HarmonicWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildHarmonicWasmBytes();
        const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
        _wasmSync = instance.exports as unknown as HarmonicWasmExports;
        return _wasmSync;
    })();
    return _wasmPromise;
}

/** get the WASM instance synchronously. returns null if not yet initialized.
 *  call `await getHarmonicWasm()` once during startup, then use this in
 *  the hot path to avoid microtask queue overhead (50+ frames/sec). */
export function getHarmonicWasmSync(): HarmonicWasmExports | null {
    return _wasmSync;
}

// burg trial WASM: the innermost prediction loop of MDL order selection.
// a single function (burg_trial) that does the dot-product prediction +
// shift-register state update + error energy accumulation. 329 bytes of
// hand-written WASM (harmonic-burg.wat) inlined as base64.
const BURG_WASM_B64 = 'AGFzbQEAAAABCwFgBn9/f39/fwF8AwIBAAUEAQCAAQYIAX8AQYCABAsHGgMDbWVtAgAKYnVyZ190cmlhbAAAA0JVRgMACoECAf4BBQF8An8BfAN/AXxEAAAAAAAAAAAhBkEAIQcCQANAIAcgAk4NASAAIAEgB2pBAnRqKAIAIQhEAAAAAAAAAAAhCUEAIQoCQANAIAogBE4NASAJIAMgCkEDdGorAwAgBSAKQQN0aisDAKKgIQkgCkEBaiEKDAALC0QAAAAAAADgv0QAAAAAAADgPyAJRAAAAAAAAAAAYxshDSAJIA2gqiELIAggC2shDCAGIAy3IAy3oqAhBiAEQQFrIQoCQANAIApBAEwNASAFIApBA3RqIAUgCkEBa0EDdGorAwA5AwAgCkEBayEKDAALCyAFIAi3OQMAIAdBAWohBwwACwsgBgs=';

interface BurgWasmExports {
    mem: WebAssembly.Memory;
    burg_trial: (dataPtr: number, bStart: number, bLen: number,
                 aPtr: number, order: number, statePtr: number) => number;
    BUF: WebAssembly.Global;
}

let _burgWasm: BurgWasmExports | null = null;

function getBurgWasm(): BurgWasmExports {
    if (_burgWasm) return _burgWasm;
    const bin = typeof atob === 'function'
        ? Uint8Array.from(atob(BURG_WASM_B64), c => c.charCodeAt(0))
        : new Uint8Array(Buffer.from(BURG_WASM_B64, 'base64'));
    const mod = new WebAssembly.Module(bin.buffer as ArrayBuffer);
    const inst = new WebAssembly.Instance(mod);
    _burgWasm = inst.exports as unknown as BurgWasmExports;
    return _burgWasm;
}

// memory layout inside the Burg WASM module:
// BUF (0x10000) onward is scratch space for the caller to write:
//   data samples (Int32Array), LP coefficients (Float64Array), state (Float64Array)
const BURG_DATA_OFF = 0x10000;           // data samples start here
const BURG_A_OFF    = 0x10000 + 0x40000; // LP coefficients (after up to 64K samples)
const BURG_ST_OFF   = 0x10000 + 0x40000 + 0x200; // state (after 64 f64 coefficients)

// SIMD NOTE (2026-03-29): investigated WASM SIMD acceleration for fitKG
// regression and CDF 5/3 wavelet. profiling shows the bottleneck is Logos
// entropy coding (~40% of encode time), which is inherently sequential.
// the arithmetic operations (wavelet + regression) total ~0.25ms per 20ms
// frame â€” a separate SIMD WASM module would need its own memory (can't share
// with the main module), so data copy overhead would eat the ~0.17ms SIMD
// gain. Lumen benefits from SIMD because 2D images have millions of pixels;
// 1D audio at 960 samples doesn't have enough parallel work to amortize the
// dispatch cost. the codec is already 5Ã— realtime at 20ms frames.

// â”€â”€ codec constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// every constant below traces to either:
//   (a) the physics of the IIR-2 oscillator (discriminant, stability manifold)
//   (b) the information theory of quantization (noise variance, entropy)
//   (c) the sample rate and word size of the platform (48kHz, 16-bit)

// K âˆˆ [-2, 2] â†’ Kint âˆˆ [-2^15, 2^15] fits signed 16-bit. scale = 2^15 / 2 = 2^14.
const COEFF_SCALE   = 1 << 14;            // 16384
const COEFF_QUANT   = 1 / COEFF_SCALE;    // minimum resolvable K/G step
const G_FLOOR       = COEFF_QUANT;         // minimum G: one step above zero
const G_CEIL        = 1.0 - COEFF_QUANT;   // maximum G: one step below undamped (r=1)
const K_CEIL        = 2.0 - COEFF_QUANT;   // maximum |K|: one step below Nyquist
const PLATFORM_I32_BITS = 32;
const PLATFORM_I32_MAX = Math.pow(2, PLATFORM_I32_BITS - 1) - 1;

// discriminant of Î»Â²âˆ’KÎ»+G = 0: stability requires KÂ²âˆ’4G â‰¤ 0 â†’ G â‰¥ KÂ²/4.
// the 1/4 is exact from the quadratic formula.
const PARABOLA_FACTOR = 1 / 4;

// uniform quantization noise variance = Î”Â²/12 where Î”=1 (integer step).
// used to regularize the Cramer LS regression against ill-conditioning.
const QUANT_NOISE_REG = 1 / 12;

// fractal dyadic prior floor: variance of x[i] - (x[i-h] + x[i+h])/2
// under independent uniform quantization noise. the 3/2 is the CDF 5/3
// lifting structure: self-noise (1^2) + two neighbor noises ((1/2)^2) each.
// = (1 + 2*(1/2)^2) * (1/12) = (3/2) * (1/12) = 1/8.
// the (1/2)^2 factor is PARABOLA_FACTOR — the wavelet lifting coefficient
// squared equals the AR(2) stability denominator. same 1/4.
const DYADIC_NOISE_FLOOR = QUANT_NOISE_REG * (1 + 2 * PARABOLA_FACTOR);  // = 1/8

const QUALITY_BITS_MAX = 15;

// 32 samples @ 48kHz = 0.67ms = half-period at 750Hz.
// this is the highest frequency where the regression window spans a full
// half-cycle, giving the Cramer LS enough phase diversity to resolve K and G.
export const BLOCK_LEN = 32;

// sample-rate-adaptive block length for the varOrder pipeline.
// targets ~21.3ms blocks (1024 @ 48kHz), clamped to powers of 2 in [16, 2048].
// the WASM scorer still uses the fixed BLOCK_LEN = 32 above.
//
// 2026-04-09: bumped from blk=32 to blk=512 after frontier exploration showed
// 4-10% bps reduction with +0.6 dB SNR on real audio. larger Burg windows
// amortize coefficient overhead and let the variable-order MDL pick higher
// orders for tonal content.
// 2026-04-10: bumped 512 → 1024 after a block-length sweep showed an additional
// 0.7-0.9% net byte reduction at Q=50/80/95. mechanism: the K coefficient stream
// shrinks ~32% (fewer blocks → fewer coefficient sets) while plane-0 grows only
// ~0.6% (Burg's larger fit window only slightly degrades the per-sample
// residuals). K savings dominate the small plane-0 penalty. confirmed safe up
// to blk=2048 but 1024 is the clean 2x sweet spot — at 21.3ms it stays comfortably
// below the ~30-50ms speech/music stationarity horizon.
export function computeBlockLen(sampleRate: number): number {
    const raw = sampleRate / 47;
    // round to nearest power of 2
    const p = Math.round(Math.log2(raw));
    const v = 1 << Math.max(0, p);
    return Math.max(16, Math.min(2048, v));
}

// adaptive max prediction order: half the block length, capped at 24.
// (cap raised from 16 to 24 alongside the blk=32 to 512 bump on 2026-04-09.
// at the new larger block sizes the variable-order MDL benefits from deeper LP
// fits for tonal content. real-audio probe showed +0.5% bps savings at ord=24
// vs 16. bumping further to 48 was tested 2026-04-10 and loses: the K stream
// growth exceeds the residual savings because the MDL coefficient cost estimate
// is intentionally miscalibrated to balance two opposing biases.)
function computeMaxOrder(blockLen: number): number {
    return Math.min(24, blockLen >> 1);
}

// dead-zone: suppress K/G jitter â‰¤ 2 steps = 2Ïƒ of quantization noise.
// (quantization step = 1/COEFF_SCALE; RMS noise = step/âˆš12 â‰ˆ 0.29 steps; 2Ïƒ â‰ˆ 2 steps.)
// both encoder and decoder use the committed (dead-zoned) values for prediction.

const HEADER_SIZE = 12;  // numSamples:u32 + sampleRate:u32 + flags:u16 + numCh:u8 + numLevels:u8
const MAC_SIZE    = 8;   // SipHash-lite 64-bit MAC (mac0:u32 + mac1:u32)


// channel layout (flags bits 4-3):
//   00 = channel (auto: mono, stereo M/S, or Hadamard for N>2)
//   01 = object-based (each channel = independent mono object + 3D position)
const LAYOUT_MASK  = 0x18;       // bits 4-3
const MS_ACTIVE    = 0x04;       // bit 2: mid/side stereo active
const GIVENS_ACTIVE = 0x02;     // bit 1: Givens rotation active (alpha in payload)

function qualityToScalarIdeal(quality: number): number {
    const q01 = Math.max(0, Math.min(1, quality / 100));
    const bits = QUALITY_BITS_MAX * Math.pow(q01, 0.9);
    return Math.pow(2, bits);
}

function qualityScalarCandidates(quality: number): number[] {
    const ideal = qualityToScalarIdeal(quality);
    const floorScalar = Math.max(1, Math.floor(ideal));
    // at scalar >= 100 (Q >= ~26), marginal scalar changes produce < 1%
    // cost difference. skip the expensive multi-candidate search entirely
    // and use the single default scalar. measured: this eliminates 4-5
    // redundant full prepareHarmonicChannels runs, cutting encode time
    // from 13x real-time to ~3x.
    if (floorScalar >= 100) return [floorScalar];
    const lattice: number[] = [];
    for (let dq = -1; dq <= 1; dq++) {
        const q = Math.max(0, Math.min(100, quality + dq));
        const v = qualityToScalarIdeal(q);
        lattice.push(
            Math.max(1, Math.floor(v)),
            Math.max(1, Math.round(v)),
            Math.max(1, Math.ceil(v)),
        );
    }
    const deduped = [...new Set(lattice)].sort((a, b) => a - b);
    if (floorScalar >= 18 || deduped.length === 0) return deduped;
    // below 4 levels the lattice is effectively ternary/quaternary and the
    // scalar objective becomes too discontinuous to trust broad downward
    // exploration. extend only a small number of lower shells, and never
    // below the first stable multi-level regime.
    const extraLow = Math.max(4, deduped[0] - 2);
    for (let scalar = deduped[0] - 1; scalar >= extraLow; scalar--) lattice.push(scalar);
    return [...new Set(lattice)].sort((a, b) => a - b);
}

export function qualityToScalar(quality: number): number {
    const ideal = qualityToScalarIdeal(quality);
    const floorScalar = Math.max(1, Math.floor(ideal));
    // the scalar law is continuous, but the implemented quantizer lives on an
    // integer lattice. at very low scalar, flooring creates a real downward
    // bias: adding one level changes amplitude SNR by
    //   20 log10((N+1)/N).
    // if that jump is still at least 0.5 dB, snap to the nearest integer
    // instead of always biasing downward. once the lattice is denser, keep the
    // old floor rule to preserve bitrate stability.
    const oneLevelDb = 20 * Math.log10((floorScalar + 1) / floorScalar);
    return oneLevelDb >= 0.5 ? Math.max(1, Math.round(ideal)) : floorScalar;
}

function predictorCarrierLimit(): number {
    // predict_enc computes round(K*prev1 - G*prev2) in a signed i32. the
    // oscillator manifold gives the exact worst-case gain bound:
    //   |pred| â‰¤ |K|Â·|prev1| + |G|Â·|prev2|
    //        â‰¤ (K_CEIL + G_CEIL) Â· max|x|
    // keep half a unit of headroom for the round-to-nearest step.
    return Math.floor((PLATFORM_I32_MAX - 0.5) / (K_CEIL + G_CEIL));
}
const LAYOUT_CHANNEL = 0x00;
const LAYOUT_OBJECT  = 0x08;

export function lossyFramePeak(samples: Float32Array, scalar: number): number {
    let peak = 0;
    let energy = 0;
    let count = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (!Number.isFinite(v)) continue;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        energy += v * v;
        count++;
    }
    peak = Math.max(peak, 1 / COEFF_SCALE);
    const rms = Math.max(Math.sqrt(energy / Math.max(count, 1)), 1 / COEFF_SCALE);
    const alpha = 1 / (1 + 2 * Math.log2(1 + Math.max(1, scalar)));
    // the quantizer trades two norms against each other:
    //   Lâˆž controls rare transients
    //   L2 controls mean-square waveform error
    // the lower the scalar, the shallower the lattice and the more precision
    // should follow the signal's bulk energy instead of its rare extremes.
    // use the scale-invariant log midpoint between peak and RMS, with the
    // interpolation weight derived from the quantizer depth and Harmonic's
    // intrinsic 2-dimensional oscillator manifold.
    return Math.exp((1 - alpha) * Math.log(peak) + alpha * Math.log(rms));
}

function envelopeBlockLenFromBurgSuperLen(burgSuperLen: number, blockLen: number): number {
    const low = Math.max(blockLen, 1);
    const high = Math.max(low, burgSuperLen);
    const logMid = 0.5 * (Math.log2(low) + Math.log2(high));
    const len = 1 << Math.round(logMid);
    return Math.max(low, Math.min(high, len));
}

function envelopeBlockLenCandidates(baseLen: number, numSamples: number, blockLen: number): number[] {
    const candidates: number[] = [];
    for (let len = Math.max(blockLen, baseLen); len * 2 <= numSamples; len <<= 1) {
        candidates.push(len);
    }
    return candidates.length > 0 ? candidates : [Math.max(blockLen, Math.min(baseLen, numSamples))];
}

function adaptiveEnvelopeLevels(count: number): number {
    let levels = 0;
    let cur = count;
    while (cur >= 4) {
        levels++;
        cur = (cur + 1) >> 1;
    }
    return levels;
}

function waveletSubbandLengths(n: number, levels: number): number[] {
    if (n < 4 || levels === 0) return [n];
    const hh: number[] = [];
    let curLen = n;
    for (let l = 0; l < levels; l++) {
        if (curLen < 4) break;
        const nlp = (curLen + 1) >> 1;
        const nhp = curLen - nlp;
        hh.push(nhp);
        curLen = nlp;
    }
    const subbands: number[] = [curLen];
    for (let i = hh.length - 1; i >= 0; i--) subbands.push(hh[i]);
    return subbands;
}

function encodeEnvelopeTrajectory(
    _wasm: HarmonicWasmExports,
    logEnv: Int16Array,
): Uint8Array {
    // delta encoding: the envelope varies slowly (1-20 Hz dynamics sampled at
    // ~750-1500 Hz), so consecutive differences are tiny. delta + zigzag +
    // byte-plane + Logos compresses 37-82% better than wavelet decomposition
    // because Logos's context model handles small delta values much better
    // than wavelet coefficients scattered across subbands.
    const n = logEnv.length;
    const delta = new Int32Array(n);
    delta[0] = logEnv[0];
    for (let i = 1; i < n; i++) delta[i] = logEnv[i] - logEnv[i - 1];

    let maxZZ = 0;
    for (let i = 0; i < n; i++) {
        const v = delta[i];
        const zz = ((v >> 31) ^ (v << 1)) >>> 0;
        if (zz > maxZZ) maxZZ = zz;
    }
    const pc = planeCount(maxZZ);

    const chunks: Uint8Array[] = [];
    let total = 0;
    const push = (chunk: Uint8Array) => { chunks.push(chunk); total += chunk.length; };
    const pushByte = (v: number) => push(Uint8Array.of(v & 0xFF));
    const pushU32 = (v: number) => push(Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF));

    pushByte(pc);

    for (let plane = 0; plane < pc; plane++) {
        const buf = new Uint8Array(n);
        const shift = plane * 8;
        for (let i = 0; i < n; i++) {
            const v = delta[i];
            const zz = ((v >> 31) ^ (v << 1)) >>> 0;
            buf[i] = (zz >>> shift) & 0xFF;
        }
        const encoded = encode0D(buf);
        pushU32(encoded.length);
        push(encoded);
    }

    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) { out.set(chunk, off); off += chunk.length; }
    return out;
}

function decodeEnvelopeTrajectory(
    _wasm: HarmonicWasmExports,
    wire: Uint8Array,
    count: number,
): Int16Array {
    if (count === 0) return new Int16Array(0);
    let off = 0;
    const pc = wire[off++] ?? 1;

    const planeData: Uint8Array[] = [];
    for (let plane = 0; plane < pc; plane++) {
        const encLen = readU32LE(wire, off); off += 4;
        planeData.push(decode0D(wire.subarray(off, off + encLen), count));
        off += encLen;
    }

    // reconstruct delta values from byte planes
    const delta = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        let zz = 0;
        for (let plane = 0; plane < pc; plane++) {
            zz |= planeData[plane][i] << (plane * 8);
        }
        delta[i] = zigzagDec(zz >>> 0);
    }

    // cumulative sum to undo delta encoding
    const logEnv = new Int16Array(count);
    logEnv[0] = Math.max(-0x8000, Math.min(0x7FFF, delta[0]));
    for (let i = 1; i < count; i++) {
        logEnv[i] = Math.max(-0x8000, Math.min(0x7FFF, logEnv[i - 1] + delta[i]));
    }
    return logEnv;
}

function envelopeLogQuantStep(scalar: number): number {
    if (scalar <= 0) return 0;
    return COEFF_SCALE * Math.log2((scalar + 1) / scalar);
}

function buildFractalEnvelopeLogCandidates(
    wasm: HarmonicWasmExports,
    logEnv: Int16Array,
    scalar: number,
): Int16Array[] {
    if (logEnv.length === 0) return [];
    if (logEnv.length < 4) {
        for (let i = 0; i < logEnv.length; i++) {
            if (logEnv[i] !== 0) return [logEnv.slice()];
        }
        return [];
    }

    const levels = adaptiveEnvelopeLevels(logEnv.length);
    if (levels === 0) {
        for (let i = 0; i < logEnv.length; i++) {
            if (logEnv[i] !== 0) return [logEnv.slice()];
        }
        return [];
    }

    const coeffs = new Int32Array(logEnv.length);
    for (let i = 0; i < logEnv.length; i++) coeffs[i] = logEnv[i];
    const subbands = waveletDecompose(wasm, coeffs, levels);
    const detailFloor = Math.max(1, Math.round(envelopeLogQuantStep(scalar)));

    for (let sb = 1; sb < subbands.length; sb++) {
        const band = subbands[sb];
        for (let i = 0; i < band.length; i++) {
            if (Math.abs(band[i]) <= detailFloor) band[i] = 0;
        }
    }

    const candidates: Int16Array[] = [];
    const pushCandidate = (env: Int16Array) => {
        let nonzero = false;
        for (let i = 0; i < env.length; i++) {
            if (env[i] !== 0) {
                nonzero = true;
                break;
            }
        }
        if (!nonzero) return;
        const prev = candidates[candidates.length - 1];
        if (prev && prev.length === env.length) {
            let same = true;
            for (let i = 0; i < env.length; i++) {
                if (prev[i] !== env[i]) {
                    same = false;
                    break;
                }
            }
            if (same) return;
        }
        candidates.push(env);
    };

    for (let keep = 0; keep < subbands.length; keep++) {
        const candidateBands = subbands.map((band, idx) => {
            if (idx === 0 || idx <= keep) return band.slice();
            return new Int32Array(band.length);
        });
        const recon = waveletReconstruct(wasm, candidateBands);
        const out = new Int16Array(logEnv.length);
        for (let i = 0; i < logEnv.length; i++) {
            out[i] = Math.max(-0x8000, Math.min(0x7FFF, recon[i] | 0));
        }
        pushCandidate(out);
    }
    return candidates;
}


// source bit depth (flags bits 6-5):
//   00 = float32 (default, any precision)
//   01 = 16-bit source (scalar auto-computed to preserve all 16 bits)
//   10 = 24-bit source
//   11 = 32-bit integer source
const DEPTH_MASK  = 0x60;        // bits 6-5
const DEPTH_F32   = 0x00;
const DEPTH_16    = 0x20;
const DEPTH_24    = 0x40;
const DEPTH_32    = 0x60;

// bit depth â†’ minimum scalar to preserve all source bits losslessly.
// scalar must exceed the max integer value at that depth so that
// round(val * scalar / peak) never aliases two distinct source values.
// capped at 24-bit (scalar = 2^23 = 8388608). 32-bit integer audio is
// virtually nonexistent; 32-bit sources are float32 (use Q instead).
// going higher risks i32 overflow in the WASM IIR-2 prediction loop
// (K*prev near Â±2^31 traps i32.trunc_f32_s).
function scalarForBitDepth(depth: number): number {
    // use 2^(bd-1) - 1 so that round(k/M * M) = k for any integer k in the
    // source range. this makes lossless roundtrip bit-exact for sources
    // normalized by the standard convention (int / (2^(bd-1) - 1)).
    if (depth === 16) return 32767;   // 2^15 - 1
    if (depth === 24) return 8388607; // 2^23 - 1
    return 0; // float32 or unsupported: use Q-derived scalar
}

// depth flag â†’ bit depth value
function depthFromFlags(flags: number): number {
    const d = flags & DEPTH_MASK;
    if (d === DEPTH_16) return 16;
    if (d === DEPTH_24) return 24;
    if (d === DEPTH_32) return 32;
    return 0; // float32
}

// â”€â”€ cross-channel coupling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// the natural extension of the 1D prediction to multichannel audio.
// instead of a separate decorrelation transform (Hadamard, M/S, pairing
// trees), the inter-channel correlation is captured INSIDE the prediction
// itself via a coupling coefficient W:
//
//   pred(ch, t) = K Â· ch[t-1] âˆ’ G Â· ch[t-2] + W Â· ref[t]
//
// W is the cross-channel coupling: how much of a reference channel's
// current sample predicts the current channel's current sample. K and G
// capture the temporal oscillation (same as before). W captures the
// spatial correlation.
//
// for correlated stereo (L â‰ˆ R): W â‰ˆ 1 on the R channel, meaning R is
// almost entirely predicted from L. the residual is the difference signal.
// for uncorrelated channels: W â‰ˆ 0, and the predictor degenerates to the
// normal temporal-only IIR-2. zero cost, zero waste.
//
// this works because the prediction pipeline is lossless on integers:
// the decoded quantized signal exactly equals the encoded quantized signal.
// encoder and decoder have identical reference channels. no drift.
//
// the coupling replaces Hadamard, M/S, and pairing trees with one
// mechanism that works for any channel count and adapts to the actual
// content. it is the 2D Mobius predictor collapsed onto the (channel x time)
// plane: K/G for the time axis, W for the channel axis.
//
// in the nabla^2_g f = r framework: K/G define the metric along the time
// axis (the oscillator curvature), W defines the metric along the channel
// axis (the inter-channel projection). the factorization into orthogonal
// renormalization layers is exact when the axes are independent, and
// near-exact for real audio because temporal and inter-channel correlations
// are approximately separable.
//
// stereo also trials M/S and Givens rotation (optimal KLT angle from the
// covariance matrix). the trial gate picks the cheapest decorrelation per
// file via actual Logos encoding cost. M/S and Givens disable coupling
// when active since they already capture inter-channel structure.
//
// per-channel payload: refIndex:u8 (0xFF = independent) + W:i16.

const NO_REF = 0xFF;
const W_SCALE = COEFF_SCALE; // same quantization as K/G

// find the best reference channel for each channel. returns an array of
// refIndex per channel (NO_REF for the anchor and uncorrelated channels).
// channels are ordered by decreasing total energy â€” the loudest channel
// is the anchor (encoded first, referenced by others).
function assignReferences(
    channels: Int32Array[], numSamples: number, scalar: number = 64,
) : number[] {
    const N = channels.length;
    if (N < 2) return [NO_REF];

    // compute energy per channel
    const energy = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        let e = 0;
        for (let s = 0; s < numSamples; s++) e += channels[i][s] * channels[i][s];
        energy[i] = e;
    }

    // sort channels by energy descending â€” the loudest is the anchor
    const order = Array.from({ length: N }, (_, i) => i);
    order.sort((a, b) => energy[b] - energy[a]);

    const refIndex = new Array<number>(N).fill(NO_REF);
    const assigned = new Set<number>();
    assigned.add(order[0]); // anchor

    // for each channel in index order (so references always have lower indices,
    // ensuring they're processed first in the per-channel encode/decode loop).
    for (let ch = 0; ch < N; ch++) {
        if (ch === order[0]) continue; // anchor: skip
        const eCh = energy[ch];
        if (eCh === 0) continue;

        let bestCorr = 0;
        let bestRef = NO_REF;
        // only consider channels with LOWER index (already processed in loop)
        for (let ref = 0; ref < ch; ref++) {
            const eRef = energy[ref];
            if (eRef === 0) continue;
            let dot = 0;
            for (let s = 0; s < numSamples; s++) dot += channels[ch][s] * channels[ref][s];
            const corr = Math.abs(dot) / Math.sqrt(eCh * eRef);
            if (corr > bestCorr) {
                bestCorr = corr;
                bestRef = ref;
            }
        }

        // adaptive coupling gate: at low scalar (low Q), require stronger
        // correlation to justify the coupling overhead. at high scalar (high Q),
        // even weak correlation saves bits because the residuals are larger.
        // threshold = clamp(0.5 / sqrt(scalar / 100), 0.1, 0.5)
        const corrThresh = Math.max(0.1, Math.min(0.5, 0.5 / Math.sqrt(scalar / 100)));
        if (bestCorr >= corrThresh) refIndex[ch] = bestRef;
    }

    return refIndex;
}

// fit a single coupling coefficient W over the entire channel.
// W = Î£(data Â· ref) / Î£(ref Â· ref) â€” scalar projection of data onto ref.
// one value per channel, not per block. the coupling is a DC-level
// relationship (how much of channel A appears in channel B). the
// per-block K/G prediction handles the time-varying part.
function fitCouplingW(
    data: Int32Array, ref: Int32Array, numSamples: number,
): { Wint: number; W: number } {
    let dot = 0, refSq = 0;
    for (let i = 0; i < numSamples; i++) {
        dot += data[i] * ref[i];
        refSq += ref[i] * ref[i];
    }
    const Wraw = refSq > 0 ? dot / refSq : 0;
    const Wclamped = Math.max(-2, Math.min(2, Wraw));
    const Wint = Math.round(Wclamped * W_SCALE);
    return { Wint, W: Wint / W_SCALE };
}


// â”€â”€ object-based audio spatial metadata â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// each audio object has a 3D position in spherical coordinates:
//   azimuth:   radians, âˆ’Ï€ to Ï€ (0 = front, Ï€/2 = left, âˆ’Ï€/2 = right)
//   elevation: radians, âˆ’Ï€/2 to Ï€/2 (0 = ear level, Ï€/2 = zenith)
//   distance:  normalized, 0 = origin, 1 = unit sphere
//
// the codec transmits raw physics (position + waveform), not a speaker
// layout. the renderer decides how to map objects to physical speakers.
// this makes harmonic layout-agnostic: stereo headphones, 5.1 home
// theater, and immersive dome arrays all decode the same bitstream.

export interface SpatialObject {
    azimuth: number;   // radians
    elevation: number; // radians
    distance: number;  // normalized
}

// standard surround layouts as spatial objects (for convenience).
// users can pass these or define arbitrary positions.
export const SURROUND_LAYOUTS: Record<string, SpatialObject[]> = {
    // ITU-R BS.775 stereo
    stereo: [
        { azimuth:  Math.PI / 6, elevation: 0, distance: 1 },  // L  (+30Â°)
        { azimuth: -Math.PI / 6, elevation: 0, distance: 1 },  // R  (âˆ’30Â°)
    ],
    // ITU-R BS.775-1 5.1
    "5.1": [
        { azimuth:  Math.PI / 6, elevation: 0, distance: 1 },  // L
        { azimuth: -Math.PI / 6, elevation: 0, distance: 1 },  // R
        { azimuth:  0,           elevation: 0, distance: 1 },  // C
        { azimuth:  0,           elevation: 0, distance: 0 },  // LFE (omnidirectional)
        { azimuth:  2 * Math.PI / 3, elevation: 0, distance: 1 }, // Ls (+120Â°)
        { azimuth: -2 * Math.PI / 3, elevation: 0, distance: 1 }, // Rs (âˆ’120Â°)
    ],
    // ITU-R BS.2051 7.1
    "7.1": [
        { azimuth:  Math.PI / 6, elevation: 0, distance: 1 },  // L
        { azimuth: -Math.PI / 6, elevation: 0, distance: 1 },  // R
        { azimuth:  0,           elevation: 0, distance: 1 },  // C
        { azimuth:  0,           elevation: 0, distance: 0 },  // LFE
        { azimuth:  2 * Math.PI / 3, elevation: 0, distance: 1 }, // Ls
        { azimuth: -2 * Math.PI / 3, elevation: 0, distance: 1 }, // Rs
        { azimuth:  5 * Math.PI / 6, elevation: 0, distance: 1 }, // Lrs (+150Â°)
        { azimuth: -5 * Math.PI / 6, elevation: 0, distance: 1 }, // Rrs (âˆ’150Â°)
    ],
    // 7.1.4 immersive (Atmos-style with height layer)
    "7.1.4": [
        { azimuth:  Math.PI / 6, elevation: 0, distance: 1 },  // L
        { azimuth: -Math.PI / 6, elevation: 0, distance: 1 },  // R
        { azimuth:  0,           elevation: 0, distance: 1 },  // C
        { azimuth:  0,           elevation: 0, distance: 0 },  // LFE
        { azimuth:  2 * Math.PI / 3, elevation: 0, distance: 1 }, // Ls
        { azimuth: -2 * Math.PI / 3, elevation: 0, distance: 1 }, // Rs
        { azimuth:  5 * Math.PI / 6, elevation: 0, distance: 1 }, // Lrs
        { azimuth: -5 * Math.PI / 6, elevation: 0, distance: 1 }, // Rrs
        { azimuth:  Math.PI / 4, elevation: Math.PI / 4, distance: 1 }, // TFL
        { azimuth: -Math.PI / 4, elevation: Math.PI / 4, distance: 1 }, // TFR
        { azimuth:  3 * Math.PI / 4, elevation: Math.PI / 4, distance: 1 }, // TRL
        { azimuth: -3 * Math.PI / 4, elevation: Math.PI / 4, distance: 1 }, // TRR
    ],
};

// â”€â”€ sample-rate-adaptive window sizing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// fundamental insight: the sample rate is the UV cutoff of the theory.
// it is the coupling constant between the discrete dynamical system
// (the codec's IIR-2 prediction) and the continuous physical signal.
// in normalized frequency space, Ï‰_digital = Ï‰_physical / fs.
//
// the K/G coefficients are cos/radius of poles in the z-plane. when
// the sample rate changes, the same physical frequency maps to a
// different angle. the codec adapts automatically â€” but the analysis
// windows must maintain consistent TIME duration regardless of rate.
//
// the Nyquist-Shannon theorem says: fs â‰¥ 2Â·fmax. but deeper:
// fs = 2Ï€ / dt, where dt is the temporal resolution of the measurement.
// this is the inverse of the Planck-scale for the signal's universe.
// every sample is a measurement. the sample rate is how often the
// universe of the signal is observed. between observations, the signal
// exists only as a superposition of possible values (bandlimited
// interpolation = the wave function between measurements).
//
// for the codec: changing fs is equivalent to rescaling the time axis
// of the ODE that generates the signal. the prediction physics is
// dimensionless â€” only the analysis window lengths need to track
// physical time.

function adaptiveBurgSuperLen(sampleRate: number, blockLen: number): number {
    // target: ~5.3ms (256 samples at 48kHz). must be multiple of blockLen.
    const target = Math.round(sampleRate * 0.00533);
    const blocks = Math.max(4, Math.round(target / blockLen));
    return blocks * blockLen;
}

export function adaptiveWaveletLevels(sampleRate: number, numSamples: number): number {
    // target: LL subband at ~6kHz. levels = floor(log2(sr / 6000)).
    // clamped by minimum sample count (need 2^(levels+2) samples).
    const maxByRate = Math.max(1, Math.min(6, Math.floor(Math.log2(sampleRate / 6000))));
    let levels = maxByRate;
    while (levels > 0 && numSamples < (1 << (levels + 2))) levels--;
    return levels;
}


// â”€â”€ IIR-2 K/G regression â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Damped oscillator: Î»Â² âˆ’ KÂ·Î» + G = 0,  roots Î» = rÂ·e^{Â±iÏ‰â‚€}
//   K = 2rÂ·cos(Ï‰â‚€)  â€” encodes both frequency and damping
//   G = rÂ²           â€” square of pole radius; G=1 â†” undamped (r=1)
//
// For a pure sinusoid x[n] = cos(nÂ·Ï‰â‚€):
//   KÂ·x[n-1] âˆ’ GÂ·x[n-2] = 2cos(Ï‰â‚€)Â·cos((n-1)Ï‰â‚€) âˆ’ cos((n-2)Ï‰â‚€) = cos(nÂ·Ï‰â‚€)
// â†’ exact cancellation, residual = 0.
//
// LS normal equations for model x[n] â‰ˆ KÂ·x[n-1] âˆ’ GÂ·x[n-2]:
//   [sumP1P1  âˆ’sumW  ] [K]   [sumP1Val]
//   [sumW   âˆ’sumP2P2 ] [G] = [sumP2Val]
// Cramer: K = (sumP1ValÂ·sumP2P2 âˆ’ sumP2ValÂ·sumW) / det
//         G = (KÂ·sumW âˆ’ sumP2Val) / sumP2P2          (note sign: positive for oscillators)
//
// implementation: buildFitAllBlocksBody() in WASM bytecode (f64 accumulators,
// includes transient detection, dead zone, stability clamping, and blend).

// â”€â”€ WASM memory helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ensureWasmMem(wasm: HarmonicWasmExports, minBytes: number): void {
    const cur = wasm.memory.buffer.byteLength;
    if (cur < minBytes) {
        wasm.memory.grow(Math.ceil((minBytes - cur) / 65536));
    }
}

function copyI32ToWasm(wasm: HarmonicWasmExports, offset: number, data: Int32Array): void {
    new Int32Array(wasm.memory.buffer, offset, data.length).set(data);
}

function readI32FromWasm(wasm: HarmonicWasmExports, offset: number, n: number): Int32Array {
    return new Int32Array(wasm.memory.buffer, offset, n).slice();
}

/** WASM-backed K/G regression â€” replaces TypeScript fitAllBlocks.
 *  data must already be at dataOff in WASM memory. writes [Kint, Gint]
 *  pairs to KG_BUF, then converts to the { K, G, Kint, Gint } format. */
function wasmFitAllBlocks(
    wasm: HarmonicWasmExports,
    data: Int32Array,
    numSamples: number,
    gCeil: number = G_CEIL,
): { K: number; G: number; Kint: number; Gint: number }[] {
    const dataOff = WASM_BUF_A;
    const outOff = KG_BUF;
    ensureWasmMem(wasm, outOff + Math.ceil(numSamples / BLOCK_LEN) * 8 + 64);
    copyI32ToWasm(wasm, dataOff, data);

    const gCeilScaled = Math.round(gCeil * COEFF_SCALE);
    const numBlocks = wasm.fit_all_blocks(dataOff, numSamples, outOff, gCeilScaled);

    // read [Kint, Gint] pairs and convert to float K, G
    const raw = new Int32Array(wasm.memory.buffer, outOff, numBlocks * 2);
    const blocks: { K: number; G: number; Kint: number; Gint: number }[] = [];
    for (let b = 0; b < numBlocks; b++) {
        const Kint = raw[b * 2];
        const Gint = raw[b * 2 + 1];
        blocks.push({ K: Kint / COEFF_SCALE, G: Gint / COEFF_SCALE, Kint, Gint });
    }
    return blocks;
}


/** Q-adaptive trajectory thinning: at low Q, the coarsely quantized signal
 *  doesn't benefit from per-32-sample K/G updates. merge groups of N adjacent
 *  blocks to the K/G of the group's first block. this makes the trajectory
 *  delta-stream highly compressible (runs of zeros). the grouping factor
 *  scales inversely with scalar: low Q â†’ large groups â†’ fewer trajectory changes.
 *  at Q=80+ (scalar >= 4096), grouping=1 (no thinning). */
/** free-energy proxy for choosing between integer lattices.
 *  the encoder already knows two things before entropy coding:
 *    1. the varOrder residual rate (plane cost + coefficient entropy)
 *    2. the quantization distortion in the shaped domain
 *
 *  convert distortion into "equivalent bits" via the Gaussian
 *  rate-distortion law:
 *
 *    R(D) = 1/2 Â· log2(ÏƒÂ² / D)
 *
 *  ÏƒÂ² is shared by both candidates, so minimizing
 *
 *    rateBits + n/2 Â· log2(D)
 *
 *  is the same variational choice with no tuned constants.
 */
function quantizerFreeEnergy(
    data: Int32Array,
    distortionEnergy: number,
    blockLen: number,
    maxOrder: number,
): number {
    const n = data.length;
    if (n === 0) return 0;
    const blocks = varOrderFitAllBlocks(data, n, blockLen, maxOrder);
    const residuals = varOrderPredictEnc(data, n, blocks, blockLen, maxOrder);
    const rateBits = estimatePlaneCost(residuals) + estimateCoeffBits(blocks);
    const mse = Math.max(distortionEnergy / n, 1e-12);
    return rateBits + 0.5 * n * Math.log2(mse);
}


interface QuantBeamState {
    cost: number;
    q1: number;
    q2: number;
    e1: number;
    e2: number;
    seq: Int32Array;
}

function quantizeToInt(x: number): number {
    return x >= 0 ? (x + 0.5) | 0 : (x - 0.5) | 0;
}

function clampToWaveformNeighborhood(q: number, raw: number): number {
    const center = quantizeToInt(raw);
    return Math.max(center - 1, Math.min(center + 1, q));
}

/** blockwise beam search on the AR(2) integer lattice.
 *  Harmonic's primary manifold is 2-dimensional: (q[n-1], q[n-2]).
 *  the smallest self-derived nontrivial beam is therefore 2Â² = 4 paths.
 *  each step searches the posterior lattice point and its nearest neighbors.
 */
// preallocated trellis candidate buffers (single-threaded, safe to reuse).
// eliminates per-step object + Int32Array allocation from the inner loop.
const _TB = 4, _TC = 3, _TN = _TB * _TC;
const _tCost = new Float64Array(_TN);
const _tQ1 = new Float64Array(_TN);
const _tQ2 = new Float64Array(_TN);
const _tE1 = new Float64Array(_TN);
const _tE2 = new Float64Array(_TN);
const _tQi = new Int32Array(_TN);
const _tPar = new Int32Array(_TN);
const _tSrt = new Uint8Array(_TN);
function trellisQuantizeBlock(
    rawBlock: Float64Array,
    K: number, G: number, w: number,
    nsK: number, nsG: number, shapeNoise: boolean,
    initQ1: number, initQ2: number, initE1: number, initE2: number,
    backwardPrior?: Float64Array, backwardWeight: number = 0,
): QuantBeamState {
    const blockLen = rawBlock.length;

    // backpointer reconstruction: instead of seq.slice() at every candidate
    // (O(blockLen^2 * beam * cands) copies), store a compact backpointer table
    // and trace the optimal path once at the end. this eliminates the dominant
    // GC pressure from the inner loop.
    const decs = new Int32Array(blockLen * _TB);
    const pars = new Int32Array(blockLen * _TB);

    // double-buffered beam state (flat typed arrays for cache locality)
    const bCost = [new Float64Array(_TB), new Float64Array(_TB)];
    const bQ1 = [new Float64Array(_TB), new Float64Array(_TB)];
    const bQ2 = [new Float64Array(_TB), new Float64Array(_TB)];
    const bE1 = [new Float64Array(_TB), new Float64Array(_TB)];
    const bE2 = [new Float64Array(_TB), new Float64Array(_TB)];
    let cur = 0, bSize = 1;
    bQ1[0][0] = initQ1; bQ2[0][0] = initQ2;
    bE1[0][0] = initE1; bE2[0][0] = initE2;

    const hasBack = backwardPrior !== undefined && backwardWeight > 0;

    for (let t = 0; t < blockLen; t++) {
        let nSize = 0;
        for (let bi = 0; bi < bSize; bi++) {
            const sq1 = bQ1[cur][bi], sq2 = bQ2[cur][bi];
            const se1 = bE1[cur][bi], se2 = bE2[cur][bi];
            const sc = bCost[cur][bi];
            const s = shapeNoise ? rawBlock[t] + nsK * se1 - nsG * se2 : rawBlock[t];
            const pred = K * sq1 - G * sq2;
            const predBack = hasBack ? backwardPrior![t] : 0;
            const target = hasBack
                ? (s + w * pred + backwardWeight * predBack) / (1 + w + backwardWeight)
                : (s + w * pred) / (1 + w);
            const center = clampToWaveformNeighborhood(quantizeToInt(target), s);

            for (let dc = -1; dc <= 1; dc++) {
                const qi = clampToWaveformNeighborhood(center + dc, s);
                const err = s - qi;
                const dp = qi - pred;
                _tCost[nSize] = sc + err * err + w * dp * dp
                    + (hasBack ? backwardWeight * (qi - predBack) * (qi - predBack) : 0);
                _tQ1[nSize] = qi; _tQ2[nSize] = sq1;
                _tE1[nSize] = err; _tE2[nSize] = se1;
                _tQi[nSize] = qi; _tPar[nSize] = bi;
                nSize++;
            }
        }

        // insertion sort by cost (<=12 elements, faster than generic sort)
        for (let i = 0; i < nSize; i++) _tSrt[i] = i;
        for (let i = 1; i < nSize; i++) {
            const key = _tSrt[i];
            const kv = _tCost[key];
            let j = i - 1;
            while (j >= 0 && _tCost[_tSrt[j]] > kv) {
                _tSrt[j + 1] = _tSrt[j]; j--;
            }
            _tSrt[j + 1] = key;
        }

        // keep top beam-width survivors
        const nxt = 1 - cur;
        bSize = Math.min(_TB, nSize);
        const off = t * _TB;
        for (let i = 0; i < bSize; i++) {
            const si = _tSrt[i];
            bCost[nxt][i] = _tCost[si];
            bQ1[nxt][i] = _tQ1[si]; bQ2[nxt][i] = _tQ2[si];
            bE1[nxt][i] = _tE1[si]; bE2[nxt][i] = _tE2[si];
            decs[off + i] = _tQi[si];
            pars[off + i] = _tPar[si];
        }
        cur = nxt;
    }

    // reconstruct optimal path via backpointers
    const seq = new Int32Array(blockLen);
    let idx = 0;
    for (let t = blockLen - 1; t >= 0; t--) {
        seq[t] = decs[t * _TB + idx];
        idx = pars[t * _TB + idx];
    }

    return {
        cost: bCost[cur][0], q1: bQ1[cur][0], q2: bQ2[cur][0],
        e1: bE1[cur][0], e2: bE2[cur][0], seq,
    };
}

/** quantize onto the integer lattice with a local AR(2) orbital prior.
 *  pass 1 does the plain cochlear-shaped quantization. fit K/G on that coarse
 *  lattice, then run a second pass that solves the same cell problem the
 *  decoder sees:
 *
 *    choose q near s, but pull toward qÌ‚ = KÂ·q[n-1] - GÂ·q[n-2]
 *
 *  the trust in the orbital prior is fully derived from physics:
 *    uniform quantization cell variance = 1/12
 *    block innovation variance = mean((x - qÌ‚)Â²)
 *
 *  so the blend weight is (1/12) / innovationVariance. tonal blocks with a
 *  clean orbital manifold get nudged onto that manifold. noisy blocks collapse
 *  back to ordinary quantization.
 */
function quantizeScaledWithOrbitalGuide(
    wasm: HarmonicWasmExports,
    rawScaled: Float32Array,
    numLevels: number,
    scalar: number,
    shapeNoise: boolean,
    nsK: number,
    nsG: number,
    varBlockLen: number,
    varMaxOrder: number,
    lossless: boolean = false,
): { data: Int32Array; energy: number } {
    const numSamples = rawScaled.length;
    const coarse = new Int32Array(numSamples);
    let e1 = 0, e2 = 0;
    for (let i = 0; i < numSamples; i++) {
        const raw = rawScaled[i];
        const s = shapeNoise ? raw + nsK * e1 - nsG * e2 : raw;
        const qi = s >= 0 ? (s + 0.5) | 0 : (s - 0.5) | 0;
        if (shapeNoise) { e2 = e1; e1 = s - qi; }
        coarse[i] = qi;
    }

    // lossless: skip orbital/trellis quantization. the trellis biases values
    // toward the AR(2) trajectory which improves lossy quality but can shift
    // a quantized value by ±1 LSB, breaking bit-exact lossless roundtrip.
    if (lossless) {
        let energy = 0;
        for (let i = 0; i < numSamples; i++) energy += coarse[i] * coarse[i];
        return { data: coarse, energy };
    }

    if (numSamples < BLOCK_LEN) {
        let energy = 0;
        for (let i = 0; i < numSamples; i++) energy += coarse[i] * coarse[i];
        return { data: coarse, energy };
    }

    const guide = wasmFitAllBlocks(wasm, coarse, numSamples);
    if (guide.length === 0) {
        let energy = 0;
        for (let i = 0; i < numSamples; i++) energy += coarse[i] * coarse[i];
        return { data: coarse, energy };
    }

    const weights = new Float64Array(guide.length);
    const backwardWeights = new Float64Array(guide.length);
    const backwardPred = new Float64Array(numSamples);
    let p1 = 0, p2 = 0;
    for (let b = 0; b < guide.length; b++) {
        const { K, G } = guide[b];
        const start = b * BLOCK_LEN;
        const end = Math.min(start + BLOCK_LEN, numSamples);
        let obsEnergy = 0;
        for (let i = start; i < end; i++) {
            const pred = K * p1 - G * p2;
            const x = coarse[i];
            const err = x - pred;
            obsEnergy += err * err;
            p2 = p1;
            p1 = x;
        }
        const blockLen = end - start;
        weights[b] = obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / blockLen) : 1024;
    }
    let n1 = 0, n2 = 0;
    for (let b = guide.length - 1; b >= 0; b--) {
        const { K, G } = guide[b];
        const start = b * BLOCK_LEN;
        const end = Math.min(start + BLOCK_LEN, numSamples);
        if (G <= G_FLOOR) {
            backwardWeights[b] = 0;
            for (let i = end - 1; i >= start; i--) {
                backwardPred[i] = coarse[i];
                n2 = n1;
                n1 = coarse[i];
            }
            continue;
        }
        let obsEnergy = 0;
        let count = 0;
        for (let i = end - 1; i >= start; i--) {
            const pred = (K * n1 - n2) / G;
            backwardPred[i] = pred;
            const err = coarse[i] - pred;
            obsEnergy += err * err;
            count++;
            n2 = n1;
            n1 = coarse[i];
        }
        backwardWeights[b] = count > 0
            ? (obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / count) : 1024)
            : 0;
    }

    const orbital = new Int32Array(numSamples);
    let orbitalDistEnergy = 0;
    e1 = 0; e2 = 0;
    p1 = 0; p2 = 0;
    for (let b = 0; b < guide.length; b++) {
        const { K, G } = guide[b];
        const w = weights[b];
        const wb = backwardWeights[b];
        const start = b * BLOCK_LEN;
        const end = Math.min(start + BLOCK_LEN, numSamples);
        if (w >= 1) {
            const rawBlock = new Float64Array(end - start);
            for (let i = start; i < end; i++) rawBlock[i - start] = rawScaled[i];
            const backBlock = wb > 0 ? Float64Array.from(backwardPred.subarray(start, end)) : undefined;
            const best = trellisQuantizeBlock(rawBlock, K, G, w, nsK, nsG, shapeNoise, p1, p2, e1, e2, backBlock, wb);
            orbital.set(best.seq, start);
            orbitalDistEnergy += best.cost;
            p1 = best.q1;
            p2 = best.q2;
            e1 = best.e1;
            e2 = best.e2;
        } else {
            for (let i = start; i < end; i++) {
                const raw = rawScaled[i];
                const s = shapeNoise ? raw + nsK * e1 - nsG * e2 : raw;
                const pred = K * p1 - G * p2;
                const predBack = backwardPred[i];
                const target = wb > 0
                    ? (s + w * pred + wb * predBack) / (1 + w + wb)
                    : (s + w * pred) / (1 + w);
                const qi = clampToWaveformNeighborhood(quantizeToInt(target), s);
                const err = s - qi;
                if (shapeNoise) { e2 = e1; e1 = err; }
                orbital[i] = qi;
                orbitalDistEnergy += err * err
                    + w * (qi - pred) * (qi - pred)
                    + (wb > 0 ? wb * (qi - predBack) * (qi - predBack) : 0);
                p2 = p1;
                p1 = qi;
            }
        }
    }

    // beam cost includes the orbital prior term. recover the actual shaped-domain
    // distortion energy for the later free-energy comparison.
    orbitalDistEnergy = 0;
    e1 = 0; e2 = 0;
    for (let i = 0; i < numSamples; i++) {
        const raw = rawScaled[i];
        const s = shapeNoise ? raw + nsK * e1 - nsG * e2 : raw;
        const err = s - orbital[i];
        orbitalDistEnergy += err * err;
        if (shapeNoise) { e2 = e1; e1 = err; }
    }
    const n = numSamples;
    if (numLevels <= 0 || n < 3) {
        let energy = 0;
        for (let i = 0; i < n; i++) energy += orbital[i] * orbital[i];
        return { data: orbital, energy };
    }

    const scales: number[] = [];
    const maxPow = Math.min(numLevels + 2, 6);
    for (let p = 0; p <= maxPow; p++) {
        const h = 1 << p;
        if ((h << 1) >= n) break;
        scales.push(h);
    }
    if (scales.length === 0) {
        let energy = 0;
        for (let i = 0; i < n; i++) energy += orbital[i] * orbital[i];
        return { data: orbital, energy };
    }

    const fractalSum = new Float32Array(n);
    const fractalWeight = new Float32Array(n);
    const orbitalTrust = new Float32Array(n);
    for (let b = 0; b < guide.length; b++) {
        const trust = weights[b] / (1 + weights[b]);
        const start = b * BLOCK_LEN;
        const end = Math.min(start + BLOCK_LEN, n);
        for (let i = start; i < end; i++) orbitalTrust[i] = trust;
    }
    for (let p = scales.length - 2; p >= 0; p--) scales.push(scales[p]);
    for (const h of scales) {
        let obsEnergy = 0;
        let count = 0;
        for (let i = h; i + h < n; i++) {
            const mid = 0.5 * (orbital[i - h] + orbital[i + h]);
            const d = orbital[i] - mid;
            obsEnergy += d * d;
            count++;
        }
        if (count === 0) continue;
        const obsVar = obsEnergy / count;
        const wBase = obsVar > 0 ? Math.min(1, DYADIC_NOISE_FLOOR / obsVar) : 1;
        if (!(wBase > 0)) continue;
        let any = false;
        for (let i = h; i + h < n; i++) {
            const w = wBase * Math.min(orbitalTrust[i - h], orbitalTrust[i], orbitalTrust[i + h]);
            if (!(w > 0)) continue;
            any = true;
            const mid = 0.5 * (orbital[i - h] + orbital[i + h]);
            fractalSum[i] += w * mid;
            fractalWeight[i] += w;
        }
        if (!any) continue;
    }

    const q = new Int32Array(n);
    let energy = 0;
    let fractalDistEnergy = 0;
    e1 = 0; e2 = 0;
    p1 = 0; p2 = 0;
    for (let b = 0; b < guide.length; b++) {
        const { K, G } = guide[b];
        const w = weights[b];
        const start = b * BLOCK_LEN;
        const end = Math.min(start + BLOCK_LEN, n);
        for (let i = start; i < end; i++) {
            const raw = rawScaled[i];
            const s = shapeNoise ? raw + nsK * e1 - nsG * e2 : raw;
            const pred = K * p1 - G * p2;
            const wf = fractalWeight[i];
            const target = wf > 0
                ? (s + w * pred + fractalSum[i]) / (1 + w + wf)
                : (s + w * pred) / (1 + w);
            const qi = clampToWaveformNeighborhood(quantizeToInt(target), s);
            const err = s - qi;
            if (shapeNoise) { e2 = e1; e1 = s - qi; }
            q[i] = qi;
            energy += qi * qi;
            fractalDistEnergy += err * err;
            p2 = p1;
            p1 = qi;
        }
    }

    const orbitalScore = quantizerFreeEnergy(orbital, orbitalDistEnergy, varBlockLen, varMaxOrder);
    const fractalScore = quantizerFreeEnergy(q, fractalDistEnergy, varBlockLen, varMaxOrder);
    if (fractalScore < orbitalScore) return { data: q, energy };

    let orbitalEnergy = 0;
    for (let i = 0; i < n; i++) orbitalEnergy += orbital[i] * orbital[i];
    return { data: orbital, energy: orbitalEnergy };
}

function quantizeChannelWithOrbitalGuide(
    wasm: HarmonicWasmExports,
    samples: Float32Array, ch: number, numChannels: number, numSamples: number,
    invPeak: number,
    shapeNoise: boolean, nsK: number, nsG: number,
    numLevels: number, scalar: number,
    varBlockLen: number, varMaxOrder: number,
    lossless: boolean = false,
): { data: Int32Array; energy: number } {
    const rawScaled = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) rawScaled[i] = samples[i * numChannels + ch] * invPeak;
    return quantizeScaledWithOrbitalGuide(wasm, rawScaled, numLevels, scalar, shapeNoise, nsK, nsG, varBlockLen, varMaxOrder, lossless);
}

function buildAmplitudeActionTrajectory(
    rawScaled: Float32Array,
    guide: { K: number; G: number }[],
    numSamples: number,
    envBlockLen: number,
    scalar: number,
): Int16Array | null {
    if (numSamples < envBlockLen * 2 || guide.length === 0) return null;
    const numEnvBlocks = Math.ceil(numSamples / envBlockLen);
    const logEnv = new Int16Array(numEnvBlocks);
    let varied = false;
    for (let eb = 0; eb < numEnvBlocks; eb++) {
        const start = eb * envBlockLen;
        const end = Math.min(start + envBlockLen, numSamples);
        let amp2 = 0;
        let count = 0;
        for (let i = start; i < end; i++) {
            const { K, G } = guide[Math.min(guide.length - 1, (i / BLOCK_LEN) | 0)];
            const x = rawScaled[i];
            const p = i > 0 ? rawScaled[i - 1] : 0;
            const phase = G > G_FLOOR ? 1 - (K * K) / (4 * G) : 0;
            if (phase > QUANT_NOISE_REG) {
                const action = x * x + G * p * p - K * x * p;
                amp2 += Math.max(0, action) / phase;
            } else {
                amp2 += x * x;
            }
            count++;
        }
        const ampScaled = Math.max(1, Math.sqrt(amp2 / Math.max(count, 1)));
        const q = Math.max(-0x8000, Math.min(0x7FFF, Math.round(Math.log2(ampScaled / scalar) * COEFF_SCALE)));
        logEnv[eb] = q;
        if (eb > 0 && q !== logEnv[eb - 1]) varied = true;
    }
    return varied ? logEnv : null;
}

function envelopeResidualBits(
    rawEnvLog: Int16Array,
    envLog: Int16Array | null,
): number {
    const n = rawEnvLog.length;
    if (n === 0) return 0;
    const floorVar = QUANT_NOISE_REG;
    let err = 0;
    if (envLog) {
        for (let i = 0; i < n; i++) {
            const d = rawEnvLog[i] - envLog[i];
            err += d * d;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const d = rawEnvLog[i];
            err += d * d;
        }
    }
    return 0.5 * n * Math.log2(Math.max(err / (n * floorVar), 1e-12));
}

interface AmplitudeCandidate {
    data: Int32Array;
    energy: number;
    envBlockLen: number;
    envLog: Int16Array;
    envCurve: Float32Array;
    envWire: Uint8Array;
    extraBits: number;
    fitBits: number;
}

function reconstructEnvelopeCurve(
    logEnv: Int16Array,
    numSamples: number,
    envBlockLen: number,
    framePeak: number,
): Float32Array {
    const env = new Float32Array(numSamples);
    if (logEnv.length === 0) {
        env.fill(framePeak);
        return env;
    }
    const last = logEnv.length - 1;
    for (let i = 0; i < numSamples; i++) {
        const pos = i / envBlockLen - 0.5;
        const left = Math.max(0, Math.min(last, Math.floor(pos)));
        const right = Math.max(0, Math.min(last, left + 1));
        const t = left === right ? 0 : Math.max(0, Math.min(1, pos - left));
        const logQ = (1 - t) * logEnv[left] + t * logEnv[right];
        env[i] = framePeak * Math.pow(2, logQ / COEFF_SCALE);
    }
    return env;
}

function quantizeChannelWithAmplitudeAxis(
    wasm: HarmonicWasmExports,
    samples: Float32Array,
    ch: number,
    numChannels: number,
    numSamples: number,
    framePeak: number,
    scalar: number,
    envBlockLen: number,
    baseline: Int32Array,
    shapeNoise: boolean,
    nsK: number,
    nsG: number,
    numLevels: number,
    varBlockLen: number,
    varMaxOrder: number,
): {
    candidates: AmplitudeCandidate[];
    baselineFitBits: number;
} {
    const guide = wasmFitAllBlocks(wasm, baseline, numSamples);
    const sourceScaled = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) sourceScaled[i] = samples[i * numChannels + ch] * (scalar / framePeak);
    const candidates: AmplitudeCandidate[] = [];
    let baselineFitBits = Number.POSITIVE_INFINITY;
    const carrierLimit = predictorCarrierLimit();
    for (const blockLen of envelopeBlockLenCandidates(envBlockLen, numSamples, varBlockLen)) {
        const rawEnvLog = buildAmplitudeActionTrajectory(sourceScaled, guide, numSamples, blockLen, scalar);
        if (!rawEnvLog) continue;
        baselineFitBits = Math.min(baselineFitBits, envelopeResidualBits(rawEnvLog, null));
        const envLogs = buildFractalEnvelopeLogCandidates(wasm, rawEnvLog, scalar);
        let meanLog = 0;
        for (let i = 0; i < rawEnvLog.length; i++) meanLog += rawEnvLog[i];
        meanLog /= rawEnvLog.length;
        for (const envLog of envLogs) {
            let residualEnergy = 0;
            let modelEnergy = 0;
            for (let i = 0; i < rawEnvLog.length; i++) {
                const model = envLog[i] - meanLog;
                const residual = rawEnvLog[i] - envLog[i];
                modelEnergy += model * model;
                residualEnergy += residual * residual;
            }
            if (!(modelEnergy > residualEnergy)) continue;
            const envCurve = reconstructEnvelopeCurve(envLog, numSamples, blockLen, framePeak);
            const carrierScaled = new Float32Array(numSamples);
            let valid = true;
            for (let i = 0; i < numSamples; i++) {
                const x = samples[i * numChannels + ch] * (scalar / envCurve[i]);
                if (!Number.isFinite(x) || Math.abs(x) > carrierLimit) {
                    valid = false;
                    break;
                }
                carrierScaled[i] = x;
            }
            if (!valid) continue;
            const quantized = quantizeScaledWithOrbitalGuide(wasm, carrierScaled, numLevels, scalar, shapeNoise, nsK, nsG, varBlockLen, varMaxOrder);
            const envWire = encodeEnvelopeTrajectory(wasm, envLog);
            const extraBits = envWire.length * 8 + 96 + 1;
            const fitBits = envelopeResidualBits(rawEnvLog, envLog);
            candidates.push({ ...quantized, envBlockLen: blockLen, envLog, envCurve, envWire, extraBits, fitBits });
        }
    }
    return { candidates, baselineFitBits: Number.isFinite(baselineFitBits) ? baselineFitBits : 0 };
}


/** estimate encoding cost for a set of subbands (bits). */
function scoreSubbandCost(subbands: Int32Array[]): number {
    let bits = 8; // numSubbands
    const numSb = subbands.length;
    let globalMaxPlane = 0;
    const sbPlaneCount: number[] = [];
    for (let sb = 0; sb < numSb; sb++) {
        const isLL = sb === 0;
        let energy = 0;
        const d = subbands[sb];
        for (let i = 0; i < d.length; i++) energy += d[i] * d[i];
        const noiseFloor = d.length * QUANT_NOISE_REG;
        if (!isLL && energy <= noiseFloor) {
            sbPlaneCount.push(0);
        } else {
            let maxZZ = 0;
            for (let i = 0; i < d.length; i++) {
                const v = d[i];
                const zz = ((v >> 31) ^ (v << 1)) >>> 0;
                if (zz > maxZZ) maxZZ = zz;
            }
            const pc = planeCount(maxZZ);
            sbPlaneCount.push(pc);
            if (pc > globalMaxPlane) globalMaxPlane = pc;
        }
        bits += 40; // sbLen + planeCount
    }
    bits += 8; // globalMaxPlane
    for (let plane = 0; plane < globalMaxPlane; plane++) {
        let totalBytes = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] > plane) totalBytes += subbands[sb].length;
        }
        const concat = new Uint8Array(totalBytes);
        let off = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] <= plane) continue;
            const d = subbands[sb];
            const shift = plane * 8;
            for (let i = 0; i < d.length; i++) {
                const v = d[i];
                const zz = ((v >> 31) ^ (v << 1)) >>> 0;
                concat[off++] = (zz >>> shift) & 0xFF;
            }
        }
        const encoded = encode0D(concat.subarray(0, off));
        bits += 32 + encoded.length * 8;
    }
    return bits;
}


/** compute the HH subband coefficient threshold for a given scalar.
 *  returns 0: audio residuals after Burg prediction carry only signal,
 *  not noise. unlike image wavelets where deep HH subbands are dominated
 *  by sensor noise (the MERA disentangler regime), audio prediction residuals
 *  have uniform signal content across all wavelet subbands. zeroing even
 *  ±1 HH coefficients destroys ~20-40% of the dynamic range at high Q,
 *  causing catastrophic SNR loss (verified: thresh=2 gives -24dB at Q80).
 *  the wavelet level trial in scoreSubbandPath already optimizes the
 *  decomposition depth, and Logos compresses near-zero runs efficiently,
 *  so explicit thresholding adds no benefit to well-predicted audio. */
function subbandThreshold(_scalar: number, bitDepth: number): number {
    if (bitDepth > 0) return 0;
    return 0;
}

/** apply LL-guided HH subband thresholding in-place.
 *  the MERA insight: wavelet subbands have cross-scale magnitude correlation.
 *  if the LL (coarse-grained) coefficient is small at position i, the
 *  corresponding HH (detail) coefficient is likely noise. energy conservation
 *  in the lifting scheme means quiet regions can't produce large detail.
 *
 *  subbands are [LL, HH_deepest, ..., HH_shallowest]. HH at level k has
 *  2^(k-1)× resolution relative to LL, so HH[i]'s parent is LL[i >> (k-1)].
 *  where the parent is quiet (below the noise floor), the threshold widens
 *  by 2×, zeroing more coefficients in silent regions.
 *
 *  thresh=0 is a no-op (lossless). thresh=1 is also a no-op for integers. */
function thresholdHHSubbands(subbands: Int32Array[], thresh: number): void {
    if (thresh <= 1 || subbands.length <= 1) return;
    const ll = subbands[0];
    const numLevels = subbands.length - 1;

    // compute LL noise floor: median absolute value gives a robust energy estimate.
    // positions below floor get widened threshold (parent says "quiet here").
    let llSum = 0;
    for (let i = 0; i < ll.length; i++) {
        const v = ll[i];
        llSum += v >= 0 ? v : -v;
    }
    const llFloor = ll.length > 0 ? llSum / ll.length : 0;

    for (let sb = 1; sb <= numLevels; sb++) {
        const d = subbands[sb];
        // sb=1 is deepest HH (same resolution as LL), sb=numLevels is shallowest.
        // decimation ratio from HH to LL: deepest has 1:1, each shallower level 2×.
        const shift = sb - 1;
        for (let i = 0; i < d.length; i++) {
            const v = d[i];
            // map HH position to LL parent
            const parentIdx = Math.min(i >> shift, ll.length - 1);
            const parentAbs = ll[parentIdx] >= 0 ? ll[parentIdx] : -ll[parentIdx];
            // where parent is quiet, widen the dead zone
            const localThresh = parentAbs <= llFloor ? thresh * 2 : thresh;
            if (v > -localThresh && v < localThresh) d[i] = 0;
        }
    }
}

/** choose wavelet decomposition or bypass (direct single subband).
 *  compares concatenated entropy estimates with HH thresholding applied,
 *  so the trial reflects what the encoder actually writes. */
function scoreSubbandPath(
    wasm: HarmonicWasmExports, residuals: Int32Array,
    numLevels: number, hhThresh: number = 0,
): Int32Array[] {
    if (numLevels === 0) return [residuals];

    // trial all level counts from 0 (bypass) to numLevels.
    // intermediate levels can be cheaper: e.g. for well-predicted residuals
    // where only 1-2 levels of decorrelation help, the extra subbands from
    // deeper decomposition add overhead without benefit.
    let bestCost = estimatePlaneCost(residuals); // bypass baseline
    let bestSb: Int32Array[] = [residuals];

    for (let lev = 1; lev <= numLevels; lev++) {
        const sb = waveletDecompose(wasm, residuals, lev);
        thresholdHHSubbands(sb, hhThresh);
        const total = sb.reduce((s, d) => s + d.length, 0);
        const concat = new Int32Array(total);
        let off = 0;
        for (const d of sb) { concat.set(d, off); off += d.length; }
        const cost = estimatePlaneCost(concat);
        if (cost < bestCost) {
            bestCost = cost;
            bestSb = sb;
        }
    }

    return bestSb;
}

/** Logos-accurate wavelet level selection. uses trialLogosSize (actual Logos
 *  encoding) for all candidates instead of Shannon entropy, matching the
 *  per-plane subband filtering structure the encoder actually writes.
 *
 *  verified improvements over Shannon estimator:
 *    lossless 24-bit: 3340→2480B (-25.7%)
 *    harmonic Q95: 1452→1232B (-15.2%)
 *    chirp Q95: 30652→30552B (-0.3%)
 *
 *  the Shannon estimator miscalibrates for high-precision signals because it
 *  ignores per-plane subband filtering (different subbands contribute to
 *  different planes). a 2-phase approach (Shannon shortlist + Logos confirm)
 *  was tried but the Shannon ranking can differ from the Logos ranking, so
 *  the top-2 shortlist missed the optimal level. full scan costs numLevels+1
 *  Logos calls (~5% encode time) but ensures the globally best level.
 *
 *  used only in the final encoding path (not inside trial gates). */
function scoreSubbandPathAccurate(
    wasm: HarmonicWasmExports, residuals: Int32Array,
    numLevels: number, hhThresh: number = 0,
): Int32Array[] {
    if (numLevels === 0) return [residuals];

    // fast path: if the Shannon estimator picks bypass, trust it without
    // running the expensive Logos-accurate scan. on real audio at all Q
    // levels, bypass wins 100% of the time (verified 2026-04-09 on 8 clips
    // x 3 Q levels). the full scan only matters for synthetic signals with
    // extreme spectral structure (lossless 24-bit narrowband).
    const shannonSb = scoreSubbandPath(wasm, residuals, numLevels, hhThresh);
    if (shannonSb.length === 1) {
        // Shannon picked bypass (single subband = no wavelet). skip Logos scan.
        return shannonSb;
    }

    // Shannon picked a wavelet level. run Logos-accurate scan to confirm.
    let bestCost = trialLogosSize([residuals]); // bypass baseline
    let bestSb: Int32Array[] = [residuals];

    for (let lev = 1; lev <= numLevels; lev++) {
        const sb = waveletDecompose(wasm, residuals, lev);
        thresholdHHSubbands(sb, hhThresh);
        const cost = trialLogosSize(sb);
        if (cost < bestCost) {
            bestCost = cost;
            bestSb = sb;
        }
    }

    return bestSb;
}

/** encode subbands through the actual plane+Logos pipeline and return total bytes.
 *  used by trial gates (lag filter, bypass) for accurate cost comparison. */
function trialLogosSize(subbands: Int32Array[]): number {
    const numSb = subbands.length;
    let globalMaxPlane = 0;
    const sbPlaneCount: number[] = [];
    for (let sb = 0; sb < numSb; sb++) {
        let maxZZ = 0;
        const d = subbands[sb];
        for (let i = 0; i < d.length; i++) {
            const v = d[i];
            const zz = ((v >> 31) ^ (v << 1)) >>> 0;
            if (zz > maxZZ) maxZZ = zz;
        }
        const pc = planeCount(maxZZ);
        sbPlaneCount.push(pc);
        if (pc > globalMaxPlane) globalMaxPlane = pc;
    }
    let total = 1 + 5 * numSb + 1; // numSb + sb headers + globalMaxPlane
    for (let plane = 0; plane < globalMaxPlane; plane++) {
        let totalBytes = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] > plane) totalBytes += subbands[sb].length;
        }
        const concat = new Uint8Array(totalBytes);
        let off = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] <= plane) continue;
            const d = subbands[sb];
            const shift = plane * 8;
            for (let i = 0; i < d.length; i++) {
                const v = d[i];
                const zz = ((v >> 31) ^ (v << 1)) >>> 0;
                concat[off++] = (zz >>> shift) & 0xFF;
            }
        }
        const encoded = encode0D(concat.subarray(0, off), 4);
        total += 4 + encoded.length;
    }
    return total;
}

/** unified scorer: coupling → variable-order Burg → wavelet → Logos.
 *  no trial gates, no stacking. one prediction stage, one residual path. */
function scoreQuantizedChannel(
    wasm: HarmonicWasmExports,
    data: Int32Array,
    samples: Float32Array,
    ch: number,
    numChannels: number,
    scalar: number,
    framePeak: number,
    targetScalar: number,
    envCurve: Float32Array | null,
    numLevels: number,
    refData?: Int32Array,
    refProjected?: Float32Array,
    extraBits: number = 0,
    blockLen: number = BLOCK_LEN,
    maxOrder: number = 10,
    hhThresh: number = 0,
) : { rateBits: number; objective: number; projectedCarrier: Float32Array } {
    const n = data.length;
    if (n === 0) {
        return { rateBits: extraBits, objective: extraBits, projectedCarrier: new Float32Array(0) };
    }

    let rateBits = extraBits;
    let working = data;
    let couplingW: number | undefined;

    // cross-channel coupling trial
    if (refData && n >= BLOCK_LEN) {
        const wFit = fitCouplingW(working, refData, n);
        if (Math.abs(wFit.W) > 0.01) {
            const decoupled = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                const wr = wFit.W * refData[i];
                decoupled[i] = working[i] - (wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0);
            }
            // quick cost comparison
            const blocksOrig = varOrderFitAllBlocks(working, n, blockLen, maxOrder);
            const residOrig = varOrderPredictEnc(working, n, blocksOrig, blockLen, maxOrder);
            const blocksDec = varOrderFitAllBlocks(decoupled, n, blockLen, maxOrder);
            const residDec = varOrderPredictEnc(decoupled, n, blocksDec, blockLen, maxOrder);
            const costOrig = estimatePlaneCost(residOrig) + estimateCoeffBits(blocksOrig) / 8;
            const costDec = estimatePlaneCost(residDec) + estimateCoeffBits(blocksDec) / 8;
            if (costDec + 2 < costOrig) {
                working = decoupled;
                couplingW = wFit.W;
                rateBits += 24; // W encoding
            }
        }
    }

    // unified variable-order prediction
    const varBlocks = varOrderFitAllBlocks(working, n, blockLen, maxOrder);
    const residuals = varOrderPredictEnc(working, n, varBlocks, blockLen, maxOrder);

    // coefficient stream cost
    const { compressed: coeffComp } = encodeCoeffStream(varBlocks);
    rateBits += 64 + coeffComp.length * 8; // origLen + compLen + data

    // wavelet vs bypass trial: compare cost of wavelet decomposition vs direct encoding.
    // for well-predicted (nearly white) residuals, wavelet adds subband overhead
    // without decorrelation benefit. trial both and pick the cheaper path.
    const subbands = scoreSubbandPath(wasm, residuals, numLevels, hhThresh);
    rateBits += scoreSubbandCost(subbands);

    // reconstruction for distortion measurement
    const scoredResiduals = waveletReconstruct(wasm, subbands);
    const reconstructed = varOrderPredictDec(scoredResiduals, n, varBlocks, blockLen, maxOrder);

    if (couplingW !== undefined && refData) {
        for (let i = 0; i < n; i++) {
            const wr = couplingW * refData[i];
            reconstructed[i] += wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0;
        }
    }

    // projection: refine decoded integers within quantization cells
    const projectedCarrier = Float32Array.from(reconstructed);
    sanitizeProjectionToCell(projectedCarrier, reconstructed);
    varOrderCellProject(projectedCarrier, reconstructed, varBlocks, blockLen, maxOrder);
    sanitizeProjectionToCell(projectedCarrier, reconstructed);
    if (couplingW !== undefined && refData && refProjected) {
        couplingCellProject(projectedCarrier, reconstructed, refProjected, refData, couplingW);
        sanitizeProjectionToCell(projectedCarrier, reconstructed);
    }

    // distortion
    let mse = 0, signal = 0;
    if (envCurve) {
        for (let i = 0; i < n; i++) {
            const ref = samples[i * numChannels + ch];
            const diff = ref - projectedCarrier[i] * (envCurve[i] / scalar);
            signal += ref * ref;
            mse += diff * diff;
        }
    } else {
        const scale = framePeak / scalar;
        for (let i = 0; i < n; i++) {
            const ref = samples[i * numChannels + ch];
            const diff = ref - projectedCarrier[i] * scale;
            signal += ref * ref;
            mse += diff * diff;
        }
    }

    return {
        rateBits,
        objective: rateBits + 0.5 * n * Math.log2(Math.max(mse / n, 1e-12)),
        projectedCarrier,
    };
}

function sanitizeProjectionToCell(projected: Float32Array, data: Int32Array): void {
    for (let i = 0; i < projected.length; i++) {
        const q = data[i];
        const lo = q - 0.5;
        const hi = q + 0.5;
        const x = projected[i];
        projected[i] = Number.isFinite(x) ? (x < lo ? lo : x > hi ? hi : x) : q;
    }
}

// â”€â”€ CDF 5/3 wavelet â€” TypeScript orchestration (calls WASM kernels) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Multi-level CDF 5/3 decomposition. Returns [LL_deepest, HH_deepest, ..., HH_1].
 *  runs all levels in WASM memory with a single copy-in, avoiding the per-level
 *  JSâ†”WASM round-trip of the naive approach. HH subbands are copied out after
 *  each level (they're final); LL stays in WASM for the next level. */
export function waveletDecompose(wasm: HarmonicWasmExports, data: Int32Array, levels: number): Int32Array[] {
    const n = data.length;
    if (n < 4 || levels === 0) return [data.slice()];

    const srcOff = WASM_BUF_A;
    const dstOff = srcOff + n * 4;
    ensureWasmMem(wasm, dstOff + n * 4 + 64);
    copyI32ToWasm(wasm, srcOff, data);

    const hhArrays: Int32Array[] = [];
    let curOff = srcOff;
    let curLen = n;

    for (let l = 0; l < levels; l++) {
        if (curLen < 4) break;
        wasm.wavelet_fwd(curOff, curLen, dstOff);
        const nlp = (curLen + 1) >> 1;
        const nhp = curLen - nlp;

        // HH is final â€” copy out now before dstOff is reused next level
        hhArrays.push(readI32FromWasm(wasm, dstOff + nlp * 4, nhp));

        // move LL from dstOff to srcOff for next level (safe: dstOff > srcOff)
        new Int32Array(wasm.memory.buffer, srcOff, nlp).set(
            new Int32Array(wasm.memory.buffer, dstOff, nlp));
        curOff = srcOff;
        curLen = nlp;
    }

    // assemble: [LL, HH_deepest, ..., HH_1]
    const subbands: Int32Array[] = [readI32FromWasm(wasm, curOff, curLen)];
    for (let i = hhArrays.length - 1; i >= 0; i--) subbands.push(hhArrays[i]);
    return subbands;
}

/** Multi-level CDF 5/3 reconstruction. Input order: [LL, HH_deepest, ..., HH_1].
 *  runs all levels in WASM memory with minimal JSâ†”WASM copies. */
function waveletReconstruct(wasm: HarmonicWasmExports, subbands: Int32Array[]): Int32Array {
    if (subbands.length <= 1) return subbands[0].slice();

    const llOff = WASM_BUF_A;
    copyI32ToWasm(wasm, llOff, subbands[0]);
    let nlp = subbands[0].length;

    for (let l = 1; l < subbands.length; l++) {
        const hh = subbands[l];
        const nhp = hh.length, n = nlp + nhp;
        const hhOff = llOff + nlp * 4;
        const dstOff = hhOff + nhp * 4;
        ensureWasmMem(wasm, dstOff + n * 4 + 64);

        copyI32ToWasm(wasm, hhOff, hh);
        wasm.wavelet_inv(llOff, nlp, hhOff, nhp, dstOff);

        // move result to llOff for next level (dstOff > llOff, safe forward copy)
        new Int32Array(wasm.memory.buffer, llOff, n).set(
            new Int32Array(wasm.memory.buffer, dstOff, n));
        nlp = n;
    }

    return readI32FromWasm(wasm, llOff, nlp);
}


// â”€â”€ zigzag / byte-plane split â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function zigzagDec(z: number): number { return (z >>> 1) ^ -(z & 1); }
function planeCount(maxZZ: number): number { return maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3; }

// ── Burg analysis primitives ──────────────────────────────────────────

// reflection coefficient quantization: uniform 10-bit signed (±511).
// reflection coefficient quantization lives on the natural metric of the
// stable AR(p) region: K ∈ (-1, 1) is the 1D Klein/Poincaré model of
// hyperbolic space, and the right chart is log-area-ratio (LAR), the
// hyperbolic-isometric map atanh: (-1, 1) → ℝ.
//
// linear Q14 (the previous scheme) wastes resolution on |K| < 0.5 (where
// dK/dλ ≈ 1, the manifold is nearly flat) and starves resolution near
// |K| → 1 (where dK/dλ → 0, the manifold is curved and formant poles
// physically live). LAR with scale=64 covers the full stable region
// |K| ≤ tanh(511/64) ≈ 0.999999 within the same ±511 wire range, and
// concentrates resolution on the disk boundary where the AR(p) actually
// feels rounding error.
//
// measured 2026-04-09 on production K vectors (8 real-audio clips × 5s @
// 48kHz): LAR scale=64 saves 6.4% on the K coefficient Logos stream vs
// linear, with unchanged residual variance after dequantization. K stream
// is 2-3% of total bytes so end-to-end gain is ~0.18%; the change earns
// its place by being the correct metric on the manifold, not by raw bytes.
//
// the 2-byte wire format uses +512 bias, encoding values 1-1023 in the
// active range. RC_SCALE/RC_BIAS retained for linear-quantized streams
// (post-filter LP coefficients, Givens rotation half-angles) which do
// not live on the same manifold.
const RC_SCALE = 511;
const RC_BIAS  = 512;
const LAR_SCALE = 64;
const LAR_K_MAX = Math.tanh(RC_SCALE / LAR_SCALE);

function quantRC(k: number): number {
    const kc = k > LAR_K_MAX ? LAR_K_MAX : (k < -LAR_K_MAX ? -LAR_K_MAX : k);
    const lar = Math.atanh(kc);
    const q = Math.round(lar * LAR_SCALE);
    return q > RC_SCALE ? RC_SCALE : (q < -RC_SCALE ? -RC_SCALE : q);
}

function dequantRC(q: number): number {
    return Math.tanh(q / LAR_SCALE);
}

/** Burg's method: compute reflection coefficients for data[start..end). */
function burgAnalysis(
    data: Int32Array, start: number, end: number, maxOrder: number,
    outRC?: Float64Array, tmpFwd?: Float64Array, tmpBwd?: Float64Array,
): Float64Array {
    const n = end - start;
    if (n < maxOrder * 2 + 1) return new Float64Array(0);

    const refCoeffs = outRC ?? new Float64Array(maxOrder);
    if (outRC) refCoeffs.fill(0, 0, maxOrder);
    const fwd = tmpFwd && tmpFwd.length >= n ? tmpFwd : new Float64Array(n);
    const bwd = tmpBwd && tmpBwd.length >= n ? tmpBwd : new Float64Array(n);
    for (let i = 0; i < n; i++) { fwd[i] = data[start + i]; bwd[i] = data[start + i]; }

    for (let m = 0; m < maxOrder; m++) {
        let num = 0, den = 0;
        for (let i = m + 1; i < n; i++) {
            num += fwd[i] * bwd[i - 1];
            den += fwd[i] * fwd[i] + bwd[i - 1] * bwd[i - 1];
        }
        if (den < 1e-10) break;
        let k = -2 * num / den;
        k = Math.max(-0.999, Math.min(0.999, k));
        refCoeffs[m] = k;

        for (let i = n - 1; i >= m + 1; i--) {
            const f = fwd[i];
            fwd[i] = f + k * bwd[i - 1];
            bwd[i] = bwd[i - 1] + k * f;
        }
    }

    return refCoeffs;
}

/** Levinson recursion: reflection coefficients to LP coefficients.
 *  preallocated temp buffer eliminates O(order^2) Float64Array allocations
 *  from the inner Levinson loop — saves ~15K allocations per encode. */
const _reflTmp = new Float64Array(32); // max order never exceeds 16
function reflToLP(k: Float64Array, order: number): Float64Array {
    const a = new Float64Array(order);
    if (order === 0) return a;

    a[0] = k[0];
    for (let m = 1; m < order; m++) {
        for (let j = 0; j < m; j++) _reflTmp[j] = a[j];
        a[m] = k[m];
        for (let j = 0; j < m; j++) a[j] = _reflTmp[j] + k[m] * _reflTmp[m - 1 - j];
    }

    // negate: Burg produces a[] where e[n] = x[n] + a[0]*x[n-1] + ...
    // we want pred = a'[0]*x[n-1] + ... so a' = -a
    for (let m = 0; m < order; m++) a[m] = -a[m];

    return a;
}

// ── unified variable-order prediction ──────────────────────────────────
//
// single adaptive-order Burg predictor per 32-sample block.
//
// for each block, Burg analysis produces reflection coefficients at orders
// 0-10. the encoder picks the order that minimizes:
//   cost(p) = p * 8 (coefficient bits) + n * log2(errorVariance_p)
// this is the MDL criterion: model complexity + data surprise.
//
// the prediction is causal, deterministic, and integer-exact:
//   pred = round(a[0]*state[0] + a[1]*state[1] + ... + a[p-1]*state[p-1])
//   residual = sample - pred
// state tracks reconstructed values, so encoder and decoder agree exactly.

const VAR_REUSE_ORDER = 0xFF; // marker: reuse previous block's coefficients
const VAR_BACKWARD_BASE = 0x80; // marker: backward-adaptive prediction (order = byte - 0x80)
// backward-adaptive Burg: the decoder estimates coefficients from already-decoded
// history, so no coefficients are transmitted. for stationary signals (speech,
// sustained tones), backward estimates are nearly as good as forward estimates
// because the spectral envelope changes slowly across blocks. the encoder
// evaluates backward alongside forward/reuse via MDL with zero coefficient cost.
// order byte encodes 0x80+p where p is the backward prediction order.
//
// the K trajectory is chaotic (lyapunov exponent 0.51 nats/block, measured
// on real speech). the prediction horizon is approximately 1 block, which is
// why reuse (lag-0) and backward (lag-1 re-estimation) work but Taylor
// extrapolation of K(t) from K(t-1), K(t-2) does not. linear extrapolation
// in both raw and log-area-ratio domains was tested and catastrophically
// fails because the AR filter is a narrow-band amplifier: even a 50 Hz
// formant misplacement produces residuals 100x larger than the signal.
// the K stream (1-3% of total bytes) is the minimum viable curvature
// transmission for a chaotic metric trajectory.
const BACKWARD_HIST_BLOCKS = 4; // number of past blocks used for backward Burg

function isBackwardOrder(order: number): boolean {
    return order >= VAR_BACKWARD_BASE && order < VAR_REUSE_ORDER;
}
function backwardPredOrder(order: number): number {
    return order - VAR_BACKWARD_BASE;
}

interface VarBlock {
    order: number;
    quantK: Int16Array;     // quantized reflection coefficients (10-bit, ±511)
    a: Float64Array;        // LP coefficients (from quantized reflections)
}

/** fit variable-order Burg on adaptive-length blocks.
 *  returns one VarBlock per block with the optimal order and coefficients.
 *  state carries across blocks (prediction is continuous). */
export function varOrderFitAllBlocks(
    data: Int32Array, numSamples: number, blockLen: number, maxOrder: number,
): VarBlock[] {
    const numBlocks = Math.ceil(numSamples / blockLen);
    const blocks: VarBlock[] = [];
    // preallocated working arrays: eliminates ~2000 small typed array
    // allocations per call from the inner order-selection loop.
    const _qkBuf = new Int16Array(maxOrder);
    const _dqkBuf = new Float64Array(maxOrder);
    // Burg working buffers: largest needed is backward history = 4*blockLen
    const maxBurgN = Math.min(numSamples, BACKWARD_HIST_BLOCKS * blockLen);
    const _burgRC = new Float64Array(maxOrder);
    const _burgFwd = new Float64Array(maxBurgN);
    const _burgBwd = new Float64Array(maxBurgN);
    // shift-register state: tracks previous samples as Float64 so that MDL
    // trial predictions match varOrderPredictEnc exactly (same FP path).
    const state = new Float64Array(maxOrder);
    const _savedSt = new Float64Array(maxOrder);
    const _bestQkBuf = new Int16Array(maxOrder);
    // MDL residual cost uses Gaussian approximation bLen * log2(errVar).
    // byte-entropy MDL was tested but regresses catastrophically because the
    // coefficient cost estimate (2 + log2(1+|q|)) underestimates the actual
    // 16-bit wire cost. the Gaussian overestimate of residual cost compensates,
    // so the two errors cancel. removing one side breaks the balance.
    for (let b = 0; b < numBlocks; b++) {
        const bStart = b * blockLen;
        const bEnd = Math.min(bStart + blockLen, numSamples);
        const bLen = bEnd - bStart;

        // fit Burg at maximum feasible order
        const maxOrd = Math.min(maxOrder, Math.floor(bLen / 3));
        const rawK = maxOrd >= 1 ? burgAnalysis(data, bStart, bEnd, maxOrd, _burgRC, _burgFwd, _burgBwd) : new Float64Array(0);

        // evaluate each candidate order via MDL
        let bestOrder = 0;
        let bestCost = Infinity;
        let bestQuantKLen = 0;
        let bestA = new Float64Array(0);
        let bestReuse = false;

        // order 0 baseline: cost = n * log2(signal variance)
        {
            let energy = 0;
            for (let i = bStart; i < bEnd; i++) energy += data[i] * data[i];
            const errVar = Math.max(1, energy / bLen);
            bestCost = bLen * Math.log2(errVar);
        }

        // try all candidate orders using the WASM burg_trial inner loop.
        // copy data once per block; only LP coefficients and state per order.
        const bw = getBurgWasm();
        const _burgDataView = new Int32Array(bw.mem.buffer, BURG_DATA_OFF, bLen);
        for (let i = 0; i < bLen; i++) _burgDataView[i] = data[bStart + i];
        const _burgAView = new Float64Array(bw.mem.buffer, BURG_A_OFF, maxOrder);
        const _burgStView = new Float64Array(bw.mem.buffer, BURG_ST_OFF, maxOrder);

        for (let tryOrder = 1; tryOrder <= maxOrd; tryOrder++) {
            for (let m = 0; m < tryOrder; m++) {
                _qkBuf[m] = quantRC(rawK[m]);
                _dqkBuf[m] = dequantRC(_qkBuf[m]);
            }
            const a = reflToLP(_dqkBuf.subarray(0, tryOrder), tryOrder);
            // copy LP coefficients and state into WASM memory
            for (let m = 0; m < tryOrder; m++) _burgAView[m] = a[m];
            for (let m = 0; m < maxOrder; m++) _burgStView[m] = state[m];
            const errEnergy = bw.burg_trial(BURG_DATA_OFF, 0, bLen, BURG_A_OFF, tryOrder, BURG_ST_OFF);
            const errVar = Math.max(1, errEnergy / bLen);
            // entropy-estimated MDL: actual per-coefficient cost instead of fixed 8 bits
            let coeffCost = 0;
            for (let m = 0; m < tryOrder; m++) {
                coeffCost += 2 + Math.log2(1 + Math.abs(_qkBuf[m]));
            }
            const cost = coeffCost + bLen * Math.log2(errVar);
            if (cost < bestCost) {
                bestCost = cost;
                bestOrder = tryOrder;
                // copy into preallocated buffer instead of slice (avoids GC)
                for (let m = 0; m < tryOrder; m++) _bestQkBuf[m] = _qkBuf[m];
                bestQuantKLen = tryOrder;
                bestA = a;
                bestReuse = false;
            }
        }

        // try reusing previous block's coefficients (zero coefficient overhead).
        // for slowly varying signals, the spectral trajectory changes so little
        // between blocks that the previous coefficients predict just as well.
        if (b > 0 && blocks[b - 1].order > 0) {
            const prev = blocks[b - 1];
            for (let m = 0; m < maxOrder; m++) _savedSt[m] = state[m];
            let reuseEnergy = 0;
            for (let i = 0; i < bLen; i++) {
                const val = data[bStart + i];
                let pred = 0;
                for (let m = 0; m < prev.order; m++) pred += prev.a[m] * _savedSt[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                reuseEnergy += (val - roundPred) * (val - roundPred);
                for (let m = prev.order - 1; m > 0; m--) _savedSt[m] = _savedSt[m - 1];
                _savedSt[0] = val;
            }
            const reuseVar = Math.max(1, reuseEnergy / bLen);
            // zero coefficient cost — only the order byte (255 marker) which is
            // in the always-present order stream anyway
            const reuseCost = bLen * Math.log2(reuseVar);
            if (reuseCost < bestCost) {
                bestCost = reuseCost;
                bestOrder = prev.order;
                for (let m = 0; m < prev.quantK.length; m++) _bestQkBuf[m] = prev.quantK[m];
                bestQuantKLen = prev.quantK.length;
                bestA = prev.a;
                bestReuse = true;
            }
        }

        // backward-adaptive trial: estimate coefficients from past decoded data.
        // the decoder runs the same Burg analysis on decoded history (identical
        // to encoder's original data due to lossless integer prediction).
        // zero coefficient cost — the decoder computes them independently.
        //
        // optimization: only try backward at the best forward order. trying all
        // orders is O(maxOrder) per block and makes encoding too slow. the best
        // forward order already encodes the right model complexity; backward just
        // asks whether the SAME order estimated from history is good enough.
        let bestBackward = false;
        if (bestOrder > 0 && !bestReuse && bStart >= blockLen) {
            const histLen = BACKWARD_HIST_BLOCKS * blockLen;
            const histStart = Math.max(0, bStart - histLen);
            const histN = bStart - histStart;
            const tryOrder = Math.min(bestOrder, Math.floor(histN / 3));
            if (tryOrder >= 1) {
                const backK = burgAnalysis(data, histStart, bStart, tryOrder, _burgRC, _burgFwd, _burgBwd);
                for (let m = 0; m < tryOrder; m++) {
                    _qkBuf[m] = quantRC(backK[m]);
                    _dqkBuf[m] = dequantRC(_qkBuf[m]);
                }
                const a = reflToLP(_dqkBuf.subarray(0, tryOrder), tryOrder);
                for (let m = 0; m < maxOrder; m++) _savedSt[m] = state[m];
                let errEnergy = 0;
                for (let i = 0; i < bLen; i++) {
                    const val = data[bStart + i];
                    let pred = 0;
                    for (let m = 0; m < tryOrder; m++) pred += a[m] * _savedSt[m];
                    const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                    errEnergy += (val - roundPred) * (val - roundPred);
                    for (let m = tryOrder - 1; m > 0; m--) _savedSt[m] = _savedSt[m - 1];
                    _savedSt[0] = val;
                }
                const errVar = Math.max(1, errEnergy / bLen);
                let backPenalty = 0;
                for (let m = 0; m < tryOrder; m++) {
                    backPenalty += 2 + Math.log2(1 + Math.abs(_qkBuf[m])) * 0.5;
                }
                const backCost = bLen * Math.log2(errVar) + backPenalty;
                if (backCost < bestCost) {
                    bestCost = backCost;
                    bestOrder = tryOrder;
                    for (let m = 0; m < tryOrder; m++) _bestQkBuf[m] = _qkBuf[m];
                    bestQuantKLen = tryOrder;
                    bestA = a;
                    bestReuse = false;
                    bestBackward = true;
                }
            }
        }

        const finalOrder = bestBackward
            ? (VAR_BACKWARD_BASE + bestOrder)
            : bestReuse ? VAR_REUSE_ORDER : bestOrder;
        blocks.push({ order: finalOrder, quantK: _bestQkBuf.slice(0, bestQuantKLen), a: bestA });

        // advance shift-register state through this block's samples
        for (let i = bStart; i < bEnd; i++) {
            for (let m = maxOrder - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = data[i];
        }
    }

    return blocks;
}

/** estimate coefficient stream cost (bits) before Logos compression.
 *  uses per-coefficient entropy estimate matching MDL criterion.
 *  reuse blocks (order=0xFF) contribute only the order byte, no coefficients. */
export function estimateCoeffBits(blocks: VarBlock[]): number {
    let bits = 0;
    for (const b of blocks) {
        bits += 8; // order byte (always)
        if (b.order !== VAR_REUSE_ORDER && !isBackwardOrder(b.order)) {
            const ord = b.order;
            for (let m = 0; m < ord; m++) {
                const absQ = b.quantK[m] < 0 ? -b.quantK[m] : b.quantK[m];
                bits += 2 + Math.log2(1 + absQ);
            }
        }
        // backward and reuse blocks: zero coefficient cost
    }
    return bits;
}

/** encode prediction: data → residuals using fitted VarBlocks.
 *  uses a.length for prediction order (handles reuse blocks transparently). */
export function varOrderPredictEnc(
    data: Int32Array, numSamples: number, blocks: VarBlock[],
    blockLen: number, maxOrder: number,
): Int32Array {
    const residuals = new Int32Array(numSamples);
    const state = new Float64Array(maxOrder);

    for (let b = 0; b < blocks.length; b++) {
        const bStart = b * blockLen;
        const bEnd = Math.min(bStart + blockLen, numSamples);
        const { a } = blocks[b];
        const p = a.length;

        for (let i = bStart; i < bEnd; i++) {
            const val = data[i];
            if (p > 0) {
                let pred = 0;
                for (let m = 0; m < p; m++) pred += a[m] * state[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                residuals[i] = val - roundPred;
            } else {
                residuals[i] = val;
            }
            for (let m = maxOrder - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = val;
        }
    }

    return residuals;
}

/** decode prediction: residuals → data using fitted VarBlocks.
 *  uses a.length for prediction order (handles reuse blocks transparently).
 *  backward-adaptive blocks compute Burg coefficients from decoded history. */
export function varOrderPredictDec(
    residuals: Int32Array, numSamples: number, blocks: VarBlock[],
    blockLen: number, maxOrder: number,
): Int32Array {
    const data = new Int32Array(numSamples);
    const state = new Float64Array(maxOrder);

    for (let b = 0; b < blocks.length; b++) {
        const bStart = b * blockLen;
        const bEnd = Math.min(bStart + blockLen, numSamples);
        let { a } = blocks[b];

        // backward-adaptive: compute coefficients from decoded history
        if (isBackwardOrder(blocks[b].order)) {
            const backOrder = backwardPredOrder(blocks[b].order);
            const histLen = BACKWARD_HIST_BLOCKS * blockLen;
            const histStart = Math.max(0, bStart - histLen);
            const histN = bStart - histStart;
            const feasibleOrd = Math.min(backOrder, Math.floor(histN / 3));
            if (feasibleOrd >= 1 && histN >= 3) {
                const rawK = burgAnalysis(data, histStart, bStart, feasibleOrd);
                const qk = new Int16Array(feasibleOrd);
                const dqk = new Float64Array(feasibleOrd);
                for (let m = 0; m < feasibleOrd; m++) {
                    qk[m] = quantRC(rawK[m]);
                    dqk[m] = dequantRC(qk[m]);
                }
                a = reflToLP(dqk, feasibleOrd);
                // store back so cell projection can use the same coefficients
                blocks[b] = { order: blocks[b].order, quantK: qk, a };
            }
        }

        const p = a.length;

        for (let i = bStart; i < bEnd; i++) {
            if (p > 0) {
                let pred = 0;
                for (let m = 0; m < p; m++) pred += a[m] * state[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                data[i] = residuals[i] + roundPred;
            } else {
                data[i] = residuals[i];
            }
            for (let m = maxOrder - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = data[i];
        }
    }

    return data;
}

/** global post-filter: second-stage prediction on Burg residuals.
 *  per-block Burg captures within-block correlation, but cross-block patterns
 *  (harmonic beating, FM modulation) survive as autocorrelation at lags 2-8.
 *
 *  generates candidates via sparse Yule-Walker at peak-autocorrelation lags:
 *  - single-lag at top-3 lags (one nonzero LP coefficient)
 *  - pair: 2x2 Yule-Walker at top-2 lags
 *  - triple: 3x3 Cramer's rule at top-3 lags
 *  - quadruple: 4x4 Gaussian elimination at top-4 lags
 *  key insight: Burg smears coefficients across ALL positions including dead
 *  zones (lag 1 often near zero); sparse Yule-Walker targets only correlation
 *  peaks. the filter's benefit comes through the wavelet (reducing coefficient
 *  magnitudes and plane counts), not through Logos directly.
 *
 *  the encoder picks whichever candidate saves the most through the full
 *  subband pipeline trial (wavelet + Logos).
 *
 *  wire format: order byte (0 = no filter) + order LP coefficient pairs (10-bit).
 *  decoder applies the LP coefficients directly.
 *
 *  limitation: at low Q (scalar < ~100), the integer rounding in the prediction
 *  step dominates the prediction gain. the filter only helps at Q70+ where
 *  residuals have enough dynamic range for integer prediction to be meaningful. */

interface PostFilterCandidate {
    order: number;
    quantLP: Int16Array; // quantized LP coefficients (10-bit, ±511)
}

function generatePostFilterCandidates(
    residuals: Int32Array, n: number, scalar: number, blockLen: number,
): PostFilterCandidate[] {
    if (n < 16) return [];
    const candidates: PostFilterCandidate[] = [];

    // adaptive threshold: stricter at low scalar (where integer rounding dominates),
    // more permissive at high scalar (where residuals have real structure)
    const acThreshold = Math.max(0.05, Math.min(0.30, 0.25 / Math.sqrt(scalar / 100)));

    // adaptive max order: scales with block length
    const postFilterMaxOrder = Math.min(blockLen >> 1, 16);

    // compute normalized autocorrelation at lags 1-maxOrder
    let r0 = 0;
    for (let i = 0; i < n; i++) r0 += residuals[i] * residuals[i];
    if (r0 <= 0) return [];
    const r = new Float64Array(postFilterMaxOrder + 1);
    for (let lag = 1; lag <= postFilterMaxOrder; lag++) {
        let rk = 0;
        for (let i = lag; i < n; i++) rk += residuals[i] * residuals[i - lag];
        r[lag] = rk / r0;
    }

    // rank lags by |autocorrelation|
    const lagScores: { lag: number; ac: number }[] = [];
    for (let lag = 1; lag <= postFilterMaxOrder; lag++) {
        lagScores.push({ lag, ac: r[lag] < 0 ? -r[lag] : r[lag] });
    }
    lagScores.sort((a, b) => b.ac - a.ac);

    // candidate: single-lag at each of top-3 lags
    for (let rank = 0; rank < Math.min(3, lagScores.length); rank++) {
        const { lag, ac } = lagScores[rank];
        if (ac < acThreshold) continue;
        const alpha10 = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(r[lag] * RC_SCALE)));
        if (alpha10 === 0) continue;
        const quantLP = new Int16Array(lag);
        quantLP[lag - 1] = alpha10;
        candidates.push({ order: lag, quantLP });
    }

    // candidate: sparse pair via Yule-Walker (top-2 lags)
    if (lagScores.length >= 2 && lagScores[0].ac > acThreshold && lagScores[1].ac > acThreshold) {
        const j = lagScores[0].lag;
        const k = lagScores[1].lag;
        const rjk = r[j > k ? j - k : k - j];
        const det = 1 - rjk * rjk;
        if (det > 1e-6) {
            const a_j = (r[j] - r[k] * rjk) / det;
            const a_k = (r[k] - r[j] * rjk) / det;
            const maxLag = j > k ? j : k;
            const quantLP = new Int16Array(maxLag);
            quantLP[j - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a_j * RC_SCALE)));
            quantLP[k - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a_k * RC_SCALE)));
            if (quantLP[j - 1] !== 0 || quantLP[k - 1] !== 0) {
                candidates.push({ order: maxLag, quantLP });
            }
        }
    }

    // candidate: sparse triple via Yule-Walker (top-3 lags)
    if (lagScores.length >= 3 && lagScores[0].ac > acThreshold && lagScores[1].ac > acThreshold && lagScores[2].ac > acThreshold) {
        const lags = lagScores.slice(0, 3).map(l => l.lag).sort((a, b) => a - b);
        const [j, k, l] = lags;
        const r_jk = r[k - j], r_jl = r[l - j], r_kl = r[l - k];
        const det = 1 - r_jk * r_jk - r_jl * r_jl - r_kl * r_kl + 2 * r_jk * r_jl * r_kl;
        if (det > 1e-6) {
            const a_j = (r[j] * (1 - r_kl * r_kl) + r[k] * (r_jl * r_kl - r_jk) + r[l] * (r_jk * r_kl - r_jl)) / det;
            const a_k = (r[j] * (r_jl * r_kl - r_jk) + r[k] * (1 - r_jl * r_jl) + r[l] * (r_jk * r_jl - r_kl)) / det; // note: (r_jk * r_jl - r_kl) via Cramer
            const a_l = (r[j] * (r_jk * r_kl - r_jl) + r[k] * (r_jk * r_jl - r_kl) + r[l] * (1 - r_jk * r_jk)) / det;
            const maxLag = l;
            const quantLP = new Int16Array(maxLag);
            quantLP[j - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a_j * RC_SCALE)));
            quantLP[k - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a_k * RC_SCALE)));
            quantLP[l - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a_l * RC_SCALE)));
            candidates.push({ order: maxLag, quantLP });
        }
    }

    // candidate: sparse quadruple via 4x4 Yule-Walker (top-4 lags)
    if (lagScores.length >= 4 && lagScores[0].ac > acThreshold && lagScores[1].ac > acThreshold &&
        lagScores[2].ac > acThreshold && lagScores[3].ac > acThreshold) {
        const lags = lagScores.slice(0, 4).map(ls => ls.lag).sort((a, b) => a - b);
        // build 4x4 autocorrelation matrix and solve via Gaussian elimination
        const R: number[][] = [];
        const rhs: number[] = [];
        let valid = true;
        for (let i = 0; i < 4; i++) {
            rhs.push(r[lags[i]]);
            const row: number[] = [];
            for (let j = 0; j < 4; j++) {
                const diff = lags[i] > lags[j] ? lags[i] - lags[j] : lags[j] - lags[i];
                if (diff > postFilterMaxOrder) { valid = false; break; }
                row.push(diff === 0 ? 1 : r[diff]);
            }
            if (!valid) break;
            R.push(row);
        }
        if (valid) {
            // Gaussian elimination with partial pivoting
            const A = R.map(row => [...row]);
            const b = [...rhs];
            let singular = false;
            for (let col = 0; col < 4 && !singular; col++) {
                let maxRow = col, maxVal = A[col][col] < 0 ? -A[col][col] : A[col][col];
                for (let row = col + 1; row < 4; row++) {
                    const v = A[row][col] < 0 ? -A[row][col] : A[row][col];
                    if (v > maxVal) { maxVal = v; maxRow = row; }
                }
                if (maxVal < 1e-8) { singular = true; break; }
                if (maxRow !== col) {
                    const tmpR = A[col]; A[col] = A[maxRow]; A[maxRow] = tmpR;
                    const tmpB = b[col]; b[col] = b[maxRow]; b[maxRow] = tmpB;
                }
                for (let row = col + 1; row < 4; row++) {
                    const factor = A[row][col] / A[col][col];
                    for (let jj = col; jj < 4; jj++) A[row][jj] -= factor * A[col][jj];
                    b[row] -= factor * b[col];
                }
            }
            if (!singular) {
                const x = new Float64Array(4);
                for (let i = 3; i >= 0; i--) {
                    let sum = b[i];
                    for (let jj = i + 1; jj < 4; jj++) sum -= A[i][jj] * x[jj];
                    x[i] = sum / A[i][i];
                }
                const maxLag = lags[3];
                const quantLP = new Int16Array(maxLag);
                let anyNonZero = false;
                for (let idx = 0; idx < 4; idx++) {
                    quantLP[lags[idx] - 1] = Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(x[idx] * RC_SCALE)));
                    if (quantLP[lags[idx] - 1] !== 0) anyNonZero = true;
                }
                if (anyNonZero) {
                    candidates.push({ order: maxLag, quantLP });
                }
            }
        }
    }

    return candidates;
}

function applyPostFilterEnc(residuals: Int32Array, n: number, order: number, quantLP: Int16Array): Int32Array {
    const a = new Float64Array(order);
    for (let m = 0; m < order; m++) a[m] = quantLP[m] / RC_SCALE;

    const out = new Int32Array(n);
    const state = new Float64Array(order);
    for (let i = 0; i < n; i++) {
        let pred = 0;
        for (let m = 0; m < order; m++) pred += a[m] * state[m];
        const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
        out[i] = residuals[i] - roundPred;
        for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
        state[0] = residuals[i]; // use original for prediction
    }
    return out;
}

function applyPostFilterDec(filtered: Int32Array, n: number, order: number, quantLP: Int16Array): Int32Array {
    const a = new Float64Array(order);
    for (let m = 0; m < order; m++) a[m] = quantLP[m] / RC_SCALE;

    const out = new Int32Array(n);
    const state = new Float64Array(order);
    for (let i = 0; i < n; i++) {
        let pred = 0;
        for (let m = 0; m < order; m++) pred += a[m] * state[m];
        const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
        out[i] = filtered[i] + roundPred;
        for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
        state[0] = out[i]; // use reconstructed for prediction
    }
    return out;
}

/** encode coefficient stream with trial-gated order-sorted layout.
 *  tries both temporal order and order-sorted layouts, picks the smaller.
 *
 *  order-sorted: within each level, forward blocks are sorted by their
 *  order value (stable). this groups same-complexity blocks together,
 *  giving Logos longer runs of homogeneous coefficient statistics.
 *  the decoder reconstructs the same sorted permutation from the order
 *  stream. a leading flag byte (0=temporal, 1=sorted) tells the decoder
 *  which layout was used.
 *
 *  the sorting gives 15-37% coefficient stream reduction for longer frames
 *  (100ms+) but can slightly regress on very short frames (10ms) where
 *  the coefficient stream is too small for Logos to benefit from grouping. */
export function encodeCoeffStream(blocks: VarBlock[]): { raw: Uint8Array; compressed: Uint8Array } {
    const n = blocks.length;
    let totalCoeffs = 0;
    let maxOrder = 0;
    for (const b of blocks) {
        const ord = (b.order === VAR_REUSE_ORDER || isBackwardOrder(b.order)) ? 0 : b.order;
        totalCoeffs += ord;
        if (ord > maxOrder) maxOrder = ord;
    }

    const coeffBytes = totalCoeffs * 2;
    // +1 for the flag byte
    const totalBytes = 1 + n + coeffBytes;

    // build temporal-order raw stream
    const rawTemporal = new Uint8Array(totalBytes);
    rawTemporal[0] = 0; // flag: temporal order
    let off = 1;
    for (let i = 0; i < n; i++) rawTemporal[off++] = blocks[i].order;
    for (let k = 0; k < maxOrder; k++) {
        for (let i = 0; i < n; i++) {
            const o = blocks[i].order;
            if (o !== VAR_REUSE_ORDER && !isBackwardOrder(o) && o > k) {
                rawTemporal[off++] = (blocks[i].quantK[k] + RC_BIAS) & 0xFF;
            }
        }
        for (let i = 0; i < n; i++) {
            const o = blocks[i].order;
            if (o !== VAR_REUSE_ORDER && !isBackwardOrder(o) && o > k) {
                rawTemporal[off++] = ((blocks[i].quantK[k] + RC_BIAS) >> 8) & 0xFF;
            }
        }
    }
    const compTemporal = encode0D(rawTemporal);

    // build order-sorted index for forward blocks
    const fwdIndices: number[] = [];
    for (let i = 0; i < n; i++) {
        if (blocks[i].order !== VAR_REUSE_ORDER && !isBackwardOrder(blocks[i].order)) {
            fwdIndices.push(i);
        }
    }
    // check if sorting would differ (need at least 2 distinct orders)
    let distinct = false;
    for (let i = 1; i < fwdIndices.length; i++) {
        if (blocks[fwdIndices[i]].order !== blocks[fwdIndices[0]].order) { distinct = true; break; }
    }

    if (!distinct || fwdIndices.length < 4) {
        // sorting would be identical to temporal, skip trial
        return { raw: rawTemporal, compressed: compTemporal };
    }

    fwdIndices.sort((a, b) => blocks[a].order - blocks[b].order);

    const rawSorted = new Uint8Array(totalBytes);
    rawSorted[0] = 1; // flag: order-sorted
    off = 1;
    for (let i = 0; i < n; i++) rawSorted[off++] = blocks[i].order;
    for (let k = 0; k < maxOrder; k++) {
        for (const idx of fwdIndices) {
            if (blocks[idx].order > k) {
                rawSorted[off++] = (blocks[idx].quantK[k] + RC_BIAS) & 0xFF;
            }
        }
        for (const idx of fwdIndices) {
            if (blocks[idx].order > k) {
                rawSorted[off++] = ((blocks[idx].quantK[k] + RC_BIAS) >> 8) & 0xFF;
            }
        }
    }
    const compSorted = encode0D(rawSorted);

    if (compSorted.length < compTemporal.length) {
        return { raw: rawSorted, compressed: compSorted };
    }
    return { raw: rawTemporal, compressed: compTemporal };
}

/** decode transposed coefficient stream back to VarBlock array.
 *  reads a flag byte (0=temporal, 1=order-sorted) then orders, then coefficients.
 *  for sorted layout, reconstructs the same permutation from the order stream. */
function decodeCoeffStream(data: Uint8Array, numBlocks: number): VarBlock[] {
    let off = 0;
    // flag byte: 0 = temporal order, 1 = order-sorted
    const sorted = data[off++] === 1;

    const orders: number[] = [];
    let maxOrder = 0;
    for (let i = 0; i < numBlocks; i++) {
        const o = data[off++];
        orders.push(o);
        if (o !== VAR_REUSE_ORDER && !isBackwardOrder(o) && o > maxOrder) maxOrder = o;
    }

    // build forward-block index (same for both layouts)
    const fwdIndices: number[] = [];
    for (let i = 0; i < numBlocks; i++) {
        if (orders[i] !== VAR_REUSE_ORDER && !isBackwardOrder(orders[i])) {
            fwdIndices.push(i);
        }
    }
    // for sorted layout, reorder by block order to match encoder
    if (sorted) fwdIndices.sort((a, b) => orders[a] - orders[b]);

    const quantKArrays: Int16Array[] = [];
    for (let i = 0; i < numBlocks; i++) {
        const ord = (orders[i] === VAR_REUSE_ORDER || isBackwardOrder(orders[i])) ? 0 : orders[i];
        quantKArrays.push(new Int16Array(ord));
    }

    // count coefficients per level for offset calculation
    const coeffsPerLevel: number[] = [];
    for (let k = 0; k < maxOrder; k++) {
        let count = 0;
        for (const idx of fwdIndices) {
            if (orders[idx] > k) count++;
        }
        coeffsPerLevel.push(count);
    }

    // read coefficients in the layout order (temporal or sorted)
    for (let k = 0; k < maxOrder; k++) {
        const loOff = off;
        const hiOff = off + coeffsPerLevel[k];
        let li = 0;
        for (const idx of fwdIndices) {
            if (orders[idx] > k) {
                const lo = data[loOff + li];
                const hi = data[hiOff + li];
                quantKArrays[idx][k] = ((hi << 8) | lo) - RC_BIAS;
                li++;
            }
        }
        off += coeffsPerLevel[k] * 2;
    }
    // build VarBlock array, resolving reuse and backward references
    const blocks: VarBlock[] = [];
    for (let i = 0; i < numBlocks; i++) {
        if (orders[i] === VAR_REUSE_ORDER && i > 0) {
            blocks.push(blocks[i - 1]); // share reference with previous block
        } else if (isBackwardOrder(orders[i])) {
            // backward-adaptive: placeholder with empty coefficients.
            // varOrderPredictDec will compute from decoded history.
            blocks.push({ order: orders[i], quantK: new Int16Array(0), a: new Float64Array(0) });
        } else {
            const order = orders[i];
            const quantK = quantKArrays[i];
            const dqk = new Float64Array(order);
            for (let m = 0; m < order; m++) dqk[m] = dequantRC(quantK[m]);
            const a = order > 0 ? reflToLP(dqk, order) : new Float64Array(0);
            blocks.push({ order, quantK, a });
        }
    }
    return blocks;
}

/** dequantization refinement: project decoded integers onto the prediction
 *  manifold within each quantization cell. forward Burg prior constrained
 *  to [q-0.5, q+0.5].
 *
 *  note: backward (anti-causal) pass was tried but provides negligible
 *  improvement (~0.000001 maxErr). the ±0.5 cell is too narrow for the
 *  backward prediction to add meaningful information beyond the forward
 *  pass. the forward-only projection is already near-optimal. */
function varOrderCellProject(
    projected: Float32Array, data: Int32Array, blocks: VarBlock[],
    blockLen: number, maxOrder: number,
): void {
    const n = data.length;
    const numBlocks = blocks.length;

    // forward pass
    const state = new Float64Array(maxOrder);
    for (let b = 0; b < numBlocks; b++) {
        const bStart = b * blockLen;
        const bEnd = Math.min(bStart + blockLen, n);
        const { a } = blocks[b];
        const p = a.length;

        if (p > 0) {
            // measure prediction quality on this block
            let obsEnergy = 0, count = 0;
            const anaState = new Float64Array(state);
            for (let i = bStart; i < bEnd; i++) {
                let pred = 0;
                for (let m = 0; m < p; m++) pred += a[m] * anaState[m];
                const d = projected[i] - pred;
                obsEnergy += d * d;
                count++;
                for (let m = p - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                anaState[0] = projected[i];
            }
            const obsVar = count > 0 ? obsEnergy / count : 0;
            const weight = obsVar > 0 ? Math.min(1, QUANT_NOISE_REG / obsVar) : 1;

            if (weight > 0) {
                for (let i = bStart; i < bEnd; i++) {
                    let pred = 0;
                    for (let m = 0; m < p; m++) pred += a[m] * state[m];
                    const q = data[i];
                    const lo = q - 0.5;
                    const hi = q + 0.5;
                    const clamped = pred < lo ? lo : pred > hi ? hi : pred;
                    projected[i] = projected[i] + weight * (clamped - projected[i]);
                    for (let m = p - 1; m > 0; m--) state[m] = state[m - 1];
                    state[0] = projected[i];
                }
            } else {
                for (let i = bStart; i < bEnd; i++) {
                    for (let m = p - 1; m > 0; m--) state[m] = state[m - 1];
                    state[0] = projected[i];
                }
            }
        } else {
            for (let i = bStart; i < bEnd; i++) {
                for (let m = maxOrder - 1; m > 0; m--) state[m] = state[m - 1];
                state[0] = projected[i];
            }
        }
    }
}


/** channel-axis dequantization refinement.
 *  the two orthogonal metric layers (W on the channel axis, K/G on the
 *  time axis) each produce an independent prior for the decoded sample's
 *  position within its quantization cell [q-0.5, q+0.5].
 *
 *  if the reference channel moved inside its cell during reconstruction,
 *  the coupled channel should move with it by W*delta_ref. project that
 *  channel-axis prior into the current channel's cell and blend it with
 *  the time-axis estimate. the precision weight W^2/(1+W^2) is the
 *  normalized energy share of the channel axis in x = u + W*r. this is
 *  not a lossy operation. it is consistency enforcement within the
 *  quantization lattice. */
function couplingCellProject(
    projected: Float32Array, data: Int32Array,
    refProjected: Float32Array, refData: Int32Array, W: number,
): void {
    const w2 = W * W;
    const axisWeight = w2 / (1 + w2);
    if (!(axisWeight > 0)) return;

    for (let i = 0; i < data.length; i++) {
        const q = data[i];
        const prior = q + W * (refProjected[i] - refData[i]);
        const lo = q - 0.5;
        const hi = q + 0.5;
        const clamped = prior < lo ? lo : prior > hi ? hi : prior;
        projected[i] += axisWeight * (clamped - projected[i]);
    }
}

/** fractal dyadic cell relaxation.
 *  the wavelet tower already says the signal should remain coherent across
 *  octaves. for a locally linear waveform, x[i] should sit near the midpoint of
 *  its dyadic neighbors:
 *
 *    x[i] â‰ˆ (x[i-h] + x[i+h]) / 2,  h = 1, 2, 4, ...
 *
 *  under independent uniform quantization noise, the midpoint residual
 *    x[i] - (x[i-h]+x[i+h])/2
 *  has exact variance:
 *    (1Â² + (1/2)Â² + (1/2)Â²) / 12 = 1/8.
 *
 *  use that as the physical floor. when the observed curvature at a dyadic
 *  scale is at or below this floor, the self-similar prior is trustworthy and
 *  the sample is relaxed toward the dyadic midpoint inside its quantization
 *  cell. when the waveform bends more sharply, the weight fades out.
 */
function fractalCellProject(
    projected: Float32Array, data: Int32Array, numLevels: number,
): void {
    const n = data.length;
    if (n < 3) return;

    const scales: number[] = [];
    const maxPow = Math.min(numLevels + 2, 6);
    for (let p = 0; p <= maxPow; p++) {
        const h = 1 << p;
        if ((h << 1) >= n) break;
        scales.push(h);
    }
    for (let p = scales.length - 2; p >= 0; p--) scales.push(scales[p]);
    if (scales.length === 0) return;

    let current = projected;
    let scratch: Float32Array | null = null;

    for (const h of scales) {
        let obsEnergy = 0;
        let count = 0;
        for (let i = h; i + h < n; i++) {
            const mid = 0.5 * (current[i - h] + current[i + h]);
            const d = current[i] - mid;
            obsEnergy += d * d;
            count++;
        }
        if (count === 0) continue;
        const obsVar = obsEnergy / count;
        const weight = obsVar > 0 ? Math.min(1, DYADIC_NOISE_FLOOR / obsVar) : 1;
        if (!(weight > 0)) continue;

        if (!scratch || scratch.length !== n) scratch = new Float32Array(n);
        scratch.set(current);
        for (let i = h; i + h < n; i++) {
            const q = data[i];
            const lo = q - 0.5;
            const hi = q + 0.5;
            const mid = 0.5 * (current[i - h] + current[i + h]);
            const clamped = mid < lo ? lo : mid > hi ? hi : mid;
            scratch[i] = current[i] + weight * (clamped - current[i]);
        }
        current = scratch.slice();
    }

    if (current !== projected) projected.set(current);
}


// reusable entropy count buffer (avoids allocation per call)
// entropy estimation scratch is now in _ctx.ent (codec context)

/** byte-plane cost estimate (bytes) for subband residuals.
 *  uses the MINIMUM of order-0 entropy and XOR-derivative entropy on the
 *  low plane. the XOR derivative (byte[i] ^ byte[i-1]) is exactly what
 *  Logos's Z-axis models â€” it captures byte-to-byte correlation that the
 *  prediction pipeline creates. taking the min of both estimates ensures
 *  the trial comparison sees whichever structure the data actually has:
 *  order-0 for independent bytes, Z-axis for correlated bytes. */
/** Shannon cost estimate for multiple subbands. sums estimatePlaneCost per
 *  subband, matching the overhead structure of trialLogosSize but without
 *  running Logos. used by MERA, connection, and packet trial gates. */
function estimateSubbandsCost(subbands: Int32Array[]): number {
    let total = 1 + 5 * subbands.length + 1;
    for (const sb of subbands) total += 4 + estimatePlaneCost(sb);
    return total;
}

function estimatePlaneCost(residuals: Int32Array): number {
    const n = residuals.length;
    if (n === 0) return 0;

    // determine plane count from max zigzag
    let maxZZ = 0;
    for (let i = 0; i < n; i++) {
        const v = residuals[i];
        const zz = ((v >> 31) ^ (v << 1)) >>> 0;
        if (zz > maxZZ) maxZZ = zz;
    }
    const planes = planeCount(maxZZ);

    let totalBits = 0;
    for (let plane = 0; plane < planes; plane++) {
        const shift = plane * 8;

        // order-0 entropy
        _ctx.ent.fill(0);
        for (let i = 0; i < n; i++) {
            const v = residuals[i];
            _ctx.ent[((v >= 0 ? v * 2 : (-v * 2 - 1)) >>> shift) & 0xFF]++;
        }
        let h0 = 0;
        for (let b = 0; b < 256; b++) {
            const c = _ctx.ent[b];
            if (c > 0) h0 -= c * Math.log2(c / n);
        }

        if (plane === 0 && n >= 32) {
            // XOR derivative entropy (models Logos Z-axis: byte-to-byte change)
            _ctx.ent.fill(0);
            let prev = ((residuals[0] >= 0 ? residuals[0] * 2 : (-residuals[0] * 2 - 1)) >>> shift) & 0xFF;
            for (let i = 1; i < n; i++) {
                const v = residuals[i];
                const zz = ((v >= 0 ? v * 2 : (-v * 2 - 1)) >>> shift) & 0xFF;
                _ctx.ent[zz ^ prev]++;
                prev = zz;
            }
            // add first sample at order-0 cost
            let hZ = 8; // first sample: worst case 8 bits
            for (let b = 0; b < 256; b++) {
                const c = _ctx.ent[b];
                if (c > 0) hZ -= c * Math.log2(c / (n - 1));
            }
            totalBits += Math.min(h0, hZ);
        } else {
            totalBits += h0;
        }
    }
    return Math.max(3, Math.ceil(totalBits / 8));
}

// â”€â”€ ChaCha20 + SipHash-lite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function qround(s: Uint32Array, a: number, b: number, c: number, d: number): void {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = (s[d] ^ s[a]) >>> 0;
    s[d] = ((s[d] << 16) | (s[d] >>> 16)) >>> 0;
    s[c] = (s[c] + s[d]) >>> 0; s[b] = (s[b] ^ s[c]) >>> 0;
    s[b] = ((s[b] << 12) | (s[b] >>> 20)) >>> 0;
    s[a] = (s[a] + s[b]) >>> 0; s[d] = (s[d] ^ s[a]) >>> 0;
    s[d] = ((s[d] << 8)  | (s[d] >>> 24)) >>> 0;
    s[c] = (s[c] + s[d]) >>> 0; s[b] = (s[b] ^ s[c]) >>> 0;
    s[b] = ((s[b] << 7)  | (s[b] >>> 25)) >>> 0;
}

function chacha20Block(state: Uint32Array): Uint32Array {
    const s = new Uint32Array(16); s.set(state);
    for (let i = 0; i < 10; i++) {
        qround(s,0,4,8,12); qround(s,1,5,9,13); qround(s,2,6,10,14); qround(s,3,7,11,15);
        qround(s,0,5,10,15); qround(s,1,6,11,12); qround(s,2,7,8,13); qround(s,3,4,9,14);
    }
    const out = new Uint32Array(16);
    for (let i = 0; i < 16; i++) out[i] = (s[i] + state[i]) >>> 0;
    state[12] = (state[12] + 1) >>> 0;
    return out;
}

function avalanche(x: number): number {
    x = Math.imul((x ^ (x >>> 16)) >>> 0, 0x85EBCA6B) >>> 0;
    x = Math.imul((x ^ (x >>> 13)) >>> 0, 0xC2B2AE35) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
}

interface CryptoState {
    state: Uint32Array; ks: Uint32Array; idx: number;
    mac0: number; mac1: number; count: number;
}

function cryptoInit(key: Uint32Array): CryptoState {
    const state = new Uint32Array(16);
    state[0] = 0x61707865; state[1] = 0x33322033;
    state[2] = 0x79622d64; state[3] = 0x6b206574;
    state[4] = key[0]; state[5] = key[1]; state[6] = key[2]; state[7] = key[3];
    return { state, ks: new Uint32Array(16), idx: 64, mac0: key[0], mac1: key[1], count: 1 };
}

function cryptoNextWord(cs: CryptoState): number {
    if (cs.idx >= 64) { cs.ks = chacha20Block(cs.state); cs.idx = 0; }
    const w = cs.ks[cs.idx >> 2]; cs.idx += 4; return w;
}

function cryptoMacUpdate(cs: CryptoState, cipher: number): void {
    cs.mac0 = (cs.mac0 + cipher) >>> 0;
    cs.mac0 = (((cs.mac0 << 13) | (cs.mac0 >>> 19)) ^ cs.mac1) >>> 0;
    cs.mac1 = (((cs.mac1 << 17) | (cs.mac1 >>> 15)) + cipher) >>> 0;
    if ((cs.count & 1023) === 0) {
        cs.state[4] = avalanche((cs.state[4] ^ cs.mac0) >>> 0);
        cs.state[5] = avalanche((cs.state[5] ^ cs.mac1) >>> 0);
        cs.mac0 = (cs.mac0 ^ 0xDEADBEEF) >>> 0;
        cs.mac1 = (cs.mac1 ^ 0x1337C0DE) >>> 0;
    }
    cs.count++;
}

function encryptPayload(data: Uint8Array, key: Uint32Array): { encrypted: Uint8Array; mac0: number; mac1: number } {
    const padded = ((data.length + 3) & ~3);
    const buf = new Uint8Array(padded); buf.set(data);
    const view = new DataView(buf.buffer);
    const cs = cryptoInit(key);
    for (let i = 0; i < padded >> 2; i++) {
        const cipher = (view.getUint32(i * 4, true) ^ cryptoNextWord(cs)) >>> 0;
        view.setUint32(i * 4, cipher, true);
        cryptoMacUpdate(cs, cipher);
    }
    return { encrypted: buf, mac0: cs.mac0, mac1: cs.mac1 };
}

function decryptPayload(data: Uint8Array, key: Uint32Array): { decrypted: Uint8Array; mac0: number; mac1: number } {
    const buf = new Uint8Array(data.length); buf.set(data);
    const view = new DataView(buf.buffer);
    const cs = cryptoInit(key);
    for (let i = 0; i < data.length >> 2; i++) {
        const cipher = view.getUint32(i * 4, true);
        cryptoMacUpdate(cs, cipher);
        view.setUint32(i * 4, (cipher ^ cryptoNextWord(cs)) >>> 0, true);
    }
    return { decrypted: buf, mac0: cs.mac0, mac1: cs.mac1 };
}

// â”€â”€ wire format helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€ codec context (reentrant) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// all mutable scratch buffers are owned by a context object, not globals.
// this makes the codec fully reentrant: multiple concurrent encode/decode
// calls (different streams, Web Workers, Promise interleaving) cannot
// corrupt each other's state. the context is created per-call and
// discarded after â€” zero risk of stale state leaking between frames.

interface CodecCtx {
    buf: Uint8Array;
    off: number;
    f32a: ArrayBuffer;
    f32v: Float32Array;
    f32b: Uint8Array;
    ent: Uint32Array;
}

function ctxCreate(): CodecCtx {
    const f32a = new ArrayBuffer(4);
    return {
        buf: new Uint8Array(8192), off: 0,
        f32a, f32v: new Float32Array(f32a), f32b: new Uint8Array(f32a),
        ent: new Uint32Array(256),
    };
}

// payload writer: instance-scoped, grows by doubling.
let _ctx: CodecCtx = ctxCreate();

function payloadReset(): void { _ctx.off = 0; }
function payloadResult(): Uint8Array { return _ctx.buf.subarray(0, _ctx.off); }

function payloadEnsure(n: number): void {
    if (_ctx.off + n > _ctx.buf.length) {
        const next = new Uint8Array(Math.max(_ctx.buf.length * 2, _ctx.off + n));
        next.set(_ctx.buf);
        _ctx.buf = next;
    }
}

function payloadByte(v: number): void {
    payloadEnsure(1);
    _ctx.buf[_ctx.off++] = v;
}

function payloadU32(v: number): void {
    payloadEnsure(4);
    _ctx.buf[_ctx.off++] = v & 0xFF;
    _ctx.buf[_ctx.off++] = (v >>> 8) & 0xFF;
    _ctx.buf[_ctx.off++] = (v >>> 16) & 0xFF;
    _ctx.buf[_ctx.off++] = (v >>> 24) & 0xFF;
}

function payloadF32(v: number): void {
    _ctx.f32v[0] = v;
    payloadEnsure(4);
    _ctx.buf.set(_ctx.f32b, _ctx.off);
    _ctx.off += 4;
}

function payloadAppend(data: Uint8Array): void {
    payloadEnsure(data.length);
    _ctx.buf.set(data, _ctx.off);
    _ctx.off += data.length;
}

function readU32LE(data: Uint8Array, off: number): number {
    return (data[off] | (data[off+1]<<8) | (data[off+2]<<16) | (data[off+3]<<24)) >>> 0;
}
function readF32LE(data: Uint8Array, off: number): number {
    const b = new ArrayBuffer(4); const u = new Uint8Array(b);
    u[0]=data[off]; u[1]=data[off+1]; u[2]=data[off+2]; u[3]=data[off+3];
    return new Float32Array(b)[0];
}


// â”€â”€ public encode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// wire format:
//   header (12 B, cleartext):
//     numSamples:u32  sampleRate:u32  flags:u16  numCh:u8  numLevels:u8
//     flags: quality(bits 15..8) | depth(bits 6..5) | layout(bits 4..3)
//            | compressed(0x01)
//     layout: 00=channel, 01=object-based
//     depth:  00=float32, 01=16-bit, 10=24-bit, 11=reserved
//   encrypted payload (ChaCha20):
//     framePeak:f32  scalar:u32
//     if layout == object:
//       for each channel: azimuth:f32 elevation:f32 distance:f32
//     for each channel: refIndex:u8 (0xFF = independent)
//     envelopeMask: ceil(numCh/8) bytes
//     effectiveChannels:u8
//     for each effective channel:
//       if envelopeMask bit set:
//         envBlockLen:u32  envCount:u32  envWireLen:u32  envData
//       if coupled (refIndex != 0xFF):
//         active:u8  Wint_lo:u8  Wint_hi:u8
//       postFilterOrder:u8 (0 = off)
//       if postFilterOrder > 0:
//         [LP_lo:u8 LP_hi:u8] x order   (10-bit signed, +512 bias)
//       coeffOrigLen:u32  coeffCompLen:u32  coeffData
//       numSubbands:u8
//       for each subband:
//         sbLen:u32  planeCount:u8
//       globalMaxPlane:u8
//       for each active plane:
//         compLen:u32  planeData             (Logos-encoded concatenated bytes)
//   mac0:u32  mac1:u32                       (SipHash-lite 64-bit over ciphertext)

export interface HarmonicOptions {
    /** quantization quality 1-100. default 80. 100 = raw float32. */
    quality?: number;
    /** number of interleaved channels. default 1. */
    numChannels?: number;
    /** source bit depth: 16 or 24. overrides quality with the minimum
     *  scalar needed to preserve all source bits. omit for float32 sources. */
    bitDepth?: number;
    /** channel layout: "channel" (default) or "object". when "object",
     *  provide spatialObjects with per-channel 3D positions. */
    layout?: "channel" | "object";
    /** per-channel spatial positions for object-based audio.
     *  length must equal numChannels. ignored when layout != "object". */
    spatialObjects?: SpatialObject[];
}

function prepareHarmonicChannels(
    wasm: HarmonicWasmExports,
    samples: Float32Array,
    sampleRate: number,
    numChannels: number,
    numSamples: number,
    scalar: number,
    framePeak: number,
    targetScalar: number,
    effectiveBitDepth: number,
    numLevels: number,
    layout: "channel" | "object",
    hhThresh: number = 0,
): {
    channels: Int32Array[];
    channelEnergy: number[];
    channelEnvelopes: (Int16Array | null)[];
    channelEnvelopeBlockLens: number[];
    channelEnvelopeWire: (Uint8Array | null)[];
    couplingRefs: number[];
    effectiveChannels: number;
    totalObjective: number;
} {
    const invPeak = scalar / framePeak;
    const shapeNoise = effectiveBitDepth === 0 && scalar > 1;
    let nsK = 0, nsG = 0;
    if (shapeNoise) {
        const V_BODY = 353;
        const L_CANAL = 0.026;
        const f1 = V_BODY / (4 * L_CANAL);
        const omega0 = 2 * Math.PI * f1 / sampleRate;
        const cosW = Math.cos(omega0);
        const absCosW = cosW < 0 ? -cosW : cosW;
        const r = -absCosW + Math.sqrt(absCosW * absCosW + 2);
        nsK = 2 * r * cosW;
        nsG = r * r;
    }

    const baselineChannels: Int32Array[] = [];
    const baselineEnergy: number[] = [];
    const channels: Int32Array[] = [];
    const channelEnergy: number[] = [];
    const channelEnvelopes: (Int16Array | null)[] = [];
    const channelEnvelopeBlockLens: number[] = [];
    const channelEnvelopeWire: (Uint8Array | null)[] = [];
    const channelProjected: (Float32Array | null)[] = [];
    const amplitudeBaselineFitBits: number[] = [];
    const amplitudeCandidates: AmplitudeCandidate[][] = [];
    const varBlockLen = computeBlockLen(sampleRate);
    const burgSuperLen = adaptiveBurgSuperLen(sampleRate, varBlockLen);
    const envelopeBlockLen = envelopeBlockLenFromBurgSuperLen(burgSuperLen, varBlockLen);
    const varMaxOrder = computeMaxOrder(varBlockLen);
    for (let ch = 0; ch < numChannels; ch++) {
        const baseline = quantizeChannelWithOrbitalGuide(
            wasm,
            samples,
            ch,
            numChannels,
            numSamples,
            invPeak,
            shapeNoise,
            nsK,
            nsG,
            numLevels,
            scalar,
            varBlockLen,
            varMaxOrder,
            effectiveBitDepth > 0,
        );
        baselineChannels.push(baseline.data);
        baselineEnergy.push(baseline.energy);
        channels.push(baseline.data);
        channelEnergy.push(baseline.energy);
        channelEnvelopes.push(null);
        channelEnvelopeBlockLens.push(0);
        channelEnvelopeWire.push(null);
        channelProjected.push(null);
        const amplitudeAxis = shapeNoise && numSamples >= envelopeBlockLen * 2
            ? quantizeChannelWithAmplitudeAxis(
                    wasm,
                    samples,
                    ch,
                    numChannels,
                    numSamples,
                    framePeak,
                    scalar,
                    envelopeBlockLen,
                    baseline.data,
                    shapeNoise,
                    nsK,
                    nsG,
                    numLevels,
                    varBlockLen,
                    varMaxOrder,
                )
            : { candidates: [], baselineFitBits: 0 };
        amplitudeBaselineFitBits.push(amplitudeAxis.baselineFitBits);
        amplitudeCandidates.push(amplitudeAxis.candidates);
    }
    const effectiveChannels = numChannels;
    let couplingRefs: number[] = [];
    let totalObjective = 0;
    // 2 passes for multichannel coupling refinement (was 3; third pass adds
    // < 0.1% coupling improvement on real content while costing a full
    // scoreQuantizedChannel sweep per channel). mono always uses 1 pass.
    const axisPasses = layout !== "object" && numChannels > 1 ? 2 : 1;
    for (let pass = 0; pass < axisPasses; pass++) {
        totalObjective = 0;
        if (layout !== "object" && numChannels > 1 && numSamples >= varBlockLen) {
            couplingRefs = assignReferences(channels, numSamples, scalar);
        } else {
            couplingRefs = new Array(numChannels).fill(NO_REF);
        }

        for (let ch = 0; ch < numChannels; ch++) {
            const amplitudeSet = amplitudeCandidates[ch];
            const baselineData = baselineChannels[ch];
            channels[ch] = baselineData;
            channelEnergy[ch] = baselineEnergy[ch];
            channelEnvelopes[ch] = null;
            channelEnvelopeBlockLens[ch] = 0;
            channelEnvelopeWire[ch] = null;

            const refIdx = couplingRefs[ch] ?? NO_REF;
            const refData = refIdx !== NO_REF ? channels[refIdx] : undefined;
            const refProjected = refIdx !== NO_REF ? channelProjected[refIdx] ?? undefined : undefined;


            const baselineScore = scoreQuantizedChannel(
                wasm,
                baselineData,
                samples,
                ch,
                numChannels,
                scalar,
                framePeak,
                targetScalar,
                null,
                numLevels,
                refData,
                refProjected,
                0,
                varBlockLen,
                varMaxOrder,
                hhThresh,
            );

            let bestObjective = baselineScore.objective + amplitudeBaselineFitBits[ch];
            let bestProjected = baselineScore.projectedCarrier;
            let bestAmplitude: AmplitudeCandidate | null = null;
            for (const amplitude of amplitudeSet) {
                const amplitudeScore = scoreQuantizedChannel(
                    wasm,
                    amplitude.data,
                    samples,
                    ch,
                    numChannels,
                    scalar,
                    framePeak,
                    targetScalar,
                    amplitude.envCurve,
                    numLevels,
                    refData,
                    refProjected,
                    amplitude.extraBits,
                    varBlockLen,
                    varMaxOrder,
                    hhThresh,
                );
                const amplitudeObjective = amplitudeScore.objective + amplitude.fitBits;
                if (amplitudeObjective < bestObjective) {
                    bestObjective = amplitudeObjective;
                    bestAmplitude = amplitude;
                    bestProjected = amplitudeScore.projectedCarrier;
                }
            }

            if (bestAmplitude) {
                channels[ch] = bestAmplitude.data;
                channelEnergy[ch] = bestAmplitude.energy;
                channelEnvelopes[ch] = bestAmplitude.envLog;
                channelEnvelopeBlockLens[ch] = bestAmplitude.envBlockLen;
                channelEnvelopeWire[ch] = bestAmplitude.envWire;
            }
            channelProjected[ch] = bestProjected;
            totalObjective += bestObjective;
        }
    }

    if (layout !== "object" && numChannels > 1 && numSamples >= varBlockLen) {
        couplingRefs = assignReferences(channels, numSamples, scalar);
    }

    return {
        channels,
        channelEnergy,
        channelEnvelopes,
        channelEnvelopeBlockLens,
        channelEnvelopeWire,
        couplingRefs,
        effectiveChannels,
        totalObjective,
    };
}

// ── harmonic long-term prediction ──────────────────────────────────
// exploits the fundamental periodicity (pitch) of harmonic signals.
// the short-term AR predictor (order ≤ 16) captures formant structure
// and local oscillations but cannot reach pitch periods (typically
// 100-500 samples at 48kHz = 2-10ms). the long-term predictor removes
// the periodic component first, leaving a flatter residual for Burg.
//
// physics: a vibrating string/vocal cord produces a periodic waveform
// with period T = 1/f0. the optimal 1-tap predictor is x'[n] = β·x[n-T]
// where β = R(T)/R(0) is the autocorrelation-derived gain. this is
// exactly the Green's function of the damped wave equation evaluated
// at the resonant frequency — the codec's namesake.
//
// 3-tap fractional-delay attempted and rejected: for pure sines, the
// 3x3 LS system at adjacent lags is near-singular (all taps sample
// the same phase). the clamped gains after quantization produce worse
// predictions than the simple 1-tap. the Burg AR predictor already
// handles the slowly-varying fractional-period drift after 1-tap.

const PITCH_MIN_PERIOD = 20;  // ~2400 Hz at 48kHz (upper limit of pitch)
const PITCH_MAX_PERIOD = 600; // ~80 Hz at 48kHz (lower limit of pitch)

/** estimate pitch period and gain from autocorrelation.
 *  returns period=0 if no strong periodicity detected. */
function estimatePitch(
    data: Int32Array, n: number, sr: number,
): { period: number; gain: number } {
    // adapt search range to sample rate. target 80Hz-2400Hz.
    const minP = Math.max(PITCH_MIN_PERIOD, Math.round(sr / 2400));
    const maxP = Math.min(PITCH_MAX_PERIOD, Math.round(sr / 80), n >> 1);
    if (maxP <= minP || n < maxP * 2) return { period: 0, gain: 0 };

    // compute R(0)
    let r0 = 0;
    for (let i = 0; i < n; i++) r0 += data[i] * data[i];
    if (r0 === 0) return { period: 0, gain: 0 };

    // coarse search: step by 2, find the lag with highest normalized correlation
    let bestLag = 0;
    let bestCorr = 0;
    for (let lag = minP; lag <= maxP; lag += 2) {
        let sum = 0;
        for (let i = lag; i < n; i++) sum += data[i] * data[i - lag];
        const corr = sum / r0;
        if (corr > bestCorr) {
            bestCorr = corr;
            bestLag = lag;
        }
    }

    // fine search: check lag-1, lag, lag+1
    if (bestLag > 0) {
        for (let delta = -1; delta <= 1; delta++) {
            const lag = bestLag + delta;
            if (lag < minP || lag > maxP) continue;
            let sum = 0;
            for (let i = lag; i < n; i++) sum += data[i] * data[i - lag];
            const corr = sum / r0;
            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }
    }

    // require minimum correlation strength to activate
    if (bestCorr < 0.3 || bestLag === 0) return { period: 0, gain: 0 };

    // compute optimal gain β = R(T) / R(0) at the denominator lag
    let num = 0, den = 0;
    for (let i = bestLag; i < n; i++) {
        num += data[i] * data[i - bestLag];
        den += data[i - bestLag] * data[i - bestLag];
    }
    const gain = den > 0 ? num / den : 0;

    return { period: bestLag, gain: Math.max(-1, Math.min(1, gain)) };
}

/** quantize pitch period to 10 bits (0 = inactive, 1-1023 = period). */
function quantPitchPeriod(p: number): number {
    return Math.max(0, Math.min(1023, p));
}

/** quantize pitch gain to 8-bit signed (range -1.0 to +1.0, 127 steps). */
function quantPitchGain(g: number): number {
    return Math.max(-127, Math.min(127, Math.round(g * 127)));
}
function dequantPitchGain(q: number): number { return q / 127; }

/** apply pitch prediction (forward): remove periodic component.
 *  x'[n] = x[n] - round(β * x[n - T]) for n >= T. */
function pitchPredict(data: Int32Array, n: number, period: number, gain: number): Int32Array {
    const out = new Int32Array(n);
    for (let i = 0; i < period; i++) out[i] = data[i];
    for (let i = period; i < n; i++) {
        const pred = gain * data[i - period];
        out[i] = data[i] - (pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0);
    }
    return out;
}

/** inverse pitch prediction (decoder): restore periodic component.
 *  x[n] = x'[n] + round(β * x[n - T]) for n >= T. */
function pitchUnpredict(data: Int32Array, n: number, period: number, gain: number): Int32Array {
    const out = new Int32Array(n);
    for (let i = 0; i < period; i++) out[i] = data[i];
    for (let i = period; i < n; i++) {
        const pred = gain * out[i - period]; // use DECODED output, not input
        out[i] = data[i] + (pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0);
    }
    return out;
}

/** lossless mid/side stereo transform for 2-channel content.
 *  side = L - R, mid = L - (side >> 1). perfectly reversible. */
function msEncode(L: Int32Array, R: Int32Array, n: number): { mid: Int32Array; side: Int32Array } {
    const side = new Int32Array(n);
    const mid = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        side[i] = L[i] - R[i];
        mid[i] = L[i] - (side[i] >> 1);
    }
    return { mid, side };
}

function msDecode(mid: Int32Array, side: Int32Array, n: number): { L: Int32Array; R: Int32Array } {
    const L = new Int32Array(n);
    const R = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        L[i] = mid[i] + (side[i] >> 1);
        R[i] = L[i] - side[i];
    }
    return { L, R };
}

/** compute the optimal decorrelation angle from the 2x2 covariance matrix.
 *  the eigenvectors of [[var_L, cov_LR], [cov_LR, var_R]] give the KLT
 *  rotation that maximally concentrates energy into one channel.
 *  returns the lifting parameter alpha = -tan(theta/2). */
function optimalStereoAlpha(L: Int32Array, R: Int32Array, n: number): number {
    let varL = 0, varR = 0, covLR = 0;
    for (let i = 0; i < n; i++) {
        varL += L[i] * L[i];
        varR += R[i] * R[i];
        covLR += L[i] * R[i];
    }
    // eigenvector direction: theta_e = 0.5 * atan2(2*cov, varL - varR)
    // to project onto the principal eigenvector, apply R(-theta_e).
    // the Givens lifting implements R(theta) with alpha = -tan(theta/2).
    // for R(-theta_e): alpha = -tan(-theta_e/2) = tan(theta_e/2).
    const diff = varL - varR;
    const cross = 2 * covLR;
    const thetaE = 0.5 * Math.atan2(cross, diff);
    return Math.max(-0.99, Math.min(0.99, Math.tan(thetaE * 0.5)));
}

/** lossless integer Givens rotation via three lifting shears.
 *  factorizes the 2D rotation matrix R(theta) into:
 *    [[1, alpha], [0, 1]] · [[1, 0], [beta, 1]] · [[1, alpha], [0, 1]]
 *  where alpha = -tan(theta/2), beta = sin(theta) = -2*alpha/(1+alpha^2).
 *  each shear step is perfectly reversible with integer rounding. */
function givensEncode(
    L: Int32Array, R: Int32Array, n: number, alpha: number,
): { ch0: Int32Array; ch1: Int32Array } {
    const beta = -2 * alpha / (1 + alpha * alpha);
    const ch0 = new Int32Array(n);
    const ch1 = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        // step 1: shear L by alpha * R
        let a = L[i] + Math.round(alpha * R[i]);
        // step 2: shear R by beta * a
        const b = R[i] + Math.round(beta * a);
        // step 3: shear a by alpha * b
        a = a + Math.round(alpha * b);
        ch0[i] = a;
        ch1[i] = b;
    }
    return { ch0, ch1 };
}

function givensDecode(
    ch0: Int32Array, ch1: Int32Array, n: number, alpha: number,
): { L: Int32Array; R: Int32Array } {
    const beta = -2 * alpha / (1 + alpha * alpha);
    const L = new Int32Array(n);
    const R = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        // undo step 3
        let a = ch0[i] - Math.round(alpha * ch1[i]);
        // undo step 2
        const r = ch1[i] - Math.round(beta * a);
        // undo step 1
        const l = a - Math.round(alpha * r);
        L[i] = l;
        R[i] = r;
    }
    return { L, R };
}

/** quantize alpha to 10 bits (±511 like reflection coefficients). */
function quantAlpha(a: number): number {
    return Math.max(-RC_SCALE, Math.min(RC_SCALE, Math.round(a * RC_SCALE)));
}

function dequantAlpha(q: number): number {
    return q / RC_SCALE;
}

export async function encodeHarmonic(
    float32Samples: Float32Array | Float32Array[],
    sampleRate: number,
    encryptionKey?: Uint32Array,
    options?: HarmonicOptions,
): Promise<Uint8Array> {
    // accept planar input (Float32Array[] from Web Audio AudioBuffer.getChannelData())
    // or interleaved input (single Float32Array). planar is converted to interleaved
    // in-place â€” zero copy for mono, one pass for multichannel.
    let samples: Float32Array;
    let inferredChannels: number;
    if (Array.isArray(float32Samples)) {
        // planar: each element is one channel's samples
        inferredChannels = float32Samples.length;
        const perCh = float32Samples[0].length;
        const interleaved = new Float32Array(perCh * inferredChannels);
        for (let i = 0; i < perCh; i++) {
            for (let ch = 0; ch < inferredChannels; ch++) {
                interleaved[i * inferredChannels + ch] = float32Samples[ch][i];
            }
        }
        samples = interleaved;
    } else {
        samples = float32Samples;
        inferredChannels = 0; // use options.numChannels
    }

    const quality     = options?.quality      ?? 80;
    const numChannels = inferredChannels || (options?.numChannels ?? 1);
    const numSamples  = (samples.length / numChannels) | 0;
    const bitDepth    = options?.bitDepth     ?? 0;
    const layout      = options?.layout       ?? "channel";
    const spatialObjs = options?.spatialObjects;

    if (samples.length % numChannels !== 0) {
        throw new Error(`harmonic: sample count ${samples.length} not divisible by ${numChannels} channels`);
    }

    if (quality >= 100 && bitDepth === 0) {
        return encodeRawMode(samples, numSamples, sampleRate, numChannels, encryptionKey);
    }

    // bit depth is explicit only. when the caller passes bitDepth: 16 or 24,
    // the codec forces the scalar high enough for bit-exact lossless and sets
    // framePeak = 1.0 (no peak normalization). when bitDepth is not set, Q
    // controls the scalar â€” no auto-detection, no magic, no surprises.
    //
    // the previous auto-detect feature (scanning samples for integer alignment)
    // was removed because it caused a real bug: live mic input from a 16-bit
    // ADC produces float32 values that are exact multiples of 1/32768. the
    // auto-detect triggered lossless mode on every mic recording, ignoring
    // the user's Q choice. file sizes were identical regardless of Q.
    //
    // for WAV file import: detect bit depth from the WAV header and pass
    // bitDepth explicitly. for live mic: pass only quality.
    const effectiveBitDepth = bitDepth;

    // scalar controls quantization precision. the IIR-2 oscillator with
    // near-unit-circle poles requires LOSSLESS integer residuals â€” proven
    // 2026-03-29 and confirmed by studying G.726, QOA, CELT, aptX: every
    // codec with IIR prediction either needs leak factors (degrading tonal
    // capture) or avoids lossy residuals entirely. Harmonic keeps lossless
    // residuals because the IIR-2 IS the core advantage.
    //
    // the Q parameter maps to scalar (quantization levels per peak amplitude).
    // scalar = floor(2^(Q/100 Ã— 15)). the prediction pipeline is lossless
    // on these integers. quality loss is ONLY in the initial floatâ†’int step.
    const qScalar = qualityToScalar(quality);
    const depthScalar = scalarForBitDepth(effectiveBitDepth);

    // sample-rate-adaptive wavelet levels
    const numLevels = adaptiveWaveletLevels(sampleRate, numSamples);

    // sample-rate-adaptive block length and max prediction order
    const blockLen = computeBlockLen(sampleRate);
    const maxOrder = computeMaxOrder(blockLen);

    // peak normalization. when bitDepth is set, fix peak=1.0 â€” the scalar
    // is already sized for the source's integer range, and skipping peak
    // normalization makes the quantization bit-exact for integer sources:
    //   qi = round(intSample / 2^(bd-1) * 2^(bd-1)) = intSample (exact)
    const wasm = await getHarmonicWasm();
    const scalarCandidates = effectiveBitDepth > 0
        ? [depthScalar]
        : qualityScalarCandidates(quality);
    const targetScalar = Math.max(qScalar, depthScalar);
    let scalar = Math.max(qScalar, depthScalar);
    let framePeak = effectiveBitDepth > 0 ? 1.0 : lossyFramePeak(samples, scalar);
    let prepared = prepareHarmonicChannels(
        wasm, samples, sampleRate, numChannels, numSamples,
        scalar, framePeak, targetScalar, effectiveBitDepth, numLevels, layout,
        subbandThreshold(scalar, effectiveBitDepth),
    );
    const seenScalars = new Set<number>([scalar]);
    for (const cand of scalarCandidates) {
        const candidateScalar = Math.max(cand, depthScalar);
        if (seenScalars.has(candidateScalar)) continue;
        seenScalars.add(candidateScalar);
        const candidatePeak = effectiveBitDepth > 0 ? 1.0 : lossyFramePeak(samples, candidateScalar);
        const candidatePrepared = prepareHarmonicChannels(
            wasm, samples, sampleRate, numChannels, numSamples,
            candidateScalar, candidatePeak, targetScalar, effectiveBitDepth, numLevels, layout,
            subbandThreshold(candidateScalar, effectiveBitDepth),
        );
        if (candidatePrepared.totalObjective < prepared.totalObjective) {
            scalar = candidateScalar;
            framePeak = candidatePeak;
            prepared = candidatePrepared;
        }
    }
    const hhThresh = subbandThreshold(scalar, effectiveBitDepth);
    const channels = prepared.channels;
    const channelEnergy = prepared.channelEnergy;
    const channelEnvelopes = prepared.channelEnvelopes;
    const channelEnvelopeBlockLens = prepared.channelEnvelopeBlockLens;
    const channelEnvelopeWire = prepared.channelEnvelopeWire;
    const effectiveChannels = prepared.effectiveChannels;
    let couplingRefs = prepared.couplingRefs;

    // stereo decorrelation: trial L/R, M/S, and Givens rotation.
    // the Givens rotation generalizes M/S to any angle via three lifting
    // shears, finding the optimal decorrelation direction from the 2x2
    // covariance matrix (KLT eigenvectors). lossless: each shear is
    // perfectly reversible with integer rounding.
    let msActive = false;
    let givensActive = false;
    let givensAlphaQ = 0;
    if (numChannels === 2 && layout !== "object" && numSamples >= blockLen) {
        // stereo decorrelation trial: compare L/R, M/S, and Givens rotation.
        // uses Shannon (estimatePlaneCost) for the comparison. full Logos
        // encoding only happens in the final per-channel encode loop below.
        // Shannon ranking matches Logos ranking for stereo decorrelation
        // decisions in practice and eliminates 6 full Logos encodes.
        const blocksL = varOrderFitAllBlocks(channels[0], numSamples, blockLen, maxOrder);
        const residL = varOrderPredictEnc(channels[0], numSamples, blocksL, blockLen, maxOrder);
        const costL = estimatePlaneCost(residL) + estimateCoeffBits(blocksL) / 8;

        const blocksR = varOrderFitAllBlocks(channels[1], numSamples, blockLen, maxOrder);
        const residR = varOrderPredictEnc(channels[1], numSamples, blocksR, blockLen, maxOrder);
        const costR = estimatePlaneCost(residR) + estimateCoeffBits(blocksR) / 8;

        let bestCostPair = costL + costR;

        // M/S trial
        const { mid, side } = msEncode(channels[0], channels[1], numSamples);
        const blocksM = varOrderFitAllBlocks(mid, numSamples, blockLen, maxOrder);
        const residM = varOrderPredictEnc(mid, numSamples, blocksM, blockLen, maxOrder);
        const costM = estimatePlaneCost(residM) + estimateCoeffBits(blocksM) / 8;

        const blocksS = varOrderFitAllBlocks(side, numSamples, blockLen, maxOrder);
        const residS = varOrderPredictEnc(side, numSamples, blocksS, blockLen, maxOrder);
        const costS = estimatePlaneCost(residS) + estimateCoeffBits(blocksS) / 8;

        if (costM + costS < bestCostPair) {
            bestCostPair = costM + costS;
            msActive = true;
            givensActive = false;
        }

        // Givens rotation trial: optimal decorrelation angle from covariance
        const rawAlpha = optimalStereoAlpha(channels[0], channels[1], numSamples);
        const qAlpha = quantAlpha(rawAlpha);
        // only trial Givens when the angle differs meaningfully from 0 and pi/4.
        // the M/S angle corresponds to alpha ~= -0.4142, quantized to ~-211.
        // skip if alpha is near 0 (no rotation) or near M/S (already tried).
        const msAlphaQ = quantAlpha(-Math.tan(Math.PI / 8));
        if (qAlpha !== 0 && Math.abs(qAlpha - msAlphaQ) > 10) {
            const dqAlpha = dequantAlpha(qAlpha);
            const { ch0: g0, ch1: g1 } = givensEncode(channels[0], channels[1], numSamples, dqAlpha);

            const blocksG0 = varOrderFitAllBlocks(g0, numSamples, blockLen, maxOrder);
            const residG0 = varOrderPredictEnc(g0, numSamples, blocksG0, blockLen, maxOrder);
            const costG0 = estimatePlaneCost(residG0) + estimateCoeffBits(blocksG0) / 8;

            const blocksG1 = varOrderFitAllBlocks(g1, numSamples, blockLen, maxOrder);
            const residG1 = varOrderPredictEnc(g1, numSamples, blocksG1, blockLen, maxOrder);
            const costG1 = estimatePlaneCost(residG1) + estimateCoeffBits(blocksG1) / 8;

            // +2 bytes overhead for the quantized alpha
            if (costG0 + costG1 + 2 < bestCostPair) {
                bestCostPair = costG0 + costG1 + 2;
                msActive = false;
                givensActive = true;
                givensAlphaQ = qAlpha;
                channels[0] = g0;
                channels[1] = g1;
            }
        }

        if (msActive) {
            channels[0] = mid;
            channels[1] = side;
            // M/S makes coupling redundant
            couplingRefs = [NO_REF, NO_REF];
        } else if (givensActive) {
            // Givens also makes coupling redundant
            couplingRefs = [NO_REF, NO_REF];
        }
    }

    payloadReset();
    payloadF32(framePeak);
    // store the actual scalar used. u32 to cover the full range including
    // 24-bit mode (scalar=8388608). the decoder reads this directly â€”
    // no formula inversion needed.
    payloadU32(scalar);

    // Givens rotation alpha: 10-bit quantized, stored as 2 bytes (signed + 512)
    if (givensActive) {
        const v = givensAlphaQ + RC_BIAS;
        payloadByte(v & 0xFF);
        payloadByte((v >> 8) & 0xFF);
    }

    // write spatial metadata for object-based layout (always written when object,
    // even without explicit positions, so encoder/decoder stay in sync)
    if (layout === "object") {
        for (let ch = 0; ch < numChannels; ch++) {
            const obj = spatialObjs?.[ch] ?? { azimuth: 0, elevation: 0, distance: 1 };
            payloadF32(obj.azimuth);
            payloadF32(obj.elevation);
            payloadF32(obj.distance);
        }
    }

    // coupling ref indices are written AFTER the per-channel loop because
    // the trial gate may reject coupling (changing refIndex to NO_REF).
    // placeholder: remember the payload offset for the ref indices.
    const couplingRefPayloadOff = _ctx.off;
    for (let ch = 0; ch < numChannels; ch++) payloadByte(NO_REF); // placeholder
    const envelopeMaskLen = Math.ceil(numChannels / 8);
    for (let i = 0; i < envelopeMaskLen; i++) {
        let maskByte = 0;
        for (let bit = 0; bit < 8; bit++) {
            const ch = i * 8 + bit;
            if (ch < numChannels && channelEnvelopes[ch]) maskByte |= 1 << bit;
        }
        payloadByte(maskByte);
    }

    payloadByte(effectiveChannels);

    for (let ch = 0; ch < effectiveChannels; ch++) {
        let data = channels[ch];
        const envLog = channelEnvelopes[ch];
        const envWire = channelEnvelopeWire[ch];

        // per-channel adaptive block length: try halved, standard, and doubled
        // blockLen, pick the cheapest. cache the winning Burg fit for reuse
        // in coupling and pitch trials (eliminates 2-3 redundant fits).
        let chBlockLen = blockLen;
        let chMaxOrder = maxOrder;
        let cachedBlocks: VarBlock[] | null = null;
        let cachedResid: Int32Array | null = null;
        if (numSamples >= blockLen * 2) {
            const blocks1 = varOrderFitAllBlocks(data, numSamples, blockLen, maxOrder);
            const resid1 = varOrderPredictEnc(data, numSamples, blocks1, blockLen, maxOrder);
            let bestCost = estimatePlaneCost(resid1) + estimateCoeffBits(blocks1) / 8;
            cachedBlocks = blocks1;
            cachedResid = resid1;
            // try doubled
            const blDouble = Math.min(blockLen * 2, 1024);
            if (blDouble !== blockLen) {
                const moDouble = computeMaxOrder(blDouble);
                const blocks2 = varOrderFitAllBlocks(data, numSamples, blDouble, moDouble);
                const resid2 = varOrderPredictEnc(data, numSamples, blocks2, blDouble, moDouble);
                const cost2 = estimatePlaneCost(resid2) + estimateCoeffBits(blocks2) / 8;
                if (cost2 + 1 < bestCost) {
                    bestCost = cost2;
                    chBlockLen = blDouble;
                    chMaxOrder = moDouble;
                    cachedBlocks = blocks2;
                    cachedResid = resid2;
                }
            }
            // try halved
            const blHalf = Math.max(blockLen >> 1, 8);
            if (blHalf !== blockLen) {
                const moHalf = computeMaxOrder(blHalf);
                const blocksH = varOrderFitAllBlocks(data, numSamples, blHalf, moHalf);
                const residH = varOrderPredictEnc(data, numSamples, blocksH, blHalf, moHalf);
                const costH = estimatePlaneCost(residH) + estimateCoeffBits(blocksH) / 8;
                if (costH + 1 < bestCost) {
                    chBlockLen = blHalf;
                    chMaxOrder = moHalf;
                    cachedBlocks = blocksH;
                    cachedResid = residH;
                }
            }
        }
        // wire: blockLen exponent (0=8, 1=16, 2=32, 3=64, 4=128, 5=256, 6=512, 7=1024)
        payloadByte(Math.round(Math.log2(chBlockLen)) - 3);

        // cross-channel coupling: subtract W·ref, trial-gated via varOrder cost
        const refIdx = couplingRefs[ch] ?? NO_REF;
        const refData = refIdx !== NO_REF ? channels[refIdx] : undefined;
        let channelW: { Wint: number; W: number } | undefined;
        if (refData && numSamples >= chBlockLen) {
            const wFit = fitCouplingW(data, refData, numSamples);
            if (Math.abs(wFit.W) > 0.01) {
                const decoupled = new Int32Array(numSamples);
                for (let i = 0; i < numSamples; i++) {
                    const wr = wFit.W * refData[i];
                    decoupled[i] = data[i] - (wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0);
                }
                // reuse cached Burg blocks for orig if available (same data, same blockLen)
                const blocksOrig = cachedBlocks ?? varOrderFitAllBlocks(data, numSamples, chBlockLen, chMaxOrder);
                const residOrig = cachedResid ?? varOrderPredictEnc(data, numSamples, blocksOrig, chBlockLen, chMaxOrder);
                const blocksDec = varOrderFitAllBlocks(decoupled, numSamples, chBlockLen, chMaxOrder);
                const residDec = varOrderPredictEnc(decoupled, numSamples, blocksDec, chBlockLen, chMaxOrder);
                const costOrig = estimatePlaneCost(residOrig) + estimateCoeffBits(blocksOrig) / 8;
                const costDec = estimatePlaneCost(residDec) + estimateCoeffBits(blocksDec) / 8;
                if (costDec + 2 < costOrig) {
                    data = decoupled;
                    channelW = wFit;
                    // invalidate cache — data changed
                    cachedBlocks = null;
                    cachedResid = null;
                } else {
                    couplingRefs[ch] = NO_REF;
                }
            } else {
                couplingRefs[ch] = NO_REF;
            }
        }

        // envelope (amplitude axis)
        if (envLog && envWire) {
            payloadU32(channelEnvelopeBlockLens[ch] || 0);
            payloadU32(envLog.length);
            payloadU32(envWire.length);
            payloadAppend(envWire);
        }

        // coupling W
        if ((couplingRefs[ch] ?? NO_REF) !== NO_REF) {
            if (channelW) {
                payloadByte(1);
                payloadByte(channelW.Wint & 0xFF);
                payloadByte((channelW.Wint >> 8) & 0xFF);
            } else {
                payloadByte(0);
            }
        }

        // harmonic long-term prediction: remove pitch periodicity before Burg.
        // trial-gated: only activate if the full pipeline (pitch → Burg → wavelet → Logos)
        // is cheaper than Burg alone. caches Burg results from the trial to avoid
        // redundant computation in the main encoding path.
        let pitchPeriodQ = 0;
        let pitchGainQ = 0;
        let cachedVarBlocks: VarBlock[] | null = null;
        let cachedResiduals: Int32Array | null = null;
        if (numSamples >= PITCH_MIN_PERIOD * 4) {
            const { period, gain } = estimatePitch(data, numSamples, sampleRate);
            if (period > 0 && Math.abs(gain) > 0.3) {
                // skip the expensive pipeline trial for weak pitch (gain < 0.3).
                // weak pitch means the autocorrelation peak is low and the pitch
                // predictor won't save enough to justify 2 extra Burg fits.
                const pQ = quantPitchPeriod(period);
                const gQ = quantPitchGain(gain);
                if (pQ > 0 && gQ !== 0) {
                    const dqGain = dequantPitchGain(gQ);
                    const pitched = pitchPredict(data, numSamples, pQ, dqGain);
                    // full pipeline cost comparison (Burg → wavelet → Logos)
                    // reuse cached Burg blocks for orig if available
                    // Shannon-gated pitch comparison. bypass wavelet trial and
                    // Logos encode entirely since the relative cost comparison is
                    // accurate enough to decide whether pitch prediction helps.
                    const blocksOrig = cachedBlocks ?? varOrderFitAllBlocks(data, numSamples, chBlockLen, chMaxOrder);
                    const residOrig = cachedResid ?? varOrderPredictEnc(data, numSamples, blocksOrig, chBlockLen, chMaxOrder);
                    const costOrig = estimatePlaneCost(residOrig) + estimateCoeffBits(blocksOrig) / 8;
                    const blocksPitch = varOrderFitAllBlocks(pitched, numSamples, chBlockLen, chMaxOrder);
                    const residPitch = varOrderPredictEnc(pitched, numSamples, blocksPitch, chBlockLen, chMaxOrder);
                    const costPitch = estimatePlaneCost(residPitch) + estimateCoeffBits(blocksPitch) / 8 + 4;
                    if (costPitch < costOrig) {
                        data = pitched;
                        pitchPeriodQ = pQ;
                        pitchGainQ = gQ;
                        cachedVarBlocks = blocksPitch;
                        cachedResiduals = residPitch;
                    } else {
                        cachedVarBlocks = blocksOrig;
                        cachedResiduals = residOrig;
                    }
                }
            }
        }
        // write pitch parameters: 1 byte flag, then conditionally 3 bytes
        if (pitchPeriodQ > 0) {
            payloadByte(1);
            payloadByte(pitchPeriodQ & 0xFF);
            payloadByte((pitchPeriodQ >> 8) & 0xFF);
            payloadByte((pitchGainQ + 128) & 0xFF);
        } else {
            payloadByte(0);
        }

        // unified variable-order prediction (reuse cached results from pitch trial)
        const varBlocks = cachedVarBlocks ?? varOrderFitAllBlocks(data, numSamples, chBlockLen, chMaxOrder);
        let residuals = cachedResiduals ?? varOrderPredictEnc(data, numSamples, varBlocks, chBlockLen, chMaxOrder);

        // global post-filter: sparse Yule-Walker on Burg residuals.
        // tries single-lag and multi-lag candidates, picks the cheapest.
        // uses Shannon-based estimatePlaneCost for fast candidate screening.
        // previously used trialLogosSize (full Logos encode per candidate)
        // which was the dominant cost of the post-filter trial. Shannon is
        // accurate enough for relative comparisons between filter candidates.
        const costNoFilter = estimatePlaneCost(residuals);

        let bestPostOrder = 0;
        let bestPostQuantLP: Int16Array | null = null;
        let bestPostResiduals = residuals;
        let bestCost = costNoFilter;

        const postCandidates = generatePostFilterCandidates(residuals, numSamples, scalar, chBlockLen);
        for (const cand of postCandidates) {
            const filtered = applyPostFilterEnc(residuals, numSamples, cand.order, cand.quantLP);
            const costAfter = estimatePlaneCost(filtered) + 1 + cand.order * 2;
            if (costAfter < bestCost) {
                bestCost = costAfter;
                bestPostOrder = cand.order;
                bestPostQuantLP = cand.quantLP;
                bestPostResiduals = filtered;
            }
        }

        residuals = bestPostResiduals;
        if (bestPostOrder > 0) {
            payloadByte(bestPostOrder);
            for (let m = 0; m < bestPostOrder; m++) {
                const v = bestPostQuantLP![m] + RC_BIAS;
                payloadByte(v & 0xFF);
                payloadByte((v >> 8) & 0xFF);
            }
        } else {
            payloadByte(0); // no post-filter
        }

        // coefficient stream
        const { raw: coeffRaw, compressed: coeffComp } = encodeCoeffStream(varBlocks);
        payloadU32(coeffRaw.length);
        payloadU32(coeffComp.length);
        payloadAppend(coeffComp);

        // wavelet vs bypass: Logos-accurate level selection. the Shannon estimator
        // is well-calibrated for broadband signals (chirp, speech) but miscalibrates
        // for high-precision narrowband signals: lossless 24-bit improved 25.7%
        // (3340→2480B) and harmonic Q95 improved 15.2% (1452→1232B) by using
        // actual Logos encoding cost instead of Shannon entropy for level selection.
        // costs ~4 extra Logos calls per channel (~5% encode time) but this is
        // the final path where the decision directly determines output bytes.
        const subbands = scoreSubbandPathAccurate(wasm, residuals, numLevels, hhThresh);

        // cached baseline cost for subband transform trials (MERA, connection, packet).
        // invalidated (-1) whenever subbands are modified, recomputed lazily.
        let sbBaseCost = -1;

        // MERA disentangler: Givens rotation between LL and deepest HH subband.
        // multi-scale entanglement renormalization ansatz (MERA) insight: wavelet
        // subbands at adjacent scales share magnitude correlation (e.g. edges
        // produce large coefficients in both LL and HH simultaneously). a Givens
        // rotation disentangles this correlation, concentrating energy into one
        // subband and making both more compressible. this is the "disentangler"
        // layer of the MERA tensor network, operating between renormalization
        // (wavelet) layers. trial-gated: only applied when Logos cost decreases.
        let meraAlphaQ = 0;
        let meraActive = false;
        if (subbands.length >= 2) {
            const sb0 = subbands[0], sb1 = subbands[1];
            const minLen = Math.min(sb0.length, sb1.length);
            if (minLen >= 4) {
                const rawAlpha = optimalStereoAlpha(sb0, sb1, minLen);
                const qAlpha = quantAlpha(rawAlpha);
                if (qAlpha !== 0) {
                    const dqAlpha = dequantAlpha(qAlpha);
                    const { ch0, ch1 } = givensEncode(sb0, sb1, minLen, dqAlpha);
                    // build trial subbands with rotated LL and HH
                    const trialSb: Int32Array[] = subbands.slice();
                    const rot0 = new Int32Array(sb0.length);
                    rot0.set(ch0.subarray(0, minLen));
                    if (sb0.length > minLen) rot0[minLen] = sb0[minLen];
                    const rot1 = new Int32Array(sb1.length);
                    rot1.set(ch1.subarray(0, minLen));
                    if (sb1.length > minLen) rot1[minLen] = sb1[minLen];
                    trialSb[0] = rot0;
                    trialSb[1] = rot1;
                    if (sbBaseCost < 0) sbBaseCost = estimateSubbandsCost(subbands);
                    const costMera = estimateSubbandsCost(trialSb) + 3; // 1 flag + 2 alpha
                    if (costMera < sbBaseCost) {
                        subbands[0] = rot0;
                        subbands[1] = rot1;
                        meraAlphaQ = qAlpha;
                        meraActive = true;
                        sbBaseCost = -1; // invalidate: subbands changed
                    }
                }
            }
        }
        payloadByte(meraActive ? 1 : 0);
        if (meraActive) {
            const v = meraAlphaQ + RC_BIAS;
            payloadByte(v & 0xFF);
            payloadByte((v >> 8) & 0xFF);
        }

        // cross-scale connection prediction: the CDF 5/3 lifting scheme is a
        // discrete connection on a fiber bundle. LL is the base space, HH is the
        // fiber. the LL derivative (local slope) predicts HH coefficient magnitude
        // at transient locations where the bundle has curvature. this is the local
        // version of what the MERA disentangler does globally. the prediction
        // exploits the fact that singularities (transients, onsets) create large
        // coefficients in both LL and HH at the same position.
        let connectionAlphaQ = 0;
        let connectionActive = false;
        if (subbands.length >= 2) {
            const ll = subbands[0], hh = subbands[1];
            const minLen = Math.min(ll.length - 1, hh.length);
            if (minLen >= 4) {
                // compute LL derivative and cross-correlate with deepest HH
                let covDH = 0, varD = 0;
                for (let i = 0; i < minLen; i++) {
                    const d = ll[i + 1] - ll[i]; // connection form: local LL slope
                    covDH += d * hh[i];
                    varD += d * d;
                }
                if (varD > 0) {
                    const rawAlpha = covDH / varD;
                    const qAlpha = quantAlpha(rawAlpha);
                    if (qAlpha !== 0) {
                        const dqAlpha = dequantAlpha(qAlpha);
                        // trial: predict HH from LL derivative, see if residual is cheaper
                        const trialHH = new Int32Array(hh.length);
                        for (let i = 0; i < minLen; i++) {
                            const d = ll[i + 1] - ll[i];
                            const pred = dqAlpha * d;
                            trialHH[i] = hh[i] - (pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0);
                        }
                        // copy any trailing samples unchanged
                        for (let i = minLen; i < hh.length; i++) trialHH[i] = hh[i];
                        const trialSb = subbands.slice();
                        trialSb[1] = trialHH;
                        if (sbBaseCost < 0) sbBaseCost = estimateSubbandsCost(subbands);
                        const costConn = estimateSubbandsCost(trialSb) + 3; // 1 flag + 2 alpha
                        if (costConn < sbBaseCost) {
                            subbands[1] = trialHH;
                            connectionAlphaQ = qAlpha;
                            connectionActive = true;
                            sbBaseCost = -1; // invalidate: subbands changed
                        }
                    }
                }
            }
        }
        payloadByte(connectionActive ? 1 : 0);
        if (connectionActive) {
            const v = connectionAlphaQ + RC_BIAS;
            payloadByte(v & 0xFF);
            payloadByte((v >> 8) & 0xFF);
        }

        // wavelet packet split: try one extra decomposition level on the
        // shallowest HH subband (HH1, the largest). this is the Coifman-
        // Wickerhauser best-basis idea reduced to a single 1-bit decision:
        // if splitting HH1 into two sub-subbands reduces Logos cost, do it.
        // post-Burg residuals often retain spectral color that the standard
        // dyadic wavelet tree doesn't fully exploit.
        let packetSplit = false;
        if (subbands.length >= 2) {
            const lastIdx = subbands.length - 1;
            const hh1 = subbands[lastIdx];
            if (hh1.length >= 4) {
                const splitSb = waveletDecompose(wasm, hh1, 1);
                if (splitSb.length === 2) {
                    const trialSb = subbands.slice(0, lastIdx);
                    trialSb.push(splitSb[0], splitSb[1]);
                    if (sbBaseCost < 0) sbBaseCost = estimateSubbandsCost(subbands);
                    const costSplit = estimateSubbandsCost(trialSb) + 1; // 1 flag byte
                    if (costSplit < sbBaseCost) {
                        subbands[lastIdx] = splitSb[0];
                        subbands.push(splitSb[1]);
                        packetSplit = true;
                    }
                }
            }
        }
        payloadByte(packetSplit ? 1 : 0);

        // subband encoding: zigzag + byte planes + batched Logos
        const numSb = subbands.length;
        payloadByte(numSb);

        const sbPlaneCount: number[] = [];
        let globalMaxPlane = 0;
        for (let sb = 0; sb < numSb; sb++) {
            const isLL = sb === 0;
            let energy = 0;
            const d = subbands[sb];
            for (let i = 0; i < d.length; i++) energy += d[i] * d[i];
            const noiseFloor = d.length * QUANT_NOISE_REG;
            if (!isLL && energy <= noiseFloor) {
                sbPlaneCount.push(0);
            } else {
                let maxZZ = 0;
                for (let i = 0; i < d.length; i++) {
                    const v = d[i];
                    const zz = ((v >> 31) ^ (v << 1)) >>> 0;
                    if (zz > maxZZ) maxZZ = zz;
                }
                const pc = planeCount(maxZZ);
                sbPlaneCount.push(pc);
                if (pc > globalMaxPlane) globalMaxPlane = pc;
            }
        }

        // write subband headers
        for (let sb = 0; sb < numSb; sb++) {
            payloadU32(subbands[sb].length);
            payloadByte(sbPlaneCount[sb]);
        }
        payloadByte(globalMaxPlane);

        // build concatenated plane streams and encode each with one Logos call.
        // only include subbands that actually have data at this plane level:
        // a subband with planeCount=1 has no high-byte data, so including it
        // in plane 1 would just feed zeros to Logos (wasting context bandwidth).
        for (let plane = 0; plane < globalMaxPlane; plane++) {
            let totalBytes = 0;
            for (let sb = 0; sb < numSb; sb++) {
                if (sbPlaneCount[sb] > plane) totalBytes += subbands[sb].length;
            }
            const concat = new Uint8Array(totalBytes);
            let off = 0;
            for (let sb = 0; sb < numSb; sb++) {
                if (sbPlaneCount[sb] <= plane) continue;
                const d = subbands[sb];
                const shift = plane * 8;
                for (let i = 0; i < d.length; i++) {
                    const v = d[i];
                    const zz = ((v >> 31) ^ (v << 1)) >>> 0;
                    concat[off++] = (zz >>> shift) & 0xFF;
                }
            }
            // stride=4: post-V-axis re-tune. originally stride=2 (lag-2 spatial
            // context complementing O2 at lag-1), but the var-order Burg fits
            // typically absorb lag-2 byte structure during the AR prediction stage.
            // a stride sweep on real Q=50/80/95 residuals after the V axis was
            // added showed stride=4 consistently wins by a small margin (0.06% at
            // Q80, 0.10% at Q95) vs stride=2; strides 0/1/8/16/...512 all hurt.
            // hypothesis: var-order Burg leaves more lag-4 residual structure than
            // lag-2 because the AR coefficients fit lower lags first.
            const encoded = encode0D(concat.subarray(0, off), 4);
            payloadU32(encoded.length);
            payloadAppend(encoded);
        }
    }

    // patch the coupling ref indices now that trials are complete
    for (let ch = 0; ch < numChannels; ch++) {
        _ctx.buf[couplingRefPayloadOff + ch] = couplingRefs[ch] ?? NO_REF;
    }

    // Encrypt
    const key = encryptionKey && encryptionKey.length >= 4
        ? new Uint32Array([encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]])
        : new Uint32Array([0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED]);
    const { encrypted, mac0, mac1 } = encryptPayload(new Uint8Array(payloadResult()), key);

    // Assemble output
    const out = new Uint8Array(HEADER_SIZE + encrypted.length + MAC_SIZE);
    const ov  = new DataView(out.buffer);
    ov.setUint32(0, numSamples, true);
    ov.setUint32(4, sampleRate, true);
    const layoutFlag = layout === "object" ? LAYOUT_OBJECT : LAYOUT_CHANNEL;
    const depthFlag  = effectiveBitDepth === 16 ? DEPTH_16 : effectiveBitDepth === 24 ? DEPTH_24 : DEPTH_F32;
    const msFlag = msActive ? MS_ACTIVE : 0;
    const givensFlag = givensActive ? GIVENS_ACTIVE : 0;
    ov.setUint16(8, ((quality & 0xFF) << 8) | 1 | layoutFlag | depthFlag | msFlag | givensFlag, true);
    out[10] = numChannels - 1; out[11] = numLevels; // numChannels stored as 0-based (0=1ch, 255=256ch)

    out.set(encrypted, HEADER_SIZE);
    const macOff = HEADER_SIZE + encrypted.length;
    ov.setUint32(macOff,     mac0, true);
    ov.setUint32(macOff + 4, mac1, true);

    return out;
}

// â”€â”€ public decode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function decodeHarmonic(
    encoded: Uint8Array,
    encryptionKey?: Uint32Array,
): Promise<{
    pcm: Float32Array; sampleRate: number; tampered: boolean;
    spatialObjects?: SpatialObject[];
}> {
    if (encoded.length < HEADER_SIZE + MAC_SIZE) {
        throw new Error("harmonic: payload too short");
    }

    const hdr = new DataView(encoded.buffer, encoded.byteOffset, HEADER_SIZE);
    const numSamples  = hdr.getUint32(0, true);
    const sampleRate  = hdr.getUint32(4, true) || 48000;
    const flags       = hdr.getUint16(8, true);
    const isRaw       = (flags & 1) === 0;
    const quality     = (flags >> 8) & 0xFF;
    const numChannels = (encoded[10] + 1); // 0-based: 0=1ch, 255=256ch
    const numLevels   = encoded[11] || 0;
    const layoutFlag  = flags & LAYOUT_MASK;
    const isObject    = layoutFlag === LAYOUT_OBJECT;
    const bitDepth    = depthFromFlags(flags);
    const isMidSide   = (flags & MS_ACTIVE) !== 0;
    const isGivens    = (flags & GIVENS_ACTIVE) !== 0;

    if (isRaw) {
        return decodeRawMode(encoded, numSamples, sampleRate, numChannels, encryptionKey);
    }

    // sample-rate-adaptive block length and max prediction order
    const blockLen = computeBlockLen(sampleRate);
    const maxOrder = computeMaxOrder(blockLen);

    const key = encryptionKey && encryptionKey.length >= 4
        ? new Uint32Array([encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]])
        : new Uint32Array([0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED]);

    const payloadEnd = encoded.length - MAC_SIZE;
    const { decrypted, mac0, mac1 } = decryptPayload(encoded.subarray(HEADER_SIZE, payloadEnd), key);

    const expMac0 = readU32LE(encoded, payloadEnd);
    const expMac1 = readU32LE(encoded, payloadEnd + 4);
    if (mac0 !== expMac0 || mac1 !== expMac1) {
        return { pcm: new Float32Array(0), sampleRate, tampered: true };
    }

    const wasm = await getHarmonicWasm();
    const allChannelData: Int32Array[] = [];
    const allChannelProjected: (Float32Array | null)[] = [];
    const allChannelEnvelopes: (Float32Array | null)[] = [];
    const decCouplingW: Record<number, number> = {};
    let off = 0;
    const p = decrypted;

    const framePeak = readF32LE(p, off); off += 4; // authenticated: inside MAC scope
    const scalar = readU32LE(p, off) || 1; off += 4; // actual scalar used by encoder

    // Givens rotation alpha (10-bit quantized, 2 bytes)
    let givensAlpha = 0;
    if (isGivens) {
        const lo = p[off]; const hi = p[off + 1]; off += 2;
        givensAlpha = dequantAlpha(((hi << 8) | lo) - RC_BIAS);
    }

    // read spatial metadata for object-based layout
    let spatialObjects: SpatialObject[] | undefined;
    if (isObject) {
        spatialObjects = [];
        for (let ch = 0; ch < numChannels; ch++) {
            spatialObjects.push({
                azimuth:   readF32LE(p, off), elevation: readF32LE(p, off + 4),
                distance:  readF32LE(p, off + 8),
            });
            off += 12;
        }
    }

    // read cross-channel coupling metadata
    const decCouplingRefs: number[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
        decCouplingRefs.push(p[off++]);
    }
    const envelopeMask = p.subarray(off, off + Math.ceil(numChannels / 8));
    off += envelopeMask.length;
    // read effective channel count
    const effectiveChannels = p[off++];

    for (let ch = 0; ch < effectiveChannels; ch++) {
        // per-channel adaptive block length
        const chBlockLenExponent = p[off++];
        const chBlockLen = 8 << chBlockLenExponent;
        const chMaxOrder = computeMaxOrder(chBlockLen);

        let envCurve: Float32Array | null = null;
        const hasEnvelope = ((envelopeMask[ch >> 3] >> (ch & 7)) & 1) !== 0;
        if (hasEnvelope) {
            const envBlockLen = readU32LE(p, off); off += 4;
            const envCount = readU32LE(p, off); off += 4;
            const envWireLen = readU32LE(p, off); off += 4;
            const envLog = decodeEnvelopeTrajectory(wasm, p.subarray(off, off + envWireLen), envCount); off += envWireLen;
            envCurve = reconstructEnvelopeCurve(envLog, numSamples, Math.max(chBlockLen, envBlockLen), framePeak);
        }

        // coupling W
        const chRefIdx = decCouplingRefs[ch] ?? NO_REF;
        let signalCouplingActive = false;
        if (chRefIdx !== NO_REF) {
            signalCouplingActive = p[off++] === 1;
            if (signalCouplingActive) {
                const Wint = (p[off] | (p[off + 1] << 8)) << 16 >> 16;
                off += 2;
                decCouplingW[ch] = Wint / W_SCALE;
            }
        }

        // decode pitch prediction params
        const pitchActive = p[off++] === 1;
        let pitchPeriod = 0;
        let pitchGain = 0;
        if (pitchActive) {
            pitchPeriod = p[off] | (p[off + 1] << 8); off += 2;
            pitchGain = dequantPitchGain(p[off++] - 128);
        }

        // decode post-filter params (10-bit LP coefficients, 2 bytes each)
        const postFilterOrder = p[off++];
        const postFilterQuantLP = new Int16Array(postFilterOrder);
        for (let m = 0; m < postFilterOrder; m++) {
            const lo = p[off++];
            const hi = p[off++];
            postFilterQuantLP[m] = ((hi << 8) | lo) - RC_BIAS;
        }

        // decode coefficient stream
        const numBlocks = Math.ceil(numSamples / chBlockLen);
        const coeffOrigLen = readU32LE(p, off); off += 4;
        const coeffCompLen = readU32LE(p, off); off += 4;
        const coeffRaw = decode0D(p.subarray(off, off + coeffCompLen), coeffOrigLen); off += coeffCompLen;
        const varBlocks = decodeCoeffStream(coeffRaw, numBlocks);

        // MERA disentangler params
        const meraFlag = p[off++];
        let meraAlpha = 0;
        if (meraFlag === 1) {
            const lo = p[off++];
            const hi = p[off++];
            meraAlpha = dequantAlpha(((hi << 8) | lo) - RC_BIAS);
        }

        // cross-scale connection prediction params
        const connectionFlag = p[off++];
        let connectionAlpha = 0;
        if (connectionFlag === 1) {
            const lo = p[off++];
            const hi = p[off++];
            connectionAlpha = dequantAlpha(((hi << 8) | lo) - RC_BIAS);
        }

        // wavelet packet split flag
        const packetSplitFlag = p[off++];

        // decode subbands (batched plane streams)
        const numSubbands = p[off++];
        const sbLens: number[] = [];
        const sbPlanes: number[] = [];
        for (let sb = 0; sb < numSubbands; sb++) {
            sbLens.push(readU32LE(p, off)); off += 4;
            sbPlanes.push(p[off++]);
        }
        const globalMaxPlane = p[off++];

        const planeData: Uint8Array[] = [];
        for (let plane = 0; plane < globalMaxPlane; plane++) {
            let totalBytes = 0;
            for (let sb = 0; sb < numSubbands; sb++) {
                if (sbPlanes[sb] > plane) totalBytes += sbLens[sb];
            }
            const compLen = readU32LE(p, off); off += 4;
            planeData.push(decode0D(p.subarray(off, off + compLen), totalBytes, 2));
            off += compLen;
        }

        // reconstruct subbands from plane slices. each plane only contains
        // subbands where sbPlanes[sb] > plane, so per-plane offsets track
        // independently.
        const subbands: Int32Array[] = [];
        const planeOffs = new Array(globalMaxPlane).fill(0);
        for (let sb = 0; sb < numSubbands; sb++) {
            const n = sbLens[sb];
            const pc = sbPlanes[sb];
            if (pc === 0) {
                subbands.push(new Int32Array(n));
                continue;
            }
            const out = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                let zz = 0;
                for (let plane = 0; plane < pc; plane++) {
                    zz |= planeData[plane][planeOffs[plane] + i] << (plane * 8);
                }
                out[i] = zigzagDec(zz >>> 0);
            }
            for (let plane = 0; plane < pc; plane++) {
                planeOffs[plane] += n;
            }
            subbands.push(out);
        }

        // wavelet packet unsplit: if HH1 was split, reconstruct it from last two subbands
        if (packetSplitFlag === 1 && subbands.length >= 3) {
            const hh1Parts = [subbands[subbands.length - 2], subbands[subbands.length - 1]];
            const hh1 = waveletReconstruct(wasm, hh1Parts);
            subbands.length -= 2;
            subbands.push(hh1);
        }

        // cross-scale connection inverse: add back LL-derivative prediction to HH
        if (connectionFlag === 1 && subbands.length >= 2) {
            const ll = subbands[0], hh = subbands[1];
            const minLen = Math.min(ll.length - 1, hh.length);
            for (let i = 0; i < minLen; i++) {
                const d = ll[i + 1] - ll[i];
                const pred = connectionAlpha * d;
                hh[i] += pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
            }
        }

        // MERA disentangler inverse: undo Givens rotation on LL and deepest HH
        if (meraFlag === 1 && subbands.length >= 2) {
            const sb0 = subbands[0], sb1 = subbands[1];
            const minLen = Math.min(sb0.length, sb1.length);
            const { L, R } = givensDecode(sb0, sb1, minLen, meraAlpha);
            for (let i = 0; i < minLen; i++) { sb0[i] = L[i]; sb1[i] = R[i]; }
        }

        // wavelet reconstruct -> post-filter inverse -> varOrder prediction inverse
        let waveletResiduals = waveletReconstruct(wasm, subbands);
        if (postFilterOrder > 0) {
            waveletResiduals = applyPostFilterDec(waveletResiduals, numSamples, postFilterOrder, postFilterQuantLP);
        }
        let reconstructed = varOrderPredictDec(waveletResiduals, numSamples, varBlocks, chBlockLen, chMaxOrder);

        // pitch prediction inverse: restore periodic component
        if (pitchActive && pitchPeriod > 0) {
            reconstructed = pitchUnpredict(reconstructed, numSamples, pitchPeriod, pitchGain);
        }

        // signal-level coupling inverse: add W·ref_data back
        if (signalCouplingActive && decCouplingW[ch] !== undefined) {
            const W = decCouplingW[ch];
            const refData = allChannelData[chRefIdx];
            if (refData) {
                for (let i = 0; i < numSamples; i++) {
                    const wr = W * refData[i];
                    reconstructed[i] += wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0;
                }
            }
        }

        allChannelData.push(reconstructed);
        let projected: Float32Array | null = null;
        if (bitDepth === 0 && scalar > 1) {
            projected = Float32Array.from(reconstructed);
            sanitizeProjectionToCell(projected, reconstructed);
            varOrderCellProject(projected, reconstructed, varBlocks, chBlockLen, chMaxOrder);
            sanitizeProjectionToCell(projected, reconstructed);
            if (signalCouplingActive && decCouplingW[ch] !== undefined) {
                const refProjected = allChannelProjected[chRefIdx];
                const refData = allChannelData[chRefIdx];
                if (refProjected && refData) {
                    couplingCellProject(projected, reconstructed, refProjected, refData, decCouplingW[ch]);
                    sanitizeProjectionToCell(projected, reconstructed);
                }
            }
            fractalCellProject(projected, reconstructed, numLevels);
            sanitizeProjectionToCell(projected, reconstructed);
        }
        allChannelProjected.push(projected);
        allChannelEnvelopes.push(envCurve);
    }

    // stereo inverse: convert rotated channels back to L/R
    if (isGivens && numChannels === 2 && allChannelData.length >= 2) {
        // Givens inverse rotation
        const { L, R } = givensDecode(allChannelData[0], allChannelData[1], numSamples, givensAlpha);
        allChannelData[0] = L;
        allChannelData[1] = R;
        if (allChannelProjected[0] && allChannelProjected[1]) {
            // approximate inverse for projected (float) arrays
            const beta = -2 * givensAlpha / (1 + givensAlpha * givensAlpha);
            const p0 = allChannelProjected[0]!;
            const p1 = allChannelProjected[1]!;
            const pL = new Float32Array(numSamples);
            const pR = new Float32Array(numSamples);
            for (let i = 0; i < numSamples; i++) {
                let a = p0[i] - givensAlpha * p1[i];
                const r = p1[i] - beta * a;
                pL[i] = a - givensAlpha * r;
                pR[i] = r;
            }
            allChannelProjected[0] = pL;
            allChannelProjected[1] = pR;
        }
    } else if (isMidSide && numChannels === 2 && allChannelData.length >= 2) {
        const { L, R } = msDecode(allChannelData[0], allChannelData[1], numSamples);
        allChannelData[0] = L;
        allChannelData[1] = R;
        if (allChannelProjected[0] && allChannelProjected[1]) {
            const projMid = allChannelProjected[0]!;
            const projSide = allChannelProjected[1]!;
            const projL = new Float32Array(numSamples);
            const projR = new Float32Array(numSamples);
            for (let i = 0; i < numSamples; i++) {
                projL[i] = projMid[i] + (projSide[i] / 2);
                projR[i] = projL[i] - projSide[i];
            }
            allChannelProjected[0] = projL;
            allChannelProjected[1] = projR;
        }
    }

    // dequantize to float32 interleaved output
    const invScalar = framePeak / scalar;
    const pcm = new Float32Array(numSamples * numChannels);
    for (let ch = 0; ch < numChannels; ch++) {
        const d = allChannelData[ch];
        const projected = allChannelProjected[ch];
        const envCurve = allChannelEnvelopes[ch];
        for (let i = 0; i < numSamples; i++) {
            const gain = envCurve ? (envCurve[i] / scalar) : invScalar;
            pcm[i * numChannels + ch] = (projected ? projected[i] : d[i]) * gain;
        }
    }

    return { pcm, sampleRate, tampered: false, spatialObjects };
}

// â”€â”€ raw passthrough (Q=100) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function encodeRawMode(
    float32Samples: Float32Array, numSamples: number, sampleRate: number,
    numChannels: number, encryptionKey?: Uint32Array,
): Uint8Array {
    const key = encryptionKey && encryptionKey.length >= 4
        ? new Uint32Array([encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]])
        : new Uint32Array([0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED]);

    const dataBytes = numSamples * numChannels * 4;
    const out = new Uint8Array(HEADER_SIZE + dataBytes + MAC_SIZE);
    const ov  = new DataView(out.buffer);
    ov.setUint32(0, numSamples, true); ov.setUint32(4, sampleRate, true);
    ov.setUint16(8, 0, true); // flags bit0=0 â†’ raw
    out[10] = numChannels - 1; out[11] = 0;

    const sampleBytes = new Uint8Array(float32Samples.buffer, float32Samples.byteOffset, dataBytes);
    out.set(sampleBytes, HEADER_SIZE);

    const cs = cryptoInit(key);
    for (let i = 0; i < dataBytes >> 2; i++) {
        const addr   = HEADER_SIZE + i * 4;
        const cipher = (ov.getUint32(addr, true) ^ cryptoNextWord(cs)) >>> 0;
        ov.setUint32(addr, cipher, true);
        cryptoMacUpdate(cs, cipher);
    }
    ov.setUint32(HEADER_SIZE + dataBytes, cs.mac0, true);
    ov.setUint32(HEADER_SIZE + dataBytes + 4, cs.mac1, true);
    return out;
}

function decodeRawMode(
    encoded: Uint8Array, numSamples: number, sampleRate: number,
    numChannels: number, encryptionKey?: Uint32Array,
): { pcm: Float32Array; sampleRate: number; tampered: boolean } {
    const key = encryptionKey && encryptionKey.length >= 4
        ? new Uint32Array([encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]])
        : new Uint32Array([0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED]);

    const dataBytes = encoded.length - HEADER_SIZE - MAC_SIZE;
    const buf  = new Uint8Array(dataBytes); buf.set(encoded.subarray(HEADER_SIZE, HEADER_SIZE + dataBytes));
    const bv   = new DataView(buf.buffer);
    const cs   = cryptoInit(key);

    for (let i = 0; i < dataBytes >> 2; i++) {
        const cipher = bv.getUint32(i * 4, true);
        cryptoMacUpdate(cs, cipher);
        bv.setUint32(i * 4, (cipher ^ cryptoNextWord(cs)) >>> 0, true);
    }

    const expMac0 = readU32LE(encoded, HEADER_SIZE + dataBytes);
    const expMac1 = readU32LE(encoded, HEADER_SIZE + dataBytes + 4);
    if (cs.mac0 !== expMac0 || cs.mac1 !== expMac1) {
        return { pcm: new Float32Array(0), sampleRate, tampered: true };
    }

    const pcm = new Float32Array(buf.buffer, 0, numSamples * numChannels);
    return { pcm: pcm.slice(), sampleRate, tampered: false };
}
