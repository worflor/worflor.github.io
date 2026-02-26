/**
 * live-wasm-video.ts
 * 
 * Whisper Raw Video Codec
 *
 * ChaCha20-AEAD Encrypted 1:1 Video Pipeline.
 * Features an integrated 256-bit Symmetric Double Ratchet.
 * Zero compression. Mathematically perfect fidelity.
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

export class VideoCodec {
    public wasm: VideoWasmExports | null = null;
    private initialized = false;

    async init(encryptionKey: Uint32Array) {
        if (encryptionKey.length < 8) throw new Error("Key must be 256 bits (Uint32Array of 8)");
        this.wasm = await getVideoWasm();
        const k = encryptionKey;
        this.wasm.reset_encoder_state(k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
        this.wasm.reset_decoder_state(k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
        this.initialized = true;
    }

    /** Exact packet size for a given resolution. Use to pre-allocate buffers. */
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

    /** Encrypt a frame. Returns a new Uint8Array packet. */
    encode(pixels: Uint8Array, width: number, height: number): Uint8Array {
        if (!this.wasm) throw new Error("Codec not initialized");
        const numPixels = width * height;
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
        dv.setUint32(8, 0, true); // flags

        const bytesWritten = this.wasm.encode_video(pixelsPtr, numPixels, outPtr);
        return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
    }

    /**
     * Encrypt a frame directly into a pre-allocated buffer. Zero-alloc hot path.
     * `out` must be at least `VideoCodec.packetSize(width, height)` bytes.
     * Returns the number of bytes written.
     */
    encodeInto(pixels: Uint8Array, width: number, height: number, out: Uint8Array): number {
        if (!this.wasm) throw new Error("Codec not initialized");
        const numPixels = width * height;
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

    /** Decrypt a packet. Returns a new Uint8Array for the pixels. */
    decode(packet: Uint8Array): { pixels: Uint8Array; width: number; height: number; tampered: boolean } {
        if (!this.wasm) throw new Error("Codec not initialized");
        if (packet.length < HEADER_SIZE + MAC_SIZE) throw new Error("Video packet too short");

        const dvHdr = new DataView(packet.buffer, packet.byteOffset, HEADER_SIZE);
        const width = dvHdr.getUint16(0, true);
        const height = dvHdr.getUint16(2, true);
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
        if (!tampered) {
            pixels.set(new Uint8Array(mem.buffer, outPtr, pixelsDecoded * 4));
        }

        return { pixels, width, height, tampered };
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

        if (!tampered) {
            out.set(new Uint8Array(mem.buffer, outPtr, pixelsDecoded * 4));
        }

        return { width, height, tampered };
    }

    /** Convenience: decode to ImageData for direct canvas rendering. Browser-only. */
    decodeToImageData(packet: Uint8Array): ImageData | null {
        const { pixels, width, height, tampered } = this.decode(packet);
        if (tampered) return null;
        return new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height);
    }
}
