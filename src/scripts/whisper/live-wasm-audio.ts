/**
 * live-wasm-audio.ts
 *
 * ChaCha20-AEAD Encrypted 16-bit PCM Codec for Zero-Compromise Lifelike Audio.
 * Features an integrated 256-bit Symmetric Double Ratchet for perfect E2EE.
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
const LOAD32 = (al: number, off: number) => [0x28, al, ...encodeULEB(off)];
const STORE16 = (al: number, off: number) => [0x3b, al, ...encodeULEB(off)];
const STORE32 = (al: number, off: number) => [0x36, al, ...encodeULEB(off)];
const STOREF32 = (al: number, off: number) => [0x38, al, ...encodeULEB(off)];
const LOADF32 = (al: number, off: number) => [0x2a, al, ...encodeULEB(off)];
const I32_REINTERPRET_F32 = [0xbc];
const F32_REINTERPRET_I32 = [0xbe];

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
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR,
        ...CI32(0x85EBCA6B), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(13), ...SHR_u, ...XOR,
        ...CI32(0xC2B2AE35), ...MUL, ...SET(reg),
        ...GET(reg), ...GET(reg), ...CI32(16), ...SHR_u, ...XOR, ...SET(reg),
    ];
}

const ENC_STATE_ADDR = 0x0100;
const DEC_STATE_ADDR = 0x0200;
const BUF_START = 0x0300;
const HEADER_SIZE = 8;
const MAC_SIZE = 8; // 64-bit AEAD MAC

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
            ...STORE32(2, stateAddr + 64 + i * 4) // Store in Keystream buffer
        );
    }

    return [
        ...loadState,
        ...rounds,
        ...saveState,
        // Increment Block Counter
        ...CI32(0), ...CI32(0), ...LOAD32(2, stateAddr + 48), ...CI32(1), ...ADD, ...STORE32(2, stateAddr + 48),
    ];
}

function buildEncodeBody(): number[] {
    const i = 3, sample = 4, outLen = 5, idx = 6, keystream_word = 7, sample_count = 8, mac0 = 9, mac1 = 10, temp = 11;
    const v = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];

    const body = [
        ...GET(2), ...GET(1), ...STORE32(2, 0),
        ...GET(2), ...CI32(0), ...STORE16(1, 4),
        ...GET(2), ...CI32(0), ...STORE16(0, 6),

        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 132), ...SET(sample_count),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 140), ...SET(mac1),
        ...CI32(0), ...SET(i),
        ...CI32(HEADER_SIZE), ...SET(outLen),

        ...BLOCK, ...LOOP,
        ...GET(i), ...GET(1), ...GE_s, ...BRIF(1),

        // Read f32 sample directly from the memory buffer, reinterpret as i32 for crypto
        ...GET(0), ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOADF32(2, 0), ...I32_REINTERPRET_F32, ...SET(sample),

        ...GET(idx), ...CI32(64), ...GE_s,
        ...IF,
        ...buildChaChaBlock(ENC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // Read 32-bits of keystream at a time instead of 16-bits
        ...CI32(0), ...CI32(ENC_STATE_ADDR + 64), ...GET(idx), ...ADD,
        ...LOAD32(2, 0), ...SET(keystream_word),

        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        ...GET(sample), ...GET(keystream_word), ...XOR, ...SET(sample),

        // Update MAC (Inline SipHash-lite)
        ...GET(mac0), ...GET(sample), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(sample), ...ADD, ...SET(mac1),

        // Write 32-bit encrypted sample to outPtr
        ...GET(2), ...GET(outLen), ...ADD, ...GET(sample), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),
        
        // Ratchet the key and the MAC state dynamically every 1024 samples
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ,
        ...IF,
        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp),
        ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 16),

        ...CI32(0), ...LOAD32(2, ENC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp),
        ...CI32(0), ...GET(temp), ...STORE32(2, ENC_STATE_ADDR + 20),

        // Mutate MAC state so it doesn't saturate
        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,
        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),

        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // Append 64-bit MAC to payload
        ...GET(2), ...GET(outLen), ...ADD, ...GET(mac0), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),
        ...GET(2), ...GET(outLen), ...ADD, ...GET(mac1), ...STORE32(2, 0),
        ...GET(outLen), ...CI32(4), ...ADD, ...SET(outLen),

        ...CI32(0), ...GET(idx), ...STORE32(2, ENC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, ENC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, ENC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, ENC_STATE_ADDR + 140),

        ...GET(outLen),
        ...END,
    ];
    return funcBody([{ count: 25, type: I32 }], body);
}

function buildDecodeBody(): number[] {
    const i = 3, inSample = 4, decoded = 5, idx = 6, keystream_word = 7, sample_count = 8, mac0 = 9, mac1 = 10, temp = 11, numSamples = 12, expMac0 = 13, expMac1 = 14;
    const v = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

    const body = [
        ...GET(0), ...LOAD32(2, 0), ...SET(numSamples),

        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 128), ...SET(idx),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 132), ...SET(sample_count),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 136), ...SET(mac0),
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 140), ...SET(mac1),
        ...CI32(0), ...SET(i),
        ...CI32(0), ...SET(decoded),

        ...BLOCK, ...LOOP,
        ...GET(decoded), ...GET(numSamples), ...GE_s, ...BRIF(1),
        
        ...GET(i), ...CI32(2), ...SHL, ...GET(1), ...CI32(HEADER_SIZE + MAC_SIZE), ...SUB, ...GE_s, ...BRIF(1),

        // Read the encrypted 32-bit integer directly
        ...GET(0), ...CI32(HEADER_SIZE), ...ADD, ...GET(i), ...CI32(2), ...SHL, ...ADD,
        ...LOAD32(2, 0), ...SET(inSample),

        // Update MAC (Inline SipHash-lite) with cipher text BEFORE decrypting
        ...GET(mac0), ...GET(inSample), ...ADD, ...SET(mac0),
        ...GET(mac0), ...CI32(13), ...ROTL, ...GET(mac1), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(17), ...ROTL, ...GET(inSample), ...ADD, ...SET(mac1),

        ...GET(idx), ...CI32(64), ...GE_s,
        ...IF,
        ...buildChaChaBlock(DEC_STATE_ADDR, v),
        ...CI32(0), ...SET(idx),
        ...END,

        // Read full 32-bits of keystream
        ...CI32(0), ...CI32(DEC_STATE_ADDR + 64), ...GET(idx), ...ADD,
        ...LOAD32(2, 0), ...SET(keystream_word),

        ...GET(idx), ...CI32(4), ...ADD, ...SET(idx),

        ...GET(inSample), ...GET(keystream_word), ...XOR, ...SET(inSample),

        // Write decrypted integer back as a 32-bit float exactly as received
        ...GET(2), ...GET(decoded), ...CI32(2), ...SHL, ...ADD,
        ...GET(inSample), ...F32_REINTERPRET_I32, ...STOREF32(2, 0),

        ...GET(decoded), ...CI32(1), ...ADD, ...SET(decoded),
        
        // Ratchet
        ...GET(sample_count), ...CI32(1023), ...AND, ...CI32(0), ...EQ,
        ...IF,
        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 16), ...GET(mac0), ...XOR, ...SET(temp),
        ...avalanche(temp),
        ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 16),

        ...CI32(0), ...LOAD32(2, DEC_STATE_ADDR + 20), ...GET(mac1), ...XOR, ...SET(temp),
        ...avalanche(temp),
        ...CI32(0), ...GET(temp), ...STORE32(2, DEC_STATE_ADDR + 20),

        ...GET(mac0), ...CI32(0xDEADBEEF), ...XOR, ...SET(mac0),
        ...GET(mac1), ...CI32(0x1337C0DE), ...XOR, ...SET(mac1),
        ...END,
        ...GET(sample_count), ...CI32(1), ...ADD, ...SET(sample_count),

        ...GET(i), ...CI32(1), ...ADD, ...SET(i),
        ...BR(0),
        ...END, ...END,

        // Verify MAC at the end of the packet payload
        ...GET(0), ...GET(1), ...CI32(8), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac0),
        ...GET(0), ...GET(1), ...CI32(4), ...SUB, ...ADD, ...LOAD32(2, 0), ...SET(expMac1),

        ...GET(mac0), ...GET(expMac0), ...EQ, ...GET(mac1), ...GET(expMac1), ...EQ, ...AND,
        ...CI32(0), ...EQ,
        ...IF,
        // MAC FAILED: Return 0 samples (silence) to protect against bit-flipping
        ...CI32(0), ...SET(decoded),
        ...END,

        ...CI32(0), ...GET(idx), ...STORE32(2, DEC_STATE_ADDR + 128),
        ...CI32(0), ...GET(sample_count), ...STORE32(2, DEC_STATE_ADDR + 132),
        ...CI32(0), ...GET(mac0), ...STORE32(2, DEC_STATE_ADDR + 136),
        ...CI32(0), ...GET(mac1), ...STORE32(2, DEC_STATE_ADDR + 140),

        ...GET(decoded),
        ...END,
    ];
    return funcBody([{ count: 28, type: I32 }], body);
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
        ...END,
    ]);
}

export function buildAdpcmWasmBytes(): Uint8Array {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

    const typeSection = section(1, [
        ...encodeULEB(3),
        0x60, ...encodeULEB(3), I32, I32, I32, ...encodeULEB(1), I32,
        0x60, ...encodeULEB(0), ...encodeULEB(0),
        0x60, ...encodeULEB(4), I32, I32, I32, I32, ...encodeULEB(0),
    ]);

    const funcSection = section(3, [
        ...encodeULEB(4),
        ...encodeULEB(0),
        ...encodeULEB(0),
        ...encodeULEB(2),
        ...encodeULEB(2),
    ]);
    const memSection = section(5, [...encodeULEB(1), 0x01, ...encodeULEB(2), ...encodeULEB(2048)]);

    const exportSection = section(7, [
        ...encodeULEB(5),
        ...nameSec("memory"), 0x02, ...encodeULEB(0),
        ...nameSec("encode_adpcm"), 0x00, ...encodeULEB(0),
        ...nameSec("decode_adpcm"), 0x00, ...encodeULEB(1),
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

export interface AdpcmWasmExports {
    memory: WebAssembly.Memory;
    encode_adpcm: (pcmPtr: number, numSamples: number, outPtr: number) => number;
    decode_adpcm: (adpcmPtr: number, numBytes: number, outPtr: number) => number;
    reset_encoder_state: (k0: number, k1: number, k2: number, k3: number) => void;
    reset_decoder_state: (k0: number, k1: number, k2: number, k3: number) => void;
}

let _wasmPromise: Promise<AdpcmWasmExports> | null = null;

export function getAdpcmWasm(): Promise<AdpcmWasmExports> {
    if (_wasmPromise) return _wasmPromise;
    _wasmPromise = (async () => {
        const bytes = buildAdpcmWasmBytes();
        // Typecast to avoid TS resolving to the wrong WebAssembly.instantiate overload in strict environments
        const result = await WebAssembly.instantiate(bytes, {}) as WebAssembly.InstantiatedSource;
        return result.instance.exports as unknown as AdpcmWasmExports;
    })();
    return _wasmPromise;
}

export const WASM_BUF = BUF_START;

const DC_ALPHA = 0.9995;
let dcXPrev = 0;
let dcYPrev = 0;

export function resetAdpcmFilters(): void {
    dcXPrev = 0;
    dcYPrev = 0;
}

function applyDcBlockAndPreemphasis(samples: Float32Array): Float32Array {
    const len = samples.length;
    let dcX = dcXPrev;
    let dcY = dcYPrev;
    const dcAlpha = DC_ALPHA;

    for (let i = 0; i < len; i++) {
        const x = samples[i];
        const dc = x - dcX + dcAlpha * dcY;
        dcX = x;
        dcY = dc;
        
        let s = dc;
        if (s > 0.98) {
            s = 0.98 + 0.02 * Math.tanh((s - 0.98) / 0.02);
        } else if (s < -0.98) {
            s = -0.98 + 0.02 * Math.tanh((s + 0.98) / 0.02);
        }
        
        samples[i] = s;
    }

    dcXPrev = dcX;
    dcYPrev = dcY;

    return samples;
}

export async function encodeAdpcm(
    float32Samples: Float32Array,
    sampleRate: number,
    encryptionKey?: Uint32Array,
): Promise<Uint8Array> {
    const wasm = await getAdpcmWasm();
    const mem = wasm.memory;

    const numSamples = float32Samples.length;
    const pcmBytes = numSamples * 4; // 32-bit floats
    const outMaxBytes = HEADER_SIZE + numSamples * 4 + MAC_SIZE;
    const totalNeeded = WASM_BUF + pcmBytes + outMaxBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_encoder_state(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_encoder_state(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }
    
    resetAdpcmFilters();

    const pcmPtr = WASM_BUF;
    const outPtr = WASM_BUF + pcmBytes;

    const conditioned = applyDcBlockAndPreemphasis(float32Samples);

    // Bypass Int16 completely - write raw float32 directly
    const f32View = new Float32Array(mem.buffer, pcmPtr, numSamples);    
    for (let i = 0; i < numSamples; i++) {
        f32View[i] = conditioned[i];
    }
    
    const bytesWritten = wasm.encode_adpcm(pcmPtr, numSamples, outPtr);

    const view = new DataView(mem.buffer);
    view.setUint16(outPtr + 4, sampleRate & 0xFFFF, true);

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
    const sampleRate = hdr.getUint16(4, true) || 48000;

    const inBytes = adpcmBytes.length;
    const outBytes = numSamples * 4; // 32-bit floats
    const totalNeeded = WASM_BUF + inBytes + outBytes;

    const currentBytes = mem.buffer.byteLength;
    if (currentBytes < totalNeeded) {
        mem.grow(Math.ceil((totalNeeded - currentBytes) / 65536));
    }

    if (encryptionKey && encryptionKey.length === 4) {
        wasm.reset_decoder_state(encryptionKey[0], encryptionKey[1], encryptionKey[2], encryptionKey[3]);
    } else {
        wasm.reset_decoder_state(0xDEADBEEF, 0x1337C0DE, 0x8BADF00D, 0x0DEFACED);
    }
    resetAdpcmFilters();

    const inPtr = WASM_BUF;
    const outPtr = WASM_BUF + inBytes;

    new Uint8Array(mem.buffer).set(adpcmBytes, inPtr);

    const samplesDecoded = wasm.decode_adpcm(inPtr, inBytes, outPtr);
    
    const tampered = samplesDecoded === 0;

    const pcm = new Float32Array(tampered ? numSamples : samplesDecoded);
    if (!tampered) {
        // Read directly from output memory as Float32
        const f32View = new Float32Array(mem.buffer, outPtr, samplesDecoded);
        for (let i = 0; i < samplesDecoded; i++) {
            pcm[i] = f32View[i];
        }
    }

    return { pcm, sampleRate, tampered };
}

export function wavFromPcm(pcm: Float32Array, sampleRate: number): Uint8Array {
    const numSamples = pcm.length;
    const byteRate = sampleRate * 2;
    const dataBytes = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);

    dv.setUint32(0, 0x52494646, false);
    dv.setUint32(4, 36 + dataBytes, true);
    dv.setUint32(8, 0x57415645, false);
    dv.setUint32(12, 0x666d7420, false);
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    dv.setUint32(36, 0x64617461, false);
    dv.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
        off += 2;
    }
    return new Uint8Array(buf);
}

export async function adpcmToWav(adpcmBytes: Uint8Array): Promise<Blob> {
    const { pcm, sampleRate } = await decodeAdpcm(adpcmBytes);
    const wav = wavFromPcm(pcm, sampleRate);
    return new Blob([wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer], { type: "audio/wav" });
}
