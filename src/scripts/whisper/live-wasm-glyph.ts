/**
 * live-wasm-glyph.ts — Whisper Glyph 7D Online Ink Codec (Woflo / MB)
 *
 * compresses time-ordered pen motion, not just final vector shape.
 * (x, y) are the main path. pressure, tilt, azimuth ride alongside it.
 * most blocks use a damped harmonic oscillator in the complex plane.
 * short straight-ish runs can switch to a ballistic cubic predictor.
 * main predictor for sample n:
 *
 *   z[n] = K · z[n-1] − G · z[n-2]
 *
 * K, G are complex coefficients fitted per local block (up to 16 samples)
 * via complex least-squares (2×2 Hermitian normal equation, Cramer
 * solution) with Tikhonov regularization on the diagonal. after
 * quantization to Q14, the eigenvalue product and sum are clamped to the
 * stability manifold (|G| <= 1, |K| <= 2) so the oscillator never diverges.
 *
 * the seven dimensions:
 *   x  (explicit)  horizontal position, complex real part
 *   y  (explicit)  vertical position, complex imaginary part
 *   p  (explicit)  pressure / force side channel
 *   θ  (explicit)  tilt / altitude angle side channel
 *   φ  (explicit)  azimuth angle side channel
 *   t  (implicit)  time = sample index
 *   s  (implicit)  stroke identity = stream instance
 *
 * a circle has K = e^{iθ}, G = 0. a spiral has K = r·e^{iθ}. an ellipse
 * needs both K and G. curvature and damping live in the same algebraic
 * object: the eigenvalues λ₁, λ₂ of the characteristic equation
 * λ² − Kλ + G = 0 give the natural frequencies of the stroke segment.
 * the residuals cover what the fitted block law misses.
 *
 * ── prediction hierarchy ──────────────────────────────────────────────
 *
 * 7D input → mode select → sidecar/coupling/delta → Logos (0D)
 *
 * the oscillator lane handles loops, ellipses, cursive swings, and other
 * rhythmic segments. the ballistic lane handles short reaches, hooks,
 * taps, and straighter runs where cubic extrapolation is cheaper.
 * pressure, tilt, azimuth are coded with linear prediction, oscillator
 * reuse, or an independent sidecar fit:
 *
 *   default:  c[n] = 2·c[n-1] − c[n-2]           (linear extrapolation)
 *   coupled:  c[n] = kR·c[n-1] − gR·c[n-2]       (oscillator eigenvalues)
 *   fitted:   c[n] = k·c[n-1] − g·c[n-2]         (independent AR(2))
 *   velocity: c[n] = linear + α·|Δz[n]|           (pressure-speed coupling)
 *
 * the coupled trial reuses the oscillator's real coefficients kR/gR for
 * pressure with no extra fit bytes. if that is wrong, the codec falls
 * back to an independent sidecar fit or plain linear prediction.
 *
 * all sidecar trials are gated: only fire when they reduce total cost.
 *
 * ── implementation ────────────────────────────────────────────────────
 *
 * the predictor core is hand-written WebAssembly (glyph.wat → glyph.wasm):
 *   fit, encodeBlock, decodeBlock         complex oscillator + linear sidecars
 *   fitSidecar, encodeBlockSc, decodeBlockSc   fitted sidecar AR(2)
 *   couplingEst, encodeBlockCpl, decodeBlockCpl  velocity coupling
 *   microFit, microEnc, microDec          second-pass oscillator on residuals
 *   deltaResid, undeltaResid              first-difference pre-filter
 *
 * the js wrapper adds lane selection, batch-only short blocks on sharp
 * motion changes, and the ballistic lane. the WASM binary is inlined as
 * base64. zero dependencies beyond Logos.
 *
 * WASM memory layout (1 page = 64KB):
 *   POINTS  0x0000  i32[10240]  2048 pts × 5 channels
 *   RESID   0xA000  i32[80]     16 pts × 5 channels
 *   RESID2  0xA140  i32[32]     16 pts × 2 channels (micro-oscillator)
 *
 * ── wire format ─────────────────────────────────────────────────────────
 *
 * headers-first layout: all block headers and coefficients precede all
 * residuals. single Logos call on the combined stream. the Ab-axis stride
 * bridges across channel groups in the residual region.
 *
 *   short:    [rawLen:2 LE] [metaLen:1] [stride:1] [Logos(meta + data)]
 *   extended: [0,0] [rawLen:4 LE] [metaLen:2 LE] [stride:1] [Logos(meta + data)]
 *
 * meta region (per block):
 *   [header:1]  mode(bit 0) | (count-1)(bits 1-4) | repeat(bit 5)
 *               | chMask(bits 6-7). chMask=0b11 → extended byte follows.
 *   [ext:1]     (if chMask=0b11) bits 0-1=real chMask, bits 2-5=features,
 *               bits 6-7=primitive lane
 *   [coeffs]    zigzag varint deltas of kR,kI,gR,gI (harmonic only)
 *   [scK,scG]   zigzag varint deltas from baseline (if FEAT_SIDECAR)
 *   [cplW]      zigzag varint (if FEAT_COUPLING)
 *   [mkR..mgI]  zigzag varint (if FEAT_MICRO)
 *   [tiltK,tiltG,azimK,azimG] zigzag varint (if chMask=0b00, full stylus)
 *
 * data region (all blocks, channel-major):
 *   for each block: [ch0_pt0..ch0_ptN, ch1_pt0..ch1_ptN, ...]
 *   zigzag LEB128 varints. when FEAT_MICRO active, x,y come from
 *   micro secondary residuals; other channels from primary residuals.
 *
 * chMask (dimensional collapse / anti-causal free zeros):
 *   0b00: 5 channels — full stylus
 *   0b01: 3 channels (x, y, p) — basic stylus
 *   0b10: 2 channels (x, y) — mouse/finger
 *   0b11: extended header present (features byte follows)
 *
 * features (trial-gated, only present when non-zero):
 *   bit 0: FEAT_DELTA    delta pre-filter on residuals
 *   bit 1: FEAT_SIDECAR  fitted or coupled AR(2) for pressure
 *   bit 2: FEAT_COUPLING pressure predicted from velocity |Δz|
 *   bit 3: FEAT_MICRO    second-pass oscillator on x,y residuals
 *
 * ── streaming ───────────────────────────────────────────────────────────
 *
 * GlyphStreamEncoder accumulates points and emits fixed 16-point packets.
 * batch encode may cut earlier on sharp motion changes; live streaming
 * stays fixed-size. GlyphStreamDecoder reconstructs points from each packet.
 */

import { encode0D, decode0D, createInstance, type LogosCodec } from './live-wasm-logos';
import { fitMatrix3, predictMatrix3, type Mat3 } from './ga-predictor';

// cached Logos instance for micro trial comparison. avoids recompiling
// the WASM module per block (~1-5ms saved per micro trial).
let _microLogos: LogosCodec | null = null;
function getMicroLogos(): LogosCodec {
    if (!_microLogos) _microLogos = createInstance();
    return _microLogos;
}

export const GLYPH_BLOCK_SIZE = 16;

export const GLYPH_CHANNEL_NAMES = ['x', 'y', 'p', 'tilt', 'azimuth'] as const;
export const GLYPH_CHANNELS = GLYPH_CHANNEL_NAMES.length;

export type GlyphChannelName = typeof GLYPH_CHANNEL_NAMES[number];

export enum GlyphMode {
    HARMONIC = 0,
    LINEAR = 1,
    REPEAT = 2,
    // backward-adaptive: decoder re-estimates K/G by running fit() on
    // the WASM POINTS buffer (which contains previously decoded points).
    // encoder runs the same fit() on the original points (= decoded, since
    // prediction is lossless on integers). zero coefficient cost.
    // wire encoding: repeat=1, mode=1 (previously unused combination).
    BACKWARD = 3,
    // Cl(3) geometric algebra: 3×3 matrix AR(2) on (x, y, pressure).
    // predicts all three channels jointly via v[n] = M_K·v[n-1] - M_G·v[n-2].
    // captures pressure-curvature correlation that the split approach misses.
    GA = 4,
}

export enum GlyphLane {
    DEFAULT = 0,
    BALLISTIC = 1,
    // velrot: the eigenmotion restricted to eigenvalues {1, e^{i eps}} — a
    // single turning-rate coefficient (sin eps) instead of four K/G values.
    // 2D only (x,y); witness channels keep the default harmonic path.
    VELROT = 2,
    // GA: Cl(3) — a 3x3 matrix AR(2) coding (x, y, pressure) jointly. carries
    // 18 coefficients (M_K, M_G) on the wire; tilt/azimuth stay linear. couples
    // pressure to position dynamics. rarely cheapest, but lossless and correct.
    GA = 3,
}

// feature flags for v2 wire format
const FEAT_DELTA    = 1 << 0;
const FEAT_SIDECAR  = 1 << 1;
const FEAT_COUPLING = 1 << 2;
const FEAT_MICRO    = 1 << 3;
const FEAT_GA       = 1 << 4;

export interface GlyphCoeffs {
    kR: number;
    kI: number;
    gR: number;
    gI: number;
}

export interface GlyphBlock {
    lane: GlyphLane;
    mode: GlyphMode;
    kR: number;
    kI: number;
    gR: number;
    gI: number;
    residuals: Int32Array;
    // v2 features
    features: number;
    scK: number;
    scG: number;
    cplW: number;
    mkR: number;
    mkI: number;
    mgR: number;
    mgI: number;
    microResiduals: Int32Array | null;
    tiltK: number;
    tiltG: number;
    azimK: number;
    azimG: number;
    // Cl(3) GA mode: 3×3 matrices M_K, M_G as Q14 fixed-point (row-major)
    gaK: Int16Array | null;
    gaG: Int16Array | null;
    // velrot lane: the single turning-rate coefficient sin(eps) in Q14. when
    // present (lane === VELROT) the x,y oscillator's K,G are reconstructed from
    // it (K = 1 + e^{i eps}, G = e^{i eps}); witness channels are unchanged.
    velSin?: number;
}

export type GlyphSeed = number[];

export interface GlyphEncodeOptions {
    // batch encode may cut before 16 on motion changes. streaming keeps fixed 16-point packets.
    adaptiveSegmentation?: boolean;
}

// ── inlined WASM binary ─────────────────────────────────────────────────────

const WASM_B64 = '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AADQQKKeqhADIR4gGEQAAAAAAADQQKKeqhADIR8gGUQAAAAAAADQQKKeqhADISAgH7cgH7eiICC3ICC3oqAhGyAbRAAAAAAAALBBZARARAAAAAAAANBAIBufoyEcIB+3IByinqohHyAgtyAcop6qISALIB23IB23oiAetyAet6KgIRsgG0QAAAAAAADQQWQEQEQAAAAAAADgQCAbn6MhHCAdtyAcop6qIR0gHrcgHKKeqiEeCyAdJAogHiQLIB8kDCAgJA0LlgMBFH9BACEQQYDAAiECQcDCAiEDIwohESMLIRIjDCETIw0hFCACKAIAEAEhCCACQQRqKAIAEAEhCSACQRRqKAIAEAEhBiACQRhqKAIAEAEhByADIAgQADYCACADQQRqIAkQADYCACAQIAgQABACaiAJEAAQAmohECADQQhqIQMgAyAGEAA2AgAgA0EEaiAHEAA2AgAgECAGEAAQAmogBxAAEAJqIRAgA0EIaiEDQQIhAQJAA0AgASAATg0BQYDAAiABQRRsaiECIAIoAgAQASEEIAJBBGooAgAQASEFIBG3IAa3oiAStyAHt6KhIBO3IAi3oiAUtyAJt6KhoUQAAAAAAAAQP6Ke/AIhCiARtyAHt6IgErcgBreioCATtyAJt6IgFLcgCLeioKFEAAAAAAAAED+invwCIQsgBCAKayEMIAUgC2shDSAMEAAhDiANEAAhDyADIA42AgAgA0EEaiAPNgIAIBAgDhACaiAPEAJqIRAgBiEIIAchCSAEIQYgBSEHIANBCGohAyABQQFqIQEMAAsLIBALyQEBCn9BFCELQQAhCkEAIQMCQANAIAMgAU4NASAKQYDAAiADQQRsaigCABACaiEKIANBAWohAwwACwsgAEEBayECAkADQCACQQFIDQFBACEDAkADQCADIAFODQFBgMACIAIgC2xqIANBBGxqIQRBgMACIAJBAWsgC2xqIANBBGxqIQUgBCgCABABIQYgBSgCABABIQcgBiAHayEIIAgQACEJIAQgCTYCACAKIAkQAmohCiADQQFqIQMMAAsLIAJBAWshAgwACwsgCguFAQEIf0EUIQlBASECAkADQCACIABODQFBACEDAkADQCADIAFODQFBgMACIAIgCWxqIANBBGxqIQRBgMACIAJBAWsgCWxqIANBBGxqIQUgBCgCABABIQYgBSgC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';

// ── WASM module singleton ─────────────────────────────────────────────────────

interface GlyphWasm {
    mem: WebAssembly.Memory;
    POINTS: WebAssembly.Global;
    RESID: WebAssembly.Global;
    RESID2: WebAssembly.Global;
    kR: WebAssembly.Global;
    kI: WebAssembly.Global;
    gR: WebAssembly.Global;
    gI: WebAssembly.Global;
    errSum: WebAssembly.Global;
    scK: WebAssembly.Global;
    scG: WebAssembly.Global;
    mkR: WebAssembly.Global;
    mkI: WebAssembly.Global;
    mgR: WebAssembly.Global;
    mgI: WebAssembly.Global;
    cplW: WebAssembly.Global;
    velSin: WebAssembly.Global;
    fit: (start: number, len: number) => void;
    fitVelrot: (start: number, len: number) => void;
    velrotKG: (sinQ: number) => void;
    encodeBlock: (start: number, len: number, mode: number) => number;
    decodeBlock: (cursor: number, count: number, mode: number,
                  kR: number, kI: number, gR: number, gI: number) => void;
    fitSidecar: (start: number, len: number, chIdx: number) => void;
    encodeBlockSc: (start: number, len: number, mode: number,
                    scK: number, scG: number) => number;
    decodeBlockSc: (cursor: number, count: number, mode: number,
                    kR: number, kI: number, gR: number, gI: number,
                    scK: number, scG: number) => void;
    couplingEst: (start: number, len: number) => void;
    encodeBlockCpl: (start: number, len: number, mode: number, cplW: number) => number;
    decodeBlockCpl: (cursor: number, count: number, mode: number,
                     kR: number, kI: number, gR: number, gI: number,
                     cplW: number) => void;
    microFit: (count: number) => void;
    microEnc: (count: number) => number;
    microDec: (count: number, mkR: number, mkI: number, mgR: number, mgI: number) => void;
    deltaResid: (count: number, nCh: number) => number;
    undeltaResid: (count: number, nCh: number) => void;
}

let _w: GlyphWasm | null = null;

function b64decode(s: string): Uint8Array {
    if (typeof atob === 'function') {
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
}

function w(): GlyphWasm {
    if (_w) return _w;
    const bytes = b64decode(WASM_B64);
    const mod = new WebAssembly.Module(bytes.buffer as ArrayBuffer);
    const inst = new WebAssembly.Instance(mod);
    _w = inst.exports as unknown as GlyphWasm;
    return _w;
}

function gval(g: WebAssembly.Global): number { return (g as any).value as number; }
function sval(g: WebAssembly.Global, v: number): void { (g as any).value = v; }

// capture sidecar K/G atomically after a fitSidecar call.
// fitSidecar writes to shared globals m.scK/m.scG which get overwritten
// on the next call, so this helper makes the read-after-write explicit.
function captureSidecar(m: any, start: number, len: number, chOff: number): [number, number] {
    m.fitSidecar(start, len, chOff);
    return [gval(m.scK), gval(m.scG)];
}

// ── codec ─────────────────────────────────────────────────────────────────────

const CH = GLYPH_CHANNELS;

// zigzag encode/decode for coefficient serialization
function zzEnc(v: number): number { return (v << 1) ^ (v >> 31); }
function zzDec(v: number): number { return (v >>> 1) ^ (0 - (v & 1)); }

// matches WASM f64.nearest (IEEE 754 roundTiesToEven, a.k.a. banker's rounding).
// Math.round rounds *.5 up; f64.nearest rounds *.5 to nearest even integer.
function roundEven(x: number): number {
    const r = Math.round(x);
    // only differs from Math.round when fractional part is exactly 0.5
    if (Math.abs(x - Math.trunc(x)) === 0.5) {
        // round to even: if rounded result is odd, go the other way
        return (r & 1) ? r - Math.sign(x) : r;
    }
    return r;
}

// varint byte cost estimate (matches WASM $vsz)
function vszCost(v: number): number {
    v = v >>> 0;
    const bits = 32 - Math.clz32(v | 1);
    return ((bits + 6) * 37) >>> 8;
}

// LINEAR baseline coefficients in Q14
const LIN_KR = 32768;  // K = 2.0 in Q14
const LIN_KI = 0;
const LIN_GR = 16384;  // G = 1.0 in Q14
const LIN_GI = 0;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

export class GlyphCodec {

    // ── varint (LEB128 unsigned, for serialization) ───────────────────────

    private static pushVarint(buf: number[], v: number): void {
        v >>>= 0;
        while (v >= 0x80) { buf.push((v & 0x7F) | 0x80); v >>>= 7; }
        buf.push(v & 0x7F);
    }

    private static readVarint(data: Uint8Array, off: { v: number }): number {
        let result = 0, shift = 0;
        while (off.v < data.length) {
            const b = data[off.v++];
            result |= (b & 0x7F) << shift;
            if (!(b & 0x80)) return result >>> 0;
            shift += 7;
            if (shift >= 35) break;
        }
        return result >>> 0;
    }

    private static pushSigned(buf: number[], v: number): void {
        this.pushVarint(buf, zzEnc(v));
    }

    private static readSigned(data: Uint8Array, off: { v: number }): number {
        return zzDec(this.readVarint(data, off));
    }

    // ── coefficient delta coding ─────────────────────────────────────────
    // encode K/G as zigzag varint deltas from a reference (previous block
    // or LINEAR baseline). returns estimated byte cost.

    private static coeffDeltaCost(kR: number, kI: number, gR: number, gI: number,
                                   refKR: number, refKI: number, refGR: number, refGI: number): number {
        return vszCost(zzEnc(kR - refKR)) + vszCost(zzEnc(kI - refKI)) +
               vszCost(zzEnc(gR - refGR)) + vszCost(zzEnc(gI - refGI));
    }

    private static pushCoeffDeltas(buf: number[], kR: number, kI: number, gR: number, gI: number,
                                    refKR: number, refKI: number, refGR: number, refGI: number): void {
        this.pushSigned(buf, kR - refKR);
        this.pushSigned(buf, kI - refKI);
        this.pushSigned(buf, gR - refGR);
        this.pushSigned(buf, gI - refGI);
    }

    // ── encode (WASM predictor, multi-feature trial) ─────────────────────

    private static phaseBoundaryScore(points: Int32Array, boundaryPt: number, nPts: number): number {
        if (boundaryPt < 1 || boundaryPt + 2 >= nPts) return 0;

        const p = (pt: number, ch: number): number => points[pt * CH + ch];
        const v0x = p(boundaryPt, 0) - p(boundaryPt - 1, 0);
        const v0y = p(boundaryPt, 1) - p(boundaryPt - 1, 1);
        const v1x = p(boundaryPt + 1, 0) - p(boundaryPt, 0);
        const v1y = p(boundaryPt + 1, 1) - p(boundaryPt, 1);
        const v2x = p(boundaryPt + 2, 0) - p(boundaryPt + 1, 0);
        const v2y = p(boundaryPt + 2, 1) - p(boundaryPt + 1, 1);

        const s0 = Math.hypot(v0x, v0y);
        const s1 = Math.hypot(v1x, v1y);
        const s2 = Math.hypot(v2x, v2y);
        const cross01 = v0x * v1y - v0y * v1x;
        const cross12 = v1x * v2y - v1y * v2x;
        const turn = Math.abs(cross01) / (s0 * s1 + 1);
        const jerk = Math.hypot(v2x - 2 * v1x + v0x, v2y - 2 * v1y + v0y) / (s0 + s1 + s2 + 1);
        const speedShock = Math.abs(s1 - s0) / (Math.max(s0, s1) + 1);

        let witnessJump = 0;
        witnessJump += Math.abs(p(boundaryPt + 1, 2) - p(boundaryPt, 2)) / 4096;
        witnessJump += Math.abs(p(boundaryPt + 1, 3) - p(boundaryPt, 3)) / 6144;
        witnessJump += Math.abs(p(boundaryPt + 1, 4) - p(boundaryPt, 4)) / 8192;

        const speedValley = (s1 < Math.min(s0, s2) * 0.65) ? 0.35 : 0;
        const curvatureFlip = (cross01 !== 0 && cross12 !== 0 && cross01 * cross12 < 0) ? 0.28 : 0;
        const salient =
            turn > 0.55 ||
            jerk > 0.45 ||
            speedShock > 0.6 ||
            witnessJump > 1.1 ||
            curvatureFlip > 0;

        if (!salient) return 0;

        return turn * 1.05 +
            jerk * 0.9 +
            speedShock * 0.55 +
            witnessJump * 0.28 +
            speedValley +
            curvatureFlip;
    }

    private static chooseBlockLen(points: Int32Array, startPt: number, nPts: number): number {
        const remaining = nPts - startPt;
        const maxLen = Math.min(GLYPH_BLOCK_SIZE, remaining);
        if (maxLen <= 4) return maxLen;

        let bestLen = maxLen;
        let bestScore = 1.1;

        for (let len = 4; len < maxLen; len++) {
            const score = this.phaseBoundaryScore(points, startPt + len - 1, nPts);
            if (score > bestScore) {
                bestScore = score;
                bestLen = len;
                if (score > 2.2) break;
            }
        }

        const tail = remaining - bestLen;
        if (bestLen < maxLen && tail > 0 && tail < 4 && bestScore < 1.8) {
            return maxLen;
        }
        return bestLen;
    }

    private static isBallisticFriendly(points: Int32Array, startPt: number, len: number): boolean {
        if (len < 4) return false;

        let turnSum = 0;
        let turnMax = 0;
        let accSamples = 0;
        let refAx = 0, refAy = 0, refMag = 0;
        let alignSum = 0;
        let twistSum = 0;

        for (let absPt = startPt; absPt < startPt + len; absPt++) {
            const v0x = points[(absPt - 1) * CH] - points[(absPt - 2) * CH];
            const v0y = points[(absPt - 1) * CH + 1] - points[(absPt - 2) * CH + 1];
            const v1x = points[absPt * CH] - points[(absPt - 1) * CH];
            const v1y = points[absPt * CH + 1] - points[(absPt - 1) * CH + 1];
            const s0 = Math.hypot(v0x, v0y);
            const s1 = Math.hypot(v1x, v1y);
            const turn = Math.abs(v0x * v1y - v0y * v1x) / (s0 * s1 + 1);
            turnSum += turn;
            if (turn > turnMax) turnMax = turn;

            if (absPt < 2) continue;
            const ax = points[absPt * CH] - 2 * points[(absPt - 1) * CH] + points[(absPt - 2) * CH];
            const ay = points[absPt * CH + 1] - 2 * points[(absPt - 1) * CH + 1] + points[(absPt - 2) * CH + 1];
            const amag = Math.hypot(ax, ay);
            if (amag < 2) continue;

            if (accSamples === 0) {
                refAx = ax;
                refAy = ay;
                refMag = amag;
            } else {
                alignSum += (ax * refAx + ay * refAy) / (amag * refMag + 1);
                twistSum += Math.abs(ax * refAy - ay * refAx) / (amag * refMag + 1);
            }
            accSamples++;
        }

        if (accSamples < 2) return false;

        const meanTurn = turnSum / len;
        const alignCount = Math.max(1, accSamples - 1);
        const meanAlign = alignSum / alignCount;
        const meanTwist = twistSum / alignCount;

        return turnMax < 0.42 &&
            meanTurn < 0.22 &&
            meanAlign > 0.8 &&
            meanTwist < 0.28;
    }

    private static buildBallisticBlock(points: Int32Array, startPt: number, len: number): GlyphBlock | null {
        if (!this.isBallisticFriendly(points, startPt, len)) return null;
        const residuals = new Int32Array(len * CH);

        for (let j = 0; j < len; j++) {
            const absPt = startPt + j;
            for (let c = 0; c < CH; c++) {
                const pred = absPt >= 3
                    ? 3 * points[(absPt - 1) * CH + c] - 3 * points[(absPt - 2) * CH + c] + points[(absPt - 3) * CH + c]
                    : 2 * points[(absPt - 1) * CH + c] - points[(absPt - 2) * CH + c];
                const diff = points[absPt * CH + c] - pred;
                if (diff < I32_MIN || diff > I32_MAX) return null;
                residuals[j * CH + c] = zzEnc(diff | 0);
            }
        }

        return {
            lane: GlyphLane.BALLISTIC,
            mode: GlyphMode.LINEAR,
            kR: 0,
            kI: 0,
            gR: 0,
            gI: 0,
            residuals,
            features: 0,
            scK: 0,
            scG: 0,
            cplW: 0,
            mkR: 0,
            mkI: 0,
            mgR: 0,
            mgI: 0,
            microResiduals: null,
            tiltK: 0,
            tiltG: 0,
            azimK: 0,
            azimG: 0,
            gaK: null, gaG: null,
        };
    }

    private static decodeBallisticBlock(
        heap: Int32Array,
        pointsOff: number,
        cursor: number,
        count: number,
        residuals: Int32Array
    ): void {
        for (let j = 0; j < count; j++) {
            const absPt = cursor + j;
            const dst = pointsOff + absPt * CH;
            const p1 = pointsOff + (absPt - 1) * CH;
            const p2 = pointsOff + (absPt - 2) * CH;
            const p3 = pointsOff + (absPt - 3) * CH;

            for (let c = 0; c < CH; c++) {
                const pred = absPt >= 3
                    ? 3 * heap[p1 + c] - 3 * heap[p2 + c] + heap[p3 + c]
                    : 2 * heap[p1 + c] - heap[p2 + c];
                heap[dst + c] = pred + zzDec(residuals[j * CH + c]);
            }
        }
    }

    private static estimateRawBlockCost(
        block: GlyphBlock,
        hasPrevCoeffs: boolean,
        prevKR: number,
        prevKI: number,
        prevGR: number,
        prevGI: number
    ): number {
        const count = block.residuals.length / CH;
        const chMask = this.detectChMask(block.residuals, count);
        const wireCh = this.maskChannels(chMask);
        const hasExt = block.features !== 0 || block.lane !== GlyphLane.DEFAULT;

        let cost = 1 + (hasExt ? 1 : 0);

        if (block.lane === GlyphLane.DEFAULT && block.mode === GlyphMode.HARMONIC) {
            const refKR = hasPrevCoeffs ? prevKR : LIN_KR;
            const refKI = hasPrevCoeffs ? prevKI : LIN_KI;
            const refGR = hasPrevCoeffs ? prevGR : LIN_GR;
            const refGI = hasPrevCoeffs ? prevGI : LIN_GI;
            cost += this.coeffDeltaCost(block.kR, block.kI, block.gR, block.gI, refKR, refKI, refGR, refGI);
        }

        if (block.lane === GlyphLane.VELROT) {
            // one turning-rate coefficient (absolute; pack delta-codes it)
            cost += vszCost(zzEnc(block.velSin ?? 0));
        }

        if (block.lane === GlyphLane.GA && block.gaK && block.gaG) {
            // 18 matrix coefficients (absolute; pack delta-codes them)
            for (let j = 0; j < 9; j++) cost += vszCost(zzEnc(block.gaK[j])) + vszCost(zzEnc(block.gaG[j]));
        }

        if (block.features & FEAT_SIDECAR) {
            cost += vszCost(zzEnc(block.scK - 32768));
            cost += vszCost(zzEnc(block.scG - 16384));
        }
        if (block.features & FEAT_COUPLING) {
            cost += vszCost(zzEnc(block.cplW));
        }
        if (block.features & FEAT_MICRO) {
            cost += vszCost(zzEnc(block.mkR));
            cost += vszCost(zzEnc(block.mkI));
            cost += vszCost(zzEnc(block.mgR));
            cost += vszCost(zzEnc(block.mgI));
        }
        if (chMask === 0b00) {
            cost += vszCost(zzEnc(block.tiltK));
            cost += vszCost(zzEnc(block.tiltG));
            cost += vszCost(zzEnc(block.azimK));
            cost += vszCost(zzEnc(block.azimG));
        }

        if ((block.features & FEAT_MICRO) && block.microResiduals) {
            for (let i = 0; i < count; i++) cost += vszCost(block.microResiduals[i * 2]);
            for (let i = 0; i < count; i++) cost += vszCost(block.microResiduals[i * 2 + 1]);
            for (let c = 2; c < wireCh; c++) {
                for (let i = 0; i < count; i++) cost += vszCost(block.residuals[i * CH + c]);
            }
        } else {
            for (let c = 0; c < wireCh; c++) {
                for (let i = 0; i < count; i++) cost += vszCost(block.residuals[i * CH + c]);
            }
        }

        return cost;
    }

    // public entry: handles strokes of any length by encoding in windows that
    // fit the fixed WASM POINTS buffer, then concatenating. short strokes take
    // the single-window fast path unchanged.
    static encode(points: Int32Array, prev?: GlyphCoeffs, opts?: GlyphEncodeOptions): GlyphBlock[] {
        const WINDOW = 2048; // WASM POINTS buffer capacity (points, incl. 2 seeds)
        const totalPts = Math.floor(points.length / CH);
        if (totalPts <= WINDOW) return this.encodeWindow(points, prev, opts);

        // long stroke: encode in windows of WINDOW points that overlap by the 2
        // seed points, so the data blocks tile the stroke with no gap. each
        // window starts without a coefficient reference, so its first block is
        // never REPEAT/BACKWARD (which would need a cross-window reference whose
        // decoded value differs from the encoded one). every block thus carries
        // explicit coefficients, and pack/unpack preserve those values across the
        // whole concatenated list, so the stream decodes as one sequence. only
        // the first window honours the caller's `prev`.
        const blocks: GlyphBlock[] = [];
        let dataStart = 2;
        let first = true;
        while (dataStart < totalPts) {
            const seedStart = dataStart - 2;
            const winEnd = Math.min(seedStart + WINDOW, totalPts);
            const winBlocks = this.encodeWindow(points.subarray(seedStart * CH, winEnd * CH), first ? prev : undefined, opts);
            for (const b of winBlocks) blocks.push(b);
            first = false;
            dataStart = winEnd;
        }
        return blocks;
    }

    private static encodeWindow(points: Int32Array, prev?: GlyphCoeffs, opts?: GlyphEncodeOptions): GlyphBlock[] {
        const m = w();
        const maxPts = 2048;
        const nPts = Math.min(Math.floor(points.length / CH), maxPts);
        const pointsOff = gval(m.POINTS) >> 2;
        const residOff = gval(m.RESID) >> 2;
        const resid2Off = gval(m.RESID2) >> 2;
        const heap = new Int32Array(m.mem.buffer);
        const adaptiveSegmentation = opts?.adaptiveSegmentation ?? true;

        heap.set(points.subarray(0, nPts * CH), pointsOff);

        const blocks: GlyphBlock[] = [];
        let prevKR = prev?.kR ?? LIN_KR, prevKI = prev?.kI ?? LIN_KI;
        let prevGR = prev?.gR ?? LIN_GR, prevGI = prev?.gI ?? LIN_GI;
        let prevBlockStart = -1, prevBlockLen = 0;
        let hasPrev = !!prev;
        // preallocated per-block buffers (max block = GLYPH_BLOCK_SIZE × CH)
        const _residBuf = new Int32Array(GLYPH_BLOCK_SIZE * CH);
        const _microBuf = new Int32Array(GLYPH_BLOCK_SIZE * 2);

        for (let i = 2; i < nPts;) {
            const len = adaptiveSegmentation
                ? this.chooseBlockLen(points, i, nPts)
                : Math.min(GLYPH_BLOCK_SIZE, nPts - i);
            if (len < 1) break;

            // ── phase 1: find best primary mode (harmonic/linear/repeat) ──

            // harmonic: fit + encode
            m.fit(i - 2, len + 2);
            const hCost = m.encodeBlock(i, len, GlyphMode.HARMONIC);
            const hErr = gval(m.errSum);
            const hKR = gval(m.kR), hKI = gval(m.kI);
            const hGR = gval(m.gR), hGI = gval(m.gI);

            // linear: encode
            const lCost = m.encodeBlock(i, len, GlyphMode.LINEAR);
            const lErr = gval(m.errSum);

            // repeat: reuse previous block's coefficients (zero overhead).
            // skip when previous was linear — repeat of linear = linear.
            let rCost = Infinity, rErr = Infinity;
            const prevWasNonLinear = hasPrev && (prevKR !== LIN_KR || prevKI !== LIN_KI || prevGR !== LIN_GR || prevGI !== LIN_GI);
            if (prevWasNonLinear) {
                sval(m.kR, prevKR); sval(m.kI, prevKI);
                sval(m.gR, prevGR); sval(m.gI, prevGI);
                rCost = m.encodeBlock(i, len, GlyphMode.REPEAT);
                rErr = gval(m.errSum);
            }

            // backward-adaptive: re-estimate K/G from the previous block's
            // point data via fit(). the encoder's POINTS buffer has the original
            // points; the decoder's POINTS buffer has decoded points. since
            // prediction is lossless on integers, these are identical, so both
            // sides produce the same K/G from the same fit() call.
            // the fit range must match EXACTLY between encoder and decoder.
            // both use: fit(prevBlockStart, min(prevBlockLen + 2, available))
            let bCost = Infinity, bErr = Infinity;
            let bKR = 0, bKI = 0, bGR = 0, bGI = 0;
            if (prevBlockStart >= 0 && prevBlockLen >= 3) {
                // fit on the previous block's point range.
                // include 2 history points before the block for the AR(2) fit.
                const fitStart = Math.max(0, prevBlockStart - 2);
                const fitLen = prevBlockStart - fitStart + prevBlockLen;
                m.fit(fitStart, fitLen);
                bKR = gval(m.kR); bKI = gval(m.kI);
                bGR = gval(m.gR); bGI = gval(m.gI);
                sval(m.kR, bKR); sval(m.kI, bKI);
                sval(m.gR, bGR); sval(m.gI, bGI);
                bCost = m.encodeBlock(i, len, GlyphMode.HARMONIC);
                bErr = gval(m.errSum);
                bCost -= 8; // zero coefficient cost (decoder derives via fit)
            }

            // velrot: the eigenmotion restricted to eigenvalues {1, e^{i eps}},
            // a constrained harmonic carrying one turning-rate coefficient
            // (sin eps) instead of four K/G values. predicted exactly like a
            // harmonic block, so witness channels and phase-2 features compose
            // unchanged. it runs LAST, so RESID holds velrot residuals after this
            // point and any other winner re-encodes below.
            m.fitVelrot(i - 2, len + 2);
            const vSin = gval(m.velSin);
            const vCost = m.encodeBlock(i, len, GlyphMode.HARMONIC);
            const vErr = gval(m.errSum);
            const vKR = gval(m.kR), vKI = gval(m.kI), vGR = gval(m.gR), vGI = gval(m.gI);
            // drop the 8-byte harmonic coeff assumption, add the 1-byte extended
            // header and the single velSin varint (absolute; pack delta-codes it).
            const vAdjCost = vCost - 8 + 1 + vszCost(zzEnc(vSin));

            // compute coefficient delta costs for harmonic
            // try delta from previous AND delta from LINEAR baseline, pick cheaper
            const refKR = hasPrev ? prevKR : LIN_KR;
            const refKI = hasPrev ? prevKI : LIN_KI;
            const refGR = hasPrev ? prevGR : LIN_GR;
            const refGI = hasPrev ? prevGI : LIN_GI;
            const coeffCost = this.coeffDeltaCost(hKR, hKI, hGR, hGI, refKR, refKI, refGR, refGI);

            // harmonic total cost uses varint delta coefficients instead of fixed 8 bytes
            // the WASM encodeBlock returns cost assuming 8-byte coefficients for harmonic.
            // subtract 8 and add actual varint delta cost.
            const hAdjCost = hCost - 8 + coeffCost;

            // pick cheapest mode. velrot ran last, so RESID currently holds its
            // residuals; any non-velrot winner re-encodes below.
            let bestCost = hAdjCost, bestErr = hErr, bestMode = GlyphMode.HARMONIC;
            let bestIsVelrot = false;
            if (lCost < bestCost || (lCost === bestCost && lErr <= bestErr)) {
                bestCost = lCost; bestErr = lErr; bestMode = GlyphMode.LINEAR; bestIsVelrot = false;
            }
            if (rCost < bestCost || (rCost === bestCost && rErr <= bestErr)) {
                bestCost = rCost; bestErr = rErr; bestMode = GlyphMode.REPEAT; bestIsVelrot = false;
            }
            if (bCost < bestCost && bErr <= hErr * 2) {
                bestCost = bCost; bestErr = bErr; bestMode = GlyphMode.BACKWARD; bestIsVelrot = false;
            }
            if (vAdjCost < bestCost) {
                bestCost = vAdjCost; bestErr = vErr; bestMode = GlyphMode.HARMONIC; bestIsVelrot = true;
            }

            // restore RESID to the winner's residuals. velrot is already resident
            // (it was the last encode); every other winner re-encodes.
            let useKR = 0, useKI = 0, useGR = 0, useGI = 0;
            if (bestIsVelrot) {
                useKR = vKR; useKI = vKI; useGR = vGR; useGI = vGI;
            } else if (bestMode === GlyphMode.HARMONIC) {
                sval(m.kR, hKR); sval(m.kI, hKI);
                sval(m.gR, hGR); sval(m.gI, hGI);
                m.encodeBlock(i, len, GlyphMode.HARMONIC);
                useKR = hKR; useKI = hKI; useGR = hGR; useGI = hGI;
            } else if (bestMode === GlyphMode.BACKWARD) {
                sval(m.kR, bKR); sval(m.kI, bKI);
                sval(m.gR, bGR); sval(m.gI, bGI);
                m.encodeBlock(i, len, GlyphMode.HARMONIC);
                useKR = bKR; useKI = bKI; useGR = bGR; useGI = bGI;
            } else if (bestMode === GlyphMode.REPEAT) {
                sval(m.kR, prevKR); sval(m.kI, prevKI);
                sval(m.gR, prevGR); sval(m.gI, prevGI);
                m.encodeBlock(i, len, GlyphMode.REPEAT);
                useKR = prevKR; useKI = prevKI; useGR = prevGR; useGI = prevGI;
            } else {
                m.encodeBlock(i, len, GlyphMode.LINEAR);
            }

            // copy primary residuals + detect pressure in one pass
            const residuals = new Int32Array(len * CH);
            let hasPressure = false;
            for (let j = 0; j < len; j++) {
                const off = j * CH;
                residuals[off] = heap[residOff + off];
                residuals[off + 1] = heap[residOff + off + 1];
                residuals[off + 2] = heap[residOff + off + 2];
                residuals[off + 3] = heap[residOff + off + 3];
                residuals[off + 4] = heap[residOff + off + 4];
                if (residuals[off + 2] !== 0) hasPressure = true;
            }
            const baseCost = bestCost;

            // ── phase 2: trial v2 features on top of the winner ──
            // skip feature trials when residuals are negligible
            let features = 0;
            let scK = 0, scG = 0;
            let cplW = 0;
            let mkR = 0, mkI = 0, mgR = 0, mgI = 0;
            let microResiduals: Int32Array | null = null;

            if (baseCost > 4) {

            // magnitude sum of active channels — proxy for entropy.
            // smaller zigzag values → more concentrated around zero → better Logos.
            // this is the correct metric when all values fit in 1-byte varints
            // (which they do for pen strokes), where varint byte cost is constant.
            const chMaskBase = this.detectChMask(residuals, len);
            const wireChBase = this.maskChannels(chMaskBase);
            let baseMagSum = 0;
            for (let j = 0; j < len; j++) {
                for (let c = 0; c < wireChBase; c++) baseMagSum += residuals[j * CH + c];
            }

            // trial: sidecar AR(2) for pressure.
            // tries TWO candidates and picks the better:
            //   1. coupled: use the oscillator's kR/gR (same dynamics, may cost
            //      less overhead if kR/gR happen to be close to the optimal pressure k/g)
            //   2. independent: fit k/g to pressure data directly
            // pressure dynamics are independent of the position mode, so the
            // sidecar is tried for every mode including LINEAR (the dominant case
            // for real ink). on a linear block the coupled candidate degrades to
            // linear-pressure and simply loses; the independent fit does the work.
            if (hasPressure && len >= 4) {
                // candidate 1: coupled (oscillator's kR/gR for pressure)
                sval(m.kR, useKR); sval(m.kI, useKI);
                sval(m.gR, useGR); sval(m.gI, useGI);
                const coupledCost = m.encodeBlockSc(i, len, bestMode, useKR, useGR);
                const coupledOverhead = vszCost(zzEnc(useKR - 32768)) + vszCost(zzEnc(useGR - 16384));
                let coupledMag = 0;
                for (let j = 0; j < len; j++) {
                    for (let c = 0; c < wireChBase; c++) coupledMag += heap[residOff + j * CH + c];
                }

                // candidate 2: independent fit
                const [indepK, indepG] = captureSidecar(m, i - 2, len + 2, 8);
                sval(m.kR, useKR); sval(m.kI, useKI);
                sval(m.gR, useGR); sval(m.gI, useGI);
                const indepCost = m.encodeBlockSc(i, len, bestMode, indepK, indepG);
                const indepOverhead = vszCost(zzEnc(indepK - 32768)) + vszCost(zzEnc(indepG - 16384));
                let indepMag = 0;
                for (let j = 0; j < len; j++) {
                    for (let c = 0; c < wireChBase; c++) indepMag += heap[residOff + j * CH + c];
                }

                // pick the best candidate that beats the base
                const coupledTotal = coupledCost + coupledOverhead;
                const indepTotal = indepCost + indepOverhead;
                let bestScK = 0, bestScG = 0, bestScCost = Infinity;

                if (coupledTotal < baseCost && (coupledTotal < indepTotal || coupledMag < indepMag)) {
                    bestScK = useKR; bestScG = useGR; bestScCost = coupledTotal;
                } else if (indepTotal < baseCost && (indepK !== 32768 || indepG !== 16384)) {
                    bestScK = indepK; bestScG = indepG; bestScCost = indepTotal;
                }

                if (bestScCost < baseCost) {
                    features |= FEAT_SIDECAR;
                    scK = bestScK; scG = bestScG;
                    // re-encode only if winner wasn't the last trial (indep)
                    if (bestScK !== indepK || bestScG !== indepG) {
                        sval(m.kR, useKR); sval(m.kI, useKI);
                        sval(m.gR, useGR); sval(m.gI, useGI);
                        m.encodeBlockSc(i, len, bestMode, scK, scG);
                    }
                    for (let j = 0; j < len * CH; j++) residuals[j] = heap[residOff + j];
                } else {
                    for (let j = 0; j < len * CH; j++) heap[residOff + j] = residuals[j];
                }
            }

            // trial: cross-channel coupling (pressure ↔ velocity)
            if (hasPressure && len >= 4 && !(features & FEAT_SIDECAR)) {
                m.couplingEst(i - 2, len + 2);
                const trialCplW = gval(m.cplW);

                if (trialCplW !== 0) {
                    sval(m.kR, useKR); sval(m.kI, useKI);
                    sval(m.gR, useGR); sval(m.gI, useGI);
                    const cplCost = m.encodeBlockCpl(i, len, bestMode, trialCplW);
                    const cplOverhead = vszCost(zzEnc(trialCplW));

                    if (cplCost + cplOverhead < baseCost) {
                        features |= FEAT_COUPLING;
                        cplW = trialCplW;
                        // RESID already populated by the trial call above
                        for (let j = 0; j < len * CH; j++) residuals[j] = heap[residOff + j];
                    } else {
                        for (let j = 0; j < len * CH; j++) heap[residOff + j] = residuals[j];
                    }
                }
            }

            // at this point RESID has the best residuals. copy them back for
            // potential micro/delta trials.
            for (let j = 0; j < len * CH; j++) heap[residOff + j] = residuals[j];

            // micro-oscillator: trial uses an isolated Logos instance to compare
            // actual compressed size of primary vs secondary residuals.
            // this is the only reliable way to predict Logos's response.
            if (len >= 5) {
                m.microFit(len);
                const trialMkR = gval(m.mkR), trialMkI = gval(m.mkI);
                const trialMgR = gval(m.mgR), trialMgI = gval(m.mgI);

                if (trialMkR !== 0 || trialMkI !== 0 || trialMgR !== 0 || trialMgI !== 0) {
                    m.microEnc(len);

                    // build trial byte streams into preallocated buffers
                    const trialLen = len * 2;
                    const origArr = _microBuf.subarray(0, 0); // reuse _microBuf's underlying buffer
                    const origU8 = new Uint8Array(trialLen);
                    const microU8 = new Uint8Array(trialLen);
                    for (let j = 0; j < len; j++) origU8[j] = residuals[j * CH] & 0xFF;
                    for (let j = 0; j < len; j++) origU8[len + j] = residuals[j * CH + 1] & 0xFF;
                    for (let j = 0; j < len; j++) microU8[j] = heap[resid2Off + j * 2] & 0xFF;
                    for (let j = 0; j < len; j++) microU8[len + j] = heap[resid2Off + j * 2 + 1] & 0xFF;

                    const trial = getMicroLogos();
                    const origSize = trial.encode0D(origU8, len).length;
                    const microSize = trial.encode0D(microU8, len).length;

                    // micro coefficient wire cost
                    const microCoeffCost = vszCost(zzEnc(trialMkR)) + vszCost(zzEnc(trialMkI)) +
                                           vszCost(zzEnc(trialMgR)) + vszCost(zzEnc(trialMgI));

                    // only fire if micro x,y compresses smaller even with coefficient overhead
                    if (microSize + microCoeffCost + 1 < origSize) {
                        features |= FEAT_MICRO;
                        mkR = trialMkR; mkI = trialMkI;
                        mgR = trialMgR; mgI = trialMgI;
                        microResiduals = new Int32Array(len * 2);
                        for (let j = 0; j < len * 2; j++) microResiduals[j] = heap[resid2Off + j];
                    }
                }
            }

            // trial: delta pre-filter on residuals.
            // uses magnitude sum comparison, not varint byte count.
            // when all residuals fit in 1-byte varints (which they do for pen
            // strokes), varint cost is constant — only magnitude differences
            // matter for Logos compression quality.
            for (let j = 0; j < len * CH; j++) heap[residOff + j] = residuals[j];

            // delta and micro are incompatible: micro sends x,y through a separate
            // path (RESID2), but delta modifies x,y in RESID. the decoder can't
            // unmix them. when micro is active, skip delta.
            if (len >= 3 && !(features & FEAT_MICRO)) {
                const chMask = this.detectChMask(residuals, len);
                const wireCh = this.maskChannels(chMask);

                // magnitude sum before delta
                let origMag = 0;
                for (let j = 0; j < len; j++) {
                    for (let c = 0; c < wireCh; c++) origMag += residuals[j * CH + c];
                }

                // deltaResid modifies RESID in-place
                m.deltaResid(len, wireCh);

                // magnitude sum after delta
                let deltaMag = 0;
                for (let j = 0; j < len; j++) {
                    for (let c = 0; c < wireCh; c++) deltaMag += heap[residOff + j * CH + c];
                }

                // 5% margin: delta must reduce magnitudes enough to justify
                // the first-sample seed overhead and any pattern disruption
                if (deltaMag < origMag * 0.95) {
                    features |= FEAT_DELTA;
                    for (let j = 0; j < len * CH; j++) residuals[j] = heap[residOff + j];
                } else {
                    for (let j = 0; j < len * CH; j++) heap[residOff + j] = residuals[j];
                }
            }

            } // end if (baseCost > 4) feature trial gate

            let tiltK = 0, tiltG = 0, azimK = 0, azimG = 0;
            if (len >= 4) {
                [tiltK, tiltG] = captureSidecar(m, i - 2, len + 2, 12);
                [azimK, azimG] = captureSidecar(m, i - 2, len + 2, 16);
            }

            // ── build block ──

            // linear blocks ignore K,G on decode (and never serialise them), so a
            // near-straight stroke would otherwise carry a zero eigenmotion and be
            // indistinguishable from any other straight stroke. store the velrot-
            // fitted eigenmotion there instead: a curvature descriptor that gives
            // the seal/gesture engine a real shape signal at no cost to decode/pack.
            const isLin = bestMode === GlyphMode.LINEAR;
            let block: GlyphBlock = {
                lane: bestIsVelrot ? GlyphLane.VELROT : GlyphLane.DEFAULT,
                mode: bestMode,
                kR: isLin ? vKR : useKR, kI: isLin ? vKI : useKI,
                gR: isLin ? vGR : useGR, gI: isLin ? vGI : useGI,
                residuals,
                features,
                scK, scG,
                cplW,
                mkR, mkI, mgR, mgI,
                microResiduals,
                tiltK, tiltG, azimK, azimG,
                gaK: null, gaG: null,
                velSin: bestIsVelrot ? vSin : undefined,
            };

            const defaultRawCost = this.estimateRawBlockCost(block, hasPrev, prevKR, prevKI, prevGR, prevGI);
            const ballisticBlock = this.buildBallisticBlock(points, i, len);
            if (ballisticBlock) {
                const ballisticRawCost = this.estimateRawBlockCost(
                    ballisticBlock,
                    false,
                    LIN_KR,
                    LIN_KI,
                    LIN_GR,
                    LIN_GI
                );
                if (ballisticRawCost <= defaultRawCost) {
                    ballisticBlock.tiltK = tiltK;
                    ballisticBlock.tiltG = tiltG;
                    ballisticBlock.azimK = azimK;
                    ballisticBlock.azimG = azimG;
                    block = ballisticBlock;
                }
            }

            // ── phase 3: Cl(3) GA trial ──
            // fits a 3×3 matrix predictor on (x, y, pressure) jointly.
            // only fires when the block has pressure variation (otherwise the
            // split approach already handles it optimally).
            if (len >= 4 && hasPressure) {
                const gaFit = fitMatrix3(points, i, len, CH);
                // Q14 quantize: M_Kq = round(M_K * 16384), M_Gq = round(M_G * 16384)
                // then delta-encode M_Kq from identity (diagonal - 16384, off-diag - 0)
                const Q14 = 16384;
                const gaKq = new Int16Array(9);
                const gaGq = new Int16Array(9);
                const gaKdelta = new Int16Array(9); // for wire encoding
                for (let j = 0; j < 9; j++) {
                    gaKq[j] = Math.max(-32768, Math.min(32767, roundEven(gaFit.M_K[j] * Q14)));
                    gaGq[j] = Math.max(-32768, Math.min(32767, roundEven(gaFit.M_G[j] * Q14)));
                    const diag = (j === 0 || j === 4 || j === 8) ? Q14 : 0;
                    gaKdelta[j] = gaKq[j] - diag;
                }
                // recompute residuals with QUANTIZED matrices (integer prediction)
                const gaResiduals = new Int32Array(len * CH);
                // at extreme coordinate magnitudes the quantized GA matrix can
                // diverge and produce a residual outside int32; storing it in the
                // Int32Array would truncate and break losslessness. guard exactly
                // as the ballistic lane does and reject GA if it overflows.
                let gaValid = true;
                for (let n = 0; n < len; n++) {
                    const idx = i + n;
                    // Q14 matrix prediction: pred_c = Σ(M_Kq[c][j] * v1[j] - M_Gq[c][j] * v2[j]) / Q14
                    for (let c = 0; c < 3; c++) {
                        let pred = 0;
                        for (let j = 0; j < 3; j++) {
                            pred += gaKq[c * 3 + j] * points[(idx - 1) * CH + j]
                                  - gaGq[c * 3 + j] * points[(idx - 2) * CH + j];
                        }
                        const diff = points[idx * CH + c] - roundEven(pred / Q14);
                        if (diff < I32_MIN || diff > I32_MAX) gaValid = false;
                        gaResiduals[n * CH + c] = diff;
                    }
                    // tilt/azimuth: linear prediction
                    gaResiduals[n * CH + 3] = points[idx * CH + 3] - (2 * points[(idx - 1) * CH + 3] - points[(idx - 2) * CH + 3]);
                    gaResiduals[n * CH + 4] = points[idx * CH + 4] - (2 * points[(idx - 1) * CH + 4] - points[(idx - 2) * CH + 4]);
                }
                // estimate GA cost in varint bytes
                let gaCost = 2;
                for (let j = 0; j < 9; j++) {
                    gaCost += vszCost(zzEnc(gaKdelta[j]));
                    gaCost += vszCost(zzEnc(gaGq[j]));
                }
                const gaChMask = this.detectChMask(gaResiduals, len);
                const gaWireCh = this.maskChannels(gaChMask);
                for (let c = 0; c < gaWireCh; c++) {
                    for (let n = 0; n < len; n++) gaCost += vszCost(zzEnc(gaResiduals[n * CH + c]));
                }
                const currentCost = this.estimateRawBlockCost(block, hasPrev, prevKR, prevKI, prevGR, prevGI);
                // GA rides its own lane (GlyphLane.GA): the 18 matrix coefficients
                // are delta-coded on the wire and the block round-trips bit-exact.
                // gaValid rejects the rare extreme-magnitude block whose residual
                // would overflow int32. tilt/azimuth are coded linearly, so no
                // witness coefficients are carried.
                if (gaValid && gaCost < currentCost) {
                    block = {
                        lane: GlyphLane.GA,
                        mode: GlyphMode.GA,
                        kR: 0, kI: 0, gR: 0, gI: 0,
                        residuals: gaResiduals,
                        features: 0,
                        scK: 0, scG: 0, cplW: 0,
                        mkR: 0, mkI: 0, mgR: 0, mgI: 0,
                        microResiduals: null,
                        tiltK: 0, tiltG: 0, azimK: 0, azimG: 0,
                        gaK: gaKq, gaG: gaGq,
                    };
                }
            }

            blocks.push(block);

            if (block.lane !== GlyphLane.DEFAULT || block.mode === GlyphMode.LINEAR || block.mode === GlyphMode.GA) {
                hasPrev = false;
            } else {
                prevKR = block.kR; prevKI = block.kI;
                prevGR = block.gR; prevGI = block.gI;
                hasPrev = true;
            }
            prevBlockStart = i;
            prevBlockLen = len;
            i += len;
        }
        return blocks;
    }

    // ── decode (WASM predictor) ──────────────────────────────────────────

    static decode(blocks: GlyphBlock[], seed1: GlyphSeed, seed2: GlyphSeed): Int32Array {
        let total = 2;
        for (const b of blocks) total += b.residuals.length / CH;
        const out = new Int32Array(total * CH);
        out[0] = seed2[0]; out[1] = seed2[1]; out[2] = seed2[2]; out[3] = seed2[3]; out[4] = seed2[4];
        out[5] = seed1[0]; out[6] = seed1[1]; out[7] = seed1[2]; out[8] = seed1[3]; out[9] = seed1[4];

        // the WASM POINTS buffer holds 2048 points, so reconstruct in windows of
        // the same 2046-data-point stride that encode used. encode made each
        // window's first block self-contained (never REPEAT/BACKWARD), so each
        // window decodes from a fresh reference, re-seeded by the previous two
        // reconstructed points. short strokes are a single window (fast path).
        const DATA = 2048 - 2; // data points per window
        if (total - 2 <= DATA) { this.decodeBlocks(blocks, out, 2); return out; }

        let bi = 0, outPt = 2;
        while (bi < blocks.length) {
            const winBlocks: GlyphBlock[] = [];
            let winPts = 0;
            while (bi < blocks.length && winPts + blocks[bi].residuals.length / CH <= DATA) {
                winPts += blocks[bi].residuals.length / CH;
                winBlocks.push(blocks[bi]);
                bi++;
            }
            const buf = new Int32Array((winPts + 2) * CH);
            for (let c = 0; c < CH; c++) {
                buf[c] = out[(outPt - 2) * CH + c];
                buf[CH + c] = out[(outPt - 1) * CH + c];
            }
            this.decodeBlocks(winBlocks, buf, 2);
            out.set(buf.subarray(2 * CH, (winPts + 2) * CH), outPt * CH);
            outPt += winPts;
        }
        return out;
    }

    static decodeBlocks(blocks: GlyphBlock[], points: Int32Array, startIdx: number): void {
        const m = w();
        const pointsOff = gval(m.POINTS) >> 2;
        const residOff = gval(m.RESID) >> 2;
        const resid2Off = gval(m.RESID2) >> 2;
        const heap = new Int32Array(m.mem.buffer);

        const maxPts = 2048;
        const nExisting = Math.min(Math.floor(points.length / CH), maxPts);
        heap.set(points.subarray(0, nExisting * CH), pointsOff);

        let cursor = startIdx;
        let prevCursor = -1, prevCount = 0;
        // K/G tracking for REPEAT resolution (mirrors encoder's prevKR/prevGR)
        let decPrevKR = 0, decPrevKI = 0, decPrevGR = 0, decPrevGI = 0;
        let decHasPrev = false;
        for (const b of blocks) {
            const count = b.residuals.length / CH;
            if (cursor + count > nExisting) break;

            if (b.lane === GlyphLane.BALLISTIC) {
                this.decodeBallisticBlock(heap, pointsOff, cursor, count, b.residuals);
                decHasPrev = false;
                prevCursor = cursor;
                prevCount = count;
                cursor += count;
                continue;
            }

            // GA mode: Q14 integer 3×3 matrix prediction on (x, y, p)
            if (b.mode === GlyphMode.GA && b.gaK && b.gaG) {
                const Q14 = 16384;
                for (let n = 0; n < count; n++) {
                    const idx = cursor + n;
                    const off = idx * CH;
                    for (let c = 0; c < 3; c++) {
                        let pred = 0;
                        for (let j = 0; j < 3; j++) {
                            pred += b.gaK[c * 3 + j] * heap[pointsOff + (idx - 1) * CH + j]
                                  - b.gaG[c * 3 + j] * heap[pointsOff + (idx - 2) * CH + j];
                        }
                        heap[pointsOff + off + c] = roundEven(pred / Q14) + b.residuals[n * CH + c];
                    }
                    heap[pointsOff + off + 3] = (2 * heap[pointsOff + (idx - 1) * CH + 3] - heap[pointsOff + (idx - 2) * CH + 3]) + b.residuals[n * CH + 3];
                    heap[pointsOff + off + 4] = (2 * heap[pointsOff + (idx - 1) * CH + 4] - heap[pointsOff + (idx - 2) * CH + 4]) + b.residuals[n * CH + 4];
                }
                decHasPrev = false;
                prevCursor = cursor;
                prevCount = count;
                cursor += count;
                continue;
            }

            // velrot: reconstruct K,G from the single turning-rate coefficient.
            // identical computation on encode and decode, so the harmonic
            // predictor below sees exactly the K,G the encoder used.
            if (b.lane === GlyphLane.VELROT) {
                m.velrotKG(b.velSin ?? 0);
                b.kR = gval(m.kR); b.kI = gval(m.kI);
                b.gR = gval(m.gR); b.gI = gval(m.gI);
            } else
            // resolve K/G for backward and repeat modes.
            // this runs DURING decode (not unpack) so backward-derived K/G
            // are available for subsequent repeat blocks.
            if (b.mode === GlyphMode.BACKWARD && prevCursor >= 0 && prevCount >= 1) {
                const fitStart = Math.max(0, prevCursor - 2);
                const fitLen = prevCursor - fitStart + prevCount;
                m.fit(fitStart, fitLen);
                b.kR = gval(m.kR); b.kI = gval(m.kI);
                b.gR = gval(m.gR); b.gI = gval(m.gI);
            } else if (b.mode === GlyphMode.REPEAT && decHasPrev) {
                b.kR = decPrevKR; b.kI = decPrevKI;
                b.gR = decPrevGR; b.gI = decPrevGI;
            }

            // detect channel count for potential undelta
            const chMask = this.detectChMask(b.residuals, count);
            const wireCh = this.maskChannels(chMask);

            // load primary residuals into WASM RESID
            for (let j = 0; j < count * CH; j++) heap[residOff + j] = b.residuals[j];

            // if micro-oscillator is active, load secondary residuals into RESID2
            // and run WASM microDec to reconstruct primary x,y in RESID.
            // WASM-native decode guarantees exact f64.nearest matching.
            if ((b.features & FEAT_MICRO) && b.microResiduals) {
                for (let j = 0; j < count * 2; j++) heap[resid2Off + j] = b.microResiduals[j];
                m.microDec(count, b.mkR, b.mkI, b.mgR, b.mgI);
            }

            // undo delta pre-filter if active
            if (b.features & FEAT_DELTA) {
                m.undeltaResid(count, wireCh);
            }

            // decode based on features.
            // backward mode uses harmonic prediction with fit()-derived K/G.
            const wasmMode = b.mode === GlyphMode.BACKWARD ? GlyphMode.HARMONIC : b.mode;
            if (b.features & FEAT_SIDECAR) {
                m.decodeBlockSc(cursor, count, wasmMode,
                    b.kR, b.kI, b.gR, b.gI, b.scK, b.scG);
            } else if (b.features & FEAT_COUPLING) {
                m.decodeBlockCpl(cursor, count, wasmMode,
                    b.kR, b.kI, b.gR, b.gI, b.cplW);
            } else {
                m.decodeBlock(cursor, count, wasmMode, b.kR, b.kI, b.gR, b.gI);
            }
            // update K/G tracking for subsequent repeat blocks. velrot is
            // excluded: its K,G are derived from velSin, not a repeat reference
            // (matching encode/pack, where hasPrev is cleared after a velrot block).
            if (b.mode !== GlyphMode.LINEAR && b.lane !== GlyphLane.VELROT) {
                decPrevKR = b.kR; decPrevKI = b.kI;
                decPrevGR = b.gR; decPrevGI = b.gI;
                decHasPrev = true;
            } else {
                decHasPrev = false;
            }
            prevCursor = cursor;
            prevCount = count;
            cursor += count;
        }

        for (let i = startIdx * CH; i < cursor * CH; i++) {
            points[i] = heap[pointsOff + i];
        }
    }

    // ── dimensional collapse detection ──────────────────────────────────

    private static detectChMask(residuals: Int32Array, count: number): number {
        for (let i = 0; i < count; i++) {
            if (residuals[i * CH + 3] !== 0 || residuals[i * CH + 4] !== 0) return 0b00;
        }
        for (let i = 0; i < count; i++) {
            if (residuals[i * CH + 2] !== 0) return 0b01;
        }
        return 0b10;
    }

    private static maskChannels(mask: number): number {
        return mask === 0b10 ? 2 : mask === 0b01 ? 3 : CH;
    }

    // ── pack / unpack (headers-first layout with stride) ──────────────────
    //
    // layout: [all headers+coefficients] [all residuals (channel-major)]
    // single Logos call on the combined stream. headers go first so Logos
    // warms its O2 context on structural bytes. residuals form one contiguous
    // block where the Ab-axis stride gives cross-channel prediction.
    // stride = total residual bytes per channel across ALL blocks. the Ab-axis
    // at byte data[i] looks at data[i - stride], which is the same time-slot
    // in the previous channel.

    static pack(blocks: GlyphBlock[]): Uint8Array {
        const meta: number[] = [];
        const data: number[] = [];
        let prevKR = LIN_KR, prevKI = LIN_KI, prevGR = LIN_GR, prevGI = LIN_GI;
        let hasPrevCoeffs = false;
        let prevVelSin = 0; // delta reference for the velrot coefficient
        // delta references for the GA matrices: M_K starts at identity, M_G at zero
        let prevGaK = [LIN_GR, 0, 0, 0, LIN_GR, 0, 0, 0, LIN_GR];
        let prevGaG = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        let residPerChannel = 0; // total residual varint bytes per channel

        for (const b of blocks) {
            const count = b.residuals.length / CH;
            const chMask = this.detectChMask(b.residuals, count);
            const wireCh = this.maskChannels(chMask);

            // ── meta (headers + coefficients) ──

            const isRepeat = b.mode === GlyphMode.REPEAT;
            const isBackward = b.mode === GlyphMode.BACKWARD;
            // backward: repeat=1, mode=1 (previously unused combination). lane-coded
            // modes (GA) carry their mode in the ext byte's lane field, so the
            // header modeBit is held at 0 to avoid colliding with the count bits.
            const modeBit = b.lane === GlyphLane.GA ? 0 : (isBackward ? 1 : (isRepeat ? 0 : b.mode));
            const repeatBit = (isRepeat || isBackward) ? (1 << 5) : 0;
            const hasExt = b.features !== 0 || b.lane !== GlyphLane.DEFAULT;
            const headerChMask = hasExt ? 0b11 : chMask;
            meta.push(modeBit | ((count - 1) << 1) | repeatBit | (headerChMask << 6));

            if (hasExt) {
                meta.push(chMask | (b.features << 2) | (b.lane << 6));
            }

            if (b.lane === GlyphLane.DEFAULT && b.mode === GlyphMode.HARMONIC) {
                const refKR = hasPrevCoeffs ? prevKR : LIN_KR;
                const refKI = hasPrevCoeffs ? prevKI : LIN_KI;
                const refGR = hasPrevCoeffs ? prevGR : LIN_GR;
                const refGI = hasPrevCoeffs ? prevGI : LIN_GI;
                this.pushCoeffDeltas(meta, b.kR, b.kI, b.gR, b.gI, refKR, refKI, refGR, refGI);
            }

            if (b.lane === GlyphLane.VELROT) {
                // one turning-rate coefficient, delta-coded from the previous velrot block
                this.pushSigned(meta, (b.velSin ?? 0) - prevVelSin);
                prevVelSin = b.velSin ?? 0;
            }

            if (b.lane === GlyphLane.GA && b.gaK && b.gaG) {
                // 18 matrix coefficients (M_K then M_G), delta-coded from the
                // previous GA block (M_K from identity, M_G from zero initially).
                for (let j = 0; j < 9; j++) this.pushSigned(meta, b.gaK[j] - prevGaK[j]);
                for (let j = 0; j < 9; j++) this.pushSigned(meta, b.gaG[j] - prevGaG[j]);
                prevGaK = Array.from(b.gaK);
                prevGaG = Array.from(b.gaG);
            }

            if (b.features & FEAT_SIDECAR) {
                this.pushSigned(meta, b.scK - 32768);
                this.pushSigned(meta, b.scG - 16384);
            }
            if (b.features & FEAT_COUPLING) {
                this.pushSigned(meta, b.cplW);
            }
            if (b.features & FEAT_MICRO) {
                this.pushSigned(meta, b.mkR);
                this.pushSigned(meta, b.mkI);
                this.pushSigned(meta, b.mgR);
                this.pushSigned(meta, b.mgI);
            }
            if (chMask === 0b00) {
                this.pushSigned(meta, b.tiltK);
                this.pushSigned(meta, b.tiltG);
                this.pushSigned(meta, b.azimK);
                this.pushSigned(meta, b.azimG);
            }

            // ── data (residuals, channel-major) ──
            // track varint byte count per channel for stride calculation

            if ((b.features & FEAT_MICRO) && b.microResiduals) {
                const preLen = data.length;
                for (let i = 0; i < count; i++) this.pushVarint(data, b.microResiduals[i * 2]);
                const xBytes = data.length - preLen;
                for (let i = 0; i < count; i++) this.pushVarint(data, b.microResiduals[i * 2 + 1]);
                for (let c = 2; c < wireCh; c++) {
                    for (let i = 0; i < count; i++) this.pushVarint(data, b.residuals[i * CH + c]);
                }
                // first channel's byte count = stride candidate
                if (residPerChannel === 0) residPerChannel = xBytes;
            } else {
                const preLen = data.length;
                for (let c = 0; c < wireCh; c++) {
                    for (let i = 0; i < count; i++) this.pushVarint(data, b.residuals[i * CH + c]);
                    if (c === 0 && residPerChannel === 0) residPerChannel = data.length - preLen;
                }
            }

            // advance the coefficient-delta reference ONLY for harmonic blocks.
            // backward/repeat coefficients are derived during decode (from decoded
            // points), so they are unknown at unpack time — unpack therefore leaves
            // the reference untouched across them, and pack must do the same or the
            // next harmonic block's deltas decode against a mismatched baseline.
            if (b.lane === GlyphLane.DEFAULT && b.mode === GlyphMode.HARMONIC) {
                prevKR = b.kR; prevKI = b.kI;
                prevGR = b.gR; prevGI = b.gI;
                hasPrevCoeffs = true;
            } else if (b.lane !== GlyphLane.DEFAULT || b.mode === GlyphMode.LINEAR) {
                hasPrevCoeffs = false;
            }
            // backward / repeat: leave prevKR and hasPrevCoeffs unchanged
        }

        if (meta.length === 0 && data.length === 0) return new Uint8Array(0);

        // combine into single stream: [meta][data]
        const raw = new Uint8Array(meta.length + data.length);
        for (let i = 0; i < meta.length; i++) raw[i] = meta[i];
        for (let i = 0; i < data.length; i++) raw[meta.length + i] = data[i];

        // stride for Ab-axis: bytes per residual channel. during the meta
        // prefix the Ab-axis falls back to its default predictor. once the
        // residual region begins, stride lines channels up.
        const stride = residPerChannel;
        const compressed = encode0D(raw, stride);

        if (raw.length <= 0xFFFF && meta.length <= 0xFE) {
            // short header: 2-byte rawLen, 1-byte metaLen
            const out = new Uint8Array(4 + compressed.length);
            out[0] = raw.length & 0xFF;
            out[1] = (raw.length >> 8) & 0xFF;
            out[2] = meta.length & 0xFF;
            out[3] = stride & 0xFF;
            out.set(compressed, 4);
            return out;
        }

        // long header: raw/meta lengths no longer fit in the short form
        const out = new Uint8Array(9 + compressed.length);
        out[0] = 0;
        out[1] = 0;
        out[2] = raw.length & 0xFF;
        out[3] = (raw.length >> 8) & 0xFF;
        out[4] = (raw.length >> 16) & 0xFF;
        out[5] = (raw.length >> 24) & 0xFF;
        out[6] = meta.length & 0xFF;
        out[7] = (meta.length >> 8) & 0xFF;
        out[8] = stride & 0xFF;
        out.set(compressed, 9);
        return out;
    }

    static unpack(bytes: Uint8Array): GlyphBlock[] {
        if (bytes.length < 5) return [];
        let rawLen: number;
        let metaLen: number;
        let stride: number;
        let payloadOff: number;

        if (bytes[0] === 0 && bytes[1] === 0) {
            if (bytes.length < 9) return [];
            rawLen =
                (bytes[2]) |
                (bytes[3] << 8) |
                (bytes[4] << 16) |
                (bytes[5] << 24);
            rawLen >>>= 0;
            metaLen = bytes[6] | (bytes[7] << 8);
            stride = bytes[8];
            payloadOff = 9;
        } else {
            rawLen = bytes[0] | (bytes[1] << 8);
            metaLen = bytes[2];
            stride = bytes[3];
            payloadOff = 4;
        }
        if (rawLen === 0) return [];

        const raw = decode0D(bytes.subarray(payloadOff), rawLen, stride);
        // meta occupies raw[0..metaLen-1], data occupies raw[metaLen..]
        const blocks: GlyphBlock[] = [];
        const mOff = { v: 0 };        // meta cursor
        const dOff = { v: metaLen };   // data cursor (starts after meta)
        let prevKR = LIN_KR, prevKI = LIN_KI, prevGR = LIN_GR, prevGI = LIN_GI;
        let hasPrevCoeffs = false;
        let prevVelSin = 0; // delta reference for the velrot coefficient
        const prevGaK = [LIN_GR, 0, 0, 0, LIN_GR, 0, 0, 0, LIN_GR]; // GA M_K delta ref (identity)
        const prevGaG = [0, 0, 0, 0, 0, 0, 0, 0, 0];                // GA M_G delta ref (zero)

        try {
            while (mOff.v < metaLen) {
                const header = raw[mOff.v++];
                const modeBit = header & 1;
                const count = ((header >> 1) & 0xF) + 1;
                const isRepeat = (header & 0x20) !== 0;
                const headerChMask = (header >> 6) & 3;
                if (count > GLYPH_BLOCK_SIZE) break;

                let chMask: number;
                let features: number;
                let lane = GlyphLane.DEFAULT;
                if (headerChMask === 0b11) {
                    const ext = mOff.v < metaLen ? raw[mOff.v++] : 0;
                    chMask = ext & 3;
                    features = (ext >> 2) & 0xF;
                    lane = (ext >> 6) & 0x3;
                } else {
                    chMask = headerChMask;
                    features = 0;
                }
                const wireCh = this.maskChannels(chMask);

                let kR = 0, kI = 0, gR = 0, gI = 0;
                let velSin = 0;
                let gaK: Int16Array | null = null, gaG: Int16Array | null = null;
                let mode: GlyphMode;
                if (lane === GlyphLane.VELROT) {
                    // velrot: one delta-coded turning-rate coefficient. predicted
                    // as harmonic; K,G reconstructed from velSin during decodeBlocks.
                    mode = GlyphMode.HARMONIC;
                    velSin = this.readSigned(raw, mOff) + prevVelSin;
                    prevVelSin = velSin;
                    hasPrevCoeffs = false;
                } else if (lane === GlyphLane.GA) {
                    // GA: 18 delta-coded matrix coefficients (M_K then M_G)
                    mode = GlyphMode.GA;
                    gaK = new Int16Array(9); gaG = new Int16Array(9);
                    for (let j = 0; j < 9; j++) { gaK[j] = this.readSigned(raw, mOff) + prevGaK[j]; prevGaK[j] = gaK[j]; }
                    for (let j = 0; j < 9; j++) { gaG[j] = this.readSigned(raw, mOff) + prevGaG[j]; prevGaG[j] = gaG[j]; }
                    hasPrevCoeffs = false;
                } else if (lane !== GlyphLane.DEFAULT) {
                    mode = GlyphMode.LINEAR;
                    hasPrevCoeffs = false;
                } else if (isRepeat && modeBit === 1) {
                    // repeat=1, mode=1 → BACKWARD: K/G derived during decodeBlocks
                    mode = GlyphMode.BACKWARD;
                } else if (isRepeat) {
                    // REPEAT: K/G resolved during decodeBlocks (not here) so that
                    // REPEAT following BACKWARD gets the correct backward-derived K/G.
                    mode = GlyphMode.REPEAT;
                } else if (modeBit === GlyphMode.HARMONIC) {
                    mode = GlyphMode.HARMONIC;
                    const refKR = hasPrevCoeffs ? prevKR : LIN_KR;
                    const refKI = hasPrevCoeffs ? prevKI : LIN_KI;
                    const refGR = hasPrevCoeffs ? prevGR : LIN_GR;
                    const refGI = hasPrevCoeffs ? prevGI : LIN_GI;
                    kR = this.readSigned(raw, mOff) + refKR;
                    kI = this.readSigned(raw, mOff) + refKI;
                    gR = this.readSigned(raw, mOff) + refGR;
                    gI = this.readSigned(raw, mOff) + refGI;
                    prevKR = kR; prevKI = kI; prevGR = gR; prevGI = gI;
                    hasPrevCoeffs = true;
                } else {
                    mode = GlyphMode.LINEAR;
                    hasPrevCoeffs = false;
                }

                let scK = 32768, scG = 16384;
                if (features & FEAT_SIDECAR) {
                    scK = this.readSigned(raw, mOff) + 32768;
                    scG = this.readSigned(raw, mOff) + 16384;
                }

                let cplW = 0;
                if (features & FEAT_COUPLING) {
                    cplW = this.readSigned(raw, mOff);
                }

                let mkR = 0, mkI = 0, mgR = 0, mgI = 0;
                if (features & FEAT_MICRO) {
                    mkR = this.readSigned(raw, mOff);
                    mkI = this.readSigned(raw, mOff);
                    mgR = this.readSigned(raw, mOff);
                    mgI = this.readSigned(raw, mOff);
                }

                let tiltK = 0, tiltG = 0, azimK = 0, azimG = 0;
                if (chMask === 0b00) {
                    tiltK = this.readSigned(raw, mOff);
                    tiltG = this.readSigned(raw, mOff);
                    azimK = this.readSigned(raw, mOff);
                    azimG = this.readSigned(raw, mOff);
                }

                const residuals = new Int32Array(count * CH);
                let microResiduals: Int32Array | null = null;

                if (features & FEAT_MICRO) {
                    microResiduals = new Int32Array(count * 2);
                    for (let i = 0; i < count; i++) microResiduals[i * 2] = this.readVarint(raw, dOff);
                    for (let i = 0; i < count; i++) microResiduals[i * 2 + 1] = this.readVarint(raw, dOff);
                    for (let c = 2; c < wireCh; c++) {
                        for (let i = 0; i < count; i++) residuals[i * CH + c] = this.readVarint(raw, dOff);
                    }
                } else {
                    for (let c = 0; c < wireCh; c++) {
                        for (let i = 0; i < count; i++) residuals[i * CH + c] = this.readVarint(raw, dOff);
                    }
                }

                blocks.push({
                    lane,
                    mode, kR, kI, gR, gI, residuals,
                    features, scK, scG, cplW,
                    mkR, mkI, mgR, mgI, microResiduals,
                    tiltK, tiltG, azimK, azimG,
                    gaK, gaG,
                    velSin,
                });

                if (lane !== GlyphLane.DEFAULT) {
                    hasPrevCoeffs = false;
                } else if (mode === GlyphMode.BACKWARD || mode === GlyphMode.REPEAT) {
                    // K/G for backward and repeat are resolved during decodeBlocks,
                    // not here. backward derives via fit(), repeat copies from the
                    // decode-time prevK which includes backward-derived values.
                } else if (mode !== GlyphMode.LINEAR) {
                    prevKR = kR; prevKI = kI; prevGR = gR; prevGI = gI;
                    hasPrevCoeffs = true;
                } else {
                    hasPrevCoeffs = false;
                }
            }
        } catch { }
        return blocks;
    }
}

// ── streaming ─────────────────────────────────────────────────────────────────

export class GlyphStreamEncoder {
    private buffer = new Int32Array(GLYPH_BLOCK_SIZE * CH + CH * 2);
    private head = 2;
    constructor(seed: GlyphSeed) {
        for (let c = 0; c < CH; c++) {
            this.buffer[c] = seed[c];
            this.buffer[CH + c] = seed[c];
        }
    }
    push(values: ArrayLike<number>): Uint8Array | null {
        const base = this.head * CH;
        for (let c = 0; c < CH; c++) this.buffer[base + c] = values[c];
        this.head++;
        if (this.head === GLYPH_BLOCK_SIZE + 2) {
            // each chunk is self-contained: no cross-chunk coefficient state. the
            // decoder unpacks every chunk from the LINEAR baseline, so carrying
            // coefficients here would delta-code against a reference the decoder
            // never sees (silent corruption on curved strokes). the point seeds
            // below preserve prediction continuity; coefficients do not need to.
            const blocks = GlyphCodec.encode(this.buffer, undefined, { adaptiveSegmentation: false });
            const bytes = GlyphCodec.pack(blocks);
            const s1off = (this.head - 1) * CH;
            const s2off = (this.head - 2) * CH;
            for (let c = 0; c < CH; c++) {
                this.buffer[c] = this.buffer[s2off + c];
                this.buffer[CH + c] = this.buffer[s1off + c];
            }
            this.head = 2; return bytes;
        }
        return null;
    }
    /** flush partial block. call on stroke end. */
    flush(): Uint8Array | null {
        if (this.head <= 2) return null;
        return GlyphCodec.pack(GlyphCodec.encode(
            this.buffer.slice(0, this.head * CH),
            undefined,
            { adaptiveSegmentation: false }
        ));
    }
}

export class GlyphStreamDecoder {
    private points = new Int32Array(GLYPH_BLOCK_SIZE * CH + CH * 2);
    constructor(seed: GlyphSeed) {
        for (let c = 0; c < CH; c++) {
            this.points[c] = seed[c];
            this.points[CH + c] = seed[c];
        }
    }
    decode(bytes: Uint8Array): Int32Array {
        const blocks = GlyphCodec.unpack(bytes);
        if (blocks.length === 0) return new Int32Array(0);
        GlyphCodec.decodeBlocks(blocks, this.points, 2);
        const bufferPts = Math.floor(this.points.length / CH);
        let pointCount = 0;
        for (const block of blocks) {
            const blockPts = block.residuals.length / CH;
            if (2 + pointCount + blockPts > bufferPts) break;
            pointCount += blockPts;
        }
        if (pointCount === 0) return new Int32Array(0);
        const endPoint = 2 + pointCount;
        const result = this.points.slice(CH * 2, endPoint * CH);
        const s1off = (endPoint - 1) * CH;
        const s2off = (endPoint - 2) * CH;
        for (let c = 0; c < CH; c++) {
            this.points[c] = this.points[s2off + c];
            this.points[CH + c] = this.points[s1off + c];
        }
        return result;
    }
}
