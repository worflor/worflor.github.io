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
}

export enum GlyphLane {
    DEFAULT = 0,
    BALLISTIC = 1,
}

// feature flags for v2 wire format
const FEAT_DELTA    = 1 << 0;
const FEAT_SIDECAR  = 1 << 1;
const FEAT_COUPLING = 1 << 2;
const FEAT_MICRO    = 1 << 3;

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
}

export type GlyphSeed = number[];

export interface GlyphEncodeOptions {
    // batch encode may cut before 16 on motion changes. streaming keeps fixed 16-point packets.
    adaptiveSegmentation?: boolean;
}

// ── inlined WASM binary ─────────────────────────────────────────────────────

const WASM_B64 = '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AbchByAEKAIAEAG3IQggBEEEaigCABABtyEJIAUoAgAQAbchCiAFQQRqKAIAEAG3IQsgDCAIIAiiIAkgCaKgoCEMIA0gCCAKoiAJIAuioKAhDSAOIAkgCqIgCCALoqGgIQ4gDyAKIAqiIAsgC6KgoCEPIBAgBiAIoiAHIAmioKAhECARIAcgCKIgBiAJoqGgIREgEiAGIAqiIAcgC6KgoCESIBMgByAKoiAGIAuioaAhEyABQQFqIQEMAAsLIAwgD6VEje21oPfGsD6iIRogDCAaoCEMIA8gGqAhDyAMIA+iIA0gDaIgDiAOoqChIRQgFJlEoMLr/ktItDljBEBBACQKQQAkC0EAJAxBACQNDwtEAAAAAAAA8D8gFKMhFSAQIA+iIA0gEqIgDiAToqChIBWiIRYgESAPoiANIBOiIA4gEqKhoSAVoiEXIAwgEqIgECANoiARIA6ioaGaIBWiIRggDCAToiAQIA6iIBEgDaKgoZogFaIhGSAWRAAAAAAAANBAop6qEAMhHSAXRAAAAAAAANBAop6qEAMhHiAYRAAAAAAAANBAop6qEAMhHyAZRAAAAAAAANBAop6qEAMhICAftyAft6IgILcgILeioCEbIBtEAAAAAAAAsEFkBEBEAAAAAAAA0EAgG5+jIRwgH7cgHKKeqiEfICC3IByinqohIAsgHbcgHbeiIB63IB63oqAhGyAbRAAAAAAAANBBZARARAAAAAAAAOBAIBufoyEcIB23IByinqohHSAetyAcop6qIR4LIB0kCiAeJAsgHyQMICAkDQuWAwEUf0EAIRBBgMACIQJBwMICIQMjCiERIwshEiMMIRMjDSEUIAIoAgAQASEIIAJBBGooAgAQASEJIAJBFGooAgAQASEGIAJBGGooAgAQASEHIAMgCBAANgIAIANBBGogCRAANgIAIBAgCBAAEAJqIAkQABACaiEQIANBCGohAyADIAYQADYCACADQQRqIAcQADYCACAQIAYQABACaiAHEAAQAmohECADQQhqIQNBAiEBAkADQCABIABODQFBgMACIAFBFGxqIQIgAigCABABIQQgAkEEaigCABABIQUgEbcgBreiIBK3IAe3oqEgE7cgCLeiIBS3IAm3oqGhRAAAAAAAABA/op78AiEKIBG3IAe3oiAStyAGt6KgIBO3IAm3oiAUtyAIt6KgoUQAAAAAAAAQP6Ke/AIhCyAEIAprIQwgBSALayENIAwQACEOIA0QACEPIAMgDjYCACADQQRqIA82AgAgECAOEAJqIA8QAmohECAGIQggByEJIAQhBiAFIQcgA0EIaiEDIAFBAWohAQwACwsgEAvJAQEKf0EUIQtBACEKQQAhAwJAA0AgAyABTg0BIApBgMACIANBBGxqKAIAEAJqIQogA0EBaiEDDAALCyAAQQFrIQICQANAIAJBAUgNAUEAIQMCQANAIAMgAU4NAUGAwAIgAiALbGogA0EEbGohBEGAwAIgAkEBayALbGogA0EEbGohBSAEKAIAEAEhBiAFKAIAEAEhByAGIAdrIQggCBAAIQkgBCAJNgIAIAogCRACaiEKIANBAWohAwwACwsgAkEBayECDAALCyAKC4UBAQh/QRQhCUEBIQICQANAIAIgAE4NAUEAIQMCQANAIAMgAU4NAUGAwAIgAiAJbGogA0EEbGohBEGAwAIgAkEBayAJbGogA0EEbGohBSAEKAIAEAEhBiAFKAIAEAEhByAGIAdqIQggBCAIEAA2AgAgA0EBaiEDDAALCyACQQFqIQIMAAsLC8kCAQ1/QYDAAiEGQcDCAiEHIAcoAgAQASEMIAdBBGooAgAQASENIAYgDBAANgIAIAZBBGogDRAANgIAIABBAUwEQA8LIAdBCGooAgAQASEKIAdBDGooAgAQASELIAZBFGogChAANgIAIAZBGGogCxAANgIAQQIhBQJAA0AgBSAATg0BQcDCAiAFQQhsaiEHIAcoAgAQASEQIAdBBGooAgAQASERIAG3IAq3oiACtyALt6KhIAO3IAy3oiAEtyANt6KhoUQAAAAAAAAQP6Ke/AIhDiABtyALt6IgArcgCreioCADtyANt6IgBLcgDLeioKFEAAAAAAAAED+invwCIQ8gDiAQaiEIIA8gEWohCUGAwAIgBUEUbGohBiAGIAgQADYCACAGQQRqIAkQADYCACAKIQwgCyENIAghCiAJIQsgBUEBaiEFDAALCws=';

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
    fit: (start: number, len: number) => void;
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

    static encode(points: Int32Array, prev?: GlyphCoeffs, opts?: GlyphEncodeOptions): GlyphBlock[] {
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

            // pick cheapest mode. track the last trial that wrote RESID to skip
            // redundant re-encode when the winner is already in the buffer.
            // trial order: harmonic → linear → repeat → backward
            // last writer: backward > repeat > linear (harmonic is before linear)
            let bestCost = hAdjCost, bestErr = hErr, bestMode = GlyphMode.HARMONIC;
            let lastResidWriter = -1; // -1 = harmonic, 0 = linear, 1 = repeat, 2 = backward
            if (lCost < bestCost || (lCost === bestCost && lErr <= bestErr)) {
                bestCost = lCost; bestErr = lErr; bestMode = GlyphMode.LINEAR;
            }
            lastResidWriter = 0; // linear was the last unconditional write
            if (rCost < bestCost || (rCost === bestCost && rErr <= bestErr)) {
                bestCost = rCost; bestErr = rErr; bestMode = GlyphMode.REPEAT;
            }
            if (prevWasNonLinear) lastResidWriter = 1; // repeat ran after linear
            if (bCost < bestCost && bErr <= hErr * 2) {
                bestCost = bCost; bestErr = bErr; bestMode = GlyphMode.BACKWARD;
            }
            if (prevBlockStart >= 0 && prevBlockLen >= 3) lastResidWriter = 2;

            // re-encode only if the winner isn't already the last RESID writer
            let useKR = 0, useKI = 0, useGR = 0, useGI = 0;
            const needReencode = !(
                (bestMode === GlyphMode.LINEAR && lastResidWriter === 0) ||
                (bestMode === GlyphMode.REPEAT && lastResidWriter === 1) ||
                (bestMode === GlyphMode.BACKWARD && lastResidWriter === 2)
            );
            if (bestMode === GlyphMode.HARMONIC) {
                sval(m.kR, hKR); sval(m.kI, hKI);
                sval(m.gR, hGR); sval(m.gI, hGI);
                m.encodeBlock(i, len, GlyphMode.HARMONIC);
                useKR = hKR; useKI = hKI; useGR = hGR; useGI = hGI;
            } else if (bestMode === GlyphMode.BACKWARD) {
                useKR = bKR; useKI = bKI; useGR = bGR; useGI = bGI;
                if (needReencode) {
                    sval(m.kR, bKR); sval(m.kI, bKI);
                    sval(m.gR, bGR); sval(m.gI, bGI);
                    m.encodeBlock(i, len, GlyphMode.HARMONIC);
                }
            } else if (bestMode === GlyphMode.REPEAT) {
                useKR = prevKR; useKI = prevKI; useGR = prevGR; useGI = prevGI;
                if (needReencode) {
                    sval(m.kR, prevKR); sval(m.kI, prevKI);
                    sval(m.gR, prevGR); sval(m.gI, prevGI);
                    m.encodeBlock(i, len, GlyphMode.REPEAT);
                }
            } else {
                if (needReencode) m.encodeBlock(i, len, GlyphMode.LINEAR);
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
            if (hasPressure && len >= 4 && bestMode !== GlyphMode.LINEAR) {
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
                m.fitSidecar(i - 2, len + 2, 8);
                const indepK = gval(m.scK), indepG = gval(m.scG);
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

            // ── build block ──

            let block: GlyphBlock = {
                lane: GlyphLane.DEFAULT,
                mode: bestMode,
                kR: useKR, kI: useKI, gR: useGR, gI: useGI,
                residuals,
                features,
                scK, scG,
                cplW,
                mkR, mkI, mgR, mgI,
                microResiduals,
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
                    block = ballisticBlock;
                }
            }

            blocks.push(block);

            if (block.lane !== GlyphLane.DEFAULT || block.mode === GlyphMode.LINEAR) {
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
        this.decodeBlocks(blocks, out, 2);
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
            // update K/G tracking for subsequent repeat blocks
            if (b.mode !== GlyphMode.LINEAR) {
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
        let residPerChannel = 0; // total residual varint bytes per channel

        for (const b of blocks) {
            const count = b.residuals.length / CH;
            const chMask = this.detectChMask(b.residuals, count);
            const wireCh = this.maskChannels(chMask);

            // ── meta (headers + coefficients) ──

            const isRepeat = b.mode === GlyphMode.REPEAT;
            const isBackward = b.mode === GlyphMode.BACKWARD;
            // backward: repeat=1, mode=1 (previously unused combination)
            const modeBit = isBackward ? 1 : (isRepeat ? 0 : b.mode);
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

            if (b.lane === GlyphLane.DEFAULT && b.mode !== GlyphMode.LINEAR) {
                prevKR = b.kR; prevKI = b.kI;
                prevGR = b.gR; prevGI = b.gI;
                hasPrevCoeffs = true;
            } else {
                hasPrevCoeffs = false;
            }
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
                let mode: GlyphMode;
                if (lane !== GlyphLane.DEFAULT) {
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
    private prev: GlyphCoeffs | undefined;
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
            const blocks = GlyphCodec.encode(this.buffer, this.prev, { adaptiveSegmentation: false });
            const last = blocks[blocks.length - 1];
            if (last && last.mode !== GlyphMode.LINEAR) {
                this.prev = { kR: last.kR, kI: last.kI, gR: last.gR, gI: last.gI };
            } else {
                this.prev = undefined;
            }
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
            this.prev,
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
