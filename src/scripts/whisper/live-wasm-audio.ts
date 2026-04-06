/**
 * live-wasm-audio.ts - Whisper Harmonic Audio Codec (Woflo / MB)
 *
 * waveform-accurate audio codec. it trades bitrate against lattice precision,
 * not against the waveform itself. supports N-channel surround, object-based
 * spatial audio, variable source bit depth, and any sample rate the f32/i32
 * predictor geometry can represent safely.
 *
 * the prediction hierarchy integrates structure from coarse to fine:
 *
 *   1. peak normalization + scalar quantization (float32 -> int32)
 *   2. cross-channel coupling W on the channel axis
 *   3. Burg adaptive-order LPC on 256-sample super-blocks
 *   4. AR(2) damped oscillator prediction on 32-sample blocks
 *   5. optional micro-oscillator on the residual
 *   6. optional delta whitening
 *   7. trajectory prediction in delay-embedding space
 *   8. harmonic topology on voiced content
 *   9. CDF 5/3 wavelet decomposition
 *  10. guarded subband masking
 *  11. Logos entropy coding for residual planes and trajectories
 *  12. ChaCha20 stream cipher + SipHash-lite MAC
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
 * current measured position on this branch:
 *   synthetic 48 kHz mono speech
 *     q10  130.6 kbps   24.5 dB
 *     q20  166.8 kbps   33.4 dB
 *     q40  183.1 kbps   48.8 dB
 *     q80  232.0 kbps   80.5 dB
 *     q95  256.4 kbps   92.8 dB
 *
 *   cached 15 s mono real-audio clip
 *     Harmonic Q60   251 kbps   37.5 dB
 *     Harmonic Q70   313 kbps   45.6 dB
 *     Harmonic Q80   366 kbps   53.7 dB
 *     Harmonic Q90   426 kbps   61.8 dB
 *     Vorbis 192k    193 kbps   34.2 dB
 *     MP3 320k       321 kbps   27.3 dB
 *     FLAC           675 kbps   inf dB
 *
 * lossless modes:
 *   bitDepth=16 and bitDepth=24 remain exact. q=100 is raw float32 passthrough.
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
const WASM_STATE_STRIDE = 0x10;
function wasmEncState(ch: number): number { return ch * WASM_STATE_STRIDE; }
function wasmDecState(ch: number): number { return 0x1000 + ch * WASM_STATE_STRIDE; }

// K/G inspection buffer: fit_all_blocks writes Int32 [Kint, Gint] pairs here.
// also used by writeKGToWasmSync for test inspection.
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
const QUALITY_BITS_MAX = 15;

// 32 samples @ 48kHz = 0.67ms = half-period at 750Hz.
// this is the highest frequency where the regression window spans a full
// half-cycle, giving the Cramer LS enough phase diversity to resolve K and G.
export const BLOCK_LEN = 32;

// dead-zone: suppress K/G jitter â‰¤ 2 steps = 2Ïƒ of quantization noise.
// (quantization step = 1/COEFF_SCALE; RMS noise = step/âˆš12 â‰ˆ 0.29 steps; 2Ïƒ â‰ˆ 2 steps.)
// both encoder and decoder use the committed (dead-zoned) values for prediction.
const DEAD_K = 2;
const DEAD_G = 2;

const HEADER_SIZE = 12;  // numSamples:u32 + sampleRate:u32 + flags:u16 + numCh:u8 + numLevels:u8
const MAC_SIZE    = 8;   // SipHash-lite 64-bit MAC (mac0:u32 + mac1:u32)

// harmonic topology: Goertzel extraction of voiced harmonics â†’ 2D MÃ¶bius field.
const MAX_HARMONICS = 24;       // harmonics 2..25 (covers formant range at any f0)
const VOICED_GAIN_DB = 3.0;     // minimum prediction gain for voiced (signal > 2Ã— residual)
const VOICED_CEILING_DB = 40.0;  // above 40 dB: AR(2) captured everything, no harmonics left
const HARMONIC_FLAG = 0x02;      // bit 1 of header flags

// channel layout (flags bits 4-3):
//   00 = channel (auto: mono, stereo M/S, or Hadamard for N>2)
//   01 = object-based (each channel = independent mono object + 3D position)
const LAYOUT_MASK  = 0x18;       // bits 4-3

function qualityToScalarIdeal(quality: number): number {
    const q01 = Math.max(0, Math.min(1, quality / 100));
    const bits = QUALITY_BITS_MAX * Math.pow(q01, 0.9);
    return Math.pow(2, bits);
}

function qualityScalarCandidates(quality: number): number[] {
    const lattice: number[] = [];
    for (let dq = -1; dq <= 1; dq++) {
        const ideal = qualityToScalarIdeal(Math.max(0, Math.min(100, quality + dq)));
        lattice.push(
            Math.max(1, Math.floor(ideal)),
            Math.max(1, Math.round(ideal)),
            Math.max(1, Math.ceil(ideal)),
        );
    }
    const deduped = [...new Set(lattice)].sort((a, b) => a - b);
    const floorScalar = Math.max(1, Math.floor(qualityToScalarIdeal(quality)));
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

function envelopeBlockLenFromBurgSuperLen(burgSuperLen: number): number {
    const low = Math.max(BLOCK_LEN, 1);
    const high = Math.max(low, burgSuperLen);
    const logMid = 0.5 * (Math.log2(low) + Math.log2(high));
    const len = 1 << Math.round(logMid);
    return Math.max(low, Math.min(high, len));
}

function envelopeBlockLenCandidates(baseLen: number, numSamples: number): number[] {
    const candidates: number[] = [];
    for (let len = Math.max(BLOCK_LEN, baseLen); len * 2 <= numSamples; len <<= 1) {
        candidates.push(len);
    }
    return candidates.length > 0 ? candidates : [Math.max(BLOCK_LEN, Math.min(baseLen, numSamples))];
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
    wasm: HarmonicWasmExports,
    logEnv: Int16Array,
): Uint8Array {
    const levels = adaptiveEnvelopeLevels(logEnv.length);
    const envData = new Int32Array(logEnv.length);
    for (let i = 0; i < logEnv.length; i++) envData[i] = logEnv[i];
    const subbands = waveletDecompose(wasm, envData, levels);

    const sbPlaneCount: number[] = [];
    let globalMaxPlane = 0;
    for (let sb = 0; sb < subbands.length; sb++) {
        let maxZZ = 0;
        const d = subbands[sb];
        for (let i = 0; i < d.length; i++) {
            const v = d[i];
            const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
            if (zz > maxZZ) maxZZ = zz;
        }
        const pc = maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3;
        sbPlaneCount.push(pc);
        if (pc > globalMaxPlane) globalMaxPlane = pc;
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const push = (chunk: Uint8Array) => {
        chunks.push(chunk);
        total += chunk.length;
    };
    const pushByte = (v: number) => push(Uint8Array.of(v & 0xFF));
    const pushU32 = (v: number) => push(Uint8Array.of(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF));

    pushByte(levels);
    pushByte(globalMaxPlane);
    for (let sb = 0; sb < sbPlaneCount.length; sb++) pushByte(sbPlaneCount[sb]);

    for (let plane = 0; plane < globalMaxPlane; plane++) {
        let totalBytes = 0;
        for (let sb = 0; sb < subbands.length; sb++) totalBytes += subbands[sb].length;
        const concat = new Uint8Array(totalBytes);
        let off = 0;
        for (let sb = 0; sb < subbands.length; sb++) {
            const d = subbands[sb];
            const shift = plane * 8;
            for (let i = 0; i < d.length; i++) {
                const v = d[i];
                const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
                concat[off++] = (zz >>> shift) & 0xFF;
            }
        }
        const encoded = encode0D(concat);
        pushU32(encoded.length);
        push(encoded);
    }

    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
        out.set(chunk, off);
        off += chunk.length;
    }
    return out;
}

function decodeEnvelopeTrajectory(
    wasm: HarmonicWasmExports,
    wire: Uint8Array,
    count: number,
): Int16Array {
    if (count === 0) return new Int16Array(0);
    let off = 0;
    const levels = wire[off++] ?? 0;
    const globalMaxPlane = wire[off++] ?? 1;
    const subbandLens = waveletSubbandLengths(count, levels);
    const sbPlaneCount = new Uint8Array(subbandLens.length);
    for (let sb = 0; sb < sbPlaneCount.length; sb++) sbPlaneCount[sb] = wire[off++] ?? 1;

    const planeData: Uint8Array[] = [];
    for (let plane = 0; plane < globalMaxPlane; plane++) {
        const encLen = readU32LE(wire, off); off += 4;
        let totalBytes = 0;
        for (let sb = 0; sb < subbandLens.length; sb++) totalBytes += subbandLens[sb];
        planeData.push(decode0D(wire.subarray(off, off + encLen), totalBytes));
        off += encLen;
    }

    const subbands: Int32Array[] = [];
    let planeOff = 0;
    for (let sb = 0; sb < subbandLens.length; sb++) {
        const n = subbandLens[sb];
        const out = new Int32Array(n);
        if (globalMaxPlane === 1) {
            const lo = planeData[0];
            for (let i = 0; i < n; i++) out[i] = zigzagDec(lo[planeOff + i]);
        } else if (globalMaxPlane === 2) {
            const lo = planeData[0], mid = planeData[1];
            for (let i = 0; i < n; i++) out[i] = zigzagDec(((mid[planeOff + i] << 8) | lo[planeOff + i]) >>> 0);
        } else {
            const lo = planeData[0], mid = planeData[1], top = planeData[2];
            for (let i = 0; i < n; i++) {
                out[i] = zigzagDec(((top[planeOff + i] << 16) | (mid[planeOff + i] << 8) | lo[planeOff + i]) >>> 0);
            }
        }
        planeOff += n;
        subbands.push(out);
    }

    const recon = waveletReconstruct(wasm, subbands);
    const logEnv = new Int16Array(count);
    for (let i = 0; i < count; i++) {
        logEnv[i] = Math.max(-0x8000, Math.min(0x7FFF, recon[i] | 0));
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
    if (depth === 16) return 32768;   // 2^15
    if (depth === 24) return 8388608; // 2^23
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
// the coupling replaces Hadamard, M/S, and pairing trees with ONE
// mechanism that works for any channel count and adapts to the actual
// content. it's the 2D MÃ¶bius predictor collapsed onto the (channel Ã— time)
// plane: K/G for the time axis, W for the channel axis.
//
// per-channel payload: refIndex:u8 (0xFF = independent) + W trajectory
// (quantized i16, Rice-coded, Logos-compressed alongside K/G).

const NO_REF = 0xFF;
const W_SCALE = COEFF_SCALE; // same quantization as K/G

// find the best reference channel for each channel. returns an array of
// refIndex per channel (NO_REF for the anchor and uncorrelated channels).
// channels are ordered by decreasing total energy â€” the loudest channel
// is the anchor (encoded first, referenced by others).
function assignReferences(
    channels: Int32Array[], numSamples: number,
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

        if (bestCorr >= 0.3) refIndex[ch] = bestRef;
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

function adaptiveBurgSuperLen(sampleRate: number): number {
    // target: ~5.3ms (256 samples at 48kHz). must be multiple of BLOCK_LEN.
    const target = Math.round(sampleRate * 0.00533);
    const blocks = Math.max(4, Math.round(target / BLOCK_LEN));
    return blocks * BLOCK_LEN;
}

function adaptiveGoertzelLen(sampleRate: number): number {
    // target: ~21.3ms (1024 samples at 48kHz). must be multiple of BLOCK_LEN.
    const target = Math.round(sampleRate * 0.02133);
    const blocks = Math.max(8, Math.round(target / BLOCK_LEN));
    return blocks * BLOCK_LEN;
}

export function adaptiveWaveletLevels(sampleRate: number, numSamples: number): number {
    // target: LL subband at ~6kHz. levels = floor(log2(sr / 6000)).
    // clamped by minimum sample count (need 2^(levels+2) samples).
    const maxByRate = Math.max(1, Math.min(6, Math.floor(Math.log2(sampleRate / 6000))));
    let levels = maxByRate;
    while (levels > 0 && numSamples < (1 << (levels + 2))) levels--;
    return levels;
}

// prediction gain thresholds (in power ratio, not dB):
// AR2_SKIP_BURG: 30 dB = 10^3 â†’ residual < 0.1% of signal. above this,
// Burg's higher-order LP can't improve over AR(2) enough to justify its cost.
const AR2_SKIP_BURG = 1 - 1e-3;     // 0.999
// AR2_SKIP_MASKING: 15 dB = 10^1.5 â†’ residual < 3% of signal. above this,
// residuals are reconstruction-critical quantization noise â€” don't zero subbands.
const AR2_SKIP_MASKING = 1 - Math.pow(10, -1.5);  // ~0.968


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

/** backward-adaptive K/G fitting: derives K/G from PREVIOUS block's data.
 *  both encoder and decoder can compute identical K/G from the causal past,
 *  eliminating the K/G trajectory from the bitstream entirely.
 *
 *  for block N: fit K/G from samples [N*32 - 32 .. N*32 - 1].
 *  block 0 has no history â†’ K=0, G=COEFF_QUANT (no prediction).
 *
 *  the regression is the same 2Ã—2 Cramer LS as wasmFitAllBlocks, but on
 *  the lookback window. uses TypeScript (not WASM) because the window is
 *  only 32 samples â€” the overhead is negligible vs the WASM call cost. */
function fitBackwardKG(
    wasm: HarmonicWasmExports, data: Int32Array, numSamples: number,
): { K: number; G: number; Kint: number; Gint: number }[] {
    const numBlocks = Math.ceil(numSamples / BLOCK_LEN);
    const blocks: { K: number; G: number; Kint: number; Gint: number }[] = [];

    for (let b = 0; b < numBlocks; b++) {
        if (b === 0) {
            blocks.push({ K: 0, G: COEFF_QUANT, Kint: 0, Gint: 1 });
            continue;
        }
        // fit K/G from the PREVIOUS block's data using the WASM regression.
        // this guarantees bit-exact match with the decoder's K/G fitting.
        const lookback = data.subarray(b * BLOCK_LEN - BLOCK_LEN, b * BLOCK_LEN);
        const kgResult = wasmFitAllBlocks(wasm, lookback, BLOCK_LEN);
        if (kgResult.length > 0) {
            blocks.push(kgResult[0]);
        } else {
            blocks.push({ K: 0, G: COEFF_QUANT, Kint: 0, Gint: 1 });
        }
    }

    return blocks;
}

/** Q-adaptive trajectory thinning: at low Q, the coarsely quantized signal
 *  doesn't benefit from per-32-sample K/G updates. merge groups of N adjacent
 *  blocks to the K/G of the group's first block. this makes the trajectory
 *  delta-stream highly compressible (runs of zeros). the grouping factor
 *  scales inversely with scalar: low Q â†’ large groups â†’ fewer trajectory changes.
 *  at Q=80+ (scalar >= 4096), grouping=1 (no thinning). */
function thinTrajectory(
    blocks: { K: number; G: number; Kint: number; Gint: number }[],
    scalar: number,
): void {
    // smooth thinning: group size scales with 1/sqrt(scalar).
    // at scalar=4096 (Q=80): group=1. at scalar=64 (Q=40): group=4.
    // at scalar=8 (Q=20): group=11. eliminates bitrate stair-steps.
    const group = Math.max(1, Math.round(32 / Math.sqrt(scalar)));
    if (group <= 1) return;

    for (let i = 0; i < blocks.length; i += group) {
        const anchor = blocks[i];
        for (let j = 1; j < group && i + j < blocks.length; j++) {
            blocks[i + j].K = anchor.K;
            blocks[i + j].G = anchor.G;
            blocks[i + j].Kint = anchor.Kint;
            blocks[i + j].Gint = anchor.Gint;
        }
    }
}

/** free-energy proxy for choosing between integer lattices.
 *  the encoder already knows two things before entropy coding:
 *    1. the AR(2) residual rate surrogate
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
    wasm: HarmonicWasmExports,
    data: Int32Array,
    distortionEnergy: number,
    scalar: number,
): number {
    const n = data.length;
    if (n === 0) return 0;
    const kgBlocks = wasmFitAllBlocks(wasm, data, n);
    thinTrajectory(kgBlocks, scalar);
    const residuals = wasmPredictEnc(wasm, data, kgBlocks, wasmEncState(255));
    const rateBits = estimateRiceCost(residuals, n) + estimateTrajectoryBits(kgBlocks);
    const mse = Math.max(distortionEnergy / n, 1e-12);
    return rateBits + 0.5 * n * Math.log2(mse);
}

function stochasticWaveformPenaltyBits(
    mse: number,
    signal: number,
    n: number,
    targetScalar: number,
): number {
    if (n <= 0 || signal <= 1e-20) return 0;
    return (0.5 * n / Math.LN2) * (targetScalar * targetScalar * mse / signal);
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
function trellisQuantizeBlock(
    rawBlock: Float64Array,
    K: number, G: number, w: number,
    nsK: number, nsG: number, shapeNoise: boolean,
    initQ1: number, initQ2: number, initE1: number, initE2: number,
    backwardPrior?: Float64Array, backwardWeight: number = 0,
): QuantBeamState {
    const blockLen = rawBlock.length;
    let beam: QuantBeamState[] = [{
        cost: 0,
        q1: initQ1,
        q2: initQ2,
        e1: initE1,
        e2: initE2,
        seq: new Int32Array(blockLen),
    }];

    for (let t = 0; t < blockLen; t++) {
        const next: QuantBeamState[] = [];
        for (const state of beam) {
            const s = shapeNoise ? rawBlock[t] + nsK * state.e1 - nsG * state.e2 : rawBlock[t];
            const pred = K * state.q1 - G * state.q2;
            const hasBackward = backwardPrior && backwardWeight > 0;
            const predBack = hasBackward ? backwardPrior[t] : 0;
            const target = hasBackward
                ? (s + w * pred + backwardWeight * predBack) / (1 + w + backwardWeight)
                : (s + w * pred) / (1 + w);
            const center = clampToWaveformNeighborhood(quantizeToInt(target), s);

            for (let dc = -1; dc <= 1; dc++) {
                const qi = clampToWaveformNeighborhood(center + dc, s);
                const err = s - qi;
                const seq = state.seq.slice();
                seq[t] = qi;
                next.push({
                    cost: state.cost
                        + err * err
                        + w * (qi - pred) * (qi - pred)
                        + (hasBackward ? backwardWeight * (qi - predBack) * (qi - predBack) : 0),
                    q1: qi,
                    q2: state.q1,
                    e1: err,
                    e2: state.e1,
                    seq,
                });
            }
        }
        next.sort((a, b) => a.cost - b.cost);
        beam = next.slice(0, 4);
    }

    return beam[0];
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
        const wBase = obsVar > 0 ? Math.min(1, (1 / 8) / obsVar) : 1;
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

    const orbitalScore = quantizerFreeEnergy(wasm, orbital, orbitalDistEnergy, scalar);
    const fractalScore = quantizerFreeEnergy(wasm, q, fractalDistEnergy, scalar);
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
): { data: Int32Array; energy: number } {
    const rawScaled = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) rawScaled[i] = samples[i * numChannels + ch] * invPeak;
    return quantizeScaledWithOrbitalGuide(wasm, rawScaled, numLevels, scalar, shapeNoise, nsK, nsG);
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
    for (const blockLen of envelopeBlockLenCandidates(envBlockLen, numSamples)) {
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
            const quantized = quantizeScaledWithOrbitalGuide(wasm, carrierScaled, numLevels, scalar, shapeNoise, nsK, nsG);
            const envWire = encodeEnvelopeTrajectory(wasm, envLog);
            const extraBits = envWire.length * 8 + 96 + 1;
            const fitBits = envelopeResidualBits(rawEnvLog, envLog);
            candidates.push({ ...quantized, envBlockLen: blockLen, envLog, envCurve, envWire, extraBits, fitBits });
        }
    }
    return { candidates, baselineFitBits: Number.isFinite(baselineFitBits) ? baselineFitBits : 0 };
}

function cloneHarmonicState(state?: HarmonicState): HarmonicState | undefined {
    if (!state) return undefined;
    return {
        trajWindow: new Int32Array(state.trajWindow),
        trajFill: state.trajFill,
    };
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
            const blocksOrig = varOrderFitAllBlocks(working, n);
            const residOrig = varOrderPredictEnc(working, n, blocksOrig);
            const blocksDec = varOrderFitAllBlocks(decoupled, n);
            const residDec = varOrderPredictEnc(decoupled, n, blocksDec);
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
    const varBlocks = varOrderFitAllBlocks(working, n);
    const residuals = varOrderPredictEnc(working, n, varBlocks);

    // coefficient stream cost
    const { compressed: coeffComp } = encodeCoeffStream(varBlocks);
    rateBits += 64 + coeffComp.length * 8; // origLen + compLen + data

    // wavelet decomposition
    const subbands = waveletDecompose(wasm, residuals, numLevels);

    // subband masking + plane count
    rateBits += 8; // numSubbands
    const numSb = subbands.length;
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
                const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
                if (zz > maxZZ) maxZZ = zz;
            }
            const pc = maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3;
            sbPlaneCount.push(pc);
            if (pc > globalMaxPlane) globalMaxPlane = pc;
        }
        rateBits += 40; // sbLen + planeCount
    }
    rateBits += 8; // globalMaxPlane

    // entropy coding simulation (actual Logos encode for accurate cost)
    for (let plane = 0; plane < globalMaxPlane; plane++) {
        let totalBytes = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] > 0) totalBytes += subbands[sb].length;
        }
        const concat = new Uint8Array(totalBytes);
        let off = 0;
        for (let sb = 0; sb < numSb; sb++) {
            if (sbPlaneCount[sb] === 0) continue;
            const d = subbands[sb];
            const shift = plane * 8;
            for (let i = 0; i < d.length; i++) {
                const v = d[i];
                const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
                concat[off++] = (zz >>> shift) & 0xFF;
            }
        }
        const encoded = encode0D(concat.subarray(0, off));
        rateBits += 32 + encoded.length * 8;
    }

    // reconstruction for distortion measurement
    const scoredSubbands = subbands.map((sb, idx) =>
        sbPlaneCount[idx] === 0 ? new Int32Array(sb.length) : sb.slice());
    const scoredResiduals = waveletReconstruct(wasm, scoredSubbands);
    const reconstructed = varOrderPredictDec(scoredResiduals, n, varBlocks);

    if (couplingW !== undefined && refData) {
        for (let i = 0; i < n; i++) {
            const wr = couplingW * refData[i];
            reconstructed[i] += wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0;
        }
    }

    // projection: refine decoded integers within quantization cells
    const projectedCarrier = Float32Array.from(reconstructed);
    sanitizeProjectionToCell(projectedCarrier, reconstructed);
    varOrderCellProject(projectedCarrier, reconstructed, varBlocks);
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

function wasmWaveletFwd(wasm: HarmonicWasmExports, data: Int32Array): { ll: Int32Array; hh: Int32Array } {
    const n = data.length;
    if (n < 2) return { ll: data.slice(), hh: new Int32Array(0) };
    const srcOff = WASM_BUF_A;
    const dstOff = srcOff + n * 4;
    ensureWasmMem(wasm, dstOff + n * 4 + 64);
    copyI32ToWasm(wasm, srcOff, data);
    const nlp = wasm.wavelet_fwd(srcOff, n, dstOff);
    const nhp = n - nlp;
    return {
        ll: readI32FromWasm(wasm, dstOff, nlp),
        hh: readI32FromWasm(wasm, dstOff + nlp * 4, nhp),
    };
}

function wasmWaveletInv(wasm: HarmonicWasmExports, ll: Int32Array, hh: Int32Array): Int32Array {
    const nlp = ll.length, nhp = hh.length, n = nlp + nhp;
    if (nhp === 0) return ll.slice();
    const llOff  = WASM_BUF_A;
    const hhOff  = llOff + nlp * 4;
    const dstOff = hhOff + nhp * 4;
    ensureWasmMem(wasm, dstOff + n * 4 + 64);
    copyI32ToWasm(wasm, llOff, ll);
    copyI32ToWasm(wasm, hhOff, hh);
    wasm.wavelet_inv(llOff, nlp, hhOff, nhp, dstOff);
    return readI32FromWasm(wasm, dstOff, n);
}

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



// â”€â”€ trajectory prediction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// nonlinear closure of the prediction chain. after the linear hierarchy
// (Burg, AR(2), micro-osc, delta) removes oscillatory structure, the residual
// traces a trajectory on a low-dimensional manifold in delay-embedding space
// (Takens 1981). three interlocking techniques exploit this:
//
// 1. MaÃ±Ã© mixed embedding (MaÃ±Ã© 1981, Deyle & Sugihara 2011):
//    instead of pure time delays, embed using position + velocity +
//    acceleration + amplitude. these decorrelated features capture different
//    dynamics aspects, producing better neighbors than raw delays.
//
// 2. recurrence diagonal tracking (Eckmann 1987):
//    trajectories are continuous â€” if neighbor m was good at time t, then
//    m+1 is likely good at t+1. check the previous diagonal first (O(d)),
//    fall back to full kNN search (O(WÃ—d)) only when the diagonal breaks.
//
// 3. local Lyapunov confidence (Abarbanel 1992):
//    the weighted variance of neighbor continuations measures local
//    predictability. high variance = chaotic region = skip prediction.
//    computed from the kNN data at zero extra search cost.
//
// the predictor is SYMMETRIC: encoder and decoder compute identical
// predictions from the causal past. zero side information transmitted.

const TRAJ_K       = 6;     // nearest neighbors for simplex projection
const TRAJ_WINDOW  = 256;   // causal window size

// pre-allocated buffer for the kNN kernel (zero per-sample allocation).
// safe as module-level: channels are processed sequentially, not concurrently.
// in Web Workers, each worker gets its own copy of this module-level const.
const _sqrtCache = new Float64Array(TRAJ_K);

/** cross-frame trajectory state. the encoder and decoder both maintain this
 *  across frames. the warm window gives the trajectory predictor history from
 *  previous frames, so the kNN search starts with a full window immediately
 *  (no cold-start penalty). measured: 15-25% compression improvement over
 *  cold-start on 1-second signals. */
export interface HarmonicState {
    /** residual history from previous frames (circular, most recent at end) */
    trajWindow: Int32Array;
    /** how many valid samples are in the window */
    trajFill: number;
}

/** create a fresh codec state (cold start). */
export function createHarmonicState(): HarmonicState {
    return {
        trajWindow: new Int32Array(TRAJ_WINDOW),
        trajFill: 0,
    };
}

/** append residuals to the state's trajectory window (circular). */
function trajStateAppend(state: HarmonicState, residuals: Int32Array): void {
    const W = TRAJ_WINDOW;
    const n = residuals.length;
    if (n >= W) {
        // residuals longer than window â€” just keep the last W samples
        state.trajWindow.set(residuals.subarray(n - W));
        state.trajFill = W;
    } else if (state.trajFill + n <= W) {
        // fits without wrapping
        state.trajWindow.set(residuals, state.trajFill);
        state.trajFill += n;
    } else {
        // shift old data left, append new
        const keep = W - n;
        state.trajWindow.copyWithin(0, state.trajFill - keep, state.trajFill);
        state.trajWindow.set(residuals, keep);
        state.trajFill = W;
    }
}

/** trajectory prediction core: MaÃ±Ã© embedding + diagonal tracking.
 *
 *  MaÃ±Ã© mixed embedding: instead of pure delays [r(n-1)..r(n-4)], use
 *  [position, velocity, acceleration, amplitude] â€” decorrelated features
 *  that capture different dynamics aspects (MaÃ±Ã© 1981, Deyle & Sugihara 2011).
 *
 *  diagonal tracking: trajectories are continuous, so if neighbor m was best
 *  at time t, check m+1 first at time t+1. full search only when diagonal
 *  breaks (Eckmann 1987). amortized cost: O(d) per sample instead of O(WÃ—d).
 *
 *  the `encode` flag controls direction:
 *  encode â†’ out[i] = input[i] - pred,  decode â†’ out[i] = input[i] + pred. */
function trajProcess(input: Int32Array, out: Int32Array, encode: boolean, startIdx: number = 0): void {
    const n = input.length, k = TRAJ_K, W = TRAJ_WINDOW;
    const data = encode ? input : out;

    const bestDists = new Float64Array(k);
    const bestIdxs = new Int32Array(k);

    let diagIdx = -1;
    let prevBestDist = Infinity;

    // samples before startIdx are warm window â€” already set in out[], skip processing
    const begin = Math.max(3, startIdx);
    for (let i = startIdx; i < begin && i < n; i++) out[i] = input[i];

    for (let i = begin; i < n; i++) {
        const wStart = Math.max(3, i - W);

        // inline MaÃ±Ã© features for query point
        const qr0 = data[i - 1], qr1 = data[i - 2], qr2 = data[i - 3];
        const qPos = qr0, qVel = qr0 - qr1, qAcc = qr0 - 2 * qr1 + qr2;
        const qAmp = qr0 >= 0 ? qr0 : -qr0;

        // â”€â”€ diagonal tracking: check previous best neighbor's successor â”€â”€
        let diagHit = false;
        let diagDist = Infinity;
        const nextDiag = diagIdx + 1;
        if (diagIdx >= wStart && nextDiag >= wStart && nextDiag < i) {
            const mr0 = data[nextDiag - 1], mr1 = data[nextDiag - 2], mr2 = data[nextDiag - 3];
            const d0 = qPos - mr0, d1 = qVel - (mr0 - mr1);
            const d2 = qAcc - (mr0 - 2 * mr1 + mr2), d3 = qAmp - (mr0 >= 0 ? mr0 : -mr0);
            diagDist = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
            diagHit = diagDist <= prevBestDist * 4.0;
        }

        bestDists.fill(Infinity);
        bestIdxs.fill(-1);

        if (diagHit) {
            bestDists[0] = diagDist;
            bestIdxs[0] = nextDiag;
            // local search Â±16 around diagonal for more neighbors
            const ls = Math.max(wStart, nextDiag - 16);
            const le = Math.min(i, nextDiag + 16);
            for (let m = ls; m < le; m++) {
                if (m === nextDiag) continue;
                const mr0 = data[m - 1], mr1 = data[m - 2], mr2 = data[m - 3];
                const d0 = qPos - mr0, d1 = qVel - (mr0 - mr1);
                const d2 = qAcc - (mr0 - 2 * mr1 + mr2), d3 = qAmp - (mr0 >= 0 ? mr0 : -mr0);
                const dist = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
                if (dist < bestDists[k - 1]) {
                    bestDists[k - 1] = dist;
                    bestIdxs[k - 1] = m;
                    for (let s = k - 1; s > 0 && bestDists[s] < bestDists[s - 1]; s--) {
                        const td = bestDists[s]; bestDists[s] = bestDists[s - 1]; bestDists[s - 1] = td;
                        const ti = bestIdxs[s]; bestIdxs[s] = bestIdxs[s - 1]; bestIdxs[s - 1] = ti;
                    }
                }
            }
        } else {
            // full search
            for (let m = wStart; m < i; m++) {
                const mr0 = data[m - 1], mr1 = data[m - 2], mr2 = data[m - 3];
                const d0 = qPos - mr0, d1 = qVel - (mr0 - mr1);
                const d2 = qAcc - (mr0 - 2 * mr1 + mr2), d3 = qAmp - (mr0 >= 0 ? mr0 : -mr0);
                const dist = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
                if (dist < bestDists[k - 1]) {
                    bestDists[k - 1] = dist;
                    bestIdxs[k - 1] = m;
                    for (let s = k - 1; s > 0 && bestDists[s] < bestDists[s - 1]; s--) {
                        const td = bestDists[s]; bestDists[s] = bestDists[s - 1]; bestDists[s - 1] = td;
                        const ti = bestIdxs[s]; bestIdxs[s] = bestIdxs[s - 1]; bestIdxs[s - 1] = ti;
                    }
                }
            }
        }

        // count valid neighbors and compute Gaussian-weighted prediction.
        // optimization: cache sqrt(dist) from the count pass and precompute
        // 1/dMean to replace k divisions with k multiplications (~6Ã— faster).
        // the Schraudolph exp(-x) bit-hack (reinterpret integer as float64)
        // replaces Math.exp, avoiding the JSâ†’C++ boundary: ~15 cycles vs ~100.
        let actual = 0, dSum = 0;
        for (let j = 0; j < k; j++) {
            if (bestIdxs[j] < 0) break;
            const sd = Math.sqrt(bestDists[j]);
            _sqrtCache[j] = sd;
            dSum += sd;
            actual++;
        }

        if (actual < 2) {
            out[i] = input[i];
            diagIdx = -1;
            prevBestDist = Infinity;
            continue;
        }

        const invDMean = actual / (dSum || 1);
        let wSum = 0, predSum = 0;
        for (let j = 0; j < actual; j++) {
            const w = Math.exp(-_sqrtCache[j] * invDMean);
            wSum += w;
            predSum += w * data[bestIdxs[j]];
        }
        const pr = predSum / wSum;
        const pred = pr >= 0 ? (pr + 0.5) | 0 : (pr - 0.5) | 0;

        out[i] = encode ? (input[i] - pred) : (input[i] + pred);
        diagIdx = bestIdxs[0];
        prevBestDist = bestDists[0];
    }
}

/** Farmer-Sidorowich encode with optional warm window from previous frames.
 *  if state is provided, prepends the warm window to extend the causal past.
 *  IMPORTANT: state is NOT updated here â€” the caller must call trajStateUpdate
 *  with the final residuals (whether trajectory was used or not) to keep
 *  encoder and decoder states in sync. */
function trajectoryEncode(residuals: Int32Array, state?: HarmonicState): Int32Array {
    const errors = new Int32Array(residuals.length);
    if (state && state.trajFill >= 3) {
        const warm = state.trajWindow.subarray(0, state.trajFill);
        const extended = new Int32Array(warm.length + residuals.length);
        extended.set(warm);
        extended.set(residuals, warm.length);
        const extOut = new Int32Array(extended.length);
        extOut.set(warm);
        trajProcess(extended, extOut, true, warm.length);
        errors.set(extOut.subarray(warm.length));
    } else {
        trajProcess(residuals, errors, true, 0);
    }
    return errors;
}

/** Farmer-Sidorowich decode with optional warm window from previous frames. */
function trajectoryDecode(errors: Int32Array, state?: HarmonicState): Int32Array {
    const residuals = new Int32Array(errors.length);
    if (state && state.trajFill >= 3) {
        const warm = state.trajWindow.subarray(0, state.trajFill);
        const extended = new Int32Array(warm.length + errors.length);
        extended.set(warm);
        extended.set(errors, warm.length);
        const extOut = new Int32Array(extended.length);
        extOut.set(warm);
        trajProcess(extended, extOut, false, warm.length);
        residuals.set(extOut.subarray(warm.length));
    } else {
        trajProcess(errors, residuals, false, 0);
    }
    return residuals;
}

// â”€â”€ zigzag / byte-plane split â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function zigzagEnc(v: number): number { return (v << 1) ^ (v >> 31); }
function zigzagDec(z: number): number { return (z >>> 1) ^ -(z & 1); }

/** Adaptive plane encoding: skip zero byte planes to reduce Logos calls.
 *  planeCount=1 (lo only) when max zigzag < 256,
 *  planeCount=2 (mid+lo) when < 65536,
 *  planeCount=3 (top+mid+lo) otherwise.
 *  Returns { planeCount, planes[], origLen } where planes are Logos-encoded. */
function encodeResidualPlanes(residuals: Int32Array): {
    topEnc: Uint8Array; midEnc: Uint8Array; loEnc: Uint8Array;
    origLen: number; planeCount: number;
} {
    const n = residuals.length;
    if (n === 0) {
        const empty = new Uint8Array(0);
        return { topEnc: empty, midEnc: empty, loEnc: empty, origLen: 0, planeCount: 1 };
    }

    // scan for max zigzag value to determine plane count
    let maxZZ = 0;
    for (let i = 0; i < n; i++) {
        const v = residuals[i];
        const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
        if (zz > maxZZ) maxZZ = zz;
    }

    const planeCount = maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3;
    const empty = new Uint8Array(0);

    if (planeCount === 1) {
        // lo plane only â€” skip top and mid entirely
        const lo = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const v = residuals[i];
            lo[i] = (v >= 0 ? v * 2 : (-v * 2 - 1)) & 0xFF;
        }
        return { topEnc: empty, midEnc: empty, loEnc: encode0D(lo), origLen: n, planeCount };
    }

    if (planeCount === 2) {
        // mid + lo planes â€” skip top
        const mid = new Uint8Array(n), lo = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const v = residuals[i];
            const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
            mid[i] = (zz >>> 8) & 0xFF;
            lo[i]  =  zz        & 0xFF;
        }
        return { topEnc: empty, midEnc: encode0D(mid), loEnc: encode0D(lo), origLen: n, planeCount };
    }

    // planeCount === 3: all planes
    const top = new Uint8Array(n), mid = new Uint8Array(n), lo = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const z = zigzagEnc(residuals[i]) >>> 0;
        top[i] = (z >>> 16) & 0xFF;
        mid[i] = (z >>>  8) & 0xFF;
        lo[i]  =  z         & 0xFF;
    }
    return { topEnc: encode0D(top), midEnc: encode0D(mid), loEnc: encode0D(lo), origLen: n, planeCount };
}

function decodeResidualPlanes(
    topEnc: Uint8Array, midEnc: Uint8Array, loEnc: Uint8Array,
    origLen: number, planeCount: number = 3,
): Int32Array {
    if (origLen === 0) return new Int32Array(0);
    const out = new Int32Array(origLen);

    if (planeCount === 1) {
        const lo = decode0D(loEnc, origLen);
        for (let i = 0; i < origLen; i++) out[i] = zigzagDec(lo[i]);
        return out;
    }

    if (planeCount === 2) {
        const mid = decode0D(midEnc, origLen);
        const lo  = decode0D(loEnc,  origLen);
        for (let i = 0; i < origLen; i++) {
            const z = ((mid[i] << 8) | lo[i]) >>> 0;
            out[i] = zigzagDec(z);
        }
        return out;
    }

    // planeCount === 3
    const top = decode0D(topEnc, origLen);
    const mid = decode0D(midEnc, origLen);
    const lo  = decode0D(loEnc,  origLen);
    for (let i = 0; i < origLen; i++) {
        const z = ((top[i] << 16) | (mid[i] << 8) | lo[i]) >>> 0;
        out[i] = zigzagDec(z);
    }
    return out;
}

// â”€â”€ harmonic topology layer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// The harmonic amplitude surface A(n, t) â€” Goertzel cos/sin coefficients for
// harmonics n = 2,3,... at each voiced block t â€” is the time-frequency topology
// layer for 1D audio.  Analogous to Spatial's xmid(y,z) surface, it captures
// the spectral envelope as a smooth 2D field.  Compressed with 2D MÃ¶bius:
//   P(h,b) = A(hâˆ’1,b) + A(h,bâˆ’1) âˆ’ A(hâˆ’1,bâˆ’1)
// Error = Î”hÂ·Î”bÂ·A â€” zero for bilinear spectral envelopes.
//
// After extraction, the aperiodic residual (harmonics subtracted) passes
// through the existing wavelet + Logos pipeline.  For voiced signals the
// aperiodic energy drops sharply, collapsing the subband encoding cost.
// The fundamental (harmonic 1) is already removed by the AR(2) predictor;
// the topology layer captures harmonics 2, 3, ... up to Nyquist.

function omega0FromKG(K: number, G: number): number {
    const r = Math.sqrt(Math.max(G_FLOOR, G));
    const cosW = K / (2 * r);
    return cosW >= 1 ? 0 : cosW <= -1 ? Math.PI : Math.acos(cosW);
}

function countUsableH(omega0: number): number {
    if (omega0 < 0.001) return 0;
    return Math.min(MAX_HARMONICS, Math.max(0, Math.floor(Math.PI / omega0) - 1));
}

function blockVoiced(
    signal: Int32Array, residual: Int32Array,
    start: number, end: number,
): boolean {
    let sp = 0, np = 0;
    for (let i = start; i < end; i++) {
        sp += signal[i] * signal[i];
        np += residual[i] * residual[i];
    }
    if (sp < BLOCK_LEN) return false; // silence
    const gain = 10 * Math.log10(sp / Math.max(np, 1));
    // Voiced = meaningful prediction gain but residual still has energy
    // (pure tones have gain > 40 dB â€” AR(2) already captured everything,
    //  no harmonics left to extract)
    return gain >= VOICED_GAIN_DB && gain < VOICED_CEILING_DB;
}

function goertzelExtract(
    residual: Int32Array, start: number, blockLen: number,
    omega0: number, numH: number,
): { cosQ: Int32Array; sinQ: Int32Array } {
    const cosQ = new Int32Array(numH);
    const sinQ = new Int32Array(numH);
    // hann window: -31 dB sidelobes (vs -13 dB rectangular) reduces
    // cross-harmonic leakage in the Goertzel analysis. coherent gain
    // is 0.5, compensated by doubling the normalization factor.
    const norm = 4 / blockLen;
    const twoPiOverN = 2 * Math.PI / blockLen;
    for (let h = 0; h < numH; h++) {
        const freq = (h + 2) * omega0;
        if (freq >= Math.PI) break;
        let cc = 0, ss = 0;
        for (let t = 0; t < blockLen; t++) {
            const w = 0.5 - 0.5 * Math.cos(twoPiOverN * t);
            const v = residual[start + t] * w;
            cc += v * Math.cos(freq * t);
            ss += v * Math.sin(freq * t);
        }
        cosQ[h] = Math.round(cc * norm);
        sinQ[h] = Math.round(ss * norm);
    }
    return { cosQ, sinQ };
}

function harmonicSynth(
    omega0: number, cosQ: Int32Array, sinQ: Int32Array,
    numH: number, blockLen: number,
): Int32Array {
    const out = new Int32Array(blockLen);
    for (let h = 0; h < numH; h++) {
        const freq = (h + 2) * omega0;
        if (freq >= Math.PI) break;
        const c = cosQ[h], s = sinQ[h];
        if (c === 0 && s === 0) continue;
        for (let t = 0; t < blockLen; t++) {
            const hv = c * Math.cos(freq * t) + s * Math.sin(freq * t);
            out[t] += hv >= 0 ? (hv + 0.5) | 0 : (hv - 0.5) | 0;
        }
    }
    return out;
}

function superOmega(
    kgBlocks: { K: number; G: number }[],
    firstBlock: number, lastBlock: number,
): number {
    const omegas: number[] = [];
    for (let b = firstBlock; b < lastBlock; b++) {
        omegas.push(omega0FromKG(kgBlocks[b].K, kgBlocks[b].G));
    }
    omegas.sort((a, b) => a - b);
    return omegas[Math.floor(omegas.length / 2)];
}

function mobiusEnc2D(field: Int32Array, H: number, W: number): Int32Array {
    const r = new Int32Array(H * W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = field[y * W + x];
        const L = x > 0 ? field[y * W + x - 1] : 0;
        const A = y > 0 ? field[(y - 1) * W + x] : 0;
        const D = (x > 0 && y > 0) ? field[(y - 1) * W + x - 1] : 0;
        r[y * W + x] = v - (L + A - D);
    }
    return r;
}

function mobiusDec2D(r: Int32Array, H: number, W: number): Int32Array {
    const f = new Int32Array(H * W);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const L = x > 0 ? f[y * W + x - 1] : 0;
        const A = y > 0 ? f[(y - 1) * W + x] : 0;
        const D = (x > 0 && y > 0) ? f[(y - 1) * W + x - 1] : 0;
        f[y * W + x] = r[y * W + x] + (L + A - D);
    }
    return f;
}

// â”€â”€ Burg lattice prediction (primary stage on original signal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Adaptive-order LPC via Burg's method on the original quantized signal.
// Operates per 256-sample super-block. Order > 2 captures formants and
// higher harmonics that AR(2) can't reach. Order â‰¤ 2 falls back to identity
// (AR(2) already handles single-peak signals optimally).
//
// Pipeline: Burg primary â†’ AR(2) refinement â†’ wavelet â†’ entropy coding.
// Decoder: wavelet â†’ AR(2) inverse â†’ Burg inverse.

// 256 samples @ 48kHz = 5.3ms â‰ˆ one pitch period at 188Hz.
// long enough for Burg to capture the spectral envelope,
// short enough to track formant transitions in running speech.
const BURG_SUPER_LEN = 256;
// LP order 12: captures a 6-formant vocal tract (2 poles per formant).
// the vocal tract has 4-5 formants in the 0-5kHz range, plus spectral tilt.
const BURG_MAX_ORDER = 12;
// reflection coefficient threshold: |kâ‚˜|Â² < 0.15Â² = 0.0225 = 2.25% energy.
// each additional LP order must explain at least 2.25% of remaining variance.
// this is conservative â€” prevents overfitting to quantization artifacts.
const BURG_K_THRESH  = 0.15;
// Burg must reduce energy by at least 10% (1 dB) to justify its trajectory cost.
// each super-block costs ~7 bytes; 10% of even a small signal saves more.
const BURG_ENERGY_THRESHOLD = 0.90;
const BURG_FLAG      = 0x04;   // bit 2 of header flags

interface BurgSuperBlock {
    order: number;
    quantK: Int8Array;
    a: Float64Array;
}

function quantRC(k: number): number {
    return Math.max(-127, Math.min(127, Math.round(k * 127)));
}

function dequantRC(q: number): number {
    return q / 127;
}

/** Burg's method: compute reflection coefficients for data[start..end). */
function burgAnalysis(
    data: Int32Array, start: number, end: number, maxOrder: number,
): Float64Array {
    const n = end - start;
    if (n < maxOrder * 2 + 1) return new Float64Array(0);

    const refCoeffs = new Float64Array(maxOrder);
    const fwd = new Float64Array(n);
    const bwd = new Float64Array(n);
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

/** Select optimal order: stop when |kâ‚˜| < threshold. */
function burgSelectOrder(refCoeffs: Float64Array): number {
    for (let m = 0; m < refCoeffs.length; m++) {
        if (Math.abs(refCoeffs[m]) < BURG_K_THRESH) return m;
    }
    return refCoeffs.length;
}

/** Levinson recursion: reflection coefficients â†’ LP coefficients.
 *  Returns a[0..order-1] where pred = sum(a[m] * x[n-1-m], m=0..P-1). */
function reflToLP(k: Float64Array, order: number): Float64Array {
    const a = new Float64Array(order);
    if (order === 0) return a;

    a[0] = k[0];
    for (let m = 1; m < order; m++) {
        const prev = new Float64Array(m);
        for (let j = 0; j < m; j++) prev[j] = a[j];
        a[m] = k[m];
        for (let j = 0; j < m; j++) a[j] = prev[j] + k[m] * prev[m - 1 - j];
    }

    // negate: Burg produces a[] where e[n] = x[n] + a[0]*x[n-1] + ...
    // we want pred = a'[0]*x[n-1] + ... so a' = -a
    for (let m = 0; m < order; m++) a[m] = -a[m];

    return a;
}

/** Primary Burg forward prediction on original signal (encoder).
 *  For order > 2: produces LP residuals. For order â‰¤ 2: identity (passthrough).
 *  State tracks original data values (reconstructed = data[i] exactly). */
function burgPrimaryForward(
    data: Int32Array, numSamples: number, superLen: number = BURG_SUPER_LEN,
): { output: Int32Array; superBlocks: BurgSuperBlock[] } {
    const numSuper = Math.ceil(numSamples / superLen);
    const superBlocks: BurgSuperBlock[] = [];
    const output = new Int32Array(numSamples);
    const state = new Float64Array(BURG_MAX_ORDER);

    for (let si = 0; si < numSuper; si++) {
        const sStart = si * superLen;
        const sEnd = Math.min(sStart + superLen, numSamples);
        const sLen = sEnd - sStart;

        // burg analysis on original signal
        const rawK = burgAnalysis(data, sStart, sEnd,
            Math.min(BURG_MAX_ORDER, Math.floor(sLen / 3)));
        const order = burgSelectOrder(rawK);

        if (order > 2) {
            // quantize reflection coefficients
            const quantK = new Int8Array(order);
            for (let m = 0; m < order; m++) quantK[m] = quantRC(rawK[m]);
            const dequantK = new Float64Array(order);
            for (let m = 0; m < order; m++) dequantK[m] = dequantRC(quantK[m]);
            const a = reflToLP(dequantK, order);

            // LP forward prediction with encoder-tracks-decoder state
            let origEnergy = 0, burgEnergy = 0;
            const savedState = new Float64Array(state);
            for (let i = 0; i < sLen; i++) {
                const val = data[sStart + i];
                origEnergy += val * val;
                let pred = 0;
                for (let m = 0; m < order; m++) pred += a[m] * state[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                const res = val - roundPred;
                burgEnergy += res * res;
                output[sStart + i] = res;
                // reconstructed = res + roundPred = val exactly
                for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                state[0] = val;
            }

            // energy safety: only use Burg if it actually reduces energy
            // accept Burg if it captures at least 10% of the signal energy.
            // each super-block costs ~7 bytes (order + coefficients). even a
            // 10% energy reduction saves more than that in residual encoding.
            if (origEnergy > 0 && burgEnergy < origEnergy * BURG_ENERGY_THRESHOLD) {
                superBlocks.push({ order, quantK, a });
            } else {
                // rollback: Burg didn't help, use identity
                for (let i = 0; i < sLen; i++) output[sStart + i] = data[sStart + i];
                // state already tracks data[i] values from the loop, no change needed
                superBlocks.push({ order: 0, quantK: new Int8Array(0), a: new Float64Array(0) });
            }
        } else {
            // order â‰¤ 2: identity passthrough (AR(2) handles this)
            for (let i = 0; i < sLen; i++) output[sStart + i] = data[sStart + i];
            superBlocks.push({ order: 0, quantK: new Int8Array(0), a: new Float64Array(0) });
        }

        // state always tracks original data values
        for (let j = 0; j < Math.min(BURG_MAX_ORDER, sLen); j++) {
            state[j] = data[sStart + sLen - 1 - j];
        }
    }

    return { output, superBlocks };
}

/** Primary Burg inverse prediction (decoder). */
function burgPrimaryInverse(
    residuals: Int32Array, numSamples: number, superBlocks: BurgSuperBlock[],
    superLen: number = BURG_SUPER_LEN,
): Int32Array {
    const data = new Int32Array(numSamples);
    const state = new Float64Array(BURG_MAX_ORDER);

    for (let si = 0; si < superBlocks.length; si++) {
        const sStart = si * superLen;
        const sEnd = Math.min(sStart + superLen, numSamples);
        const sLen = sEnd - sStart;
        const { a, order } = superBlocks[si];

        if (order > 0) {
            for (let i = 0; i < sLen; i++) {
                let pred = 0;
                for (let m = 0; m < order; m++) pred += a[m] * state[m];
                const reconstructed = residuals[sStart + i] + (pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0);
                data[sStart + i] = reconstructed;
                for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                state[0] = reconstructed;
            }
        } else {
            // identity
            for (let i = 0; i < sLen; i++) data[sStart + i] = residuals[sStart + i];
        }

        // state tracks reconstructed data
        for (let j = 0; j < Math.min(BURG_MAX_ORDER, sLen); j++) {
            state[j] = data[sStart + sLen - 1 - j];
        }
    }

    return data;
}

// ── unified variable-order prediction ──────────────────────────────────
//
// replaces the 3-stage pipeline (Burg-superblock + AR(2)-block + micro)
// with a single adaptive-order Burg predictor per 32-sample block.
//
// for each block, Burg analysis produces reflection coefficients at orders
// 2, 4, 6, 8. the encoder picks the order that minimizes:
//   cost(p) = p * 8 (coefficient bits) + n * log2(errorVariance_p)
// this is the MDL criterion: model complexity + data surprise.
//
// the prediction is causal, deterministic, and integer-exact:
//   pred = round(a[0]*state[0] + a[1]*state[1] + ... + a[p-1]*state[p-1])
//   residual = sample - pred
// state tracks reconstructed values, so encoder and decoder agree exactly.

const VAR_MAX_ORDER = 8;
const VAR_ORDERS = [0, 2, 4, 6, 8];

interface VarBlock {
    order: number;
    quantK: Int8Array;      // quantized reflection coefficients
    a: Float64Array;        // LP coefficients (from quantized reflections)
}

/** fit variable-order Burg on all 32-sample blocks.
 *  returns one VarBlock per block with the optimal order and coefficients.
 *  state carries across blocks (prediction is continuous). */
export function varOrderFitAllBlocks(
    data: Int32Array, numSamples: number,
): VarBlock[] {
    const numBlocks = Math.ceil(numSamples / BLOCK_LEN);
    const blocks: VarBlock[] = [];
    const state = new Float64Array(VAR_MAX_ORDER);

    for (let b = 0; b < numBlocks; b++) {
        const bStart = b * BLOCK_LEN;
        const bEnd = Math.min(bStart + BLOCK_LEN, numSamples);
        const bLen = bEnd - bStart;

        // fit Burg at maximum feasible order
        const maxOrd = Math.min(VAR_MAX_ORDER, Math.floor(bLen / 3));
        const rawK = maxOrd >= 2 ? burgAnalysis(data, bStart, bEnd, maxOrd) : new Float64Array(0);

        // evaluate each candidate order via MDL
        let bestOrder = 0;
        let bestCost = Infinity;
        let bestQuantK = new Int8Array(0);
        let bestA = new Float64Array(0);

        // order 0 baseline: cost = n * log2(signal variance)
        {
            let energy = 0;
            for (let i = bStart; i < bEnd; i++) {
                const val = data[i];
                let pred = 0;
                // no prediction at order 0, but we still measure residual = val
                energy += val * val;
            }
            const errVar = Math.max(1, energy / bLen);
            bestCost = bLen * Math.log2(errVar);
            bestOrder = 0;
        }

        // try orders 2, 4, 6, 8
        for (const tryOrder of VAR_ORDERS) {
            if (tryOrder === 0 || tryOrder > maxOrd) continue;

            // quantize reflection coefficients at this order
            const qk = new Int8Array(tryOrder);
            const dqk = new Float64Array(tryOrder);
            for (let m = 0; m < tryOrder; m++) {
                qk[m] = quantRC(rawK[m]);
                dqk[m] = dequantRC(qk[m]);
            }
            const a = reflToLP(dqk, tryOrder);

            // compute prediction error with encoder-decoder state tracking
            const savedState = new Float64Array(state);
            let errEnergy = 0;
            for (let i = 0; i < bLen; i++) {
                const val = data[bStart + i];
                let pred = 0;
                for (let m = 0; m < tryOrder; m++) pred += a[m] * savedState[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                const res = val - roundPred;
                errEnergy += res * res;
                for (let m = tryOrder - 1; m > 0; m--) savedState[m] = savedState[m - 1];
                savedState[0] = val; // encoder tracks original (lossless)
            }

            const errVar = Math.max(1, errEnergy / bLen);
            const cost = tryOrder * 8 + bLen * Math.log2(errVar);

            if (cost < bestCost) {
                bestCost = cost;
                bestOrder = tryOrder;
                bestQuantK = qk;
                bestA = a;
            }
        }

        blocks.push({ order: bestOrder, quantK: bestQuantK, a: bestA });

        // advance state: always track original data
        for (let i = 0; i < bLen; i++) {
            for (let m = VAR_MAX_ORDER - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = data[bStart + i];
        }
    }

    return blocks;
}

/** estimate coefficient stream cost (bits) before Logos compression.
 *  counts order bytes + reflection coefficient bytes per block. */
export function estimateCoeffBits(blocks: VarBlock[]): number {
    let bits = 0;
    for (const b of blocks) {
        bits += 8; // order byte
        bits += b.order * 8; // reflection coefficients
    }
    return bits;
}

/** encode prediction: data → residuals using fitted VarBlocks. */
export function varOrderPredictEnc(
    data: Int32Array, numSamples: number, blocks: VarBlock[],
): Int32Array {
    const residuals = new Int32Array(numSamples);
    const state = new Float64Array(VAR_MAX_ORDER);

    for (let b = 0; b < blocks.length; b++) {
        const bStart = b * BLOCK_LEN;
        const bEnd = Math.min(bStart + BLOCK_LEN, numSamples);
        const { a, order } = blocks[b];

        for (let i = bStart; i < bEnd; i++) {
            const val = data[i];
            if (order > 0) {
                let pred = 0;
                for (let m = 0; m < order; m++) pred += a[m] * state[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                residuals[i] = val - roundPred;
            } else {
                residuals[i] = val;
            }
            for (let m = VAR_MAX_ORDER - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = val; // track original (encoder side)
        }
    }

    return residuals;
}

/** decode prediction: residuals → data using fitted VarBlocks. */
function varOrderPredictDec(
    residuals: Int32Array, numSamples: number, blocks: VarBlock[],
): Int32Array {
    const data = new Int32Array(numSamples);
    const state = new Float64Array(VAR_MAX_ORDER);

    for (let b = 0; b < blocks.length; b++) {
        const bStart = b * BLOCK_LEN;
        const bEnd = Math.min(bStart + BLOCK_LEN, numSamples);
        const { a, order } = blocks[b];

        for (let i = bStart; i < bEnd; i++) {
            if (order > 0) {
                let pred = 0;
                for (let m = 0; m < order; m++) pred += a[m] * state[m];
                const roundPred = pred >= 0 ? (pred + 0.5) | 0 : (pred - 0.5) | 0;
                data[i] = residuals[i] + roundPred;
            } else {
                data[i] = residuals[i];
            }
            for (let m = VAR_MAX_ORDER - 1; m > 0; m--) state[m] = state[m - 1];
            state[0] = data[i]; // track reconstructed (decoder side)
        }
    }

    return data;
}

/** encode coefficient stream: [order_byte][k1][k2]...[kp] per block.
 *  Logos-compressed for transmission. */
export function encodeCoeffStream(blocks: VarBlock[]): { raw: Uint8Array; compressed: Uint8Array } {
    // compute total size
    let totalBytes = 0;
    for (const b of blocks) totalBytes += 1 + b.order;
    const raw = new Uint8Array(totalBytes);
    let off = 0;
    for (const b of blocks) {
        raw[off++] = b.order;
        for (let m = 0; m < b.order; m++) raw[off++] = (b.quantK[m] + 128) & 0xFF;
    }
    const compressed = encode0D(raw);
    return { raw, compressed };
}

/** decode coefficient stream back to VarBlock array. */
function decodeCoeffStream(data: Uint8Array, numBlocks: number): VarBlock[] {
    const blocks: VarBlock[] = [];
    let off = 0;
    for (let b = 0; b < numBlocks; b++) {
        const order = data[off++];
        const quantK = new Int8Array(order);
        for (let m = 0; m < order; m++) quantK[m] = (data[off++] - 128) << 24 >> 24;
        const dequantK = new Float64Array(order);
        for (let m = 0; m < order; m++) dequantK[m] = dequantRC(quantK[m]);
        const a = order > 0 ? reflToLP(dequantK, order) : new Float64Array(0);
        blocks.push({ order, quantK, a });
    }
    return blocks;
}

/** dequantization refinement: project decoded integers onto the prediction
 *  manifold within each quantization cell. forward + backward Burg priors
 *  constrained to [q-0.5, q+0.5]. */
function varOrderCellProject(
    projected: Float32Array, data: Int32Array, blocks: VarBlock[],
): void {
    const n = data.length;
    const numBlocks = blocks.length;

    // forward pass
    const state = new Float64Array(VAR_MAX_ORDER);
    for (let b = 0; b < numBlocks; b++) {
        const bStart = b * BLOCK_LEN;
        const bEnd = Math.min(bStart + BLOCK_LEN, n);
        const { a, order } = blocks[b];

        if (order > 0) {
            // measure prediction quality on this block
            let obsEnergy = 0, count = 0;
            const anaState = new Float64Array(state);
            for (let i = bStart; i < bEnd; i++) {
                let pred = 0;
                for (let m = 0; m < order; m++) pred += a[m] * anaState[m];
                const d = projected[i] - pred;
                obsEnergy += d * d;
                count++;
                for (let m = order - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                anaState[0] = projected[i];
            }
            const obsVar = count > 0 ? obsEnergy / count : 0;
            const weight = obsVar > 0 ? Math.min(1, QUANT_NOISE_REG / obsVar) : 1;

            if (weight > 0) {
                for (let i = bStart; i < bEnd; i++) {
                    let pred = 0;
                    for (let m = 0; m < order; m++) pred += a[m] * state[m];
                    const q = data[i];
                    const lo = q - 0.5;
                    const hi = q + 0.5;
                    const clamped = pred < lo ? lo : pred > hi ? hi : pred;
                    projected[i] = projected[i] + weight * (clamped - projected[i]);
                    for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                    state[0] = projected[i];
                }
            } else {
                for (let i = bStart; i < bEnd; i++) {
                    for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                    state[0] = projected[i];
                }
            }
        } else {
            for (let i = bStart; i < bEnd; i++) {
                for (let m = VAR_MAX_ORDER - 1; m > 0; m--) state[m] = state[m - 1];
                state[0] = projected[i];
            }
        }
    }
}

/** decoder-side dequantization refinement.
 *  each decoded integer sample only tells us that the true sample lies in the
 *  quantization cell [q-0.5, q+0.5]. Burg already gives a local physical prior
 *  for where the waveform should be inside that cell. run that prior in both
 *  directions: causal (past -> future) and anti-causal (future -> past).
 *
 *  this creates a tiny boolean lattice of constraints:
 *    quantization cell âˆ§ forward Burg prior âˆ§ backward Burg prior
 *
 *  each Burg prior is projected into the cell, then blended against the cell
 *  midpoint q with precision weight (quantization variance / innovation
 *  variance). when the model is strong, it pulls the sample toward the more
 *  physically plausible point inside the same committed cell. when the model is
 *  weak, the midpoint wins and this collapses back to normal dequantization.
 */
function burgCellProject(
    data: Int32Array, numSamples: number, superBlocks: BurgSuperBlock[],
    superLen: number = BURG_SUPER_LEN,
): Float32Array {
    const current = new Float32Array(numSamples);
    const forward = new Float32Array(numSamples);
    const backward = new Float32Array(numSamples);
    const wForward = new Float32Array(superBlocks.length);
    const wBackward = new Float32Array(superBlocks.length);
    for (let i = 0; i < numSamples; i++) current[i] = data[i];

    // two symmetric relaxation cycles: the first moves off the midpoint, the
    // second lets neighboring refined samples influence each other once.
    for (let iter = 0; iter < 2; iter++) {
        {
            const state = new Float64Array(BURG_MAX_ORDER);
            const anaState = new Float64Array(BURG_MAX_ORDER);
            for (let si = 0; si < superBlocks.length; si++) {
                const sStart = si * superLen;
                const sEnd = Math.min(sStart + superLen, numSamples);
                const sLen = sEnd - sStart;
                const { a, order } = superBlocks[si];

                if (order > 0) {
                    let obsEnergy = 0;
                    for (let i = 0; i < sLen; i++) {
                        let pred = 0;
                        for (let m = 0; m < order; m++) pred += a[m] * anaState[m];
                        const x = current[sStart + i];
                        const err = x - pred;
                        obsEnergy += err * err;
                        for (let m = order - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                        anaState[0] = x;
                    }
                    wForward[si] = obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / sLen) : 1024;

                    for (let i = 0; i < sLen; i++) {
                        let pred = 0;
                        for (let m = 0; m < order; m++) pred += a[m] * state[m];
                        const q = data[sStart + i];
                        const lo = q - 0.5;
                        const hi = q + 0.5;
                        const projected = pred < lo ? lo : pred > hi ? hi : pred;
                        forward[sStart + i] = projected;
                        for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                        state[0] = projected;
                    }
                } else {
                    for (let i = 0; i < sLen; i++) {
                        forward[sStart + i] = data[sStart + i];
                        for (let m = BURG_MAX_ORDER - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                        anaState[0] = current[sStart + i];
                    }
                    wForward[si] = 0;
                }

                for (let j = 0; j < Math.min(BURG_MAX_ORDER, sLen); j++) {
                    state[j] = forward[sStart + sLen - 1 - j];
                }
            }
        }

        {
            const state = new Float64Array(BURG_MAX_ORDER);
            const anaState = new Float64Array(BURG_MAX_ORDER);
            for (let si = superBlocks.length - 1; si >= 0; si--) {
                const sStart = si * superLen;
                const sEnd = Math.min(sStart + superLen, numSamples);
                const sLen = sEnd - sStart;
                const { a, order } = superBlocks[si];

                if (order > 0) {
                    let obsEnergy = 0;
                    for (let i = sEnd - 1; i >= sStart; i--) {
                        let pred = 0;
                        for (let m = 0; m < order; m++) pred += a[m] * anaState[m];
                        const x = current[i];
                        const err = x - pred;
                        obsEnergy += err * err;
                        for (let m = order - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                        anaState[0] = x;
                    }
                    wBackward[si] = obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / sLen) : 1024;

                    for (let i = sEnd - 1; i >= sStart; i--) {
                        let pred = 0;
                        for (let m = 0; m < order; m++) pred += a[m] * state[m];
                        const q = data[i];
                        const lo = q - 0.5;
                        const hi = q + 0.5;
                        const projected = pred < lo ? lo : pred > hi ? hi : pred;
                        backward[i] = projected;
                        for (let m = order - 1; m > 0; m--) state[m] = state[m - 1];
                        state[0] = projected;
                    }
                } else {
                    for (let i = sEnd - 1; i >= sStart; i--) {
                        backward[i] = data[i];
                        for (let m = BURG_MAX_ORDER - 1; m > 0; m--) anaState[m] = anaState[m - 1];
                        anaState[0] = current[i];
                    }
                    wBackward[si] = 0;
                }
            }
        }

        for (let si = 0; si < superBlocks.length; si++) {
            const sStart = si * superLen;
            const sEnd = Math.min(sStart + superLen, numSamples);
            const wf = wForward[si];
            const wb = wBackward[si];
            for (let i = sStart; i < sEnd; i++) {
                const q = data[i];
                current[i] = q + (wf * (forward[i] - q) + wb * (backward[i] - q)) / (1 + wf + wb);
            }
        }
    }

    return current;
}

/** ar(2) cell projection for regions where Burg is inactive.
 *  when Burg is off, the committed raw waveform still lives on the AR(2)
 *  orbital manifold already carried by the K/G trajectory. unlike Burg, the
 *  orbit is exactly 2-dimensional, so the reverse-time prior is available in
 *  closed form from the inverse state transition:
 *
 *    x[n+2] = KÂ·x[n+1] - GÂ·x[n]
 *    x[n]   = (KÂ·x[n+1] - x[n+2]) / G
 *
 *  run the same boolean-lattice meet as Burg:
 *    quantization cell âˆ§ forward AR(2) prior âˆ§ backward AR(2) prior
 *
 *  only samples in Burg-inactive superblocks are moved. Burg-active regions
 *  already have the stronger LP prior and are left alone here.
 */
function ar2CellProject(
    projected: Float32Array, data: Int32Array,
    kgBlocks: { K: number; G: number }[],
    burgSuperBlocks?: BurgSuperBlock[], burgSuperLen: number = BURG_SUPER_LEN,
): void {
    const n = data.length;
    if (n === 0 || kgBlocks.length === 0) return;

    const active = new Uint8Array(n);
    if (burgSuperBlocks && burgSuperBlocks.length > 0) {
        for (let si = 0; si < burgSuperBlocks.length; si++) {
            if (burgSuperBlocks[si].order > 0) continue;
            const sStart = si * burgSuperLen;
            const sEnd = Math.min(sStart + burgSuperLen, n);
            active.fill(1, sStart, sEnd);
        }
    } else {
        active.fill(1);
    }

    let anyActive = false;
    for (let i = 0; i < n; i++) {
        if (active[i]) { anyActive = true; break; }
    }
    if (!anyActive) return;

    const numBlocks = kgBlocks.length;
    const current = projected.slice();
    const forward = new Float32Array(n);
    const backward = new Float32Array(n);
    const wForward = new Float32Array(numBlocks);
    const wBackward = new Float32Array(numBlocks);

    for (let iter = 0; iter < 2; iter++) {
        {
            let ana1 = 0, ana2 = 0;
            let state1 = 0, state2 = 0;
            for (let b = 0; b < numBlocks; b++) {
                const { K, G } = kgBlocks[b];
                const start = b * BLOCK_LEN;
                const end = Math.min(start + BLOCK_LEN, n);
                let obsEnergy = 0;
                let count = 0;
                for (let i = start; i < end; i++) {
                    const pred = K * ana1 - G * ana2;
                    const x = current[i];
                    if (active[i]) {
                        const err = x - pred;
                        obsEnergy += err * err;
                        count++;
                    }
                    ana2 = ana1;
                    ana1 = x;
                }
                wForward[b] = count > 0
                    ? (obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / count) : 1024)
                    : 0;

                for (let i = start; i < end; i++) {
                    const pred = K * state1 - G * state2;
                    let x = current[i];
                    if (active[i]) {
                        const q = data[i];
                        const lo = q - 0.5;
                        const hi = q + 0.5;
                        x = pred < lo ? lo : pred > hi ? hi : pred;
                    }
                    forward[i] = x;
                    state2 = state1;
                    state1 = x;
                }
            }
        }

        {
            let ana1 = 0, ana2 = 0;
            let state1 = 0, state2 = 0;
            for (let b = numBlocks - 1; b >= 0; b--) {
                const { K, G } = kgBlocks[b];
                const start = b * BLOCK_LEN;
                const end = Math.min(start + BLOCK_LEN, n);
                if (G <= G_FLOOR) {
                    wBackward[b] = 0;
                    for (let i = end - 1; i >= start; i--) {
                        backward[i] = current[i];
                        ana2 = ana1;
                        ana1 = current[i];
                        state2 = state1;
                        state1 = current[i];
                    }
                    continue;
                }

                let obsEnergy = 0;
                let count = 0;
                for (let i = end - 1; i >= start; i--) {
                    const pred = (K * ana1 - ana2) / G;
                    const x = current[i];
                    if (active[i]) {
                        const err = x - pred;
                        obsEnergy += err * err;
                        count++;
                    }
                    ana2 = ana1;
                    ana1 = x;
                }
                wBackward[b] = count > 0
                    ? (obsEnergy > 0 ? QUANT_NOISE_REG / (obsEnergy / count) : 1024)
                    : 0;

                for (let i = end - 1; i >= start; i--) {
                    const pred = (K * state1 - state2) / G;
                    let x = current[i];
                    if (active[i]) {
                        const q = data[i];
                        const lo = q - 0.5;
                        const hi = q + 0.5;
                        x = pred < lo ? lo : pred > hi ? hi : pred;
                    }
                    backward[i] = x;
                    state2 = state1;
                    state1 = x;
                }
            }
        }

        for (let b = 0; b < numBlocks; b++) {
            const start = b * BLOCK_LEN;
            const end = Math.min(start + BLOCK_LEN, n);
            const wf = wForward[b];
            const wb = wBackward[b];
            for (let i = start; i < end; i++) {
                if (!active[i]) continue;
                const q = data[i];
                current[i] = q + (wf * (forward[i] - q) + wb * (backward[i] - q)) / (1 + wf + wb);
            }
        }
    }

    projected.set(current);
}

/** channel-axis dequantization refinement.
 *  Harmonic factors multichannel prediction into two orthogonal layers:
 *    1. W on the channel axis
 *    2. K/G + Burg on the time axis
 *
 *  if the reference channel moved inside its quantization cell during
 *  reconstruction, the coupled channel should move with it by WÂ·Î”ref. project
 *  that channel-axis prior into the current channel's cell and blend it with
 *  the time-axis estimate. the precision weight WÂ²/(1+WÂ²) is the normalized
 *  energy share of the channel axis in x â‰ˆ u + WÂ·r.
 */
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
        const weight = obsVar > 0 ? Math.min(1, (1 / 8) / obsVar) : 1;
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

/** Encode Burg super-blocks to bytes. */
function encodeBurgTrajectory(superBlocks: BurgSuperBlock[]): Uint8Array {
    let totalBytes = 0;
    for (const sb of superBlocks) totalBytes += 1 + sb.order;
    const out = new Uint8Array(totalBytes);
    let off = 0;
    for (const sb of superBlocks) {
        out[off++] = sb.order;
        for (let m = 0; m < sb.order; m++) out[off++] = sb.quantK[m] & 0xFF;
    }
    return out;
}

/** Decode Burg super-blocks from bytes. */
function decodeBurgTrajectory(data: Uint8Array, numSuperBlocks: number): BurgSuperBlock[] {
    const superBlocks: BurgSuperBlock[] = [];
    let off = 0;
    for (let si = 0; si < numSuperBlocks; si++) {
        const order = data[off++];
        const quantK = new Int8Array(order);
        for (let m = 0; m < order; m++) quantK[m] = (data[off++] << 24) >> 24;
        const dequantK = new Float64Array(order);
        for (let m = 0; m < order; m++) dequantK[m] = dequantRC(quantK[m]);
        const a = reflToLP(dequantK, order);
        superBlocks.push({ order, quantK, a });
    }
    return superBlocks;
}

/** Estimate Rice coding cost (bits) for a residual array.
 *  Used by the Burg trial to compare Burg+AR(2) vs plain AR(2) paths. */
function estimateRiceCost(residuals: Int32Array, n: number): number {
    let sumAbs = 0;
    for (let i = 0; i < n; i++) {
        const v = residuals[i];
        sumAbs += v >= 0 ? v : -v;
    }
    if (sumAbs === 0) return n; // 1 bit per sample minimum
    const meanAbs = sumAbs / n;
    const k = Math.max(0, Math.floor(Math.log2(Math.max(1, meanAbs * Math.LN2))));
    let bits = 0;
    for (let i = 0; i < n; i++) {
        const v = residuals[i];
        const zz = v >= 0 ? v * 2 : (-v * 2 - 1);
        bits += (zz >>> k) + 1 + k;
    }
    return bits;
}

/** Estimate K/G trajectory encoding cost (bits).
 *  Counts per-block change flags and approximates Rice-coded deltas.
 *  Used by the trial encoder to fairly compare paths that produce
 *  different K/G trajectories (e.g., plain AR(2) vs Burg+AR(2)). */
const KG_TRAJ_WIRE_LEGACY = 0;
const KG_TRAJ_WIRE_RUN_AWARE = 1;

function estimateTrajectoryBitsLegacy(
    blocks: { Kint: number; Gint: number }[],
    metaKK: number, metaGK: number,
): number {
    let bits = 0;
    let prevK = 0, prevG = 0;
    let prev2K = 0, prev2G = 0;
    let runK = 0, runG = 0;
    for (const { Kint, Gint } of blocks) {
        const predK = prevK + ((metaKK * (prevK - prev2K) + 32) >> 6);
        const predG = prevG + ((metaGK * (prevG - prev2G) + 32) >> 6);
        const dk = Kint - predK;
        const dg = Gint - predG;
        const zk = zigzagEnc(dk) >>> 0;
        const zg = zigzagEnc(dg) >>> 0;
        if (zk > 0x7FFF || zg > 0x7FFF) {
            bits += 33;
            runK = 0; runG = 0;
        } else {
            bits += 1; // reset bit
            const kChanged = zk !== 0;
            const gChanged = zg !== 0;
            bits += 2; // changed flags
            if (kChanged) {
                const mK = runK === 0 ? 0 : Math.min(14, 31 - Math.clz32(runK));
                bits += 4 + (zk >>> mK) + 1 + mK;
                runK = (runK + zk) >>> 1;
            }
            if (gChanged) {
                const mG = runG === 0 ? 0 : Math.min(14, 31 - Math.clz32(runG));
                bits += 4 + (zg >>> mG) + 1 + mG;
                runG = (runG + zg) >>> 1;
            }
        }
        prev2K = prevK; prev2G = prevG;
        prevK = Kint; prevG = Gint;
    }
    return bits;
}

function estimateTrajectoryBitsRunAware(
    blocks: { Kint: number; Gint: number }[],
    metaKK: number, metaGK: number,
): number {
    let bits = 0;
    let prevK = 0, prevG = 0;
    let prev2K = 0, prev2G = 0;
    let runZeros = 0;
    let runAvg = 0;
    for (const { Kint, Gint } of blocks) {
        const predK = prevK + ((metaKK * (prevK - prev2K) + 32) >> 6);
        const predG = prevG + ((metaGK * (prevG - prev2G) + 32) >> 6);
        const dk = Kint - predK;
        const dg = Gint - predG;
        if (dk === 0 && dg === 0) {
            runZeros++;
        } else {
            bits += estimateZeroRunBits(runZeros, runAvg);
            if (runZeros > 1) runAvg = (runAvg + (runZeros - 2)) >>> 1;
            runZeros = 0;
            const dkAbs = Math.abs(dk);
            const dgAbs = Math.abs(dg);
            bits += 2; // tag
            const kChanged = dkAbs > DEAD_K;
            const gChanged = dgAbs > DEAD_G;
            bits += 2; // changed flags
            if (kChanged) bits += 4 + Math.max(1, Math.ceil(Math.log2(dkAbs + 1)));
            if (gChanged) bits += 4 + Math.max(1, Math.ceil(Math.log2(dgAbs + 1)));
        }
        prev2K = prevK; prev2G = prevG;
        prevK = Kint; prevG = Gint;
    }
    bits += estimateZeroRunBits(runZeros, runAvg);
    return bits;
}

function estimateTrajectoryBits(blocks: { Kint: number; Gint: number }[]): number {
    const { metaKK, metaGK } = metaPredictKG(blocks);
    const legacyBits = estimateTrajectoryBitsLegacy(blocks, metaKK, metaGK);
    const runAwareBits = estimateTrajectoryBitsRunAware(blocks, metaKK, metaGK);
    return 8 + Math.min(legacyBits, runAwareBits);
}

// reusable entropy count buffer (avoids allocation per call)
// entropy estimation scratch is now in _ctx.ent (codec context)

/** byte-plane cost estimate (bytes) for subband residuals.
 *  uses the MINIMUM of order-0 entropy and XOR-derivative entropy on the
 *  low plane. the XOR derivative (byte[i] ^ byte[i-1]) is exactly what
 *  Logos's Z-axis models â€” it captures byte-to-byte correlation that the
 *  trajectory predictor creates. taking the min of both estimates ensures
 *  the trial comparison sees whichever structure the data actually has:
 *  order-0 for independent bytes, Z-axis for correlated bytes. */
function estimatePlaneCost(residuals: Int32Array): number {
    const n = residuals.length;
    if (n === 0) return 0;

    // determine plane count from max zigzag
    let maxZZ = 0;
    for (let i = 0; i < n; i++) {
        const v = residuals[i];
        const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
        if (zz > maxZZ) maxZZ = zz;
    }
    const planes = maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3;

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

// â”€â”€ bit I/O â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class BitWriter {
    private buf: number[] = [];
    private bits = 0;
    private acc = 0;

    write(value: number, nbits: number): void {
        if (nbits === 0) return;
        this.acc |= ((value & (((1 << nbits) >>> 0) - 1)) >>> 0) << this.bits;
        this.bits += nbits;
        while (this.bits >= 8) { this.buf.push(this.acc & 0xFF); this.acc >>>= 8; this.bits -= 8; }
    }

    flush(): Uint8Array {
        if (this.bits > 0) this.buf.push(this.acc & 0xFF);
        return new Uint8Array(this.buf);
    }
}

class BitReader {
    private data: Uint8Array;
    private pos = 0; private bits = 0; private acc = 0;
    constructor(data: Uint8Array) { this.data = data; }

    read(nbits: number): number {
        while (this.bits < nbits && this.pos < this.data.length) {
            this.acc |= this.data[this.pos++] << this.bits; this.bits += 8;
        }
        const mask = nbits === 32 ? 0xFFFFFFFF : ((1 << nbits) >>> 0) - 1;
        const val  = (this.acc & mask) >>> 0;
        if (nbits === 32) { this.acc = 0; this.bits = 0; }
        else { this.acc >>>= nbits; this.bits -= nbits; }
        return val;
    }
}

function riceEncode(bw: BitWriter, value: number, m: number): void {
    const q = value >>> m;
    if (q >= 15) {
        for (let i = 0; i < 15; i++) bw.write(0, 1);
        bw.write(value & 0x1FFFF, 17);
    } else {
        for (let i = 0; i < q; i++) bw.write(0, 1);
        bw.write(1, 1);
        if (m > 0) bw.write(value & ((1 << m) - 1), m);
    }
}

function riceDecode(br: BitReader, m: number): number {
    let q = 0;
    while (q < 15 && br.read(1) === 0) q++;
    if (q >= 15) return br.read(17);
    return (q << m) | (m > 0 ? br.read(m) : 0);
}

function estimateZeroRunBits(runLen: number, runAvg: number): number {
    if (runLen <= 0) return 0;
    if (runLen === 1) return 2;
    const mRun = runAvg === 0 ? 0 : Math.min(14, 31 - Math.clz32(runAvg));
    const code = runLen - 2;
    return 2 + 4 + (code >>> mRun) + 1 + mRun;
}

// â”€â”€ K/G trajectory encoding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// K (frequency) and G (damping rÂ²) have distinct physical statistics:
//   K tracks pitch, stable for pure tones and slowly drifting during vibrato.
//   G stays near 1 for tonal signals and rarely changes at all.
// Change-flags let each coefficient be omitted entirely when it hasn't moved.
// The residual itself is predicted from second-order motion, so smooth K/G
// glides collapse toward zero without changing the decoded trajectory.
//
// Wire format per block:
//   non-reset: [reset:1=0][kChanged:1][gChanged:1] + if kChanged: [mK:4b+Rice(zk,mK)] + if gChanged: [mG:4b+Rice(zg,mG)]
//   reset path (zigzag > 0x7FFF): [reset:1=1][K:16b][G:16b]
//
// Minimum cost when both are stable: 3 bits/block = 0.094 bps.
// Dead-zone upstream in fitAllBlocks ensures Kint/Gint are already committed values,
// so the flags stay zero for stable signals without any extra logic here.
/** Meta-prediction: fit AR(1) to the K and G trajectories themselves.
 *  the prediction parameters trace orbits in parameter space â€” vibrato
 *  produces oscillating K, pitch glides produce drifting K, sustained
 *  tones produce constant K. the meta-oscillator captures this dynamics,
 *  reducing trajectory entropy by 40-100% across real audio.
 *  returns the meta-coefficients and replaces each Kint/Gint with its
 *  meta-residual (smaller values â†’ shorter Rice codes â†’ fewer bits). */
function metaPredictKG(blocks: { Kint: number; Gint: number }[]): {
    metaKK: number; metaGK: number;
} {
    const n = blocks.length;
    if (n < 3) return { metaKK: 0, metaGK: 0 };

    // fit AR(1) to Kint trajectory: Kint[b] â‰ˆ Î±Â·Kint[b-1]
    // scale 64: Î± âˆˆ [-2, 2) maps to [-128, 127] (signed 8-bit safe)
    let sxx = 0, sxv = 0;
    for (let b = 2; b < n; b++) {
        const dvPrev = blocks[b - 1].Kint - blocks[b - 2].Kint;
        const dvNext = blocks[b].Kint - blocks[b - 1].Kint;
        sxx += dvPrev * dvPrev;
        sxv += dvPrev * dvNext;
    }
    const metaKK = sxx > 0 ? Math.max(-128, Math.min(127, Math.round(sxv / sxx * 64))) : 0;

    sxx = 0; sxv = 0;
    for (let b = 2; b < n; b++) {
        const dvPrev = blocks[b - 1].Gint - blocks[b - 2].Gint;
        const dvNext = blocks[b].Gint - blocks[b - 1].Gint;
        sxx += dvPrev * dvPrev;
        sxv += dvPrev * dvNext;
    }
    const metaGK = sxx > 0 ? Math.max(-128, Math.min(127, Math.round(sxv / sxx * 64))) : 0;

    return { metaKK, metaGK };
}

function encodeKGTrajectoryLegacy(
    blocks: { Kint: number; Gint: number }[],
    metaKK: number = 0, metaGK: number = 0,
): Uint8Array {
    const bw = new BitWriter();
    let decKint = 0, decGint = 0;
    let prevKint = 0, prevGint = 0;
    let runK = 0, runG = 0;
    for (const { Kint, Gint } of blocks) {
        const velK = decKint - prevKint;
        const velG = decGint - prevGint;
        const predK = decKint + ((metaKK * velK + 32) >> 6);
        const predG = decGint + ((metaGK * velG + 32) >> 6);
        const dk = Kint - predK, dg = Gint - predG;
        const zk = zigzagEnc(dk) >>> 0, zg = zigzagEnc(dg) >>> 0;
        if (zk > 0x7FFF || zg > 0x7FFF) {
            bw.write(1, 1);
            bw.write(Kint & 0xFFFF, 16); bw.write(Gint & 0xFFFF, 16);
            prevKint = decKint; prevGint = decGint;
            decKint = Kint; decGint = Gint;
            runK = 0; runG = 0;
        } else {
            bw.write(0, 1);
            const kChanged = zk !== 0 ? 1 : 0;
            const gChanged = zg !== 0 ? 1 : 0;
            bw.write(kChanged, 1);
            bw.write(gChanged, 1);
            if (kChanged) {
                const mK = runK === 0 ? 0 : Math.min(14, 31 - Math.clz32(runK));
                bw.write(mK, 4);
                riceEncode(bw, zk, mK);
            }
            if (gChanged) {
                const mG = runG === 0 ? 0 : Math.min(14, 31 - Math.clz32(runG));
                bw.write(mG, 4);
                riceEncode(bw, zg, mG);
            }
            prevKint = decKint; prevGint = decGint;
            decKint = predK + dk;
            decGint = predG + dg;
            runK = (runK + zk) >>> 1;
            runG = (runG + zg) >>> 1;
        }
    }
    return bw.flush();
}

function encodeKGTrajectoryRunAware(
    blocks: { Kint: number; Gint: number }[],
    metaKK: number = 0, metaGK: number = 0,
): Uint8Array {
    const bw = new BitWriter();
    let decKint = 0, decGint = 0;
    let prevKint = 0, prevGint = 0;
    let runK = 0, runG = 0;
    let zeroRun = 0;
    let runZ = 0;
    const flushZeroRun = (): void => {
        if (zeroRun <= 0) return;
        if (zeroRun === 1) {
            bw.write(0, 2);
        } else {
            bw.write(1, 2);
            const code = zeroRun - 2;
            const mRun = runZ === 0 ? 0 : Math.min(14, 31 - Math.clz32(runZ));
            bw.write(mRun, 4);
            riceEncode(bw, code, mRun);
            runZ = (runZ + code) >>> 1;
        }
        zeroRun = 0;
    };
    for (const { Kint, Gint } of blocks) {
        const velK = decKint - prevKint;
        const velG = decGint - prevGint;
        const predK = decKint + ((metaKK * velK + 32) >> 6);
        const predG = decGint + ((metaGK * velG + 32) >> 6);
        const dk = Kint - predK, dg = Gint - predG;
        const zk = zigzagEnc(dk) >>> 0, zg = zigzagEnc(dg) >>> 0;
        if (zk === 0 && zg === 0) {
            zeroRun++;
            prevKint = decKint; prevGint = decGint;
            decKint = Kint; decGint = Gint;
            continue;
        }
        flushZeroRun();
        if (zk > 0x7FFF || zg > 0x7FFF) {
            bw.write(3, 2);
            bw.write(Kint & 0xFFFF, 16); bw.write(Gint & 0xFFFF, 16);
            prevKint = decKint; prevGint = decGint;
            decKint = Kint; decGint = Gint;
            runK = 0; runG = 0;
        } else {
            bw.write(2, 2);
            const kChanged = zk !== 0 ? 1 : 0;
            const gChanged = zg !== 0 ? 1 : 0;
            bw.write(kChanged, 1);
            bw.write(gChanged, 1);
            if (kChanged) {
                const mK = runK === 0 ? 0 : Math.min(14, 31 - Math.clz32(runK));
                bw.write(mK, 4);
                riceEncode(bw, zk, mK);
            }
            if (gChanged) {
                const mG = runG === 0 ? 0 : Math.min(14, 31 - Math.clz32(runG));
                bw.write(mG, 4);
                riceEncode(bw, zg, mG);
            }
            prevKint = decKint; prevGint = decGint;
            decKint = predK + dk;
            decGint = predG + dg;
            runK = (runK + zk) >>> 1;
            runG = (runG + zg) >>> 1;
        }
    }
    flushZeroRun();
    return bw.flush();
}

function buildKGTrajectoryPayload(
    blocks: { Kint: number; Gint: number }[],
    metaKK: number = 0, metaGK: number = 0,
): { raw: Uint8Array; compressed: Uint8Array } {
    const legacyBody = encodeKGTrajectoryLegacy(blocks, metaKK, metaGK);
    const legacy = new Uint8Array(legacyBody.length + 1);
    legacy[0] = KG_TRAJ_WIRE_LEGACY;
    legacy.set(legacyBody, 1);

    const runAwareBody = encodeKGTrajectoryRunAware(blocks, metaKK, metaGK);
    const runAware = new Uint8Array(runAwareBody.length + 1);
    runAware[0] = KG_TRAJ_WIRE_RUN_AWARE;
    runAware.set(runAwareBody, 1);

    const legacyCompressed = encode0D(legacy);
    const runAwareCompressed = encode0D(runAware);
    if (runAwareCompressed.length < legacyCompressed.length) {
        return { raw: runAware, compressed: runAwareCompressed };
    }
    if (legacyCompressed.length < runAwareCompressed.length) {
        return { raw: legacy, compressed: legacyCompressed };
    }
    const useRunAware = runAware.length < legacy.length;
    if (useRunAware) return { raw: runAware, compressed: runAwareCompressed };
    return { raw: legacy, compressed: legacyCompressed };
}

function decodeKGTrajectoryLegacy(
    kgBitsData: Uint8Array, numBlocks: number,
    metaKK: number = 0, metaGK: number = 0,
): { Kint: number; Gint: number }[] {
    const br = new BitReader(kgBitsData);
    const blocks: { Kint: number; Gint: number }[] = [];
    let prevKint = 0, prevGint = 0, runK = 0, runG = 0;
    let prev2Kint = 0, prev2Gint = 0;
    for (let b = 0; b < numBlocks; b++) {
        let Kint: number, Gint: number;
        if (br.read(1) !== 0) {
            Kint = (br.read(16) << 16) >> 16;
            Gint = (br.read(16) << 16) >> 16;
            runK = 0; runG = 0;
        } else {
            const kChanged = br.read(1);
            const gChanged = br.read(1);
            let zk = 0, zg = 0;
            if (kChanged) {
                const mK = br.read(4);
                zk = riceDecode(br, mK);
            }
            if (gChanged) {
                const mG = br.read(4);
                zg = riceDecode(br, mG);
            }
            const velK = prevKint - prev2Kint;
            const velG = prevGint - prev2Gint;
            const predK = prevKint + ((metaKK * velK + 32) >> 6);
            const predG = prevGint + ((metaGK * velG + 32) >> 6);
            Kint = predK + zigzagDec(zk);
            Gint = predG + zigzagDec(zg);
            runK = (runK + zk) >>> 1;
            runG = (runG + zg) >>> 1;
        }
        blocks.push({ Kint, Gint });
        prev2Kint = prevKint; prev2Gint = prevGint;
        prevKint = Kint; prevGint = Gint;
    }
    return blocks;
}

function decodeKGTrajectoryRunAware(
    kgBitsData: Uint8Array, numBlocks: number,
    metaKK: number = 0, metaGK: number = 0,
): { Kint: number; Gint: number }[] {
    const br = new BitReader(kgBitsData);
    const blocks: { Kint: number; Gint: number }[] = [];
    let prevKint = 0, prevGint = 0, runK = 0, runG = 0;
    let prev2Kint = 0, prev2Gint = 0;
    let runZ = 0;
    for (let b = 0; b < numBlocks; ) {
        const tag = br.read(2);
        if (tag === 0 || tag === 1) {
            const zeroRun = tag === 0 ? 1 : (() => {
                const mRun = br.read(4);
                const code = riceDecode(br, mRun);
                runZ = (runZ + code) >>> 1;
                return code + 2;
            })();
            for (let r = 0; r < zeroRun && b < numBlocks; r++, b++) {
                const velK = prevKint - prev2Kint;
                const velG = prevGint - prev2Gint;
                const Kint = prevKint + ((metaKK * velK + 32) >> 6);
                const Gint = prevGint + ((metaGK * velG + 32) >> 6);
                blocks.push({ Kint, Gint });
                prev2Kint = prevKint; prev2Gint = prevGint;
                prevKint = Kint; prevGint = Gint;
            }
            continue;
        }
        let Kint: number, Gint: number;
        if (tag === 3) {
            Kint = (br.read(16) << 16) >> 16;
            Gint = (br.read(16) << 16) >> 16;
            runK = 0; runG = 0;
        } else {
            const kChanged = br.read(1);
            const gChanged = br.read(1);
            let zk = 0, zg = 0;
            if (kChanged) {
                const mK = br.read(4);
                zk = riceDecode(br, mK);
            }
            if (gChanged) {
                const mG = br.read(4);
                zg = riceDecode(br, mG);
            }
            const velK = prevKint - prev2Kint;
            const velG = prevGint - prev2Gint;
            const predK = prevKint + ((metaKK * velK + 32) >> 6);
            const predG = prevGint + ((metaGK * velG + 32) >> 6);
            Kint = predK + zigzagDec(zk);
            Gint = predG + zigzagDec(zg);
            runK = (runK + zk) >>> 1;
            runG = (runG + zg) >>> 1;
        }
        blocks.push({ Kint, Gint });
        prev2Kint = prevKint; prev2Gint = prevGint;
        prevKint = Kint; prevGint = Gint;
        b++;
    }
    return blocks;
}

function decodeKGTrajectory(
    kgBitsData: Uint8Array, numBlocks: number,
    metaKK: number = 0, metaGK: number = 0,
): { Kint: number; Gint: number }[] {
    if (kgBitsData.length === 0) return [];
    const mode = kgBitsData[0];
    const body = kgBitsData.subarray(1);
    if (mode === KG_TRAJ_WIRE_RUN_AWARE) return decodeKGTrajectoryRunAware(body, numBlocks, metaKK, metaGK);
    return decodeKGTrajectoryLegacy(body, numBlocks, metaKK, metaGK);
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

// â”€â”€ write K/G trajectory to WASM memory for test inspection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Tests read KG_BUF as Int32Array [Kint, Gint, Kint, Gint, ...] per block.
// numBlocks = ceil(numSamples/32) * numChannels (channels interleaved by block).
// Synchronous â€” called with an already-resolved wasm instance so the view
// is never detached by a concurrent memory.grow.

function writeKGToWasmSync(
    wasm: HarmonicWasmExports,
    kgPerChannel: { Kint: number; Gint: number }[][],
    numSamples: number,
): void {
    const numChannels = kgPerChannel.length;
    const numBlocks   = Math.ceil(numSamples / BLOCK_LEN);
    const bytesNeeded = KG_BUF + numBlocks * numChannels * 8 + 1024;
    ensureWasmMem(wasm, bytesNeeded);

    // Create view AFTER potential grow so it's never detached.
    const view = new Int32Array(wasm.memory.buffer);
    let off = KG_BUF >> 2;

    // Interleave: block 0 ch0, block 0 ch1, block 1 ch0, block 1 ch1, ...
    for (let b = 0; b < numBlocks; b++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const kg = kgPerChannel[ch];
            if (b < kg.length) {
                view[off++] = kg[b].Kint;
                view[off++] = kg[b].Gint;
            }
        }
    }
}

// â”€â”€ prediction via WASM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function wasmPredictEnc(
    wasm: HarmonicWasmExports,
    data: Int32Array,
    blocks: { K: number; G: number }[],
    stateOffset: number,
    qstep: number = 1,
): Int32Array {
    const n = data.length, nBlocks = blocks.length;
    const dataOff  = WASM_BUF_A;
    const residOff = dataOff + n * 4;
    const kgOff    = (residOff + n * 4 + 15) & ~15;
    ensureWasmMem(wasm, kgOff + nBlocks * 8 + 64);

    copyI32ToWasm(wasm, dataOff, data);

    const kgView = new Float32Array(wasm.memory.buffer, kgOff, nBlocks * 2);
    for (let i = 0; i < nBlocks; i++) {
        kgView[i * 2]     = blocks[i].K;
        kgView[i * 2 + 1] = blocks[i].G;
    }

    const sv = new Float32Array(wasm.memory.buffer, stateOffset, 2);
    sv[0] = 0; sv[1] = 0;
    new Int32Array(wasm.memory.buffer, stateOffset + 8, 1)[0] = qstep;

    wasm.predict_enc(dataOff, n, kgOff, stateOffset, residOff);
    return readI32FromWasm(wasm, residOff, n);
}

function wasmPredictDec(
    wasm: HarmonicWasmExports,
    residuals: Int32Array,
    blocks: { K: number; G: number }[],
    stateOffset: number,
    outOffset: number,
    qstep: number = 1,
): Int32Array {
    const n = residuals.length, nBlocks = blocks.length;
    const residOff = WASM_BUF_A;
    const kgOff    = (Math.max(outOffset + n * 4, residOff + n * 4) + 15) & ~15;
    ensureWasmMem(wasm, kgOff + nBlocks * 8 + 64);

    copyI32ToWasm(wasm, residOff, residuals);

    const kgView = new Float32Array(wasm.memory.buffer, kgOff, nBlocks * 2);
    for (let i = 0; i < nBlocks; i++) {
        kgView[i * 2]     = blocks[i].K;
        kgView[i * 2 + 1] = blocks[i].G;
    }

    const sv = new Float32Array(wasm.memory.buffer, stateOffset, 2);
    sv[0] = 0; sv[1] = 0;
    new Int32Array(wasm.memory.buffer, stateOffset + 8, 1)[0] = qstep;

    wasm.predict_dec(residOff, n, kgOff, stateOffset, outOffset);
    return readI32FromWasm(wasm, outOffset, n);
}

// â”€â”€ public encode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// wire format:
//   header (12 B, cleartext):
//     numSamples:u32  sampleRate:u32  flags:u16  numCh:u8  numLevels:u8
//     flags: quality(bits 15..8) | depth(bits 6..5) | layout(bits 4..3)
//            | BURG_FLAG(0x04) | HARMONIC_FLAG(0x02) | compressed(0x01)
//     layout: 00=channel (auto M/S or Hadamard), 01=object-based
//     depth:  00=float32, 01=16-bit, 10=24-bit, 11=reserved
//   encrypted payload (ChaCha20):
//     framePeak: f32, scalar: u32
//     if layout == object:
//       for each channel: azimuth:f32 elevation:f32 distance:f32
//     for each channel: refIndex:u8 (0xFF = independent, else ref channel)
//     envelopeMask: bytes
//     for each coupled channel (refIndex != 0xFF): W:i16 (coupling coefficient)
//     effectiveChannels: u8
//     for each effective channel:
//       if envelopeMask bit set:
//         envBlockLen:u32 envCount:u32 envWireLen:u32 envWire
//       burgOrigLen:u32                      (0 = no Burg for this channel)
//       if burgOrigLen > 0:
//         burgCompLen:u32  burgData          (Logos-compressed Burg trajectory)
//       metaKK:u8  metaGK:u8                (trajectory velocity-carry coefficients, signed+128)
//       kgOrigLen:u32  kgCompLen:u32         (Logos-compressed Rice-coded K/G trajectory)
//       kgData: bytes
//       useMicro:u8                          (1 = micro-oscillator active)
//       if useMicro:
//         metaMK:u8  metaMG:u8              (micro-osc meta-prediction)
//         kg2OrigLen:u32  kg2CompLen:u32     (Logos-compressed micro-osc trajectory)
//         kg2Data: bytes
//       useDelta:u8                          (1 = delta pre-filter active)
//       useTrajectory:u8                     (1 = Farmer-Sidorowich active)
//       harmonicHeader: u16(numVoiced) u8(maxH)  (0,0,0 = no harmonics)
//       if numVoiced > 0:
//         voicedMask + cos/sin fields        (2D MÃ¶bius + per-field plane encoding)
//       numSubbands: u8                      (1 if wavelet skipped, 4 if active)
//       for each subband:
//         sbLen:u32  planeCount:u8           (0=zeroed, 1=lo, 2=mid+lo, 3=all)
//       globalMaxPlane: u8
//       for each active plane level:
//         compLen:u32  data                  (Logos-encoded concatenated plane bytes)
//   mac0:u32  mac1:u32                       (SipHash-lite 64-bit over ciphertext)

export interface HarmonicOptions {
    /** quantization quality 1-100. default 80. 100 = raw float32. */
    quality?: number;
    /** number of interleaved channels. default 1. */
    numChannels?: number;
    /** cross-frame streaming state (trajectory predictor window). */
    state?: HarmonicState;
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
    const burgSuperLen = adaptiveBurgSuperLen(sampleRate);
    const envelopeBlockLen = envelopeBlockLenFromBurgSuperLen(burgSuperLen);
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
                )
            : { candidates: [], baselineFitBits: 0 };
        amplitudeBaselineFitBits.push(amplitudeAxis.baselineFitBits);
        amplitudeCandidates.push(amplitudeAxis.candidates);
    }
    const effectiveChannels = numChannels;
    let couplingRefs: number[] = [];
    let totalObjective = 0;
    const axisPasses = layout !== "object" && numChannels > 1 ? 3 : 1;
    for (let pass = 0; pass < axisPasses; pass++) {
        totalObjective = 0;
        if (layout !== "object" && numChannels > 1 && numSamples >= BLOCK_LEN) {
            couplingRefs = assignReferences(channels, numSamples);
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

    if (layout !== "object" && numChannels > 1 && numSamples >= BLOCK_LEN) {
        couplingRefs = assignReferences(channels, numSamples);
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
        );
        if (candidatePrepared.totalObjective < prepared.totalObjective) {
            scalar = candidateScalar;
            framePeak = candidatePeak;
            prepared = candidatePrepared;
        }
    }
    const channels = prepared.channels;
    const channelEnergy = prepared.channelEnergy;
    const channelEnvelopes = prepared.channelEnvelopes;
    const channelEnvelopeBlockLens = prepared.channelEnvelopeBlockLens;
    const channelEnvelopeWire = prepared.channelEnvelopeWire;
    const effectiveChannels = prepared.effectiveChannels;
    let couplingRefs = prepared.couplingRefs;

    payloadReset();
    payloadF32(framePeak);
    // store the actual scalar used. u32 to cover the full range including
    // 24-bit mode (scalar=8388608). the decoder reads this directly â€”
    // no formula inversion needed.
    payloadU32(scalar);

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

        // cross-channel coupling: subtract W·ref, trial-gated via varOrder cost
        const refIdx = couplingRefs[ch] ?? NO_REF;
        const refData = refIdx !== NO_REF ? channels[refIdx] : undefined;
        let channelW: { Wint: number; W: number } | undefined;
        if (refData && numSamples >= BLOCK_LEN) {
            const wFit = fitCouplingW(data, refData, numSamples);
            if (Math.abs(wFit.W) > 0.01) {
                const decoupled = new Int32Array(numSamples);
                for (let i = 0; i < numSamples; i++) {
                    const wr = wFit.W * refData[i];
                    decoupled[i] = data[i] - (wr >= 0 ? (wr + 0.5) | 0 : (wr - 0.5) | 0);
                }
                const blocksOrig = varOrderFitAllBlocks(data, numSamples);
                const residOrig = varOrderPredictEnc(data, numSamples, blocksOrig);
                const blocksDec = varOrderFitAllBlocks(decoupled, numSamples);
                const residDec = varOrderPredictEnc(decoupled, numSamples, blocksDec);
                const costOrig = estimatePlaneCost(residOrig) + estimateCoeffBits(blocksOrig) / 8;
                const costDec = estimatePlaneCost(residDec) + estimateCoeffBits(blocksDec) / 8;
                if (costDec + 2 < costOrig) {
                    data = decoupled;
                    channelW = wFit;
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

        // unified variable-order prediction
        const varBlocks = varOrderFitAllBlocks(data, numSamples);
        const residuals = varOrderPredictEnc(data, numSamples, varBlocks);

        // coefficient stream
        const { raw: coeffRaw, compressed: coeffComp } = encodeCoeffStream(varBlocks);
        payloadU32(coeffRaw.length);
        payloadU32(coeffComp.length);
        payloadAppend(coeffComp);

        // wavelet decomposition
        const subbands = waveletDecompose(wasm, residuals, numLevels);

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
                    const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
                    if (zz > maxZZ) maxZZ = zz;
                }
                const pc = maxZZ < 256 ? 1 : maxZZ < 65536 ? 2 : 3;
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

        // build concatenated plane streams and encode each with one Logos call
        for (let plane = 0; plane < globalMaxPlane; plane++) {
            let totalBytes = 0;
            for (let sb = 0; sb < numSb; sb++) {
                if (sbPlaneCount[sb] > 0) totalBytes += subbands[sb].length;
            }
            const concat = new Uint8Array(totalBytes);
            let off = 0;
            for (let sb = 0; sb < numSb; sb++) {
                if (sbPlaneCount[sb] === 0) continue;
                const d = subbands[sb];
                const shift = plane * 8;
                for (let i = 0; i < d.length; i++) {
                    const v = d[i];
                    const zz = (v >= 0 ? v * 2 : (-v * 2 - 1)) >>> 0;
                    concat[off++] = (zz >>> shift) & 0xFF;
                }
            }
            const encoded = encode0D(concat.subarray(0, off));
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
    ov.setUint16(8, ((quality & 0xFF) << 8) | 1 | layoutFlag | depthFlag, true);
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

    if (isRaw) {
        return decodeRawMode(encoded, numSamples, sampleRate, numChannels, encryptionKey);
    }

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
        let envCurve: Float32Array | null = null;
        const hasEnvelope = ((envelopeMask[ch >> 3] >> (ch & 7)) & 1) !== 0;
        if (hasEnvelope) {
            const envBlockLen = readU32LE(p, off); off += 4;
            const envCount = readU32LE(p, off); off += 4;
            const envWireLen = readU32LE(p, off); off += 4;
            const envLog = decodeEnvelopeTrajectory(wasm, p.subarray(off, off + envWireLen), envCount); off += envWireLen;
            envCurve = reconstructEnvelopeCurve(envLog, numSamples, Math.max(BLOCK_LEN, envBlockLen), framePeak);
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

        // decode coefficient stream
        const numBlocks = Math.ceil(numSamples / BLOCK_LEN);
        const coeffOrigLen = readU32LE(p, off); off += 4;
        const coeffCompLen = readU32LE(p, off); off += 4;
        const coeffRaw = decode0D(p.subarray(off, off + coeffCompLen), coeffOrigLen); off += coeffCompLen;
        const varBlocks = decodeCoeffStream(coeffRaw, numBlocks);

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
                if (sbPlanes[sb] > 0) totalBytes += sbLens[sb];
            }
            const compLen = readU32LE(p, off); off += 4;
            planeData.push(decode0D(p.subarray(off, off + compLen), totalBytes));
            off += compLen;
        }

        // reconstruct subbands from plane slices
        const subbands: Int32Array[] = [];
        let planeOff = 0;
        for (let sb = 0; sb < numSubbands; sb++) {
            const n = sbLens[sb];
            if (sbPlanes[sb] === 0) {
                subbands.push(new Int32Array(n));
                continue;
            }
            const out = new Int32Array(n);
            if (globalMaxPlane === 1) {
                const lo = planeData[0];
                for (let i = 0; i < n; i++) out[i] = zigzagDec(lo[planeOff + i]);
            } else if (globalMaxPlane === 2) {
                const lo = planeData[0], mid = planeData[1];
                for (let i = 0; i < n; i++) {
                    out[i] = zigzagDec(((mid[planeOff + i] << 8) | lo[planeOff + i]) >>> 0);
                }
            } else {
                const lo = planeData[0], mid = planeData[1], top = planeData[2];
                for (let i = 0; i < n; i++) {
                    out[i] = zigzagDec(((top[planeOff + i] << 16) | (mid[planeOff + i] << 8) | lo[planeOff + i]) >>> 0);
                }
            }
            planeOff += n;
            subbands.push(out);
        }

        // wavelet reconstruct -> varOrder prediction inverse
        const waveletResiduals = waveletReconstruct(wasm, subbands);
        let reconstructed = varOrderPredictDec(waveletResiduals, numSamples, varBlocks);

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
            varOrderCellProject(projected, reconstructed, varBlocks);
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
