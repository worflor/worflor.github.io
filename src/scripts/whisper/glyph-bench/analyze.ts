/**
 * analyze.ts — does the complex plane ever pay on real strokes?
 *
 * controls for the two confounds:
 *   1. glyph's 4-byte container header (uses payload-only bytes).
 *   2. the rotationality of the motion (the complex plane couples x,y, a bet
 *      that the stroke turns; axis-separable strokes should favour real AR(2)).
 *
 * stratifies real Quick Draw strokes by curvature and by length and reports,
 * per stratum, how the complex predictor's payload compares to the decoupled
 * real-AR(2) predictor's. no paper output; this is a diagnostic.
 */

import { CH, type Stroke } from "./corpus.js";
import { loadReal } from "./realcorpus.js";
import { cGlyph, cRealAR2Logos, cDeltaLogos } from "./methods.js";

// mean absolute turning angle per interior sample: 0 for a straight line,
// large for a tight scribble. a scale-free measure of how much the motion turns.
function rotationality(s: Stroke): number {
    const n = s.points.length / CH;
    if (n < 3) return 0;
    let sum = 0, cnt = 0;
    for (let i = 1; i < n - 1; i++) {
        const ax = s.points[i * CH] - s.points[(i - 1) * CH];
        const ay = s.points[i * CH + 1] - s.points[(i - 1) * CH + 1];
        const bx = s.points[(i + 1) * CH] - s.points[i * CH];
        const by = s.points[(i + 1) * CH + 1] - s.points[i * CH + 1];
        const na = Math.hypot(ax, ay), nb = Math.hypot(bx, by);
        if (na < 1e-9 || nb < 1e-9) continue;
        const cross = ax * by - ay * bx, dot = ax * bx + ay * by;
        sum += Math.abs(Math.atan2(cross, dot));
        cnt++;
    }
    return cnt ? sum / cnt : 0;
}

const data = loadReal();
console.log(`corpus: ${data.strokes.length} strokes, mean length ${data.meanLen.toFixed(1)}`);

interface Rec { len: number; turn: number; glyph: number; real: number; delta: number; }
const recs: Rec[] = data.strokes.map(s => {
    const n = s.points.length / CH;
    return {
        len: n, turn: rotationality(s),
        glyph: cGlyph(s).payload,        // header-stripped
        real: cRealAR2Logos(s),
        delta: cDeltaLogos(s),
    };
});

function report(label: string, key: (r: Rec) => number, bins: number[]): void {
    console.log(`\n=== stratified by ${label} ===`);
    console.log(`${"stratum".padEnd(16)} ${"N".padStart(4)} ${"glyphBPS".padStart(9)} ${"realBPS".padStart(8)} ${"g/real".padStart(7)} ${"glyph<real".padStart(11)}`);
    const edges = [0, ...bins, Infinity];
    for (let b = 0; b < edges.length - 1; b++) {
        const lo = edges[b], hi = edges[b + 1];
        const grp = recs.filter(r => key(r) >= lo && key(r) < hi);
        if (grp.length === 0) continue;
        let gB = 0, rB = 0, samp = 0, wins = 0;
        for (const r of grp) {
            gB += r.glyph; rB += r.real; samp += r.len;
            if (r.glyph < r.real) wins++;
        }
        const gbps = (gB * 8) / samp, rbps = (rB * 8) / samp;
        const range = hi === Infinity ? `${lo.toFixed(2)}+` : `${lo.toFixed(2)}-${hi.toFixed(2)}`;
        console.log(`${range.padEnd(16)} ${String(grp.length).padStart(4)} ${gbps.toFixed(2).padStart(9)} ${rbps.toFixed(2).padStart(8)} ${(gbps / rbps).toFixed(3).padStart(7)} ${(100 * wins / grp.length).toFixed(0).padStart(10)}%`);
    }
}

// overall, payload-stripped
const gAll = recs.reduce((a, r) => a + r.glyph, 0), rAll = recs.reduce((a, r) => a + r.real, 0);
const dAll = recs.reduce((a, r) => a + r.delta, 0), sAll = recs.reduce((a, r) => a + r.len, 0);
console.log(`\noverall (payload-only): glyph ${(gAll * 8 / sAll).toFixed(2)} | real ${(rAll * 8 / sAll).toFixed(2)} | delta ${(dAll * 8 / sAll).toFixed(2)} bps`);
console.log(`overall glyph/real ratio: ${(gAll / rAll).toFixed(3)}  (<1 means complex wins)`);

report("rotationality (rad/sample)", r => r.turn, [0.15, 0.30, 0.50, 0.80]);
report("length (samples)", r => r.len, [40, 70, 110, 180]);

// the high-turn, long-stroke corner: where the complex plane should be happiest
const corner = recs.filter(r => r.turn >= 0.30 && r.len >= 70);
if (corner.length) {
    const g = corner.reduce((a, r) => a + r.glyph, 0), rr = corner.reduce((a, r) => a + r.real, 0), ss = corner.reduce((a, r) => a + r.len, 0);
    console.log(`\nrotational & long (turn>=0.30, len>=70): N=${corner.length}, glyph ${(g * 8 / ss).toFixed(2)} vs real ${(rr * 8 / ss).toFixed(2)} bps, ratio ${(g / rr).toFixed(3)}`);
}
