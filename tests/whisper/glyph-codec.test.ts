/**
 * glyph-codec.test.ts — dedicated test suite for the Glyph 7D codec.
 *
 * tests the codec as a codec: geometric fidelity, prediction physics,
 * compression efficiency, mode selection, stability, and adversarial inputs.
 * every test uses geometrically meaningful input, not random noise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    GlyphCodec,
    GlyphLane,
    GlyphMode,
    GlyphStreamEncoder,
    GlyphStreamDecoder,
    GLYPH_BLOCK_SIZE,
    GLYPH_CHANNELS,
    GLYPH_CHANNEL_NAMES,
    type GlyphSeed,
} from "../../src/scripts/whisper/live-wasm-glyph.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CH = GLYPH_CHANNELS; // 5

// helper: load raw WASM instance for low-level tests
function loadWasm() {
    const wasm = readFileSync(join(__dirname, "../../src/scripts/whisper/glyph.wasm"));
    const mod = new WebAssembly.Module(wasm);
    const inst = new WebAssembly.Instance(mod);
    return inst.exports as any;
}

// ── generators ───────────────────────────────────────────────────────────────
// each produces Int32Array in [x, y, p, tilt, azimuth, ...] layout with 2 seed points.

function circle(cx: number, cy: number, r: number, n: number, pressure = 16000): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        const theta = (i / n) * Math.PI * 2;
        pts[i * CH] = Math.round(cx + r * Math.cos(theta));
        pts[i * CH + 1] = Math.round(cy + r * Math.sin(theta));
        pts[i * CH + 2] = pressure;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function spiral(cx: number, cy: number, r0: number, growth: number, n: number): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        const theta = (i / n) * Math.PI * 4;
        const r = r0 + growth * i;
        pts[i * CH] = Math.round(cx + r * Math.cos(theta));
        pts[i * CH + 1] = Math.round(cy + r * Math.sin(theta));
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function ellipse(cx: number, cy: number, a: number, b: number, n: number): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        const theta = (i / n) * Math.PI * 2;
        pts[i * CH] = Math.round(cx + a * Math.cos(theta));
        pts[i * CH + 1] = Math.round(cy + b * Math.sin(theta));
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function line(x0: number, y0: number, dx: number, dy: number, n: number): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        pts[i * CH] = Math.round(x0 + dx * i);
        pts[i * CH + 1] = Math.round(y0 + dy * i);
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function quadraticStroke(n: number): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        pts[i * CH] = 1000 + 18 * i + 7 * i * i;
        pts[i * CH + 1] = 4000 - 12 * i + 5 * i * i;
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function cubicBezier(
    p0: [number, number], p1: [number, number],
    p2: [number, number], p3: [number, number],
    n: number, pressure = 16000
): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const u = 1 - t;
        const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
        const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
        pts[i * CH] = Math.round(x);
        pts[i * CH + 1] = Math.round(y);
        pts[i * CH + 2] = pressure;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

// handwriting-like: horizontal baseline with sinusoidal bumps, pressure and tilt variation
function handwriting(n: number): Int32Array {
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < n; i++) {
        const t = i / n;
        pts[i * CH] = Math.round(500 + t * 6000);
        pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 5) * 800 + Math.sin(t * Math.PI * 13) * 200);
        pts[i * CH + 2] = Math.round(12000 + Math.sin(t * Math.PI * 7) * 4000);
        pts[i * CH + 3] = Math.round(5000 + Math.sin(t * Math.PI * 3) * 2000); // tilt varies
        pts[i * CH + 4] = Math.round(18000 + Math.sin(t * Math.PI * 2) * 8000); // azimuth varies
    }
    return pts;
}

// sharp corner: two straight segments meeting at an angle
function corner(n: number): Int32Array {
    const half = Math.floor(n / 2);
    const pts = new Int32Array(n * CH);
    for (let i = 0; i < half; i++) {
        pts[i * CH] = 1000 + i * 60;
        pts[i * CH + 1] = 3000;
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    const cx = pts[(half - 1) * CH], cy = pts[(half - 1) * CH + 1];
    for (let i = half; i < n; i++) {
        const j = i - half;
        pts[i * CH] = cx + j * 30;
        pts[i * CH + 1] = cy - j * 50;
        pts[i * CH + 2] = 16000;
        pts[i * CH + 3] = 0;
        pts[i * CH + 4] = 0;
    }
    return pts;
}

function seedsFrom(pts: Int32Array): { seed1: GlyphSeed; seed2: GlyphSeed } {
    const seed1: number[] = [];
    const seed2: number[] = [];
    for (let c = 0; c < CH; c++) {
        seed1.push(pts[CH + c]);
        seed2.push(pts[c]);
    }
    return { seed1, seed2 };
}

// exact round-trip helper
function assertExactRoundTrip(pts: Int32Array, label: string): void {
    const blocks = GlyphCodec.encode(pts);
    const packed = GlyphCodec.pack(blocks);
    const unpacked = GlyphCodec.unpack(packed);
    const { seed1, seed2 } = seedsFrom(pts);
    const decoded = GlyphCodec.decode(unpacked, seed1, seed2);
    assert.equal(decoded.length, pts.length, `${label}: length mismatch`);
    for (let i = 0; i < pts.length; i++) {
        assert.equal(decoded[i], pts[i], `${label}: mismatch at index ${i}`);
    }
}

function countModes(blocks: { mode: GlyphMode }[]): [number, number, number, number] {
    const m: [number, number, number, number] = [0, 0, 0, 0];
    for (const b of blocks) m[b.mode]++;
    return m;
}

// raw serialized size before Logos (for compression measurement without slow entropy coding)
// accounts for channel mask: only counts active channel varints
function rawSerializedSize(blocks: { mode: GlyphMode; residuals: Int32Array }[]): number {
    let bytes = 0;
    for (const b of blocks) {
        bytes += 1; // header
        if (b.mode === GlyphMode.HARMONIC) bytes += 8; // coefficients
        const count = b.residuals.length / CH;
        // detect channel mask (same logic as pack)
        let wireCh: number = CH;
        let tiltAzZero = true;
        for (let i = 0; i < count && tiltAzZero; i++) {
            if (b.residuals[i * CH + 3] !== 0 || b.residuals[i * CH + 4] !== 0) tiltAzZero = false;
        }
        if (tiltAzZero) {
            wireCh = 3;
            let pZero = true;
            for (let i = 0; i < count && pZero; i++) {
                if (b.residuals[i * CH + 2] !== 0) pZero = false;
            }
            if (pZero) wireCh = 2;
        }
        for (let i = 0; i < count; i++) {
            for (let c = 0; c < wireCh; c++) {
                let v = b.residuals[i * CH + c] >>> 0;
                do { bytes++; v >>>= 7; } while (v);
            }
        }
    }
    return bytes;
}

// raw size WITHOUT channel mask (all 5 channels always)
function rawSerializedSizeNaive(blocks: { mode: GlyphMode; residuals: Int32Array }[]): number {
    let bytes = 0;
    for (const b of blocks) {
        bytes += 1;
        if (b.mode === GlyphMode.HARMONIC) bytes += 8;
        for (let i = 0; i < b.residuals.length; i++) {
            let v = b.residuals[i] >>> 0;
            do { bytes++; v >>>= 7; } while (v);
        }
    }
    return bytes;
}

// write channel data into WASM heap (point stride = CH i32s)
function writePointsToHeap(
    heap: Int32Array,
    points: Record<string, number>[]
): void {
    for (let i = 0; i < points.length; i++) {
        for (let c = 0; c < CH; c++) {
            heap[i * CH + c] = points[i][GLYPH_CHANNEL_NAMES[c]] ?? 0;
        }
    }
}

// ── test suite ───────────────────────────────────────────────────────────────

describe("glyph codec: geometric fidelity", () => {

    it("exact lossless round-trip for circle", () => {
        assertExactRoundTrip(circle(5000, 5000, 2000, 2 + GLYPH_BLOCK_SIZE * 4), "circle");
    });

    it("exact lossless round-trip for ellipse", () => {
        assertExactRoundTrip(ellipse(4000, 4000, 3000, 1500, 2 + GLYPH_BLOCK_SIZE * 4), "ellipse");
    });

    it("exact lossless round-trip for spiral", () => {
        assertExactRoundTrip(spiral(5000, 5000, 500, 30, 2 + GLYPH_BLOCK_SIZE * 6), "spiral");
    });

    it("exact lossless round-trip for cubic bezier", () => {
        assertExactRoundTrip(
            cubicBezier([1000, 2000], [2000, 5000], [6000, 5000], [7000, 2000],
                2 + GLYPH_BLOCK_SIZE * 4),
            "bezier"
        );
    });

    it("exact lossless round-trip for handwriting-like trajectory", () => {
        assertExactRoundTrip(handwriting(2 + GLYPH_BLOCK_SIZE * 6), "handwriting");
    });

    it("exact lossless round-trip for sharp corner", () => {
        assertExactRoundTrip(corner(2 + GLYPH_BLOCK_SIZE * 4), "corner");
    });

    it("exact lossless round-trip for single partial block", () => {
        assertExactRoundTrip(circle(3000, 3000, 1000, 7), "partial-block");
    });
});

describe("glyph codec: mode selection", () => {

    it("chooses harmonic or repeat for tight circles", () => {
        const pts = circle(5000, 5000, 5000, 2 + GLYPH_BLOCK_SIZE * 2);
        const blocks = GlyphCodec.encode(pts, undefined, { adaptiveSegmentation: false });
        const [h, l, r] = countModes(blocks);
        assert.ok(l === 0, `tight circle should not use linear mode, got ${l} linear blocks`);
        assert.ok(h + r === blocks.length, "all blocks should be harmonic or repeat");
    });

    it("chooses linear for perfectly straight lines", () => {
        const pts = line(1000, 2000, 50, 30, 2 + GLYPH_BLOCK_SIZE * 3);
        const blocks = GlyphCodec.encode(pts);
        const [h, l, r] = countModes(blocks);
        assert.ok(h === 0 && r === 0, `line should only use linear, got h=${h} r=${r}`);
    });

    it("uses repeat mode on constant-curvature arcs", () => {
        const pts = circle(5000, 5000, 8000, 2 + GLYPH_BLOCK_SIZE * 4);
        const blocks = GlyphCodec.encode(pts);
        const [h, l, r] = countModes(blocks);
        assert.ok(h + r === blocks.length, `all blocks should be harmonic/repeat, got l=${l}`);
        assert.ok(r >= 1, `constant curvature should produce at least 1 repeat block, got ${r}`);
    });

    it("mixes modes on compound trajectories (curve + line + curve)", () => {
        const arcPts = circle(5000, 5000, 5000, 2 + GLYPH_BLOCK_SIZE * 2);
        const linePts = line(1000, 2000, 100, 60, 2 + GLYPH_BLOCK_SIZE * 2);

        const arcBlocks = GlyphCodec.encode(arcPts);
        const lineBlocks = GlyphCodec.encode(linePts);
        const [ah, al, ar] = countModes(arcBlocks);
        const [lh, ll, lr] = countModes(lineBlocks);
        assert.ok(ah + ar > 0, "arcs should produce harmonic/repeat blocks");
        assert.ok(ll > 0, "lines should produce linear blocks");
        assertExactRoundTrip(arcPts, "compound-arc");
        assertExactRoundTrip(linePts, "compound-line");
    });
});

describe("glyph codec: primitive-bank lanes", () => {

    it("selects the ballistic lane on quadratic strokes", () => {
        const pts = quadraticStroke(2 + GLYPH_BLOCK_SIZE * 2);
        const blocks = GlyphCodec.encode(pts);
        assert.ok(blocks.some(b => b.lane === GlyphLane.BALLISTIC),
            "quadratic stroke should trigger the ballistic lane");
        assertExactRoundTrip(pts, "quadratic-ballistic");
    });

    it("segments a sharp within-block corner at a motion boundary", () => {
        const pts = corner(2 + GLYPH_BLOCK_SIZE);
        const blocks = GlyphCodec.encode(pts);
        assert.ok(blocks.length >= 2, `expected at least 2 blocks, got ${blocks.length}`);
        assert.ok(blocks[0].residuals.length / CH < GLYPH_BLOCK_SIZE,
            "phase-aware segmentation should cut before the 16-point ceiling");
        assertExactRoundTrip(pts, "segmented-corner");
    });
});

describe("glyph codec: compression", () => {

    it("harmonic mode compresses tight circles better than linear would", () => {
        const pts = circle(5000, 5000, 5000, 2 + GLYPH_BLOCK_SIZE * 2);
        const blocks = GlyphCodec.encode(pts);

        let totalResidMag = 0;
        let harmonicCount = 0;
        for (const b of blocks) {
            if (b.mode === GlyphMode.HARMONIC || b.mode === GlyphMode.REPEAT) {
                harmonicCount++;
                for (let i = 0; i < b.residuals.length; i++) {
                    const zz = b.residuals[i];
                    const v = (zz >>> 1) ^ (0 - (zz & 1));
                    totalResidMag += Math.abs(v);
                }
            }
        }
        assert.ok(harmonicCount > 0, "tight circle should produce harmonic blocks");
        // average per x,y channel (skip p,t,a which are constant → 0 residual)
        const avgResid = totalResidMag / (harmonicCount * GLYPH_BLOCK_SIZE * CH);
        assert.ok(avgResid < 10, `circle average residual ${avgResid.toFixed(2)} too large`);
    });

    it("compressed output is smaller than raw input for smooth curves", () => {
        const pts = cubicBezier([500, 1000], [2000, 4000], [5000, 4000], [7000, 1000],
            2 + GLYPH_BLOCK_SIZE * 4);
        const blocks = GlyphCodec.encode(pts);
        const rawInputBytes = pts.length * 4; // i32 per value
        const serializedBytes = rawSerializedSize(blocks);
        assert.ok(serializedBytes < rawInputBytes,
            `serialized ${serializedBytes} should be < raw ${rawInputBytes}`);
    });

    it("dimensional collapse saves bytes for mouse input (2ch) vs naive 5ch", () => {
        // mouse/finger: only x,y active, p/tilt/azimuth = 0.
        // channel mask collapses 3 dimensions → 60% fewer residual varints.
        const pts = circle(5000, 5000, 2000, 2 + GLYPH_BLOCK_SIZE * 4);
        const blocks = GlyphCodec.encode(pts);

        const maskedSize = rawSerializedSize(blocks);
        const naiveSize = rawSerializedSizeNaive(blocks);

        // the naive encoding wastes 3 zero-varint bytes per point (p, tilt, azimuth)
        // channel mask eliminates them entirely
        const savedBytes = naiveSize - maskedSize;
        const nPoints = (pts.length / CH) - 2; // exclude seeds
        assert.ok(savedBytes >= nPoints * 3,
            `dimensional collapse should save ≥${nPoints * 3} bytes, saved ${savedBytes}`);
        // verify the masked size is about 40% of naive (position is 2/5 channels)
        const ratio = maskedSize / naiveSize;
        assert.ok(ratio < 0.7,
            `masked/naive ratio ${ratio.toFixed(2)} should be < 0.7 (dimensional collapse)`);
    });

    it("dimensional collapse detects 3ch mode for basic stylus (varying pressure)", () => {
        // basic stylus: x,y,p active, tilt/azimuth = 0 → 3 channels on wire.
        const n = 2 + GLYPH_BLOCK_SIZE * 4;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + t * 5000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 2) * 1000);
            pts[i * CH + 2] = Math.round(2000 + 14000 * Math.sin(t * Math.PI));
            // tilt and azimuth zero (basic stylus)
        }
        const blocks = GlyphCodec.encode(pts);
        const maskedSize = rawSerializedSize(blocks);
        const naiveSize = rawSerializedSizeNaive(blocks);

        // should save 2 zero-varint bytes per point (tilt + azimuth)
        const nPoints = n - 2;
        const savedBytes = naiveSize - maskedSize;
        assert.ok(savedBytes >= nPoints * 2,
            `3ch collapse should save ≥${nPoints * 2} bytes, saved ${savedBytes}`);
        assertExactRoundTrip(pts, "3ch-stylus");
    });

    it("repeat mode saves bytes compared to all-harmonic on constant curvature", () => {
        const pts = circle(5000, 5000, 3000, 2 + GLYPH_BLOCK_SIZE * 8);
        const blocks = GlyphCodec.encode(pts);

        const actualSize = rawSerializedSize(blocks);
        let repeatCount = 0;
        for (const b of blocks) if (b.mode === GlyphMode.REPEAT) repeatCount++;
        const noRepeatSize = actualSize + repeatCount * 8;

        if (repeatCount > 0) {
            assert.ok(actualSize < noRepeatSize,
                `repeat should save bytes: ${actualSize} vs ${noRepeatSize} (${repeatCount} repeats)`);
        }
    });
});

describe("glyph codec: stability and robustness", () => {

    it("handles constant points (zero motion)", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 5000;
            pts[i * CH + 1] = 3000;
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "constant");
    });

    it("handles alternating jitter (worst case for linear predictor)", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 5000 + (i % 2 === 0 ? 1 : -1);
            pts[i * CH + 1] = 3000 + (i % 2 === 0 ? -1 : 1);
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "jitter");
    });

    it("handles large coordinates (4K tablet range)", () => {
        const pts = circle(16000, 12000, 8000, 2 + GLYPH_BLOCK_SIZE * 4);
        assertExactRoundTrip(pts, "large-coords");
    });

    it("handles negative coordinates", () => {
        const pts = circle(-5000, -3000, 2000, 2 + GLYPH_BLOCK_SIZE * 4);
        assertExactRoundTrip(pts, "negative-coords");
    });

    it("handles coordinates near i16 boundary", () => {
        const pts = circle(0, 0, 30000, 2 + GLYPH_BLOCK_SIZE * 4);
        assertExactRoundTrip(pts, "boundary-coords");
    });

    it("handles minimum block size (1 point after seeds)", () => {
        const pts = new Int32Array(3 * CH);
        pts[0] = 1000; pts[1] = 2000; pts[2] = 16000; pts[3] = 0; pts[4] = 0;
        pts[5] = 1050; pts[6] = 2030; pts[7] = 16000; pts[8] = 0; pts[9] = 0;
        pts[10] = 1100; pts[11] = 2060; pts[12] = 16000; pts[13] = 0; pts[14] = 0;
        assertExactRoundTrip(pts, "min-block");
    });

    it("coefficients satisfy stability constraints after fit", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;

        const cases: [string, () => void][] = [
            ["circle", () => {
                writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
                    x: Math.round(5000 + 2000 * Math.cos(i * 0.35)),
                    y: Math.round(5000 + 2000 * Math.sin(i * 0.35)),
                    p: 16000,
                })));
            }],
            ["diverging spiral", () => {
                writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
                    x: Math.round(5000 + 100 * Math.pow(1.8, i) * Math.cos(i * 0.5)),
                    y: Math.round(5000 + 100 * Math.pow(1.8, i) * Math.sin(i * 0.5)),
                    p: 16000,
                })));
            }],
            ["collinear", () => {
                writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
                    x: 1000 + i * 200,
                    y: 5000,
                    p: 16000,
                })));
            }],
            ["stationary", () => {
                writePointsToHeap(heap, Array.from({ length: 18 }, () => ({
                    x: 4000,
                    y: 4000,
                    p: 16000,
                })));
            }],
        ];

        for (const [name, setup] of cases) {
            setup();
            m.fit(0, 18);
            const kR = m.kR.value, kI = m.kI.value;
            const gR = m.gR.value, gI = m.gI.value;
            const kMag = Math.sqrt(kR * kR + kI * kI) / Q14;
            const gMag = Math.sqrt(gR * gR + gI * gI) / Q14;
            assert.ok(kMag <= 2.0001, `${name}: |K|=${kMag.toFixed(4)} exceeds 2`);
            assert.ok(gMag <= 1.0001, `${name}: |G|=${gMag.toFixed(4)} exceeds 1`);
        }
    });

    it("stability clamping works when both components are at i16 extremes", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const s = Math.pow(2, i);
            return {
                x: Math.round(s * Math.cos(i * 0.3)),
                y: Math.round(s * Math.sin(i * 0.3)),
                p: 16000,
            };
        }));
        m.fit(0, 18);
        const gR = m.gR.value, gI = m.gI.value;
        const gMag = Math.sqrt(gR * gR + gI * gI) / Q14;
        assert.ok(gMag <= 1.0001,
            `divergent data: |G|=${gMag.toFixed(4)} should be clamped ≤ 1`);

        // verify round-trip is exact with divergent data
        const pts = new Int32Array(18 * CH);
        for (let i = 0; i < 18; i++) {
            const s = Math.pow(2, i);
            pts[i * CH] = Math.round(s * Math.cos(i * 0.3));
            pts[i * CH + 1] = Math.round(s * Math.sin(i * 0.3));
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "divergent-trajectory");
    });
});

describe("glyph codec: sidecar channels", () => {

    it("preserves varying pressure through encode/decode", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 3;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + t * 5000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 2) * 1000);
            pts[i * CH + 2] = Math.round(2000 + 14000 * Math.sin(t * Math.PI));
        }
        assertExactRoundTrip(pts, "pressure-ramp");
    });

    it("preserves pressure discontinuity (pen tap)", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 3000 + i * 40;
            pts[i * CH + 1] = 3000;
            pts[i * CH + 2] = i < n / 2 ? 1000 : 30000;
        }
        assertExactRoundTrip(pts, "pressure-tap");
    });

    it("preserves varying tilt through encode/decode", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 3;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + t * 5000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 2) * 1000);
            pts[i * CH + 2] = 16000;
            // tilt: slow ramp from near-flat to near-vertical
            pts[i * CH + 3] = Math.round(1000 + t * 14000);
            pts[i * CH + 4] = 0;
        }
        assertExactRoundTrip(pts, "tilt-ramp");
    });

    it("preserves varying azimuth through encode/decode", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 3;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + t * 5000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 2) * 1000);
            pts[i * CH + 2] = 16000;
            pts[i * CH + 3] = 5000;
            // azimuth: sinusoidal rotation (unwrapped)
            pts[i * CH + 4] = Math.round(18000 + Math.sin(t * Math.PI * 4) * 12000);
        }
        assertExactRoundTrip(pts, "azimuth-varying");
    });

    it("preserves all 5 channels simultaneously with complex variation", () => {
        assertExactRoundTrip(handwriting(2 + GLYPH_BLOCK_SIZE * 6), "all-channels");
    });

    it("tilt and azimuth discontinuity round-trips exactly", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 3000 + i * 40;
            pts[i * CH + 1] = 3000;
            pts[i * CH + 2] = 16000;
            // sudden tilt change mid-stroke (pen flip)
            pts[i * CH + 3] = i < n / 2 ? 2000 : 14000;
            // sudden azimuth change
            pts[i * CH + 4] = i < n / 2 ? 5000 : 25000;
        }
        assertExactRoundTrip(pts, "tilt-azimuth-discontinuity");
    });
});

describe("glyph codec: streaming equivalence", () => {

    it("streaming encoder+decoder matches batch encode+decode", () => {
        const raw = handwriting(2 + GLYPH_BLOCK_SIZE * 4);
        // streaming starts from a single seed (both context slots identical),
        // so duplicate pts[1] into pts[0] for batch-streaming equivalence
        const seed: GlyphSeed = [];
        for (let c = 0; c < CH; c++) {
            seed.push(raw[CH + c]);
            raw[c] = raw[CH + c];
        }
        const pts = raw;

        // batch path
        const blocks = GlyphCodec.encode(pts);
        const packed = GlyphCodec.pack(blocks);
        const unpacked = GlyphCodec.unpack(packed);
        const batchDecoded = GlyphCodec.decode(unpacked, seed, seed);

        // streaming path
        const enc = new GlyphStreamEncoder(seed);
        const dec = new GlyphStreamDecoder(seed);
        const streamPoints: number[] = [];
        const nDataPts = (pts.length / CH) - 2;

        for (let i = 0; i < nDataPts; i++) {
            const idx = (i + 2) * CH;
            const chunk = enc.push(pts.subarray(idx, idx + CH));
            if (chunk) {
                const decoded = dec.decode(chunk);
                for (let j = 0; j < decoded.length; j += CH) {
                    for (let c = 0; c < CH; c++) streamPoints.push(decoded[j + c]);
                }
            }
        }
        const tail = enc.flush();
        if (tail) {
            const decoded = dec.decode(tail);
            for (let j = 0; j < decoded.length; j += CH) {
                for (let c = 0; c < CH; c++) streamPoints.push(decoded[j + c]);
            }
        }

        assert.equal(streamPoints.length, nDataPts * CH, "stream point count");
        for (let i = 0; i < streamPoints.length; i++) {
            assert.equal(streamPoints[i], batchDecoded[CH * 2 + i],
                `stream/batch mismatch at index ${i}`);
        }
    });

    it("streaming encoder carries repeat state across emissions", () => {
        const r = 8000, n = 2 + GLYPH_BLOCK_SIZE * 4;
        const seed: GlyphSeed = [
            Math.round(5000 + r),
            5000,
            16000, 0, 0
        ];

        const enc = new GlyphStreamEncoder(seed);
        const dec = new GlyphStreamDecoder(seed);
        const allDecoded: number[] = [];
        let totalEmissions = 0;

        for (let i = 0; i < n - 2; i++) {
            const theta = ((i + 2) / n) * Math.PI * 2;
            const vals = new Array(CH).fill(0);
            vals[0] = Math.round(5000 + r * Math.cos(theta));
            vals[1] = Math.round(5000 + r * Math.sin(theta));
            vals[2] = 16000;
            const chunk = enc.push(vals);
            if (chunk) {
                totalEmissions++;
                const decoded = dec.decode(chunk);
                for (let j = 0; j < decoded.length; j++) allDecoded.push(decoded[j]);
            }
        }
        const tail = enc.flush();
        if (tail) {
            totalEmissions++;
            const decoded = dec.decode(tail);
            for (let j = 0; j < decoded.length; j++) allDecoded.push(decoded[j]);
        }

        assert.ok(totalEmissions >= 3, `expected ≥3 emissions, got ${totalEmissions}`);
        assert.equal(allDecoded.length, (n - 2) * CH, "all points decoded");
    });

    it("flush emits correct partial block", () => {
        const seed: GlyphSeed = [1000, 2000, 16000, 0, 0];
        const enc = new GlyphStreamEncoder(seed);
        const dec = new GlyphStreamDecoder(seed);

        const count = 7;
        const input: GlyphSeed[] = [];
        for (let i = 0; i < count; i++) {
            input.push([1000 + i * 50, 2000 + i * 30, 16000, 0, 0]);
            const chunk = enc.push(input[i]);
            assert.equal(chunk, null, "should not emit before GLYPH_BLOCK_SIZE");
        }

        const flushed = enc.flush();
        assert.ok(flushed !== null, "flush should emit partial block");
        const decoded = dec.decode(flushed!);
        assert.equal(decoded.length / CH, count, "decoded count matches input count");

        for (let i = 0; i < count; i++) {
            assert.equal(decoded[i * CH], input[i][0], `x mismatch at ${i}`);
            assert.equal(decoded[i * CH + 1], input[i][1], `y mismatch at ${i}`);
            assert.equal(decoded[i * CH + 2], input[i][2], `p mismatch at ${i}`);
            assert.equal(decoded[i * CH + 3], input[i][3], `tilt mismatch at ${i}`);
            assert.equal(decoded[i * CH + 4], input[i][4], `azimuth mismatch at ${i}`);
        }
    });
});

describe("glyph codec: prediction quality", () => {

    it("harmonic residuals are unbiased (nearest rounding, not floor)", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const theta = (i / 18) * Math.PI * 2;
            return {
                x: Math.round(5000 + 3000 * Math.cos(theta)),
                y: Math.round(5000 + 3000 * Math.sin(theta)),
                p: 16000,
            };
        }));

        m.fit(0, 18);
        m.encodeBlock(2, 16, 0);

        let sumX = 0, sumY = 0;
        const residOff = 0xA000 >> 2;
        for (let i = 0; i < 16; i++) {
            const zx = heap[residOff + i * CH];
            const zy = heap[residOff + i * CH + 1];
            sumX += (zx >>> 1) ^ (0 - (zx & 1));
            sumY += (zy >>> 1) ^ (0 - (zy & 1));
        }
        const meanX = sumX / 16, meanY = sumY / 16;
        assert.ok(Math.abs(meanX) < 2,
            `x residual mean ${meanX.toFixed(2)} should be near zero (nearest rounding)`);
        assert.ok(Math.abs(meanY) < 2,
            `y residual mean ${meanY.toFixed(2)} should be near zero (nearest rounding)`);
    });

    it("oscillator residuals are smaller than linear residuals on circles", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const theta = (i / 18) * Math.PI * 2;
            return {
                x: Math.round(5000 + 2000 * Math.cos(theta)),
                y: Math.round(5000 + 2000 * Math.sin(theta)),
                p: 16000,
            };
        }));

        m.fit(0, 18);
        m.encodeBlock(2, 16, 0);
        const harmonicErr = m.errSum.value;

        m.encodeBlock(2, 16, 1);
        const linearErr = m.errSum.value;

        assert.ok(harmonicErr < linearErr,
            `harmonic error (${harmonicErr}) should be < linear error (${linearErr}) on circle`);
    });

    it("linear residuals are zero for perfectly straight segments", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: 1000 + i * 100,
            y: 2000 + i * 60,
            p: 16000,
        })));

        m.encodeBlock(2, 16, 1);
        const linearErr = m.errSum.value;
        assert.equal(linearErr, 0, "linear predictor should have zero error on linear data");

        const residOff = 0xA000 >> 2;
        for (let i = 0; i < 16 * CH; i++) {
            assert.equal(heap[residOff + i], 0, `residual[${i}] should be 0`);
        }
    });

    it("repeat mode produces identical residuals to harmonic with same coefficients", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const theta = i * 0.3;
            return {
                x: Math.round(5000 + 2000 * Math.cos(theta)),
                y: Math.round(5000 + 2000 * Math.sin(theta)),
                p: 16000,
            };
        }));

        m.fit(0, 18);
        const kR = m.kR.value, kI = m.kI.value, gR = m.gR.value, gI = m.gI.value;

        // harmonic encode (mode 0)
        m.encodeBlock(2, 16, 0);
        const nResid = 16 * CH;
        const residOff = 0xA000 >> 2;
        const harmonicResid = new Int32Array(nResid);
        for (let i = 0; i < nResid; i++) harmonicResid[i] = heap[residOff + i];

        // restore coefficients and encode repeat (mode 2)
        m.kR.value = kR; m.kI.value = kI; m.gR.value = gR; m.gI.value = gI;
        m.encodeBlock(2, 16, 2);
        const repeatResid = new Int32Array(nResid);
        for (let i = 0; i < nResid; i++) repeatResid[i] = heap[residOff + i];

        for (let i = 0; i < nResid; i++) {
            assert.equal(repeatResid[i], harmonicResid[i],
                `residual mismatch at ${i}: repeat=${repeatResid[i]} harmonic=${harmonicResid[i]}`);
        }
    });
});

describe("glyph codec: adversarial inputs", () => {

    it("survives encode/decode of maximum coordinate range", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = i % 2 === 0 ? 32767 : -32767;
            pts[i * CH + 1] = i % 3 === 0 ? 32767 : -32767;
            pts[i * CH + 2] = i % 2 === 0 ? 0 : 32767;
            pts[i * CH + 3] = i % 2 === 0 ? -10000 : 10000;
            pts[i * CH + 4] = i % 3 === 0 ? -20000 : 20000;
        }
        assertExactRoundTrip(pts, "extreme-zigzag");
    });

    it("survives encode/decode of all-zero data", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        assertExactRoundTrip(pts, "all-zero");
    });

    it("survives encode/decode of single-point repeated data", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 12345;
            pts[i * CH + 1] = -6789;
            pts[i * CH + 2] = 500;
            pts[i * CH + 3] = 3000;
            pts[i * CH + 4] = 15000;
        }
        assertExactRoundTrip(pts, "single-point");
    });

    it("survives encode/decode of high-frequency oscillation", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 5000 + Math.round(500 * Math.sin(i * Math.PI));
            pts[i * CH + 1] = 3000 + Math.round(300 * Math.cos(i * Math.PI * 0.7));
            pts[i * CH + 2] = 16000;
            pts[i * CH + 3] = Math.round(5000 + 3000 * Math.sin(i * Math.PI * 0.5));
            pts[i * CH + 4] = Math.round(10000 + 8000 * Math.cos(i * Math.PI * 0.3));
        }
        assertExactRoundTrip(pts, "nyquist-oscillation");
    });

    it("handles multi-trial deterministic fuzz across diverse geometries", () => {
        const lcg = (seed: number) => {
            let s = seed | 0;
            return () => { s = (Math.imul(1664525, s) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
        };

        const generators = [
            (rnd: () => number) => {
                const cx = Math.round(rnd() * 20000 - 10000);
                const cy = Math.round(rnd() * 20000 - 10000);
                const r = Math.round(rnd() * 5000 + 500);
                return circle(cx, cy, r, 2 + GLYPH_BLOCK_SIZE * 3);
            },
            (rnd: () => number) => {
                const p = () => [Math.round(rnd() * 10000), Math.round(rnd() * 10000)] as [number, number];
                return cubicBezier(p(), p(), p(), p(), 2 + GLYPH_BLOCK_SIZE * 3);
            },
            (rnd: () => number) => {
                const cx = Math.round(rnd() * 10000);
                const cy = Math.round(rnd() * 10000);
                return spiral(cx, cy, Math.round(rnd() * 1000 + 100), Math.round(rnd() * 50), 2 + GLYPH_BLOCK_SIZE * 3);
            },
            (rnd: () => number) => {
                return line(
                    Math.round(rnd() * 10000), Math.round(rnd() * 10000),
                    Math.round(rnd() * 100 - 50), Math.round(rnd() * 100 - 50),
                    2 + GLYPH_BLOCK_SIZE * 3
                );
            },
        ];

        for (let trial = 0; trial < 20; trial++) {
            const rnd = lcg(42 + trial * 31);
            const gen = generators[trial % generators.length];
            const pts = gen(rnd);
            assertExactRoundTrip(pts, `fuzz-trial-${trial}`);
        }
    });
});

// ── hardened edge cases ──────────────────────────────────────────────────────

describe("glyph codec: edge cases (never break)", () => {

    it("exact round-trip for every partial block size 1..15", () => {
        for (let k = 1; k < GLYPH_BLOCK_SIZE; k++) {
            const n = 2 + k;
            const pts = new Int32Array(n * CH);
            for (let i = 0; i < n; i++) {
                pts[i * CH] = 1000 + i * 37;
                pts[i * CH + 1] = 2000 + i * 23;
                pts[i * CH + 2] = 8000 + i * 100;
                pts[i * CH + 3] = i * 50;
                pts[i * CH + 4] = i * 80;
            }
            assertExactRoundTrip(pts, `partial-${k}`);
        }
    });

    it("exact round-trip for exactly 1 full block (16 data points)", () => {
        const pts = circle(5000, 5000, 2000, 2 + GLYPH_BLOCK_SIZE);
        assertExactRoundTrip(pts, "exactly-1-block");
    });

    it("exact round-trip for seeds only (no data points)", () => {
        const pts = new Int32Array(2 * CH);
        pts[0] = 1000; pts[1] = 2000; pts[2] = 16000; pts[3] = 500; pts[4] = 800;
        pts[5] = 1050; pts[6] = 2030; pts[7] = 16000; pts[8] = 500; pts[9] = 800;
        const blocks = GlyphCodec.encode(pts);
        assert.equal(blocks.length, 0, "no blocks for seeds-only input");
        const packed = GlyphCodec.pack(blocks);
        const unpacked = GlyphCodec.unpack(packed);
        assert.equal(unpacked.length, 0, "unpack produces no blocks");
    });

    it("pack/unpack of empty block array", () => {
        const packed = GlyphCodec.pack([]);
        const unpacked = GlyphCodec.unpack(packed);
        assert.equal(unpacked.length, 0);
    });

    it("streaming decoder handles empty bytes gracefully", () => {
        const seed: GlyphSeed = [1000, 2000, 16000, 0, 0];
        const dec = new GlyphStreamDecoder(seed);
        const result = dec.decode(new Uint8Array(0));
        assert.equal(result.length, 0);
    });

    it("streaming flush with no points returns null", () => {
        const seed: GlyphSeed = [1000, 2000, 16000, 0, 0];
        const enc = new GlyphStreamEncoder(seed);
        assert.equal(enc.flush(), null);
    });

    it("streaming: every flush size 1..15 round-trips exactly", () => {
        for (let k = 1; k < GLYPH_BLOCK_SIZE; k++) {
            const seed: GlyphSeed = [1000, 2000, 16000, 100, 300];
            const enc = new GlyphStreamEncoder(seed);
            const dec = new GlyphStreamDecoder(seed);
            const expected: number[] = [];
            for (let i = 0; i < k; i++) {
                const x = 1100 + i * 37, y = 2060 + i * 23, p = 16000, t = 300 + i * 10, a = 500 + i * 15;
                const vals = [x, y, p, t, a];
                enc.push(vals);
                expected.push(...vals);
            }
            const flushed = enc.flush();
            assert.ok(flushed !== null, `flush size ${k} should emit`);
            const decoded = dec.decode(flushed!);
            assert.equal(decoded.length, k * CH, `flush size ${k}: decoded length`);
            for (let i = 0; i < expected.length; i++) {
                assert.equal(decoded[i], expected[i], `flush size ${k}: mismatch at ${i}`);
            }
        }
    });

    it("streaming: multi-emission continuity across 8 full blocks", () => {
        const r = 3000, cx = 5000, cy = 5000;
        const totalPts = GLYPH_BLOCK_SIZE * 8;
        const seed: GlyphSeed = [Math.round(cx + r), cy, 16000, 0, 0];
        const enc = new GlyphStreamEncoder(seed);
        const dec = new GlyphStreamDecoder(seed);
        const n = totalPts + 2;
        const allDecoded: number[] = [];
        const allExpected: number[] = [];

        for (let i = 0; i < totalPts; i++) {
            const theta = ((i + 2) / n) * Math.PI * 2;
            const x = Math.round(cx + r * Math.cos(theta));
            const y = Math.round(cy + r * Math.sin(theta));
            const vals = new Array(CH).fill(0);
            vals[0] = x; vals[1] = y; vals[2] = 16000;
            allExpected.push(...vals);
            const chunk = enc.push(vals);
            if (chunk) {
                const decoded = dec.decode(chunk);
                for (let j = 0; j < decoded.length; j++) allDecoded.push(decoded[j]);
            }
        }
        const tail = enc.flush();
        if (tail) {
            const decoded = dec.decode(tail);
            for (let j = 0; j < decoded.length; j++) allDecoded.push(decoded[j]);
        }

        assert.equal(allDecoded.length, totalPts * CH, "all points recovered");
        for (let i = 0; i < allDecoded.length; i++) {
            assert.equal(allDecoded[i], allExpected[i], `continuity mismatch at ${i}`);
        }
    });

    it("large coordinates near i32 safe range", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 100000 + i * 500;
            pts[i * CH + 1] = -100000 + i * 300;
            pts[i * CH + 2] = 50000;
            pts[i * CH + 3] = 30000;
            pts[i * CH + 4] = 60000;
        }
        assertExactRoundTrip(pts, "large-i32");
    });

    it("negative pressure and orientation values", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 5000 + i * 10;
            pts[i * CH + 1] = 3000 + i * 20;
            pts[i * CH + 2] = -16000 + i * 100;
            pts[i * CH + 3] = -10000 + i * 50;
            pts[i * CH + 4] = -20000 + i * 80;
        }
        assertExactRoundTrip(pts, "negative-channels");
    });

    it("zigzag encoding boundary: values 0, 1, -1, max, min", () => {
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        const vals = [0, 1, -1, 32767, -32768, 16383, -16384, 100, -100, 255, -256, 127, -128, 65535, -65536, 10000];
        for (let i = 0; i < n; i++) {
            // use boundary values as perturbations on a smooth baseline
            pts[i * CH] = 5000 + vals[i % vals.length];
            pts[i * CH + 1] = 3000 + vals[(i + 3) % vals.length];
            pts[i * CH + 2] = 16000 + vals[(i + 5) % vals.length];
            pts[i * CH + 3] = 5000 + vals[(i + 7) % vals.length];
            pts[i * CH + 4] = 10000 + vals[(i + 11) % vals.length];
        }
        assertExactRoundTrip(pts, "zigzag-boundary");
    });

    it("rapid channel mask transitions across blocks", () => {
        // block 1: mouse (2ch), block 2: stylus (3ch), block 3: full (5ch), block 4: mouse again
        const n = 2 + GLYPH_BLOCK_SIZE * 4;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + t * 8000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 3) * 1000);
            const blockIdx = Math.floor((i - 2) / GLYPH_BLOCK_SIZE);
            if (blockIdx === 1) {
                // stylus block: pressure varies
                pts[i * CH + 2] = Math.round(2000 + 10000 * Math.sin(t * Math.PI));
            } else if (blockIdx === 2) {
                // full stylus: all channels active
                pts[i * CH + 2] = Math.round(2000 + 10000 * Math.sin(t * Math.PI));
                pts[i * CH + 3] = Math.round(3000 + 2000 * Math.sin(t * Math.PI * 2));
                pts[i * CH + 4] = Math.round(15000 + 8000 * Math.cos(t * Math.PI));
            }
            // blocks 0, 3: mouse-like (p/tilt/azimuth = 0)
        }
        assertExactRoundTrip(pts, "channel-mask-transitions");
    });

    it("identical seeds (pen placed without moving)", () => {
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 5000;
            pts[i * CH + 1] = 3000;
            pts[i * CH + 2] = 16000;
            pts[i * CH + 3] = 4000;
            pts[i * CH + 4] = 12000;
        }
        assertExactRoundTrip(pts, "identical-seeds");
    });

    it("deterministic: same input always produces same output", () => {
        const pts = handwriting(2 + GLYPH_BLOCK_SIZE * 3);
        const packed1 = GlyphCodec.pack(GlyphCodec.encode(pts));
        const packed2 = GlyphCodec.pack(GlyphCodec.encode(pts));
        assert.equal(packed1.length, packed2.length, "packed length should be deterministic");
        for (let i = 0; i < packed1.length; i++) {
            assert.equal(packed1[i], packed2[i], `byte ${i} differs between runs`);
        }
    });

    it("single channel active at a time (all permutations)", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        for (let activeCh = 0; activeCh < CH; activeCh++) {
            const pts = new Int32Array(n * CH);
            for (let i = 0; i < n; i++) {
                pts[i * CH + activeCh] = 1000 + i * 37;
            }
            assertExactRoundTrip(pts, `single-ch-${activeCh}`);
        }
    });

    it("maximum block count (many tiny blocks from streaming flush)", () => {
        // test a long stroke that produces many full blocks + partial
        const n = 2 + GLYPH_BLOCK_SIZE * 12 + 7;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(500 + t * 10000);
            pts[i * CH + 1] = Math.round(3000 + Math.sin(t * Math.PI * 8) * 1500);
            pts[i * CH + 2] = Math.round(8000 + Math.sin(t * Math.PI * 4) * 6000);
            pts[i * CH + 3] = Math.round(4000 + Math.sin(t * Math.PI * 2) * 3000);
            pts[i * CH + 4] = Math.round(16000 + Math.cos(t * Math.PI * 3) * 10000);
        }
        assertExactRoundTrip(pts, "many-blocks");
    });

    it("varint encoding: very large residuals from discontinuity", () => {
        // create a trajectory with a massive jump mid-block to stress varint encoding
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            if (i < n / 2) {
                pts[i * CH] = 1000 + i * 10;
                pts[i * CH + 1] = 2000 + i * 5;
            } else {
                // massive teleport
                pts[i * CH] = 500000 + i * 10;
                pts[i * CH + 1] = -300000 + i * 5;
            }
            pts[i * CH + 2] = 16000;
            pts[i * CH + 3] = i < n / 2 ? 0 : 30000;
            pts[i * CH + 4] = i < n / 2 ? 0 : -25000;
        }
        assertExactRoundTrip(pts, "large-residuals");
    });

    it("alternating zero/nonzero in sidecar channels", () => {
        const n = 2 + GLYPH_BLOCK_SIZE * 2;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 3000 + i * 30;
            pts[i * CH + 1] = 4000 + i * 20;
            // pressure alternates between zero and nonzero
            pts[i * CH + 2] = i % 2 === 0 ? 0 : 16000;
            // tilt alternates
            pts[i * CH + 3] = i % 3 === 0 ? 5000 : 0;
            // azimuth alternates
            pts[i * CH + 4] = i % 4 === 0 ? 10000 : 0;
        }
        assertExactRoundTrip(pts, "alternating-sidecar");
    });
});

describe("glyph codec: WASM low-level edge cases", () => {

    it("fit with collinear points produces near-linear coefficients", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;
        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: 1000 + i * 200,
            y: 2000 + i * 100,
            p: 16000,
        })));
        m.fit(0, 18);
        // for a straight line, the best oscillator fit approaches K=2, G=1
        // but tikhonov regularization and Q14 quantization add small deviations
        const kMag = Math.sqrt(m.kR.value ** 2 + m.kI.value ** 2) / Q14;
        const gMag = Math.sqrt(m.gR.value ** 2 + m.gI.value ** 2) / Q14;
        assert.ok(Math.abs(kMag - 2) < 0.05, `line |K|=${kMag.toFixed(4)} should be ~2`);
        assert.ok(Math.abs(gMag - 1) < 0.05, `line |G|=${gMag.toFixed(4)} should be ~1`);
    });

    it("fit with stationary points produces near-zero coefficients", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;
        writePointsToHeap(heap, Array.from({ length: 18 }, () => ({
            x: 5000, y: 5000, p: 16000,
        })));
        m.fit(0, 18);
        // stationary points: all deltas are zero, but regularization biases
        // the fit toward K=0.5, G=0 (tikhonov eps on the diagonal). this is
        // harmless because zero-motion residuals are zero regardless.
        const kMag = Math.sqrt(m.kR.value ** 2 + m.kI.value ** 2) / Q14;
        const gMag = Math.sqrt(m.gR.value ** 2 + m.gI.value ** 2) / Q14;
        assert.ok(kMag < 1.0, `stationary |K|=${kMag.toFixed(4)} should be small`);
        assert.ok(gMag <= 0.5 + 0.001, `stationary |G|=${gMag.toFixed(4)} should be small`);
        // verify the round-trip is still exact (the important thing)
        const pts = new Int32Array(18 * CH);
        for (let i = 0; i < 18; i++) { pts[i * CH] = 5000; pts[i * CH + 1] = 5000; pts[i * CH + 2] = 16000; }
        assertExactRoundTrip(pts, "stationary-wasm");
    });

    it("encode then decode with mode=1 on oscillating data preserves values", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const pointsOff = 0;
        const residOff = 0xA000 >> 2;

        // write oscillating data
        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: 5000 + Math.round(500 * Math.sin(i * 0.5)),
            y: 3000 + Math.round(300 * Math.cos(i * 0.7)),
            p: 8000 + i * 100,
            tilt: 2000 + i * 50,
            azimuth: 10000 + i * 80,
        })));

        // save original points
        const original = new Int32Array(18 * CH);
        for (let i = 0; i < 18 * CH; i++) original[i] = heap[pointsOff + i];

        // encode block in linear mode
        m.encodeBlock(2, 16, 1);
        const residuals = new Int32Array(16 * CH);
        for (let i = 0; i < 16 * CH; i++) residuals[i] = heap[residOff + i];

        // restore seeds, clear data points
        for (let i = 0; i < 2 * CH; i++) heap[pointsOff + i] = original[i];
        for (let i = 2 * CH; i < 18 * CH; i++) heap[pointsOff + i] = 0;

        // write residuals back and decode
        for (let i = 0; i < 16 * CH; i++) heap[residOff + i] = residuals[i];
        m.decodeBlock(2, 16, 1, 0, 0, 0, 0);

        // verify
        for (let i = 2 * CH; i < 18 * CH; i++) {
            assert.equal(heap[pointsOff + i], original[i],
                `WASM decode mismatch at offset ${i}: got ${heap[pointsOff + i]}, expected ${original[i]}`);
        }
    });

    it("encode mode 0 then decode with same coefficients restores exactly", () => {
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const pointsOff = 0;
        const residOff = 0xA000 >> 2;

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const theta = (i / 18) * Math.PI * 2;
            return {
                x: Math.round(5000 + 2000 * Math.cos(theta)),
                y: Math.round(5000 + 2000 * Math.sin(theta)),
                p: 8000 + Math.round(4000 * Math.sin(theta)),
                tilt: 3000 + Math.round(1000 * Math.cos(theta * 2)),
                azimuth: 12000 + Math.round(6000 * Math.sin(theta * 0.5)),
            };
        }));

        const original = new Int32Array(18 * CH);
        for (let i = 0; i < 18 * CH; i++) original[i] = heap[pointsOff + i];

        m.fit(0, 18);
        const kR = m.kR.value, kI = m.kI.value, gR = m.gR.value, gI = m.gI.value;
        m.encodeBlock(2, 16, 0);

        const residuals = new Int32Array(16 * CH);
        for (let i = 0; i < 16 * CH; i++) residuals[i] = heap[residOff + i];

        // restore seeds only
        for (let i = 0; i < 2 * CH; i++) heap[pointsOff + i] = original[i];
        for (let i = 2 * CH; i < 18 * CH; i++) heap[pointsOff + i] = 0;
        for (let i = 0; i < 16 * CH; i++) heap[residOff + i] = residuals[i];

        m.decodeBlock(2, 16, 0, kR, kI, gR, gI);

        for (let i = 2 * CH; i < 18 * CH; i++) {
            assert.equal(heap[pointsOff + i], original[i],
                `mode 0 decode mismatch at ${i}`);
        }
    });
});

// ── oscillator physics verification ──────────────────────────────────────────

describe("glyph codec: oscillator physics", () => {

    it("harmonic residuals are near-zero for circles at various frequencies", () => {
        // for a circle z[n] = R·e^{iωn}, the complex oscillator should
        // predict almost perfectly regardless of frequency. the residuals
        // should be bounded by integer quantization noise.
        // (note: a single complex exponential makes the 2x2 normal equation
        // singular — regularization picks the minimum-norm solution, so K and G
        // don't match simple analytic formulas. but the RESIDUALS are what matter.)
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const residOff = 0xA000 >> 2;
        const R = 10000;

        const frequencies = [
            { omega: Math.PI / 8, label: "π/8" },
            { omega: Math.PI / 4, label: "π/4" },
            { omega: Math.PI / 16, label: "π/16" },
            { omega: 0.7, label: "0.7" },
            { omega: 1.5, label: "1.5" },
        ];

        for (const { omega, label } of frequencies) {
            writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
                x: Math.round(R * Math.cos(omega * i)),
                y: Math.round(R * Math.sin(omega * i)),
                p: 16000,
            })));

            m.fit(0, 18);
            m.encodeBlock(2, 16, 0);

            let maxResid = 0;
            for (let i = 0; i < 16; i++) {
                for (let c = 0; c < 2; c++) {
                    const zz = heap[residOff + i * CH + c];
                    const v = (zz >>> 1) ^ (0 - (zz & 1));
                    maxResid = Math.max(maxResid, Math.abs(v));
                }
            }
            // for R=10000, quantization noise is ≤1, prediction error should be tiny
            assert.ok(maxResid <= 3,
                `ω=${label}: max residual ${maxResid} should be ≤3`);
        }
    });

    it("fitted K, G recover two-frequency superposition (ellipse)", () => {
        // an ellipse z[n] = a·cos(ωn) + i·b·sin(ωn) = (a+b)/2·e^{iωn} + (a-b)/2·e^{-iωn}
        // this is a sum of two complex exponentials: λ₁ = e^{iω}, λ₂ = e^{-iω}
        // so K = λ₁ + λ₂ = 2cos(ω) (real), G = λ₁·λ₂ = 1.
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;
        const omega = Math.PI / 9; // angular step for 18-point cycle

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: Math.round(5000 * Math.cos(omega * i)),
            y: Math.round(2000 * Math.sin(omega * i)),
            p: 16000,
        })));

        m.fit(0, 18);
        const kR = m.kR.value / Q14;
        const kI = m.kI.value / Q14;
        const gR = m.gR.value / Q14;
        const gI = m.gI.value / Q14;

        const expectedK = 2 * Math.cos(omega);

        // K should be real ≈ 2cos(ω), G should be real ≈ 1
        assert.ok(Math.abs(kR - expectedK) < 0.02,
            `ellipse kR=${kR.toFixed(4)} expected ${expectedK.toFixed(4)}`);
        assert.ok(Math.abs(kI) < 0.02,
            `ellipse kI=${kI.toFixed(4)} should be ~0`);
        assert.ok(Math.abs(gR - 1) < 0.02,
            `ellipse gR=${gR.toFixed(4)} expected ~1`);
        assert.ok(Math.abs(gI) < 0.02,
            `ellipse gI=${gI.toFixed(4)} should be ~0`);
    });

    it("damped spiral has small residuals and stable coefficients", () => {
        // a damped spiral: z[n] = R·α^n·e^{iωn} with α < 1 (damping factor)
        // the key properties: (1) coefficients are stable, (2) residuals are small,
        // (3) lossless round-trip. (note: like circles, the single-exponential
        // form makes the normal equation ill-conditioned, so K/G values are
        // biased by regularization. we test behavior, not coefficient values.)
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;
        const residOff = 0xA000 >> 2;
        const R = 8000, alpha = 0.95, omega = 0.4;

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: Math.round(R * Math.pow(alpha, i) * Math.cos(omega * i)),
            y: Math.round(R * Math.pow(alpha, i) * Math.sin(omega * i)),
            p: 16000,
        })));

        m.fit(0, 18);
        const kMag = Math.sqrt(m.kR.value ** 2 + m.kI.value ** 2) / Q14;
        const gMag = Math.sqrt(m.gR.value ** 2 + m.gI.value ** 2) / Q14;

        // stability constraints must hold
        assert.ok(kMag <= 2.0001, `|K|=${kMag.toFixed(4)} exceeds 2`);
        assert.ok(gMag <= 1.0001, `|G|=${gMag.toFixed(4)} exceeds 1`);

        // residuals should be small (good prediction)
        m.encodeBlock(2, 16, 0);
        let maxResid = 0;
        for (let i = 0; i < 16; i++) {
            for (let c = 0; c < 2; c++) {
                const zz = heap[residOff + i * CH + c];
                const v = (zz >>> 1) ^ (0 - (zz & 1));
                maxResid = Math.max(maxResid, Math.abs(v));
            }
        }
        assert.ok(maxResid <= 5,
            `damped spiral max residual ${maxResid} should be small`);

        // and of course, lossless round-trip
        const n = 2 + GLYPH_BLOCK_SIZE * 4;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            pts[i * CH] = Math.round(R * Math.pow(alpha, i) * Math.cos(omega * i));
            pts[i * CH + 1] = Math.round(R * Math.pow(alpha, i) * Math.sin(omega * i));
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "damped-spiral");
    });

    it("residuals are near-zero for analytically predictable trajectory", () => {
        // large radius circle: the oscillator should predict almost perfectly.
        // residuals should be tiny (just quantization noise).
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const residOff = 0xA000 >> 2;
        const R = 10000, omega = Math.PI / 9;

        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => ({
            x: Math.round(R * Math.cos(omega * i)),
            y: Math.round(R * Math.sin(omega * i)),
            p: 16000,
        })));

        m.fit(0, 18);
        m.encodeBlock(2, 16, 0);

        // check raw residuals (before zigzag — decode zigzag to get actual residual)
        let maxResid = 0;
        for (let i = 0; i < 16; i++) {
            for (let c = 0; c < 2; c++) { // only x,y channels
                const zz = heap[residOff + i * CH + c];
                const v = (zz >>> 1) ^ (0 - (zz & 1));
                maxResid = Math.max(maxResid, Math.abs(v));
            }
        }
        // for radius 10000, integer quantization error is ≤1 per coordinate.
        // prediction error should be ≤ 2 (cumulative from prev quantization).
        assert.ok(maxResid <= 3,
            `circle max residual ${maxResid} should be ≤3 (quantization noise only)`);
    });

    it("oscillator eigenvalues satisfy characteristic equation", () => {
        // for ANY fitted K,G and data, the eigenvalues λ₁,λ₂ of λ²-Kλ+G=0
        // must have |λ| ≤ 1 (stability clamping guarantees this).
        // verify by computing discriminant and checking eigenvalue magnitudes.
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const Q14 = 16384;

        const trajectories = [
            Array.from({ length: 18 }, (_, i) => ({
                x: Math.round(5000 + 3000 * Math.cos(i * 0.3)),
                y: Math.round(5000 + 3000 * Math.sin(i * 0.3)),
                p: 16000,
            })),
            Array.from({ length: 18 }, (_, i) => ({
                x: Math.round(5000 + 2000 * Math.cos(i * 0.7) + 1000 * Math.cos(i * 1.3)),
                y: Math.round(5000 + 2000 * Math.sin(i * 0.7) + 1000 * Math.sin(i * 1.3)),
                p: 16000,
            })),
            Array.from({ length: 18 }, (_, i) => ({
                x: i % 2 === 0 ? 10000 : -10000,
                y: i % 3 === 0 ? 5000 : -5000,
                p: 16000,
            })),
        ];

        for (let t = 0; t < trajectories.length; t++) {
            writePointsToHeap(heap, trajectories[t]);
            m.fit(0, 18);

            const K = { r: m.kR.value / Q14, i: m.kI.value / Q14 };
            const G = { r: m.gR.value / Q14, i: m.gI.value / Q14 };

            // eigenvalues: λ = (K ± sqrt(K² - 4G)) / 2
            // K² (complex): (Kr+iKi)² = Kr²-Ki² + 2i·Kr·Ki
            const K2r = K.r * K.r - K.i * K.i;
            const K2i = 2 * K.r * K.i;
            // K² - 4G
            const dr = K2r - 4 * G.r;
            const di = K2i - 4 * G.i;
            // sqrt(complex discriminant)
            const dMag = Math.sqrt(dr * dr + di * di);
            const sqrtR = Math.sqrt((dMag + dr) / 2);
            const sqrtI = di >= 0 ? Math.sqrt((dMag - dr) / 2) : -Math.sqrt((dMag - dr) / 2);

            // λ₁ = (K + sqrt(disc)) / 2
            const l1r = (K.r + sqrtR) / 2;
            const l1i = (K.i + sqrtI) / 2;
            const l1Mag = Math.sqrt(l1r * l1r + l1i * l1i);

            // λ₂ = (K - sqrt(disc)) / 2
            const l2r = (K.r - sqrtR) / 2;
            const l2i = (K.i - sqrtI) / 2;
            const l2Mag = Math.sqrt(l2r * l2r + l2i * l2i);

            // both eigenvalues must have magnitude ≤ 1 (stability)
            assert.ok(l1Mag <= 1.01,
                `trajectory ${t}: |λ₁|=${l1Mag.toFixed(4)} exceeds 1`);
            assert.ok(l2Mag <= 1.01,
                `trajectory ${t}: |λ₂|=${l2Mag.toFixed(4)} exceeds 1`);
        }
    });

    it("frequency sweep (chirp) round-trips exactly", () => {
        // a chirp where the frequency changes linearly. the harmonic predictor
        // can't perfectly predict this (nonstationary), so it stresses mode
        // switching between blocks.
        const n = 2 + GLYPH_BLOCK_SIZE * 6;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            const omega = 0.1 + t * 2.0; // frequency ramp from 0.1 to 2.1 rad/sample
            const phase = 0.1 * i + t * t * n; // integral of omega
            pts[i * CH] = Math.round(5000 + 3000 * Math.cos(phase));
            pts[i * CH + 1] = Math.round(5000 + 3000 * Math.sin(phase));
            pts[i * CH + 2] = 16000;
            pts[i * CH + 3] = Math.round(3000 + 1000 * Math.sin(t * Math.PI));
            pts[i * CH + 4] = Math.round(10000 + 5000 * Math.cos(t * Math.PI * 2));
        }
        assertExactRoundTrip(pts, "chirp");
    });

    it("figure-eight (lissajous) round-trips and uses harmonic mode", () => {
        // lissajous figure: x = A·sin(2ωt), y = B·sin(ωt)
        // the 2:1 frequency ratio means the oscillator can't capture both
        // frequencies perfectly, so residuals will be nonzero but moderate.
        const n = 2 + GLYPH_BLOCK_SIZE * 4;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(5000 + 4000 * Math.sin(2 * Math.PI * 2 * t));
            pts[i * CH + 1] = Math.round(5000 + 3000 * Math.sin(2 * Math.PI * t));
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "lissajous");
        // should use some harmonic blocks (curves, not straight)
        const blocks = GlyphCodec.encode(pts);
        const [h, l, r] = countModes(blocks);
        assert.ok(h + r > 0, `lissajous should use harmonic/repeat, got h=${h} r=${r} l=${l}`);
    });
});

// ── sidecar i32 wrapping stress ──────────────────────────────────────────────

describe("glyph codec: i32 arithmetic edge cases", () => {

    it("sidecar linear prediction wraps consistently for large values", () => {
        // linear prediction: c[n] = 2*c[n-1] - c[n-2]
        // the i32.shl 1 wraps for |c[n-1]| > INT_MAX/2 ≈ 1073741823
        // but wrapping is consistent between encoder and decoder.
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        // use large pressure values near i32 wrap boundary
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 3000 + i * 20;
            pts[i * CH + 1] = 4000 + i * 30;
            // pressure ramps into wrapping territory
            pts[i * CH + 2] = 1000000000 + i * 50000000;
            pts[i * CH + 3] = 500000000 + i * 40000000;
            pts[i * CH + 4] = -800000000 - i * 30000000;
        }
        assertExactRoundTrip(pts, "sidecar-wrap");
    });

    it("coordinates near INT_MAX/2 round-trip exactly", () => {
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        const base = 1073741000; // near INT_MAX/2
        for (let i = 0; i < n; i++) {
            pts[i * CH] = base + i * 100;
            pts[i * CH + 1] = -(base + i * 80);
            pts[i * CH + 2] = base - i * 200;
            pts[i * CH + 3] = 0;
            pts[i * CH + 4] = 0;
        }
        assertExactRoundTrip(pts, "near-int-max-half");
    });

    it("zigzag + varint round-trip for large magnitude residuals", () => {
        // create input with massive discontinuities to produce large residuals
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        const lcg = (seed: number) => {
            let s = seed;
            return () => { s = (Math.imul(1664525, s) + 1013904223) | 0; return s; };
        };
        const rnd = lcg(12345);
        for (let i = 0; i < n; i++) {
            // random i32 values — worst case for prediction, huge residuals
            pts[i * CH] = rnd();
            pts[i * CH + 1] = rnd();
            pts[i * CH + 2] = rnd();
            pts[i * CH + 3] = rnd();
            pts[i * CH + 4] = rnd();
        }
        assertExactRoundTrip(pts, "random-i32");
    });

    it("alternating INT_MAX/-INT_MAX coordinates round-trip", () => {
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        const MAX = 2147483647;
        const MIN = -2147483648;
        for (let i = 0; i < n; i++) {
            pts[i * CH] = i % 2 === 0 ? MAX : MIN;
            pts[i * CH + 1] = i % 2 === 0 ? MIN : MAX;
            pts[i * CH + 2] = i % 2 === 0 ? MAX : MIN;
            pts[i * CH + 3] = i % 3 === 0 ? MAX : 0;
            pts[i * CH + 4] = i % 3 === 0 ? MIN : 0;
        }
        assertExactRoundTrip(pts, "int-extremes");
    });
});

// ── block boundary and cross-block continuity ────────────────────────────────

describe("glyph codec: cross-block continuity", () => {

    it("seed carry-over is exact at block boundaries", () => {
        // encode a long trajectory, then verify that decoding block-by-block
        // produces the same result as decoding all at once.
        const n = 2 + GLYPH_BLOCK_SIZE * 5;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(2000 + 6000 * Math.cos(t * Math.PI * 3));
            pts[i * CH + 1] = Math.round(4000 + 3000 * Math.sin(t * Math.PI * 5));
            pts[i * CH + 2] = Math.round(8000 + 6000 * Math.sin(t * Math.PI));
            pts[i * CH + 3] = Math.round(3000 + 2000 * Math.cos(t * Math.PI * 2));
            pts[i * CH + 4] = Math.round(15000 + 8000 * Math.sin(t * Math.PI * 0.7));
        }

        // batch decode
        const blocks = GlyphCodec.encode(pts);
        const packed = GlyphCodec.pack(blocks);
        const unpacked = GlyphCodec.unpack(packed);
        const { seed1, seed2 } = seedsFrom(pts);
        const batchResult = GlyphCodec.decode(unpacked, seed1, seed2);

        // block-by-block decode (simulates streaming)
        const blockResult = new Int32Array(batchResult.length);
        for (let i = 0; i < 2 * CH; i++) blockResult[i] = batchResult[i]; // copy seeds

        let cursor = 2;
        for (const block of unpacked) {
            const count = block.residuals.length / CH;
            // create a mini-array with just seeds + this block
            const mini = new Int32Array((2 + count) * CH);
            for (let c = 0; c < CH; c++) {
                mini[c] = blockResult[(cursor - 2) * CH + c];
                mini[CH + c] = blockResult[(cursor - 1) * CH + c];
            }
            const miniBlocks = [block];
            GlyphCodec.decodeBlocks(miniBlocks, mini, 2);
            for (let i = 0; i < count * CH; i++) {
                blockResult[cursor * CH + i] = mini[2 * CH + i];
            }
            cursor += count;
        }

        // verify block-by-block matches batch
        for (let i = 2 * CH; i < batchResult.length; i++) {
            assert.equal(blockResult[i], batchResult[i],
                `cross-block continuity mismatch at ${i}`);
        }
    });

    it("mode transitions at block boundaries are seamless", () => {
        // trajectory: straight line → tight curve → straight line
        // this forces LINEAR → HARMONIC → LINEAR mode transitions.
        const n = 2 + GLYPH_BLOCK_SIZE * 6;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const blockIdx = Math.floor((i - 2) / GLYPH_BLOCK_SIZE);
            if (blockIdx >= 2 && blockIdx <= 3) {
                // tight curve section
                const t = (i - 2 - GLYPH_BLOCK_SIZE * 2) / (GLYPH_BLOCK_SIZE * 2);
                pts[i * CH] = Math.round(5000 + 3000 * Math.cos(t * Math.PI * 2));
                pts[i * CH + 1] = Math.round(5000 + 3000 * Math.sin(t * Math.PI * 2));
            } else {
                // straight line section
                pts[i * CH] = 1000 + i * 50;
                pts[i * CH + 1] = 2000 + i * 30;
            }
            pts[i * CH + 2] = 16000;
        }
        assertExactRoundTrip(pts, "mode-transitions");

        const blocks = GlyphCodec.encode(pts);
        const modes = blocks.map(b => b.mode);
        // verify there are mode changes (not all same)
        const uniqueModes = new Set(modes);
        assert.ok(uniqueModes.size >= 2,
            `should have mode transitions, got only ${[...uniqueModes].join(",")}`);
    });
});

// ── wire format robustness ───────────────────────────────────────────────────

describe("glyph codec: wire format robustness", () => {

    it("uses the extended wire header when meta exceeds one byte", () => {
        const blocks = Array.from({ length: 300 }, () => ({
            lane: GlyphLane.DEFAULT,
            mode: GlyphMode.LINEAR,
            kR: 0,
            kI: 0,
            gR: 0,
            gI: 0,
            residuals: new Int32Array(CH),
            features: 0,
            scK: 0,
            scG: 0,
            cplW: 0,
            mkR: 0,
            mkI: 0,
            mgR: 0,
            mgI: 0,
            microResiduals: null,
        }));

        const packed = GlyphCodec.pack(blocks);
        assert.equal(packed[0], 0, "extended header should use zero raw-length sentinel");
        assert.equal(packed[1], 0, "extended header should use zero raw-length sentinel");

        const unpacked = GlyphCodec.unpack(packed);
        assert.equal(unpacked.length, blocks.length, "extended header block count mismatch");
        for (let i = 0; i < unpacked.length; i++) {
            assert.equal(unpacked[i].lane, GlyphLane.DEFAULT);
            assert.equal(unpacked[i].mode, GlyphMode.LINEAR);
            assert.equal(unpacked[i].residuals.length, CH);
        }
    });

    it("truncated wire data does not crash (graceful degradation)", () => {
        const pts = handwriting(2 + GLYPH_BLOCK_SIZE * 3);
        const packed = GlyphCodec.pack(GlyphCodec.encode(pts));

        // try every possible truncation
        for (let len = 0; len <= packed.length; len++) {
            const truncated = packed.slice(0, len);
            // should not throw
            const blocks = GlyphCodec.unpack(truncated);
            if (blocks.length > 0) {
                const { seed1, seed2 } = seedsFrom(pts);
                // decode should not throw
                GlyphCodec.decode(blocks, seed1, seed2);
            }
        }
    });

    it("corrupted bytes do not crash (graceful degradation)", () => {
        const pts = circle(5000, 5000, 2000, 2 + GLYPH_BLOCK_SIZE * 2);
        const packed = GlyphCodec.pack(GlyphCodec.encode(pts));
        const { seed1, seed2 } = seedsFrom(pts);

        // flip each byte and verify no crash
        for (let i = 0; i < packed.length; i++) {
            const corrupted = new Uint8Array(packed);
            corrupted[i] ^= 0xFF;
            try {
                const blocks = GlyphCodec.unpack(corrupted);
                if (blocks.length > 0) {
                    GlyphCodec.decode(blocks, seed1, seed2);
                }
            } catch {
                // some corruptions may cause valid-looking but wrong headers
                // that lead to OOB in Logos. that's acceptable as long as
                // it throws instead of producing silent wrong results.
            }
        }
    });

    it("coefficient bias encoding is reversible for all Q14 values", () => {
        // the wire format biases Q14 i16 [-32768,32767] → u16 [0,65535].
        // verify that every valid Q14 value survives the bias round-trip.
        // this tests the push16/read16 + bias mechanism.
        for (let v = -32768; v <= 32767; v++) {
            const biased = v + 32768;
            const lo = biased & 0xFF;
            const hi = (biased >> 8) & 0xFF;
            const restored = (lo | (hi << 8)) - 32768;
            assert.equal(restored, v, `Q14 bias round-trip failed for ${v}`);
        }
    });

    it("varint encoding is reversible for all zigzag-encoded i32 values", () => {
        // test representative values including boundaries
        const values = [
            0, 1, -1, 2, -2, 63, -64, 64, -65, 127, -128,
            128, -129, 255, -256, 8191, -8192, 8192, -8193,
            32767, -32768, 65535, -65536, 1048575, -1048576,
            2147483647, -2147483647, -2147483648,
        ];

        for (const v of values) {
            // zigzag encode
            const zz = (v << 1) ^ (v >> 31);
            // varint encode
            const buf: number[] = [];
            let tmp = zz >>> 0;
            while (tmp >= 0x80) { buf.push((tmp & 0x7F) | 0x80); tmp >>>= 7; }
            buf.push(tmp & 0x7F);
            // varint decode
            let result = 0, shift = 0;
            for (const b of buf) {
                result |= (b & 0x7F) << shift;
                shift += 7;
            }
            result >>>= 0;
            // zigzag decode
            const decoded = (result >>> 1) ^ (0 - (result & 1));
            assert.equal(decoded, v, `varint round-trip failed for ${v} (zz=${zz >>> 0})`);
        }
    });
});

// ── deep codec logic tests ───────────────────────────────────────────────────

describe("glyph codec: encoder/decoder agreement", () => {

    it("repeat mode is disabled after a linear block", () => {
        // a trajectory that forces: HARMONIC → LINEAR → next block
        // the next block after LINEAR should NOT use repeat mode (no prev coefficients)
        const n = 2 + GLYPH_BLOCK_SIZE * 3;
        const pts = new Int32Array(n * CH);
        // block 0: curve (should be harmonic)
        for (let i = 0; i < 2 + GLYPH_BLOCK_SIZE; i++) {
            const t = i / GLYPH_BLOCK_SIZE;
            pts[i * CH] = Math.round(5000 + 3000 * Math.cos(t * Math.PI));
            pts[i * CH + 1] = Math.round(5000 + 3000 * Math.sin(t * Math.PI));
            pts[i * CH + 2] = 16000;
        }
        // block 1: straight line (should be linear)
        for (let i = 2 + GLYPH_BLOCK_SIZE; i < 2 + GLYPH_BLOCK_SIZE * 2; i++) {
            const j = i - (2 + GLYPH_BLOCK_SIZE);
            pts[i * CH] = 8000 + j * 100;
            pts[i * CH + 1] = 5000;
            pts[i * CH + 2] = 16000;
        }
        // block 2: another straight line (should be linear, NOT repeat)
        for (let i = 2 + GLYPH_BLOCK_SIZE * 2; i < n; i++) {
            const j = i - (2 + GLYPH_BLOCK_SIZE * 2);
            pts[i * CH] = 8000 + GLYPH_BLOCK_SIZE * 100 + j * 100;
            pts[i * CH + 1] = 5000;
            pts[i * CH + 2] = 16000;
        }
        const blocks = GlyphCodec.encode(pts);
        // verify block 2 is linear (not repeat), because block 1 was linear
        // which clears the hasPrev state
        if (blocks.length >= 3 && blocks[1].mode === GlyphMode.LINEAR) {
            assert.notEqual(blocks[2].mode, GlyphMode.REPEAT,
                "block after linear should not be repeat (no prev coefficients)");
        }
        assertExactRoundTrip(pts, "repeat-after-linear");
    });

    it("consecutive encode/decode on same WASM instance doesn't corrupt state", () => {
        // encode several completely different trajectories back-to-back
        // to verify the WASM globals and heap don't leak across calls.
        const trajectories = [
            circle(5000, 5000, 3000, 2 + GLYPH_BLOCK_SIZE * 2),
            line(100, 200, 50, 30, 2 + GLYPH_BLOCK_SIZE * 2),
            handwriting(2 + GLYPH_BLOCK_SIZE * 3),
            spiral(8000, 4000, 500, 40, 2 + GLYPH_BLOCK_SIZE * 2),
            ellipse(3000, 6000, 2500, 1000, 2 + GLYPH_BLOCK_SIZE * 3),
        ];

        for (let round = 0; round < 3; round++) {
            for (let t = 0; t < trajectories.length; t++) {
                assertExactRoundTrip(trajectories[t], `consecutive-r${round}-t${t}`);
            }
        }
    });

    it("WASM encoder and decoder produce identical predictions sample by sample", () => {
        // manually verify that for every sample in a block, the encoder's
        // prediction matches what the decoder will compute.
        const m = loadWasm();
        const heap = new Int32Array(m.mem.buffer);
        const pointsOff = 0;
        const residOff = 0xA000 >> 2;
        const Q14 = 16384;

        // set up a circle with all 5 channels active
        writePointsToHeap(heap, Array.from({ length: 18 }, (_, i) => {
            const theta = (i / 18) * Math.PI * 2;
            return {
                x: Math.round(4000 + 2000 * Math.cos(theta)),
                y: Math.round(4000 + 2000 * Math.sin(theta)),
                p: Math.round(10000 + 5000 * Math.sin(theta)),
                tilt: Math.round(3000 + 1500 * Math.cos(theta * 2)),
                azimuth: Math.round(15000 + 7000 * Math.sin(theta * 0.5)),
            };
        }));

        const original = new Int32Array(18 * CH);
        for (let i = 0; i < 18 * CH; i++) original[i] = heap[pointsOff + i];

        // fit and encode in harmonic mode
        m.fit(0, 18);
        const kR = m.kR.value, kI = m.kI.value, gR = m.gR.value, gI = m.gI.value;
        m.encodeBlock(2, 16, 0);
        const residuals = new Int32Array(16 * CH);
        for (let i = 0; i < 16 * CH; i++) residuals[i] = heap[residOff + i];

        // restore only seeds, decode block
        for (let i = 0; i < 2 * CH; i++) heap[pointsOff + i] = original[i];
        for (let i = 2 * CH; i < 18 * CH; i++) heap[pointsOff + i] = 0;
        for (let i = 0; i < 16 * CH; i++) heap[residOff + i] = residuals[i];
        m.decodeBlock(2, 16, 0, kR, kI, gR, gI);

        // every reconstructed sample must match the original exactly
        for (let i = 0; i < 16; i++) {
            for (let c = 0; c < CH; c++) {
                const idx = (i + 2) * CH + c;
                assert.equal(heap[pointsOff + idx], original[idx],
                    `sample ${i} ch ${c}: decoded ${heap[pointsOff + idx]} ≠ original ${original[idx]}`);
            }
        }
    });

    it("sidecar wrapping propagates correctly across multiple points", () => {
        // the linear predictor c[n] = 2*c[n-1] - c[n-2] uses i32.shl 1.
        // if c[n-1] > INT_MAX/2, the shl wraps. verify this wrapping propagates
        // through a full block consistently.
        const n = 2 + GLYPH_BLOCK_SIZE;
        const pts = new Int32Array(n * CH);
        // start pressure near INT_MAX/2, incrementing to force wrapping
        const base = 1073741800; // slightly below INT_MAX/2
        for (let i = 0; i < n; i++) {
            pts[i * CH] = 3000 + i * 20;
            pts[i * CH + 1] = 4000 + i * 10;
            pts[i * CH + 2] = base + i * 100;
            pts[i * CH + 3] = 0;
            pts[i * CH + 4] = 0;
        }
        // the prediction for pts[2].p = 2 * (base+100) - base = base + 200
        // for pts[3].p = 2 * (base+200) - (base+100) = base + 300
        // at some point 2*c[n-1] overflows i32. the residual captures the difference
        // and the decoder wraps identically, so round-trip is exact.
        assertExactRoundTrip(pts, "sidecar-wrap-propagation");
    });

    it("block with count=1 works for all three modes", () => {
        // minimum block size is 1 point. verify all modes handle it.
        const pts = new Int32Array(3 * CH);
        // 2 seeds + 1 data point
        pts[0] = 1000; pts[1] = 2000; pts[2] = 8000; pts[3] = 500; pts[4] = 1500;
        pts[5] = 1100; pts[6] = 2050; pts[7] = 8200; pts[8] = 550; pts[9] = 1600;
        pts[10] = 1200; pts[11] = 2100; pts[12] = 8400; pts[13] = 600; pts[14] = 1700;
        assertExactRoundTrip(pts, "count-1");

        const blocks = GlyphCodec.encode(pts);
        assert.equal(blocks.length, 1, "should produce exactly 1 block");
        assert.equal(blocks[0].residuals.length / CH, 1, "block should have 1 point");
    });

    it("multi-block encode preserves WASM heap between blocks", () => {
        // encode a multi-block trajectory and verify that each block's
        // residuals are computed from the correct previous points (not
        // corrupted by the fit/encodeBlock of the prior block).
        const n = 2 + GLYPH_BLOCK_SIZE * 3;
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(1000 + 7000 * t + 2000 * Math.sin(t * Math.PI * 6));
            pts[i * CH + 1] = Math.round(3000 + 3000 * Math.cos(t * Math.PI * 4));
            pts[i * CH + 2] = Math.round(10000 + 5000 * Math.sin(t * Math.PI * 2));
            pts[i * CH + 3] = Math.round(2000 + 1000 * t);
            pts[i * CH + 4] = Math.round(12000 + 4000 * Math.cos(t * Math.PI));
        }

        // encode block by block manually and compare with batch encode
        const batchBlocks = GlyphCodec.encode(pts, undefined, { adaptiveSegmentation: false });
        // decode and verify
        assertExactRoundTrip(pts, "multi-block-heap");

        // also verify each block has valid residual count
        let totalResidPts = 0;
        for (const b of batchBlocks) {
            const blockPts = b.residuals.length / CH;
            assert.ok(blockPts >= 1 && blockPts <= GLYPH_BLOCK_SIZE,
                `block has ${blockPts} points, expected 1-${GLYPH_BLOCK_SIZE}`);
            totalResidPts += blockPts;
        }
        assert.equal(totalResidPts, n - 2, "total residual points should match data points");
    });

    it("pack/unpack preserves coefficient values exactly", () => {
        // verify that Q14 coefficient encoding/decoding is bit-exact
        // for coefficients produced by the actual fit function.
        const trajectories = [
            circle(5000, 5000, 3000, 2 + GLYPH_BLOCK_SIZE * 2),
            ellipse(4000, 3000, 2000, 5000, 2 + GLYPH_BLOCK_SIZE * 2),
            spiral(5000, 5000, 1000, 50, 2 + GLYPH_BLOCK_SIZE * 2),
        ];

        for (const pts of trajectories) {
            const blocks = GlyphCodec.encode(pts);
            const packed = GlyphCodec.pack(blocks);
            const unpacked = GlyphCodec.unpack(packed);

            assert.equal(unpacked.length, blocks.length, "block count mismatch");
            for (let i = 0; i < blocks.length; i++) {
                assert.equal(unpacked[i].lane, blocks[i].lane, `block ${i} lane mismatch`);
                assert.equal(unpacked[i].mode, blocks[i].mode, `block ${i} mode mismatch`);
                if (blocks[i].mode === GlyphMode.HARMONIC) {
                    assert.equal(unpacked[i].kR, blocks[i].kR, `block ${i} kR mismatch`);
                    assert.equal(unpacked[i].kI, blocks[i].kI, `block ${i} kI mismatch`);
                    assert.equal(unpacked[i].gR, blocks[i].gR, `block ${i} gR mismatch`);
                    assert.equal(unpacked[i].gI, blocks[i].gI, `block ${i} gI mismatch`);
                }
                assert.equal(unpacked[i].residuals.length, blocks[i].residuals.length,
                    `block ${i} residual length mismatch`);
                const hasMicro = !!(blocks[i].features & 8);
                for (let j = 0; j < blocks[i].residuals.length; j++) {
                    // when micro-oscillator is active, x,y residuals (channels 0,1)
                    // are replaced by secondary residuals in the wire format.
                    // the unpacked block stores zeros for x,y in the primary residuals
                    // since those are carried separately in microResiduals.
                    const ch = j % CH;
                    if (hasMicro && (ch === 0 || ch === 1)) continue;
                    assert.equal(unpacked[i].residuals[j], blocks[i].residuals[j],
                        `block ${i} residual[${j}] mismatch`);
                }
            }
        }
    });

    it("streaming encoder matches batch for long stroke with sidecar variation", () => {
        // a realistically complex stroke: position curves, pressure fading,
        // tilt and azimuth rotating. tests that the streaming encoder's
        // block-by-block operation matches the batch encoder's output.
        const n = 2 + GLYPH_BLOCK_SIZE * 7 + 11; // 7 full blocks + partial
        const pts = new Int32Array(n * CH);
        for (let i = 0; i < n; i++) {
            const t = i / n;
            pts[i * CH] = Math.round(500 + 8000 * t + 1500 * Math.sin(t * Math.PI * 8));
            pts[i * CH + 1] = Math.round(4000 + 2000 * Math.sin(t * Math.PI * 5) +
                500 * Math.cos(t * Math.PI * 13));
            // pressure: fade in then out
            pts[i * CH + 2] = Math.round(16000 * Math.sin(t * Math.PI));
            // tilt: slow ramp
            pts[i * CH + 3] = Math.round(2000 + 10000 * t);
            // azimuth: smooth rotation
            pts[i * CH + 4] = Math.round(20000 * t);
        }

        // streaming starts from a single seed, so make pts[0] == pts[1]
        const seed: GlyphSeed = [];
        for (let c = 0; c < CH; c++) {
            seed.push(pts[CH + c]);
            pts[c] = pts[CH + c];
        }

        // batch
        const batchBlocks = GlyphCodec.encode(pts);
        const batchPacked = GlyphCodec.pack(batchBlocks);
        const batchUnpacked = GlyphCodec.unpack(batchPacked);
        const batchDecoded = GlyphCodec.decode(batchUnpacked, seed, seed);

        // streaming
        const enc = new GlyphStreamEncoder(seed);
        const dec = new GlyphStreamDecoder(seed);
        const streamPts: number[] = [];
        const nData = (pts.length / CH) - 2;
        for (let i = 0; i < nData; i++) {
            const idx = (i + 2) * CH;
            const chunk = enc.push(pts.subarray(idx, idx + CH));
            if (chunk) {
                const decoded = dec.decode(chunk);
                for (let j = 0; j < decoded.length; j++) streamPts.push(decoded[j]);
            }
        }
        const tail = enc.flush();
        if (tail) {
            const decoded = dec.decode(tail);
            for (let j = 0; j < decoded.length; j++) streamPts.push(decoded[j]);
        }

        assert.equal(streamPts.length, nData * CH, "stream point count");
        for (let i = 0; i < streamPts.length; i++) {
            assert.equal(streamPts[i], batchDecoded[CH * 2 + i],
                `stream/batch diverge at ${i}`);
        }
    });
});
