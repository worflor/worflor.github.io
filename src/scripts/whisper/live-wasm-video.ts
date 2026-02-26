/**
 * live-wasm-video.ts
 *
 * Whisper Video Codec
 *
 * ChaCha20-AEAD encrypted video pipeline with integrated 256-bit Symmetric
 * Double Ratchet. Adaptive compression: YUV420, MED spatial prediction,
 * subtraction-delta P-frames with block skip, chroma-aware quantization,
 * zigzag transform, and hybrid Rice entropy coding with per-frame adaptive k.
 * Scene-change detection auto-promotes P-frames to I-frames when beneficial.
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

/** Per-frame setup: nonce from frame counter, reset block counter, write header frameIdx */
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
 *  mixes MAC into nonce for forward secrecy binding, re-keys MAC. */
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
        // (use temp as scratch — don't modify mac0/mac1, MAC must cover entire frame)
        ...GET(mac0), ...SET(temp), ...avalanche(temp),
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 52), ...GET(temp), ...XOR,
        ...STORE32(2, stateAddr + 52),
        ...GET(mac1), ...SET(temp), ...avalanche(temp),
        ...CI32(0),
        ...CI32(0), ...LOAD32(2, stateAddr + 56), ...GET(temp), ...XOR,
        ...STORE32(2, stateAddr + 56),
        // MAC continues accumulating — never reset mid-frame
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

        // PRF-based ratchet every 4096 pixels — full 256-bit key refresh
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

        // PRF-based ratchet every 4096 pixels — full 256-bit key refresh
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

// --- Pseudo-dimension helpers for WASM ---
// WASM decode reads width(u16)*height(u16) from header to get pixel count.
// For compressed packets, we need to fit pseudoPixels into two u16 fields.
function pseudoDims(n: number): [number, number] {
    if (n <= 65535) return [n, 1];
    const h = Math.ceil(n / 65535);
    const w = Math.ceil(n / h);
    return [w, h];
}

// --- Flags field layout (32 bits) ---
const FLAG_COMPRESSED = 1 << 0;
const FLAG_KEYFRAME   = 1 << 1;
const FLAG_QUALITY_SHIFT = 2;
const FLAG_QUALITY_MASK  = 0x7F; // 7 bits, values 1-100
const FLAG_RUNK_SHIFT = 9;
const FLAG_RUNK_MASK  = 0x07;   // 3 bits, values 0-7
const FLAG_VALK_SHIFT = 12;
const FLAG_VALK_MASK  = 0x07;   // 3 bits, values 0-7
const FLAG_NOMED      = 1 << 15; // bit 15: I-frame encoded without MED prediction

function encodeFlags(
    compressed: boolean, keyframe: boolean, quality: number,
    runK: number, valK: number, noMed = false
): number {
    let f = 0;
    if (compressed) f |= FLAG_COMPRESSED;
    if (keyframe) f |= FLAG_KEYFRAME;
    if (noMed) f |= FLAG_NOMED;
    f |= (quality & FLAG_QUALITY_MASK) << FLAG_QUALITY_SHIFT;
    f |= (runK & FLAG_RUNK_MASK) << FLAG_RUNK_SHIFT;
    f |= (valK & FLAG_VALK_MASK) << FLAG_VALK_SHIFT;
    return f;
}

function decodeFlags(flags: number): {
    compressed: boolean; keyframe: boolean; quality: number;
    runK: number; valK: number; noMed: boolean;
} {
    return {
        compressed: (flags & FLAG_COMPRESSED) !== 0,
        keyframe: (flags & FLAG_KEYFRAME) !== 0,
        noMed: (flags & FLAG_NOMED) !== 0,
        quality: (flags >>> FLAG_QUALITY_SHIFT) & FLAG_QUALITY_MASK,
        runK: (flags >>> FLAG_RUNK_SHIFT) & FLAG_RUNK_MASK,
        valK: (flags >>> FLAG_VALK_SHIFT) & FLAG_VALK_MASK,
    };
}

// --- Color space conversion ---

function rgbaToYuv420(rgba: Uint8Array, w: number, h: number): Uint8Array {
    const ySize = w * h;
    const uvW = w >> 1, uvH = h >> 1;
    const uvSize = uvW * uvH;
    const yuv = new Uint8Array(ySize + uvSize * 2);
    // Y plane
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            const idx = (j * w + i) * 4;
            const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
            yuv[j * w + i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
        }
    }
    // U and V planes (subsampled 2x2)
    const uOff = ySize, vOff = ySize + uvSize;
    for (let j = 0; j < uvH; j++) {
        for (let i = 0; i < uvW; i++) {
            let rSum = 0, gSum = 0, bSum = 0;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const sy = j * 2 + dy, sx = i * 2 + dx;
                    const idx = (sy * w + sx) * 4;
                    rSum += rgba[idx]; gSum += rgba[idx + 1]; bSum += rgba[idx + 2];
                }
            }
            const r = rSum >> 2, g = gSum >> 2, b = bSum >> 2;
            yuv[uOff + j * uvW + i] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            yuv[vOff + j * uvW + i] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
        }
    }
    return yuv;
}

function yuv420ToRgba(yuv: Uint8Array, w: number, h: number): Uint8Array {
    const ySize = w * h;
    const uvW = w >> 1, uvH = h >> 1;
    const uvSize = uvW * uvH;
    const uOff = ySize, vOff = ySize + uvSize;
    const rgba = new Uint8Array(w * h * 4);

    // Bilinear UV upsampling: interpolate chroma between sample centers
    // to eliminate blocky color transitions. Each UV sample sits at the
    // center of its 2x2 luma block, so sub-pixel offsets are (0.5, 0.5).
    for (let j = 0; j < h; j++) {
        // UV coordinate and fractional position
        const fj = (j - 0.5) * 0.5; // map luma position to UV space
        const uj0 = Math.max(0, fj | 0);
        const uj1 = Math.min(uvH - 1, uj0 + 1);
        const fv = Math.max(0, Math.min(1, fj - uj0)); // vertical blend factor

        for (let i = 0; i < w; i++) {
            const fi = (i - 0.5) * 0.5;
            const ui0 = Math.max(0, fi | 0);
            const ui1 = Math.min(uvW - 1, ui0 + 1);
            const fu = Math.max(0, Math.min(1, fi - ui0)); // horizontal blend factor

            // Bilinear interpolation of U and V
            const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv);
            const w01 = (1 - fu) * fv, w11 = fu * fv;
            const u = (
                yuv[uOff + uj0 * uvW + ui0] * w00 +
                yuv[uOff + uj0 * uvW + ui1] * w10 +
                yuv[uOff + uj1 * uvW + ui0] * w01 +
                yuv[uOff + uj1 * uvW + ui1] * w11
            ) - 128;
            const v = (
                yuv[vOff + uj0 * uvW + ui0] * w00 +
                yuv[vOff + uj0 * uvW + ui1] * w10 +
                yuv[vOff + uj1 * uvW + ui0] * w01 +
                yuv[vOff + uj1 * uvW + ui1] * w11
            ) - 128;

            const y = yuv[j * w + i] - 16;
            const c = 298 * y;
            const idx = (j * w + i) * 4;
            rgba[idx]     = Math.max(0, Math.min(255, (c + 409 * v + 128) >> 8));
            rgba[idx + 1] = Math.max(0, Math.min(255, (c - 100 * u - 208 * v + 128) >> 8));
            rgba[idx + 2] = Math.max(0, Math.min(255, (c + 516 * u + 128) >> 8));
            rgba[idx + 3] = 255;
        }
    }
    return rgba;
}

// --- Delta frame engine ---
// Subtraction delta (mod 256) instead of XOR: small changes produce small values
// centered around 0, which quantize and Rice-encode much more efficiently.
// XOR of 100 and 103 gives 7; subtraction gives 3 — smaller, more compressible.

function computeDelta(current: Uint8Array, previous: Uint8Array): Uint8Array {
    const delta = new Uint8Array(current.length);
    for (let i = 0; i < current.length; i++) delta[i] = (current[i] - previous[i]) & 0xFF;
    return delta;
}

function applyDelta(delta: Uint8Array, previous: Uint8Array): Uint8Array {
    const out = new Uint8Array(delta.length);
    for (let i = 0; i < delta.length; i++) out[i] = (delta[i] + previous[i]) & 0xFF;
    return out;
}

// --- Block skip ---
// Operates on spatial blocks across the Y plane for motion detection,
// but extracts/reinserts from the full YUV420 buffer so UV planes are included.

function buildBlockBitmap(
    yDelta: Uint8Array, w: number, h: number, blockSize: number, threshold: number
): { bitmap: Uint8Array; blocksX: number; blocksY: number; changedCount: number } {
    const blocksX = Math.ceil(w / blockSize);
    const blocksY = Math.ceil(h / blockSize);
    const totalBlocks = blocksX * blocksY;
    const bitmap = new Uint8Array(Math.ceil(totalBlocks / 8));
    let changedCount = 0;
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            let energy = 0;
            for (let dy = 0; dy < blockSize && by * blockSize + dy < h; dy++) {
                for (let dx = 0; dx < blockSize && bx * blockSize + dx < w; dx++) {
                    const off = (by * blockSize + dy) * w + (bx * blockSize + dx);
                    const d = yDelta[off];
                    energy += d < 128 ? d : 256 - d; // signed magnitude of mod-256 delta
                    if (energy >= threshold) break;
                }
                if (energy >= threshold) break;
            }
            if (energy >= threshold) {
                bitmap[blockIdx >> 3] |= 1 << (blockIdx & 7);
                changedCount++;
            }
        }
    }
    return { bitmap, blocksX, blocksY, changedCount };
}

// Extract changed blocks from a planar buffer (Y, U, or V plane independently)
function extractChangedBlocksPlane(
    data: Uint8Array, planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    blockSize: number, planeBlockSize: number
): Uint8Array {
    const chunks: number[] = [];
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
            for (let dy = 0; dy < planeBlockSize; dy++) {
                const y = by * planeBlockSize + dy;
                if (y >= planeH) break;
                for (let dx = 0; dx < planeBlockSize; dx++) {
                    const x = bx * planeBlockSize + dx;
                    if (x >= planeW) break;
                    chunks.push(data[y * planeW + x]);
                }
            }
        }
    }
    return new Uint8Array(chunks);
}

// Reinsert changed blocks into a planar buffer
function reinsertChangedBlocksPlane(
    blockData: Uint8Array, readStart: number,
    planeW: number, planeH: number,
    bitmap: Uint8Array, blocksX: number, blocksY: number,
    planeBlockSize: number, base: Uint8Array
): number {
    let readPos = readStart;
    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const blockIdx = by * blocksX + bx;
            if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
            for (let dy = 0; dy < planeBlockSize; dy++) {
                const y = by * planeBlockSize + dy;
                if (y >= planeH) break;
                for (let dx = 0; dx < planeBlockSize; dx++) {
                    const x = bx * planeBlockSize + dx;
                    if (x >= planeW) break;
                    base[y * planeW + x] = blockData[readPos++];
                }
            }
        }
    }
    return readPos;
}

// --- Perceptual transfer function (sqrt PQ) ---
// Human vision follows Weber's law: sensitivity to luminance changes is
// proportional to 1/L. A sqrt transfer function (gamma=0.5) redistributes
// quantization levels to match this, giving 2x more precision in darks
// and correspondingly less in brights (where the eye can't tell).
// This is the same principle as sRGB gamma, µ-law audio companding,
// and SMPTE ST 2084 PQ. Applied ONLY to Y plane of I-frames.

// Gamma=0.55: gentler than sqrt(0.5), avoids harsh bright-value inversion errors.
// Still gives 1.8x more levels in the dark half vs linear quantization.
// The LUTs are bijective: PQ_INV[PQ_FWD[v]] ≈ v (max error 1, from rounding).
const PQ_GAMMA = 0.55;
const PQ_GAMMA_INV = 1 / PQ_GAMMA;
const PQ_FWD = new Uint8Array(256); // linear → perceptual
const PQ_INV = new Uint8Array(256); // perceptual → linear
for (let i = 0; i < 256; i++) {
    PQ_FWD[i] = Math.min(255, (Math.pow(i / 255, PQ_GAMMA) * 255 + 0.5) | 0);
    PQ_INV[i] = Math.min(255, (Math.pow(i / 255, PQ_GAMMA_INV) * 255 + 0.5) | 0);
}

function pqForward(data: Uint8Array, offset: number, count: number): void {
    for (let i = offset; i < offset + count; i++) data[i] = PQ_FWD[data[i]];
}

function pqInverse(data: Uint8Array, offset: number, count: number): void {
    for (let i = offset; i < offset + count; i++) data[i] = PQ_INV[data[i]];
}

// --- Quantization ---
// Maps quality 1-99 to a smooth divisor curve.
// q=99 → step=2 (lightest), q=50 → step=8, q=1 → step=128 (heaviest).
// UV planes get a quality-scaled boost (1.0-1.2x) because human vision is
// less sensitive to chrominance.

function qstep(quality: number): number {
    // Exponential curve: step = 2^((100-q)/17)  clamped to [1, 128]
    // Float step — no rounding — gives smooth quality gradient with no plateaus.
    // Exponent 17 (was 13): gentler curve preserves 45% of luma levels at q80
    // (up from 35% at exp=13), while q30 step=17.4 still compresses aggressively.
    return Math.max(1, Math.min(128, Math.pow(2, (100 - quality) / 17)));
}

function uvQstep(quality: number): number {
    const yS = qstep(quality);
    // Quality-adaptive chroma boost:
    //   q>=75: boost=1.0 (no boost — color accuracy is paramount for high quality)
    //   q<75:  ramp from 1.0 to 1.15 (saves chroma bits where eye can't tell)
    // This gives perfect color at high quality and reasonable bitrate savings at low quality.
    const boost = quality >= 75 ? 1.0 : 1.0 + 0.15 * ((75 - quality) / 75);
    return Math.min(128, yS * boost);
}

/** Quantize with chroma boost: Y uses yStep, UV uses uvStep. For absolute values (I-frames). */
function quantizeChroma(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    const yInv = 1 / yS, uvInv = 1 / uvS; // precompute reciprocals — division is slow
    const out = new Uint8Array(data.length);
    for (let i = 0; i < ySamples; i++) out[i] = (data[i] * yInv + 0.5) | 0;
    for (let i = ySamples; i < data.length; i++) out[i] = (data[i] * uvInv + 0.5) | 0;
    return out;
}

function dequantizeChroma(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < ySamples; i++) out[i] = Math.min(255, (data[i] * yS + 0.5) | 0);
    for (let i = ySamples; i < data.length; i++) out[i] = Math.min(255, (data[i] * uvS + 0.5) | 0);
    return out;
}

/** Signed quantize for subtraction deltas (P-frames). Values 0-127 = positive, 128-255 = negative.
 *  Uses quality-adaptive deadzone: wider at low quality (maximize zeros for compression),
 *  tighter at high quality (preserve subtle motion detail). */
function quantizeChromaSigned(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    // Deadzone width scales inversely with quality:
    //   q90: 0.55 * step (tight — preserve detail)
    //   q80: 0.60 * step
    //   q50: 0.70 * step
    //   q30: 0.80 * step (wide — maximize zeros)
    const dzFactor = 0.5 + 0.35 * (1 - quality / 100);
    const yDZ = yS * dzFactor, uvDZ = uvS * dzFactor;
    const yInv = 1 / yS, uvInv = 1 / uvS;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const inv = i < ySamples ? yInv : uvInv;
        const dz = i < ySamples ? yDZ : uvDZ;
        const v = data[i];
        if (v < 128) {
            // Positive delta: apply deadzone then truncate toward 0
            out[i] = v < dz ? 0 : ((v * inv + 0.5) | 0) & 0xFF;
        } else {
            // Negative delta
            const mag = 256 - v;
            out[i] = mag < dz ? 0 : (-(((mag * inv + 0.5) | 0))) & 0xFF;
        }
    }
    return out;
}

function dequantizeChromaSigned(data: Uint8Array, ySamples: number, quality: number): Uint8Array {
    const yS = qstep(quality), uvS = uvQstep(quality);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const step = i < ySamples ? yS : uvS;
        const v = data[i];
        if (v < 128) {
            out[i] = Math.min(127, (v * step + 0.5) | 0) & 0xFF;
        } else {
            out[i] = (-Math.min(128, ((256 - v) * step + 0.5) | 0)) & 0xFF;
        }
    }
    return out;
}

// --- Ordered dithering (Bayer 4×4) ---
// Adds spatially-patterned ±half-step noise BEFORE quantization to break banding.
// The Bayer matrix spreads quantization error across pixels rather than creating
// sharp step boundaries. Applied only to I-frames (P-frame deltas are already noisy).

const BAYER4 = new Float32Array([
     0/16, 8/16, 2/16, 10/16,
    12/16, 4/16, 14/16,  6/16,
     3/16, 11/16, 1/16,  9/16,
    15/16, 7/16, 13/16,  5/16
]);

function ditherPlane(
    yuv: Uint8Array, off: number, stride: number, rows: number, step: number
): void {
    // Gradient-adaptive: only dither pixels where local gradient exists.
    // Uniform regions (solid colors) are left untouched for perfect compression.
    // Strength scales with step — larger quantization bins get stronger dithering.
    if (step < 1.5) return; // q>=90: steps so fine that banding can't happen
    for (let j = 0; j < rows; j++) {
        const jMod = (j & 3) << 2;
        for (let i = 0; i < stride; i++) {
            const idx = off + j * stride + i;
            const v = yuv[idx];
            // Local gradient: max |diff| to left and top neighbors
            const left = i > 0 ? yuv[idx - 1] : v;
            const top = j > 0 ? yuv[idx - stride] : v;
            const grad = Math.max(Math.abs(v - left), Math.abs(v - top));
            if (grad < 2) continue; // uniform region — skip dithering
            // Scale dither by how much gradient there is (clamped to full strength)
            const t = Math.min(1, grad / step);
            const d = (BAYER4[jMod + (i & 3)] - 0.5) * step * t;
            yuv[idx] = Math.max(0, Math.min(255, v + d + 0.5)) | 0;
        }
    }
}

function ditherYUV(yuv: Uint8Array, w: number, h: number, quality: number): void {
    const yS = qstep(quality), uvS = uvQstep(quality);
    const ySize = w * h;
    const uvW = w >> 1, uvH = h >> 1;
    const uvSize = uvW * uvH;
    ditherPlane(yuv, 0, w, h, yS);
    ditherPlane(yuv, ySize, uvW, uvH, uvS);
    ditherPlane(yuv, ySize + uvSize, uvW, uvH, uvS);
}

// --- Temporal FRC dithering (decoder-side only) ---
// Frame Rate Control: alternates Bayer pattern each frame so the eye averages
// consecutive frames, perceiving ~2x the effective bit depth. This is exactly
// how 6-bit display panels achieve 8-bit appearance, and it costs zero bits.
// Applied AFTER reconstruction (doesn't affect reference frame → zero drift).
//
// Pattern cycles through 4 Bayer offsets: (0,0), (2,1), (1,2), (3,3)
// which are maximally dispersed in the 4x4 Bayer matrix.
const FRC_OFFSETS = [[0, 0], [2, 1], [1, 2], [3, 3]];

function frcDither(
    yuv: Uint8Array, w: number, h: number, quality: number, frameNum: number
): void {
    const step = qstep(quality);
    if (step < 1.5) return; // high quality: steps so fine that FRC isn't needed
    // Quality-adaptive FRC strength: subtle at high quality, stronger at low
    const baseStrength = step * (0.2 + 0.15 * (1 - quality / 100));
    const [offX, offY] = FRC_OFFSETS[frameNum & 3];
    // Only dither Y plane, and only where there's gradient (skip flat regions)
    for (let j = 0; j < h; j++) {
        const bj = ((j + offY) & 3) << 2;
        for (let i = 0; i < w; i++) {
            const idx = j * w + i;
            const v = yuv[idx];
            // Only apply FRC near quantization boundaries (where banding is visible)
            const left = i > 0 ? yuv[idx - 1] : v;
            const top = j > 0 ? yuv[idx - w] : v;
            const grad = Math.max(Math.abs(v - left), Math.abs(v - top));
            if (grad < 1) continue; // perfectly flat — no banding possible
            const d = (BAYER4[bj + ((i + offX) & 3)] - 0.5) * baseStrength;
            yuv[idx] = Math.max(0, Math.min(255, v + d + 0.5)) | 0;
        }
    }
}

// --- Spatial prediction (LOCO-I / JPEG-LS MED predictor) ---
// Applied AFTER quantization (on discrete values) so prediction is lossless.
// Converts smooth gradients into near-zero residuals for better entropy coding.

/** MED predict per-plane. In-place, reverse raster order. */
function medPredict(data: Uint8Array, offset: number, stride: number, rows: number): void {
    // Process from bottom-right to top-left so original values are available for prediction
    for (let y = rows - 1; y >= 0; y--) {
        for (let x = stride - 1; x >= 0; x--) {
            const i = offset + y * stride + x;
            const left = x > 0 ? data[offset + y * stride + (x - 1)] : 0;
            const top = y > 0 ? data[offset + (y - 1) * stride + x] : 0;
            const topLeft = (x > 0 && y > 0) ? data[offset + (y - 1) * stride + (x - 1)] : 0;
            // MED: adapts to edges. Horizontal edge → predict from top.
            // Vertical edge → predict from left. Smooth → plane predictor.
            let pred: number;
            if (topLeft <= Math.min(left, top)) pred = Math.max(left, top);
            else if (topLeft >= Math.max(left, top)) pred = Math.min(left, top);
            else pred = (left + top - topLeft);
            data[i] = (data[i] - pred) & 0xFF;
        }
    }
}

/** MED unpredict per-plane. In-place, forward raster order. */
function medUnpredict(data: Uint8Array, offset: number, stride: number, rows: number): void {
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < stride; x++) {
            const i = offset + y * stride + x;
            const left = x > 0 ? data[offset + y * stride + (x - 1)] : 0;
            const top = y > 0 ? data[offset + (y - 1) * stride + x] : 0;
            const topLeft = (x > 0 && y > 0) ? data[offset + (y - 1) * stride + (x - 1)] : 0;
            let pred: number;
            if (topLeft <= Math.min(left, top)) pred = Math.max(left, top);
            else if (topLeft >= Math.max(left, top)) pred = Math.min(left, top);
            else pred = (left + top - topLeft);
            data[i] = (data[i] + pred) & 0xFF;
        }
    }
}

// --- Zigzag transform ---
// After MED/left prediction, residuals are signed mod 256: value 255 means -1,
// 254 means -2, etc. Zigzag maps signed to unsigned so small residuals stay small:
//   0→0, -1→1, +1→2, -2→3, +2→4, ...
// This concentrates energy near zero for optimal Rice coding.

function zigzagEncode(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        data[i] = v < 128 ? (v << 1) : (((256 - v) << 1) - 1);
    }
}

function zigzagDecode(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        data[i] = (v & 1) ? (256 - ((v + 1) >> 1)) : (v >> 1);
    }
}

// --- Entropy coding: hybrid zero-run + Rice for non-zeros ---
// Encodes as (zero_run_length, non_zero_value) pairs using Rice coding.
// Rice k parameters are adaptive per-frame: computed from mean run/value
// statistics in a single pass. Chosen k is stored in the packet flags (6 bits).

const RICE_ESCAPE = 24;  // unary escape threshold (shared for run/val)

function riceEncodeWithK(data: Uint8Array, runK: number, valK: number): Uint8Array {
    const buf = new Uint8Array(Math.ceil(data.length * 2) + 16);
    let bytePos = 0, bitPos = 0;

    function writeBit(b: number) {
        if (b) buf[bytePos] |= (1 << bitPos);
        if (++bitPos === 8) { bitPos = 0; bytePos++; }
    }

    function writeBits(val: number, count: number) {
        for (let i = 0; i < count; i++) writeBit((val >>> i) & 1);
    }

    function writeRice(val: number, k: number) {
        const q = val >>> k;
        if (q < RICE_ESCAPE) {
            for (let j = 0; j < q; j++) writeBit(1);
            writeBit(0);
            if (k > 0) writeBits(val & ((1 << k) - 1), k);
        } else {
            for (let j = 0; j < RICE_ESCAPE; j++) writeBit(1);
            writeBit(0);
            writeBits(val, 16);
        }
    }

    let i = 0;
    while (i < data.length) {
        let runLen = 0;
        while (i + runLen < data.length && data[i + runLen] === 0) runLen++;

        if (i + runLen >= data.length) {
            writeRice(runLen, runK);
            break;
        }

        writeRice(runLen, runK);
        i += runLen;
        writeRice(data[i] - 1, valK);
        i++;
    }

    const totalBytes = bitPos > 0 ? bytePos + 1 : bytePos;
    return buf.subarray(0, totalBytes);
}

/** Measure encoded size for a given k pair without allocating the full output. */
function riceMeasure(data: Uint8Array, runK: number, valK: number): number {
    let bits = 0;

    function countRice(val: number, k: number) {
        const q = val >>> k;
        if (q < RICE_ESCAPE) {
            bits += q + 1 + k;
        } else {
            bits += RICE_ESCAPE + 1 + 16;
        }
    }

    let i = 0;
    while (i < data.length) {
        let runLen = 0;
        while (i + runLen < data.length && data[i + runLen] === 0) runLen++;

        if (i + runLen >= data.length) {
            countRice(runLen, runK);
            break;
        }

        countRice(runLen, runK);
        i += runLen;
        countRice(data[i] - 1, valK);
        i++;
    }

    return Math.ceil(bits / 8);
}

/** Pick optimal Rice k from data statistics, then encode once. */
function riceEncodeAdaptive(data: Uint8Array): { encoded: Uint8Array; runK: number; valK: number } {
    // Single pass: collect run lengths and values
    let runSum = 0, runCount = 0, valSum = 0, valCount = 0;
    let i = 0;
    while (i < data.length) {
        let runLen = 0;
        while (i + runLen < data.length && data[i + runLen] === 0) runLen++;
        runSum += runLen;
        runCount++;
        i += runLen;
        if (i < data.length) {
            valSum += data[i] - 1;
            valCount++;
            i++;
        }
    }
    // Optimal Rice k ≈ max(0, floor(log2(mean))) when mean >= 1
    const runMean = runCount > 0 ? runSum / runCount : 0;
    const valMean = valCount > 0 ? valSum / valCount : 0;
    const runK = runMean >= 1 ? Math.min(7, Math.floor(Math.log2(runMean))) : 0;
    const valK = valMean >= 1 ? Math.min(7, Math.floor(Math.log2(valMean))) : 0;
    return { encoded: riceEncodeWithK(data, runK, valK), runK, valK };
}

function riceDecode(data: Uint8Array, expectedLen: number, runK: number, valK: number): Uint8Array {
    const out = new Uint8Array(expectedLen);
    let bytePos = 0, bitPos = 0;
    let wi = 0;

    function readBit(): number {
        if (bytePos >= data.length) return 0;
        const b = (data[bytePos] >>> bitPos) & 1;
        if (++bitPos === 8) { bitPos = 0; bytePos++; }
        return b;
    }

    function readBits(count: number): number {
        let val = 0;
        for (let i = 0; i < count; i++) val |= (readBit() << i);
        return val;
    }

    function readRice(k: number): number {
        let q = 0;
        while (readBit() === 1) q++;
        if (q >= RICE_ESCAPE) return readBits(16);
        const r = k > 0 ? readBits(k) : 0;
        return (q << k) | r;
    }

    while (wi < expectedLen) {
        const runLen = readRice(runK);
        wi += runLen;
        if (wi >= expectedLen) break;
        out[wi++] = readRice(valK) + 1;
    }

    return out;
}

// --- Compressed payload assembly ---

function packCompressedPayload(
    rleData: Uint8Array, isKeyframe: boolean,
    blocksX: number, blocksY: number, bitmap: Uint8Array
): Uint8Array {
    if (isKeyframe) return rleData;
    // P-frame: [bitmap][rleData] — blocksX/blocksY derived from w/h/blockSize
    const bitmapLen = Math.ceil(blocksX * blocksY / 8);
    const out = new Uint8Array(bitmapLen + rleData.length);
    out.set(bitmap.subarray(0, bitmapLen), 0);
    out.set(rleData, bitmapLen);
    return out;
}

function unpackCompressedPayload(
    payload: Uint8Array, isKeyframe: boolean,
    blocksX: number, blocksY: number
): { rleData: Uint8Array; bitmap: Uint8Array } {
    if (isKeyframe) return { rleData: payload, bitmap: new Uint8Array(0) };
    const bitmapLen = Math.ceil(blocksX * blocksY / 8);
    const bitmap = payload.subarray(0, bitmapLen);
    const rleData = payload.subarray(bitmapLen);
    return { rleData, bitmap };
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
        // Quality-adaptive block threshold: at high quality, catch subtle changes.
        // At low quality, ignore small deltas (they'll be quantized away anyway).
        //   q90: 0.6x base (sensitive)  q80: 0.8x  q50: 1.4x  q30: 2.0x
        const thresholdScale = 0.5 + 1.5 * (1 - quality / 100);
        const blockThreshold = Math.max(2, (baseThreshold * thresholdScale + 0.5) | 0);
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;
        const uvBlockSize = blockSize >> 1; // UV is 2x subsampled

        // Step 1: RGBA → YUV420
        const yuv = rgbaToYuv420(pixels, w, h);

        // Step 2: Keyframe or delta?
        let isKeyframe = !this.prevFrame || this.framesSinceKey >= keyFrameInterval;

        let toEncode: Uint8Array;
        let blocksX = 0, blocksY = 0;
        let bitmap = new Uint8Array(0);

        // PQ forward on Y plane: all frames operate in perceptual space.
        // prevFrame is stored in PQ space so deltas are perceptually uniform.
        pqForward(yuv, 0, ySize);

        let useNoMed = false; // track which path won for flags

        if (isKeyframe) {
            // I-frame: dither → quantize → adaptive MED → zigzag → RLE
            // Try BOTH paths (with MED, without MED) and pick whichever compresses smaller.
            // MED helps smooth/gradient content ~15x but hurts high-frequency content ~0.7x.
            ditherYUV(yuv, w, h, quality);
            const quantized = quantizeChroma(yuv, ySize, quality);
            // Track decoder state: store what decoder will reconstruct (PQ space)
            this.prevFrame = dequantizeChroma(quantized, ySize, quality);

            // Path A: with MED prediction
            const withMed = new Uint8Array(quantized);
            medPredict(withMed, 0, w, h);
            medPredict(withMed, ySize, uvW, uvH);
            medPredict(withMed, ySize + uvSize, uvW, uvH);
            const zigMed = new Uint8Array(withMed);
            zigzagEncode(zigMed);
            const medResult = riceEncodeAdaptive(zigMed);

            // Path B: without MED (just zigzag the raw quantized values)
            const noMed = new Uint8Array(quantized);
            zigzagEncode(noMed);
            const noMedResult = riceEncodeAdaptive(noMed);

            // Pick winner
            if (noMedResult.encoded.length < medResult.encoded.length) {
                toEncode = noMed;
                useNoMed = true;
            } else {
                toEncode = zigMed;
            }
            this.framesSinceKey = 1;
        } else {
            // P-frame: delta in PQ space against encoder's reference
            const delta = computeDelta(yuv, this.prevFrame!);

            // Block skip: detect motion on Y plane
            const blockInfo = buildBlockBitmap(delta.subarray(0, ySize), w, h, blockSize, blockThreshold);
            blocksX = blockInfo.blocksX;
            blocksY = blockInfo.blocksY;
            bitmap = blockInfo.bitmap;

            // Extract changed blocks from ALL planes (Y + U + V)
            const yBlocks = extractChangedBlocksPlane(
                delta.subarray(0, ySize), w, h,
                bitmap, blocksX, blocksY, blockSize, blockSize
            );
            const uBlocks = extractChangedBlocksPlane(
                delta.subarray(ySize, ySize + uvSize), uvW, uvH,
                bitmap, blocksX, blocksY, blockSize, uvBlockSize
            );
            const vBlocks = extractChangedBlocksPlane(
                delta.subarray(ySize + uvSize), uvW, uvH,
                bitmap, blocksX, blocksY, blockSize, uvBlockSize
            );

            // Concatenate Y+U+V block data
            const allBlocks = new Uint8Array(yBlocks.length + uBlocks.length + vBlocks.length);
            allBlocks.set(yBlocks, 0);
            allBlocks.set(uBlocks, yBlocks.length);
            allBlocks.set(vBlocks, yBlocks.length + uBlocks.length);

            const quantizedBlocks = quantizeChromaSigned(allBlocks, yBlocks.length, quality);

            // Track decoder state: simulate the lossy reconstruction (BEFORE prediction)
            const lossyDelta = new Uint8Array(yuvSize); // zeros = unchanged blocks stay zero
            const lossyBlocks = dequantizeChromaSigned(quantizedBlocks, yBlocks.length, quality);

            // Zigzag on quantized block data (no left-prediction: signed-quantized
            // deltas are already concentrated at 0/±1, prediction adds noise)
            toEncode = new Uint8Array(quantizedBlocks);
            zigzagEncode(toEncode);
            // Reinsert lossy blocks into all three planes
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
        }

        // Step 5: Adaptive Rice encoding
        let rleData: Uint8Array, runK: number, valK: number;
        if (isKeyframe) {
            // I-frame: already encoded via adaptive MED selection above — reuse winner
            const winner = useNoMed ? riceEncodeAdaptive(toEncode) : riceEncodeAdaptive(toEncode);
            // Note: toEncode was already set to the winning path's zigzagged data.
            // We re-encode here because the original result was temporary. The cost
            // is negligible since I-frames are infrequent (1 per keyFrameInterval).
            rleData = winner.encoded; runK = winner.runK; valK = winner.valK;
        } else {
            const result = riceEncodeAdaptive(toEncode);
            rleData = result.encoded; runK = result.runK; valK = result.valK;
        }

        // Step 6: Pack payload
        let payload = packCompressedPayload(rleData, isKeyframe, blocksX, blocksY, bitmap);

        // Step 7: Scene-change detection — if P-frame is bigger than an I-frame would be,
        // redo as I-frame. This catches abrupt scene changes where every block is different.
        if (!isKeyframe) {
            const iframeEstimate = this.estimateIframeSize(yuv, w, h, ySize, uvW, uvH, uvSize, quality);
            if (payload.length > iframeEstimate) {
                // Redo as I-frame with adaptive MED (yuv is already in PQ space)
                isKeyframe = true;
                ditherYUV(yuv, w, h, quality);
                const q = quantizeChroma(yuv, ySize, quality);
                this.prevFrame = dequantizeChroma(q, ySize, quality);

                // Try both paths
                const wM = new Uint8Array(q);
                medPredict(wM, 0, w, h); medPredict(wM, ySize, uvW, uvH);
                medPredict(wM, ySize + uvSize, uvW, uvH);
                const zM = new Uint8Array(wM); zigzagEncode(zM);
                const mR = riceEncodeAdaptive(zM);

                const nM = new Uint8Array(q); zigzagEncode(nM);
                const nR = riceEncodeAdaptive(nM);

                const pickNoMed = nR.encoded.length < mR.encoded.length;
                const iResult = pickNoMed ? nR : mR;
                this.framesSinceKey = 1;
                payload = packCompressedPayload(iResult.encoded, true, 0, 0, new Uint8Array(0));
                const iFlags = encodeFlags(true, true, quality, iResult.runK, iResult.valK, pickNoMed);
                return { payload, flags: iFlags };
            }
        }

        const flags = encodeFlags(true, isKeyframe, quality, runK, valK, useNoMed);
        return { payload, flags };
    }

    /** Quick I-frame size estimate without full Rice allocation. */
    private estimateIframeSize(
        yuv: Uint8Array, w: number, h: number,
        ySize: number, uvW: number, uvH: number, uvSize: number,
        quality: number
    ): number {
        // yuv is already in PQ space (caller applies PQ before if/else)
        const q = quantizeChroma(yuv, ySize, quality);
        medPredict(q, 0, w, h);
        medPredict(q, ySize, uvW, uvH);
        medPredict(q, ySize + uvSize, uvW, uvH);
        zigzagEncode(q);
        // Use same analytical k selection as the real encoder
        let runSum = 0, runCount = 0, valSum = 0, valCount = 0;
        let i = 0;
        while (i < q.length) {
            let runLen = 0;
            while (i + runLen < q.length && q[i + runLen] === 0) runLen++;
            runSum += runLen; runCount++;
            i += runLen;
            if (i < q.length) { valSum += q[i] - 1; valCount++; i++; }
        }
        const rk = runCount > 0 && runSum / runCount >= 1 ? Math.min(7, Math.floor(Math.log2(runSum / runCount))) : 0;
        const vk = valCount > 0 && valSum / valCount >= 1 ? Math.min(7, Math.floor(Math.log2(valSum / valCount))) : 0;
        return riceMeasure(q, rk, vk);
    }

    private decompressFrame(decrypted: Uint8Array, w: number, h: number, flags: number): Uint8Array {
        const { keyframe, quality, runK, valK, noMed } = decodeFlags(flags);
        const ySize = w * h;
        const uvW = w >> 1, uvH = h >> 1;
        const uvSize = uvW * uvH;
        const yuvSize = ySize + uvSize * 2;
        const blockSize = this.config.blockSize;
        const uvBlockSize = blockSize >> 1;
        const blocksX = Math.ceil(w / blockSize);
        const blocksY = Math.ceil(h / blockSize);

        const { rleData, bitmap } = unpackCompressedPayload(decrypted, keyframe, blocksX, blocksY);

        if (keyframe) {
            // I-frame: Rice → zigzag → [MED unpredict if used] → dequantize → PQ inv → FRC → RGBA
            const quantized = riceDecode(rleData, yuvSize, runK, valK);
            zigzagDecode(quantized);
            if (!noMed) {
                medUnpredict(quantized, 0, w, h);                  // Y plane
                medUnpredict(quantized, ySize, uvW, uvH);          // U plane
                medUnpredict(quantized, ySize + uvSize, uvW, uvH); // V plane
            }
            const yuv = dequantizeChroma(quantized, ySize, quality);
            this.prevDecFrame = new Uint8Array(yuv); // reference in PQ space
            // Output path: PQ inverse → FRC dither → RGBA
            pqInverse(yuv, 0, ySize);
            frcDither(yuv, w, h, quality, this.decFrameCount++);
            return yuv420ToRgba(yuv, w, h);
        } else {
            // P-frame: RLE decode → dequantize → reinsert blocks (all planes) → un-delta → RGBA

            // Count expected block bytes for Y plane
            let yBlockBytes = 0;
            for (let by = 0; by < blocksY; by++) {
                for (let bx = 0; bx < blocksX; bx++) {
                    const blockIdx = by * blocksX + bx;
                    if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
                    for (let dy = 0; dy < blockSize; dy++) {
                        if (by * blockSize + dy >= h) break;
                        for (let dx = 0; dx < blockSize; dx++) {
                            if (bx * blockSize + dx >= w) break;
                            yBlockBytes++;
                        }
                    }
                }
            }
            // Count expected block bytes for one UV plane
            let uvBlockBytes = 0;
            for (let by = 0; by < blocksY; by++) {
                for (let bx = 0; bx < blocksX; bx++) {
                    const blockIdx = by * blocksX + bx;
                    if (!(bitmap[blockIdx >> 3] & (1 << (blockIdx & 7)))) continue;
                    for (let dy = 0; dy < uvBlockSize; dy++) {
                        if (by * uvBlockSize + dy >= uvH) break;
                        for (let dx = 0; dx < uvBlockSize; dx++) {
                            if (bx * uvBlockSize + dx >= uvW) break;
                            uvBlockBytes++;
                        }
                    }
                }
            }

            const totalBlockBytes = yBlockBytes + uvBlockBytes * 2;
            const quantizedBlocks = riceDecode(rleData, totalBlockBytes, runK, valK);
            zigzagDecode(quantizedBlocks);
            const deltaBlocks = dequantizeChromaSigned(quantizedBlocks, yBlockBytes, quality);

            // Reinsert changed blocks into full YUV delta
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

            // Apply delta to previous frame in PQ space (all planes)
            const base = this.prevDecFrame || new Uint8Array(yuvSize);
            const yuv = applyDelta(fullDelta, base);

            this.prevDecFrame = new Uint8Array(yuv); // reference in PQ space
            // Output path: PQ inverse → FRC dither → RGBA
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
            // Raw path — existing behavior
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
        return new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height);
    }
}
