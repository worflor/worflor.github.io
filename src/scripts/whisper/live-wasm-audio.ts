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
 *   0x0000 –  0x000F  : INDEX_TABLE  (16 × i8)
 *   0x0010 –  0x00C1  : STEP_TABLE   (89 × i16, little-endian)
 *   0x0200+            : caller-managed PCM/ADPCM buffers
 *
 * Input PCM: Int16 (signed 16-bit), mono.
 * Output:    IMA ADPCM 4-bit nibbles, packed 2 per byte, ~4:1 compression.
 *
 * FORMAT HEADER (4 bytes prefixed before ADPCM nibble stream):
 *   [0..1] u16 LE — number of original PCM samples
 *   [2]    u8     — initial predictor (always 0, reserved)
 *   [3]    u8     — initial step index (always 0, reserved)
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

function name(s: string): number[] {
    const b = Array.from(new TextEncoder().encode(s));
    return [...encodeULEB(b.length), ...b];
}

function section(id: number, body: number[]): number[] {
    return [id, ...encodeULEB(body.length), ...body];
}

const I32 = 0x7f;
const VOID = 0x40;

// Instructions
const GET = (i: number) => [0x20, ...encodeULEB(i)];  // local.get
const SET = (i: number) => [0x21, ...encodeULEB(i)];  // local.set
const TEE = (i: number) => [0x22, ...encodeULEB(i)];  // local.tee
const CI32 = (v: number) => [0x41, ...encodeSLEB(v)];  // i32.const
const BR = (l: number) => [0x0c, ...encodeULEB(l)];  // br
const BRIF = (l: number) => [0x0d, ...encodeULEB(l)];  // br_if
const BLOCK = [0x02, VOID];
const LOOP = [0x03, VOID];
const END = [0x0b];

// Memory ops  (opcode, align_log2, offset)
const LOAD8s = (align: number, off: number) => [0x2c, align, ...encodeULEB(off)]; // i32.load8_s
const LOAD16s = (align: number, off: number) => [0x2e, align, ...encodeULEB(off)]; // i32.load16_s
const STORE8 = (align: number, off: number) => [0x3a, align, ...encodeULEB(off)]; // i32.store8
const STORE16 = (align: number, off: number) => [0x3b, align, ...encodeULEB(off)]; // i32.store16

// Arithmetic / logic
const ADD = [0x6a]; // i32.add
const SUB = [0x6b]; // i32.sub
const MUL = [0x6c]; // i32.mul
const SHR_s = [0x75]; // i32.shr_s
const SHR_u = [0x76]; // i32.shr_u
const SHL = [0x74]; // i32.shl
const AND = [0x71]; // i32.and
const OR = [0x72]; // i32.or
const XOR = [0x73]; // i32.xor
const GE_s = [0x4e]; // i32.ge_s
const GT_s = [0x4a]; // i32.gt_s
const LT_s = [0x48]; // i32.lt_s
const LE_s = [0x4c]; // i32.le_s
const EQ = [0x46]; // i32.eq
const NEZ = [0x45]; // i32.eqz (for != 0 via NOT eqz)
const DROP = [0x1a];

function encodeLocals(decls: { count: number; type: number }[]): number[] {
    return [...encodeULEB(decls.length), ...decls.flatMap(d => [...encodeULEB(d.count), d.type])];
}

function funcBody(locals: { count: number; type: number }[], instr: number[]): number[] {
    const body = [...encodeLocals(locals), ...instr.flat()];
    return [...encodeULEB(body.length), ...body];
}

// ── IMA ADPCM Tables ─────────────────────────────────────────────────────────

// Standard IMA ADPCM step table — 89 entries
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

// Standard IMA index adjustment table — 16 entries (signed, -1 or positive)
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// Memory offsets for the tables
const IDX_TBL_ADDR = 0x0000; // 16 bytes (i8's — stored as unsigned, decoded as signed in WASM)
const STEP_TBL_ADDR = 0x0010; // 89 * 2 bytes = 178 bytes (i16 LE)
const BUF_START = 0x0200; // First byte available for caller buffers

// ── encode_adpcm function body ────────────────────────────────────────────────
//
// Signature: (pcmPtr: i32, numSamples: i32, outPtr: i32) -> i32
//
// Locals (all i32):
//   0: pcmPtr     1: numSamples   2: outPtr
//   3: valpred    4: index        5: step
//   6: i          7: sample       8: diff
//   9: vpdiff     10: sign        11: delta
//   12: nibble    13: outByte     14: oddFlag   15: outLen
//
// The function writes a 4-byte header, then the nibble stream.
// Returns total bytes written (4 + ceil(numSamples/2)).
//
function buildEncodeBody(): number[] {
    // Param indices are 0,1,2. Locals start at 3.
    const valpred = 3, index = 4, step = 5, i = 6, sample = 7, diff = 8;
    const vpdiff = 9, sign = 10, delta = 11, nibble = 12, outByte = 13, odd = 14, outLen = 15;

    const body = [
        // --- write 4-byte header ---
        // header[0..1] = numSamples (u16 LE)
        ...GET(2), ...GET(1), ...STORE16(0, 0),
        // header[2] = 0 (initial predictor)
        ...GET(2), ...CI32(0), ...STORE8(0, 2),
        // header[3] = 0 (initial step index)
        ...GET(2), ...CI32(0), ...STORE8(0, 3),

        // valpred = 0, index = 0, i = 0, outByte = 0, odd = 0
        ...CI32(0), ...SET(valpred),
        ...CI32(0), ...SET(index),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(outByte),
        ...CI32(0), ...SET(odd),

        // The nibble output starts at outPtr+4 (after header)
        // outLen tracks bytes written so far
        ...CI32(4), ...SET(outLen),

        // Main loop
        ...BLOCK, ...LOOP,
        // if i >= numSamples: break
        ...GET(i), ...GET(1), ...GE_s, ...BRIF(1),

        // sample = mem_i16[pcmPtr + i*2]
        ...GET(0), ...GET(i), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(sample),

        // step = STEP_TABLE[index] = mem_i16[STEP_TBL_ADDR + index*2]
        ...CI32(STEP_TBL_ADDR), ...GET(index), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(step),

        // diff = sample - valpred
        ...GET(sample), ...GET(valpred), ...SUB, ...SET(diff),

        // sign = (diff < 0) ? 8 : 0
        ...GET(diff), ...CI32(0), ...LT_s,
        ...CI32(3), ...SHL,   // shift bool (0 or 1) left by 3 → (0 or 8)
        ...SET(sign),

        // if diff < 0: diff = -diff
        ...GET(diff), ...CI32(0), ...LT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0),
        ...BR(1),
        ...END,
        ...CI32(0), ...GET(diff), ...SUB, ...SET(diff),
        ...END,

        // delta = 0, vpdiff = step >> 3
        ...CI32(0), ...SET(delta),
        ...GET(step), ...CI32(3), ...SHR_s, ...SET(vpdiff),

        // if diff >= step: delta |= 4, vpdiff += step, diff -= step
        ...GET(diff), ...GET(step), ...GE_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(delta), ...CI32(4), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...GET(diff), ...GET(step), ...SUB, ...SET(diff),
        ...END,

        // step >>= 1
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        // if diff >= step: delta |= 2, vpdiff += step, diff -= step
        ...GET(diff), ...GET(step), ...GE_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(delta), ...CI32(2), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...GET(diff), ...GET(step), ...SUB, ...SET(diff),
        ...END,

        // step >>= 1
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        // if diff >= step: delta |= 1, vpdiff += step
        ...GET(diff), ...GET(step), ...GE_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(delta), ...CI32(1), ...OR, ...SET(delta),
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,

        // nibble = delta | sign
        ...GET(delta), ...GET(sign), ...OR, ...SET(nibble),

        // update valpred: if sign: valpred -= vpdiff else valpred += vpdiff
        ...GET(sign), ...CI32(0), ...EQ,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        // sign != 0 branch (sign==8 means negative)
        ...GET(valpred), ...GET(vpdiff), ...SUB, ...SET(valpred),
        ...BR(1),
        ...END,
        ...GET(valpred), ...GET(vpdiff), ...ADD, ...SET(valpred),

        // clamp valpred to [-32768, 32767]
        // if valpred < -32768: valpred = -32768
        ...GET(valpred), ...CI32(-32768), ...LT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(-32768), ...SET(valpred),
        ...END,
        // if valpred > 32767: valpred = 32767
        ...GET(valpred), ...CI32(32767), ...GT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(32767), ...SET(valpred),
        ...END,

        // update index: index += INDEX_TABLE[nibble & 0xF]
        // INDEX_TABLE stored as unsigned bytes; values -1 stored as 0xFF → load then sign-extend via (v << 24) >> 24
        ...CI32(IDX_TBL_ADDR), ...GET(nibble), ...CI32(0x0F), ...AND, ...ADD,
        ...LOAD8s(0, 0),   // sign-extends: 0xFF → -1
        ...GET(index), ...ADD, ...SET(index),

        // clamp index to [0, 88]
        ...GET(index), ...CI32(0), ...LT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(0), ...SET(index),
        ...END,
        ...GET(index), ...CI32(88), ...GT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(88), ...SET(index),
        ...END,

        // pack nibble: if odd==0 → low nibble; if odd==1 → high nibble + flush byte
        ...GET(odd), ...CI32(0), ...EQ,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        // odd == 0: store nibble in low half of outByte
        ...GET(nibble), ...CI32(0x0F), ...AND, ...SET(outByte),
        ...CI32(1), ...SET(odd),
        ...BR(1),
        ...END,
        // odd == 1: store nibble in high half, flush byte to memory
        // outByte |= (nibble & 0xF) << 4
        ...GET(outByte), ...GET(nibble), ...CI32(0x0F), ...AND, ...CI32(4), ...SHL, ...OR, ...SET(outByte),
        // mem_i8[outPtr + outLen] = outByte
        ...GET(2), ...GET(outLen), ...ADD, ...GET(outByte), ...STORE8(0, 0),
        ...GET(outLen), ...CI32(1), ...ADD, ...SET(outLen),
        ...CI32(0), ...SET(outByte),
        ...CI32(0), ...SET(odd),

        // i++
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // If numSamples is odd, flush the last half-byte
        ...GET(odd), ...CI32(1), ...EQ,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(2), ...GET(outLen), ...ADD, ...GET(outByte), ...STORE8(0, 0),
        ...GET(outLen), ...CI32(1), ...ADD, ...SET(outLen),
        ...END,

        // return outLen
        ...GET(outLen),
        ...END,
    ];
    return funcBody([{ count: 13, type: I32 }], body);
}

// ── decode_adpcm function body ────────────────────────────────────────────────
//
// Signature: (adpcmPtr: i32, numBytes: i32, outPtr: i32) -> i32
//
// Reads 4-byte header, then decodes nibble stream.
// Returns number of PCM samples written (Int16 each).
//
// Locals (all i32):
//   0: adpcmPtr   1: numBytes   2: outPtr
//   3: valpred    4: index      5: step
//   6: i          7: byteVal    8: nibble
//   9: vpdiff     10: sign      11: delta   12: numSamples   13: decodedSrcs
//
function buildDecodeBody(): number[] {
    const valpred = 3, index = 4, step = 5, i = 6, byteVal = 7, nibble = 8;
    const vpdiff = 9, sign = 10, delta = 11, numSamples = 12, decoded = 13;

    const body = [
        // --- read 4-byte header ---
        // numSamples = u16 at adpcmPtr+0
        ...GET(0), ...LOAD16s(0, 0),
        // sign-extend from 16 to 32 then mask to 0xFFFF (treat as unsigned u16)
        ...CI32(0xFFFF), ...AND, ...SET(numSamples),

        // valpred = 0, index = 0, i = 0, decoded = 0
        ...CI32(0), ...SET(valpred),
        ...CI32(0), ...SET(index),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(decoded),

        // nibble data starts at adpcmPtr+4
        // Main loop: iterate over pairs of nibbles (each byte has 2)
        // We use byte index into adpcmPtr+4
        ...BLOCK, ...LOOP,
        // if decoded >= numSamples: break
        ...GET(decoded), ...GET(numSamples), ...GE_s, ...BRIF(1),
        // if byte offset >= numBytes-4: break (protect OOB)
        ...GET(i), ...CI32(2), ...SHR_u,  // byteIndex = i / 2
        ...GET(1), ...CI32(4), ...SUB,    // numBytes - 4 (data bytes)
        ...GE_s, ...BRIF(1),

        // byteVal = mem_i8[(adpcmPtr+4) + i/2] — unsigned
        ...GET(0), ...CI32(4), ...ADD, ...GET(i), ...CI32(1), ...SHR_u, ...ADD,
        ...LOAD8s(0, 0), ...CI32(0xFF), ...AND, ...SET(byteVal),

        // nibble = (i & 1 == 0) ? (byteVal & 0xF) : ((byteVal >> 4) & 0xF)
        ...GET(i), ...CI32(1), ...AND, ...CI32(0), ...EQ,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(byteVal), ...CI32(4), ...SHR_u, ...CI32(0xF), ...AND, ...SET(nibble),
        ...BR(1),
        ...END,
        ...GET(byteVal), ...CI32(0xF), ...AND, ...SET(nibble),

        // step = STEP_TABLE[index]
        ...CI32(STEP_TBL_ADDR), ...GET(index), ...CI32(1), ...SHL, ...ADD,
        ...LOAD16s(1, 0), ...SET(step),

        // sign = nibble & 0x8
        ...GET(nibble), ...CI32(8), ...AND, ...SET(sign),

        // delta = nibble & 0x7
        ...GET(nibble), ...CI32(7), ...AND, ...SET(delta),

        // vpdiff = step >> 3
        ...GET(step), ...CI32(3), ...SHR_s, ...SET(vpdiff),

        // if delta & 4: vpdiff += step
        ...GET(delta), ...CI32(4), ...AND,
        ...BLOCK, ...BLOCK,
        ...CI32(0), ...EQ, ...BRIF(0), ...BR(1), ...END,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        // if delta & 2: vpdiff += step
        ...GET(delta), ...CI32(2), ...AND,
        ...BLOCK, ...BLOCK,
        ...CI32(0), ...EQ, ...BRIF(0), ...BR(1), ...END,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,
        ...GET(step), ...CI32(1), ...SHR_s, ...SET(step),

        // if delta & 1: vpdiff += step
        ...GET(delta), ...CI32(1), ...AND,
        ...BLOCK, ...BLOCK,
        ...CI32(0), ...EQ, ...BRIF(0), ...BR(1), ...END,
        ...GET(vpdiff), ...GET(step), ...ADD, ...SET(vpdiff),
        ...END,

        // if sign != 0: valpred -= vpdiff  else valpred += vpdiff
        ...GET(sign), ...CI32(0), ...EQ,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...GET(valpred), ...GET(vpdiff), ...SUB, ...SET(valpred),
        ...BR(1),
        ...END,
        ...GET(valpred), ...GET(vpdiff), ...ADD, ...SET(valpred),

        // clamp valpred
        ...GET(valpred), ...CI32(-32768), ...LT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(-32768), ...SET(valpred),
        ...END,
        ...GET(valpred), ...CI32(32767), ...GT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(32767), ...SET(valpred),
        ...END,

        // update index
        ...CI32(IDX_TBL_ADDR), ...GET(nibble), ...CI32(0x0F), ...AND, ...ADD,
        ...LOAD8s(0, 0),
        ...GET(index), ...ADD, ...SET(index),

        // clamp index
        ...GET(index), ...CI32(0), ...LT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(0), ...SET(index),
        ...END,
        ...GET(index), ...CI32(88), ...GT_s,
        ...BLOCK, ...BLOCK,
        ...BRIF(0), ...BR(1), ...END,
        ...CI32(88), ...SET(index),
        ...END,

        // write valpred to outPtr + decoded*2
        ...GET(2), ...GET(decoded), ...CI32(1), ...SHL, ...ADD,
        ...GET(valpred), ...STORE16(1, 0),

        // decoded++, i++
        ...GET(decoded), ...CI32(1), ...ADD, ...SET(decoded),
        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // return decoded
        ...GET(decoded),
        ...END,
    ];
    return funcBody([{ count: 11, type: I32 }], body);
}

// ── Assemble final WASM binary ────────────────────────────────────────────────

export function buildAdpcmWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    // type section: 2 function types, both (i32,i32,i32)->i32
    const typeSection = section(1, [
        ...encodeULEB(2),
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32,
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32,
    ]);

    // function section: func 0 uses type 0, func 1 uses type 1
    const funcSection = section(3, [...encodeULEB(2), ...encodeULEB(0), ...encodeULEB(1)]);

    // memory: 1 page min (64 KB), max 2048 pages (128 MB)
    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(1), ...encodeULEB(2048)]);

    // exports: memory, encode_adpcm, decode_adpcm
    const exportSection = section(7, [
        ...encodeULEB(3),
        ...name("memory"), 0x02, ...encodeULEB(0),
        ...name("encode_adpcm"), 0x00, ...encodeULEB(0),
        ...name("decode_adpcm"), 0x00, ...encodeULEB(1),
    ]);

    // data section: initialize INDEX_TABLE and STEP_TABLE into linear memory
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
        ...encodeULEB(2),
        ...buildEncodeBody(),
        ...buildDecodeBody(),
    ]);

    return new Uint8Array([
        ...magic,
        ...typeSection,
        ...funcSection,
        ...memSection,
        ...exportSection,
        ...dataSection,
        ...codeSection,
    ]);
}

// ── Runtime wrapper ───────────────────────────────────────────────────────────

export interface AdpcmWasmExports {
    memory: WebAssembly.Memory;
    encode_adpcm: (pcmPtr: number, numSamples: number, outPtr: number) => number;
    decode_adpcm: (adpcmPtr: number, numBytes: number, outPtr: number) => number;
}

let _wasmPromise: Promise<AdpcmWasmExports> | null = null;

export function getAdpcmWasm(): Promise<AdpcmWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildAdpcmWasmBytes();
        const buf = bytes.buffer instanceof ArrayBuffer
            ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            : new Uint8Array(bytes).buffer;
        const mod = await WebAssembly.compile(buf as ArrayBuffer);
        const inst = await WebAssembly.instantiate(mod, {});
        return inst.exports as unknown as AdpcmWasmExports;
    })();
    return _wasmPromise;
}

// PCM buffer start address in WASM linear memory (after tables)
export const WASM_BUF = BUF_START;

/**
 * Encode a Float32Array of audio samples (-1..1) to ADPCM bytes.
 * Returns a Uint8Array containing the 4-byte header + compressed nibbles.
 */
export async function encodeAdpcm(float32Samples: Float32Array): Promise<Uint8Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    const numSamples = float32Samples.length;
    // each sample is i16 (2 bytes), output is 4-byte header + ceil(n/2) nibble bytes
    const pcmBytes = numSamples * 2;
    const outMaxBytes = 4 + Math.ceil(numSamples / 2);
    const totalNeeded = WASM_BUF + pcmBytes + outMaxBytes;

    // grow WASM memory if needed
    const PAGE = 65536;
    while (mem.buffer.byteLength < totalNeeded) {
        mem.grow(1);
    }

    const pcmPtr = WASM_BUF;
    const outPtr = WASM_BUF + pcmBytes;

    // convert Float32 → Int16 and write to WASM memory
    const view = new DataView(mem.buffer);
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, float32Samples[i]));
        view.setInt16(pcmPtr + i * 2, Math.round(s * 32767), true);
    }

    const bytesWritten = wasm.encode_adpcm(pcmPtr, numSamples, outPtr);
    return new Uint8Array(mem.buffer.slice(outPtr, outPtr + bytesWritten));
}

/**
 * Decode ADPCM bytes back to Float32Array (-1..1).
 * The first 4 bytes must be the header written by encodeAdpcm.
 */
export async function decodeAdpcm(adpcmBytes: Uint8Array): Promise<Float32Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    if (adpcmBytes.length < 4) throw new Error("adpcm: too short");
    const numSamples = new DataView(adpcmBytes.buffer, adpcmBytes.byteOffset, 4).getUint16(0, true);

    const inBytes = adpcmBytes.length;
    const outBytes = numSamples * 2;
    const totalNeeded = WASM_BUF + inBytes + outBytes;

    const PAGE = 65536;
    while (mem.buffer.byteLength < totalNeeded) {
        mem.grow(1);
    }

    const adpcmPtr = WASM_BUF;
    const outPtr = WASM_BUF + inBytes;

    new Uint8Array(mem.buffer).set(adpcmBytes, adpcmPtr);

    const samplesDecoded = wasm.decode_adpcm(adpcmPtr, inBytes, outPtr);

    // convert Int16 → Float32
    const out = new Float32Array(samplesDecoded);
    const dv = new DataView(mem.buffer);
    for (let i = 0; i < samplesDecoded; i++) {
        out[i] = dv.getInt16(outPtr + i * 2, true) / 32768;
    }
    return out;
}
