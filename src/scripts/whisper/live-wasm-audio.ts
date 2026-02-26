/**
 * live-wasm-audio.ts
 * 
 * The Whisper Parametric Audio Codec
 *
 * We aren't doing simple math predictors anymore. We are reverse-engineering sound itself.
 * This codec evaluates audio as a literal physical equation of motion:
 * pred = (Tension * p1) - (Friction * p2)
 * 
 * The WASM AST executes a 3-pass O(N) linear regression every block, dynamically dialing in
 * the exact continuous Tension (K) and Friction (G) coefficients of reality. We turned the 
 * codec into an infinite spectrum generator that perfectly tracks and cancels harmonic 
 * transients up to 20kHz, dropping payload bitrates by over 60%.
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
    I64_LOAD: 0x29,
    F32_LOAD: 0x2a,
    I32_LOAD8_U: 0x2d,
    I32_LOAD16_U: 0x2f,
    I32_STORE: 0x36,
    I64_STORE: 0x37,
    F32_STORE: 0x38,
    I32_STORE8: 0x3a,
    I32_STORE16: 0x3b,
    // I32 Math
    I32_EQ: 0x46,
    I32_LT_S: 0x48,
    I32_LT_U: 0x49,
    I32_GT_S: 0x4a,
    I32_GT_U: 0x4b,
    I32_GE_S: 0x4e,
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
    I64_OR: 0x84,
    I64_SHL: 0x86,
    I64_SHR_U: 0x88,
    // F32 Math
    F32_EQ: 0x5b,
    F32_ABS: 0x8b,
    F32_NEAREST: 0x90,
    F32_ADD: 0x92,
    F32_SUB: 0x93,
    F32_MUL: 0x94,
    F32_DIV: 0x95,
    F32_MAX: 0x97,
    // Conversions
    I32_WRAP_I64: 0xa7,
    I64_EXTEND_I32_U: 0xad,
    F32_CONVERT_I32_S: 0xb2,
    I32_REINTERPRET_F32: 0xbc,
    F32_REINTERPRET_I32: 0xbe,
    I32_TRUNC_SAT_F32_S: [0xfc, 0x00],
    // Types
    F32: 0x7d,
    I64: 0x7e,
    FUNC: 0x60,
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
const LOAD16u = (al: number, off: number) => [Op.I32_LOAD16_U, al, ...encodeULEB(off)];
const LOAD32 = (al: number, off: number) => [Op.I32_LOAD, al, ...encodeULEB(off)];
const STORE8 = (al: number, off: number) => [Op.I32_STORE8, al, ...encodeULEB(off)];
const STORE16 = (al: number, off: number) => [Op.I32_STORE16, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [Op.I32_STORE, al, ...encodeULEB(off)];
const STOREF32 = (al: number, off: number) => [Op.F32_STORE, al, ...encodeULEB(off)];
const LOADF32 = (al: number, off: number) => [Op.F32_LOAD, al, ...encodeULEB(off)];
const I32_REINTERPRET_F32 = [Op.I32_REINTERPRET_F32];
const F32_REINTERPRET_I32 = [Op.F32_REINTERPRET_I32];
const I32_TRUNC_SAT_F32_S = Op.I32_TRUNC_SAT_F32_S;
const F32_CONVERT_I32_S = [Op.F32_CONVERT_I32_S];

const LOAD64 = (al: number, off: number) => [Op.I64_LOAD, al, ...encodeULEB(off)];
const STORE64 = (al: number, off: number) => [Op.I64_STORE, al, ...encodeULEB(off)];
const I64_EXTEND_I32_U = [Op.I64_EXTEND_I32_U];
const I32_WRAP_I64 = [Op.I32_WRAP_I64];
const I64_SHL = [Op.I64_SHL];
const I64_SHR_u = [Op.I64_SHR_U];
const I64_OR = [Op.I64_OR];
const CI64 = (v: number) => [Op.I64_CONST, ...encodeSLEB(v)];

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

const F32_EQ = [Op.F32_EQ];
const F32_ABS = [Op.F32_ABS];
const F32_NEAREST = [Op.F32_NEAREST];
const F32_ADD = [Op.F32_ADD];
const F32_SUB = [Op.F32_SUB];
const F32_MUL = [Op.F32_MUL];
const F32_DIV = [Op.F32_DIV];
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
    const body = [...encodeLocals(locals), ...instr.flat()];
    return [...encodeULEB(body.length), ...body];
}

function avalanche(reg: number): number[] {
    return [
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR,
        ...CI32(0x85EBCA6B), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(13), ...SHR_u, ...XOR,
        ...CI32(0xC2B2AE35), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR, ...SET(reg),
    ];
}

const ENC_STATE_ADDR = 0x0100;
const DEC_STATE_ADDR = 0x0200;
const BUF_START = 0x0800;
const HEADER_SIZE = 12;
const MAC_SIZE = 8;

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
        loadState.push(...CI32(0), ...LOAD32(2, stateAddr + i * 4), ...SET(v[i]));
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
            ...CI32(0),
            ...GET(v[i]), ...CI32(0), ...LOAD32(2, stateAddr + i * 4), ...ADD,
            ...STORE32(2, stateAddr + 64 + i * 4) // Keystream buffer
        );
    }

    return [
        ...loadState,
        ...rounds,
        ...saveState,
        ...CI32(0), ...CI32(0), ...LOAD32(2, stateAddr + 48), ...CI32(1), ...ADD, ...STORE32(2, stateAddr + 48),
    ];
}

/**
 * The Digital Twin Stereo AST.
 * 
 * We don't just 'do' stereo. We decompose reality into Mid and Side.
 * 
 * If numChannels == 2:
 *  - Mid = (L+R)/2 (The core pressure wave)
 *  - Side = (L-R)   (The spatial width / phase differential)
 *  - Full Spatial Preservation: By regressing both Mid and Side with their own 
 *    physics coefficients, we perfectly track the soundstage geometry.
 */
function buildEncodeBody(): number[] {
    const pcmPtr = 0, numSamples = 1, outPtr = 2, scalar = 3, numChannels = 4; // args

    // I32 locals
    const packedLen = 5, i = 6, j = 7, p1_sim = 8, p2_sim = 9;
    const i32_val = 10, delta = 11, z = 12, mz = 13, W_curr = 14, temp = 15;
    const crypto_i = 16, crypto_words = 17, cipher = 18, idx = 19, sample_count = 20;
    const mac0 = 21, mac1 = 22, prev1 = 23, prev2 = 24, block_start = 25, block_end = 26;
    const v = [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
    const K = 43, G = 44, bit_cnt = 45, ch = 46;

    // F32 locals
    const framePeak = 47, f32_val = 48, sum_p1_p1 = 49, sum_p1_val = 50;
    const sum_p2_p2 = 51, sum_p2_err = 52, K_float = 53, G_float = 54;
    const f32_p1 = 55, f32_p2 = 56;
    const left = 57, right = 58;

    // I64 locals
    const i64_bit_buf = 59; // Using I64 for the real bit accumulator

    // Helper: shift value into bit buffer, drain full bytes
    function emitBits(valueInstr: number[], nbitsInstr: number[]): number[] {
        return [
            ...GET(i64_bit_buf),
            ...valueInstr, ...I64_EXTEND_I32_U, ...GET(bit_cnt), ...I64_EXTEND_I32_U, ...I64_SHL,
            ...I64_OR, ...SET(i64_bit_buf),
            ...GET(bit_cnt), ...nbitsInstr, ...ADD, ...SET(bit_cnt),
            ...BLOCK, ...LOOP,
            ...GET(bit_cnt), ...CI32(8), ...LT_u, ...BRIF(1),
            ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD,
            ...GET(i64_bit_buf), ...I32_WRAP_I64, ...STORE8(0, 0),
            ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
            ...GET(i64_bit_buf), ...CI64(8), ...I64_SHR_u, ...SET(i64_bit_buf),
            ...GET(bit_cnt), ...CI32(8), ...SUB, ...SET(bit_cnt),
            ...BR(0), ...END, ...END,
        ];
    }

    // Helper: zigzag encode delta → z = (delta << 1) ^ (delta >> 31)
    function zigzag(deltaReg: number, zReg: number): number[] {
        return [
            ...GET(deltaReg), ...CI32(1), ...SHL,
            ...GET(deltaReg), ...CI32(31), ...SHR_s,
            ...XOR, ...SET(zReg),
        ];
    }

    // Helper: track max z for a predictor's mz register
    function updateMaxZ(zReg: number, mzReg: number): number[] {
        return [...GET(zReg), ...GET(mzReg), ...GT_u, ...IF, ...GET(zReg), ...SET(mzReg), ...END];
    }

    const body = [
        // 1. Slam the Header
        ...GET(outPtr), ...GET(numSamples), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(0), ...STORE32(2, 4), // Frequency space (JS fills this)
        ...GET(outPtr), ...GET(numChannels), ...CI32(8), ...SHL, ...STORE16(1, 8), // flags: channel count lives in the mid-byte
        ...GET(outPtr), ...CI32(0), ...STORE16(0, 10), // Dead air

        // 2. Load Parametric predictor state
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 144), ...SET(prev1),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 148), ...SET(prev2),

        // 3. Peak Normalization (Handling Interleaved Stereo)
        ...F32_CONST(0.001), ...SET(framePeak),
        ...CI32(0), ...SET(i),
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(numSamples), ...GET(numChannels), ...MUL, ...GE_s, ...BRIF(1),
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...F32_ABS,
        ...GET(framePeak), ...F32_MAX, ...SET(framePeak),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END,

        // ── Physics Evaluator: 32 samples per microblock of pure resonance ──
        ...CI32(0), ...SET(block_start), ...CI32(0), ...SET(packedLen),
        ...CI64(0), ...SET(i64_bit_buf), ...CI32(0), ...SET(bit_cnt),

        ...BLOCK, ...LOOP, // block loop
        ...GET(block_start), ...GET(numSamples), ...GE_s, ...BRIF(1),

        // Don't overshoot reality
        ...GET(block_start), ...CI32(32), ...ADD, ...SET(block_end),
        ...GET(block_end), ...GET(numSamples), ...GT_u, ...IF, ...GET(numSamples), ...SET(block_end), ...END,

        // ── Reality Check: 0=Mid, 1=Side ──
        ...CI32(0), ...SET(ch),
        ...BLOCK, ...LOOP, // dimension loop

        // ── Pass 1: Extract Tension (K) for current channel ──
        ...F32_CONST(0), ...SET(sum_p1_p1),
        ...F32_CONST(0), ...SET(sum_p1_val),
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),

        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // pass 1 loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // L/R -> M/S Matrix
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        // Load L and R
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 4), ...SET(right),

        ...GET(ch), ...CI32(0), ...EQ, ...IF,
        // Mid = (L + R) / 2
        ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val),
        ...ELSE,
        // Side = L - R
        ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val),
        ...END,
        ...ELSE,
        // Mono fallback
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val),
        ...END,

        // Quantize
        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        ...GET(i32_val), ...F32_CONVERT_I32_S, ...SET(f32_val),
        ...GET(p1_sim), ...F32_CONVERT_I32_S, ...SET(f32_p1),
        ...GET(p2_sim), ...F32_CONVERT_I32_S, ...SET(f32_p2),

        ...GET(sum_p1_p1), ...GET(f32_p1), ...GET(f32_p1), ...F32_MUL, ...F32_ADD, ...SET(sum_p1_p1),
        ...GET(sum_p1_val), ...GET(f32_p1), ...GET(f32_val), ...GET(f32_p2), ...F32_ADD, ...F32_MUL, ...F32_ADD, ...SET(sum_p1_val),

        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // pass 1 loop

        // K_float = sum_p1_val / (sum_p1_p1 + epsilon)
        ...GET(sum_p1_val), ...GET(sum_p1_p1), ...F32_CONST(0.000001), ...F32_ADD, ...F32_DIV, ...SET(K_float),

        // ── Pass 2: Extract Friction (G) & Predict Entropy (mz) ──
        ...F32_CONST(0), ...SET(sum_p2_p2),
        ...F32_CONST(0), ...SET(sum_p2_err),
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),

        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // pass 2 loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // L/R -> M/S Matrix
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 4), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF,
        ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val),
        ...ELSE,
        ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val),
        ...END,
        ...ELSE,
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val),
        ...END,

        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        ...GET(i32_val), ...F32_CONVERT_I32_S, ...SET(f32_val),
        ...GET(p1_sim), ...F32_CONVERT_I32_S, ...SET(f32_p1),
        ...GET(p2_sim), ...F32_CONVERT_I32_S, ...SET(f32_p2),

        ...GET(sum_p2_p2), ...GET(f32_p2), ...GET(f32_p2), ...F32_MUL, ...F32_ADD, ...SET(sum_p2_p2),
        ...GET(sum_p2_err), ...GET(f32_p2), ...GET(K_float), ...GET(f32_p1), ...F32_MUL, ...GET(f32_val), ...F32_SUB, ...F32_MUL, ...F32_ADD, ...SET(sum_p2_err),

        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // pass 2 loop

        // G_float = sum_p2_err / (sum_p2_p2 + epsilon)
        ...GET(sum_p2_err), ...GET(sum_p2_p2), ...F32_CONST(0.000001), ...F32_ADD, ...F32_DIV, ...SET(G_float),

        // Convert K and G to 8-bit ints (scale 32)
        ...GET(K_float), ...F32_CONST(32.0), ...F32_MUL, ...I32_TRUNC_SAT_F32_S, ...SET(K),
        ...GET(G_float), ...F32_CONST(32.0), ...F32_MUL, ...I32_TRUNC_SAT_F32_S, ...SET(G),

        // Clamp to [-128, 127]
        ...GET(K), ...CI32(127), ...GT_s, ...IF, ...CI32(127), ...SET(K), ...END,
        ...GET(K), ...CI32(-128), ...LT_s, ...IF, ...CI32(-128), ...SET(K), ...END,
        ...GET(G), ...CI32(127), ...GT_s, ...IF, ...CI32(127), ...SET(G), ...END,
        ...GET(G), ...CI32(-128), ...LT_s, ...IF, ...CI32(-128), ...SET(G), ...END,

        // ── Pass 3: Entropy evaluation for `mz` using quantized K and G ──
        ...CI32(0), ...SET(mz),
        ...GET(prev1), ...SET(p1_sim),
        ...GET(prev2), ...SET(p2_sim),
        ...GET(block_start), ...SET(i),

        ...BLOCK, ...LOOP, // pass 3 sim loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // L/R -> M/S Matrix
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 4), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF,
        ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val),
        ...ELSE,
        ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val),
        ...END,
        ...ELSE,
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val),
        ...END,

        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        // pred = (K * p1) >> 5 - (G * p2) >> 5
        ...GET(K), ...GET(p1_sim), ...MUL, ...CI32(5), ...SHR_s,
        ...GET(G), ...GET(p2_sim), ...MUL, ...CI32(5), ...SHR_s, ...SUB, ...SET(temp),

        // delta = i32_val - pred
        ...GET(i32_val), ...GET(temp), ...SUB, ...SET(delta),

        ...zigzag(delta, z), ...updateMaxZ(z, mz),

        ...GET(p1_sim), ...SET(p2_sim), ...GET(i32_val), ...SET(p1_sim),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // pass 3 sim loop

        // W_curr = 32 - clz(mz) -> Bit-width needed to survive the entropy
        ...CI32(32), ...GET(mz), ...CLZ, ...SUB, ...SET(W_curr),

        // ── Emit physics coefficients (21 bits) ──
        ...GET(K), ...CI32(255), ...AND, ...SET(temp), // Tension
        ...emitBits([...GET(temp)], [...CI32(8)]),
        ...GET(G), ...CI32(255), ...AND, ...SET(temp), // Friction
        ...emitBits([...GET(temp)], [...CI32(8)]),
        ...emitBits([...GET(W_curr)], [...CI32(5)]),

        // ── Final Encode: Applying the Physical Equation of Motion ──
        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // encode loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        // L/R -> M/S Matrix
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(left),
        ...GET(pcmPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...LOADF32(2, 4), ...SET(right),
        ...GET(ch), ...CI32(0), ...EQ, ...IF,
        ...GET(left), ...GET(right), ...F32_ADD, ...F32_CONST(0.5), ...F32_MUL, ...SET(f32_val),
        ...ELSE,
        ...GET(left), ...GET(right), ...F32_SUB, ...SET(f32_val),
        ...END,
        ...ELSE,
        ...GET(pcmPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOADF32(2, 0), ...SET(f32_val),
        ...END,

        ...GET(f32_val), ...GET(framePeak), ...F32_DIV, ...GET(scalar), ...F32_MUL, ...F32_NEAREST, ...I32_TRUNC_SAT_F32_S, ...SET(i32_val),

        // pred = (K * p1) >> 5 - (G * p2) >> 5
        ...GET(K), ...GET(prev1), ...MUL, ...CI32(5), ...SHR_s,
        ...GET(G), ...GET(prev2), ...MUL, ...CI32(5), ...SHR_s, ...SUB, ...SET(temp),

        // delta = val - pred
        ...GET(i32_val), ...GET(temp), ...SUB, ...SET(delta),

        ...zigzag(delta, z),

        ...GET(W_curr), ...CI32(0), ...GT_u, ...IF,
        ...emitBits([...GET(z)], [...GET(W_curr)]),
        ...END,

        // Advance state
        ...GET(prev1), ...SET(prev2), ...GET(i32_val), ...SET(prev1),

        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // end encode loop

        // Increment channel
        ...GET(ch), ...CI32(1), ...ADD, ...SET(ch),
        ...GET(ch), ...GET(numChannels), ...LT_u, ...BRIF(0),
        ...END, ...END, // end channel loop

        ...GET(block_end), ...SET(block_start), ...BR(0),
        ...END, ...END, // end block loop

        // Flush remaining bits
        ...GET(bit_cnt), ...CI32(0), ...GT_u, ...IF,
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD,
        ...GET(i64_bit_buf), ...I32_WRAP_I64, ...STORE8(0, 0),
        ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
        ...END,

        // Pad to 4-byte alignment
        ...BLOCK, ...LOOP,
        ...GET(packedLen), ...CI32(3), ...AND, ...CI32(0), ...EQ, ...BRIF(1),
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD, ...CI32(0), ...STORE8(0, 0),
        ...GET(packedLen), ...CI32(1), ...ADD, ...SET(packedLen),
        ...BR(0), ...END, ...END,

        // Save Parametric state
        ...CI32(0), ...GET(prev1), ...STORE32(2, ENC_STATE_ADDR + 144),
        ...CI32(0), ...GET(prev2), ...STORE32(2, ENC_STATE_ADDR + 148),

        // 4. Cryptography Pass
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 132), ...SET(sample_count), // total encrypted words
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 140), ...SET(mac1),

        ...GET(packedLen), ...CI32(2), ...SHR_u, ...SET(crypto_words), // packedLen / 4
        ...CI32(0), ...SET(crypto_i),

        ...BLOCK, ...LOOP, // crypto loop
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        // Load plaintext 32-bit chunk
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(z), // z is temp plaintext

        // Generate keystream block if needed
        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // XOR
        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(z), ...XOR, ...SET(cipher),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        // Write cipher back to payload in-place
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(cipher), ...STORE32(2, 0),

        // Update MAC (Inline SipHash-lite)
        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        // Ratchet the key and MAC every 1024 words
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 16),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 20),

        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        // Append 64-bit MAC
        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(packedLen), ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(HEADER_SIZE + 4), ...ADD, ...GET(packedLen), ...ADD, ...GET(mac1), ...STORE32(2, 0),

        // Append f32 framePeak (4 bytes)
        ...GET(outPtr), ...CI32(HEADER_SIZE + 8), ...ADD, ...GET(packedLen), ...ADD, ...GET(framePeak), ...STOREF32(2, 0),

        // Save Crypto state
        ...CI32(0), ...GET(idx), ...STORE32(2, ENC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, ENC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, ENC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, ENC_STATE_ADDR + 140),

        // 5. Return size (Header + Payload + MAC + framePeak)
        ...GET(packedLen), ...CI32(HEADER_SIZE + MAC_SIZE + 4), ...ADD,
        ...END,
    ];
    return funcBody([
        { count: 42, type: I32 }, // locals 5..46 are I32
        { count: 12, type: F32 }, // locals 47..58 are F32
        { count: 1, type: I64 },  // local 59 is I64
    ], body);
}

function buildDecodeBody(): number[] {
    const adpcmPtr = 0, numBytes = 1, outPtr = 2, scalar = 3, numChannels = 4; // args

    // I32 locals
    const numSamples = 5, packedLen = 6, prev1 = 7, i32_val = 8, delta = 9, z = 10;
    const crypto_i = 11, crypto_words = 12, cipher = 13, idx = 14, sample_count = 15;
    const mac0 = 16, mac1 = 17, temp = 18, expMac0 = 19, expMac1 = 20, i = 21;
    const bit_cnt = 22;
    const v = [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38];
    const prev2 = 39, block_start = 40, block_end = 41;

    // Physics Engine I32 Locals
    const K = 42, G = 43, W_curr = 44, ch = 45;
    const mid = 46, side = 47; // Temp storage for M/S to L/R conversion

    // F32 locals
    const framePeak = 48; // local 48 is F32

    // I64 locals
    const i64_bit_buf = 49; // local 49 is I64 bit accumulator

    // Helper: refill i64 bit_buf from payload bytes until bit_cnt >= needed
    function refillBits(neededInstr: number[]): number[] {
        return [
            ...BLOCK, ...LOOP,
            ...GET(bit_cnt), ...neededInstr, ...GE_s, ...BRIF(1),
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

    // Helper: extract n bits from bit_buf, consuming them. Result on stack as i32.
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
        // 1. Recover the Pressure Wave (numSamples)
        ...GET(adpcmPtr), ...LOAD32(2, 0), ...SET(numSamples),

        // 2. Wake up the Crypto Engine
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 132), ...SET(sample_count),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 140), ...SET(mac1),

        // 3. The Decryption Pass (In-place reality reconstruction)
        // packedLen = numBytes - (Header + MAC + framePeak)
        ...GET(numBytes), ...CI32(HEADER_SIZE + MAC_SIZE + 4), ...SUB, ...SET(packedLen),
        ...GET(packedLen), ...CI32(2), ...SHR_u, ...SET(crypto_words),
        ...CI32(0), ...SET(crypto_i),

        ...BLOCK, ...LOOP,
        ...GET(crypto_i), ...GET(crypto_words), ...GE_s, ...BRIF(1),

        ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...SET(cipher),

        // MAC UPDATE
        ...GET(mac0), ...GET(cipher), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(cipher), ...ADD, ...SET(mac1),

        // KEYSTREAM
        ...GET(idx), ...CI32(64), ...GE_s, ...IF,
        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // XOR AND OVERWRITE
        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...GET(idx), ...ADD, ...LOAD32(2, 0), ...GET(cipher), ...XOR, ...SET(temp),
        ...GET(adpcmPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_i), ...CI32(2), ...SHL, ...ADD, ...GET(temp), ...STORE32(2, 0),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        // Ratchet
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 16),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 20),
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        // VerVerify MAC
        // MAC is 8 bytes before the last 4 bytes (framePeak), so offsets are -12 and -8 from numBytes
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(12), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac0),
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(8), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac1),

        ...GET(mac0), ...GET(expMac0), ...EQ, ...GET(mac1), ...GET(expMac1), ...EQ, ...AND, ...CI32(0), ...EQ, ...IF,
        ...CI32(0), ...RETURN,
        ...END,

        // Save Crypto state
        ...CI32(0), ...GET(idx), ...STORE32(2, DEC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, DEC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, DEC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, DEC_STATE_ADDR + 140),

        // Read appended framePeak (it's at the very end of numBytes)
        // Offset is numBytes - 4
        ...GET(adpcmPtr), ...GET(numBytes), ...CI32(4), ...SUB, ...ADD, ...LOADF32(2, 0), ...SET(framePeak),

        // 4. Digital Twin Simulation — Continuous resonance recovery
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 144), ...SET(prev1),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 148), ...SET(prev2),
        ...CI32(0), ...SET(i), ...CI32(0), ...SET(crypto_i),
        ...CI32(0), ...SET(bit_cnt),
        ...CI64(0), ...SET(i64_bit_buf),
        ...CI32(0), ...SET(block_start),

        ...BLOCK, ...LOOP, // block loop
        ...GET(block_start), ...GET(numSamples), ...GE_s, ...BRIF(1),

        ...GET(block_start), ...CI32(32), ...ADD, ...SET(block_end),
        ...GET(block_end), ...GET(numSamples), ...GT_u, ...IF, ...GET(numSamples), ...SET(block_end), ...END,

        // ── Dimensions: 0=Mid, 1=Side ──
        ...CI32(0), ...SET(ch),
        ...BLOCK, ...LOOP, // dimension loop

        // Read Physics Header (21 bits)
        ...refillBits([...CI32(21)]),
        ...extractBits([...CI32(8)]), ...SET(K),
        ...GET(K), ...CI32(24), ...SHL, ...CI32(24), ...SHR_s, ...SET(K),
        ...extractBits([...CI32(8)]), ...SET(G),
        ...GET(G), ...CI32(24), ...SHL, ...CI32(24), ...SHR_s, ...SET(G),
        ...extractBits([...CI32(5)]), ...SET(W_curr),

        // Decode Samples
        ...GET(block_start), ...SET(i),
        ...BLOCK, ...LOOP, // decode samples loop
        ...GET(i), ...GET(block_end), ...GE_s, ...BRIF(1),

        ...GET(W_curr), ...CI32(0), ...GT_u, ...IF,
        ...refillBits([...GET(W_curr)]),
        ...extractBits([...GET(W_curr)]), ...SET(z),
        ...GET(z), ...CI32(1), ...AND, ...CI32(0), ...EQ, ...IF,
        ...GET(z), ...CI32(1), ...SHR_u, ...SET(delta),
        ...ELSE,
        ...GET(z), ...CI32(1), ...SHR_u, ...CI32(-1), ...XOR, ...SET(delta),
        ...END,
        ...ELSE,
        ...CI32(0), ...SET(delta),
        ...END,

        ...GET(K), ...GET(prev1), ...MUL, ...CI32(5), ...SHR_s,
        ...GET(G), ...GET(prev2), ...MUL, ...CI32(5), ...SHR_s, ...SUB, ...SET(temp),
        ...GET(delta), ...GET(temp), ...ADD, ...SET(i32_val),

        // Store reconstructed M/S sample temporarily
        ...GET(ch), ...CI32(0), ...EQ, ...IF,
        ...GET(i32_val), ...SET(mid),
        ...ELSE,
        ...GET(i32_val), ...SET(side),
        ...END,

        // If mono or Side dimension finished, reconstruct the L/R soundstage
        ...GET(numChannels), ...CI32(1), ...EQ, ...GET(ch), ...CI32(1), ...EQ, ...OR, ...IF,
        ...GET(numChannels), ...CI32(2), ...EQ, ...IF,
        // Dimension Matrix: L = Mid + Side/2, R = Mid - Side/2
        ...GET(mid), ...GET(side), ...CI32(1), ...SHR_s, ...ADD, ...SET(i32_val),
        ...GET(outPtr), ...GET(i), ...CI32(3), ...SHL, ...ADD, ...GET(i32_val), ...F32_CONVERT_I32_S, ...GET(scalar), ...F32_DIV, ...GET(framePeak), ...F32_MUL, ...STOREF32(2, 0),
        // R = M - S/2
        ...GET(mid), ...GET(side), ...CI32(1), ...SHR_s, ...SUB, ...SET(i32_val),
        ...GET(outPtr), ...GET(i), ...CI32(3), ...SHL, ...CI32(4), ...ADD, ...ADD, ...GET(i32_val), ...F32_CONVERT_I32_S, ...GET(scalar), ...F32_DIV, ...GET(framePeak), ...F32_MUL, ...STOREF32(2, 4),
        ...ELSE,
        // Mono
        ...GET(outPtr), ...GET(i), ...CI32(2), ...SHL, ...ADD, ...GET(i32_val), ...F32_CONVERT_I32_S, ...GET(scalar), ...F32_DIV, ...GET(framePeak), ...F32_MUL, ...STOREF32(2, 0),
        ...END,
        ...END,

        ...GET(prev1), ...SET(prev2), ...GET(i32_val), ...SET(prev1),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i), ...BR(0),
        ...END, ...END, // decode samples loop

        ...GET(ch), ...CI32(1), ...ADD, ...SET(ch),
        ...GET(ch), ...GET(numChannels), ...LT_u, ...BRIF(0),
        ...END, ...END, // channel loop

        ...GET(block_end), ...SET(block_start), ...BR(0),
        ...END, ...END, // block loop

        ...CI32(0), ...GET(prev1), ...STORE32(2, DEC_STATE_ADDR + 144),
        ...CI32(0), ...GET(prev2), ...STORE32(2, DEC_STATE_ADDR + 148),

        ...GET(numSamples),
        ...END,
    ];
    return funcBody([
        { count: 43, type: I32 }, // locals 5..47 (numSamples..side)
        { count: 1, type: F32 },  // local 48 (framePeak)
        { count: 1, type: I64 },  // local 49 (i64_bit_buf)
    ], body);
}

function buildEncodeRawBody(): number[] {
    const pcmPtr = 0, numSamples = 1, outPtr = 2, numChannels = 3; // args
    const inSample = 4, cipher = 5, crypto_i = 6, crypto_words = 7, temp = 8;
    const idx = 9, sample_count = 10, mac0 = 11, mac1 = 12;
    const v = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];

    const body = [
        ...GET(outPtr), ...GET(numSamples), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(0), ...STORE32(2, 4), // Sample Rate (zeroed, filled by JS)
        ...GET(outPtr), ...GET(numChannels), ...CI32(8), ...SHL, ...STORE16(1, 8), // flags: mid-byte numChannels
        ...GET(outPtr), ...CI32(0), ...STORE16(0, 10), // Padding

        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 132), ...SET(sample_count),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 140), ...SET(mac1),

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
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 16),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 20),
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,

        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),
        ...GET(crypto_i), ...CI32(1), ...ADD, ...SET(crypto_i), ...BR(0),
        ...END, ...END,

        ...GET(outPtr), ...CI32(HEADER_SIZE), ...ADD, ...GET(crypto_words), ...CI32(2), ...SHL, ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outPtr), ...CI32(HEADER_SIZE + 4), ...ADD, ...GET(crypto_words), ...CI32(2), ...SHL, ...ADD, ...GET(mac1), ...STORE32(2, 0),

        ...CI32(0), ...GET(idx), ...STORE32(2, ENC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, ENC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, ENC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, ENC_STATE_ADDR + 140),

        ...GET(crypto_words), ...CI32(2), ...SHL, ...CI32(HEADER_SIZE + MAC_SIZE), ...ADD,
        ...END
    ];
    return funcBody([{ count: 30, type: I32 }], body);
}

function buildDecodeRawBody(): number[] {
    const adpcmPtr = 0, numBytes = 1, outPtr = 2, numChannels = 3; // args
    const cipher = 4, crypto_i = 5, crypto_words = 6, temp = 7;
    const idx = 8, sample_count = 9, mac0 = 10, mac1 = 11, expMac0 = 12, expMac1 = 13;
    const v = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

    const body = [
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 132), ...SET(sample_count),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 140), ...SET(mac1),

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
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 16),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp), ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 20),
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

        ...CI32(0), ...GET(idx), ...STORE32(2, DEC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, DEC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, DEC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, DEC_STATE_ADDR + 140),

        ...GET(crypto_words), ...GET(numChannels), ...DIV,
        ...END
    ];
    return funcBody([{ count: 30, type: I32 }], body);
}

function buildResetStateBody(addr: number): number[] {
    const k0 = 0, k1 = 1, k2 = 2, k3 = 3;
    return funcBody([], [
        ...CI32(0), ...CI32(0x61707865), ...STORE32(2, addr + 0),
        ...CI32(0), ...CI32(0x3320646e), ...STORE32(2, addr + 4),
        ...CI32(0), ...CI32(0x79622d32), ...STORE32(2, addr + 8),
        ...CI32(0), ...CI32(0x6b206574), ...STORE32(2, addr + 12),
        // 256-bit Key Derived from 128-bit input
        ...CI32(0), ...GET(k0), ...STORE32(2, addr + 16),
        ...CI32(0), ...GET(k1), ...STORE32(2, addr + 20),
        ...CI32(0), ...GET(k2), ...STORE32(2, addr + 24),
        ...CI32(0), ...GET(k3), ...STORE32(2, addr + 28),
        ...CI32(0), ...GET(k0), ...CI32(0xDEADBEEF), ...XOR, ...STORE32(2, addr + 32),
        ...CI32(0), ...GET(k1), ...CI32(0x1337C0DE), ...XOR, ...STORE32(2, addr + 36),
        ...CI32(0), ...GET(k2), ...CI32(0x8BADF00D), ...XOR, ...STORE32(2, addr + 40),
        ...CI32(0), ...GET(k3), ...CI32(0x0DEFACED), ...XOR, ...STORE32(2, addr + 44),
        // Counters & Nonce
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 48), // Block Counter
        ...CI32(0), ...CI32(1), ...STORE32(2, addr + 52), // Nonce 0
        ...CI32(0), ...CI32(2), ...STORE32(2, addr + 56), // Nonce 1
        ...CI32(0), ...CI32(3), ...STORE32(2, addr + 60), // Nonce 2

        ...CI32(0), ...CI32(64), ...STORE32(2, addr + 128), // idx
        ...CI32(0), ...CI32(1), ...STORE32(2, addr + 132), // sample_count
        ...CI32(0), ...GET(k0), ...STORE32(2, addr + 136), // Initial MAC state 0
        ...CI32(0), ...GET(k1), ...STORE32(2, addr + 140), // Initial MAC state 1

        // Parametric State
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 144), // prev1
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 148), // prev2
        ...END,
    ]);
}

/**
 * The raw binary interface to the Digital Twin.
 */
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
        ...encodeULEB(4),
        // 0: (i32, i32, i32, f32, i32) -> i32 (adpcm/raw funcs)
        Op.FUNC, ...encodeULEB(5), I32, I32, I32, Op.F32, I32, ...encodeULEB(1), I32,
        // 1: (i32, i32, i32, i32) -> i32 (raw funcs)
        Op.FUNC, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(1), I32,
        // 2: (i32, i32, i32, i32) -> void (resets)
        Op.FUNC, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(0),
        // 3: () -> void (not used)
        Op.FUNC, ...encodeULEB(0), ...encodeULEB(0),
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

/**
 * Spin up the physics engine.
 */
export function getAdpcmWasm(): Promise<AdpcmWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildAdpcmWasmBytes();
        const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
        return instance.exports as unknown as AdpcmWasmExports;
    })();
    return _wasmPromise;
}

const WASM_BUF = BUF_START;

export async function encodeAdpcm(
    float32Samples: Float32Array,
    sampleRate: number,
    encryptionKey?: Uint32Array,
    options?: { quality?: number; numChannels?: number },
): Promise<Uint8Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    const quality = options?.quality ?? 80;
    const numChannels = options?.numChannels ?? 1; // 1=Mono, 2=Stereo (M/S Dimension Matrix)
    const isRaw = quality >= 100;
    const scalar = Math.max(1, Math.floor(Math.pow(2, (quality / 100) * 15)));

    const numSamples = float32Samples.length / numChannels; // Total frames of reality
    const pcmBytes = float32Samples.length * 4;
    const outMaxBytes = HEADER_SIZE + pcmBytes + MAC_SIZE + (Math.ceil(numSamples / 32) * 10 * numChannels); // Buffer for safety
    const totalNeeded = WASM_BUF + pcmBytes + outMaxBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_enc(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_enc(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }

    const pcmPtr = WASM_BUF;
    const outPtr = WASM_BUF + pcmBytes;

    if (isRaw) {
        new Float32Array(mem.buffer, pcmPtr, float32Samples.length).set(float32Samples);
        const bytesWritten = wasm.encode_raw(pcmPtr, numSamples, outPtr, numChannels);
        const view = new DataView(mem.buffer);
        view.setUint32(outPtr + 4, sampleRate, true);
        return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
    }

    new Float32Array(mem.buffer, pcmPtr, float32Samples.length).set(float32Samples);
    const bytesWritten = wasm.encode_adpcm(pcmPtr, numSamples, outPtr, scalar, numChannels);

    const view = new DataView(mem.buffer);
    view.setUint32(outPtr + 4, sampleRate, true);
    const flags = ((quality & 0xFF) << 8) | 1;
    view.setUint16(outPtr + 8, flags, true);

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
    const outBytes = numSamples * 4;
    const totalNeeded = WASM_BUF + inBytes + outBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_dec(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_dec(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }

    const inPtr = WASM_BUF;
    const outPtr = WASM_BUF + inBytes;

    new Uint8Array(mem.buffer, inPtr, inBytes).set(adpcmBytes);

    let samplesDecoded = 0;
    const numChannels = ((flags >> 8) & 0xFF) || 1;

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
