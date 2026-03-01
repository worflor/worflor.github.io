/**
 * live-wasm-video.ts
 *
 * the Whisper Lumen Video Codec by Woflo / MB
 *
 * every 8x8 block is modelled as a physical surface. the encoder fits the
 * second-order causal Taylor expansion of that surface:
 *
 *   pred = D + α·(L-D) + β·(A-D) + γ·(fyy + fxx + fxy)
 *
 * α is horizontal gradient (fy), β is vertical gradient (fx), and γ covers the
 * full Hessian correction ½ΔᵀHΔ, all three second-order curvature terms at once.
 * a 3x3 normal equation solver (Gaussian elimination) fits these per block.
 * whatever the surface model can't explain becomes the residual.
 *
 * a digital twin of light. the wire carries surface geometry, the decoder
 * reconstructs pixels from physics.
 *
 * all hot-path functions (color conversion, delta, zigzag, PQ, quantization,
 * block ops, dithering) run in hand-written WebAssembly with v128 SIMD.
 */
import * as simd from "./video-simd";

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

const GET = (i: number) => [0x20, ...encodeULEB(i)];
const SET = (i: number) => [0x21, ...encodeULEB(i)];
const CI32 = (v: number) => [0x41, ...encodeSLEB(v)];
const BR = (l: number) => [0x0c, ...encodeULEB(l)];
const BRIF = (l: number) => [0x0d, ...encodeULEB(l)];
const BLOCK = [0x02, VOID];
const LOOP = [0x03, VOID];
const IF = [0x04, VOID];
const END = [0x0b];

const LOAD16s = (al: number, off: number) => [0x2e, al, ...encodeULEB(off)];
const LOAD16u = (al: number, off: number) => [0x2f, al, ...encodeULEB(off)];
const LOAD32 = (al: number, off: number) => [0x28, al, ...encodeULEB(off)];
const STORE16 = (al: number, off: number) => [0x3b, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [0x36, al, ...encodeULEB(off)];

const ADD = [0x6a];
const SUB = [0x6b];
const MUL = [0x6c];
const SHL = [0x74];
const SHR_u = [0x76];
const ROTL = [0x77];
const AND = [0x71];
const XOR = [0x73];
const GE_s = [0x4e];
const EQ = [0x46];

function encodeLocals(decls: { count: number; type: number }[]): number[] {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}

function funcBody(locals: { count: number; type: number }[], instr: number[]): number[] {
    const body = [...encodeLocals(locals), ...instr.flat()];
    return [...encodeULEB(body.length), ...body];
}

function avalanche(reg: number): number[] {
    return [
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR, ...SET(reg),
        ...GET(reg), ...CI32(0x85EBCA6B), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(13), ...SHR_u, ...XOR, ...SET(reg),
        ...GET(reg), ...CI32(0xC2B2AE35), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR, ...SET(reg),
    ];
}

const ENC_STATE_ADDR = 0x0100;
const DEC_STATE_ADDR = 0x0200;
const BUF_START = 0x0300;
export const HEADER_SIZE = 12; // width(u16), height(u16), frameIdx(u32), flags(u32)
export const MAC_SIZE = 8;

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
            ...STORE32(2, stateAddr + 64 + i * 4)
        );
    }

    return [
        ...loadState,
        ...rounds,
        ...saveState,
        ...CI32(0), ...CI32(0), ...LOAD32(2, stateAddr + 48), ...CI32(1), ...ADD, ...STORE32(2, stateAddr + 48),
    ];
}

/** per-frame setup: nonce from frame counter, reset block counter, write header frameIdx */
function buildFrameSetup(stateAddr: number, outPtrLocal?: number): number[] {
    return [
        // Set nonce word 0 from frame counter
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 144),
        ...STORE32(2, stateAddr + 52),
        // Write frame counter to packet header (encode only)
        ...(outPtrLocal !== undefined ? [
            ...GET(outPtrLocal),
            ...CI32(0), ...LOAD32(2, stateAddr + 144),
            ...STORE32(2, 4),
        ] : []),
        // Increment frame counter
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 144), ...CI32(1), ...ADD,
        ...STORE32(2, stateAddr + 144),
        // Reset block counter for new frame
        ...CI32(0), ...CI32(0), ...STORE32(2, stateAddr + 48),
    ];
}

/** PRF-based ratchet: generates a ChaCha block, copies output to all 8 key words,
 *  mixes MAC into nonce for forward secrecy binding, re-keys MAC */
function buildRatchet(stateAddr: number, v: number[], mac0: number, mac1: number, temp: number): number[] {
    const copyKeyFromOutput: number[] = [];
    for (let j = 0; j < 8; j++) {
        copyKeyFromOutput.push(
            ...CI32(0),
            ...CI32(0), ...LOAD32(2, stateAddr + 64 + j * 4),
            ...STORE32(2, stateAddr + 16 + j * 4),
        );
    }
    return [
        // Generate ratchet block (consumes one ChaCha counter value)
        ...buildChaChaBlock(stateAddr, v),
        // Full 256-bit key refresh from PRF output
        ...copyKeyFromOutput,
        // Mix MAC snapshot into nonce for forward secrecy binding
        // (use temp as scratch, don't modify mac0/mac1, MAC must cover entire frame)
        ...GET(mac0), ...SET(temp), ...avalanche(temp),
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 52), ...GET(temp), ...XOR,
        ...STORE32(2, stateAddr + 52),
        ...GET(mac1), ...SET(temp), ...avalanche(temp),
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 56), ...GET(temp), ...XOR,
        ...STORE32(2, stateAddr + 56),
        // MAC continues accumulating, never reset mid-frame
    ];
}

function buildEncodeBody(): number[] {
    const i = 3, pixel = 4, outLen = 5, idx = 6, keystream_word = 7, pixel_count = 8, mac0 = 9, mac1 = 10, temp = 11, remainder = 12;
    const v = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28];

    const processPixel = (blockOffset: number) => [
        // Read 32-bit pixel (RGBA) (Scalar fallback for remainder)
        ...GET(0), ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOAD32(2, 0), ...SET(temp),

        // Keystream XOR
        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...CI32(blockOffset), ...ADD,
        ...LOAD32(2, 0), ...SET(idx), // idx is 6 (i32)
        ...GET(temp), ...GET(idx), ...XOR, ...SET(temp), // temp is 11 (i32)

        // MAC Update
        ...GET(mac0), ...GET(temp), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(temp), ...ADD, ...SET(mac1),

        // Write encrypted pixel
        ...GET(2), ...GET(outLen), ...ADD, ...GET(temp), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),

        ...GET(pixel_count), ...CI32(1), ...ADD, ...SET(pixel_count),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
    ];

    // We use SIMD to process 4 pixels (16 bytes = 128 bits) at a time
    // This perfectly matches 1/4th of a ChaCha block (64 bytes)
    const processQuadPixel = (blockOffset: number) => [
        // Load 4 pixels (128 bits) from input buffer
        ...GET(0), ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...V128_LOAD(4, 0), ...SET(pixel), // Use 'pixel' local as v128

        // Load 128 bits (16 bytes) of keystream
        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...CI32(blockOffset), ...ADD,
        ...V128_LOAD(4, 0), ...SET(keystream_word), // Use as v128

        // XOR 4 pixels with keystream in one instruction
        ...GET(pixel), ...GET(keystream_word), ...V128_XOR, ...SET(pixel),

        // For MAC update, we need to extract the 32-bit lanes, but to save SIMD complexity
        // we'll just store the encrypted v128 to memory, then read it back as I32 for the scalar MAC.
        // Or better yet, we can do scalar MAC directly from memory after storing.
        ...GET(2), ...GET(outLen), ...ADD, ...GET(pixel), ...V128_STORE(4, 0),

        // Now do scalar MAC on the 4 words we just stored
        // Word 0
        ...GET(mac0), ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 0), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 0), ...ADD, ...SET(mac1),
        // Word 1
        ...GET(mac0), ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 4), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 4), ...ADD, ...SET(mac1),
        // Word 2
        ...GET(mac0), ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 8), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 8), ...ADD, ...SET(mac1),
        // Word 3
        ...GET(mac0), ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 12), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(2), ...GET(outLen), ...ADD, ...LOAD32(2, 12), ...ADD, ...SET(mac1),

        ...GET(outLen), ...CI32(16), ...ADD, ...SET(outLen),
        ...GET(pixel_count), ...CI32(4), ...ADD, ...SET(pixel_count), // processed 4 pixels
        ...GET(i), ...CI32(4), ...ADD, ...SET(i),
    ];

    let unrolled = [];
    // 64 bytes per ChaCha block / 16 bytes per quad = 4 iterations
    for (let j = 0; j < 4; j++) {
        unrolled.push(...processQuadPixel(j * 16));
    }

    const body = [
        // Per-frame setup: nonce from counter, reset block counter, write header
        ...buildFrameSetup(ENC_STATE_ADDR, 2),

        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 132), ...SET(pixel_count),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 140), ...SET(mac1),
        ...CI32(0), ...SET(i),
        ...CI32(HEADER_SIZE), ...SET(outLen),

        // Main unrolled loop (16 pixels per block)
        ...BLOCK, ...LOOP,
        ...GET(1), ...GET(i), ...SUB, ...SET(remainder),
        ...GET(remainder), ...CI32(16), ...GE_s, ...CI32(0), ...EQ, ...BRIF(1),

        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...unrolled,

        // PRF-based ratchet every 4096 pixels, full 256-bit key refresh
        ...GET(pixel_count), ...CI32(4095), ...AND, ...CI32(0), ...EQ,
        ...IF,
        ...buildRatchet(ENC_STATE_ADDR, v, mac0, mac1, temp),
        ...END,

        ...BR(0),
        ...END, ...END,

        // Remainder loop (1 pixel at a time, dynamic keystream offset)
        ...GET(i), ...GET(1), ...GE_s, ...CI32(0), ...EQ,
        ...IF,
        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx), // idx = keystream byte offset within block
        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(1), ...GE_s, ...BRIF(1),

        // Read pixel
        ...GET(0), ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOAD32(2, 0), ...SET(temp),
        // Keystream XOR (dynamic offset: mem[idx + STATE+64])
        ...GET(idx), ...LOAD32(2, ENC_STATE_ADDR + 64), ...SET(remainder),
        ...GET(temp), ...GET(remainder), ...XOR, ...SET(temp),
        // MAC
        ...GET(mac0), ...GET(temp), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(temp), ...ADD, ...SET(mac1),
        // Write encrypted pixel
        ...GET(2), ...GET(outLen), ...ADD, ...GET(temp), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),
        // Advance
        ...GET(pixel_count), ...CI32(1), ...ADD, ...SET(pixel_count),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        ...BR(0),
        ...END, ...END,
        ...END,

        // Append MAC
        ...GET(2), ...GET(outLen), ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),
        ...GET(2), ...GET(outLen), ...ADD, ...GET(mac1), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),

        ...CI32(0), ...GET(pixel_count), ...STORE32(2, ENC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, ENC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, ENC_STATE_ADDR + 140),

        ...GET(outLen),
        ...END,
    ];

    // Locals definition:
    // 3: i (i32)
    // 4: pixel (v128)
    // 5: outLen (i32)
    // 6: idx (i32)
    // 7: keystream_word (v128)
    // 8: pixel_count (i32)
    // 9: mac0 (i32)
    // 10: mac1 (i32)
    // 11: temp (i32)
    // 12: remainder (i32)
    // 13-28: v (i32 x 16)

    const localDecls = [
        { count: 1, type: I32 },  // 3: i
        { count: 1, type: V128 }, // 4: pixel
        { count: 2, type: I32 },  // 5: outLen, 6: idx
        { count: 1, type: V128 }, // 7: keystream_word
        { count: 21, type: I32 }  // 8..28: pixel_count, mac0, mac1, temp, remainder, v[16]
    ];

    return funcBody(localDecls, body);
}

function buildDecodeBody(): number[] {
    const i = 3, inPixel = 4, ks_v128 = 5, decodedCount = 6, pixel_count = 7, mac0 = 8, mac1 = 9, temp = 10, totalPixels = 11, expMac0 = 12, expMac1 = 13, remainder = 14;
    const v = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

    const processPixel = (blockOffset: number) => [
        ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOAD32(2, 0), ...SET(expMac0), // expMac0 (11) is i32

        // Update MAC with cipher text FIRST
        ...GET(mac0), ...GET(expMac0), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(expMac0), ...ADD, ...SET(mac1),

        // Keystream XOR
        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...CI32(blockOffset), ...ADD,
        ...LOAD32(2, 0), ...SET(remainder), // remainder (13) is i32
        ...GET(expMac0), ...GET(remainder), ...XOR, ...SET(expMac0),

        // Write decrypted pixel
        ...GET(2), ...GET(decodedCount), ...CI32(2), ...SHL, ...ADD,
        ...GET(expMac0), ...STORE32(2, 0),

        ...GET(decodedCount), ...CI32(1), ...ADD, ...SET(decodedCount),
        ...GET(pixel_count), ...CI32(1), ...ADD, ...SET(pixel_count),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
    ];

    const processQuadPixel = (blockOffset: number) => [
        // Load cipher text (4 pixels / 16 bytes)
        ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...V128_LOAD(4, 0), ...SET(inPixel), // as v128

        // Update MAC with cipher text FIRST
        // Word 0
        ...GET(mac0), ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 0), ...ADD, ...SET(mac1),
        // Word 1
        ...GET(mac0), ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 4), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 4), ...ADD, ...SET(mac1),
        // Word 2
        ...GET(mac0), ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 8), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 8), ...ADD, ...SET(mac1),
        // Word 3
        ...GET(mac0), ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 12), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD, ...LOAD32(2, 12), ...ADD, ...SET(mac1),


        // Keystream XOR
        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...CI32(blockOffset), ...ADD,
        ...V128_LOAD(4, 0), ...SET(ks_v128),
        ...GET(inPixel), ...GET(ks_v128), ...V128_XOR, ...SET(inPixel),

        // Write decrypted 128-bit block
        ...GET(2), ...GET(decodedCount), ...CI32(2), ...SHL, ...ADD,
        ...GET(inPixel), ...V128_STORE(4, 0),

        ...GET(decodedCount), ...CI32(4), ...ADD, ...SET(decodedCount),
        ...GET(pixel_count), ...CI32(4), ...ADD, ...SET(pixel_count),
        ...GET(i), ...CI32(4), ...ADD, ...SET(i),
    ];

    let unrolled = [];
    for (let j = 0; j < 4; j++) {
        unrolled.push(...processQuadPixel(j * 16));
    }

    const body = [
        // Per-frame setup: nonce from counter, reset block counter
        ...buildFrameSetup(DEC_STATE_ADDR),

        ...GET(0), ...LOAD16u(1, 0), ...SET(totalPixels), // width
        ...GET(0), ...LOAD16u(1, 2), ...GET(totalPixels), ...MUL, ...SET(totalPixels), // width * height

        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 132), ...SET(pixel_count),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 140), ...SET(mac1),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(decodedCount),

        ...BLOCK, ...LOOP,
        ...GET(totalPixels), ...GET(decodedCount), ...SUB, ...SET(remainder),
        ...GET(remainder), ...CI32(16), ...GE_s, ...CI32(0), ...EQ, ...BRIF(1),

        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...unrolled,

        // PRF-based ratchet every 4096 pixels, full 256-bit key refresh
        ...GET(pixel_count), ...CI32(4095), ...AND, ...CI32(0), ...EQ,
        ...IF,
        ...buildRatchet(DEC_STATE_ADDR, v, mac0, mac1, temp),
        ...END,

        ...BR(0),
        ...END, ...END,

        // Remainder loop (dynamic keystream offset)
        ...GET(decodedCount), ...GET(totalPixels), ...GE_s, ...CI32(0), ...EQ,
        ...IF,
        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...CI32(0), ...SET(temp), // temp = keystream byte offset within block
        ...BLOCK, ...LOOP,
        ...GET(decodedCount), ...GET(totalPixels), ...GE_s, ...BRIF(1),

        // Read ciphertext
        ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOAD32(2, 0), ...SET(expMac0),
        // MAC with ciphertext FIRST
        ...GET(mac0), ...GET(expMac0), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(expMac0), ...ADD, ...SET(mac1),
        // Keystream XOR (dynamic offset: mem[temp + STATE+64])
        ...GET(temp), ...LOAD32(2, DEC_STATE_ADDR + 64), ...SET(remainder),
        ...GET(expMac0), ...GET(remainder), ...XOR, ...SET(expMac0),
        // Write decrypted pixel
        ...GET(2), ...GET(decodedCount), ...CI32(2), ...SHL, ...ADD,
        ...GET(expMac0), ...STORE32(2, 0),
        // Advance
        ...GET(decodedCount), ...CI32(1), ...ADD, ...SET(decodedCount),
        ...GET(pixel_count), ...CI32(1), ...ADD, ...SET(pixel_count),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...GET(temp), ...CI32(4), ...ADD, ...SET(temp),

        ...BR(0),
        ...END, ...END,
        ...END,

        // Verify MAC
        ...GET(0), ...GET(1), ...CI32(8), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac0),
        ...GET(0), ...GET(1), ...CI32(4), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac1),
        ...GET(mac0), ...GET(expMac0), ...EQ, ...GET(mac1), ...GET(expMac1), ...EQ, ...AND,
        ...CI32(0), ...EQ,
        ...IF, ...CI32(0), ...SET(decodedCount), ...END,

        ...CI32(0), ...GET(pixel_count), ...STORE32(2, DEC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, DEC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, DEC_STATE_ADDR + 140),

        ...GET(decodedCount),
        ...END,
    ];
    const localDecls = [
        { count: 1, type: I32 },  // 3: i
        { count: 2, type: V128 }, // 4: inPixel, 5: ks_v128
        { count: 9, type: I32 },  // 6-14: decodedCount, pixel_count, mac0, mac1, temp, totalPixels, expMac0, expMac1, remainder
        { count: 16, type: I32 }, // 15-30: v[16] ChaCha state
    ];
    return funcBody(localDecls, body);
}

function buildResetStateBody(addr: number): number[] {
    // 8 params: k0..k7 = full 256-bit key (RFC 8439 ChaCha20)
    const k0 = 0, k1 = 1, k2 = 2, k3 = 3, k4 = 4, k5 = 5, k6 = 6, k7 = 7;
    return funcBody([], [
        // "expand 32-byte k" constants
        ...CI32(0), ...CI32(0x61707865), ...STORE32(2, addr + 0),
        ...CI32(0), ...CI32(0x3320646e), ...STORE32(2, addr + 4),
        ...CI32(0), ...CI32(0x79622d32), ...STORE32(2, addr + 8),
        ...CI32(0), ...CI32(0x6b206574), ...STORE32(2, addr + 12),
        // Key (256 bits = 8 words)
        ...CI32(0), ...GET(k0), ...STORE32(2, addr + 16),
        ...CI32(0), ...GET(k1), ...STORE32(2, addr + 20),
        ...CI32(0), ...GET(k2), ...STORE32(2, addr + 24),
        ...CI32(0), ...GET(k3), ...STORE32(2, addr + 28),
        ...CI32(0), ...GET(k4), ...STORE32(2, addr + 32),
        ...CI32(0), ...GET(k5), ...STORE32(2, addr + 36),
        ...CI32(0), ...GET(k6), ...STORE32(2, addr + 40),
        ...CI32(0), ...GET(k7), ...STORE32(2, addr + 44),
        // Counter = 0
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 48),
        // Nonce (word 0 set per-frame from frame counter; words 1-2 static seed)
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 52),
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 56),
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 60),
        // Extended state
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 128),
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 132), // pixel_count
        // Keyed MAC seed (derived from key, domain-separated)
        ...CI32(0), ...GET(k0), ...CI32(0x736f6d65), ...XOR, ...STORE32(2, addr + 136),
        ...CI32(0), ...GET(k1), ...CI32(0x646f7261), ...XOR, ...STORE32(2, addr + 140),
        ...CI32(0), ...CI32(0), ...STORE32(2, addr + 144), // frame_counter
        ...END,
    ]);
}

// Wasm SIMD (v128) opcodes
const V128 = 0x7b;
const V128_LOAD = (al: number, off: number) => [0xfd, 0x00, al, ...encodeULEB(off)];
const V128_STORE = (al: number, off: number) => [0xfd, 0x0b, al, ...encodeULEB(off)];
const V128_XOR = [0xfd, 0x51];

export function buildVideoWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const typeSection = section(1, [
        ...encodeULEB(2),
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32,  // type 0: (i32,i32,i32)->i32
        0x60, ...encodeULEB(8), I32, I32, I32, I32, I32, I32, I32, I32, ...encodeULEB(0), // type 1: (i32 x 8)->void
    ]);
    const funcSection = section(3, [
        ...encodeULEB(4),
        ...encodeULEB(0),
        ...encodeULEB(0),
        ...encodeULEB(1),
        ...encodeULEB(1),
    ]);
    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(16), ...encodeULEB(8192)]);
    const exportSection = section(7, [
        ...encodeULEB(5),
        ...nameSec("memory"), 0x02, ...encodeULEB(0),
        ...nameSec("encode_video"), 0x00, ...encodeULEB(0),
        ...nameSec("decode_video"), 0x00, ...encodeULEB(1),
        ...nameSec("reset_encoder_state"), 0x00, ...encodeULEB(2),
        ...nameSec("reset_decoder_state"), 0x00, ...encodeULEB(3),
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
    ]);
}

export interface VideoWasmExports {
    memory: WebAssembly.Memory;
    encode_video: (pixelsPtr: number, numPixels: number, outPtr: number) => number;
    decode_video: (packetPtr: number, packetLen: number, outPtr: number) => number;
    reset_encoder_state: (k0: number, k1: number, k2: number, k3: number, k4: number, k5: number, k6: number, k7: number) => void;
    reset_decoder_state: (k0: number, k1: number, k2: number, k3: number, k4: number, k5: number, k6: number, k7: number) => void;
}

let _wasmPromise: Promise<VideoWasmExports> | null = null;
export function getVideoWasm(): Promise<VideoWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildVideoWasmBytes();
        const result = await WebAssembly.instantiate(bytes, {}) as any;
        return result.instance.exports as unknown as VideoWasmExports;
    })();
    return _wasmPromise;
}

export interface PacketHeader {
    width: number;
    height: number;
    frameIdx: number;
    flags: number;
}

// --- pseudo-dimension helpers for WASM ---
// WASM decode reads width(u16)*height(u16) from header to get pixel count.
// for compressed packets, we need to fit pseudoPixels into two u16 fields.
function pseudoDims(n: number): [number, number] {
    if (n <= 65535) return [n, 1];
    const h = Math.ceil(n / 65535);
    const w = Math.ceil(n / h);
    return [w, h];
}

// --- flags field layout (32 bits) ---
const FLAG_COMPRESSED = 1 << 0;
const FLAG_KEYFRAME = 1 << 1;
const FLAG_QUALITY_SHIFT = 2;
const FLAG_QUALITY_MASK = 0x7F; // 7 bits, values 1-100

function encodeFlags(compressed: boolean, keyframe: boolean, quality: number): number {
    let f = 0;
    if (compressed) f |= FLAG_COMPRESSED;
    if (keyframe) f |= FLAG_KEYFRAME;
    f |= (quality & FLAG_QUALITY_MASK) << FLAG_QUALITY_SHIFT;
    return f;
}

function decodeFlags(flags: number): {
    compressed: boolean; keyframe: boolean; quality: number;
} {
    return {
        compressed: (flags & FLAG_COMPRESSED) !== 0,
        keyframe: (flags & FLAG_KEYFRAME) !== 0,
        quality: (flags >>> FLAG_QUALITY_SHIFT) & FLAG_QUALITY_MASK,
    };
}

// --- color space conversion ---

function rgbaToYuv420(rgba: Uint8Array, w: number, h: number): Uint8Array {
    return simd.rgbaToYuv420(rgba, w, h);
}

function yuv420ToRgba(yuv: Uint8Array, w: number, h: number): Uint8Array {
    return simd.yuv420ToRgba(yuv, w, h);
}

// --- delta frame engine ---
// subtraction delta (mod 256) instead of XOR: small changes produce small values
// centered around 0, which quantize and compress much more efficiently.
// XOR of 100 and 103 gives 7; subtraction gives 3, smaller residual.

function computeDelta(current: Uint8Array, previous: Uint8Array): Uint8Array {
    return simd.computeDelta(current, previous);
}

function applyDelta(delta: Uint8Array, previous: Uint8Array): Uint8Array {
    return simd.applyDelta(delta, previous);
}

// --- block skip ---
// operates on spatial blocks across the Y plane for motion detection,
// but extracts/reinserts from the full YUV420 buffer so UV planes are included.

function buildBlockBitmap(
    yDelta: Uint8Array, w: number, h: number, blockSize: number, threshold: number
): { bitmap: Uint8Array; blocksX: number; blocksY: number; changedCount: number } {
    return simd.buildBlockBitmap(yDelta, w, h, blockSize, threshold);
}

function extractChangedBlocksPlane(
    data: Uint8Array, planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    planeBlockSize: number
): Uint8Array {
    return simd.extractChangedBlocksPlane(data, planeW, planeH, bitmap, blocksX, blocksY, planeBlockSize);
}

function reinsertChangedBlocksPlane(
    blockData: Uint8Array, readStart: number,
    planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    planeBlockSize: number, base: Uint8Array
): number {
    return simd.reinsertChangedBlocksPlane(blockData, readStart, planeW, planeH, bitmap, blocksX, blocksY, planeBlockSize, base);
}

// --- perceptual transfer function (sqrt PQ) ---
// human vision follows Weber's law: sensitivity scales as 1/L. sqrt transfer
// (gamma=0.5) redistributes quantization to give 2x more precision in darks.
// same principle as sRGB gamma, µ-law companding, SMPTE ST 2084 PQ.
// applied to Y plane of I-frames only.
//
// gamma=0.55: gentler than sqrt, avoids harsh bright-value inversion errors.
// still 1.8x more levels in the dark half vs linear. LUTs are bijective:
// PQ_INV[PQ_FWD[v]] ≈ v (max error 1, from rounding).
const PQ_GAMMA = 0.55;
const PQ_GAMMA_INV = 1 / PQ_GAMMA;
const PQ_FWD = new Uint8Array(256); // linear → perceptual
const PQ_INV = new Uint8Array(256); // perceptual → linear
for (let i = 0; i < 256; i++) {
    PQ_FWD[i] = Math.min(255, (Math.pow(i / 255, PQ_GAMMA) * 255 + 0.5) | 0);
    PQ_INV[i] = Math.min(255, (Math.pow(i / 255, PQ_GAMMA_INV) * 255 + 0.5) | 0);
}

function pqForward(data: Uint8Array, offset: number, count: number): void {
    simd.pqForward(data, offset, count);
}

function pqInverse(data: Uint8Array, offset: number, count: number): void {
    simd.pqInverse(data, offset, count);
}

// --- quantization ---
// maps quality 1-99 to a smooth divisor curve.
// q=99 → step=2, q=50 → step=8, q=1 → step=128.
// UV planes get a quality-scaled boost (1.0-1.2x) since
// human vision is less sensitive to chrominance.

function qstep(quality: number): number {
    // exponential curve: step = 2^((100-q)/17) clamped to [1, 128]
    // float step, no rounding, smooth gradient with no plateaus.
    // exponent 17: preserves 45% of luma levels at q80, q30 step=17.4 still compresses hard.
    return Math.max(1, Math.min(128, Math.pow(2, (100 - quality) / 17)));
}

function uvQstep(quality: number): number {
    const yS = qstep(quality);
    // quality-adaptive chroma boost:
    //   q>=75: boost=1.0, color accuracy matters at high quality
    //   q<75:  ramp from 1.0 to 1.15, saves chroma bits where the eye can't tell
    const boost = quality >= 75 ? 1.0 : 1.0 + 0.15 * ((75 - quality) / 75);
    return Math.min(128, yS * boost);
}

function quantizeChroma(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    return simd.quantizeChroma(data, ySamples, 1 / yS, 1 / uvS);
}

function dequantizeChroma(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    return simd.dequantizeChroma(data, ySamples, yS, uvS);
}

function quantizeChromaSigned(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    const dzFactor = 0.5 + 0.35 * (1 - quality / 100);
    return simd.quantizeChromaSigned(data, ySamples, 1 / yS, 1 / uvS, yS * dzFactor, uvS * dzFactor);
}

function dequantizeChromaSigned(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    return simd.dequantizeChromaSigned(data, ySamples, yS, uvS);
}

function ditherYUV(yuv: Uint8Array, w: number, h: number, quality: number): void {
    const yS = qstep(quality), uvS = uvQstep(quality);
    simd.ditherYUV(yuv, w, h, yS, uvS);
}

function frcDither(
    yuv: Uint8Array, w: number, h: number, quality: number, frameNum: number
): void {
    const step = qstep(quality);
    if (step < 1.5) return;
    const baseStrength = step * (0.2 + 0.15 * (1 - quality / 100));
    simd.frcDither(yuv, w, h, baseStrength, frameNum);
}

// --- zigzag transform ---
// residuals after spatial prediction are signed mod 256 (255 means -1, etc).
// zigzag maps signed to unsigned so small residuals stay small:
//   0→0, -1→1, +1→2, -2→3, +2→4, ...
// concentrates energy near zero for fixed-width coding.

function zigzagEncode(data: Uint8Array): void {
    simd.zigzagEncode(data);
}

function zigzagDecode(data: Uint8Array): void {
    simd.zigzagDecode(data);
}

// --- spatial physics block codec ---
// second-order causal Taylor expansion per 8x8 block:
//   pred = D + α·(L-D) + β·(A-D) + γ·(fyy + fxx + fxy)
// D=diagonal, L=left, A=above. α=fy, β=fx, γ=Hessian (fyy+fxx+fxy).
// 3x3 normal equation solver fits coefficients. W-bit residual packing.

/** clz32: count leading zeros of a 32-bit unsigned integer */
function clz32(v: number): number { return Math.clz32(v); }

/**
 * blockEncode: I-frame spatial physics encoder.
 * full plane in 8x8 raster-order blocks with causal neighbors.
 * pred = D + α·(L-D) + β·(A-D) + γ·(fyy + fxx + fxy)
 * fyy = L-2D+AD, fxx = A-2D+DL, fxy = A-D-AA+AD.
 * per-block header [α_q:8][β_q:8][γ_q:8][W:6] + W-bit residuals.
 */
function blockEncode(data: Uint8Array, width: number, height: number): Uint8Array {
    const BS = 8;
    const blocksX = Math.ceil(width / BS);
    const blocksY = Math.ceil(height / BS);
    // Worst case: 30 header bits + 8*8*8=512 data bits = 542 bits per block
    const buf = new Uint8Array(Math.ceil(blocksX * blocksY * 542 / 8) + 16);
    let bytePos = 0, bitBuf = 0, bitCount = 0;

    function flushBits() {
        while (bitCount >= 8) {
            buf[bytePos++] = bitBuf & 0xFF;
            bitBuf >>>= 8;
            bitCount -= 8;
        }
    }

    function writeBits(val: number, count: number) {
        bitBuf |= (val & ((1 << count) - 1)) << bitCount;
        bitCount += count;
        flushBits();
    }

    // 3×3 Gaussian elimination with partial pivoting
    function solve3x3(
        m00: number, m01: number, m02: number,
        m11: number, m12: number, m22: number,
        r0: number, r1: number, r2: number
    ): [number, number, number] {
        const a = [m00, m01, m02, r0];
        const b = [m01, m11, m12, r1];
        const c = [m02, m12, m22, r2];
        const rows = [a, b, c];
        for (let col = 0; col < 3; col++) {
            let maxVal = Math.abs(rows[col][col]), maxRow = col;
            for (let row = col + 1; row < 3; row++) {
                const v = Math.abs(rows[row][col]);
                if (v > maxVal) { maxVal = v; maxRow = row; }
            }
            if (maxVal < 1e-10) continue;
            if (maxRow !== col) { const tmp = rows[col]; rows[col] = rows[maxRow]; rows[maxRow] = tmp; }
            for (let row = col + 1; row < 3; row++) {
                const f = rows[row][col] / rows[col][col];
                for (let j = col; j < 4; j++) rows[row][j] -= f * rows[col][j];
            }
        }
        const x = [0, 0, 0];
        for (let i = 2; i >= 0; i--) {
            if (Math.abs(rows[i][i]) < 1e-10) continue;
            let sum = rows[i][3];
            for (let j = i + 1; j < 3; j++) sum -= rows[i][j] * x[j];
            x[i] = sum / rows[i][i];
        }
        return x as [number, number, number];
    }

    // Work buffer for reconstructed values (needed for causal prediction)
    const recon = new Uint8Array(data);

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const bw = Math.min(BS, width - bx * BS);
            const bh = Math.min(BS, height - by * BS);

            // Accumulate 3×3 normal equations: M^T·M and M^T·y
            // b1 = L-D (fy), b2 = A-D (fx), b3 = fyy+fxx+fxy (full Hessian correction)
            let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0;
            let r0 = 0, r1 = 0, r2 = 0;
            for (let ly = 0; ly < bh; ly++) {
                const gy = by * BS + ly;
                for (let lx = 0; lx < bw; lx++) {
                    const gx = bx * BS + lx;
                    if (gx === 0 || gy === 0) continue;
                    const val = recon[gy * width + gx];
                    const L = recon[gy * width + gx - 1];
                    const A = recon[(gy - 1) * width + gx];
                    const D = recon[(gy - 1) * width + gx - 1];
                    const b1 = L - D;
                    const b2 = A - D;
                    // Full second-order correction: fyy + fxx + fxy
                    const fyy = gy > 1 ? (L - 2 * D + recon[(gy - 2) * width + gx - 1]) : 0;
                    const fxx = gx > 1 ? (A - 2 * D + recon[(gy - 1) * width + gx - 2]) : 0;
                    const fxy = gy > 1 ? (A - D - recon[(gy - 2) * width + gx] + recon[(gy - 2) * width + gx - 1]) : 0;
                    const b3 = fyy + fxx + fxy;
                    const target = val - D;
                    m00 += b1 * b1; m01 += b1 * b2; m02 += b1 * b3;
                    m11 += b2 * b2; m12 += b2 * b3;
                    m22 += b3 * b3;
                    r0 += b1 * target; r1 += b2 * target; r2 += b3 * target;
                }
            }

            const [alpha, beta, gamma] = solve3x3(m00, m01, m02, m11, m12, m22, r0, r1, r2);

            // Quantize coefficients to 8-bit signed (Q5: multiply by 32)
            const aq = Math.max(-128, Math.min(127, Math.round(alpha * 32))) | 0;
            const bq = Math.max(-128, Math.min(127, Math.round(beta * 32))) | 0;
            const cq = Math.max(-128, Math.min(127, Math.round(gamma * 32))) | 0;

            // Pass 2: compute predictions with quantized coefficients, zigzag residuals, find maxZ
            let maxZ = 0;
            const residuals = new Uint8Array(bw * bh);
            for (let ly = 0; ly < bh; ly++) {
                const gy = by * BS + ly;
                for (let lx = 0; lx < bw; lx++) {
                    const gx = bx * BS + lx;
                    const val = recon[gy * width + gx];
                    let pred: number;
                    if (gx > 0 && gy > 0) {
                        const L = recon[gy * width + gx - 1];
                        const A = recon[(gy - 1) * width + gx];
                        const D = recon[(gy - 1) * width + gx - 1];
                        const fyy = gy > 1 ? (L - 2 * D + recon[(gy - 2) * width + gx - 1]) : 0;
                        const fxx = gx > 1 ? (A - 2 * D + recon[(gy - 1) * width + gx - 2]) : 0;
                        const fxy = gy > 1 ? (A - D - recon[(gy - 2) * width + gx] + recon[(gy - 2) * width + gx - 1]) : 0;
                        pred = D + ((aq * (L - D) + bq * (A - D) + cq * (fyy + fxx + fxy)) >> 5);
                    } else if (gx > 0) {
                        pred = recon[gy * width + gx - 1];
                    } else if (gy > 0) {
                        pred = recon[(gy - 1) * width + gx];
                    } else {
                        pred = 0;
                    }
                    const r = (val - pred) & 0xFF;
                    // Zigzag: signed mod 256 → unsigned
                    const z = r < 128 ? (r << 1) : (((256 - r) << 1) - 1);
                    residuals[ly * bw + lx] = z;
                    if (z > maxZ) maxZ = z;
                }
            }

            const W = maxZ > 0 ? (32 - clz32(maxZ)) : 0;

            // Emit header: α_q(8) + β_q(8) + γ_q(8) + W(6) = 30 bits
            writeBits(aq & 0xFF, 8);
            writeBits(bq & 0xFF, 8);
            writeBits(cq & 0xFF, 8);
            writeBits(W, 6);

            // Emit data: each residual in W bits
            if (W > 0) {
                for (let i = 0; i < bw * bh; i++) {
                    writeBits(residuals[i], W);
                }
            }
        }
    }

    // Flush remaining bits
    if (bitCount > 0) buf[bytePos++] = bitBuf & 0xFF;
    return buf.subarray(0, bytePos);
}

/** blockDecode: I-frame spatial physics decoder, mirror of blockEncode. */
function blockDecode(bitstream: Uint8Array, width: number, height: number): Uint8Array {
    const BS = 8;
    const blocksX = Math.ceil(width / BS);
    const blocksY = Math.ceil(height / BS);
    const out = new Uint8Array(width * height);
    let bytePos = 0, bitBuf = 0, bitCount = 0;

    function readBits(count: number): number {
        while (bitCount < count) {
            bitBuf |= (bytePos < bitstream.length ? bitstream[bytePos++] : 0) << bitCount;
            bitCount += 8;
        }
        const val = bitBuf & ((1 << count) - 1);
        bitBuf >>>= count;
        bitCount -= count;
        return val;
    }

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const bw = Math.min(BS, width - bx * BS);
            const bh = Math.min(BS, height - by * BS);

            // Read header: α_q(8) + β_q(8) + γ_q(8) + W(6) = 30 bits
            const aq = (readBits(8) << 24) >> 24; // sign extend
            const bq = (readBits(8) << 24) >> 24;
            const cq = (readBits(8) << 24) >> 24;
            const W = readBits(6);

            for (let ly = 0; ly < bh; ly++) {
                const gy = by * BS + ly;
                for (let lx = 0; lx < bw; lx++) {
                    const gx = bx * BS + lx;
                    let pred: number;
                    if (gx > 0 && gy > 0) {
                        const L = out[gy * width + gx - 1];
                        const A = out[(gy - 1) * width + gx];
                        const D = out[(gy - 1) * width + gx - 1];
                        const fyy = gy > 1 ? (L - 2 * D + out[(gy - 2) * width + gx - 1]) : 0;
                        const fxx = gx > 1 ? (A - 2 * D + out[(gy - 1) * width + gx - 2]) : 0;
                        const fxy = gy > 1 ? (A - D - out[(gy - 2) * width + gx] + out[(gy - 2) * width + gx - 1]) : 0;
                        pred = D + ((aq * (L - D) + bq * (A - D) + cq * (fyy + fxx + fxy)) >> 5);
                    } else if (gx > 0) {
                        pred = out[gy * width + gx - 1];
                    } else if (gy > 0) {
                        pred = out[(gy - 1) * width + gx];
                    } else {
                        pred = 0;
                    }
                    const z = W > 0 ? readBits(W) : 0;
                    // Inverse zigzag
                    const r = (z & 1) ? (256 - ((z + 1) >> 1)) : (z >> 1);
                    out[gy * width + gx] = (pred + r) & 0xFF;
                }
            }
        }
    }

    return out;
}

/** blockEncodeMulti: P-frame encoder. independent blocks, 30-bit header + W-bit residuals each. */
function blockEncodeMulti(blockData: Uint8Array, blockDims: { w: number; h: number }[]): Uint8Array {
    const buf = new Uint8Array(Math.ceil(blockData.length * 10 / 8) + blockDims.length * 4 + 16);
    let bytePos = 0, bitBuf = 0, bitCount = 0;

    function flushBits() {
        while (bitCount >= 8) {
            buf[bytePos++] = bitBuf & 0xFF;
            bitBuf >>>= 8;
            bitCount -= 8;
        }
    }

    function writeBits(val: number, count: number) {
        bitBuf |= (val & ((1 << count) - 1)) << bitCount;
        bitCount += count;
        flushBits();
    }

    let readPos = 0;
    for (const { w, h } of blockDims) {
        const n = w * h;
        const block = blockData.subarray(readPos, readPos + n);
        readPos += n;

        // Zigzag all residuals, find maxZ
        let maxZ = 0;
        const zz = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const v = block[i];
            const z = v < 128 ? (v << 1) : (((256 - v) << 1) - 1);
            zz[i] = z;
            if (z > maxZ) maxZ = z;
        }

        const W = maxZ > 0 ? (32 - clz32(maxZ)) : 0;

        // For P-frame blocks: no spatial prediction, just α=β=γ=0
        writeBits(0, 8); // α_q = 0
        writeBits(0, 8); // β_q = 0
        writeBits(0, 8); // γ_q = 0
        writeBits(W, 6);

        if (W > 0) {
            for (let i = 0; i < n; i++) writeBits(zz[i], W);
        }
    }

    if (bitCount > 0) buf[bytePos++] = bitBuf & 0xFF;
    return buf.subarray(0, bytePos);
}

/** blockDecodeMulti: P-frame decoder. */
function blockDecodeMulti(bitstream: Uint8Array, blockDims: { w: number; h: number }[], totalPixels: number): Uint8Array {
    const out = new Uint8Array(totalPixels);
    let bytePos = 0, bitBuf = 0, bitCount = 0;

    function readBits(count: number): number {
        while (bitCount < count) {
            bitBuf |= (bytePos < bitstream.length ? bitstream[bytePos++] : 0) << bitCount;
            bitCount += 8;
        }
        const val = bitBuf & ((1 << count) - 1);
        bitBuf >>>= count;
        bitCount -= count;
        return val;
    }

    let writePos = 0;
    for (const { w, h } of blockDims) {
        const n = w * h;
        // read header (α_q, β_q, γ_q are ignored for P-frame blocks, no spatial prediction)
        readBits(8); // α_q
        readBits(8); // β_q
        readBits(8); // γ_q
        const W = readBits(6);

        for (let i = 0; i < n; i++) {
            const z = W > 0 ? readBits(W) : 0;
            // Inverse zigzag
            out[writePos++] = (z & 1) ? (256 - ((z + 1) >> 1)) : (z >> 1);
        }
    }

    return out;
}

/** build {w, h} dimensions for each changed block (Y + U + V). */
function buildChangedBlockDims(
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    blockSize: number, planeW: number, planeH: number,
    uvBlockSize: number, uvW: number, uvH: number
): { w: number; h: number }[] {
    const dims: { w: number; h: number }[] = [];
    // Y plane blocks
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
            const bw = Math.min(blockSize, planeW - bx * blockSize);
            const bh = Math.min(blockSize, planeH - by * blockSize);
            dims.push({ w: bw, h: bh });
        }
    }
    // U plane blocks
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
            const bw = Math.min(uvBlockSize, uvW - bx * uvBlockSize);
            const bh = Math.min(uvBlockSize, uvH - by * uvBlockSize);
            dims.push({ w: bw, h: bh });
        }
    }
    // V plane blocks (same dims as U)
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
            const bw = Math.min(uvBlockSize, uvW - bx * uvBlockSize);
            const bh = Math.min(uvBlockSize, uvH - by * uvBlockSize);
            dims.push({ w: bw, h: bh });
        }
    }
    return dims;
}

// --- compressed payload assembly ---

/** I-frame payload: [yLen:4][yBitstream][uLen:4][uBitstream][vLen:4][vBitstream] */

function packIframePayload(yBits: Uint8Array, uBits: Uint8Array, vBits: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + yBits.length + uBits.length + vBits.length);
    const dv = new DataView(out.buffer);
    let off = 0;
    dv.setUint32(off, yBits.length, true); off += 4;
    out.set(yBits, off); off += yBits.length;
    dv.setUint32(off, uBits.length, true); off += 4;
    out.set(uBits, off); off += uBits.length;
    dv.setUint32(off, vBits.length, true); off += 4;
    out.set(vBits, off);
    return out;
}

function unpackIframePayload(payload: Uint8Array): { yBits: Uint8Array; uBits: Uint8Array; vBits: Uint8Array } {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let off = 0;
    const yLen = dv.getUint32(off, true); off += 4;
    const yBits = payload.subarray(off, off + yLen); off += yLen;
    const uLen = dv.getUint32(off, true); off += 4;
    const uBits = payload.subarray(off, off + uLen); off += uLen;
    const vLen = dv.getUint32(off, true); off += 4;
    const vBits = payload.subarray(off, off + vLen);
    return { yBits, uBits, vBits };
}

/** P-frame payload: [bitmap][blockBitstream] */

function packPframePayload(
    blockBitstream: Uint8Array,
    blocksX: number, blocksY: number, bitmap: Uint8Array
): Uint8Array {
    const bitmapLen = Math.ceil(blocksX * blocksY / 8);
    const out = new Uint8Array(bitmapLen + blockBitstream.length);
    out.set(bitmap.subarray(0, bitmapLen), 0);
    out.set(blockBitstream, bitmapLen);
    return out;
}

function unpackPframePayload(
    payload: Uint8Array,
    blocksX: number, blocksY: number
): { blockBitstream: Uint8Array; bitmap: Uint8Array } {
    const bitmapLen = Math.ceil(blocksX * blocksY / 8);
    const bitmap = payload.subarray(0, bitmapLen);
    const blockBitstream = payload.subarray(bitmapLen);
    return { blockBitstream, bitmap };
}

export interface VideoCodecConfig {
    quality: number;          // 1-100, default 80
    keyFrameInterval: number; // frames between forced I-frames, default 30
    blockSize: number;        // pixels per block side, default 8
    blockThreshold: number;   // energy threshold for block skip, default 4
}

const DEFAULT_CONFIG: VideoCodecConfig = {
    quality: 100,
    keyFrameInterval: 30,
    blockSize: 8,
    blockThreshold: 4,
};

export class VideoCodec {
    public wasm: VideoWasmExports | null = null;
    private initialized = false;
    private config: VideoCodecConfig = { ...DEFAULT_CONFIG };
    // Compression state (encoder side)
    private prevFrame: Uint8Array | null = null;
    private framesSinceKey = 0;
    // Decompression state (decoder side)
    private prevDecFrame: Uint8Array | null = null;
    private decFrameCount = 0; // for temporal FRC dithering

    async init(encryptionKey: Uint32Array, config?: Partial<VideoCodecConfig>) {
        if (encryptionKey.length < 8) throw new Error("Key must be 256 bits (Uint32Array of 8)");
        this.config = { ...DEFAULT_CONFIG, ...config };
        if (this.config.quality < 1 || this.config.quality > 100) throw new Error("quality must be 1-100");
        // Initialize SIMD WASM accelerator (once, shared across all instances)
        if (simd.initVideoSimd()) simd.initPqTables(PQ_FWD, PQ_INV);
        this.wasm = await getVideoWasm();
        const k = encryptionKey;
        this.wasm.reset_encoder_state(k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
        this.wasm.reset_decoder_state(k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
        this.prevFrame = null;
        this.prevDecFrame = null;
        this.framesSinceKey = 0;
        this.initialized = true;
    }

    /** Maximum packet size for a given resolution (raw/uncompressed case). */
    static packetSize(width: number, height: number): number {
        return HEADER_SIZE + width * height * 4 + MAC_SIZE;
    }

    /** Read packet header without decrypting. Useful for routing, stats, drop detection. */
    static peekHeader(packet: Uint8Array): PacketHeader {
        if (packet.length < HEADER_SIZE) throw new Error("Packet too short for header");
        const dv = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
        return {
            width: dv.getUint16(0, true),
            height: dv.getUint16(2, true),
            frameIdx: dv.getUint32(4, true),
            flags: dv.getUint32(8, true),
        };
    }

    private compressFrame(pixels: Uint8Array, w: number, h: number): { payload: Uint8Array; flags: number } {
        const { quality, keyFrameInterval, blockSize, blockThreshold: baseThreshold } = this.config;
        const thresholdScale = 0.5 + 1.5 * (1 - quality / 100);
        const blockThreshold = Math.max(2, (baseThreshold * thresholdScale + 0.5) | 0);
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;
        const uvBlockSize = blockSize >> 1;

        const yuv = rgbaToYuv420(pixels, w, h);
        let isKeyframe = !this.prevFrame || this.framesSinceKey >= keyFrameInterval;

        let blocksX = 0, blocksY = 0;
        let bitmap = new Uint8Array(0);

        pqForward(yuv, 0, ySize);

        if (isKeyframe) {
            // I-frame: dither → quantize → blockEncode per plane
            ditherYUV(yuv, w, h, quality);
            const quantized = quantizeChroma(yuv, ySize, quality);
            this.prevFrame = dequantizeChroma(quantized, ySize, quality);

            const yBits = blockEncode(quantized.subarray(0, ySize), w, h);
            const uBits = blockEncode(quantized.subarray(ySize, ySize + uvSize), uvW, uvH);
            const vBits = blockEncode(quantized.subarray(ySize + uvSize), uvW, uvH);

            let payload = packIframePayload(yBits, uBits, vBits);
            this.framesSinceKey = 1;

            const flags = encodeFlags(true, true, quality);
            return { payload, flags };
        } else {
            // P-frame: delta → block skip → extract → quantize → blockEncodeMulti
            const delta = computeDelta(yuv, this.prevFrame!);

            const blockInfo = buildBlockBitmap(delta.subarray(0, ySize), w, h, blockSize, blockThreshold);
            blocksX = blockInfo.blocksX;
            blocksY = blockInfo.blocksY;
            bitmap = blockInfo.bitmap as Uint8Array<ArrayBuffer>;

            const yBlocks = extractChangedBlocksPlane(
                delta.subarray(0, ySize), w, h,
                bitmap, blocksX, blocksY, blockSize
            );
            const uBlocks = extractChangedBlocksPlane(
                delta.subarray(ySize, ySize + uvSize), uvW, uvH,
                bitmap, blocksX, blocksY, uvBlockSize
            );
            const vBlocks = extractChangedBlocksPlane(
                delta.subarray(ySize + uvSize), uvW, uvH,
                bitmap, blocksX, blocksY, uvBlockSize
            );

            const allBlocks = new Uint8Array(yBlocks.length + uBlocks.length + vBlocks.length);
            allBlocks.set(yBlocks, 0);
            allBlocks.set(uBlocks, yBlocks.length);
            allBlocks.set(vBlocks, yBlocks.length + uBlocks.length);

            const quantizedBlocks = quantizeChromaSigned(allBlocks, yBlocks.length, quality);

            // Track decoder state
            const lossyDelta = new Uint8Array(yuvSize);
            const lossyBlocks = dequantizeChromaSigned(quantizedBlocks, yBlocks.length, quality);

            let pos = 0;
            pos = reinsertChangedBlocksPlane(
                lossyBlocks, pos, w, h, bitmap, blocksX, blocksY, blockSize,
                lossyDelta.subarray(0, ySize)
            );
            pos = reinsertChangedBlocksPlane(
                lossyBlocks, pos, uvW, uvH, bitmap, blocksX, blocksY, uvBlockSize,
                lossyDelta.subarray(ySize, ySize + uvSize)
            );
            reinsertChangedBlocksPlane(
                lossyBlocks, pos, uvW, uvH, bitmap, blocksX, blocksY, uvBlockSize,
                lossyDelta.subarray(ySize + uvSize)
            );
            this.prevFrame = applyDelta(lossyDelta, this.prevFrame!);
            this.framesSinceKey++;

            // Encode with blockEncodeMulti
            const dims = buildChangedBlockDims(bitmap, blocksX, blocksY, blockSize, w, h, uvBlockSize, uvW, uvH);
            const blockBitstream = blockEncodeMulti(quantizedBlocks, dims);

            let payload = packPframePayload(blockBitstream, blocksX, blocksY, bitmap);

            // Scene-change detection: if P-frame > I-frame estimate, redo as I-frame
            const iframeEstimate = this.estimateIframeSize(yuv, w, h, ySize, uvW, uvH, uvSize, quality);
            if (payload.length > iframeEstimate) {
                isKeyframe = true;
                ditherYUV(yuv, w, h, quality);
                const q = quantizeChroma(yuv, ySize, quality);
                this.prevFrame = dequantizeChroma(q, ySize, quality);

                const yBits = blockEncode(q.subarray(0, ySize), w, h);
                const uBits = blockEncode(q.subarray(ySize, ySize + uvSize), uvW, uvH);
                const vBits = blockEncode(q.subarray(ySize + uvSize), uvW, uvH);

                this.framesSinceKey = 1;
                payload = packIframePayload(yBits, uBits, vBits);
                return { payload, flags: encodeFlags(true, true, quality) };
            }

            return { payload, flags: encodeFlags(true, false, quality) };
        }
    }

    /** Quick I-frame size estimate using blockEncode. */
    private estimateIframeSize(
        yuv: Uint8Array, w: number, h: number,
        ySize: number, uvW: number, uvH: number, uvSize: number,
        quality: number
    ): number {
        const q = quantizeChroma(yuv, ySize, quality);
        const yBits = blockEncode(q.subarray(0, ySize), w, h);
        const uBits = blockEncode(q.subarray(ySize, ySize + uvSize), uvW, uvH);
        const vBits = blockEncode(q.subarray(ySize + uvSize), uvW, uvH);
        return yBits.length + uBits.length + vBits.length + 12;
    }

    private decompressFrame(decrypted: Uint8Array, w: number, h: number, flags: number): Uint8Array {
        const { keyframe, quality } = decodeFlags(flags);
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;
        const blockSize = this.config.blockSize;
        const uvBlockSize = blockSize >> 1;
        const blocksX = Math.ceil(w / blockSize);
        const blocksY = Math.ceil(h / blockSize);

        if (keyframe) {
            // I-frame: blockDecode per plane → reassemble → dequantize → PQ inv → FRC → RGBA
            const { yBits, uBits, vBits } = unpackIframePayload(decrypted);
            const yPlane = blockDecode(yBits, w, h);
            const uPlane = blockDecode(uBits, uvW, uvH);
            const vPlane = blockDecode(vBits, uvW, uvH);

            const quantized = new Uint8Array(yuvSize);
            quantized.set(yPlane, 0);
            quantized.set(uPlane, ySize);
            quantized.set(vPlane, ySize + uvSize);

            const yuv = dequantizeChroma(quantized, ySize, quality);
            this.prevDecFrame = new Uint8Array(yuv);
            pqInverse(yuv, 0, ySize);
            frcDither(yuv, w, h, quality, this.decFrameCount++);
            return yuv420ToRgba(yuv, w, h);
        } else {
            // P-frame: unpack bitmap → blockDecodeMulti → dequantize → reinsert → un-delta → RGBA
            const { blockBitstream, bitmap } = unpackPframePayload(decrypted, blocksX, blocksY);

            const dims = buildChangedBlockDims(bitmap, blocksX, blocksY, blockSize, w, h, uvBlockSize, uvW, uvH);
            let totalBlockBytes = 0;
            for (const d of dims) totalBlockBytes += d.w * d.h;

            const quantizedBlocks = blockDecodeMulti(blockBitstream, dims, totalBlockBytes);

            // Count Y block bytes for dequantize split
            let yBlockBytes = 0;
            for (let by = 0; by < blocksY; by++) {
                for (let bx = 0; bx < blocksX; bx++) {
                    const blockIdx = by * blocksX + bx;
                    if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
                    const bw = Math.min(blockSize, w - bx * blockSize);
                    const bh = Math.min(blockSize, h - by * blockSize);
                    yBlockBytes += bw * bh;
                }
            }

            const deltaBlocks = dequantizeChromaSigned(quantizedBlocks, yBlockBytes, quality);

            const fullDelta = new Uint8Array(yuvSize);
            let pos = 0;
            pos = reinsertChangedBlocksPlane(
                deltaBlocks, pos, w, h, bitmap, blocksX, blocksY, blockSize,
                fullDelta.subarray(0, ySize)
            );
            pos = reinsertChangedBlocksPlane(
                deltaBlocks, pos, uvW, uvH, bitmap, blocksX, blocksY, uvBlockSize,
                fullDelta.subarray(ySize, ySize + uvSize)
            );
            reinsertChangedBlocksPlane(
                deltaBlocks, pos, uvW, uvH, bitmap, blocksX, blocksY, uvBlockSize,
                fullDelta.subarray(ySize + uvSize)
            );

            const base = this.prevDecFrame || new Uint8Array(yuvSize);
            const yuv = applyDelta(fullDelta, base);

            this.prevDecFrame = new Uint8Array(yuv);
            pqInverse(yuv, 0, ySize);
            frcDither(yuv, w, h, quality, this.decFrameCount++);
            return yuv420ToRgba(yuv, w, h);
        }
    }

    /** Encrypt a frame. Returns a new Uint8Array packet. */
    encode(pixels: Uint8Array, width: number, height: number): Uint8Array {
        if (!this.wasm) throw new Error("Codec not initialized");
        const numPixels = width * height;

        // Raw path (quality 100 = lossless, no compression)
        if (this.config.quality === 100) {
            const pixelBytes = numPixels * 4;
            const outMaxBytes = HEADER_SIZE + pixelBytes + MAC_SIZE;
            const totalNeeded = BUF_START + pixelBytes + outMaxBytes;
            const mem = this.wasm.memory;
            if (mem.buffer.byteLength < totalNeeded) {
                this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
            }
            const pixelsPtr = BUF_START;
            const outPtr = BUF_START + pixelBytes;
            new Uint8Array(mem.buffer).set(pixels, pixelsPtr);
            const dv = new DataView(mem.buffer, outPtr, HEADER_SIZE);
            dv.setUint16(0, width, true);
            dv.setUint16(2, height, true);
            dv.setUint32(8, 0, true);
            const bytesWritten = this.wasm.encode_video(pixelsPtr, numPixels, outPtr);
            return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
        }

        // Compressed path
        const { payload, flags } = this.compressFrame(pixels, width, height);
        // Prepend 4-byte LE payload length so decoder can trim padding
        const withLen = new Uint8Array(4 + payload.length);
        new DataView(withLen.buffer).setUint32(0, payload.length, true);
        withLen.set(payload, 4);
        const [pseudoW, pseudoH] = pseudoDims(Math.ceil(withLen.length / 4));
        const pseudoPixels = pseudoW * pseudoH;
        const pseudoBytes = pseudoPixels * 4;
        const paddedPayload = new Uint8Array(pseudoBytes);
        paddedPayload.set(withLen);
        const outMaxBytes = HEADER_SIZE + pseudoBytes + MAC_SIZE;
        const totalNeeded = BUF_START + pseudoBytes + outMaxBytes;
        const mem = this.wasm.memory;
        if (mem.buffer.byteLength < totalNeeded) {
            this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
        }
        const pixelsPtr = BUF_START;
        const outPtr = BUF_START + pseudoBytes;
        new Uint8Array(mem.buffer).set(paddedPayload, pixelsPtr);
        const dv = new DataView(mem.buffer, outPtr, HEADER_SIZE);
        dv.setUint16(0, pseudoW, true);
        dv.setUint16(2, pseudoH, true);
        dv.setUint32(8, flags, true);
        const bytesWritten = this.wasm.encode_video(pixelsPtr, pseudoPixels, outPtr);
        const result = new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
        const rdv = new DataView(result.buffer, result.byteOffset, HEADER_SIZE);
        rdv.setUint16(0, width, true);
        rdv.setUint16(2, height, true);
        return result;
    }

    /**
     * Encrypt a frame directly into a pre-allocated buffer. Zero-alloc hot path.
     * `out` must be at least `VideoCodec.packetSize(width, height)` bytes.
     * Returns the number of bytes written (may be much less than packetSize when compressed).
     */
    encodeInto(pixels: Uint8Array, width: number, height: number, out: Uint8Array): number {
        if (!this.wasm) throw new Error("Codec not initialized");
        const numPixels = width * height;

        if (this.config.quality === 100) {
            const pixelBytes = numPixels * 4;
            const outMaxBytes = HEADER_SIZE + pixelBytes + MAC_SIZE;
            const totalNeeded = BUF_START + pixelBytes + outMaxBytes;
            const mem = this.wasm.memory;
            if (mem.buffer.byteLength < totalNeeded) {
                this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
            }
            const pixelsPtr = BUF_START;
            const outPtr = BUF_START + pixelBytes;
            new Uint8Array(mem.buffer).set(pixels, pixelsPtr);
            const dv = new DataView(mem.buffer, outPtr, HEADER_SIZE);
            dv.setUint16(0, width, true);
            dv.setUint16(2, height, true);
            dv.setUint32(8, 0, true);
            const bytesWritten = this.wasm.encode_video(pixelsPtr, numPixels, outPtr);
            out.set(new Uint8Array(mem.buffer, outPtr, bytesWritten));
            return bytesWritten;
        }

        const { payload, flags } = this.compressFrame(pixels, width, height);
        const withLen = new Uint8Array(4 + payload.length);
        new DataView(withLen.buffer).setUint32(0, payload.length, true);
        withLen.set(payload, 4);
        const [pseudoW, pseudoH] = pseudoDims(Math.ceil(withLen.length / 4));
        const pseudoPixels = pseudoW * pseudoH;
        const pseudoBytes = pseudoPixels * 4;
        const paddedPayload = new Uint8Array(pseudoBytes);
        paddedPayload.set(withLen);
        const outMaxBytes = HEADER_SIZE + pseudoBytes + MAC_SIZE;
        const totalNeeded = BUF_START + pseudoBytes + outMaxBytes;
        const mem = this.wasm.memory;
        if (mem.buffer.byteLength < totalNeeded) {
            this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
        }
        const pixelsPtr = BUF_START;
        const outPtr = BUF_START + pseudoBytes;
        new Uint8Array(mem.buffer).set(paddedPayload, pixelsPtr);
        const dv = new DataView(mem.buffer, outPtr, HEADER_SIZE);
        dv.setUint16(0, pseudoW, true);
        dv.setUint16(2, pseudoH, true);
        dv.setUint32(8, flags, true);
        const bytesWritten = this.wasm.encode_video(pixelsPtr, pseudoPixels, outPtr);
        out.set(new Uint8Array(mem.buffer, outPtr, bytesWritten));
        const odv = new DataView(out.buffer, out.byteOffset, HEADER_SIZE);
        odv.setUint16(0, width, true);
        odv.setUint16(2, height, true);
        return bytesWritten;
    }

    /** Decrypt a packet. Returns a new Uint8Array for the pixels. */
    decode(packet: Uint8Array): { pixels: Uint8Array; width: number; height: number; tampered: boolean } {
        if (!this.wasm) throw new Error("Codec not initialized");
        if (packet.length < HEADER_SIZE + MAC_SIZE) throw new Error("Video packet too short");

        const dvHdr = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
        const width = dvHdr.getUint16(0, true);
        const height = dvHdr.getUint16(2, true);
        const flags = dvHdr.getUint32(8, true);
        const { compressed } = decodeFlags(flags);

        if (!compressed) {
            // raw path, existing behavior
            const numPixels = width * height;
            const totalNeeded = BUF_START + packet.length + numPixels * 4;
            const mem = this.wasm.memory;
            if (mem.buffer.byteLength < totalNeeded) {
                this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
            }
            const packetPtr = BUF_START;
            const outPtr = BUF_START + packet.length;
            new Uint8Array(mem.buffer).set(packet, packetPtr);
            const pixelsDecoded = this.wasm.decode_video(packetPtr, packet.length, outPtr);
            const tampered = pixelsDecoded === 0;
            const pixels = new Uint8Array(tampered ? 0 : pixelsDecoded * 4);
            if (!tampered) pixels.set(new Uint8Array(mem.buffer, outPtr, pixelsDecoded * 4));
            return { pixels, width, height, tampered };
        }

        // Compressed path: decrypt, then decompress
        const encPayloadBytes = packet.length - HEADER_SIZE - MAC_SIZE;
        const pseudoPixels = encPayloadBytes / 4;
        const [pseudoW, pseudoH] = pseudoDims(pseudoPixels);
        const totalNeeded = BUF_START + packet.length + pseudoPixels * 4;
        const mem = this.wasm.memory;
        if (mem.buffer.byteLength < totalNeeded) {
            this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
        }
        const packetPtr = BUF_START;
        const outPtr = BUF_START + packet.length;
        new Uint8Array(mem.buffer).set(packet, packetPtr);
        // Patch header so WASM reads pseudoW*pseudoH as pixel count
        const patchDv = new DataView(mem.buffer, packetPtr, HEADER_SIZE);
        patchDv.setUint16(0, pseudoW, true);
        patchDv.setUint16(2, pseudoH, true);
        const decResult = this.wasm.decode_video(packetPtr, packet.length, outPtr);
        if (decResult === 0) return { pixels: new Uint8Array(0), width, height, tampered: true };

        const decryptedRaw = new Uint8Array(mem.buffer.slice(outPtr, outPtr + decResult * 4));
        // Read payload length prefix and trim padding
        const payloadLen = new DataView(decryptedRaw.buffer).getUint32(0, true);
        const decryptedCopy = decryptedRaw.subarray(4, 4 + payloadLen);
        const pixels = this.decompressFrame(decryptedCopy, width, height, flags);
        return { pixels, width, height, tampered: false };
    }

    /**
     * Decrypt a packet directly into a pre-allocated buffer. Zero-alloc hot path.
     * `out` must be at least `width * height * 4` bytes (read width/height from peekHeader).
     * Returns { width, height, tampered }. If !tampered, `out` contains the decoded RGBA pixels.
     */
    decodeInto(packet: Uint8Array, out: Uint8Array): { width: number; height: number; tampered: boolean } {
        if (!this.wasm) throw new Error("Codec not initialized");
        if (packet.length < HEADER_SIZE + MAC_SIZE) throw new Error("Video packet too short");

        const dvHdr = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
        const width = dvHdr.getUint16(0, true);
        const height = dvHdr.getUint16(2, true);
        const flags = dvHdr.getUint32(8, true);
        const { compressed } = decodeFlags(flags);

        if (!compressed) {
            const numPixels = width * height;
            const totalNeeded = BUF_START + packet.length + numPixels * 4;
            const mem = this.wasm.memory;
            if (mem.buffer.byteLength < totalNeeded) {
                this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
            }
            const packetPtr = BUF_START;
            const outPtr = BUF_START + packet.length;
            new Uint8Array(mem.buffer).set(packet, packetPtr);
            const pixelsDecoded = this.wasm.decode_video(packetPtr, packet.length, outPtr);
            const tampered = pixelsDecoded === 0;
            if (!tampered) out.set(new Uint8Array(mem.buffer, outPtr, pixelsDecoded * 4));
            return { width, height, tampered };
        }

        // Compressed path
        const encPayloadBytes = packet.length - HEADER_SIZE - MAC_SIZE;
        const pseudoPixels = encPayloadBytes / 4;
        const [pseudoW, pseudoH] = pseudoDims(pseudoPixels);
        const totalNeeded = BUF_START + packet.length + pseudoPixels * 4;
        const mem = this.wasm.memory;
        if (mem.buffer.byteLength < totalNeeded) {
            this.wasm.memory.grow(Math.ceil((totalNeeded - mem.buffer.byteLength) / 65536));
        }
        const packetPtr = BUF_START;
        const outPtr = BUF_START + packet.length;
        new Uint8Array(mem.buffer).set(packet, packetPtr);
        const patchDv = new DataView(mem.buffer, packetPtr, HEADER_SIZE);
        patchDv.setUint16(0, pseudoW, true);
        patchDv.setUint16(2, pseudoH, true);
        const decResult = this.wasm.decode_video(packetPtr, packet.length, outPtr);
        if (decResult === 0) return { width, height, tampered: true };

        const decryptedRaw = new Uint8Array(mem.buffer.slice(outPtr, outPtr + decResult * 4));
        const payloadLen = new DataView(decryptedRaw.buffer).getUint32(0, true);
        const decryptedCopy = decryptedRaw.subarray(4, 4 + payloadLen);
        const pixels = this.decompressFrame(decryptedCopy, width, height, flags);
        out.set(pixels);
        return { width, height, tampered: false };
    }

    /** Convenience: decode to ImageData for direct canvas rendering. Browser-only. */
    decodeToImageData(packet: Uint8Array): ImageData | null {
        const { pixels, width, height, tampered } = this.decode(packet);
        if (tampered) return null;
        return new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength), width, height);
    }
}
