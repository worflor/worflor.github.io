/**
 * live-wasm-audio.ts
 *
 * Hand-assembled WebAssembly IMA ADPCM codec for Whisper PTT.
 * No compiler. No toolchain. Pure bytecode assembled in JS arrays.
 *
 * Exports:
 *   encode_adpcm(pcmPtr: i32, numSamples: i32, outPtr: i32) -> i32  (returns byte count)
 *   decode_adpcm(adpcmPtr: i32, numBytes: i32, outPtr: i32)  -> i32  (returns sample count)
 *
 * Memory map (first page, 64 KB):
 *   0x0000 – 0x000F : INDEX_TABLE  (16 × i8)
 *   0x0010 – 0x00C1 : STEP_TABLE   (89 × i16, little-endian)
 *   0x00C4 – 0x00CB : ENC_STATE    (valpred:i32, index:i32)
 *   0x00CC – 0x00D3 : DEC_STATE    (valpred:i32, index:i32)
 *   0x0200+         : caller-managed PCM/ADPCM buffers
 *
 * Input PCM: Int16 (signed 16-bit), mono.
 * Output:    IMA ADPCM 4-bit nibbles, packed 2 per byte, ~4:1 compression.
 *
 * FORMAT HEADER (8 bytes prefixed before ADPCM nibble stream):
 *   [0..3] u32 LE — number of original PCM samples  (supports ~24h at 48kHz)
 *   [4..5] u16 LE — sample rate in Hz (e.g. 48000)
 *   [6]    u8     — reserved (0)
 *   [7]    u8     — reserved (0)
 */

// ── Bytecode helpers ──────────────────────────────────────────────────────────

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

const I32 = 0x7f;
const VOID = 0x40;

// Instructions
const GET = (i: number) => [0x20, ...encodeULEB(i)];
const SET = (i: number) => [0x21, ...encodeULEB(i)];
const CI32 = (v: number) => [0x41, ...encodeSLEB(v)];
const BR = (l: number) => [0x0c, ...encodeULEB(l)];
const BRIF = (l: number) => [0x0d, ...encodeULEB(l)];
const BLOCK = [0x02, VOID];
const LOOP = [0x03, VOID];
const IF = [0x04, VOID];
const ELSE = [0x05];
const END = [0x0b];

// Memory ops
const LOAD8s = (al: number, off: number) => [0x2c, al, ...encodeULEB(off)];
const LOAD16s = (al: number, off: number) => [0x2e, al, ...encodeULEB(off)];
const LOAD32 = (al: number, off: number) => [0x28, al, ...encodeULEB(off)];
const STORE8 = (al: number, off: number) => [0x3a, al, ...encodeULEB(off)];
const STORE16 = (al: number, off: number) => [0x3b, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [0x36, al, ...encodeULEB(off)];

// Arithmetic / logic
const ADD = [0x6a];
const SUB = [0x6b];
const SHR_s = [0x75];
const SHR_u = [0x76];
const SHL = [0x74];
const AND = [0x71];
const OR = [0x72];
const GE_s = [0x4e];
const GT_s = [0x4a];
const LT_s = [0x48];
const EQ = [0x46];

function encodeLocals(decls: { count: number; type: number }[]): number[] {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}

function funcBody(locals: { count: number; type: number }[], instr: number[]): number[] {
    const body = [...encodeLocals(locals), ...instr.flat()];
    return [...encodeULEB(body.length), ...body];
}

// ── IMA ADPCM Tables ─────────────────────────────────────────────────────────

const STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28,
    31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408,
    449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
    1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
    4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
];

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

const IDX_TBL_ADDR = 0x0000;
const STEP_TBL_ADDR = 0x0010;
const ENC_STATE_ADDR = 0x00C4;
const DEC_STATE_ADDR = 0x00CC;
const BUF_START = 0x0200;

// HEADER_SIZE updated to 8 bytes (u32 numSamples + u16 sampleRate + 2 reserved)
const HEADER_SIZE = 8;

// ── encode_adpcm function body ────────────────────────────────────────────────
// Signature: (pcmPtr: i32, numSamples: i32, outPtr: i32) -> i32
// Header is now 8 bytes. Returns 8 + ceil(numSamples/2).
function buildEncodeBody(): number[] {
    const valpred = 3, index = 4, step = 5, i = 6, sample = 7, diff = 8;
    const vpdiff = 9, sign = 10, delta = 11, nibble = 12, outByte = 13, odd = 14, outLen = 15;

    const body = [
        // write 8-byte header
        // [0..3] = numSamples as u32
        ...GET(2), ...GET(1), ...STORE32(2, 0),
        // [4..5] = 0 (sample rate filled in by JS wrapper after WASM call)
        ...GET(2), ...CI32(0), ...STORE16(1, 4),
        // [6..7] = 0 reserved
        ...GET(2), ...CI32(0), ...STORE16(0, 6),

        // load state from memory for streaming support
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR), ...SET(valpred),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 4), ...SET(index),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(outByte),
        ...CI32(0), ...SET(odd),
        ...CI32(HEADER_SIZE), ...SET(outLen),

        // Main loop
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(1), ...GE_s, ...BRIF(1),

        // sample = i16[pcmPtr + i*2]
        ...GET(0), ...GET(i), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(sample),

        // step = STEP_TABLE[index]
        ...CI32(STEP_TBL_ADDR), ...GET(index), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(step),

        // diff = sample - valpred
        ...GET(sample), ...GET(valpred), ...SUB, ...SET(diff),

        // sign = (diff < 0) ? 8 : 0
        ...GET(diff), ...CI32(0), ...LT_s,
        ...CI32(3), ...SHL,
        ...SET(sign),

        // if diff < 0: diff = -diff
        ...GET(diff), ...CI32(0), ...LT_s,
        ...IF,
        ...CI32(0), ...GET(diff), ...SUB, ...SET(diff),
        ...END,

        // delta = 0, vpdiff = step >> 3
        ...CI32(0), ...SET(delta),
        ...GET(step), ...CI32(3), ...SHR_s, ...SET(vpdiff),

        // successive approximation: 3 bits of magnitude
        ...GET(diff), ...GET(step), ...GE_s,
        ...IF,
        ...GET(delta), ...CI32(4), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...GET(diff), ...GET(step), ...SUB, ...SET(diff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        ...GET(diff), ...GET(step), ...GE_s,
        ...IF,
        ...GET(delta), ...CI32(2), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...GET(diff), ...GET(step), ...SUB, ...SET(diff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        ...GET(diff), ...GET(step), ...GE_s,
        ...IF,
        ...GET(delta), ...CI32(1), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,

        // nibble = delta | sign
        ...GET(delta), ...GET(sign), ...OR, ...SET(nibble),

        // update valpred
        ...GET(sign), ...CI32(0), ...EQ,
        ...IF,
        ...GET(valpred), ...GET(vpdiff), ...ADD, ...SET(valpred),
        ...ELSE,
        ...GET(valpred), ...GET(vpdiff), ...SUB, ...SET(valpred),
        ...END,

        // clamp valpred
        ...GET(valpred), ...CI32(-32768), ...LT_s,
        ...IF,
        ...CI32(-32768), ...SET(valpred),
        ...END,
        ...GET(valpred), ...CI32(32767), ...GT_s,
        ...IF,
        ...CI32(32767), ...SET(valpred),
        ...END,

        // update index
        ...CI32(IDX_TBL_ADDR), ...GET(nibble), ...CI32(0x0F), ...AND, ...ADD,
        ...LOAD8s(0, 0),
        ...GET(index), ...ADD, ...SET(index),

        // clamp index
        ...GET(index), ...CI32(0), ...LT_s,
        ...IF,
        ...CI32(0), ...SET(index),
        ...END,
        ...GET(index), ...CI32(88), ...GT_s,
        ...IF,
        ...CI32(88), ...SET(index),
        ...END,

        // pack nibble (low nibble first)
        ...GET(odd), ...CI32(0), ...EQ,
        ...IF,
        ...GET(nibble), ...CI32(0x0F), ...AND, ...SET(outByte),
        ...CI32(1), ...SET(odd),
        ...ELSE,
        ...GET(outByte), ...GET(nibble), ...CI32(0x0F), ...AND, ...CI32(4), ...SHL, ...OR, ...SET(outByte),
        ...GET(2), ...GET(outLen), ...ADD, ...GET(outByte), ...STORE8(0, 0),
        ...GET(outLen), ...CI32(1), ...ADD, ...SET(outLen),
        ...CI32(0), ...SET(outByte),
        ...CI32(0), ...SET(odd),
        ...END,

        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // save state to memory for streaming support
        ...CI32(0), ...GET(valpred), ...STORE32(2, ENC_STATE_ADDR),
        ...CI32(0), ...GET(index), ...STORE32(2, ENC_STATE_ADDR + 4),

        // flush last half-byte if numSamples is odd
        ...GET(odd), ...CI32(1), ...EQ,
        ...IF,
        ...GET(2), ...GET(outLen), ...ADD, ...GET(outByte), ...STORE8(0, 0),
        ...GET(outLen), ...CI32(1), ...ADD, ...SET(outLen),
        ...END,

        ...GET(outLen),
        ...END,
    ];
    return funcBody([{ count: 13, type: I32 }], body);
}

// ── decode_adpcm function body ────────────────────────────────────────────────
// Signature: (adpcmPtr: i32, numBytes: i32, outPtr: i32) -> i32
// Reads 8-byte header. Returns sample count.
function buildDecodeBody(): number[] {
    const valpred = 3, index = 4, step = 5, i = 6, byteVal = 7, nibble = 8;
    const vpdiff = 9, sign = 10, delta = 11, numSamples = 12, decoded = 13;

    const body = [
        // numSamples = u32 at [0..3]
        ...GET(0), ...LOAD32(2, 0), ...SET(numSamples),

        // load state from memory for streaming support
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR), ...SET(valpred),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 4), ...SET(index),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(decoded),

        ...BLOCK, ...LOOP,
        ...GET(decoded), ...GET(numSamples), ...GE_s, ...BRIF(1),
        // OOB guard: nibble byte index must be < (numBytes - HEADER_SIZE)
        ...GET(i), ...CI32(2), ...SHR_u,
        ...GET(1), ...CI32(HEADER_SIZE), ...SUB,
        ...GE_s, ...BRIF(1),

        // byteVal = u8[(adpcmPtr+HEADER_SIZE) + i/2]
        ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(1), ...SHR_u, ...ADD,
        ...LOAD8s(0, 0), ...CI32(0xFF), ...AND, ...SET(byteVal),

        // nibble: low nibble first (i&1==0 → high byte → wait, nibble order: i=0 → low nibble)
        ...GET(i), ...CI32(1), ...AND, ...CI32(0), ...EQ,
        ...IF,
        ...GET(byteVal), ...CI32(0xF), ...AND, ...SET(nibble),
        ...ELSE,
        ...GET(byteVal), ...CI32(4), ...SHR_u, ...CI32(0xF), ...AND, ...SET(nibble),
        ...END,

        // step = STEP_TABLE[index]
        ...CI32(STEP_TBL_ADDR), ...GET(index), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(step),

        // sign = nibble & 8
        ...GET(nibble), ...CI32(8), ...AND, ...SET(sign),
        // delta = nibble & 7
        ...GET(nibble), ...CI32(7), ...AND, ...SET(delta),

        // vpdiff = step >> 3
        ...GET(step), ...CI32(3), ...SHR_s, ...SET(vpdiff),

        ...GET(delta), ...CI32(4), ...AND,
        ...IF,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        ...GET(delta), ...CI32(2), ...AND,
        ...IF,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        ...GET(delta), ...CI32(1), ...AND,
        ...IF,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,

        // update valpred
        ...GET(sign), ...CI32(0), ...EQ,
        ...IF,
        ...GET(valpred), ...GET(vpdiff), ...ADD, ...SET(valpred),
        ...ELSE,
        ...GET(valpred), ...GET(vpdiff), ...SUB, ...SET(valpred),
        ...END,

        // clamp valpred
        ...GET(valpred), ...CI32(-32768), ...LT_s,
        ...IF,
        ...CI32(-32768), ...SET(valpred),
        ...END,
        ...GET(valpred), ...CI32(32767), ...GT_s,
        ...IF,
        ...CI32(32767), ...SET(valpred),
        ...END,

        // update index
        ...CI32(IDX_TBL_ADDR), ...GET(nibble), ...CI32(0x0F), ...AND, ...ADD,
        ...LOAD8s(0, 0),
        ...GET(index), ...ADD, ...SET(index),

        // clamp index
        ...GET(index), ...CI32(0), ...LT_s,
        ...IF,
        ...CI32(0), ...SET(index),
        ...END,
        ...GET(index), ...CI32(88), ...GT_s,
        ...IF,
        ...CI32(88), ...SET(index),
        ...END,

        // write i16 sample
        ...GET(2), ...GET(decoded), ...CI32(1), ...SHL, ...ADD,
        ...GET(valpred), ...STORE16(1, 0),

        ...GET(decoded), ...CI32(1), ...ADD, ...SET(decoded),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // save state to memory for streaming support
        ...CI32(0), ...GET(valpred), ...STORE32(2, DEC_STATE_ADDR),
        ...CI32(0), ...GET(index), ...STORE32(2, DEC_STATE_ADDR + 4),

        ...GET(decoded),
        ...END,
    ];
    return funcBody([{ count: 11, type: I32 }], body);
}

// Signature: () -> ()
function buildResetStateBody(addr: number): number[] {
    return funcBody([], [
        ...CI32(0), ...CI32(0), ...STORE32(2, addr),
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 4),
        ...END,
    ]);
}

// ── Assemble final WASM binary ────────────────────────────────────────────────

export function buildAdpcmWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    const typeSection = section(1, [
        ...encodeULEB(2),
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32, // encode/decode
        0x60, ...encodeULEB(0), ...encodeULEB(0),                     // void reset
    ]);

    const funcSection = section(3, [
        ...encodeULEB(4),
        ...encodeULEB(0), // encode (type 0)
        ...encodeULEB(0), // decode (type 0)
        ...encodeULEB(1), // reset_encode (type 1)
        ...encodeULEB(1), // reset_decode (type 1)
    ]);
    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(1), ...encodeULEB(2048)]);

    const exportSection = section(7, [
        ...encodeULEB(5),
        ...nameSec("memory"), 0x02, ...encodeULEB(0),
        ...nameSec("encode_adpcm"), 0x00, ...encodeULEB(0),
        ...nameSec("decode_adpcm"), 0x00, ...encodeULEB(1),
        ...nameSec("reset_encoder_state"), 0x00, ...encodeULEB(2),
        ...nameSec("reset_decoder_state"), 0x00, ...encodeULEB(3),
    ]);

    const indexBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        indexBytes[i] = INDEX_TABLE[i] < 0 ? 256 + INDEX_TABLE[i] : INDEX_TABLE[i];
    }
    const stepBytes = new Uint8Array(89 * 2);
    const stepView = new DataView(stepBytes.buffer);
    for (let i = 0; i < 89; i++) stepView.setUint16(i * 2, STEP_TABLE[i], true);

    function dataSeg(addr: number, bytes: Uint8Array): number[] {
        return [0x00, ...CI32(addr), ...END, ...encodeULEB(bytes.length), ...bytes];
    }

    const dataSection = section(11, [
        ...encodeULEB(2),
        ...dataSeg(IDX_TBL_ADDR, indexBytes),
        ...dataSeg(STEP_TBL_ADDR, stepBytes),
    ]);

    const codeSection = section(10, [
        ...encodeULEB(4),
        ...buildEncodeBody(),
        ...buildDecodeBody(),
        ...buildResetStateBody(ENC_STATE_ADDR),
        ...buildResetStateBody(DEC_STATE_ADDR),
    ]);

    return new Uint8Array([
        ...magic,
        ...typeSection,
        ...funcSection,
        ...memSection,
        ...exportSection,
        ...codeSection,
        ...dataSection,
    ]);
}

// ── Runtime wrapper ───────────────────────────────────────────────────────────

export interface AdpcmWasmExports {
    memory: WebAssembly.Memory;
    encode_adpcm: (pcmPtr: number, numSamples: number, outPtr: number) => number;
    decode_adpcm: (adpcmPtr: number, numBytes: number, outPtr: number) => number;
    reset_encoder_state: () => void;
    reset_decoder_state: () => void;
}

let _wasmPromise: Promise<AdpcmWasmExports> | null = null;

export function getAdpcmWasm(): Promise<AdpcmWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildAdpcmWasmBytes();
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const mod = await WebAssembly.compile(buf);
        const inst = await WebAssembly.instantiate(mod, {});
        return inst.exports as unknown as AdpcmWasmExports;
    })();
    return _wasmPromise;
}

export const WASM_BUF = BUF_START;

// ── Signal conditioning ────────────────────────────────────────────────────────
//
// Two filters applied in the JS domain before encode and after decode.
// These are intentionally in JS (not WASM) since they operate on Float32 —
// keeping them here avoids adding f32 arithmetic to the WASM bytecode while
// still giving us near-zero overhead from a typed-array loop.
//
// 1. DC blocker (high-pass, α ≈ 0.9999): removes mic DC offset so ADPCM
//    doesn't waste bits tracking a constant bias. Implements the standard
//    y[n] = x[n] - x[n-1] + α·y[n-1] first-order IIR.
//
// 2. Pre-emphasis  (encode only, μ = 0.97): boosts high frequencies before
//    encode. Voice energy is concentrated in mid/high freqs; ADPCM quantisation
//    error is perceptually worst in those ranges. Boosting them pre-encode
//    and flattening them post-decode (de-emphasis) gives a perceptibly cleaner
//    result, equivalent to a free ~3dB SNR improvement for voice.

const DC_ALPHA = 0.9999;
const PREEMPH_MU = 0.90; // Reduced pre-emphasis for more natural sound

// --- Streaming DSP State ---
let dcXPrev = 0;
let dcYPrev = 0;
let expEnv = 0;
let expGain = 1.0;
let preemphPrev = 0;
let deemphPrev = 0;

export function resetAdpcmFilters(): void {
    dcXPrev = 0;
    dcYPrev = 0;
    expEnv = 0;
    expGain = 1.0;
    preemphPrev = 0;
    deemphPrev = 0;
}

function applyDcBlockAndPreemphasis(samples: Float32Array, sampleRate: number): Float32Array {
    const out = new Float32Array(samples.length);

    // DC blocker
    for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const dc = x - dcXPrev + DC_ALPHA * dcYPrev;
        dcXPrev = x;
        dcYPrev = dc;
        out[i] = dc;
    }

    // --- Very Gentle Noise Gate ---
    // Preserve natural room tone and breath by only reducing very low-level noise slightly
    const GATE_THRESH = 0.00001; // ~ -50 dBFS (lower threshold = more noise preserved)
    const ATTACK_MS = 5; // Faster attack for immediate response
    const RELEASE_MS = 500; // Very slow release to avoid pumping artifacts

    const alphaAttack = Math.exp(-1 / (sampleRate * (ATTACK_MS / 1000)));
    const alphaRelease = Math.exp(-1 / (sampleRate * (RELEASE_MS / 1000)));

    for (let i = 0; i < out.length; i++) {
        const energy = out[i] * out[i];
        expEnv = energy > expEnv
            ? alphaAttack * expEnv + (1 - alphaAttack) * energy
            : alphaRelease * expEnv + (1 - alphaRelease) * energy;

        // Target gain: 1.0 for voice, 0.85 for background noise (very subtle reduction)
        const targetGain = expEnv > GATE_THRESH ? 1.0 : 0.85;

        expGain = targetGain > expGain
            ? alphaAttack * expGain + (1 - alphaAttack) * targetGain
            : alphaRelease * expGain + (1 - alphaRelease) * targetGain;

        out[i] *= expGain;
    }

    // --- Pre-emphasis & Soft Clipping ---
    const preout = new Float32Array(samples.length);
    for (let i = 0; i < out.length; i++) {
        let s = out[i] - PREEMPH_MU * preemphPrev;
        preemphPrev = out[i];

        // Very Gentle Soft Clipper
        // Preserves transients by only clipping at very high levels with a gentle curve
        if (s > 0.95) {
            s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05);
        } else if (s < -0.95) {
            s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
        }

        preout[i] = s;
    }

    return preout;
}

function applyDeemphasis(samples: Float32Array): Float32Array {
    // De-emphasis: y[n] = x[n] + mu * y[n-1]  (inverse of pre-emphasis)
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        out[i] = samples[i] + PREEMPH_MU * deemphPrev;
        deemphPrev = out[i];
    }
    return out;
}

// ── Public encode / decode ────────────────────────────────────────────────────

/**
 * Encode Float32 PCM (-1..1) to ADPCM bytes.
 * Applies DC blocker + pre-emphasis before encode.
 * @param sampleRate  The AudioContext sample rate (stored in header, used for correct playback).
 */
export async function encodeAdpcm(
    float32Samples: Float32Array,
    sampleRate: number,
): Promise<Uint8Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    const numSamples = float32Samples.length;
    const pcmBytes = numSamples * 2;
    const outMaxBytes = HEADER_SIZE + Math.ceil(numSamples / 2);
    const totalNeeded = WASM_BUF + pcmBytes + outMaxBytes;

    while (mem.buffer.byteLength < totalNeeded) mem.grow(1);

    // For file-based usage, we reset state on every fresh encode.
    // Realtime streaming would skip this.
    wasm.reset_encoder_state();
    resetAdpcmFilters();

    const pcmPtr = WASM_BUF;
    const outPtr = WASM_BUF + pcmBytes;

    // Apply DC blocker + Noise Gate + pre-emphasis
    const conditioned = applyDcBlockAndPreemphasis(float32Samples, sampleRate);

    // Convert Float32 → Int16
    const view = new DataView(mem.buffer);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, conditioned[i]));
        view.setInt16(pcmPtr + i * 2, Math.round(s * 32767), true);
    }

    const bytesWritten = wasm.encode_adpcm(pcmPtr, numSamples, outPtr);

    // Patch sample rate into header bytes [4..5] (u16 LE)
    view.setUint16(outPtr + 4, sampleRate & 0xFFFF, true);

    return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
}

/**
 * Decode ADPCM bytes back to Float32Array (-1..1).
 * Returns { pcm, sampleRate } — use sampleRate for correct AudioBuffer creation.
 * Applies de-emphasis after decode.
 */
export async function decodeAdpcm(
    adpcmBytes: Uint8Array,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    if (adpcmBytes.length < HEADER_SIZE) throw new Error("adpcm: payload too short");

    const hdr = new DataView(adpcmBytes.buffer, adpcmBytes.byteOffset, HEADER_SIZE);
    const numSamples = hdr.getUint32(0, true);
    const sampleRate = hdr.getUint16(4, true) || 48000; // fallback for legacy 4-byte headers

    const inBytes = adpcmBytes.length;
    const outBytes = numSamples * 2;
    const totalNeeded = WASM_BUF + inBytes + outBytes;

    while (mem.buffer.byteLength < totalNeeded) mem.grow(1);

    // For file-based usage, we reset state on every fresh decode.
    // Realtime streaming would skip this.
    wasm.reset_decoder_state();
    resetAdpcmFilters();

    const inPtr = WASM_BUF;
    const outPtr = WASM_BUF + inBytes;

    new Uint8Array(mem.buffer).set(adpcmBytes, inPtr);

    const samplesDecoded = wasm.decode_adpcm(inPtr, inBytes, outPtr);

    // Int16 → Float32
    const raw = new Float32Array(samplesDecoded);
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < samplesDecoded; i++) {
        raw[i] = dv.getInt16(outPtr + i * 2, true) / 32768;
    }

    // De-emphasis
    const pcm = applyDeemphasis(raw);

    // Normalize if peak > 1.0 to guarantee the Web Audio API never hard-clips.
    // De-emphasis can occasionally push transients slightly above 1.0 due to 
    // the restored bass frequencies and ADPCM quantisation noise.
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
        const abs = Math.abs(pcm[i]);
        if (abs > peak) peak = abs;
    }
    if (peak > 1.0) {
        const scale = 1.0 / peak;
        for (let i = 0; i < pcm.length; i++) pcm[i] *= scale;
    }

    return { pcm, sampleRate };
}

// ── WAV export ────────────────────────────────────────────────────────────────

/**
 * Encode Float32 PCM into a standard RIFF WAV (16-bit, mono).
 * Universally playable — every OS, every media player.
 */
export function wavFromPcm(pcm: Float32Array, sampleRate: number): Uint8Array {
    const numSamples = pcm.length;
    const byteRate = sampleRate * 2;      // 1 ch × 16-bit = 2 bytes/sample
    const dataBytes = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);

    // RIFF header
    dv.setUint32(0, 0x52494646, false);   // "RIFF"
    dv.setUint32(4, 36 + dataBytes, true);
    dv.setUint32(8, 0x57415645, false);   // "WAVE"
    // fmt chunk
    dv.setUint32(12, 0x666d7420, false);   // "fmt "
    dv.setUint32(16, 16, true);            // chunk size
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, 1, true);            // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, 2, true);            // block align
    dv.setUint16(34, 16, true);            // bits per sample
    // data chunk
    dv.setUint32(36, 0x64617461, false);   // "data"
    dv.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
        off += 2;
    }
    return new Uint8Array(buf);
}

/**
 * Convert Whisper ADPCM bytes → WAV Blob ready for URL.createObjectURL().
 */
export async function adpcmToWav(adpcmBytes: Uint8Array): Promise<Blob> {
    const { pcm, sampleRate } = await decodeAdpcm(adpcmBytes);
    const wav = wavFromPcm(pcm, sampleRate);
    return new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], { type: "audio/wav" });
}
