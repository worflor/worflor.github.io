/**
 * live-wasm-video.ts — Whisper Lumen Video Codec (Woflo / MB)
 *
 * VBS DCT (8/16/32) + 3D Möbius coefficient prediction + 8-mode intra +
 * adaptive quantization + CfL chroma-from-luma + deblocking + delta P-frames.
 * format 0x07 = I-frame, 0x08 = P-frame (delta through same VBS pipeline).
 * encrypted: ChaCha20 + HalfSipHash-2-4 MAC, hand-written WASM+SIMD.
 */
import * as simd from "./video-simd";
import { encode0D, decode0D } from "./live-wasm-logos";

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

const LOAD16u = (al: number, off: number) => [0x2f, al, ...encodeULEB(off)];
const LOAD32 = (al: number, off: number) => [0x28, al, ...encodeULEB(off)];
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
    return simd.yuv420ToRgbaNN(yuv, w, h);
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
// --- perceptual transfer function (sqrt PQ) ---
// human vision follows Weber's law: sensitivity scales as 1/L. sqrt transfer
// (gamma=0.5) redistributes quantization to give 2x more precision in darks.
// same principle as sRGB gamma, µ-law companding, SMPTE ST 2084 PQ.
// applied to Y plane of I-frames only.
//
// Identity PQ tables: SDR Y is display-referred (already gamma-encoded by camera/display
// pipeline). Applying a second perceptual curve warps the quantization spacing non-uniformly,
// causing non-monotonic PSNR at specific Q levels (Y error direction flips, unclamps RGB).
// Identity is the mathematically correct choice for 8-bit SDR input.
const PQ_FWD = new Uint8Array(256); // identity
const PQ_INV = new Uint8Array(256); // identity
for (let i = 0; i < 256; i++) { PQ_FWD[i] = i; PQ_INV[i] = i; }

function pqForward(data: Uint8Array, offset: number, count: number): void {
    simd.pqForward(data, offset, count);
}

function pqInverse(data: Uint8Array, offset: number, count: number): void {
    simd.pqInverse(data, offset, count);
}

// ── DCT-8 transform ──────────────────────────────────────────────────────────
//
// Orthonormal 2D type-II DCT for 8×8 blocks.  Forward and inverse are
// transposes of each other (IDCT = DCT of transposed input), so one cosine
// table covers both directions.
//
// Frequency convention (same as JPEG):
//   C[v][u] = orthonormal DCT coefficient at vertical freq v, horizontal freq u
//   u,v ∈ [0,7].  Stored row-major: index = v*8+u.
//
// Input pixels are centred before the transform (subtract `centre`, e.g. 128
// for Y), so C[0][0] ≈ block_mean * 8.  After quantisation the DC level for
// Y ≈ ±100 at Q=70, well within signed-byte range.
//
// Precision: Float32 — sufficient for 8-bit source pixels.

const _DCTT: Float32Array = (() => {
    // _DCTT[k*8+n] = c(k) * cos(π*k*(2n+1)/16),  c(0)=1/√2, c(k>0)=1
    const t = new Float32Array(64);
    const sq2inv = 1 / Math.SQRT2;
    for (let k = 0; k < 8; k++)
        for (let n = 0; n < 8; n++)
            t[k * 8 + n] = (k === 0 ? sq2inv : 1) * Math.cos(Math.PI * k * (2 * n + 1) / 16);
    return t;
})();
const _DCTNORM = 0.5; // √(2/8)

/** Forward 2D DCT-8 of an 8×8 block.
 *  @param src  source plane (Uint8Array or Float32Array)
 *  @param sOff pixel (row=0,col=0) offset into src
 *  @param stride row stride of src (pixels per row)
 *  @param centre value subtracted from each pixel before transform (e.g. 128)
 *  @param out  output Float32Array(64), row-major [v*8+u] */
function dct8x8Fwd(
    src: Uint8Array | Float32Array,
    sOff: number, stride: number, centre: number,
    out: Float32Array
): void {
    const tmp = new Float32Array(64);
    // 1. Row-wise 1D DCT
    for (let r = 0; r < 8; r++) {
        for (let k = 0; k < 8; k++) {
            let s = 0;
            for (let n = 0; n < 8; n++) s += (src[sOff + r * stride + n] - centre) * _DCTT[k * 8 + n];
            tmp[r * 8 + k] = s * _DCTNORM;
        }
    }
    // 2. Column-wise 1D DCT  (rows of tmp are horizontal-frequency vectors)
    for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
            let s = 0;
            for (let r = 0; r < 8; r++) s += tmp[r * 8 + u] * _DCTT[v * 8 + r];
            out[v * 8 + u] = s * _DCTNORM;
        }
    }
}

/** Inverse 2D DCT-8.  Adds `centre` to each reconstructed sample.
 *  @param coeffs Float32Array(64), row-major [v*8+u]
 *  @param cOff   offset into coeffs
 *  @param dst    output plane (Uint8Array for clamped, or Float32Array)
 *  @param dOff   pixel (row=0,col=0) offset into dst
 *  @param stride row stride of dst
 *  @param centre value added to each reconstructed sample */
function dct8x8Inv(
    coeffs: Float32Array,
    cOff: number,
    dst: Uint8Array | Float32Array,
    dOff: number, stride: number, centre: number
): void {
    const tmp = new Float32Array(64);
    // 1. Column-wise IDCT  (invert the second pass of forward)
    for (let u = 0; u < 8; u++) {
        for (let r = 0; r < 8; r++) {
            let s = 0;
            for (let v = 0; v < 8; v++) s += coeffs[cOff + v * 8 + u] * _DCTT[v * 8 + r];
            tmp[r * 8 + u] = s * _DCTNORM;
        }
    }
    // 2. Row-wise IDCT  (invert the first pass of forward)
    for (let r = 0; r < 8; r++) {
        for (let n = 0; n < 8; n++) {
            let s = 0;
            for (let k = 0; k < 8; k++) s += tmp[r * 8 + k] * _DCTT[k * 8 + n];
            const v = s * _DCTNORM + centre;
            if (dst instanceof Uint8Array)
                dst[dOff + r * stride + n] = Math.max(0, Math.min(255, Math.round(v)));
            else
                (dst as Float32Array)[dOff + r * stride + n] = v;
        }
    }
}

// ── DCT-16 transform ──────────────────────────────────────────────────────────
//
// Orthonormal 2D type-II DCT for 16×16 blocks.
// T16[k,n] = c(k) * cos(π*k*(2n+1)/32),  c(0)=1/√2, c(k>0)=1
// Frequency (v,u) covers 16×16 = 256 coefficients.  _DCTNORM16 = 0.25 = 1/√16.

const _DCTT16: Float32Array = (() => {
    const t = new Float32Array(256);
    const sq2inv = 1 / Math.SQRT2;
    for (let k = 0; k < 16; k++)
        for (let n = 0; n < 16; n++)
            t[k * 16 + n] = (k === 0 ? sq2inv : 1) * Math.cos(Math.PI * k * (2 * n + 1) / 32);
    return t;
})();
const _DCTNORM16 = Math.sqrt(2 / 16); // √(2/N) for N=16, same convention as _DCTNORM=√(2/8)=0.5

function dct16x16Fwd(
    src: Uint8Array | Float32Array,
    sOff: number, stride: number, centre: number,
    out: Float32Array
): void {
    const tmp = new Float32Array(256);
    for (let r = 0; r < 16; r++) {
        for (let k = 0; k < 16; k++) {
            let s = 0;
            for (let n = 0; n < 16; n++) s += (src[sOff + r * stride + n] - centre) * _DCTT16[k * 16 + n];
            tmp[r * 16 + k] = s * _DCTNORM16;
        }
    }
    for (let v = 0; v < 16; v++) {
        for (let u = 0; u < 16; u++) {
            let s = 0;
            for (let r = 0; r < 16; r++) s += tmp[r * 16 + u] * _DCTT16[v * 16 + r];
            out[v * 16 + u] = s * _DCTNORM16;
        }
    }
}

function dct16x16Inv(
    coeffs: Float32Array, cOff: number,
    dst: Uint8Array | Float32Array,
    dOff: number, stride: number, centre: number
): void {
    const tmp = new Float32Array(256);
    for (let u = 0; u < 16; u++) {
        for (let r = 0; r < 16; r++) {
            let s = 0;
            for (let v = 0; v < 16; v++) s += coeffs[cOff + v * 16 + u] * _DCTT16[v * 16 + r];
            tmp[r * 16 + u] = s * _DCTNORM16;
        }
    }
    for (let r = 0; r < 16; r++) {
        for (let n = 0; n < 16; n++) {
            let s = 0;
            for (let k = 0; k < 16; k++) s += tmp[r * 16 + k] * _DCTT16[k * 16 + n];
            const v = s * _DCTNORM16 + centre;
            if (dst instanceof Uint8Array)
                dst[dOff + r * stride + n] = Math.max(0, Math.min(255, Math.round(v)));
            else
                (dst as Float32Array)[dOff + r * stride + n] = v;
        }
    }
}

// ── 32×32 DCT ─────────────────────────────────────────────────────────────────
// T32[k,n] = c(k) * cos(π*k*(2n+1)/64),  c(0)=1/√2, c(k>0)=1
// Frequency (v,u) covers 32×32 = 1024 coefficients. _DCTNORM32 = √(2/32).

const _DCTT32: Float32Array = (() => {
    const t = new Float32Array(32 * 32);
    const sq2inv = 1 / Math.SQRT2;
    for (let k = 0; k < 32; k++)
        for (let n = 0; n < 32; n++)
            t[k * 32 + n] = (k === 0 ? sq2inv : 1) * Math.cos(Math.PI * k * (2 * n + 1) / 64);
    return t;
})();
const _DCTNORM32 = Math.sqrt(2 / 32); // 1/4

function dct32x32Fwd(
    src: Uint8Array | Float32Array,
    sOff: number, stride: number, centre: number,
    out: Float32Array
): void {
    const tmp = new Float32Array(1024);
    for (let r = 0; r < 32; r++) {
        for (let k = 0; k < 32; k++) {
            let s = 0;
            for (let n = 0; n < 32; n++) s += (src[sOff + r * stride + n] - centre) * _DCTT32[k * 32 + n];
            tmp[r * 32 + k] = s * _DCTNORM32;
        }
    }
    for (let v = 0; v < 32; v++) {
        for (let u = 0; u < 32; u++) {
            let s = 0;
            for (let r = 0; r < 32; r++) s += tmp[r * 32 + u] * _DCTT32[v * 32 + r];
            out[v * 32 + u] = s * _DCTNORM32;
        }
    }
}

function dct32x32Inv(
    coeffs: Float32Array, cOff: number,
    dst: Uint8Array | Float32Array,
    dOff: number, stride: number, centre: number
): void {
    const tmp = new Float32Array(1024);
    for (let u = 0; u < 32; u++) {
        for (let r = 0; r < 32; r++) {
            let s = 0;
            for (let v = 0; v < 32; v++) s += coeffs[cOff + v * 32 + u] * _DCTT32[v * 32 + r];
            tmp[r * 32 + u] = s * _DCTNORM32;
        }
    }
    for (let r = 0; r < 32; r++) {
        for (let n = 0; n < 32; n++) {
            let s = 0;
            for (let k = 0; k < 32; k++) s += tmp[r * 32 + k] * _DCTT32[k * 32 + n];
            const v = s * _DCTNORM32 + centre;
            if (dst instanceof Uint8Array)
                dst[dOff + r * stride + n] = Math.max(0, Math.min(255, Math.round(v)));
            else
                (dst as Float32Array)[dOff + r * stride + n] = v;
        }
    }
}

/** Build N×N quantisation step array (N=16,32) by upscaling from 8×8 baseline. */
function makeQdctN(base8: Uint8Array, quality: number, N: number): Float32Array {
    const q8 = makeQdct(base8, quality);
    const scale = N / 8;
    const qN = new Float32Array(N * N);
    for (let v = 0; v < N; v++)
        for (let u = 0; u < N; u++) {
            const v8 = Math.min(Math.round(v / scale), 7);
            const u8 = Math.min(Math.round(u / scale), 7);
            qN[v * N + u] = q8[v8 * 8 + u8];
        }
    return qN;
}

/** Extract N-pixel border references for an N×N block from reconstructed plane. */
function intraRefsN(
    recon: Float32Array, bx: number, by: number, w: number, h: number, centre: number, N: number
): { lc: Float32Array | null; tr: Float32Array | null; tl: number } {
    const px = bx * N, py = by * N;
    const lc = bx > 0 ? (() => {
        const c = new Float32Array(N);
        for (let y = 0; y < N; y++) c[y] = recon[Math.min(py + y, h - 1) * w + (px - 1)] - centre;
        return c;
    })() : null;
    const tr = by > 0 ? (() => {
        const c = new Float32Array(N);
        for (let x = 0; x < N; x++) c[x] = recon[(py - 1) * w + Math.min(px + x, w - 1)] - centre;
        return c;
    })() : null;
    const tl = (bx > 0 && by > 0) ? recon[(py - 1) * w + (px - 1)] - centre : 0;
    return { lc, tr, tl };
}

/** 8-mode intra prediction for any N×N block (N=8,16,32). */
function intraPredN(mode: number, lc: Float32Array | null, tr: Float32Array | null, tl: number, N: number): Float32Array {
    const pred = new Float32Array(N * N);
    const M = N - 1;
    if (mode === 1) { // DC + H.265 boundary smoothing
        let sum = 0, n = 0;
        if (lc) for (let i = 0; i < N; i++) { sum += lc[i]; n++; }
        if (tr) for (let i = 0; i < N; i++) { sum += tr[i]; n++; }
        const dc = n > 0 ? Math.round(sum / n) : 0;
        pred.fill(dc);
        if (tr) { for (let x = 0; x < N; x++) pred[x] = (tr[x] + 3*dc + 2) >> 2; }
        if (lc) { for (let y = 1; y < N; y++) pred[y*N] = (lc[y] + 3*dc + 2) >> 2; }
        if (tr && lc) pred[0] = (tr[0] + lc[0] + 2*dc + 2) >> 2;
        else if (tr) pred[0] = (tr[0] + 3*dc + 2) >> 2;
        else if (lc) pred[0] = (lc[0] + 3*dc + 2) >> 2;
    } else if (mode === 4) { // DDL
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
            pred[y*N+x] = tr ? tr[Math.min(x+y+1, M)] : 0;
    } else if (mode === 5) { // DDR
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
            pred[y*N+x] = x > y ? (tr ? tr[x-y-1] : 0) : x < y ? (lc ? lc[y-x-1] : 0) : tl;
    } else if (mode === 6) { // Smooth-H
        const right = tr ? tr[M] : 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
            pred[y*N+x] = ((lc ? lc[y] : 0) * (M - x) + right * x) / M;
    } else if (mode === 7) { // Smooth-V
        const bot = lc ? lc[M] : 0;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
            pred[y*N+x] = ((tr ? tr[x] : 0) * (M - y) + bot * y) / M;
    } else if (mode === 0) { // H.265/AV1 Planar
        const botLeft = lc ? lc[M] : 0, topRight = tr ? tr[M] : 0;
        const shift = 31 - Math.clz32(N) + 1; // 8→4, 16→5, 32→6
        const round = 1 << (shift - 1);
        for (let y = 0; y < N; y++) {
            const L = lc ? lc[y] : 0;
            for (let x = 0; x < N; x++)
                pred[y*N+x] = ((M-x)*L + (x+1)*topRight + (M-y)*(tr ? tr[x] : 0) + (y+1)*botLeft + round) >> shift;
        }
    } else { // 2 H, 3 V
        for (let y = 0; y < N; y++) {
            const L = lc ? lc[y] : 0;
            for (let x = 0; x < N; x++)
                pred[y*N+x] = mode === 2 ? L : (tr ? tr[x] : 0);
        }
    }
    return pred;
}



// ── JPEG-standard quantisation tables (Q=50 baseline) ────────────────────────
//
// Lumen maps its quality parameter to JPEG-quality via:
//   jpegQ = quality   (direct mapping to start; tune later)
// Scale factor: jpegQ < 50 → s = 5000/q, else s = 200 − 2*q
// Step = max(1, round(base * s / 100))

const _QDCT_LUMA_BASE = new Uint8Array([
    16,11,10,16,24,40,51,61,
    12,12,14,19,26,58,60,55,
    14,13,16,24,40,57,69,56,
    14,17,22,29,51,87,80,62,
    18,22,37,56,68,109,103,77,
    24,35,55,64,81,104,113,92,
    49,64,78,87,103,121,120,101,
    72,92,95,98,112,100,103,99,
]);
const _QDCT_CHROMA_BASE = new Uint8Array([
    17,18,24,47,99,99,99,99,
    18,21,26,66,99,99,99,99,
    24,26,56,99,99,99,99,99,
    47,66,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
    99,99,99,99,99,99,99,99,
]);

/** Build a 64-element quantisation step array from a baseline table and quality. */
function makeQdct(base: Uint8Array, quality: number): Float32Array {
    const s = quality < 50 ? 5000 / quality : 200 - 2 * quality;
    const q = new Float32Array(64);
    for (let i = 0; i < 64; i++) q[i] = Math.max(1, Math.round(base[i] * s / 100));
    return q;
}

/** AC dead-zone quantization: extends rounding threshold from 0.5q to 0.6q for AC
 *  coefficients (fi > 0). Coefficients in (0.5q, 0.6q) that would normally round to ±1
 *  are instead rounded to 0, creating more all-zero frequency planes that compress away. */
function dzQuant(c: number, q: number, fi: number): number {
    return (fi > 0 && Math.abs(c) < q * 0.60) ? 0 : Math.round(c / q);
}

/** per-block AQ: boundary gradient activity → qdct multiplier [0.8, 1.25].
 *  textured blocks get coarser Q (masking), smooth blocks get finer Q. */
function blockAQ(lc: Float32Array | null, tr: Float32Array | null, bs: number): number {
    let sum2 = 0, n = 0;
    if (lc) for (let i = 1; i < bs; i++) { const d = lc[i] - lc[i-1]; sum2 += d * d; n++; }
    if (tr) for (let i = 1; i < bs; i++) { const d = tr[i] - tr[i-1]; sum2 += d * d; n++; }
    if (n === 0) return 1.0;
    const activity = sum2 / n + 1; // +1 avoids log(0); values are integer-exact
    return Math.max(0.8, Math.min(1.25, Math.pow(activity / 80, 0.12)));
}
// ════════════════════════════════════════════════════════════════════════════════
// AKASHA INTRA PREDICTION + 3D/4D MÖBIUS COEFFICIENT CODING
//
// two-pass: (1) spatial — intra-predict 8×8 blocks, DCT, quantize, closed-loop recon.
//           (2) entropy — 3D Möbius (bx,by,fi) for Y; 4D Möbius (ubx,uby,fi,yAvg) for UV.
// ════════════════════════════════════════════════════════════════════════════════

/** Predict one 8×8 block in centred pixel space.
 *  lc = left column, tr = top row, tl = top-left (all centred). null at image edges.
 *
 *  Modes (4 bits/block):
 *  0 PLANAR  pred[y][x] = lc[y] + tr[x] − tl           (gradient blend, L+A−D)
 *  1 DC      pred = mean(lc ∪ tr)
 *  2 H       pred[y][x] = lc[y]                         (horizontal copy)
 *  3 V       pred[y][x] = tr[x]                         (vertical copy)
 *  4 DDL     pred[y][x] = tr[min(x+y+1,7)]              (diagonal down-left ~135°)
 *  5 DDR     pred[y][x] = x>y→tr[x-y-1] | x<y→lc[y-x-1] | x==y→tl  (diagonal ~45°)
 *  6 SMOOTH_H pred[y][x] = lerp(lc[y], tr[7], x/7)     (smooth horizontal)
 *  7 SMOOTH_V pred[y][x] = lerp(tr[x], lc[7], y/7)     (smooth vertical)
 */

// ── Entropy-domain L+A-D (Möbius web at the byte level) ─────────────────────
//
// Applies mod-256 L+A-D prediction to a cb-plane before/after encode0D.
// The decoded bytes are bitwise-identical to the input — purely lossless entropy coding.
// No effect on the spatial reconstruction path whatsoever.
//
// Residual distribution: adjacent cb values are spatially correlated → residuals
// cluster near 0 (and 255 = −1 mod 256). The Logos Bit0/Bit1 models code near-0
// bytes at ~0.03–0.2 bits vs ~3–6 bits for raw centred bytes. Large gain on smooth content.

function l2dCbEncode(cb: Uint8Array, nB: number, bxN: number, byN: number): Uint8Array {
    const res = new Uint8Array(nB);
    for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
        const bi = by * bxN + bx;
        const L = bx > 0 ? cb[bi-1] : 128;
        const A = by > 0 ? cb[bi-bxN] : 128;
        const D = (bx > 0 && by > 0) ? cb[bi-bxN-1] : 128;
        // CLAMP predictor: clamp L+A−D to [min(L,A), max(L,A)] — avoids overshoot at edges
        const lad = L + A - D;
        const P = Math.max(Math.min(L, A), Math.min(Math.max(L, A), lad));
        res[bi] = (cb[bi] - P) & 0xFF;
    }
    return encode0D(res);
}

function l2dCbDecode(data: Uint8Array, nB: number, bxN: number, byN: number): Uint8Array {
    const res = decode0D(data, nB);
    const cb = new Uint8Array(nB);
    for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
        const bi = by * bxN + bx;
        const L = bx > 0 ? cb[bi-1] : 128;
        const A = by > 0 ? cb[bi-bxN] : 128;
        const D = (bx > 0 && by > 0) ? cb[bi-bxN-1] : 128;
        // CLAMP predictor: clamp L+A−D to [min(L,A), max(L,A)] — avoids overshoot at edges
        const lad = L + A - D;
        const P = Math.max(Math.min(L, A), Math.min(Math.max(L, A), lad));
        cb[bi] = (res[bi] + P) & 0xFF;
    }
    return cb;
}

// ── Entropy-domain 3D Möbius: L+A+B − DXY − DXF − DYF + DXYF ──────────────
//
// Extends the 2D spatial prediction to include the frequency axis (B = previous
// frequency plane's cb value for the same block position).  The inclusion-exclusion
// formula over the unit 3-cube has error = Δx·Δy·Δf·g — zero for any signal
// whose cb values are at most bilinear in (x,y,f).  Adjacent DCT frequency planes
// are strongly correlated for natural images (energy rolls off smoothly), so the
// B neighbor reduces residual entropy beyond what 2D spatial prediction achieves.
//
// Uses mod-256 arithmetic (same as l2dCbEncode). No clamping — the full Möbius
// is optimal for polynomial signals, and encode0D handles wrapped residuals well.

function l3dCbEncode(
    cb: Uint8Array, prevCb: Uint8Array,
    nB: number, bxN: number, byN: number
): Uint8Array {
    const res = new Uint8Array(nB);
    for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
        const bi = by * bxN + bx;
        const L    = bx > 0 ? cb[bi-1] : 128;
        const A    = by > 0 ? cb[bi-bxN] : 128;
        const B    = prevCb[bi];
        const DXY  = (bx > 0 && by > 0) ? cb[bi-bxN-1] : 128;
        const DXF  = bx > 0 ? prevCb[bi-1] : 128;
        const DYF  = by > 0 ? prevCb[bi-bxN] : 128;
        const DXYF = (bx > 0 && by > 0) ? prevCb[bi-bxN-1] : 128;
        // Full 3D Möbius clamped to [min(L,A,B), max(L,A,B)]
        const raw = L + A + B - DXY - DXF - DYF + DXYF;
        const lo = Math.min(L, A, B), hi = Math.max(L, A, B);
        const P = Math.max(lo, Math.min(hi, raw));
        // Zigzag fold: mod-256 residual → small-abs-first byte ordering
        // 0→0, 255(-1)→1, 1→2, 254(-2)→3, 2→4, ... so ±small → small byte
        const r = (cb[bi] - P) & 0xFF;
        res[bi] = r < 128 ? r * 2 : (256 - r) * 2 - 1;
    }
    return encode0D(res);
}

function l3dCbDecode(
    data: Uint8Array, prevCb: Uint8Array,
    nB: number, bxN: number, byN: number
): Uint8Array {
    const res = decode0D(data, nB);
    const cb = new Uint8Array(nB);
    for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
        const bi = by * bxN + bx;
        const L    = bx > 0 ? cb[bi-1] : 128;
        const A    = by > 0 ? cb[bi-bxN] : 128;
        const B    = prevCb[bi];
        const DXY  = (bx > 0 && by > 0) ? cb[bi-bxN-1] : 128;
        const DXF  = bx > 0 ? prevCb[bi-1] : 128;
        const DYF  = by > 0 ? prevCb[bi-bxN] : 128;
        const DXYF = (bx > 0 && by > 0) ? prevCb[bi-bxN-1] : 128;
        const raw = L + A + B - DXY - DXF - DYF + DXYF;
        const lo = Math.min(L, A, B), hi = Math.max(L, A, B);
        const P = Math.max(lo, Math.min(hi, raw));
        // Unfold zigzag: even → positive, odd → negative
        const m = res[bi];
        const r = (m & 1) ? (256 - ((m + 1) >> 1)) & 0xFF : (m >> 1);
        cb[bi] = (r + P) & 0xFF;
    }
    return cb;
}

// ---------------------------------------------------------------------------
// ── Akasha encode/decode helpers ─────────────────────────────────────────────

/** 3D Möbius predictor for the Y coefficient tensor (bx, by, fi). */
function mob3D(dec: Int16Array, fi: number, by: number, bx: number, bxN: number, nB: number): number {
    const bi = by * bxN + bx;
    const hL = bx > 0, hA = by > 0, hB = fi > 0;
    const L    = hL           ? dec[fi*nB + bi - 1]          : 0;
    const A    = hA           ? dec[fi*nB + bi - bxN]        : 0;
    const B    = hB           ? dec[(fi-1)*nB + bi]          : 0;
    const DXY  = hL&&hA       ? dec[fi*nB + bi-1-bxN]        : 0;
    const DXF  = hL&&hB       ? dec[(fi-1)*nB + bi - 1]      : 0;
    const DYF  = hA&&hB       ? dec[(fi-1)*nB + bi - bxN]    : 0;
    const DXYF = hL&&hA&&hB   ? dec[(fi-1)*nB + bi-1-bxN]    : 0;
    return L + A + B - DXY - DXF - DYF + DXYF;
}

/** 4D Möbius predictor for UV: T dimension = Y_avg channel. */
function mob4DUV(
    dec: Int16Array, yAvg: Float32Array,
    fi: number, uby: number, ubx: number, ubxN: number, nBUV: number
): number {
    const bi = uby * ubxN + ubx;
    const hL = ubx > 0, hA = uby > 0, hB = fi > 0;
    // T: Y_avg at current position
    const T    =                  yAvg[fi * nBUV + bi];
    const L    = hL           ? dec[fi*nBUV + bi - 1]           : 0;
    const A    = hA           ? dec[fi*nBUV + bi - ubxN]        : 0;
    const B    = hB           ? dec[(fi-1)*nBUV + bi]           : 0;
    const DXT  = hL           ? yAvg[fi*nBUV + bi - 1]          : 0;
    const DYT  = hA           ? yAvg[fi*nBUV + bi - ubxN]       : 0;
    const DFT  = hB           ? yAvg[(fi-1)*nBUV + bi]          : 0;
    const DXY  = hL&&hA       ? dec[fi*nBUV + bi-1-ubxN]        : 0;
    const DXF  = hL&&hB       ? dec[(fi-1)*nBUV + bi - 1]       : 0;
    const DYF  = hA&&hB       ? dec[(fi-1)*nBUV + bi - ubxN]    : 0;
    const DXYT = hL&&hA       ? yAvg[fi*nBUV + bi-1-ubxN]       : 0;
    const DXFT = hL&&hB       ? yAvg[(fi-1)*nBUV + bi - 1]      : 0;
    const DYFT = hA&&hB       ? yAvg[(fi-1)*nBUV + bi - ubxN]   : 0;
    const DXYF = hL&&hA&&hB   ? dec[(fi-1)*nBUV + bi-1-ubxN]    : 0;
    const D4   = hL&&hA&&hB   ? yAvg[(fi-1)*nBUV + bi-1-ubxN]   : 0;
    return (L + A + B + T)
         - (DXY + DXF + DXT + DYF + DYT + DFT)
         + (DXYF + DXYT + DXFT + DYFT)
         - D4;
}

/** Encode 64 frequency planes using closed-loop 3D Möbius prediction.
 *  Wire layout: 8-byte bitmap + (2B-len + 1B-sc + encode0D(cb)) per non-zero plane. */
function encodeFreqPlanes3D(rawLvl: Int16Array, nB: number, bxN: number, byN: number): Uint8Array {
    const dec = new Int16Array(64 * nB);
    const pBufs: (Uint8Array | null)[] = [];
    for (let fi = 0; fi < 64; fi++) {
        let maxAbs = 0;
        for (let bi = 0; bi < nB; bi++) { const a = Math.abs(rawLvl[fi*nB+bi]); if (a > maxAbs) maxAbs = a; }
        if (maxAbs === 0) { pBufs.push(null); continue; }

        // Pass 1: open-loop using rawLvl as spatial neighbours to bound closed-loop residuals
        for (let bi = 0; bi < nB; bi++) dec[fi*nB+bi] = rawLvl[fi*nB+bi];
        let maxR = 0;
        for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
            const bi = by*bxN+bx;
            const r = rawLvl[fi*nB+bi] - mob3D(dec, fi, by, bx, bxN, nB);
            const a = Math.abs(r); if (a > maxR) maxR = a;
        }
        const sc = Math.ceil(maxR / 120) || 1;  // /120 not /127: 6% headroom for closed-loop drift

        // Pass 2: closed-loop encode; dec tracks decoder's exact state (uses clamped q)
        const cb = new Uint8Array(nB);
        for (let bi = 0; bi < nB; bi++) dec[fi*nB+bi] = 0;  // reset current fi for closed-loop
        for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
            const bi = by * bxN + bx;
            const P = mob3D(dec, fi, by, bx, bxN, nB);
            const q = Math.round((rawLvl[fi*nB+bi] - P) / sc);
            cb[bi] = Math.min(255, Math.max(0, q + 128));
            dec[fi*nB+bi] = (cb[bi] - 128) * sc + P;  // mirror decoder exactly
        }
        const enc = encode0D(cb);
        const pb = new Uint8Array(1 + enc.length);
        pb[0] = sc & 0x7F; pb.set(enc, 1);
        pBufs.push(pb);
    }
    const bm = new Uint8Array(8);
    let total = 8;
    for (let fi = 0; fi < 64; fi++) if (pBufs[fi]) { bm[fi>>3] |= 1<<(fi&7); total += 2+pBufs[fi]!.length; }
    const out = new Uint8Array(total); out.set(bm); let off = 8;
    for (let fi = 0; fi < 64; fi++) if (pBufs[fi]) {
        const pb = pBufs[fi]!; out[off]=pb.length&0xFF; out[off+1]=pb.length>>8; off+=2; out.set(pb,off); off+=pb.length;
    }
    return out;
}

/** Decode 64 frequency planes encoded by encodeFreqPlanes3D. */
function decodeFreqPlanes3D(bits: Uint8Array, nB: number, bxN: number, byN: number): Int16Array {
    const levels = new Int16Array(64 * nB);
    let off = 8; // skip bitmap bytes
    for (let fi = 0; fi < 64; fi++) {
        if (!(bits[fi>>3] & (1<<(fi&7)))) continue;
        const plen = bits[off] | (bits[off+1]<<8); off += 2;
        const sc = bits[off] & 0x7F;
        const cb = decode0D(bits.subarray(off+1, off+plen), nB); off += plen;
        for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
            const bi = by*bxN+bx;
            levels[fi*nB+bi] = (cb[bi]-128)*sc + mob3D(levels, fi, by, bx, bxN, nB);
        }
    }
    return levels;
}

/** Encode 64 UV frequency planes with 4D Möbius (T = Y_avg channel). */
function encodeFreqPlanes4DUV(
    rawLvl: Int16Array, nBUV: number, ubxN: number, ubyN: number,
    yAvg: Float32Array
): Uint8Array {
    const dec = new Int16Array(64 * nBUV);
    const pBufs: (Uint8Array | null)[] = [];
    for (let fi = 0; fi < 64; fi++) {
        let maxAbs = 0;
        for (let bi = 0; bi < nBUV; bi++) { const a = Math.abs(rawLvl[fi*nBUV+bi]); if (a > maxAbs) maxAbs = a; }
        if (maxAbs === 0) { pBufs.push(null); continue; }

        // Pass 1: open-loop with rawLvl as spatial neighbours
        for (let bi = 0; bi < nBUV; bi++) dec[fi*nBUV+bi] = rawLvl[fi*nBUV+bi];
        let maxR = 0;
        for (let uby = 0; uby < ubyN; uby++) for (let ubx = 0; ubx < ubxN; ubx++) {
            const bi = uby*ubxN+ubx;
            const r = rawLvl[fi*nBUV+bi] - mob4DUV(dec, yAvg, fi, uby, ubx, ubxN, nBUV);
            const a = Math.abs(r); if (a > maxR) maxR = a;
        }
        const sc = Math.ceil(maxR / 120) || 1;

        // Pass 2: closed-loop; mirror decoder state exactly
        const cb = new Uint8Array(nBUV);
        for (let bi = 0; bi < nBUV; bi++) dec[fi*nBUV+bi] = 0;
        for (let uby = 0; uby < ubyN; uby++) for (let ubx = 0; ubx < ubxN; ubx++) {
            const bi = uby * ubxN + ubx;
            const P = mob4DUV(dec, yAvg, fi, uby, ubx, ubxN, nBUV);
            const q = Math.round((rawLvl[fi*nBUV+bi] - P) / sc);
            cb[bi] = Math.min(255, Math.max(0, q + 128));
            dec[fi*nBUV+bi] = (cb[bi] - 128) * sc + P;
        }
        const enc = encode0D(cb);
        const pb = new Uint8Array(1 + enc.length);
        pb[0] = sc & 0x7F; pb.set(enc, 1);
        pBufs.push(pb);
    }
    const bm = new Uint8Array(8);
    let total = 8;
    for (let fi = 0; fi < 64; fi++) if (pBufs[fi]) { bm[fi>>3] |= 1<<(fi&7); total += 2+pBufs[fi]!.length; }
    const out = new Uint8Array(total); out.set(bm); let off = 8;
    for (let fi = 0; fi < 64; fi++) if (pBufs[fi]) {
        const pb = pBufs[fi]!; out[off]=pb.length&0xFF; out[off+1]=pb.length>>8; off+=2; out.set(pb,off); off+=pb.length;
    }
    return out;
}

/** Decode UV planes encoded with encodeFreqPlanes4DUV. */
function decodeFreqPlanes4DUV(
    bits: Uint8Array, nBUV: number, ubxN: number, ubyN: number,
    yAvg: Float32Array
): Int16Array {
    const levels = new Int16Array(64 * nBUV);
    let off = 8;
    for (let fi = 0; fi < 64; fi++) {
        if (!(bits[fi>>3] & (1<<(fi&7)))) continue;
        const plen = bits[off] | (bits[off+1]<<8); off += 2;
        const sc = bits[off] & 0x7F;
        const cb = decode0D(bits.subarray(off+1, off+plen), nBUV); off += plen;
        for (let uby = 0; uby < ubyN; uby++) for (let ubx = 0; ubx < ubxN; ubx++) {
            const bi = uby*ubxN+ubx;
            levels[fi*nBUV+bi] = (cb[bi]-128)*sc + mob4DUV(levels, yAvg, fi, uby, ubx, ubxN, nBUV);
        }
    }
    return levels;
}

/** Build Y_avg tensor: yAvg[fi * nBUV + uby*ubxN + ubx] = mean of 4 Y decoded levels. */
function buildYAvg(
    yDecLvl: Int16Array, bxNY: number, byNY: number,
    ubxN: number, ubyN: number
): Float32Array {
    const nBUV = ubxN * ubyN;
    const nBY = bxNY * byNY;
    const yAvg = new Float32Array(64 * nBUV);
    for (let fi = 0; fi < 64; fi++) {
        const yBase = fi * nBY;
        for (let uby = 0; uby < ubyN; uby++) for (let ubx = 0; ubx < ubxN; ubx++) {
            const iy0 = Math.min(uby*2,   byNY-1), iy1 = Math.min(uby*2+1, byNY-1);
            const ix0 = Math.min(ubx*2,   bxNY-1), ix1 = Math.min(ubx*2+1, bxNY-1);
            yAvg[fi*nBUV + uby*ubxN+ubx] = (
                yDecLvl[yBase + iy0*bxNY + ix0] + yDecLvl[yBase + iy0*bxNY + ix1] +
                yDecLvl[yBase + iy1*bxNY + ix0] + yDecLvl[yBase + iy1*bxNY + ix1]
            ) / 4;
        }
    }
    return yAvg;
}

// ── Akasha: intra prediction + per-block scalar quantization ───────────────────
//
// Correctness guarantee: for each block, the encoder quantizes to cb, then
// immediately dequantizes to update recon — exactly mirroring the decoder.
// No cross-block frequency-domain predictor → no circular dependency.
//
// Wire format:
//   [8B bitmap: active fi planes]
//   [2B scLen][encode0D(scArr)]     — per-block scale, nB bytes
//   for each active fi: [2B len][encode0D(cb_plane)]  — nB bytes each

/** Encode one plane (luma or chroma) with 8-mode intra + per-block scalar quant.
 *  modeBits uses 4-bit nibble packing (2 blocks/byte).
 *  cb planes and scArr are entropy-coded with L+A-D prediction (Möbius entropy web). */
/** CfL global alpha: OLS regression of UV block means on Y block means. */
function cflGlobalAlpha(
    uvPlane: Uint8Array, uvW: number, uvH: number,
    yRecon: Uint8Array, yW: number, yH: number
): number {
    const uvBxN = Math.ceil(uvW / 8), uvByN = Math.ceil(uvH / 8);
    let sYY = 0, sYUV = 0;
    for (let uvBy = 0; uvBy < uvByN; uvBy++) {
        for (let uvBx = 0; uvBx < uvBxN; uvBx++) {
            let ySum = 0, yN = 0;
            for (let dy = 0; dy < 16 && uvBy*16+dy < yH; dy++)
                for (let dx = 0; dx < 16 && uvBx*16+dx < yW; dx++) {
                    ySum += yRecon[(uvBy*16+dy)*yW+(uvBx*16+dx)]; yN++;
                }
            const yMean = yN > 0 ? ySum/yN : 128;
            let uvSum = 0, uvN = 0;
            for (let dy = 0; dy < 8 && uvBy*8+dy < uvH; dy++)
                for (let dx = 0; dx < 8 && uvBx*8+dx < uvW; dx++) {
                    uvSum += uvPlane[(uvBy*8+dy)*uvW+(uvBx*8+dx)]; uvN++;
                }
            const uvMean = uvN > 0 ? uvSum/uvN : 128;
            sYY  += (yMean-128)*(yMean-128);
            sYUV += (yMean-128)*(uvMean-128);
        }
    }
    return sYY < 1 ? 0 : Math.max(-2, Math.min(2, sYUV / sYY));
}

function encodeAkashaPlane(
    plane: Uint8Array, w: number, h: number, qdct: Float32Array, centre: number,
    cflAlpha?: number, yRecon?: Uint8Array, yW?: number, yH?: number
): { bits: Uint8Array; modeBits: Uint8Array; decLvl: Int16Array; recon: Uint8Array } {
    const bxN = Math.ceil(w / 8), byN = Math.ceil(h / 8), nB = bxN * byN;
    const modes  = new Uint8Array(nB);
    const scArr  = new Uint8Array(nB);
    const cbMat  = new Uint8Array(64 * nB).fill(128); // cbMat[fi*nB+bi]
    const dec    = new Int16Array(64 * nB);
    const recon  = new Float32Array(w * h).fill(centre);
    const coeff  = new Float32Array(64);
    const lvl    = new Int16Array(64);
    const res    = new Float32Array(64);

    for (let by = 0; by < byN; by++) {
        for (let bx = 0; bx < bxN; bx++) {
            const bi = by * bxN + bx;
            const px = bx * 8, py = by * 8;
            const { lc, tr, tl } = intraRefsN(recon, bx, by, w, h, centre, 8);

            // CfL: compute block-constant Y-mean correction BEFORE mode selection
            // so mode selection can account for CfL shifting the DC residual.
            let cflInt = 0;
            if (cflAlpha && yRecon) {
                let ySum = 0, yN = 0;
                for (let dy = 0; dy < 16 && by*16+dy < yH!; dy++)
                    for (let dx = 0; dx < 16 && bx*16+dx < yW!; dx++) {
                        ySum += yRecon[(by*16+dy)*yW!+(bx*16+dx)]; yN++;
                    }
                cflInt = Math.round(cflAlpha * ((yN>0 ? ySum/yN : 128) - 128));
            }

            // Adaptive quantization: scale Q by boundary activity (decoder-derivable)
            const aq = blockAQ(lc, tr, 8);

            // 8-mode selection: DCT-domain quantization error (Parseval optimal).
            // CfL correction included so mode selection uses the actual encoded residual.
            let bestMode = 0, bestQErr = Infinity;
            for (let m = 0; m < 8; m++) {
                const pred = intraPredN(m, lc, tr, tl, 8);
                for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                    const ry = py+y, rx = px+x;
                    res[y*8+x] = ry < h && rx < w ? (plane[ry*w+rx] - centre) - pred[y*8+x] - cflInt : 0;
                }
                dct8x8Fwd(res, 0, 8, 0, coeff);
                let qErr = 0;
                for (let fi = 0; fi < 64; fi++) {
                    const lv = dzQuant(coeff[fi], qdct[fi] * aq, fi);
                    const e = coeff[fi] - lv * qdct[fi] * aq;
                    qErr += e * e;
                }
                if (qErr < bestQErr) { bestQErr = qErr; bestMode = m; }
            }
            modes[bi] = bestMode;

            const pred = intraPredN(bestMode, lc, tr, tl, 8);
            // cflInt already computed above (no redundant Y-mean recomputation)

            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                const ry = py+y, rx = px+x;
                res[y*8+x] = ry < h && rx < w ? (plane[ry*w+rx] - centre) - pred[y*8+x] - cflInt : 0;
            }
            dct8x8Fwd(res, 0, 8, 0, coeff);
            for (let fi = 0; fi < 64; fi++) lvl[fi] = dzQuant(coeff[fi], qdct[fi] * aq, fi);

            // Per-block scale with soft-clip RD: if one outlier forces sc=2, compare
            // distortion of sc=2 (all coefficients lose precision) vs sc=1 (clip outliers to ±127).
            let maxAbs = 0;
            for (let fi = 0; fi < 64; fi++) { const a = Math.abs(lvl[fi]); if (a > maxAbs) maxAbs = a; }
            let sc = Math.ceil(maxAbs / 127) || 1;
            if (sc > 1) {
                // Distortion from sc>1: every coefficient rounds to nearest multiple of sc
                let distSc = 0;
                for (let fi = 0; fi < 64; fi++) {
                    const q = qdct[fi] * aq;
                    const dec_lv = (Math.round(lvl[fi] / sc)) * sc;
                    const e = (lvl[fi] - dec_lv) * q;
                    distSc += e * e;
                }
                // Distortion from clip: outliers clipped to ±127, rest exact (sc=1)
                let distClip = 0;
                for (let fi = 0; fi < 64; fi++) {
                    const q = qdct[fi] * aq;
                    const clamped = Math.max(-127, Math.min(127, lvl[fi]));
                    const e = (lvl[fi] - clamped) * q;
                    distClip += e * e;
                }
                if (distClip < distSc) {
                    // Clip is better: clamp levels and use sc=1
                    for (let fi = 0; fi < 64; fi++) lvl[fi] = Math.max(-127, Math.min(127, lvl[fi]));
                    sc = 1;
                }
            }
            scArr[bi] = sc;

            // Quantize + immediate dequantize (mirrors decoder exactly)
            for (let fi = 0; fi < 64; fi++) {
                const cb = Math.round(lvl[fi] / sc) + 128;
                cbMat[fi * nB + bi] = cb;
                dec[fi * nB + bi] = (cb - 128) * sc;
            }

            // Recon WITHOUT cflInt (for intra predictor consistency — neighbors see CfL-free recon)
            for (let fi = 0; fi < 64; fi++) coeff[fi] = dec[fi * nB + bi] * qdct[fi] * aq;
            dct8x8Inv(coeff, 0, res, 0, 8, 0);
            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                const ry = py+y, rx = px+x;
                if (ry < h && rx < w)
                    recon[ry*w+rx] = Math.max(0, Math.min(255, Math.round(pred[y*8+x] + res[y*8+x] + centre)));
            }
        }
    }

    // Entropy-encode sc array (Logos handles small integers efficiently)
    const scBits = encode0D(scArr);

    // Entropy-encode 64 cb planes.
    // DC (fi=0): always l2dCbEncode (block means spatially smooth → huge gain from skip).
    // AC (fi>0): per-plane best of encode0D / l2dCb / l3dCb (3D Möbius with freq axis).
    // 2-byte length field: bits 15:14 = method (0=encode0D, 1=l3dCb, 2=l2dCb).
    const bm = new Uint8Array(8);
    const planeBufs: (Uint8Array | null)[] = [];
    const planeFlags = new Uint8Array(64); // 0=encode0D, 1=l3dCb, 2=l2dCb
    const prevCbPlane = new Uint8Array(nB).fill(128);
    for (let fi = 0; fi < 64; fi++) {
        const cbPlane = cbMat.subarray(fi * nB, (fi + 1) * nB);
        let allMid = true;
        for (let bi = 0; bi < nB; bi++) if (cbPlane[bi] !== 128) { allMid = false; break; }
        if (allMid) { planeBufs.push(null); prevCbPlane.set(cbPlane); continue; }
        bm[fi >> 3] |= 1 << (fi & 7);
        const cbCopy = new Uint8Array(cbPlane);
        if (fi === 0) {
            planeBufs.push(l2dCbEncode(cbCopy, nB, bxN, byN));
            planeFlags[fi] = 2; // l2dCb
        } else {
            const enc0  = encode0D(cbCopy);
            const encL2 = l2dCbEncode(cbCopy, nB, bxN, byN);
            const encL3 = l3dCbEncode(cbCopy, prevCbPlane, nB, bxN, byN);
            if (encL3.length <= encL2.length && encL3.length <= enc0.length) {
                planeBufs.push(encL3); planeFlags[fi] = 1; // l3dCb
            } else if (encL2.length < enc0.length) {
                planeBufs.push(encL2); planeFlags[fi] = 2; // l2dCb
            } else {
                planeBufs.push(enc0); // planeFlags[fi] = 0 (encode0D)
            }
        }
        prevCbPlane.set(cbPlane);
    }

    // Pack: [8B bm][2B scLen][scBits][active planes: 2B len + data]
    // Bits 15:14 of 2B length field = method (0=encode0D, 1=l3dCb, 2=l2dCb).
    let total = 10 + scBits.length;
    for (const pb of planeBufs) if (pb) total += 2 + pb.length;
    const bits = new Uint8Array(total);
    bits.set(bm);
    bits[8] = scBits.length & 0xFF; bits[9] = scBits.length >> 8;
    bits.set(scBits, 10);
    let off = 10 + scBits.length;
    for (let fi = 0; fi < 64; fi++) if (planeBufs[fi]) {
        const pb = planeBufs[fi]!;
        const lenField = (pb.length & 0x3FFF) | (planeFlags[fi] << 14);
        bits[off] = lenField & 0xFF; bits[off + 1] = (lenField >> 8) & 0xFF; off += 2;
        bits.set(pb, off); off += pb.length;
    }

    // modeBits: L-predicted mode bytes → Logos-compressed
    const modeBits = encode0D(modes);
    return { bits, modeBits, decLvl: dec, recon: new Uint8Array(recon) };
}

/** Decode one plane encoded with encodeAkashaPlane. */
function decodeAkashaPlane(
    bits: Uint8Array, modeBits: Uint8Array, w: number, h: number, qdct: Float32Array, centre: number,
    cflAlpha?: number, yRecon?: Uint8Array, yW?: number, yH?: number
): Uint8Array {
    const bxN = Math.ceil(w / 8), byN = Math.ceil(h / 8), nB = bxN * byN;

    // Parse bitstream
    const bm = bits.subarray(0, 8);
    const scBitsLen = bits[8] | (bits[9] << 8);
    const scArr = decode0D(bits.subarray(10, 10 + scBitsLen), nB);
    let off = 10 + scBitsLen;

    // Decode cb planes: bits 15:14 = method (0=encode0D, 1=l3dCb, 2=l2dCb).
    // DC (fi=0) always uses l2dCbDecode regardless of method bits.
    const cbMat = new Uint8Array(64 * nB).fill(128);
    const prevCbPlane = new Uint8Array(nB).fill(128);
    for (let fi = 0; fi < 64; fi++) {
        if (!(bm[fi >> 3] & (1 << (fi & 7)))) {
            prevCbPlane.fill(128);
            continue;
        }
        const raw = bits[off] | (bits[off + 1] << 8); off += 2;
        const plen = raw & 0x3FFF;
        const method = (raw >> 14) & 3;
        let cb: Uint8Array;
        if (fi === 0 || method === 2) {
            cb = l2dCbDecode(bits.subarray(off, off + plen), nB, bxN, byN);
        } else if (method === 1) {
            cb = l3dCbDecode(bits.subarray(off, off + plen), prevCbPlane, nB, bxN, byN);
        } else {
            cb = decode0D(bits.subarray(off, off + plen), nB);
        }
        off += plen;
        cbMat.set(cb, fi * nB);
        prevCbPlane.set(cb);
    }

    // Decompress mode array (Logos-encoded raw mode bytes)
    const modeArr = decode0D(modeBits, nB);

    // Spatial pass: identical to encoder's encoding pass
    const plane  = new Uint8Array(w * h);
    const recon  = new Float32Array(w * h).fill(centre);
    const coeff  = new Float32Array(64);
    const res    = new Float32Array(64);

    for (let by = 0; by < byN; by++) {
        for (let bx = 0; bx < bxN; bx++) {
            const bi = by * bxN + bx;
            const px = bx * 8, py = by * 8;
            const mode = modeArr[bi];
            const { lc, tr, tl } = intraRefsN(recon, bx, by, w, h, centre, 8);
            const pred = intraPredN(mode, lc, tr, tl, 8);

            // CfL: same block-constant Y-mean correction as encoder.
            // recon is CfL-free (for intra predictor consistency); plane output includes CfL.
            let cflInt = 0;
            if (cflAlpha && yRecon) {
                let ySum = 0, yN = 0;
                for (let dy = 0; dy < 16 && by*16+dy < yH!; dy++)
                    for (let dx = 0; dx < 16 && bx*16+dx < yW!; dx++) {
                        ySum += yRecon[(by*16+dy)*yW!+(bx*16+dx)]; yN++;
                    }
                cflInt = Math.round(cflAlpha * ((yN>0 ? ySum/yN : 128) - 128));
            }

            // Adaptive quantization: same boundary-derived scale as encoder
            const aq = blockAQ(lc, tr, 8);

            const sc = scArr[bi];
            for (let fi = 0; fi < 64; fi++) coeff[fi] = (cbMat[fi * nB + bi] - 128) * sc * qdct[fi] * aq;
            dct8x8Inv(coeff, 0, res, 0, 8, 0);

            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                const ry = py+y, rx = px+x;
                if (ry < h && rx < w) {
                    const reconVal = Math.max(0, Math.min(255, Math.round(pred[y*8+x] + res[y*8+x] + centre)));
                    // Recon: no CfL (consistent with encoder, used for neighboring blocks)
                    recon[ry*w+rx] = reconVal;
                    // Plane output: add CfL correction back (actual decoded chroma value)
                    plane[ry*w+rx] = Math.max(0, Math.min(255, reconVal + cflInt));
                }
            }
        }
    }
    return plane;
}

/** H.264-style deblocking at 8px and 16px block boundaries.
 *  alpha/beta thresholds derived from dcStep; second pass at MB boundaries is 1.5× stronger. */
function deblockPlane(plane: Uint8Array, w: number, h: number, dcStep: number): void {
    // Thresholds calibrated to H.264 deblocking at equivalent QP
    const alpha = Math.max(2, Math.round(dcStep * 2.0));
    const beta  = Math.max(1, Math.round(dcStep * 0.75));
    // Stronger thresholds for 16-pixel MB boundaries
    const alpha16 = Math.max(3, Math.round(dcStep * 3.0));
    const beta16  = Math.max(2, Math.round(dcStep * 1.0));
    // Even stronger for 32-pixel SMB boundaries (VBS format 0x07)
    const alpha32 = Math.max(4, Math.round(dcStep * 3.5));
    const beta32  = Math.max(2, Math.round(dcStep * 1.25));

    // Helper: apply 4-tap deblock to a single crossing
    const filt = (p1: number, p0: number, q0: number, q1: number, a: number, b: number): [number, number] | null => {
        if (Math.abs(p0-q0) < a && Math.abs(p1-p0) < b && Math.abs(q1-q0) < b) {
            const delta = ((q0-p0)*3 + (p1-q1) + 4) >> 3;
            return [Math.max(0, Math.min(255, p0 + delta)), Math.max(0, Math.min(255, q0 - delta))];
        }
        return null;
    };

    // Horizontal deblocking: block boundary rows at y = 8, 16, 24, ...
    for (let y = 8; y < h - 1; y += 8) {
        const is32 = (y & 31) === 0;
        const is16 = !is32 && (y & 15) === 0;
        const a = is32 ? alpha32 : is16 ? alpha16 : alpha;
        const b = is32 ? beta32  : is16 ? beta16  : beta;
        for (let x = 0; x < w; x++) {
            const res = filt(plane[(y-2)*w+x], plane[(y-1)*w+x], plane[y*w+x], plane[(y+1)*w+x], a, b);
            if (res) { plane[(y-1)*w+x] = res[0]; plane[y*w+x] = res[1]; }
        }
    }
    // Vertical deblocking: block boundary columns at x = 8, 16, 24, ...
    for (let x = 8; x < w - 1; x += 8) {
        const is32 = (x & 31) === 0;
        const is16 = !is32 && (x & 15) === 0;
        const a = is32 ? alpha32 : is16 ? alpha16 : alpha;
        const b = is32 ? beta32  : is16 ? beta16  : beta;
        for (let y = 0; y < h; y++) {
            const res = filt(plane[y*w+(x-2)], plane[y*w+(x-1)], plane[y*w+x], plane[y*w+(x+1)], a, b);
            if (res) { plane[y*w+(x-1)] = res[0]; plane[y*w+x] = res[1]; }
        }
    }
}

/** Helper: encode one freq-plane section (nFreqs planes × nBlocks each).
 *  bitmap (ceil(nFreqs/8)B) + scLen(2B) + scBits + [2B len+data per active plane].
 *  DC (fi=0): l2dCbEncode; AC (fi>0): per-plane best of encode0D / l2dCb / l3dCb.
 *  2-byte length field: bits 15:14 = method (0=encode0D, 1=l3dCb, 2=l2dCb). */
function encodeFreqSection(
    cbMat: Uint8Array, nFreqs: number, nBlocks: number, scArr: Uint8Array, gridW: number, gridH: number
): Uint8Array {
    const bmBytes = Math.ceil(nFreqs / 8);
    const bm = new Uint8Array(bmBytes);
    const bufs: (Uint8Array | null)[] = [];
    const flags = new Uint8Array(nFreqs); // 0=encode0D, 1=l3dCb, 2=l2dCb
    const prevCb = new Uint8Array(nBlocks).fill(128);
    for (let fi = 0; fi < nFreqs; fi++) {
        const cbPlane = cbMat.subarray(fi * nBlocks, (fi + 1) * nBlocks);
        let allMid = true;
        for (let i = 0; i < nBlocks; i++) if (cbPlane[i] !== 128) { allMid = false; break; }
        if (allMid) { bufs.push(null); prevCb.set(cbPlane); continue; }
        bm[fi >> 3] |= 1 << (fi & 7);
        const cbCopy = new Uint8Array(cbPlane);
        if (fi === 0) {
            bufs.push(l2dCbEncode(cbCopy, nBlocks, gridW, gridH));
            flags[fi] = 2; // l2dCb
        } else {
            const enc0  = encode0D(cbCopy);
            const encL2 = l2dCbEncode(cbCopy, nBlocks, gridW, gridH);
            const encL3 = l3dCbEncode(cbCopy, prevCb, nBlocks, gridW, gridH);
            if (encL3.length <= encL2.length && encL3.length <= enc0.length) {
                bufs.push(encL3); flags[fi] = 1; // l3dCb
            } else if (encL2.length < enc0.length) {
                bufs.push(encL2); flags[fi] = 2; // l2dCb
            } else {
                bufs.push(enc0); // flags[fi] = 0 (encode0D)
            }
        }
        prevCb.set(cbPlane);
    }
    // Compress the presence bitmap (especially helpful for 16×16/32×32 sections with 32-128B bitmaps)
    const bmEncoded = encode0D(bm);
    const scBits = encode0D(scArr);
    let total = 2 + bmEncoded.length + 2 + scBits.length;
    for (const pb of bufs) if (pb) total += 2 + pb.length;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer, out.byteOffset);
    dv.setUint16(0, bmEncoded.length, true);
    out.set(bmEncoded, 2);
    let off = 2 + bmEncoded.length;
    dv.setUint16(off, scBits.length, true); off += 2;
    out.set(scBits, off); off += scBits.length;
    for (let fi = 0; fi < nFreqs; fi++) if (bufs[fi]) {
        const pb = bufs[fi]!;
        const lenField = (pb.length & 0x3FFF) | (flags[fi] << 14);
        out[off] = lenField & 0xFF; out[off + 1] = (lenField >> 8) & 0xFF; off += 2;
        out.set(pb, off); off += pb.length;
    }
    return out;
}

/** Helper: decode one freq-plane section. Returns cbMat (nFreqs×nBlocks).
 *  2-byte length field: bits 15:14 = method (0=encode0D, 1=l3dCb, 2=l2dCb). */
function decodeFreqSection(
    data: Uint8Array, nFreqs: number, nBlocks: number, gridW: number, gridH: number
): { cbMat: Uint8Array; scArr: Uint8Array } {
    const bmBytes = Math.ceil(nFreqs / 8);
    const cbMat = new Uint8Array(nFreqs * nBlocks).fill(128);
    // Decode compressed presence bitmap
    const bmEncLen = data[0] | (data[1] << 8);
    const bm = decode0D(data.subarray(2, 2 + bmEncLen), bmBytes);
    let off = 2 + bmEncLen;
    const scBitsLen = data[off] | (data[off + 1] << 8); off += 2;
    const scArr = decode0D(data.subarray(off, off + scBitsLen), nBlocks);
    off += scBitsLen;
    const prevCb = new Uint8Array(nBlocks).fill(128);
    for (let fi = 0; fi < nFreqs; fi++) {
        if (!(bm[fi >> 3] & (1 << (fi & 7)))) {
            prevCb.fill(128); // skipped plane → all 128 for next plane's B prediction
            continue;
        }
        const raw = data[off] | (data[off + 1] << 8); off += 2;
        const plen = raw & 0x3FFF;
        const method = (raw >> 14) & 3;
        let cb: Uint8Array;
        if (fi === 0 || method === 2) {
            cb = l2dCbDecode(data.subarray(off, off + plen), nBlocks, gridW, gridH);
        } else if (method === 1) {
            cb = l3dCbDecode(data.subarray(off, off + plen), prevCb, nBlocks, gridW, gridH);
        } else {
            cb = decode0D(data.subarray(off, off + plen), nBlocks);
        }
        off += plen;
        cbMat.set(cb, fi * nBlocks);
        prevCb.set(cb);
    }
    return { cbMat, scArr };
}

/** Encode Y luma with 3-level variable block size: 8×8 / 16×16 / 32×32.
 *  Outer pass: per-32×32 SMB, compare combined sub-MB error vs 32×32 error.
 *  Inner pass: per-16×16 MB, compare 8×8 vs 16×16 error.
 *  Both decisions use ≥5% improvement threshold with non-trivial error guard. */
function encodeAkashaPlaneVBS(
    plane: Uint8Array, w: number, h: number,
    qdct8: Float32Array, qdct16: Float32Array, qdct32: Float32Array, centre: number
): {
    bits8: Uint8Array; modeBits8: Uint8Array;
    bits16: Uint8Array; modeBits16: Uint8Array;
    bits32: Uint8Array; modeBits32: Uint8Array;
    smbBitmap: Uint8Array; smbW: number; smbH: number; smbModeMap: Uint8Array;
    mbBitmap: Uint8Array; mbW: number; mbH: number;
    recon: Uint8Array;
} {
    const bxN = Math.ceil(w / 8), byN = Math.ceil(h / 8), nB = bxN * byN;
    const mbW = Math.ceil(w / 16), mbH = Math.ceil(h / 16), nMB = mbW * mbH;
    const smbW = Math.ceil(w / 32), smbH = Math.ceil(h / 32), nSMB = smbW * smbH;

    // Storage: all 3 levels. Non-active positions stay at 128 (neutral) → compressed away.
    const modes8   = new Uint8Array(nB);
    const scArr8   = new Uint8Array(nB).fill(1);
    const cbMat8   = new Uint8Array(64 * nB).fill(128);
    const dec8     = new Int16Array(64 * nB);
    const modeArr16 = new Uint8Array(nMB);
    const scArr16  = new Uint8Array(nMB).fill(1);
    const cbMat16  = new Uint8Array(256 * nMB).fill(128);
    const modeArr32 = new Uint8Array(nSMB);
    const scArr32  = new Uint8Array(nSMB).fill(1);
    const cbMat32  = new Uint8Array(1024 * nSMB).fill(128);
    const mbModeMap  = new Uint8Array(nMB);  // 1 = 16×16
    const smbModeMap = new Uint8Array(nSMB); // 1 = 32×32

    const recon   = new Float32Array(w * h).fill(centre);
    const coeff8  = new Float32Array(64);
    const coeff16 = new Float32Array(256);
    const coeff32 = new Float32Array(1024);
    const res8    = new Float32Array(64);
    const res16   = new Float32Array(256);
    const res32   = new Float32Array(1024);
    const lvl8    = new Int16Array(64);
    const lvl16   = new Int16Array(256);
    const lvl32   = new Int16Array(1024);

    // Per-size dispatch tables for unified trial/commit
    const _qdct  = [qdct8, qdct16, qdct32] as const;
    const _res   = [res8, res16, res32] as const;
    const _coeff = [coeff8, coeff16, coeff32] as const;
    const _lvl   = [lvl8, lvl16, lvl32] as const;
    const _fwd   = [dct8x8Fwd, dct16x16Fwd, dct32x32Fwd] as const;
    const _inv   = [dct8x8Inv, dct16x16Inv, dct32x32Inv] as const;
    const _cbMat = [cbMat8, cbMat16, cbMat32] as const;
    const _scArr = [scArr8, scArr16, scArr32] as const;
    const _modes = [modes8, modeArr16, modeArr32] as const;
    const _nBlk  = [nB, nMB, nSMB] as const;
    // Map N → index: 8→0, 16→1, 32→2
    const _idx = (N: number) => N === 8 ? 0 : N === 16 ? 1 : 2;

    /** Compute best-mode quantization error at any block size (does NOT update recon). */
    const trialN = (bx: number, by: number, N: number): { qErr: number; mode: number } => {
        if (N === 8 && (bx >= bxN || by >= byN)) return { qErr: 0, mode: 0 };
        const i = _idx(N), N2 = N * N, px = bx * N, py = by * N;
        const qdctN = _qdct[i], resN = _res[i], coeffN = _coeff[i], fwd = _fwd[i];
        const { lc, tr, tl } = intraRefsN(recon, bx, by, w, h, centre, N);
        const aq = blockAQ(lc, tr, N);
        let best = Infinity, bestMode = 0;
        for (let m = 0; m < 8; m++) {
            const pred = intraPredN(m, lc, tr, tl, N);
            for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                const ry = py+y, rx = px+x;
                resN[y*N+x] = ry < h && rx < w ? (plane[ry*w+rx]-centre) - pred[y*N+x] : 0;
            }
            fwd(resN, 0, N, 0, coeffN);
            let qe = 0;
            for (let fi = 0; fi < N2; fi++) { const lv = dzQuant(coeffN[fi], qdctN[fi] * aq, fi); const e = coeffN[fi] - lv*qdctN[fi]*aq; qe += e*e; }
            if (qe < best) { best = qe; bestMode = m; }
        }
        return { qErr: best, mode: bestMode };
    };

    /** Commit one block at size N: quantize, store coefficients, update recon.
     *  bestMode is searched internally when omitted (8×8 path). */
    const commitN = (bx: number, by: number, N: number, bestMode?: number) => {
        if (N === 8 && (bx >= bxN || by >= byN)) return;
        const i = _idx(N), N2 = N * N, px = bx * N, py = by * N;
        const qdctN = _qdct[i], resN = _res[i], coeffN = _coeff[i], lvlN = _lvl[i];
        const fwd = _fwd[i], inv = _inv[i];
        const cbMatN = _cbMat[i], scArrN = _scArr[i], modesN = _modes[i], nBlk = _nBlk[i];
        const bi = N === 8 ? by*bxN+bx : N === 16 ? by*mbW+bx : by*smbW+bx;
        const { lc, tr, tl } = intraRefsN(recon, bx, by, w, h, centre, N);
        const aq = blockAQ(lc, tr, N);
        if (bestMode === undefined) {
            bestMode = 0; let bestQErr = Infinity;
            for (let m = 0; m < 8; m++) {
                const pred = intraPredN(m, lc, tr, tl, N);
                for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                    const ry = py+y, rx = px+x;
                    resN[y*N+x] = ry < h && rx < w ? (plane[ry*w+rx]-centre) - pred[y*N+x] : 0;
                }
                fwd(resN, 0, N, 0, coeffN);
                let qe = 0;
                for (let fi = 0; fi < N2; fi++) { const lv = dzQuant(coeffN[fi], qdctN[fi] * aq, fi); const e = coeffN[fi] - lv*qdctN[fi]*aq; qe += e*e; }
                if (qe < bestQErr) { bestQErr = qe; bestMode = m; }
            }
        }
        modesN[bi] = bestMode;
        const pred = intraPredN(bestMode, lc, tr, tl, N);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const ry = py+y, rx = px+x;
            resN[y*N+x] = ry < h && rx < w ? (plane[ry*w+rx]-centre) - pred[y*N+x] : 0;
        }
        fwd(resN, 0, N, 0, coeffN);
        for (let fi = 0; fi < N2; fi++) lvlN[fi] = dzQuant(coeffN[fi], qdctN[fi] * aq, fi);
        let maxAbs = 0;
        for (let fi = 0; fi < N2; fi++) { const a = Math.abs(lvlN[fi]); if (a > maxAbs) maxAbs = a; }
        let sc = Math.ceil(maxAbs / 127) || 1;
        if (sc > 1) {
            let dSc = 0, dClip = 0;
            for (let fi = 0; fi < N2; fi++) {
                const q = qdctN[fi] * aq;
                const dec_lv = Math.round(lvlN[fi] / sc) * sc;
                dSc += (lvlN[fi] - dec_lv) * (lvlN[fi] - dec_lv) * q * q;
                const cl = Math.max(-127, Math.min(127, lvlN[fi]));
                dClip += (lvlN[fi] - cl) * (lvlN[fi] - cl) * q * q;
            }
            if (dClip < dSc) { for (let fi = 0; fi < N2; fi++) lvlN[fi] = Math.max(-127, Math.min(127, lvlN[fi])); sc = 1; }
        }
        scArrN[bi] = sc;
        for (let fi = 0; fi < N2; fi++) {
            const cb = Math.round(lvlN[fi]/sc)+128;
            cbMatN[fi*nBlk+bi] = cb;
            const decoded = (cb-128)*sc;
            if (N === 8) dec8[fi*nB+bi] = decoded;
            coeffN[fi] = decoded * qdctN[fi] * aq;
        }
        inv(coeffN, 0, resN, 0, N, 0);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const ry = py+y, rx = px+x;
            if (ry < h && rx < w) recon[ry*w+rx] = Math.max(0, Math.min(255, Math.round(pred[y*N+x]+resN[y*N+x]+centre)));
        }
    };

    // ── Main loop: SMB-outer, MB-inner ───────────────────────────────────────
    for (let smby = 0; smby < smbH; smby++) {
        for (let smbx = 0; smbx < smbW; smbx++) {
            const smbi = smby * smbW + smbx;

            // Trial: combined error of up to 4 constituent MBs (8×8 or 16×16)
            let totalQErrSub = 0;
            for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
                const mbx = smbx*2+sx, mby = smby*2+sy;
                if (mbx >= mbW || mby >= mbH) continue;
                const qErr8mb = trialN(mbx*2, mby*2, 8).qErr + trialN(mbx*2+1, mby*2, 8).qErr +
                                trialN(mbx*2, mby*2+1, 8).qErr + trialN(mbx*2+1, mby*2+1, 8).qErr;
                const { qErr: qErr16mb } = trialN(mbx, mby, 16);
                // 16×16 wins over 8×8 for this trial MB if clearly better
                const subErr = (qErr16mb < qErr8mb * 0.95 && qErr8mb > 8) ? qErr16mb : qErr8mb;
                totalQErrSub += subErr;
            }

            // Trial: 32×32 single block
            const { qErr: qErr32, mode: best32Mode } = trialN(smbx, smby, 32);

            // 32×32 wins if ≥15% better than combined sub-MB errors AND sub has non-trivial error
            const use32 = qErr32 < totalQErrSub * 0.85 && totalQErrSub > 32;
            smbModeMap[smbi] = use32 ? 1 : 0;

            if (use32) {
                commitN(smbx, smby, 32, best32Mode);
            } else {
                // Process 4 constituent MBs (same 8×8 vs 16×16 decision as before)
                for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
                    const mbx = smbx*2+sx, mby = smby*2+sy;
                    if (mbx >= mbW || mby >= mbH) continue;
                    const mbi = mby*mbW + mbx;
                    const { qErr: qErr16mb, mode: best16Mode } = trialN(mbx, mby, 16);
                    const qErr8mb = trialN(mbx*2, mby*2, 8).qErr + trialN(mbx*2+1, mby*2, 8).qErr +
                                   trialN(mbx*2, mby*2+1, 8).qErr + trialN(mbx*2+1, mby*2+1, 8).qErr;
                    const use16 = qErr16mb < qErr8mb * 0.95 && qErr8mb > 8;
                    mbModeMap[mbi] = use16 ? 1 : 0;
                    if (use16) {
                        commitN(mbx, mby, 16, best16Mode);
                    } else {
                        commitN(mbx*2, mby*2, 8); commitN(mbx*2+1, mby*2, 8);
                        commitN(mbx*2, mby*2+1, 8); commitN(mbx*2+1, mby*2+1, 8);
                    }
                }
            }
        }
    }

    // ── Entropy encode all 3 sections ────────────────────────────────────────
    const bits8  = encodeFreqSection(cbMat8,  64,   nB,  scArr8,  bxN, byN);
    const bits16 = encodeFreqSection(cbMat16, 256,  nMB, scArr16, mbW, mbH);
    const bits32 = encodeFreqSection(cbMat32, 1024, nSMB, scArr32, smbW, smbH);

    // SMB bitmap — omitted (empty) if no SMBs chose 32×32 (saves ~163B overhead)
    const any32 = smbModeMap.some(v => v !== 0);
    const smbBitmap = any32 ? (() => {
        const bm = new Uint8Array(Math.ceil(nSMB / 8));
        for (let i = 0; i < nSMB; i++) if (smbModeMap[i]) bm[i >> 3] |= 1 << (i & 7);
        return bm;
    })() : new Uint8Array(0);

    // MB bitmap (1 bit per MB)
    const mbBitmapLen = Math.ceil(nMB / 8);
    const mbBitmap = new Uint8Array(mbBitmapLen);
    for (let mbi = 0; mbi < nMB; mbi++) if (mbModeMap[mbi]) mbBitmap[mbi >> 3] |= 1 << (mbi & 7);

    return {
        bits8,  modeBits8:  encode0D(modes8),
        bits16, modeBits16: encode0D(modeArr16),
        bits32: any32 ? bits32 : new Uint8Array(0),
        modeBits32: any32 ? encode0D(modeArr32) : new Uint8Array(0),
        smbBitmap, smbW, smbH, smbModeMap,
        mbBitmap,  mbW,  mbH,
        recon: new Uint8Array(recon),
    };
}

/** Decode Y plane encoded with encodeAkashaPlaneVBS (format 0x07: 8×8/16×16/32×32). */
function decodeAkashaPlaneVBS(
    bits8: Uint8Array, modeBits8: Uint8Array,
    bits16: Uint8Array, modeBits16: Uint8Array,
    bits32: Uint8Array, modeBits32: Uint8Array,
    smbBitmap: Uint8Array, smbW: number, smbH: number,
    mbBitmap: Uint8Array, mbW: number, mbH: number,
    w: number, h: number,
    qdct8: Float32Array, qdct16: Float32Array, qdct32: Float32Array, centre: number
): Uint8Array {
    const bxN = Math.ceil(w / 8), byN = Math.ceil(h / 8), nB = bxN * byN;
    const nMB = mbW * mbH;
    const nSMB = smbW * smbH;

    // Decode all 3 sections using the helper
    const { cbMat: cbMat8,  scArr: scArr8  } = decodeFreqSection(bits8,  64,   nB,   bxN, byN);
    const { cbMat: cbMat16, scArr: scArr16 } = decodeFreqSection(bits16, 256,  nMB,  mbW, mbH);
    // 32×32 section is omitted (empty) when no SMBs chose 32×32 (smbBitmap.length===0)
    const any32 = smbBitmap.length > 0;
    // cbMat32/scArr32/modes32 only allocated when any32 — avoid 256KB dummy allocation
    const dec32 = any32 ? decodeFreqSection(bits32, 1024, nSMB, smbW, smbH) : null;
    const cbMat32 = dec32?.cbMat ?? null;
    const scArr32 = dec32?.scArr ?? null;
    const modes8   = decode0D(modeBits8,  nB);
    const modes16  = decode0D(modeBits16, nMB);
    const modes32  = any32 ? decode0D(modeBits32, nSMB) : null;

    // Mode maps
    const smbModeMap = new Uint8Array(nSMB);
    if (any32) for (let i = 0; i < nSMB; i++) if (smbBitmap[i >> 3] & (1 << (i & 7))) smbModeMap[i] = 1;
    const mbModeMap = new Uint8Array(nMB);
    for (let i = 0; i < nMB; i++) if (mbBitmap[i >> 3] & (1 << (i & 7))) mbModeMap[i] = 1;

    // Spatial decode — SMB raster order mirrors encoder
    const plane = new Uint8Array(w * h);
    const recon = new Float32Array(w * h).fill(centre);
    const coeff8  = new Float32Array(64);
    const coeff16 = new Float32Array(256);
    const coeff32 = new Float32Array(1024);
    const res8  = new Float32Array(64);
    const res16 = new Float32Array(256);
    const res32 = new Float32Array(1024);

    for (let smby = 0; smby < smbH; smby++) {
        for (let smbx = 0; smbx < smbW; smbx++) {
            const smbi = smby * smbW + smbx;
            const spx = smbx * 32, spy = smby * 32;

            if (smbModeMap[smbi] && cbMat32 && scArr32 && modes32) {
                // ─── 32×32 block ─────────────────────────────────────────────
                const { lc, tr, tl } = intraRefsN(recon, smbx, smby, w, h, centre, 32);
                const aq32 = blockAQ(lc, tr, 32);
                const pred32 = intraPredN(modes32[smbi], lc, tr, tl, 32);
                const sc32 = scArr32[smbi] || 1;
                for (let fi = 0; fi < 1024; fi++)
                    coeff32[fi] = (cbMat32[fi*nSMB+smbi] - 128) * sc32 * qdct32[fi] * aq32;
                dct32x32Inv(coeff32, 0, res32, 0, 32, 0);
                for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
                    const ry = spy+y, rx = spx+x;
                    if (ry < h && rx < w) {
                        const v = Math.max(0, Math.min(255, Math.round(pred32[y*32+x] + res32[y*32+x] + centre)));
                        recon[ry*w+rx] = v; plane[ry*w+rx] = v;
                    }
                }
            } else {
                // ─── 4 constituent MBs ───────────────────────────────────────
                for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
                    const mbx = smbx*2+sx, mby = smby*2+sy;
                    if (mbx >= mbW || mby >= mbH) continue;
                    const mbi = mby*mbW+mbx, mpx = mbx*16, mpy = mby*16;

                    if (mbModeMap[mbi]) {
                        // ─── 16×16 block ─────────────────────────────────────
                        const { lc, tr, tl } = intraRefsN(recon, mbx, mby, w, h, centre, 16);
                        const aq16 = blockAQ(lc, tr, 16);
                        const pred16 = intraPredN(modes16[mbi], lc, tr, tl, 16);
                        const sc16 = scArr16[mbi] || 1;
                        for (let fi = 0; fi < 256; fi++)
                            coeff16[fi] = (cbMat16[fi*nMB+mbi] - 128) * sc16 * qdct16[fi] * aq16;
                        dct16x16Inv(coeff16, 0, res16, 0, 16, 0);
                        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
                            const ry = mpy+y, rx = mpx+x;
                            if (ry < h && rx < w) {
                                const v = Math.max(0, Math.min(255, Math.round(pred16[y*16+x]+res16[y*16+x]+centre)));
                                recon[ry*w+rx] = v; plane[ry*w+rx] = v;
                            }
                        }
                    } else {
                        // ─── 4 × 8×8 blocks ──────────────────────────────────
                        for (let sy2 = 0; sy2 < 2; sy2++) for (let sx2 = 0; sx2 < 2; sx2++) {
                            const bx = mbx*2+sx2, by = mby*2+sy2;
                            if (bx >= bxN || by >= byN) continue;
                            const bi = by*bxN+bx, px = bx*8, py = by*8;
                            const { lc, tr, tl } = intraRefsN(recon, bx, by, w, h, centre, 8);
                            const aq8 = blockAQ(lc, tr, 8);
                            const pred = intraPredN(modes8[bi], lc, tr, tl, 8);
                            const sc8 = scArr8[bi] || 1;
                            for (let fi = 0; fi < 64; fi++)
                                coeff8[fi] = (cbMat8[fi*nB+bi] - 128) * sc8 * qdct8[fi] * aq8;
                            dct8x8Inv(coeff8, 0, res8, 0, 8, 0);
                            for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
                                const ry = py+y, rx = px+x;
                                if (ry < h && rx < w) {
                                    const v = Math.max(0, Math.min(255, Math.round(pred[y*8+x]+res8[y*8+x]+centre)));
                                    recon[ry*w+rx] = v; plane[ry*w+rx] = v;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return plane;
}
function encodeAkasha4DUV(
    uvPlane: Uint8Array, uvW: number, uvH: number,
    yRecon: Uint8Array, yW: number, yH: number,
    qdct: Float32Array
): { bits: Uint8Array; modeBits: Uint8Array } {
    const alpha = cflGlobalAlpha(uvPlane, uvW, uvH, yRecon, yW, yH);
    const alphaInt = Math.round(alpha * 64); // store as int8, scale=1/64
    const { bits: planeBits, modeBits } = encodeAkashaPlane(
        uvPlane, uvW, uvH, qdct, 128, alpha, yRecon, yW, yH
    );
    // Prepend 1-byte quantized alpha to bits payload
    const bits = new Uint8Array(1 + planeBits.length);
    bits[0] = alphaInt & 0xFF; // int8 stored as uint8
    bits.set(planeBits, 1);
    return { bits, modeBits };
}

function decodeAkasha4DUV(
    bits: Uint8Array, modeBits: Uint8Array, uvW: number, uvH: number,
    yRecon: Uint8Array, yW: number, yH: number, qdct: Float32Array
): Uint8Array {
    // Read quantized alpha (int8) from first byte
    const alphaInt = bits[0] << 24 >> 24; // sign-extend uint8 → int8
    const alpha = alphaInt / 64;
    return decodeAkashaPlane(bits.subarray(1), modeBits, uvW, uvH, qdct, 128, alpha, yRecon, yW, yH);
}

/** Pack Akasha VBS frame (format 0x07 I-frame, 0x08 P-frame). Y plane: 3-level VBS (8×8/16×16/32×32); UV: 8×8 only.
 *  Wire layout:
 *  [0x07][2B bxN8][2B byN8]
 *  [2B smbW][2B smbH][2B smbBmLen][smbBitmap]
 *  [2B mbW][2B mbH][2B mbBmLen][mbBitmap]
 *  [4B yMod8Len][yMod8][4B yBits8Len][yBits8]
 *  [4B yMod16Len][yMod16][4B yBits16Len][yBits16]
 *  [4B yMod32Len][yMod32][4B yBits32Len][yBits32]
 *  [4B uModLen][uMod][4B uBitsLen][uBits]
 *  [4B vModLen][vMod][4B vBitsLen][vBits] */
function packAkashaVBS(
    yMod8: Uint8Array, yBits8: Uint8Array,
    yMod16: Uint8Array, yBits16: Uint8Array,
    yMod32: Uint8Array, yBits32: Uint8Array,
    smbBitmap: Uint8Array, smbW: number, smbH: number,
    mbBitmap: Uint8Array, mbW: number, mbH: number,
    uBits: Uint8Array, uMod: Uint8Array,
    vBits: Uint8Array, vMod: Uint8Array,
    bxN8: number, byN8: number,
    fmt: number = 0x07
): Uint8Array {
    const smbBmLen = smbBitmap.length;
    // Compress mbBitmap with encode0D (saves ~30-80B for 512×512 images)
    const mbBmEnc = encode0D(mbBitmap);
    const totalLen = 1 + 4    // fmt + bxN8,byN8
        + 6 + smbBmLen        // smbW,smbH,smbBmLen,smbBitmap
        + 6 + mbBmEnc.length  // mbW,mbH,mbBmEncLen,mbBitmapEncoded
        + (4+yMod8.length) + (4+yBits8.length)
        + (4+yMod16.length) + (4+yBits16.length)
        + (4+yMod32.length) + (4+yBits32.length)
        + (4+uMod.length) + (4+uBits.length)
        + (4+vMod.length) + (4+vBits.length);
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);
    out[0] = fmt; let off = 1;
    dv.setUint16(off, bxN8, true); off += 2;
    dv.setUint16(off, byN8, true); off += 2;
    dv.setUint16(off, smbW, true);   off += 2;
    dv.setUint16(off, smbH, true);   off += 2;
    dv.setUint16(off, smbBmLen, true); off += 2;
    out.set(smbBitmap, off); off += smbBmLen;
    dv.setUint16(off, mbW, true);    off += 2;
    dv.setUint16(off, mbH, true);    off += 2;
    dv.setUint16(off, mbBmEnc.length, true); off += 2;
    out.set(mbBmEnc, off); off += mbBmEnc.length;
    const write = (mod: Uint8Array, bts: Uint8Array) => {
        dv.setUint32(off, mod.length, true); off += 4; out.set(mod, off); off += mod.length;
        dv.setUint32(off, bts.length, true); off += 4; out.set(bts, off); off += bts.length;
    };
    write(yMod8, yBits8); write(yMod16, yBits16); write(yMod32, yBits32);
    write(uMod, uBits); write(vMod, vBits);
    return out;
}

function unpackAkashaVBS(data: Uint8Array): {
    bxN8: number; byN8: number;
    smbW: number; smbH: number; smbBitmap: Uint8Array;
    mbW: number;  mbH: number;  mbBitmap: Uint8Array;
    yMod8: Uint8Array; yBits8: Uint8Array;
    yMod16: Uint8Array; yBits16: Uint8Array;
    yMod32: Uint8Array; yBits32: Uint8Array;
    uMod: Uint8Array; uBits: Uint8Array;
    vMod: Uint8Array; vBits: Uint8Array;
} | null {
    if ((data[0] !== 0x07 && data[0] !== 0x08) || data.length < 13) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const bxN8 = dv.getUint16(1, true), byN8 = dv.getUint16(3, true);
    let off = 5;
    const smbW = dv.getUint16(off, true); off += 2;
    const smbH = dv.getUint16(off, true); off += 2;
    const smbBmLen = dv.getUint16(off, true); off += 2;
    const smbBitmap = data.subarray(off, off + smbBmLen); off += smbBmLen;
    const mbW = dv.getUint16(off, true); off += 2;
    const mbH = dv.getUint16(off, true); off += 2;
    const mbBmEncLen = dv.getUint16(off, true); off += 2;
    // mbBitmap is encode0D-compressed; decode back to raw bits
    const mbBitmapBytes = Math.ceil(mbW * mbH / 8);
    const mbBitmap = decode0D(data.subarray(off, off + mbBmEncLen), mbBitmapBytes); off += mbBmEncLen;
    const read = (): [Uint8Array, Uint8Array] => {
        const mlen = dv.getUint32(off, true); off += 4;
        const mod = data.subarray(off, off + mlen); off += mlen;
        const blen = dv.getUint32(off, true); off += 4;
        const bts = data.subarray(off, off + blen); off += blen;
        return [mod, bts];
    };
    const [yMod8, yBits8] = read();
    const [yMod16, yBits16] = read();
    const [yMod32, yBits32] = read();
    const [uMod, uBits] = read();
    const [vMod, vBits] = read();
    return { bxN8, byN8, smbW, smbH, smbBitmap, mbW, mbH, mbBitmap,
             yMod8, yBits8, yMod16, yBits16, yMod32, yBits32, uMod, uBits, vMod, vBits };
}


export interface VideoCodecConfig {
    quality: number;          // 1-100, default 80
    keyFrameInterval: number; // frames between forced I-frames, default 30
}

const DEFAULT_CONFIG: VideoCodecConfig = {
    quality: 100,
    keyFrameInterval: 30,
};

export class VideoCodec {
    public wasm: VideoWasmExports | null = null;
    private config: VideoCodecConfig = { ...DEFAULT_CONFIG };
    // Compression state (encoder side)
    private prevFrame: Uint8Array | null = null;
    private framesSinceKey = 0;
    private lastIframeSize = 0;
    // Decompression state (decoder side)
    private prevDecFrame: Uint8Array | null = null;

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
        const { quality, keyFrameInterval } = this.config;
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;

        const yuv = rgbaToYuv420(pixels, w, h);
        const isKeyframe = !this.prevFrame || this.framesSinceKey >= keyFrameInterval;

        pqForward(yuv, 0, ySize);

        if (isKeyframe) {
            return this.encodeIframe(yuv, w, h, ySize, uvW, uvH, uvSize, yuvSize, quality);
        } else {
            // P-frame: delta → Akasha VBS encode (format 0x08)
            const delta = computeDelta(yuv, this.prevFrame!);
            const result = this.encodePframe(delta, w, h, ySize, uvW, uvH, uvSize, yuvSize, quality);

            // scene-change: if P-frame exceeds last I-frame size, redo as I-frame
            const iframeRef = this.lastIframeSize || Math.round(yuvSize * 0.15);
            if (result.payload.length > iframeRef) {
                return this.encodeIframe(yuv, w, h, ySize, uvW, uvH, uvSize, yuvSize, quality);
            }
            return result;
        }
    }

    /** Encode an I-frame using format 0x07 (Akasha VBS). Shared by keyframe and scene-change paths. */
    private encodeIframe(
        yuv: Uint8Array, w: number, h: number,
        ySize: number, uvW: number, uvH: number, uvSize: number, yuvSize: number,
        quality: number
    ): { payload: Uint8Array; flags: number } {
        const qdctY   = makeQdct(_QDCT_LUMA_BASE,   quality);
        const qdctUV  = makeQdct(_QDCT_CHROMA_BASE, quality);
        const qdctY16 = makeQdctN(_QDCT_LUMA_BASE, quality, 16);
        const qdctY32 = makeQdctN(_QDCT_LUMA_BASE, quality, 32);
        const bxNY = Math.ceil(w / 8), byNY = Math.ceil(h / 8);

        const yVBS = encodeAkashaPlaneVBS(yuv.subarray(0, ySize), w, h, qdctY, qdctY16, qdctY32, 128);
        const uEnc = encodeAkasha4DUV(yuv.subarray(ySize, ySize+uvSize), uvW, uvH, yVBS.recon, w, h, qdctUV);
        const vEnc = encodeAkasha4DUV(yuv.subarray(ySize+uvSize),        uvW, uvH, yVBS.recon, w, h, qdctUV);

        const uRec = decodeAkasha4DUV(uEnc.bits, uEnc.modeBits, uvW, uvH, yVBS.recon, w, h, qdctUV);
        const vRec = decodeAkasha4DUV(vEnc.bits, vEnc.modeBits, uvW, uvH, yVBS.recon, w, h, qdctUV);
        // store raw recon as P-frame reference (deblocking would inject noise into deltas)
        this.prevFrame = new Uint8Array(yuvSize);
        this.prevFrame.set(yVBS.recon); this.prevFrame.set(uRec, ySize); this.prevFrame.set(vRec, ySize+uvSize);
        this.framesSinceKey = 1;

        const payload = packAkashaVBS(
            yVBS.modeBits8, yVBS.bits8, yVBS.modeBits16, yVBS.bits16,
            yVBS.modeBits32, yVBS.bits32,
            yVBS.smbBitmap, yVBS.smbW, yVBS.smbH,
            yVBS.mbBitmap,  yVBS.mbW,  yVBS.mbH,
            uEnc.bits, uEnc.modeBits, vEnc.bits, vEnc.modeBits,
            bxNY, byNY
        );
        this.lastIframeSize = payload.length;
        return { payload, flags: encodeFlags(true, true, quality) };
    }

    /** Encode a P-frame using format 0x08 (Akasha VBS on delta, no CfL, no deblocking). */
    private encodePframe(
        delta: Uint8Array, w: number, h: number,
        ySize: number, uvW: number, uvH: number, uvSize: number, yuvSize: number,
        quality: number
    ): { payload: Uint8Array; flags: number } {
        const qdctY   = makeQdct(_QDCT_LUMA_BASE,   quality);
        const qdctUV  = makeQdct(_QDCT_CHROMA_BASE, quality);
        const qdctY16 = makeQdctN(_QDCT_LUMA_BASE, quality, 16);
        const qdctY32 = makeQdctN(_QDCT_LUMA_BASE, quality, 32);
        const bxNY = Math.ceil(w / 8), byNY = Math.ceil(h / 8);

        // zero out 8x8 blocks where all deltas are below threshold (saves bits)
        const dThresh = Math.max(2, Math.round(qdctY[0] * 0.5));
        const bxN = Math.ceil(w / 8), byN = Math.ceil(h / 8);
        for (let by = 0; by < byN; by++) for (let bx = 0; bx < bxN; bx++) {
            let maxD = 0;
            for (let dy = 0; dy < 8 && by*8+dy < h; dy++)
                for (let dx = 0; dx < 8 && bx*8+dx < w; dx++) {
                    const d = delta[(by*8+dy)*w + bx*8+dx];
                    const sd = d > 128 ? 256 - d : d; // signed magnitude
                    if (sd > maxD) maxD = sd;
                }
            if (maxD <= dThresh) {
                for (let dy = 0; dy < 8 && by*8+dy < h; dy++)
                    for (let dx = 0; dx < 8 && bx*8+dx < w; dx++)
                        delta[(by*8+dy)*w + bx*8+dx] = 0;
            }
        }
        // same for UV planes
        const uvBxN = Math.ceil(uvW / 8), uvByN = Math.ceil(uvH / 8);
        const uvThresh = Math.max(2, Math.round(qdctUV[0] * 0.5));
        for (let ch = 0; ch < 2; ch++) {
            const off = ySize + ch * uvSize;
            for (let by = 0; by < uvByN; by++) for (let bx = 0; bx < uvBxN; bx++) {
                let maxD = 0;
                for (let dy = 0; dy < 8 && by*8+dy < uvH; dy++)
                    for (let dx = 0; dx < 8 && bx*8+dx < uvW; dx++) {
                        const d = delta[off + (by*8+dy)*uvW + bx*8+dx];
                        const sd = d > 128 ? 256 - d : d;
                        if (sd > maxD) maxD = sd;
                    }
                if (maxD <= uvThresh) {
                    for (let dy = 0; dy < 8 && by*8+dy < uvH; dy++)
                        for (let dx = 0; dx < 8 && bx*8+dx < uvW; dx++)
                            delta[off + (by*8+dy)*uvW + bx*8+dx] = 0;
                }
            }
        }

        // encode delta planes through VBS with centre=0 (deltas cluster around 0)
        const yVBS = encodeAkashaPlaneVBS(delta.subarray(0, ySize), w, h, qdctY, qdctY16, qdctY32, 0);
        const uEnc = encodeAkashaPlane(delta.subarray(ySize, ySize+uvSize), uvW, uvH, qdctUV, 0);
        const vEnc = encodeAkashaPlane(delta.subarray(ySize+uvSize),        uvW, uvH, qdctUV, 0);

        // reconstruct lossy delta for prevFrame tracking (no deblocking on deltas)
        const uRec = decodeAkashaPlane(uEnc.bits, uEnc.modeBits, uvW, uvH, qdctUV, 0);
        const vRec = decodeAkashaPlane(vEnc.bits, vEnc.modeBits, uvW, uvH, qdctUV, 0);
        const lossyDelta = new Uint8Array(yuvSize);
        lossyDelta.set(yVBS.recon, 0);
        lossyDelta.set(uRec, ySize);
        lossyDelta.set(vRec, ySize + uvSize);
        this.prevFrame = applyDelta(lossyDelta, this.prevFrame!);
        this.framesSinceKey++;

        const payload = packAkashaVBS(
            yVBS.modeBits8, yVBS.bits8, yVBS.modeBits16, yVBS.bits16,
            yVBS.modeBits32, yVBS.bits32,
            yVBS.smbBitmap, yVBS.smbW, yVBS.smbH,
            yVBS.mbBitmap,  yVBS.mbW,  yVBS.mbH,
            uEnc.bits, uEnc.modeBits, vEnc.bits, vEnc.modeBits,
            bxNY, byNY, 0x08
        );
        return { payload, flags: encodeFlags(true, false, quality) };
    }

    private decompressFrame(decrypted: Uint8Array, w: number, h: number, flags: number): Uint8Array {
        const { keyframe, quality } = decodeFlags(flags);
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;
        const qdctY   = makeQdct(_QDCT_LUMA_BASE,   quality);
        const qdctUV  = makeQdct(_QDCT_CHROMA_BASE, quality);
        const qdctY16 = makeQdctN(_QDCT_LUMA_BASE, quality, 16);
        const qdctY32 = makeQdctN(_QDCT_LUMA_BASE, quality, 32);

        const vbs = unpackAkashaVBS(decrypted);
        if (!vbs) return yuv420ToRgba(this.prevDecFrame || new Uint8Array(yuvSize), w, h);

        if (keyframe) {
            // Format 0x07: Akasha VBS I-frame
            const yPlane = decodeAkashaPlaneVBS(
                vbs.yBits8,  vbs.yMod8,  vbs.yBits16, vbs.yMod16,
                vbs.yBits32, vbs.yMod32,
                vbs.smbBitmap, vbs.smbW, vbs.smbH,
                vbs.mbBitmap,  vbs.mbW,  vbs.mbH,
                w, h, qdctY, qdctY16, qdctY32, 128
            );
            const uPlane = decodeAkasha4DUV(vbs.uBits, vbs.uMod, uvW, uvH, yPlane, w, h, qdctUV);
            const vPlane = decodeAkasha4DUV(vbs.vBits, vbs.vMod, uvW, uvH, yPlane, w, h, qdctUV);
            // raw recon as P-frame reference (before deblocking)
            this.prevDecFrame = new Uint8Array(yuvSize);
            this.prevDecFrame.set(yPlane); this.prevDecFrame.set(uPlane, ySize); this.prevDecFrame.set(vPlane, ySize+uvSize);
            deblockPlane(yPlane, w,   h,   qdctY[0]);
            deblockPlane(uPlane, uvW, uvH, qdctUV[0]);
            deblockPlane(vPlane, uvW, uvH, qdctUV[0]);
            const yuv = new Uint8Array(yuvSize);
            yuv.set(yPlane); yuv.set(uPlane, ySize); yuv.set(vPlane, ySize+uvSize);
            pqInverse(yuv, 0, ySize);
            return yuv420ToRgba(yuv, w, h);
        } else {
            // Format 0x08: Akasha VBS P-frame (delta)
            const yDelta = decodeAkashaPlaneVBS(
                vbs.yBits8,  vbs.yMod8,  vbs.yBits16, vbs.yMod16,
                vbs.yBits32, vbs.yMod32,
                vbs.smbBitmap, vbs.smbW, vbs.smbH,
                vbs.mbBitmap,  vbs.mbW,  vbs.mbH,
                w, h, qdctY, qdctY16, qdctY32, 0
            );
            const uDelta = decodeAkashaPlane(vbs.uBits, vbs.uMod, uvW, uvH, qdctUV, 0);
            const vDelta = decodeAkashaPlane(vbs.vBits, vbs.vMod, uvW, uvH, qdctUV, 0);
            const fullDelta = new Uint8Array(yuvSize);
            fullDelta.set(yDelta); fullDelta.set(uDelta, ySize); fullDelta.set(vDelta, ySize + uvSize);
            const base = this.prevDecFrame || new Uint8Array(yuvSize);
            const yuv = applyDelta(fullDelta, base);
            this.prevDecFrame = new Uint8Array(yuv);
            pqInverse(yuv, 0, ySize);
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
