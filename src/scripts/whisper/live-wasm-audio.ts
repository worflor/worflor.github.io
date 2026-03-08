/**
 * live-wasm-audio.ts
 *
 * the Whisper Harmonic Audio Codec by Woflo / MB
 *
 * models audio as a symmetric damped harmonic oscillator rather than a
 * frequency transform. the predictor is:
 *
 *   pred = K·prev₁ − G·prev₂
 *
 * K (tension) and G (friction) are fitted per 32-sample block via a scalar
 * joint 2×2 normal-equation regression: for a pure sinusoid at frequency ω,
 * the solution is exactly K = 2cos(ω), G = 1. residuals are Golomb-Rice coded
 * with a per-block adaptive M derived from mean residual magnitude.
 *
 * stereo uses Mid/Side decomposition: Mid = (L+R)/2, Side = L−R, each channel
 * carrying its own K/G pair so the soundstage is preserved, not averaged out.
 *
 * the codec emits raw WebAssembly bytecode from TypeScript arrays; no
 * toolchain, no .wasm files, no build step.
 *
 * wire format per block (36-bit header + variable payload):
 *   [K:16][G:16][M:4] [Rice(M)-coded residuals₀..₃₁]
 *
 * encryption: ChaCha20 stream cipher + SipHash-lite 64-bit MAC.
 * quality: Q=80 → scalar=4096 (~79 dB SNR). Q=100 → lossless float32 passthrough.
 *
 * the wire carries oscillator parameters. the decoder reconstructs the waveform.
 */

function encodeULEB(v: number): number[] {
    v = v >>> 0;
    const out: number[] = [];
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) b |= 0x80;
        out.push(b);
    } while (v !== 0);
    return out;
}

function encodeSLEB(v: number): number[] {
    v = v | 0;
    const out: number[] = [];
    let done = false;
    while (!done) {
        let b = v & 0x7f;
        v >>= 7;
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

const Op = {
    I32: 0x7f,
    VOID: 0x40,
    I32_CONST: 0x41,
    I64_CONST: 0x42,
    F32_CONST: 0x43,
    BLOCK: 0x02,
    LOOP: 0x03,
    IF: 0x04,
    ELSE: 0x05,
    END: 0x0b,
    BR: 0x0c,
    BR_IF: 0x0d,
    RETURN: 0x0f,
    LOCAL_GET: 0x20,
    LOCAL_SET: 0x21,
    // Memory
    I32_LOAD: 0x28,
    F32_LOAD: 0x2a,
    I32_LOAD8_U: 0x2d,
    I32_STORE: 0x36,
    F32_STORE: 0x38,
    I32_STORE8: 0x3a,
    // I32 Math
    I32_EQ: 0x46,
    I32_LT_S: 0x48,
    I32_LT_U: 0x49,
    I32_GT_S: 0x4a,
    I32_GT_U: 0x4b,
    I32_GE_S: 0x4e,
    I32_GE_U: 0x4f,
    I32_CLZ: 0x67,
    I32_ADD: 0x6a,
    I32_SUB: 0x6b,
    I32_MUL: 0x6c,
    I32_DIV_S: 0x6d,
    I32_AND: 0x71,
    I32_OR: 0x72,
    I32_XOR: 0x73,
    I32_SHL: 0x74,
    I32_SHR_S: 0x75,
    I32_SHR_U: 0x76,
    I32_ROTL: 0x77,
    // I64 Math
    I64_AND: 0x83,
    I64_OR: 0x84,
    I64_XOR: 0x85,
    I64_SHL: 0x86,
    I64_SHR_U: 0x88,
    I64_CTZ: 0x7a,
    // F32 Math
    F32_ABS: 0x8b,
    F32_NEAREST: 0x90,
    F32_ADD: 0x92,
    F32_SUB: 0x93,
    F32_MUL: 0x94,
    F32_DIV: 0x95,
    F32_LT: 0x5d,
    F32_MIN: 0x96,
    F32_MAX: 0x97,
    // Conversions
    I32_WRAP_I64: 0xa7,
    I64_EXTEND_I32_U: 0xad,
    F32_CONVERT_I32_S: 0xb2,
    I32_TRUNC_SAT_F32_S: [0xfc, 0x00],
    // Types
    F32: 0x7d,
    I64: 0x7e,
    V128: 0x7b,
    FUNC: 0x60,
    // SIMD (Prefixed with 0xfd, use SIMD() helper)
    V128_LOAD: 0x00,
    V128_STORE: 0x0b,
    I32X4_SPLAT: 0x11,
    I32X4_ADD: 0xae,
    I32X4_SUB: 0xb1,
    I32X4_SHL: 0xab,
    F32X4_SPLAT: 0x13,
    F32X4_EXTRACT_LANE: 0x1f, // also used by EXTRACT_F32 helper
    F32X4_ADD: 0xe4, // 228
    F32X4_SUB: 0xe5, // 229
    F32X4_MUL: 0xe6, // 230
    F32X4_DIV: 0xe7, // 231
    F32X4_ABS: 0xe0,
    F32X4_MAX: 0xe9,
    F32X4_NEAREST: 0x6a,
    I32X4_TRUNC_SAT_F32X4_S: 0xf8,
    F32X4_CONVERT_I32X4_S: 0xfa,
    I32X4_SHUFFLE: 0x0d,
    V128_CONST: 0x0c,
};

const I32 = Op.I32;
const VOID = Op.VOID;

const GET = (i: number) => [Op.LOCAL_GET, ...encodeULEB(i)];
const SET = (i: number) => [Op.LOCAL_SET, ...encodeULEB(i)];
const CI32 = (v: number) => [Op.I32_CONST, ...encodeSLEB(v)];
const BR = (l: number) => [Op.BR, ...encodeULEB(l)];
const BRIF = (l: number) => [Op.BR_IF, ...encodeULEB(l)];
const BLOCK = [Op.BLOCK, VOID];
const LOOP = [Op.LOOP, VOID];
const IF = [Op.IF, VOID];
const IF_I32 = [Op.IF, I32];
const ELSE = [Op.ELSE];
const END = [Op.END];
const RETURN = [Op.RETURN];

const LOAD8u = (al: number, off: number) => [Op.I32_LOAD8_U, al, ...encodeULEB(off)];
const LOAD32 = (al: number, off: number) => [Op.I32_LOAD, al, ...encodeULEB(off)];
const STORE8 = (al: number, off: number) => [Op.I32_STORE8, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [Op.I32_STORE, al, ...encodeULEB(off)];
const STOREF32 = (al: number, off: number) => [Op.F32_STORE, al, ...encodeULEB(off)];
const LOADF32 = (al: number, off: number) => [Op.F32_LOAD, al, ...encodeULEB(off)];
const I32_TRUNC_SAT_F32_S = Op.I32_TRUNC_SAT_F32_S;
const F32_CONVERT_I32_S = [Op.F32_CONVERT_I32_S];
const I64_EXTEND_I32_U = [Op.I64_EXTEND_I32_U];
const I32_WRAP_I64 = [Op.I32_WRAP_I64];
const I64_SHL = [Op.I64_SHL];
const I64_SHR_u = [Op.I64_SHR_U];
const I64_OR = [Op.I64_OR];
const I64_XOR_op = [Op.I64_XOR];
const I64_AND_op = [Op.I64_AND];
const I64_CTZ_op = [Op.I64_CTZ];
const CI64 = (v: number) => [Op.I64_CONST, ...encodeSLEB(v)];

const V128 = Op.V128;
const SIMD = (op: number) => [0xfd, ...encodeULEB(op)];

const LOADV128 = (al: number, off: number) => [...SIMD(Op.V128_LOAD), al, ...encodeULEB(off)];
const STOREV128 = (al: number, off: number) => [...SIMD(Op.V128_STORE), al, ...encodeULEB(off)];
const CV128 = (bytes: number[]) => [...SIMD(Op.V128_CONST), ...bytes]; // 16 bytes
const FSPLAT = SIMD(Op.F32X4_SPLAT);
const I32_SPLAT = SIMD(Op.I32X4_SPLAT);
const FADDV = SIMD(Op.F32X4_ADD);
const FSUBV = SIMD(Op.F32X4_SUB);
const I32ADDV = SIMD(Op.I32X4_ADD);
const I32SUBV = SIMD(Op.I32X4_SUB);
const FMULV = SIMD(Op.F32X4_MUL);
const FDIVV = SIMD(Op.F32X4_DIV);
const FABS_V = SIMD(Op.F32X4_ABS);
const FMAX_V = SIMD(Op.F32X4_MAX);
const I32X4_SHL_V = SIMD(Op.I32X4_SHL);
const I32X4_TRUNC_V = SIMD(Op.I32X4_TRUNC_SAT_F32X4_S);
const F32X4_CONVERT_V = SIMD(Op.F32X4_CONVERT_I32X4_S);
const F32X4_NEAREST_V = SIMD(Op.F32X4_NEAREST);

const SHUFFLE = (lanes: number[]) => [...SIMD(Op.I32X4_SHUFFLE), ...lanes];

const EXTRACT_F32 = (lane: number) => [...SIMD(Op.F32X4_EXTRACT_LANE), lane];

// horizontal sum of f32x4 vector
function f32x4_hsum(vecReg: number): number[] {
    return [
        ...GET(vecReg), ...GET(vecReg), ...GET(vecReg), ...SHUFFLE([8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7]), ...FADDV, ...SET(vecReg),
        ...GET(vecReg), ...GET(vecReg), ...GET(vecReg), ...SHUFFLE([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]), ...FADDV, ...EXTRACT_F32(0)
    ];
}

// horizontal max of f32x4 vector
function f32x4_hmax(vecReg: number): number[] {
    return [
        ...GET(vecReg), ...GET(vecReg), ...GET(vecReg), ...SHUFFLE([8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7]), ...FMAX_V, ...SET(vecReg),
        ...GET(vecReg), ...GET(vecReg), ...GET(vecReg), ...SHUFFLE([4, 5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11]), ...FMAX_V, ...EXTRACT_F32(0)
    ];
}

const ADD = [Op.I32_ADD];
const SUB = [Op.I32_SUB];
const MUL = [Op.I32_MUL];
const DIV = [Op.I32_DIV_S]; // i32.div_s
const SHL = [Op.I32_SHL];
const SHR_s = [Op.I32_SHR_S];
const SHR_u = [Op.I32_SHR_U];
const ROTL = [Op.I32_ROTL];
const AND = [Op.I32_AND];
const OR = [Op.I32_OR];
const XOR = [Op.I32_XOR];
const CLZ = [Op.I32_CLZ];

const EQ = [Op.I32_EQ];
const LT_s = [Op.I32_LT_S];
const LT_u = [Op.I32_LT_U];
const GT_s = [Op.I32_GT_S];
const GT_u = [Op.I32_GT_U];
const GE_s = [Op.I32_GE_S];
const GE_u = [Op.I32_GE_U];

const F32_NEAREST = [Op.F32_NEAREST];
const F32_ADD = [Op.F32_ADD];
const F32_SUB = [Op.F32_SUB];
const F32_MUL = [Op.F32_MUL];
const F32_DIV = [Op.F32_DIV];
const F32_LT = [Op.F32_LT];
const F32_MIN = [Op.F32_MIN];
const F32_MAX = [Op.F32_MAX];

const F32_CONST = (v: number): number[] => {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = v;
    return [Op.F32_CONST, ...Array.from(new Uint8Array(buf))];
};
const F32 = Op.F32;
const I64 = Op.I64;

function encodeLocals(decls: { count: number; type: number }[]): number[] {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}

function funcBody(locals: { count: number; type: number }[], instr: number[]): number[] {
    const body = [...encodeLocals(locals), ...instr.flat(), Op.END];
    return [...encodeULEB(body.length), ...body];
}

// murmur3 finalizer — diffuses bits for key ratchet
function avalanche(reg: number): number[] {
    return [
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR,
        ...CI32(0x85EBCA6B), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(13), ...SHR_u, ...XOR,
        ...CI32(0xC2B2AE35), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR, ...SET(reg),
    ];
}

// ── WASM memory layout ──
// 0x0000..0x00FF  unused
// 0x0100..0x01FF  encoder state (ChaCha20 + crypto counters + channel state)
// 0x0200..0x02FF  decoder state (same layout)
// 0x0200+256      decoder scratch buffer (128B Mid + 128B Side per block)
// 0x1000..         PCM / bitstream I/O buffers (16-byte aligned for SIMD)
//
// state layout at offset from base (ENC_STATE_ADDR or DEC_STATE_ADDR):
//   +0..63     ChaCha20 state (16 × i32)
//   +64..127   ChaCha20 keystream output (16 × i32)
//   +128       crypto idx (byte offset into keystream block)
//   +132       sample_count (total encrypted words)
//   +136       mac0
//   +140       mac1
//   +144..159  channel 0 predictor: [prev1, prev2, prevK, prevG]
//   +160..175  channel 1 predictor: [prev1, prev2, prevK, prevG]

const ENC_STATE_ADDR = 0x0100;
const DEC_STATE_ADDR = 0x0200;
const BUF_START = 0x1000;
const HEADER_SIZE = 12; // [numSamples:4][sampleRate:4][flags:2][numChannels:1][reserved:1]
const MAC_SIZE = 8;     // SipHash-lite 64-bit MAC

// ChaCha20 quarter-round
function QROUND(a: number, b: number, c: number, d: number): number[] {
    return [
        ...GET(a), ...GET(b), ...ADD, ...SET(a),
        ...GET(d), ...GET(a), ...XOR, ...CI32(16), ...ROTL, ...SET(d),
        ...GET(c), ...GET(d), ...ADD, ...SET(c),
        ...GET(b), ...GET(c), ...XOR, ...CI32(12), ...ROTL, ...SET(b),
        ...GET(a), ...GET(b), ...ADD, ...SET(a),
        ...GET(d), ...GET(a), ...XOR, ...CI32(8), ...ROTL, ...SET(d),
        ...GET(c), ...GET(d), ...ADD, ...SET(c),
        ...GET(b), ...GET(c), ...XOR, ...CI32(7), ...ROTL, ...SET(b),
    ];
}

function buildChaChaBlock(stateAddr: number, v: number[]): number[] {
    let loadState = [];
    for (let i = 0; i < 16; i++) {
        loadState.push(...CI32(stateAddr + i * 4), ...LOAD32(2, 0), ...SET(v[i]));
    }

    let rounds = [];
    for (let i = 0; i < 10; i++) {
        rounds.push(
            ...QROUND(v[0], v[4], v[8], v[12]),
            ...QROUND(v[1], v[5], v[9], v[13]),
            ...QROUND(v[2], v[6], v[10], v[14]),
            ...QROUND(v[3], v[7], v[11], v[15]),
            ...QROUND(v[0], v[5], v[10], v[15]),
            ...QROUND(v[1], v[6], v[11], v[12]),
            ...QROUND(v[2], v[7], v[8], v[13]),
            ...QROUND(v[3], v[4], v[9], v[14])
        );
    }

    let saveState = [];
    for (let i = 0; i < 16; i++) {
        saveState.push(
            ...CI32(stateAddr + 64 + i * 4), // address
            ...GET(v[i]), ...CI32(stateAddr + i * 4), ...LOAD32(2, 0), ...ADD, // value
            ...STORE32(2, 0)
        );
    }

    return [
        ...loadState,
        ...rounds,
        ...saveState,
        ...CI32(stateAddr + 48), ...CI32(stateAddr + 48), ...LOAD32(2, 0), ...CI32(1), ...ADD, ...STORE32(2, 0),
    ];
}

/**
 * build the WASM encode function body.
 *
 * two passes per block per channel:
 *   PASS KG: scalar joint 2×2 regression — fits K and G simultaneously via
 *            Cramer's rule; K conditional 1D fallback for near-DC (det < 1);
 *            G always re-derived as 1D conditional on K (gives G=1 for any
 *            pure sinusoid, and gives the correct G when K is clamped).
 *   PASS 3:  entropy scan — runs the predictor forward to sum zigzag residuals,
 *            derives Rice parameter M = floor(log2(mean_z)).
 *   PASS 4:  emit — same predictor, Rice(M)-codes each residual.
 *
 * K and G are held flat across the block (no within-block interpolation),
 * which is consistent with the regression objective.
 */
function buildEncodeBody(): number[] {
    const pcmPtr = 0, numSamples = 1, outPtr = 2, scalar_arg = 3, numChannels = 4; // args

    let next_i32 = 5;
    const packedLen = next_i32++, i = next_i32++, p1_sim = next_i32++, p2_sim = next_i32++;
    const i32_val = next_i32++, delta = next_i32++, z = next_i32++, mz = next_i32++, W_curr = next_i32++, temp = next_i32++;
    const crypto_i = next_i32++, crypto_words = next_i32++, cipher = next_i32++, idx = next_i32++, sample_count = next_i32++;
    const mac0 = next_i32++, mac1 = next_i32++, prev1 = next_i32++, prev2 = next_i32++, block_start = next_i32++, block_end = next_i32++;
    const v = Array.from({ length: 16 }, () => next_i32++);
    const K = next_i32++, G = next_i32++, bit_cnt = next_i32++, ch = next_i32++;
    const s31_anchor = next_i32++, pred_int = next_i32++, ch_state_ptr = next_i32++;
    const i32_locals_count = next_i32 - 5;

    let next_f32 = next_i32;
    const framePeak = next_f32++, f32_val = next_f32++, sum_p1_p1 = next_f32++, sum_p1_val = next_f32++;
    const sum_p2_p2 = next_f32++, sum_p2_err = next_f32++, K_float = next_f32++, G_float = next_f32++;
    const f32_x = next_f32++, f32_w = next_f32++, f32_scalar = next_f32++;
    const left = next_f32++, right = next_f32++;
    const f32_locals_count = next_f32 - next_i32;

    let next_i64 = next_f32;
    const i64_bit_buf = next_i64++;
    const i64_locals_count = next_i64 - next_f32;

    let next_v128 = next_i64;
    const v_peak = next_v128++; // only v128 needed in encoder (peak scan)
    const v128_locals_count = next_v128 - next_i64;

    // pack value into LSB-first bit buffer, drain complete bytes to output
    function emitBits(valueInstr: number[], nbitsInstr: number[]): number[] {
        return [
            ...GET(i64_bit_buf),
            ...valueInstr, ...CI32(1), ...nbitsInstr, ...SHL, ...CI32(1), ...SUB, ...AND, // mask to n bits
            ...I64_EXTEND_I32_U, ...GET(bit_cnt), ...I64_EXTEND_I32_U, ...I64_SHL,
            ...I64_OR, ...SET(i64_bit_buf),
            ...GET(bit_cnt), ...nbitsInstr, ...ADD, ...SET(bit_cnt),
            ...BLOCK, ...LOOP,
            ...GET(bit_cnt), ...CI32(8), ...LT_u, ...BRIF(1),
            ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD,
            ...GET(i64_bit_buf), ...I32_WRAP_I64, ...CI32(0xFF), ...AND,
            ...STORE8(0, 0),

            ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
            ...GET(i64_bit_buf), ...CI64(8), ...I64_SHR_u, ...SET(i64_bit_buf),
            ...GET(bit_cnt), ...CI32(8), ...SUB, ...SET(bit_cnt),
            ...BR(0), ...END, ...END,
        ];
    }

    // zigzag encode delta → z = (delta << 1) ^ (delta >> 31)
    function zigzag(deltaReg: number, zReg: number): number[] {
        return [
            ...GET(deltaReg), ...CI32(1), ...SHL,
            ...GET(deltaReg), ...CI32(31), ...SHR_s,
            ...XOR, ...SET(zReg),
        ];
    }

    // track max z for a predictor's mz register
    function updateMaxZ(zReg: number, mzReg: number): number[] {
        return [...GET(zReg), ...GET(mzReg), ...GT_u, ...IF, ...GET(zReg), ...SET(mzReg), ...END];
    }

    const body = [
        // 1. write header
        ...GET(outPtr), ...GET(numSamples), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(0), ...STORE32(2, 4), // sampleRate placeholder (JS fills after return)
        ...GET(outPtr), ...GET(numChannels), ...STORE8(0, 10),
        ...GET(outPtr), ...CI32(0), ...STORE8(0, 11), // reserved

        // 2. Clear Frame State
        ...CI32(0), ...SET(packedLen),

        // 3. Peak Normalization (Handling Interleaved Stereo)
        ...CV128([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ...SET(v_peak),
        ...CI32(0), ...SET(i),
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(numSamples), ...GET(numChannels), ...MUL, ...GE_s, ...BRIF(1),
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADV128(4, 0), ...FABS_V,
        ...GET(v_peak), ...FMAX_V, ...SET(v_peak),
        ...GET(i), ...CI32(4), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END,
        ...f32x4_hmax(v_peak), ...SET(framePeak),
        ...GET(framePeak), ...F32_CONST(0.0001), ...F32_MAX, ...SET(framePeak),

        // 4. Initialize Block parameters
        ...CI32(0), ...SET(block_start),

        // ── 32-sample microblock loop ──
        ...CI64(0), ...SET(i64_bit_buf), ...CI32(0), ...SET(bit_cnt),

        ...BLOCK, ...LOOP, // block loop
        ...GET(block_start), ...GET(numSamples), ...GE_s, ...BRIF(1),

        // bounds check
        ...GET(block_start), ...CI32(32), ...ADD, ...SET(block_end),
        ...GET(block_end), ...GET(numSamples), ...GT_u, ...IF, ...GET(numSamples), ...SET(block_end), ...END,

        // ── channel loop: 0=Mid, 1=Side ──
        ...CI32(0), ...SET(ch),
        ...BLOCK, ...LOOP, // channel loop

        // Calculate channel state pointer
        ...CI32(ENC_STATE_ADDR + 144), ...GET(ch), ...CI32(4), ...SHL, ...ADD, ...SET(ch_state_ptr),

        // Load channel state (prev1/prev2 seed the regression and predictor)
        ...GET(ch_state_ptr), ...LOAD32(2, 0), ...SET(prev1),
        ...GET(ch_state_ptr), ...CI32(4), ...ADD, ...LOAD32(2, 0), ...SET(prev2),

        // ── PASS KG: scalar joint 2×2 regression ──────────────────────────────
        // Solves the normal equations for pred = K·p1 − G·p2 simultaneously.
        // For a pure sinusoid at any frequency: K = 2cos(ω), G = 1 — exact.
        //
        //   system: [s11  s12][K] = [sv1]   s11=Σp1², s22=Σp2², s12=Σp1p2
        //           [s12  s22][G]   [sv2]   sv1=Σp1·val, sv2=Σp2·val
        //   solution (Cramer): det = s11·s22 − s12²
        //     K = (sv1·s22 − sv2·s12) / det
        //     G = (sv1·s12 − sv2·s11) / det
        //   degenerate (DC, silence, det≈0): fallback 1D → K = sv1/s11, G = 0
        ...GET(scalar_arg), ...F32_CONVERT_I32_S, ...SET(f32_scalar), // quantization scale

        ...F32_CONST(0.0), ...SET(sum_p1_p1),   // s11 = Σ p1²
        ...F32_CONST(0.0), ...SET(sum_p2_p2),   // s22 = Σ p2²
        ...F32_CONST(0.0), ...SET(f32_w),       // s12 = Σ p1·p2
        ...F32_CONST(0.0), ...SET(sum_p1_val),  // sv1 = Σ p1·val
        ...F32_CONST(0.0), ...SET(sum_p2_err),  // sv2 = Σ p2·val
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),

        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // regression loop — scalar, one sample at a time
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // load and quantize sample → i32_val
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 0), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF, ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val), ...ELSE, ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val), ...END,
        ...ELSE, ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val), ...END,
        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(f32_scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        // temporarily borrow K_float/G_float as fp1/fp2 (overwritten after loop)
        ...GET(p1_sim), ...F32_CONVERT_I32_S, ...SET(K_float),   // K_float = (float)p1
        ...GET(p2_sim), ...F32_CONVERT_I32_S, ...SET(G_float),   // G_float = (float)p2
        ...GET(i32_val), ...F32_CONVERT_I32_S, ...SET(f32_val),  // f32_val = (float)val

        // accumulate 5 cross-products
        ...GET(sum_p1_p1), ...GET(K_float), ...GET(K_float), ...F32_MUL, ...F32_ADD, ...SET(sum_p1_p1),
        ...GET(sum_p2_p2), ...GET(G_float), ...GET(G_float), ...F32_MUL, ...F32_ADD, ...SET(sum_p2_p2),
        ...GET(f32_w), ...GET(K_float), ...GET(G_float), ...F32_MUL, ...F32_ADD, ...SET(f32_w),
        ...GET(sum_p1_val), ...GET(K_float), ...GET(f32_val), ...F32_MUL, ...F32_ADD, ...SET(sum_p1_val),
        ...GET(sum_p2_err), ...GET(G_float), ...GET(f32_val), ...F32_MUL, ...F32_ADD, ...SET(sum_p2_err),

        // advance predictor state
        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // end regression loop

        // solve 2×2 system: det = s11·s22 − s12²  (stored in f32_x)
        ...GET(sum_p1_p1), ...GET(sum_p2_p2), ...F32_MUL,
        ...GET(f32_w), ...GET(f32_w), ...F32_MUL, ...F32_SUB, ...SET(f32_x), // f32_x = det

        // degenerate case (DC, silence): det < 1 → 1D fallback: K = sv1/s11
        ...GET(f32_x), ...F32_CONST(1.0), ...F32_LT, ...IF,
        ...GET(sum_p1_val), ...GET(sum_p1_p1), ...F32_CONST(1.0), ...F32_ADD, ...F32_DIV, ...SET(K_float),
        ...ELSE,
        // K from Cramer's rule: K = (sv1·s22 − sv2·s12) / det
        ...GET(sum_p1_val), ...GET(sum_p2_p2), ...F32_MUL,
        ...GET(sum_p2_err), ...GET(f32_w), ...F32_MUL, ...F32_SUB,
        ...GET(f32_x), ...F32_DIV, ...SET(K_float),
        ...END,

        // clamp K to safe range (avoid 0x8000 sign-flip in 16-bit decode)
        ...GET(K_float), ...F32_CONST(-2.0), ...F32_MAX, ...F32_CONST(1.9999), ...F32_MIN, ...SET(K_float),

        // G = conditional 1D optimal given clamped K: G = (K·s12 − sv2) / s22
        // • correct for any pure sinusoid (gives G=1 for any freq, independent of K clamping)
        // • correct when K is clamped (avoids the wrong Cramer G for near-DC signals)
        ...GET(K_float), ...GET(f32_w), ...F32_MUL,  // K_float * s12
        ...GET(sum_p2_err), ...F32_SUB,               // − sv2
        ...GET(sum_p2_p2), ...F32_CONST(1.0), ...F32_ADD, ...F32_DIV, ...SET(G_float), // / (s22+ε)

        // clamp G to safe range
        ...GET(G_float), ...F32_CONST(-2.0), ...F32_MAX, ...F32_CONST(1.9999), ...F32_MIN, ...SET(G_float),

        // scale to 14-bit fixed-point (16384 per 1.0)
        ...GET(K_float), ...F32_CONST(16384.0), ...F32_MUL, ...I32_TRUNC_SAT_F32_S, ...SET(K),
        ...GET(G_float), ...F32_CONST(16384.0), ...F32_MUL, ...I32_TRUNC_SAT_F32_S, ...SET(G),

        // reconstruct quantized K_float/G_float for Pass 3/4
        ...GET(K), ...F32_CONVERT_I32_S, ...F32_CONST(16384.0), ...F32_DIV, ...SET(K_float),
        ...GET(G), ...F32_CONVERT_I32_S, ...F32_CONST(16384.0), ...F32_DIV, ...SET(G_float),

        // reset predictor state for pass 3/4
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),

        // PASS 3: Entropy Assessment — sum zigzag residuals for Rice M selection
        // K_float / G_float already hold the regression result — use them flat over the block.
        // s31_anchor repurposed as pred_int (oscillator pred), mz as sum_z, W_curr as M
        ...GET(block_start), ...SET(i),
        ...CI32(0), ...SET(mz), // mz = sum_z
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // Pure oscillator predictor — flat K/G (no per-sample ramp)
        ...GET(K_float), ...GET(p1_sim), ...F32_CONVERT_I32_S, ...F32_MUL,
        ...GET(G_float), ...GET(p2_sim), ...F32_CONVERT_I32_S, ...F32_MUL, ...F32_SUB,
        ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(s31_anchor), // s31_anchor = pred_int

        // quantize actual sample, compute residue
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 0), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF, ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val), ...ELSE, ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val), ...END,
        ...ELSE, ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val), ...END,
        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(f32_scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        ...GET(i32_val), ...GET(s31_anchor), ...SUB, ...SET(delta),
        ...zigzag(delta, z),
        ...GET(mz), ...GET(z), ...ADD, ...SET(mz), // sum_z += z

        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // end Pass 3 loop

        // M = floor(log2(max(1, sum_z >> 5))) — Rice parameter from mean residual magnitude
        ...GET(mz), ...CI32(5), ...SHR_u, ...SET(W_curr), // W_curr = mean_z = sum_z / 32
        ...GET(W_curr), ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...SET(W_curr), // M=0 when mean_z=0 (perfect predictor)
        ...ELSE,
        ...CI32(31), ...GET(W_curr), ...CLZ, ...SUB, ...SET(W_curr), // M = floor(log2(mean_z))
        ...END,
        ...GET(W_curr), ...CI32(14), ...GT_s, ...IF, ...CI32(14), ...SET(W_curr), ...END, // cap M at 14

        // emit block header: K(16) + G(16) + M(4) = 36 bits (no anchor, no fixed W)
        ...emitBits([...GET(K)], [...CI32(16)]),
        ...emitBits([...GET(G)], [...CI32(16)]),
        ...emitBits([...GET(W_curr)], [...CI32(4)]),

        // PASS 4: Final Encode with Rice(M) residual coding
        ...GET(block_start), ...SET(i),
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // Pure oscillator predictor — flat K/G (no per-sample ramp)
        ...GET(K_float), ...GET(p1_sim), ...F32_CONVERT_I32_S, ...F32_MUL,
        ...GET(G_float), ...GET(p2_sim), ...F32_CONVERT_I32_S, ...F32_MUL, ...F32_SUB,
        ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(s31_anchor), // s31_anchor = pred_int

        // quantize actual sample
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 0), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF, ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val), ...ELSE, ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val), ...END,
        ...ELSE, ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val), ...END,
        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(f32_scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        ...GET(i32_val), ...GET(s31_anchor), ...SUB, ...SET(delta),
        ...zigzag(delta, z),

        // Rice(M) emit: q = z >> M; if q < 15: emit (q ones + stop 0) + M-bit remainder
        //               else: escape — emit 15 ones + 17-bit raw value (covers Q up to ~99)
        ...GET(z), ...GET(W_curr), ...SHR_u, ...SET(pred_int), // pred_int = q
        ...GET(pred_int), ...CI32(15), ...GE_u, ...IF,
        // escape: 15 ones then 17-bit raw (max z = 131071, covers scalar up to ~32768)
        ...emitBits([...CI32(0x7FFF)], [...CI32(15)]),
        ...emitBits([...GET(z), ...CI32(0x1FFFF), ...AND], [...CI32(17)]),
        ...ELSE,
        // normal: emit (1<<q)-1 as (q+1) bits, then remainder r = z & ((1<<M)-1) in M bits
        ...emitBits([...CI32(1), ...GET(pred_int), ...SHL, ...CI32(1), ...SUB], [...GET(pred_int), ...CI32(1), ...ADD]),
        ...GET(W_curr), ...CI32(0), ...GT_u, ...IF,
        ...CI32(1), ...GET(W_curr), ...SHL, ...CI32(1), ...SUB, ...GET(z), ...AND, ...SET(temp),
        ...emitBits([...GET(temp)], [...GET(W_curr)]),
        ...END,
        ...END,

        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END,

        // carry predictor state to next block
        ...GET(p1_sim), ...SET(prev1), ...GET(p2_sim), ...SET(prev2),

        // ── Save Channel State ──
        ...GET(ch_state_ptr), ...GET(prev1), ...STORE32(2, 0),
        ...GET(ch_state_ptr), ...GET(prev2), ...STORE32(2, 4),
        ...GET(ch_state_ptr), ...GET(K), ...STORE32(2, 8),
        ...GET(ch_state_ptr), ...GET(G), ...STORE32(2, 12),

        // increment channel
        ...GET(ch), ...CI32(1), ...ADD, ...SET(ch),
        ...GET(ch), ...GET(numChannels), ...LT_u, ...BRIF(0),
        ...END, ...END, // end channel loop

        ...GET(block_end), ...SET(block_start), ...BR(0),
        ...END, ...END, // end block loop

        // flush remaining bits (drain all bytes from i64_bit_buf)
        ...BLOCK, ...LOOP,
        ...GET(bit_cnt), ...CI32(0), ...EQ, ...BRIF(1),
        ...GET(i64_bit_buf), ...I32_WRAP_I64, ...CI32(0xFF), ...AND, ...SET(temp),
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD,
        ...GET(temp), ...STORE8(0, 0),
        ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
        ...GET(i64_bit_buf), ...CI64(8), ...I64_SHR_u, ...SET(i64_bit_buf),
        ...GET(bit_cnt), ...CI32(7), ...GT_s, ...IF,
        ...GET(bit_cnt), ...CI32(8), ...SUB, ...SET(bit_cnt),
        ...ELSE,
        ...CI32(0), ...SET(bit_cnt),
        ...END,
        ...BR(0), ...END, ...END,

        // pad to 4-byte alignment
        ...BLOCK, ...LOOP,
        ...GET(packedLen), ...CI32(3), ...AND, ...CI32(0), ...EQ, ...BRIF(1),
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD, ...CI32(0), ...STORE8(0, 0),
        ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
        ...BR(0), ...END, ...END,

        // 4. cryptography pass
        ...CI32(ENC_STATE_ADDR + 128), ...LOAD32(2, 0), ...SET(idx),
        ...CI32(ENC_STATE_ADDR + 132), ...LOAD32(2, 0), ...SET(sample_count), // total encrypted words
        ...CI32(ENC_STATE_ADDR + 136), ...LOAD32(2, 0), ...SET(mac0),
        ...CI32(ENC_STATE_ADDR + 140), ...LOAD32(2, 0), ...SET(mac1),

        ...GET(packedLen), ...CI32(2), ...SHR_u, ...SET(crypto_words), // packedLen / 4
        ...CI32(0), ...SET(crypto_i),

        ...BLOCK, ...LOOP, // crypto loop
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        // load plaintext 32-bit chunk
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(z), // z is temp plaintext

        // generate keystream block if needed
        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // XOR
        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(z), ...XOR, ...SET(cipher),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        // write cipher back to payload in-place
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(cipher), ...STORE32(2, 0),

        // update MAC (inline SipHash-lite)
        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        // ratchet the key and MAC every 1024 words
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(ENC_STATE_ADDR + 16), ...LOAD32(2, 0), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(ENC_STATE_ADDR + 16), ...GET(temp), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 20), ...LOAD32(2, 0), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(ENC_STATE_ADDR + 20), ...GET(temp), ...STORE32(2, 0),

        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        // append 64-bit MAC
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(HEADER_SIZE + 4), ...ADD, ...GET(packedLen), ...ADD, ...GET(mac1), ...STORE32(2, 0),

        // append f32 framePeak (4 bytes)
        ...GET(outPtr), ...CI32(HEADER_SIZE + 8), ...ADD, ...GET(packedLen), ...ADD, ...GET(framePeak), ...STOREF32(2, 0),

        // save crypto state
        ...CI32(ENC_STATE_ADDR + 128), ...GET(idx), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 132), ...GET(sample_count), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 136), ...GET(mac0), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 140), ...GET(mac1), ...STORE32(2, 0),

        ...GET(packedLen), ...CI32(HEADER_SIZE + MAC_SIZE + 4), ...ADD,
    ];
    return funcBody([
        { count: i32_locals_count, type: I32 },
        { count: f32_locals_count, type: F32 },
        { count: i64_locals_count, type: I64 },
        { count: v128_locals_count, type: V128 },
    ], body);
}

function buildDecodeBody(): number[] {
    const adpcmPtr = 0, numBytes = 1, outPtr = 2, scalar_arg = 3, numChannels = 4; // args

    let next_i32 = 5;
    const numSamples = next_i32++, packedLen = next_i32++, prev1 = next_i32++, prev2 = next_i32++, i32_val = next_i32++;
    const delta = next_i32++, z = next_i32++, crypto_i = next_i32++, crypto_words = next_i32++, cipher = next_i32++;
    const idx = next_i32++, sample_count = next_i32++, mac0 = next_i32++, mac1 = next_i32++, temp = next_i32++;
    const expMac0 = next_i32++, expMac1 = next_i32++, i = next_i32++, bit_cnt = next_i32++, block_start = next_i32++;
    const block_end = next_i32++, K = next_i32++, G = next_i32++, W_curr = next_i32++, ch = next_i32++;
    const s31_anchor = next_i32++, pred_int = next_i32++, ch_state_ptr = next_i32++;
    const v = Array.from({ length: 16 }, () => next_i32++);
    const i32_locals_count = next_i32 - 5;

    let next_f32 = next_i32;
    const framePeak = next_f32++, f32_val = next_f32++, K_float = next_f32++, G_float = next_f32++;
    const f32_scalar = next_f32++;
    const f32_locals_count = next_f32 - next_i32;

    let next_i64 = next_f32;
    const i64_bit_buf = next_i64++;
    const i64_locals_count = next_i64 - next_f32;

    let next_v128 = next_i64;
    const v_val = next_v128++, v_p1 = next_v128++, v_p2 = next_v128++;
    const v_tmp1 = next_v128++, v_tmp2 = next_v128++, v_peak = next_v128++, v_scalar = next_v128++;
    const v128_locals_count = next_v128 - next_i64;

    // refill i64 bit_buf from payload bytes until bit_cnt >= needed
    // IMPORTANT: also stops when bit_cnt >= 56 to prevent i64 overflow
    // (loading a byte at bit_cnt=56 fills bits 56-63, which is the max for i64)
    function refillBits(neededInstr: number[]): number[] {
        return [
            ...BLOCK, ...LOOP,
            ...GET(bit_cnt), ...neededInstr, ...GE_s, ...BRIF(1),
            ...GET(bit_cnt), ...CI32(56), ...GT_s, ...BRIF(1), // guard: stop if bit_cnt > 56 (next byte would overflow i64)
            // i64_bit_buf |= (byte << bit_cnt)
            ...GET(i64_bit_buf),
            ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...ADD, ...LOAD8u(0, 0), ...I64_EXTEND_I32_U,
            ...GET(bit_cnt), ...I64_EXTEND_I32_U, ...I64_SHL,
            ...I64_OR, ...SET(i64_bit_buf),
            ...GET(bit_cnt), ...CI32(8), ...ADD, ...SET(bit_cnt),
            ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i),
            ...BR(0), ...END, ...END,
        ];
    }

    // extract n bits from bit_buf, consuming them. result on stack as i32.
    function extractBits(nbitsInstr: number[]): number[] {
        return [
            ...nbitsInstr, ...CI32(32), ...EQ, ...IF_I32,
            ...GET(i64_bit_buf), ...I32_WRAP_I64, // full 32-bit wrap fallback
            ...ELSE,
            ...GET(i64_bit_buf), ...I32_WRAP_I64,
            ...CI32(1), ...nbitsInstr, ...SHL, ...CI32(1), ...SUB, // (1<<n)-1
            ...AND,
            ...END,
            // i64_bit_buf >>= n
            ...GET(i64_bit_buf), ...nbitsInstr, ...I64_EXTEND_I32_U, ...I64_SHR_u, ...SET(i64_bit_buf),
            // bit_cnt -= n
            ...GET(bit_cnt), ...nbitsInstr, ...SUB, ...SET(bit_cnt),
        ];
    }

    const body = [
        // 1. read numSamples from header
        ...GET(adpcmPtr), ...LOAD32(2, 0), ...SET(numSamples),

        // 2. init crypto state
        ...CI32(DEC_STATE_ADDR + 128), ...LOAD32(2, 0), ...SET(idx),
        ...CI32(DEC_STATE_ADDR + 132), ...LOAD32(2, 0), ...SET(sample_count),
        ...CI32(DEC_STATE_ADDR + 136), ...LOAD32(2, 0), ...SET(mac0),
        ...CI32(DEC_STATE_ADDR + 140), ...LOAD32(2, 0), ...SET(mac1),

        // 3. decryption pass (in-place)
        // packedLen = numBytes - (header + MAC + framePeak)
        ...GET(numBytes), ...CI32(HEADER_SIZE + MAC_SIZE + 4), ...SUB, ...SET(packedLen),
        ...GET(packedLen), ...CI32(2), ...SHR_u, ...SET(crypto_words),
        ...CI32(0), ...SET(crypto_i),

        ...BLOCK, ...LOOP, // crypto loop
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(cipher),

        // MAC update
        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        // keystream
        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // XOR and overwrite
        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(cipher), ...XOR, ...SET(temp),
        ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(temp), ...STORE32(2, 0),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        // ratchet
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(DEC_STATE_ADDR + 16), ...LOAD32(2, 0), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(DEC_STATE_ADDR + 16), ...GET(temp), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 20), ...LOAD32(2, 0), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(DEC_STATE_ADDR + 20), ...GET(temp), ...STORE32(2, 0),
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        // 4. Verify MAC
        // MAC is 8 bytes before the last 4 bytes (framePeak), so offsets are -12 and -8 from numBytes
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(12), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac0),
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(8), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac1),

        ...GET(mac0), ...GET(expMac0), ...EQ, ...GET(mac1), ...GET(expMac1), ...EQ, ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...RETURN,
        ...END,

        // save crypto state
        ...CI32(DEC_STATE_ADDR + 128), ...GET(idx), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 132), ...GET(sample_count), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 136), ...GET(mac0), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 140), ...GET(mac1), ...STORE32(2, 0),

        // read framePeak (last 4 bytes of payload, after MAC)
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(4), ...SUB, ...ADD, ...LOADF32(2, 0), ...SET(framePeak),
        ...GET(scalar_arg), ...F32_CONVERT_I32_S, ...SET(f32_scalar),

        // init bit reader and block state for reconstruction
        ...CI32(0), ...SET(K), ...CI32(0), ...SET(G),
        ...CI32(0), ...SET(i), ...CI32(0), ...SET(crypto_i),
        ...CI32(0), ...SET(bit_cnt),
        ...CI64(0), ...SET(i64_bit_buf),
        ...CI32(0), ...SET(block_start),

        // Zero-clear scratch buffer (256 bytes) to prevent garbage in non-aligned blocks
        ...Array.from({ length: 16 }, (_, k) => [
            ...CI32(DEC_STATE_ADDR + 256 + k * 16),
            ...CV128([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            ...STOREV128(4, 0)
        ]).flat(),

        ...BLOCK, ...LOOP, // block loop
        ...GET(block_start), ...GET(numSamples), ...GE_s, ...BRIF(1),

        ...GET(block_start), ...CI32(32), ...ADD, ...SET(block_end),
        ...GET(block_end), ...GET(numSamples), ...GT_u, ...IF, ...GET(numSamples), ...SET(block_end), ...END,
        // ── channel loop: 0=Mid, 1=Side ──
        ...CI32(0), ...SET(ch),
        ...BLOCK, ...LOOP, // channel loop

        // Calculate channel state pointer
        ...CI32(DEC_STATE_ADDR + 144), ...GET(ch), ...CI32(4), ...SHL, ...ADD, ...SET(ch_state_ptr),

        // Load channel state
        ...GET(ch_state_ptr), ...LOAD32(2, 0), ...SET(prev1),
        ...GET(ch_state_ptr), ...CI32(4), ...ADD, ...LOAD32(2, 0), ...SET(prev2),

        // read block header: K(16) + G(16) + M(4) = 36 bits
        ...refillBits([...CI32(16)]),
        ...extractBits([...CI32(16)]), ...CI32(16), ...SHL, ...CI32(16), ...SHR_s, ...SET(K),
        ...refillBits([...CI32(16)]),
        ...extractBits([...CI32(16)]), ...CI32(16), ...SHL, ...CI32(16), ...SHR_s, ...SET(G),
        ...refillBits([...CI32(4)]),
        ...extractBits([...CI32(4)]), ...SET(W_curr), // W_curr = M (Rice parameter)

        // K_float / G_float are constant over the block (flat, matching the encoder's regression)
        ...GET(K), ...F32_CONVERT_I32_S, ...F32_CONST(16384.0), ...F32_DIV, ...SET(K_float),
        ...GET(G), ...F32_CONVERT_I32_S, ...F32_CONST(16384.0), ...F32_DIV, ...SET(G_float),

        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // RECONSTRUCTION LOOP
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // Pure oscillator predictor — flat K/G over whole block
        ...GET(K_float), ...GET(prev1), ...F32_CONVERT_I32_S, ...F32_MUL,
        ...GET(G_float), ...GET(prev2), ...F32_CONVERT_I32_S, ...F32_MUL, ...F32_SUB,
        ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(pred_int), // pred_int = oscillator pred

        // Rice(M) decode: q = CTZ(~bit_buf), then normal or escape
        // Ensure enough bits: max possible read = 15 (unary escape) + 17 (raw) = 32 bits
        ...refillBits([...CI32(32)]),
        // q = count of trailing 1s in bit_buf = CTZ(~bit_buf)
        ...GET(i64_bit_buf), ...CI64(-1), ...I64_XOR_op, ...I64_CTZ_op, ...I32_WRAP_I64, ...SET(s31_anchor), // s31_anchor = q

        ...GET(s31_anchor), ...CI32(15), ...GE_u, ...IF,
        // Escape: consume 15 bits (the 15 ones), then read 17-bit raw value
        // (after refilling 32 bits and consuming 15, we have ≥17 left — no extra refill needed)
        ...GET(i64_bit_buf), ...CI64(15), ...I64_SHR_u, ...SET(i64_bit_buf),
        ...GET(bit_cnt), ...CI32(15), ...SUB, ...SET(bit_cnt),
        ...GET(i64_bit_buf), ...I32_WRAP_I64, ...CI32(0x1FFFF), ...AND, ...SET(z),
        ...GET(i64_bit_buf), ...CI64(17), ...I64_SHR_u, ...SET(i64_bit_buf),
        ...GET(bit_cnt), ...CI32(17), ...SUB, ...SET(bit_cnt),
        ...ELSE,
        // Normal Rice: consume q+1 bits (q ones + stop 0)
        ...GET(i64_bit_buf), ...GET(s31_anchor), ...CI32(1), ...ADD, ...I64_EXTEND_I32_U, ...I64_SHR_u, ...SET(i64_bit_buf),
        ...GET(bit_cnt), ...GET(s31_anchor), ...CI32(1), ...ADD, ...SUB, ...SET(bit_cnt),
        // read M-bit remainder
        ...GET(W_curr), ...CI32(0), ...GT_u, ...IF,
        ...GET(i64_bit_buf), ...I32_WRAP_I64, ...CI32(1), ...GET(W_curr), ...SHL, ...CI32(1), ...SUB, ...AND, ...SET(temp), // r
        ...GET(i64_bit_buf), ...GET(W_curr), ...I64_EXTEND_I32_U, ...I64_SHR_u, ...SET(i64_bit_buf),
        ...GET(bit_cnt), ...GET(W_curr), ...SUB, ...SET(bit_cnt),
        ...ELSE,
        ...CI32(0), ...SET(temp), // r = 0 when M = 0
        ...END,
        // z = (q << M) | r
        ...GET(s31_anchor), ...GET(W_curr), ...SHL, ...GET(temp), ...OR, ...SET(z),
        ...END,

        // zigzag decode: delta from z
        ...GET(z), ...CI32(1), ...AND, ...CI32(0), ...EQ, ...IF, ...GET(z), ...CI32(1), ...SHR_u, ...SET(delta), ...ELSE, ...GET(z), ...CI32(1), ...SHR_u, ...CI32(-1), ...XOR, ...SET(delta), ...END,

        ...GET(pred_int), ...GET(delta), ...ADD, ...SET(i32_val),

        // Save to scratch buffer for soundstage pass
        ...CI32(DEC_STATE_ADDR + 256), ...GET(ch), ...CI32(128), ...MUL, ...GET(i), ...GET(block_start), ...SUB, ...CI32(2), ...SHL, ...ADD, ...ADD, ...GET(i32_val), ...STORE32(2, 0),

        ...GET(prev1), ...SET(prev2), ...GET(i32_val), ...SET(prev1),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END,

        // carry predictor state to next block
        ...GET(ch_state_ptr), ...GET(prev1), ...STORE32(2, 0),
        ...GET(ch_state_ptr), ...GET(prev2), ...STORE32(2, 4),
        ...GET(ch_state_ptr), ...GET(K), ...STORE32(2, 8),
        ...GET(ch_state_ptr), ...GET(G), ...STORE32(2, 12),

        // increment channel
        ...GET(ch), ...CI32(1), ...ADD, ...SET(ch),
        ...GET(ch), ...GET(numChannels), ...LT_u, ...BRIF(0),
        ...END, ...END, // end channel loop

        // ── vectorized stereo reconstruction ──
        ...GET(framePeak), ...FSPLAT, ...SET(v_peak),
        ...GET(f32_scalar), ...FSPLAT, ...SET(v_scalar),

        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // soundstage loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        // L = Mid + Side/2, R = Mid - Side/2
        ...CI32(DEC_STATE_ADDR + 256), ...GET(i), ...GET(block_start), ...SUB, ...CI32(2), ...SHL, ...ADD, ...LOADV128(4, 0), ...SET(v_val), // Mid Window
        ...CI32(DEC_STATE_ADDR + 384), ...GET(i), ...GET(block_start), ...SUB, ...CI32(2), ...SHL, ...ADD, ...LOADV128(4, 0), ...SET(v_p1), // Side Window

        ...GET(v_val), ...CI32(1), ...I32X4_SHL_V, ...SET(v_p2), // 2*Mid (exact: avoids integer Side/2 floor truncation)
        ...GET(v_p2), ...GET(v_p1), ...I32ADDV, ...F32X4_CONVERT_V, ...GET(v_scalar), ...FDIVV, ...GET(v_peak), ...FMULV, ...F32_CONST(0.5), ...FSPLAT, ...FMULV, ...SET(v_tmp1), // vL = (2M+S)/(2*scalar)*peak
        ...GET(v_p2), ...GET(v_p1), ...I32SUBV, ...F32X4_CONVERT_V, ...GET(v_scalar), ...FDIVV, ...GET(v_peak), ...FMULV, ...F32_CONST(0.5), ...FSPLAT, ...FMULV, ...SET(v_tmp2), // vR = (2M-S)/(2*scalar)*peak

        // interleave L and R back to memory
        ...GET(v_tmp1), ...GET(v_tmp2), ...SHUFFLE([0, 1, 2, 3, 16, 17, 18, 19, 4, 5, 6, 7, 20, 21, 22, 23]), ...SET(v_p1), // [L0, R0, L1, R1]
        ...GET(v_tmp1), ...GET(v_tmp2), ...SHUFFLE([8, 9, 10, 11, 24, 25, 26, 27, 12, 13, 14, 15, 28, 29, 30, 31]), ...SET(v_p2), // [L2, R2, L3, R3]

        ...GET(outPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...GET(v_p1), ...STOREV128(4, 0),
        ...GET(outPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(16), ...ADD, ...ADD, ...GET(v_p2), ...STOREV128(4, 0),
        ...ELSE,
        // mono convert
        ...CI32(DEC_STATE_ADDR + 256), ...GET(i), ...GET(block_start), ...SUB, ...CI32(2), ...SHL, ...ADD, ...LOADV128(4, 0),
        ...F32X4_CONVERT_V, ...GET(v_scalar), ...FDIVV, ...GET(v_peak), ...FMULV, ...SET(v_tmp1),
        ...GET(outPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...GET(v_tmp1), ...STOREV128(4, 0),
        ...END,

        ...GET(i), ...CI32(4), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // soundstage loop

        ...GET(block_end), ...SET(block_start), ...BR(0),
        ...END, ...END, // block loop
        ...GET(numSamples),
    ];
    return funcBody([
        { count: i32_locals_count, type: I32 },
        { count: f32_locals_count, type: F32 },
        { count: i64_locals_count, type: I64 },
        { count: v128_locals_count, type: V128 },
    ], body);
}

function buildEncodeRawBody(): number[] {
    const pcmPtr = 0, numSamples = 1, outPtr = 2, numChannels = 3; // args
    const inSample = 4, cipher = 5, crypto_i = 6, crypto_words = 7, temp = 8;
    const idx = 9, sample_count = 10, mac0 = 11, mac1 = 12;
    const v = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];

    const body = [
        ...GET(outPtr), ...GET(numSamples), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(0), ...STORE32(2, 4), // sampleRate placeholder
        ...GET(outPtr), ...GET(numChannels), ...STORE8(0, 10),
        ...GET(outPtr), ...CI32(0), ...STORE8(0, 11), // reserved

        ...CI32(ENC_STATE_ADDR + 128), ...LOAD32(2, 0), ...SET(idx),
        ...CI32(ENC_STATE_ADDR + 132), ...LOAD32(2, 0), ...SET(sample_count),
        ...CI32(ENC_STATE_ADDR + 136), ...LOAD32(2, 0), ...SET(mac0),
        ...CI32(ENC_STATE_ADDR + 140), ...LOAD32(2, 0), ...SET(mac1),

        ...GET(numSamples), ...GET(numChannels), ...MUL, ...SET(crypto_words),
        ...CI32(0), ...SET(crypto_i),
        ...BLOCK, ...LOOP,
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        ...GET(pcmPtr), ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(inSample),

        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(inSample), ...XOR, ...SET(cipher),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(cipher), ...STORE32(2, 0),

        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(ENC_STATE_ADDR + 16), ...LOAD32(2, 0), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(ENC_STATE_ADDR + 16), ...GET(temp), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 20), ...LOAD32(2, 0), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(ENC_STATE_ADDR + 20), ...GET(temp), ...STORE32(2, 0),
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_words), ...CI32(2), ...SHL, ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(HEADER_SIZE + 4), ...ADD, ...GET(crypto_words), ...CI32(2), ...SHL, ...ADD, ...GET(mac1), ...STORE32(2, 0),

        ...CI32(ENC_STATE_ADDR + 128), ...GET(idx), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 132), ...GET(sample_count), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 136), ...GET(mac0), ...STORE32(2, 0),
        ...CI32(ENC_STATE_ADDR + 140), ...GET(mac1), ...STORE32(2, 0),

        ...GET(crypto_words), ...CI32(2), ...SHL, ...CI32(HEADER_SIZE + MAC_SIZE), ...ADD,
    ];
    return funcBody([{ count: 30, type: I32 }], body);
}

function buildDecodeRawBody(): number[] {
    const adpcmPtr = 0, numBytes = 1, outPtr = 2, numChannels = 3; // args
    const cipher = 4, crypto_i = 5, crypto_words = 6, temp = 7;
    const idx = 8, sample_count = 9, mac0 = 10, mac1 = 11, expMac0 = 12, expMac1 = 13;
    const v = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

    const body = [
        ...CI32(DEC_STATE_ADDR + 128), ...LOAD32(2, 0), ...SET(idx),
        ...CI32(DEC_STATE_ADDR + 132), ...LOAD32(2, 0), ...SET(sample_count),
        ...CI32(DEC_STATE_ADDR + 136), ...LOAD32(2, 0), ...SET(mac0),
        ...CI32(DEC_STATE_ADDR + 140), ...LOAD32(2, 0), ...SET(mac1),

        ...GET(numBytes), ...CI32(MAC_SIZE + HEADER_SIZE), ...SUB, ...CI32(2), ...SHR_u, ...SET(crypto_words),
        ...CI32(0), ...SET(crypto_i),

        ...BLOCK, ...LOOP,
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(cipher),

        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(cipher), ...XOR, ...SET(temp),
        ...GET(outPtr), ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(temp), ...STORE32(2, 0),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(DEC_STATE_ADDR + 16), ...LOAD32(2, 0), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(DEC_STATE_ADDR + 16), ...GET(temp), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 20), ...LOAD32(2, 0), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(DEC_STATE_ADDR + 20), ...GET(temp), ...STORE32(2, 0),
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(8), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac0),
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(4), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac1),

        ...GET(mac0), ...GET(expMac0), ...EQ, ...GET(mac1), ...GET(expMac1), ...EQ, ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...RETURN,
        ...END,

        ...CI32(DEC_STATE_ADDR + 128), ...GET(idx), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 132), ...GET(sample_count), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 136), ...GET(mac0), ...STORE32(2, 0),
        ...CI32(DEC_STATE_ADDR + 140), ...GET(mac1), ...STORE32(2, 0),

        ...GET(crypto_words), ...GET(numChannels), ...DIV,
    ];
    return funcBody([{ count: 30, type: I32 }], body);
}

function buildResetStateBody(addr: number): number[] {
    const k0 = 0, k1 = 1;
    return funcBody([], [
        ...CI32(addr + 0), ...CI32(0x61707865), ...STORE32(2, 0),
        ...CI32(addr + 4), ...CI32(0x33322033), ...STORE32(2, 0),
        ...CI32(addr + 8), ...CI32(0x79622d64), ...STORE32(2, 0),
        ...CI32(addr + 12), ...CI32(0x6b206574), ...STORE32(2, 0),

        ...CI32(addr + 16), ...GET(k0), ...STORE32(2, 0),
        ...CI32(addr + 20), ...GET(k1), ...STORE32(2, 0),
        ...CI32(addr + 24), ...CI32(0x9b056887), ...STORE32(2, 0),
        ...CI32(addr + 28), ...CI32(0x510e527f), ...STORE32(2, 0),
        ...CI32(addr + 32), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 36), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 40), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 44), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 48), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 52), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 56), ...CI32(0), ...STORE32(2, 0),
        ...CI32(addr + 60), ...CI32(0), ...STORE32(2, 0),

        ...CI32(addr + 128), ...CI32(64), ...STORE32(2, 0), // idx = 64 forces block generation
        ...CI32(addr + 132), ...CI32(1), ...STORE32(2, 0), // sample_count = 1
        ...CI32(addr + 136), ...GET(k0), ...STORE32(2, 0), // mac0 = k0
        ...CI32(addr + 140), ...GET(k1), ...STORE32(2, 0), // mac1 = k1

        // predictor state: 8 words total (prev1, prev2, prevK, prevG for 2 channels)
        ...CI32(addr + 144), ...CI32(0), ...STORE32(2, 0), // Mid prev1
        ...CI32(addr + 148), ...CI32(0), ...STORE32(2, 0), // Mid prev2
        ...CI32(addr + 152), ...CI32(0), ...STORE32(2, 0), // Mid prevK (Physics start at 0)
        ...CI32(addr + 156), ...CI32(0), ...STORE32(2, 0), // Mid prevG
        ...CI32(addr + 160), ...CI32(0), ...STORE32(2, 0), // Side prev1
        ...CI32(addr + 164), ...CI32(0), ...STORE32(2, 0), // Side prev2
        ...CI32(addr + 168), ...CI32(0), ...STORE32(2, 0), // Side prevK
        ...CI32(addr + 172), ...CI32(0), ...STORE32(2, 0), // Side prevG
    ]);
}

export interface AdpcmWasmExports {
    memory: WebAssembly.Memory;
    encode_adpcm: (pcmPtr: number, numSamples: number, outPtr: number, scalar: number, numChannels: number) => number;
    decode_adpcm: (adpcmPtr: number, numBytes: number, outPtr: number, scalar: number, numChannels: number) => number;
    encode_raw: (pcmPtr: number, numSamples: number, outPtr: number, numChannels: number) => number;
    decode_raw: (rawPtr: number, numBytes: number, outPtr: number, numChannels: number) => number;
    reset_enc: (k0: number, k1: number, k2: number, k3: number) => void;
    reset_dec: (k0: number, k1: number, k2: number, k3: number) => void;
}

export function buildAdpcmWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    const typeSection = section(1, [
        ...encodeULEB(3),
        // 0: (i32, i32, i32, i32, i32) -> i32 (adpcm codec)
        Op.FUNC, ...encodeULEB(5), I32, I32, I32, I32, I32, ...encodeULEB(1), I32,
        // 1: (i32, i32, i32, i32) -> i32 (raw codec)
        Op.FUNC, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(1), I32,
        // 2: (i32, i32, i32, i32) -> void (resets)
        Op.FUNC, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(0),
    ]);

    const funcSection = section(3, [
        ...encodeULEB(6),
        ...encodeULEB(0), // encode_adpcm
        ...encodeULEB(0), // decode_adpcm
        ...encodeULEB(1), // encode_raw
        ...encodeULEB(1), // decode_raw
        ...encodeULEB(2), // reset_enc
        ...encodeULEB(2), // reset_dec
    ]);

    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(2), ...encodeULEB(2048)]); // init 2 pages, max 2048

    const exportSection = section(7, [
        ...encodeULEB(7),
        ...nameSec("memory"), 0x02, ...encodeULEB(0),
        ...nameSec("encode_adpcm"), 0x00, ...encodeULEB(0),
        ...nameSec("decode_adpcm"), 0x00, ...encodeULEB(1),
        ...nameSec("encode_raw"), 0x00, ...encodeULEB(2),
        ...nameSec("decode_raw"), 0x00, ...encodeULEB(3),
        ...nameSec("reset_enc"), 0x00, ...encodeULEB(4),
        ...nameSec("reset_dec"), 0x00, ...encodeULEB(5),
    ]);

    const codeSection = section(10, [
        ...encodeULEB(6),
        ...buildEncodeBody(),
        ...buildDecodeBody(),
        ...buildEncodeRawBody(),
        ...buildDecodeRawBody(),
        ...buildResetStateBody(ENC_STATE_ADDR),
        ...buildResetStateBody(DEC_STATE_ADDR),
    ]);

    return new Uint8Array([
        ...magic,
        ...typeSection.flat(),
        ...funcSection.flat(),
        ...memSection.flat(),
        ...exportSection.flat(),
        ...codeSection.flat(),
    ]);
}

let _wasmPromise: Promise<AdpcmWasmExports> | null = null;

export function getAdpcmWasm(): Promise<AdpcmWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildAdpcmWasmBytes();
        const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
        return instance.exports as unknown as AdpcmWasmExports;
    })();
    return _wasmPromise;
}

export async function encodeAdpcm(
    float32Samples: Float32Array,
    sampleRate: number,
    encryptionKey?: Uint32Array,
    options?: { quality?: number; numChannels?: number },
): Promise<Uint8Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    const quality = options?.quality ?? 80;
    const numChannels = options?.numChannels ?? 1; // 1=mono, 2=stereo (M/S)
    const isRaw = quality >= 100;
    const scalar = Math.max(1, Math.floor(Math.pow(2, (quality / 100) * 15)));

    const numSamples = float32Samples.length / numChannels; // total sample frames
    const pcmBytes = float32Samples.length * 4;
    const outMaxBytes = HEADER_SIZE + pcmBytes + MAC_SIZE + (Math.ceil(numSamples / 32) * 10 * numChannels); // Buffer for safety
    const totalNeeded = BUF_START + pcmBytes + outMaxBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_enc(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_enc(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }

    const pcmPtr = BUF_START;
    const outPtr = BUF_START + pcmBytes;

    if (isRaw) {
        new Float32Array(mem.buffer, pcmPtr, float32Samples.length).set(float32Samples);
        const bytesWritten = wasm.encode_raw(pcmPtr, numSamples, outPtr, numChannels);
        const view = new DataView(mem.buffer);
        view.setUint32(outPtr + 4, sampleRate, true);
        view.setUint16(outPtr + 8, 0, true); // flags: bit0=0 → raw mode
        view.setUint8(outPtr + 10, numChannels);
        return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
    }

    new Float32Array(mem.buffer, pcmPtr, float32Samples.length + 64).fill(0); // Aggressive zero-pad for SIMD safety
    new Float32Array(mem.buffer, pcmPtr, float32Samples.length).set(float32Samples);
    const bytesWritten = wasm.encode_adpcm(pcmPtr, numSamples, outPtr, scalar, numChannels);

    const view = new DataView(mem.buffer);
    view.setUint32(outPtr + 4, sampleRate, true);
    const flags = ((quality & 0xFF) << 8) | 1;
    view.setUint16(outPtr + 8, flags, true);
    view.setUint8(outPtr + 10, numChannels);

    return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
}

export async function decodeAdpcm(
    adpcmBytes: Uint8Array,
    encryptionKey?: Uint32Array,
): Promise<{ pcm: Float32Array; sampleRate: number; tampered: boolean }> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    if (adpcmBytes.length < HEADER_SIZE + MAC_SIZE) throw new Error("adpcm: payload too short");

    const hdr = new DataView(adpcmBytes.buffer, adpcmBytes.byteOffset, HEADER_SIZE);
    const numSamples = hdr.getUint32(0, true);
    const sampleRate = hdr.getUint32(4, true) || 48000;
    const flags = hdr.getUint16(8, true);
    const isRaw = (flags & 1) === 0;
    const quality = (flags >> 8) & 0xFF;
    const scalar = Math.max(1, Math.floor(Math.pow(2, (quality / 100) * 15)));

    const inBytes = adpcmBytes.length;
    const numChannels = hdr.getUint8(10) || 1;
    const outBytes = numSamples * 4 * numChannels;
    const totalNeeded = BUF_START + inBytes + outBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_dec(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_dec(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }

    const inPtr = BUF_START;
    const outPtr = BUF_START + inBytes;

    new Uint8Array(mem.buffer, inPtr, inBytes).set(adpcmBytes);

    let samplesDecoded = 0;
    if (isRaw) {
        samplesDecoded = wasm.decode_raw(inPtr, inBytes, outPtr, numChannels);
    } else {
        samplesDecoded = wasm.decode_adpcm(inPtr, inBytes, outPtr, scalar, numChannels);
    }

    if (samplesDecoded === 0) {
        return { pcm: new Float32Array(0), sampleRate, tampered: true };
    }

    const pcm = new Float32Array(mem.buffer.slice(outPtr, outPtr + samplesDecoded * numChannels * 4));
    return { pcm, sampleRate, tampered: false };
}
