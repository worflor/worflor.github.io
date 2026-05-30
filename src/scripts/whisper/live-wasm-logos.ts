/**
 * live-wasm-logos.ts
 *
 * Logos — a universal adaptive entropy coder.
 * by Woflo / MB
 *
 * at zero dimensions there are no neighbors. no geometry, no spatial context.
 * just a stream of bytes and the question: what comes next?
 *
 * unless you tell it otherwise. set_stride(s) gives Logos one spatial axis:
 * the byte s positions back — the above-neighbor in a 2D raster, the plane
 * neighbor in 3D. one parameter bridges the gap that serialization created.
 * when stride = 0 (default), Logos is pure temporal. bit-identical output.
 *
 * the predictor is eight axes of attention (6 temporal + 1 thermodynamic + 1 spatial),
 * grounded in the same Boolean lattice / inclusion-exclusion math as the spatial
 * Möbius codecs:
 *
 * ── correlated witnesses (logit-space pool) ─────────────────────────────────
 *
 *   L  (intra-byte, 255 contexts): P(bit_k | all higher bits already decoded).
 *      MSB-first binary tree: ctx = (ctx << 1) | bit.
 *      the 255 internal nodes equal 2⁸−1, the non-trivial elements of Λ*(R⁸),
 *      the same 255 neighbors as the 8D Möbius predictor, folded into time.
 *
 *   U  (bit-lane temporal, 32 contexts): per-bit AR(2).
 *      slot = (bit_k(prev1) << 1) | bit_k(prev2).  4 slots × 8 lanes.
 *      catches oscillation, run-length, and sticky-bit structure.
 *
 *   X  (cross-subspace, 8192 contexts): 5-bit prefix (prev >>> 3) × bit tree.
 *      32 magnitude classes × 256 tree nodes × 2 counts = 16384 u32s = 64KB.
 *      fast-warming proxy for O2: 32 classes warm 8× faster than O2's 256.
 *
 *   O2 (full prev byte, 256×255 contexts): absolute position in Z_2^8.
 *      zeroth Möbius term over the byte stream. the exact byte identity.
 *
 *   Z  (XOR derivative, 256×255 contexts): prev1⊕prev2 as context.
 *      first temporal derivative. S={p1,p2} Möbius term in the spectral tower.
 *      O2 and Z together give a second-order byte-level Markov view.
 *
 *   E  (Engram AR(2), 256×255 contexts): damped oscillator b ≈ K·p1 − G·p2.
 *      5 decayed Cramer dot products → K,G → predicted next byte (0-255).
 *      the codec learns where the stream is going under its own inertia.
 *      spectral tower: O2(position) → Z(velocity) → E(trajectory).
 *
 *   P2N (coarse bigram, 16×255 contexts): prev byte nibble class (byte >> 4).
 *      16 nibble classes × 255 bit tree. captures two-byte structural patterns
 *      with 16× faster warm-up than O2's full 256 contexts.
 *
 *   V  (volatility, 16×255 contexts): log2 of L1 sum over the last 16 bytes.
 *      the GARCH conjugate of value prediction. while O2/E/P2N condition on
 *      WHICH BYTE comes next, V conditions on HOW LOUD the local neighborhood
 *      is. the missing scale observable: every prior axis tracks first moments
 *      of the byte process, V tracks the second moment. heteroscedastic envelopes
 *      (Burg residuals, AR fits, lifting transforms) are invisible to first-moment
 *      axes but show up as long-memory in the local L1.
 *      thermodynamic framing: O2 is position, V is local temperature.
 *
 * ── independent witnesses (log-odds injection) ──────────────────────────────
 *
 *   M  (exact match, 32-byte context): PPM exclusion, best-order accumulation.
 *      scans 32KB of history for positions where the exact byte sequence matches.
 *      per-bit trie filtering narrows the match set as each bit is resolved.
 *
 *   A  (structural attention): matches on byte CLASS (top nibble = byte >>> 4).
 *      M is the exact-match head; A is the soft-attention head. together they
 *      are multi-head attention, derived from first principles.
 *
 * ── blending ─────────────────────────────────────────────────────────────────
 *
 * logit-space mixing (7 correlated axes):
 *   lambda = Σ(w_i × logit(p_i)) / Σ(w_i)
 *   log-odds are additive for independent evidence sources.
 * M/A log-odds injection (independent hash-chain contexts):
 *   logit_final = lxScale×lambda + mScale×logit_M + aScale×logit_A
 * w_i = |p_i - 0.5| × min(log1p(n_i), 2) — confidence × capped evidence.
 * evidence cap at ~6 observations: KT posterior already encodes evidence
 * through p's position; uncapped log1p over-weights mature axes.
 * at KT prior (c0 = c1 = 0, p = 0.5): w = 0, all axes perfectly neutral.
 *
 * ── 3-state SSE (α = 0.05) ───────────────────────────────────────────────────
 *
 * 3 match states × 32 buckets × 16 nibble classes × 8 bit positions = 12288 cells.
 *   state 0 (gas):      no match active, table axes predict alone.
 *   state 1 (volatile): match just ended, v > 0, another imminent.
 *   state 2 (crystal):  confirmed match run, M-axis dominates.
 * separating these regimes prevents volatile-zone observations from polluting
 * the calibration of either pure-match or pure-non-match surfaces.
 *
 * ── thermodynamic evaporation ─────────────────────────────────────────────────
 *
 *   every 64 bytes:  f = e^(−(1−c)²),   c = confidence = min(1, 2·meanOpinion)
 *
 * structured data → high confidence → f → 1.  the counts freeze: crystal phase.
 * random data → low confidence → f → 1/e ≈ 0.368.  the counts melt: gas phase.
 * df/dc = 0 at the crystal boundary (Landau second-order). all axes share one
 * thermal bath.
 *
 * ── entropy monitor ──────────────────────────────────────────────────────────
 *
 * 256-byte sliding window of byte frequencies. when > 240 distinct values are
 * present (near-random), bypasses M/A axis searches entirely. cheap table
 * lookups handle the prediction alone. saves O(MAX_CHAIN × CTX) per byte on noise.
 *
 * ── implementation ────────────────────────────────────────────────────────────
 *
 * the entire codec is hand-written WebAssembly (logos.wat → logos.wasm, 7,252 bytes).
 * the WASM binary is inlined below as base64. zero dependencies.
 *
 * WASM memory layout (95 pages = 6.0 MB):
 *   uC          0x000800   i32[64]       U-axis counts (bit-lane temporal)
 *   sseC        0x010900   i32[24576]    SSE calibration grid
 *   hist        0x029000   u8[65536]     history ring buffer
 *   mPrev       0x039000   i32[32768]    M-axis prev chain
 *   mLast2      0x059000   i32[65536]    M-axis 2-byte hash
 *   matchBytes  0x0B9040   u8[256]       M candidate bytes
 *   matchW      0x0B9140   f64[256]      M candidate weights
 *   matchPos    0x0B9940   i32[256]      M candidate positions
 *   eFreq       0x0BAA40   u16[256]      entropy frequency table
 *   eWindow     0x0BAC40   u8[256]       entropy sliding window
 *   diagHist    0x0BAD40   i32[64]       run length histogram
 *   LOG1P       0x0BAE40   f64[4096]     ln(1+n) lookup table
 *   encBuf      0x0C3000   u8[1048576]   encoder output buffer
 *   inputBuf    0x1C3000   u8[1048576]   input data buffer
 *   decodeBuf   0x2C3000   u8[1048576]   decoder output buffer
 *   o2C         0x3C3000   i32[131072]   O2-axis counts (prev1 × bit tree)
 *   eC          0x4C3000   i32[131072]   E-axis counts (engPred × bit tree)
 *   p2nC        0x543000   i32[8192]     P2N-axis counts (nibble bigram × bit tree)
 *   f0C         0x558100   i32[512]      F0-axis counts (order-0 bit tree)
 *   abC         0x558900   i32[131072]   Ab-axis counts (above-neighbor × bit tree)
 *   volC        0x5D8900   i32[8192]     V-axis counts (volBin × bit tree)
 *   volWindow   0x5E0900   u8[16]        V-axis 16-byte ring buffer (rolling L1)
 *
 * 36 WASM globals hold scalar state at register speed. ~2.8MB predictor state + 3×1MB I/O buffers.
 * ln() and exp() are polynomial approximations — no JS Math dependency.
 *
 * the wire carries temporal attention residuals. the decoder reconstructs
 * byte streams from nine axes of context.
 */

// ── inlined WASM binary (logos.wasm, 6316 bytes) ────────────────────────────

const WASM_B64 = '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';

// ── WASM module singleton ───────────────────────────────────────────────────

interface LogosExports {
    mem: WebAssembly.Memory;
    init: () => void;
    set_stride: (s: number) => void;
    encode: (len: number) => number;
    decode: (origLen: number) => void;
    INPUT_BUF: WebAssembly.Global;
    ENC_BUF: WebAssembly.Global;
    DEC_BUF: WebAssembly.Global;
}

let _w: LogosExports | null = null;
let _p: Promise<LogosExports> | null = null;

function b64decode(s: string): Uint8Array {
    if (typeof atob === 'function') {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
}

function loadSync(): LogosExports {
    if (_w) return _w;
    const bytes = b64decode(WASM_B64);
    const mod = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    const inst = new WebAssembly.Instance(mod);
    _w = inst.exports as unknown as LogosExports;
    return _w;
}

async function loadAsync(): Promise<LogosExports> {
    if (_w) return _w;
    if (_p) return _p;
    _p = (async () => {
        const bytes = b64decode(WASM_B64);
        const mod = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
        const inst = new WebAssembly.Instance(mod);
        _w = inst.exports as unknown as LogosExports;
        return _w;
    })();
    return _p;
}

function w(): LogosExports {
    if (_w) return _w;
    return loadSync();
}

// ── public API ──────────────────────────────────────────────────────────────
//
// encode0D(data: Uint8Array, stride?: number) → Uint8Array
//   compress a byte buffer. returns a self-describing blob (mode byte + payload).
//   if compression doesn't help, falls back to raw passthrough automatically.
//   stride: optional spatial stride for 2D+ raster data (e.g. subband width).
//   when stride > 0, the Ab axis conditions on the byte at inputBuf[i - stride].
//   when stride = 0 (default), pure temporal mode — bit-identical to no-stride Logos.
//
// decode0D(encoded: Uint8Array, originalLength: number, stride?: number) → Uint8Array
//   decompress. you must know the original length (store it alongside the blob).
//   pass the same stride used during encoding.
//
// createInstance() → { encode0D, decode0D }
//   create an isolated codec instance with its own WASM memory.
//   use this for concurrent compression (web workers, parallel streams).
//   each instance is ~6MB of memory. instances are independent and thread-safe.
//
// mode byte prefix (first byte of encoded output):
//   0x00 = logos compressed (7-axis predictor + range coder)
//   0xFF = raw passthrough (incompressible data)
//
// guarantees:
//   output.length ≤ input.length + 1, always, by construction.
//   max input: 1MB. round-trip exact for all inputs.
//   works on any byte data: text, images, audio, video, binary formats.

const MAX_INPUT = 1048576;  // 1MB

/** codec binary size in bytes */
export const WASM_SIZE = 7252;

export function encode0D(data: Uint8Array, stride: number = 0): Uint8Array {
    if (data.length === 0) return new Uint8Array(0);
    if (data.length > MAX_INPUT)
        throw new Error(`logos: input too large (${data.length} > ${MAX_INPUT})`);

    const m = w();
    const inputOff = (m.INPUT_BUF as any).value as number;
    const encOff   = (m.ENC_BUF as any).value as number;
    const heap     = new Uint8Array(m.mem.buffer);

    heap.set(data, inputOff);
    m.set_stride(stride);
    const compLen = m.encode(data.length);

    // run-length histogram lives at diagHist (0x0BAD40)
    const diagOff = 0x0BAD40;
    const diagView = new Int32Array(m.mem.buffer, diagOff, 64);
    (encode0D as any)._lastDiag = { runLenHist: Array.from(diagView) };

    if (compLen >= data.length) {
        const out = new Uint8Array(1 + data.length);
        out[0] = 0xFF; out.set(data, 1);
        return out;
    }

    const out = new Uint8Array(1 + compLen);
    out[0] = 0x00;
    out.set(new Uint8Array(m.mem.buffer, encOff, compLen), 1);
    return out;
}

export function decode0D(data: Uint8Array, len: number, stride: number = 0): Uint8Array {
    if (len === 0) return new Uint8Array(0);
    if (len > MAX_INPUT)
        throw new Error(`decode0D: len too large (${len} > ${MAX_INPUT})`);
    if (data.length === 0) throw new Error('decode0D: empty input with non-zero len');

    const mode = data[0];

    if (mode === 0xFF) {
        if (data.length < 1 + len)
            throw new Error(`decode0D: raw payload too short (have ${data.length - 1}, need ${len})`);
        return data.slice(1, 1 + len);
    }

    if (mode !== 0x00)
        throw new Error(`decode0D: unknown mode byte 0x${mode.toString(16).padStart(2, '0')}`);

    const m = w();
    const inputOff = (m.INPUT_BUF as any).value as number;
    const decOff   = (m.DEC_BUF as any).value as number;
    const compBytes = data.subarray(1, 1 + MAX_INPUT);
    const heap = new Uint8Array(m.mem.buffer);

    heap.set(compBytes, inputOff);
    m.set_stride(stride);
    m.decode(len);

    return new Uint8Array(m.mem.buffer, decOff, len).slice();
}

export async function initLogosWasm(): Promise<void> {
    await loadAsync();
}

// ── isolated instances (for concurrent / parallel use) ───────────────────────

export interface LogosCodec {
    encode0D: (data: Uint8Array, stride?: number) => Uint8Array;
    decode0D: (data: Uint8Array, len: number, stride?: number) => Uint8Array;
}

/** create an independent codec instance with its own WASM memory.
 *  use for web workers, parallel asset pipelines, or any case where
 *  you need multiple codecs running concurrently without contention. */
export function createInstance(): LogosCodec {
    const bytes = b64decode(WASM_B64);
    const mod = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    const inst = new WebAssembly.Instance(mod);
    const m = inst.exports as unknown as LogosExports;

    function encode(data: Uint8Array, stride: number = 0): Uint8Array {
        if (data.length === 0) return new Uint8Array(0);
        if (data.length > MAX_INPUT)
            throw new Error(`logos: input too large (${data.length} > ${MAX_INPUT})`);

        const inputOff = (m.INPUT_BUF as any).value as number;
        const encOff   = (m.ENC_BUF as any).value as number;
        const heap     = new Uint8Array(m.mem.buffer);

        heap.set(data, inputOff);
        m.set_stride(stride);
        const compLen = m.encode(data.length);

        if (compLen >= data.length) {
            const out = new Uint8Array(1 + data.length);
            out[0] = 0xFF; out.set(data, 1);
            return out;
        }

        const out = new Uint8Array(1 + compLen);
        out[0] = 0x00;
        out.set(new Uint8Array(m.mem.buffer, encOff, compLen), 1);
        return out;
    }

    function decode(data: Uint8Array, len: number, stride: number = 0): Uint8Array {
        if (len === 0) return new Uint8Array(0);
        if (len > MAX_INPUT)
            throw new Error(`decode0D: len too large (${len} > ${MAX_INPUT})`);
        if (data.length === 0) throw new Error('decode0D: empty input with non-zero len');

        const mode = data[0];
        if (mode === 0xFF) {
            if (data.length < 1 + len)
                throw new Error(`decode0D: raw payload too short (have ${data.length - 1}, need ${len})`);
            return data.slice(1, 1 + len);
        }
        if (mode !== 0x00)
            throw new Error(`decode0D: unknown mode byte 0x${mode.toString(16).padStart(2, '0')}`);

        const inputOff = (m.INPUT_BUF as any).value as number;
        const decOff   = (m.DEC_BUF as any).value as number;
        const compBytes = data.subarray(1, 1 + MAX_INPUT);
        const heap = new Uint8Array(m.mem.buffer);

        heap.set(compBytes, inputOff);
        m.set_stride(stride);
        m.decode(len);

        return new Uint8Array(m.mem.buffer, decOff, len).slice();
    }

    return { encode0D: encode, decode0D: decode };
}

// ── test utilities ────────────────────────────────────────────────────────────

function idealEntropy(data: Uint8Array): number {
    if (data.length === 0) return 0;
    const counts = new Uint32Array(256);
    for (const b of data) counts[b]++;
    let H = 0;
    for (let i = 0; i < 256; i++) {
        if (counts[i] > 0) { const p = counts[i] / data.length; H -= p * Math.log2(p); }
    }
    return H;
}

function makeRandom(n: number, seed = 42): Uint8Array {
    const data = new Uint8Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        data[i] = (s >>> 24) & 0xFF;
    }
    return data;
}

function makeZipf(n: number, alpha = 1.0, seed = 42): Uint8Array {
    const cdf = new Float64Array(256);
    let norm = 0;
    for (let k = 1; k <= 256; k++) norm += Math.pow(k, -alpha);
    let acc = 0;
    for (let k = 0; k < 256; k++) { acc += Math.pow(k + 1, -alpha) / norm; cdf[k] = acc; }
    const data = new Uint8Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        const u = ((s >>> 1) & 0x7FFFFFFF) / 0x7FFFFFFF;
        let k = 0;
        while (k < 255 && cdf[k] < u) k++;
        data[i] = k;
    }
    return data;
}

// ── stress tests ──────────────────────────────────────────────────────────────

function roundTrip(label: string, data: Uint8Array): boolean {
    if (data.length === 0) { console.log(`[${label.padEnd(32)}] empty`); return true; }

    const encoded = encode0D(data);
    const decoded = decode0D(encoded, data.length);

    let errs = 0;
    for (let i = 0; i < data.length; i++) if (decoded[i] !== data[i]) errs++;

    const H   = idealEntropy(data);
    const bps = (encoded.length * 8) / data.length;
    const gap = bps - H;
    const ok  = errs === 0;
    const mode = encoded[0] === 0xFF ? 'raw' : 'logos';

    console.log(
        `[${label.padEnd(32)}]` +
        ` ${bps.toFixed(2).padStart(5)} b/s` +
        ` (H ${H.toFixed(2)}, gap ${gap >= 0 ? '+' : ''}${gap.toFixed(2)})` +
        `  ${ok ? '✓' : `✗${errs}err`}  [${mode}]`
    );
    return ok;
}

function runStressTests(): void {
    const te = new TextEncoder();
    let pass = 0, fail = 0;

    console.log('=== Whisper Logos: BondFieldBitTree (WASM) ===\n');
    console.log('axes: L (intra-byte tree) · U (AR(2) per bit lane) · X (MagnitudePrefix × tree)');
    console.log('      M (exact match, 32-byte ctx) · A (structural attention, nibble class)');
    console.log('blend: p = σ(logit_LX + s_U·logit_U + s_M·logit_M + s_A·logit_A)');
    console.log('evap:  f = e^(−(1−c)²),  c = min(1, 2·meanOpinion)\n');

    const run = (label: string, data: Uint8Array) => {
        const ok = roundTrip(label, data); ok ? pass++ : fail++;
    };

    // --- edge cases ---
    run('single byte 0x42',          new Uint8Array([0x42]));
    run('two diff bytes',            new Uint8Array([0x41, 0x42]));
    run('all zeros 256B',            new Uint8Array(256).fill(0));
    run('all 0xFF 256B',             new Uint8Array(256).fill(0xFF));

    // --- repeated / structured ---
    const alt = new Uint8Array(1024); for (let i = 0; i < 1024; i++) alt[i] = i & 1;
    run('alternating 0/1 1KB',       alt);
    run('single sym repeated 1KB',   new Uint8Array(1024).fill(0xAB));
    run('all zeros 4KB',             new Uint8Array(4096).fill(0));

    // --- ASCII text ---
    run('Hello World 13B',           te.encode('Hello, World!'));
    const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris ' +
        'nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in ' +
        'reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla ' +
        'pariatur. Excepteur sint occaecat cupidatat non proident, sunt in ' +
        'culpa qui officia deserunt mollit anim id est laborum.';
    run('Lorem ipsum 445B',          te.encode(lorem));
    run('Lorem ipsum ×4 1.8KB',      te.encode(lorem.repeat(4)));
    run('Lorem ipsum ×16 7KB',       te.encode(lorem.repeat(16)));

    // --- UTF-8 multi-byte ---
    run('emoji ×10',                 te.encode('🔥💧🌿⚡🪐✨🎵🎲🌀🔮🧬🌊🍃🌙'.repeat(10)));
    run('Japanese ×20',              te.encode('あいうえおかきくけこさしすせそたちつてと'.repeat(20)));
    run('Cyrillic ×20',              te.encode('Привет мир! Как дела? '.repeat(20)));

    // --- distributions ---
    run('uniform random 1KB',        makeRandom(1024));
    run('uniform random 4KB',        makeRandom(4096));
    run('uniform random 16KB',       makeRandom(16384));
    run('Zipf α=0.5 1KB',            makeZipf(1024, 0.5));
    run('Zipf α=1.0 1KB',            makeZipf(1024, 1.0));
    run('Zipf α=2.0 1KB',            makeZipf(1024, 2.0));
    run('Zipf α=3.0 4KB',            makeZipf(4096, 3.0));
    run('Zipf α=1.0 16KB',           makeZipf(16384, 1.0));
    run('Zipf α=2.0 16KB',           makeZipf(16384, 2.0));

    // --- structured binary ---
    const grad = new Uint8Array(1024); for (let i = 0; i < 1024; i++) grad[i] = i & 0xFF;
    run('linear gradient 1KB',       grad);

    // simulated PCM (sinusoid + noise, 16-bit LE)
    const pcm = new Uint8Array(2048); let s = 999;
    for (let i = 0; i < 1024; i++) {
        s = (s * 1664525 + 1013904223) | 0;
        const v = ((Math.sin(i * 0.1) * 0.8 + (((s >>> 24) / 255) - 0.5) * 0.2) * 32767) | 0;
        pcm[i * 2] = v & 0xFF; pcm[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    run('PCM audio bytes 2KB',       pcm);

    // --- residuals from spatial codecs ---
    console.log('\n--- residuals (downward pipe from spatial codecs) ---');
    const zigzag = (v: number) => (v << 1) ^ (v >> 31);
    const makeResiduals = (n: number, sigma: number, seed = 42) => {
        const data = new Uint8Array(n);
        let rs = seed;
        for (let i = 0; i < n; i++) {
            rs = (rs * 1664525 + 1013904223) | 0;
            const u = ((rs >>> 1) & 0x7FFFFFFF) / 0x7FFFFFFF - 0.5;
            const v = -sigma * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
            data[i] = zigzag(Math.round(v)) & 0xFF;
        }
        return data;
    };
    run('residuals σ=0.1 4KB',       makeResiduals(4096, 0.1));
    run('residuals σ=1.0 4KB',       makeResiduals(4096, 1.0));
    run('residuals σ=5.0 4KB',       makeResiduals(4096, 5.0));

    // AR(1) correlated residuals (U-axis dominant)
    const corrResid = new Uint8Array(4096);
    { let rs2 = 42, prev = 0;
      for (let i = 0; i < 4096; i++) {
          rs2 = (rs2 * 1664525 + 1013904223) | 0;
          prev = Math.round(prev * 0.8 + ((rs2 >>> 24) / 255 - 0.5) * 2);
          corrResid[i] = zigzag(prev) & 0xFF;
      }
    }
    run('correlated residuals 4KB',  corrResid);

    // 2-symbol biased
    const twoSym = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) twoSym[i] = i % 7 === 0 ? 1 : 0;
    run('2-sym biased 4KB (85% 0)',  twoSym);

    // --- X-axis: magnitude-conditional byte-class structure ---
    console.log('\n--- X-axis: magnitude-conditional structure ---');
    const hiragana = te.encode('あいうえおかきくけこさしすせそたちつてと'.repeat(50));
    const hiH = idealEntropy(hiragana);
    const hiBps = (encode0D(hiragana).length * 8) / hiragana.length;
    console.log(`Japanese UTF-8 (${hiragana.length}B): H=${hiH.toFixed(2)}, BFT=${hiBps.toFixed(2)}, gap=${(hiBps - hiH).toFixed(2)}`);
    console.log(`  X-axis (prev >>> 3): format-agnostic magnitude-class-conditional joint tree.`);

    // --- crystallization: L-axis freeze on long runs ---
    console.log('\n--- crystallization: L-axis freeze on repeated structure ---');
    const zerosChunks = [64, 256, 1024, 4096, 16384];
    for (const n of zerosChunks) {
        const enc = encode0D(new Uint8Array(n).fill(0));
        const bps = (enc.length * 8) / n;
        const bar = Math.round(bps / 8 * 20);
        console.log(`  zeros ${n.toString().padStart(6)}B: ${bps.toFixed(4)} b/s  [${'█'.repeat(Math.max(1, bar))}${'░'.repeat(Math.max(0, 20 - bar))}]`);
    }
    console.log('  → near-Shannon from L-axis crystallization. No Rice mode required.');

    // --- phase transition: structured → random → structured ---
    console.log('\n--- phase transition: structure → chaos → structure ---');
    const phase = new Uint8Array(3072);
    for (let i = 0; i < 1024; i++) phase[i] = i & 0xFF;
    const rand = makeRandom(1024, 7);
    phase.set(rand, 1024);
    for (let i = 0; i < 1024; i++) phase[2048 + i] = i & 0xFF;
    const phaseEnc = encode0D(phase);
    const phaseBps = (phaseEnc.length * 8) / phase.length;
    console.log(`  3KB phase sequence: ${phaseBps.toFixed(2)} b/s (H=${idealEntropy(phase).toFixed(2)})`);
    console.log(`  evaporation melts the stale crystal when chaos arrives. the model re-learns on return.`);

    console.log(`\nresult: ${pass} passed, ${fail} failed`);

    // --- the duality ---
    console.log('\n=== the duality: BondFieldBitTree ↔ 8D Möbius ===');
    console.log('');
    console.log('The L-axis has 255 internal tree nodes (ctx 1..255).');
    console.log('The 8D Möbius predictor interrogates 2⁸−1 = 255 spatial neighbors.');
    console.log('Both index the exact same structure: the Boolean lattice Λ*(R⁸).');
    console.log('');
    console.log('In the spatial codecs the Möbius cross-term Δx₁·…·Δxₙ·f spans multiple');
    console.log('voxels. At 0D there are no neighboring voxels. The cross-term collapses.');
    console.log('What remains is the pure temporal projection: the BondFieldBitTree.');
    console.log('');
    console.log('The chain rule P(byte) = P(b₇)·P(b₆|b₇)·…·P(b₀|b₇…b₁) and the');
    console.log('Möbius inclusion-exclusion are the same decomposition in different domains.');
    console.log('Both reduce the joint distribution over 2ⁿ outcomes to 2ⁿ−1 conditional');
    console.log('terms. The spatial codec lives in voxel space. Logos lives in time.');
    console.log('');
    console.log('The M and A axes are multi-head attention, derived from first principles:');
    console.log('  M: exact-match head. 32-byte context, PPM exclusion, per-bit trie filter.');
    console.log('  A: soft-attention head. nibble-class matching, same PPM + trie.');
    console.log('  M catches "the" repeating. A catches [lower][lower][space] structure.');
    console.log('  Together they generalize across languages with no language knowledge at all.');
}

function isDirectScriptExecution(fileBaseName: string): boolean {
    const normalize = (v: string) => v.replace(/\\/g, '/').toLowerCase();
    if (typeof process !== 'undefined' && typeof process.argv?.[1] === 'string') {
        const e = normalize(process.argv[1]);
        if (e.endsWith(`/${fileBaseName}.ts`) || e.endsWith(`/${fileBaseName}.js`)) return true;
    }
    const bun = (globalThis as { Bun?: { main?: string } }).Bun;
    if (typeof bun?.main === 'string') {
        const e = normalize(bun.main);
        return e.endsWith(`/${fileBaseName}.ts`) || e.endsWith(`/${fileBaseName}.js`);
    }
    return false;
}

if (isDirectScriptExecution('live-wasm-logos')) {
    runStressTests();
}
