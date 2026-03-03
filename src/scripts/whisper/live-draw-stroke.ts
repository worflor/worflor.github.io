export interface DrawPoint {
  x: number;
  y: number;
  p: number;
}

export interface TimedDrawPoint extends DrawPoint {
  t: number;
}

export interface StrokeSamplerState {
  lastKept: TimedDrawPoint;
  lastRaw: TimedDrawPoint;
  prevPressure: number;
  hasPrevVec: boolean;
  prevVecX: number;
  prevVecY: number;
  filteredXPx: number;
  filteredYPx: number;
  dFilteredXPx: number;
  dFilteredYPx: number;
  filterReady: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}

function quantizeNormalized(v: number, logicalSize: number): number {
  const px = v * logicalSize;
  const q = Math.round(px * 16) / 16;
  return logicalSize > 0 ? q / logicalSize : v;
}

function lowPassAlpha(cutoffHz: number, dtSec: number): number {
  if (cutoffHz <= 0 || dtSec <= 0) return 1;
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSec);
}

function lowPass(prev: number, cur: number, cutoffHz: number, dtSec: number): number {
  const alpha = clamp(lowPassAlpha(cutoffHz, dtSec), 0, 1);
  return prev + alpha * (cur - prev);
}

function adaptiveMinDistSq(speedPxPerMs: number): number {
  const minDist = clamp(0.35 + speedPxPerMs * 1.1, 0.35, 2.1);
  return minDist * minDist;
}

const ONE_EURO_MIN_CUTOFF_HZ = 1.6;
const ONE_EURO_BETA = 0.02;
const ONE_EURO_DERIV_CUTOFF_HZ = 1.5;

function smoothPressure(prevPressure: number, rawPressure: number, speedPxPerMs: number): number {
  const alpha = clamp(0.24 + speedPxPerMs * 0.24, 0.24, 0.58);
  return clamp(prevPressure * alpha + rawPressure * (1 - alpha), 0, 1);
}

function isSharpTurn(prevX: number, prevY: number, nextX: number, nextY: number): boolean {
  const prevLenSq = prevX * prevX + prevY * prevY;
  const nextLenSq = nextX * nextX + nextY * nextY;
  if (prevLenSq < 0.3 || nextLenSq < 0.3) return false;
  const dot = prevX * nextX + prevY * nextY;
  const denom = Math.sqrt(prevLenSq * nextLenSq);
  if (denom <= 1e-6) return false;
  const cosTheta = dot / denom;
  return cosTheta < 0.25;
}

export function createStrokeSampler(start: TimedDrawPoint): StrokeSamplerState {
  return {
    lastKept: { x: start.x, y: start.y, p: start.p, t: start.t },
    lastRaw: { x: start.x, y: start.y, p: start.p, t: start.t },
    prevPressure: start.p,
    hasPrevVec: false,
    prevVecX: 0,
    prevVecY: 0,
    filteredXPx: 0,
    filteredYPx: 0,
    dFilteredXPx: 0,
    dFilteredYPx: 0,
    filterReady: false,
  };
}

/**
 * Single production pipeline for stroke capture:
 * - One-Euro positional filtering (slow-speed denoise, high-speed responsiveness)
 * - pressure smoothing
 * - speed-aware distance threshold
 * - corner preservation at tight turns
 * - half-pixel coordinate quantization for stable geometry
 */
export function sampleStrokePoint(
  state: StrokeSamplerState,
  raw: TimedDrawPoint,
  logicalW: number,
  logicalH: number,
): { keep: boolean; point: DrawPoint } {
  const rawDxPx = (raw.x - state.lastRaw.x) * logicalW;
  const rawDyPx = (raw.y - state.lastRaw.y) * logicalH;
  const rawDist = Math.hypot(rawDxPx, rawDyPx);
  const dt = Math.max(1, raw.t - state.lastRaw.t);
  const dtSec = dt * 0.001;
  const speedPxPerMs = rawDist / dt;
  const rawXPx = raw.x * logicalW;
  const rawYPx = raw.y * logicalH;

  if (!state.filterReady) {
    state.filteredXPx = rawXPx;
    state.filteredYPx = rawYPx;
    state.dFilteredXPx = 0;
    state.dFilteredYPx = 0;
    state.filterReady = true;
  } else {
    const dxPxPerSec = (rawXPx - state.lastRaw.x * logicalW) / dtSec;
    const dyPxPerSec = (rawYPx - state.lastRaw.y * logicalH) / dtSec;
    state.dFilteredXPx = lowPass(state.dFilteredXPx, dxPxPerSec, ONE_EURO_DERIV_CUTOFF_HZ, dtSec);
    state.dFilteredYPx = lowPass(state.dFilteredYPx, dyPxPerSec, ONE_EURO_DERIV_CUTOFF_HZ, dtSec);

    const speedPxPerSec = Math.hypot(state.dFilteredXPx, state.dFilteredYPx);
    const cutoffHz = ONE_EURO_MIN_CUTOFF_HZ + ONE_EURO_BETA * speedPxPerSec;

    state.filteredXPx = lowPass(state.filteredXPx, rawXPx, cutoffHz, dtSec);
    state.filteredYPx = lowPass(state.filteredYPx, rawYPx, cutoffHz, dtSec);
  }

  const p = smoothPressure(state.prevPressure, raw.p, speedPxPerMs);
  const qx = quantizeNormalized(state.filteredXPx / logicalW, logicalW);
  const qy = quantizeNormalized(state.filteredYPx / logicalH, logicalH);
  const point: DrawPoint = { x: qx, y: qy, p };

  const keepDxPx = (point.x - state.lastKept.x) * logicalW;
  const keepDyPx = (point.y - state.lastKept.y) * logicalH;
  const keepDistSq = keepDxPx * keepDxPx + keepDyPx * keepDyPx;
  const minDistSq = adaptiveMinDistSq(speedPxPerMs);

  let keep = keepDistSq >= minDistSq;
  if (!keep && state.hasPrevVec) {
    if (isSharpTurn(state.prevVecX, state.prevVecY, keepDxPx, keepDyPx) && keepDistSq >= minDistSq * 0.25) {
      keep = true;
    }
  }

  state.lastRaw.x = raw.x;
  state.lastRaw.y = raw.y;
  state.lastRaw.t = raw.t;
  state.lastRaw.p = p;
  state.prevPressure = p;

  if (keep) {
    state.hasPrevVec = true;
    state.prevVecX = keepDxPx;
    state.prevVecY = keepDyPx;
    state.lastKept.x = point.x;
    state.lastKept.y = point.y;
    state.lastKept.p = point.p;
    state.lastKept.t = raw.t;
  }

  return { keep, point };
}
