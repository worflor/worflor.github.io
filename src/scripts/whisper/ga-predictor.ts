/**
 * ga-predictor.ts — Cl(3) matrix AR(2) predictor for the glyph codec.
 *
 * predicts 3-vectors v[n] = M_K · v[n-1] - M_G · v[n-2] where v = (x, y, p)
 * and M_K, M_G are 3×3 real matrices fitted by least-squares. this is the
 * natural generalization of the current complex AR(2) (which is a 2×2 rotation
 * matrix on (x, y) plus an independent scalar AR(2) on pressure).
 *
 * the matrix fit captures cross-channel correlation that the split
 * approach can never see: pressure that correlates with curvature,
 * or position that correlates with grip force.
 */

// 3×3 matrix stored as flat row-major array [m00, m01, m02, m10, m11, m12, m20, m21, m22]
export type Mat3 = Float64Array;

export function mat3(): Mat3 { return new Float64Array(9); }
export function mat3identity(): Mat3 {
  const m = mat3();
  m[0] = m[4] = m[8] = 1;
  return m;
}

function mat3get(m: Mat3, r: number, c: number): number { return m[r * 3 + c]; }
function mat3set(m: Mat3, r: number, c: number, v: number): void { m[r * 3 + c] = v; }

export function mat3mulVec(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// ── 6×6 normal equation solver ──────────────────────────────────────────────

// the AR(2) prediction v[n] = M_K · v[n-1] - M_G · v[n-2] can be rewritten as:
//   v[n] = [M_K | -M_G] · [v[n-1]; v[n-2]]
// this is a 3×6 matrix applied to a 6-vector.
// for each output component i, we have:
//   v_i[n] = Σ_j W_ij · u_j[n]  where u = [v[n-1]; v[n-2]]
// the least-squares fit for each row is independent (3 separate 6-variable regressions).
// but it's cleaner to solve as one 6×6 system per output component.

export interface GAPredictorFit {
  M_K: Mat3;
  M_G: Mat3;
  residualL1: number;
  residualL2: number;
}

/**
 * fit the 3×3 AR(2) matrices M_K, M_G from point data.
 * points is Int32Array with CH=5 stride: [x, y, p, tilt, azim].
 * start/len define the block (start is the first PREDICTED point index,
 * so start-2 and start-1 are the two seed points).
 */
export function fitMatrix3(
  points: Int32Array,
  start: number,
  len: number,
  ch: number,
): GAPredictorFit {
  const M_K = mat3();
  const M_G = mat3();

  if (len < 3) return { M_K: mat3identity(), M_G: mat3(), residualL1: Infinity, residualL2: Infinity };

  // for each output component (x=0, y=1, p=2), solve:
  //   target_i[n] = w0·x[n-1] + w1·y[n-1] + w2·p[n-1] + w3·x[n-2] + w4·y[n-2] + w5·p[n-2]
  //
  // accumulate ATA (6×6 symmetric) and ATb (6×1) for each output component.
  // since ATA is the same for all 3 outputs (same predictor vectors), build it once.

  // ATA: 6×6 symmetric — only store upper triangle (21 values)
  const ata = new Float64Array(36); // full 6×6 for simplicity
  const atb = new Float64Array(18); // 3 output components × 6

  for (let n = 0; n < len; n++) {
    const idx = start + n;
    // predictor vector u = [v[n-1]; v[n-2]]
    const u0 = points[(idx - 1) * ch];       // x[n-1]
    const u1 = points[(idx - 1) * ch + 1];   // y[n-1]
    const u2 = points[(idx - 1) * ch + 2];   // p[n-1]
    const u3 = points[(idx - 2) * ch];       // x[n-2]
    const u4 = points[(idx - 2) * ch + 1];   // y[n-2]
    const u5 = points[(idx - 2) * ch + 2];   // p[n-2]
    const u = [u0, u1, u2, u3, u4, u5];

    // target vector t = [x[n], y[n], p[n]]
    const t0 = points[idx * ch];
    const t1 = points[idx * ch + 1];
    const t2 = points[idx * ch + 2];

    // accumulate ATA += u * u^T
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        ata[i * 6 + j] += u[i] * u[j];
      }
    }

    // accumulate ATb for each output component
    for (let j = 0; j < 6; j++) {
      atb[0 * 6 + j] += u[j] * t0; // x output
      atb[1 * 6 + j] += u[j] * t1; // y output
      atb[2 * 6 + j] += u[j] * t2; // p output
    }
  }

  // tikhonov regularization: add ε to diagonal
  let maxDiag = 0;
  for (let i = 0; i < 6; i++) maxDiag = Math.max(maxDiag, Math.abs(ata[i * 6 + i]));
  const eps = maxDiag * 1e-6;
  for (let i = 0; i < 6; i++) ata[i * 6 + i] += eps;

  // solve ATA · w = ATb for each output component via cholesky factorization
  const L = new Float64Array(36);
  if (!cholesky6(ata, L)) {
    return { M_K: mat3identity(), M_G: mat3(), residualL1: Infinity, residualL2: Infinity };
  }

  for (let out = 0; out < 3; out++) {
    const b = new Float64Array(6);
    for (let j = 0; j < 6; j++) b[j] = atb[out * 6 + j];
    const w = choleskySolve6(L, b);

    // w[0..2] = M_K row for this output, w[3..5] = -M_G row
    M_K[out * 3 + 0] = w[0];
    M_K[out * 3 + 1] = w[1];
    M_K[out * 3 + 2] = w[2];
    // the fit solves v[n] = W · [v[n-1]; v[n-2]], so the v[n-2] part is -M_G
    M_G[out * 3 + 0] = -w[3];
    M_G[out * 3 + 1] = -w[4];
    M_G[out * 3 + 2] = -w[5];
  }

  // compute residuals
  let l1 = 0, l2 = 0;
  for (let n = 0; n < len; n++) {
    const idx = start + n;
    const v1: [number, number, number] = [
      points[(idx - 1) * ch], points[(idx - 1) * ch + 1], points[(idx - 1) * ch + 2],
    ];
    const v2: [number, number, number] = [
      points[(idx - 2) * ch], points[(idx - 2) * ch + 1], points[(idx - 2) * ch + 2],
    ];
    const pred = predictMatrix3(M_K, M_G, v1, v2);
    for (let c = 0; c < 3; c++) {
      const actual = points[idx * ch + c];
      const err = actual - Math.round(pred[c]);
      l1 += Math.abs(err);
      l2 += err * err;
    }
  }

  return { M_K, M_G, residualL1: l1, residualL2: l2 };
}

export function predictMatrix3(
  M_K: Mat3, M_G: Mat3,
  v1: [number, number, number],
  v2: [number, number, number],
): [number, number, number] {
  const k = mat3mulVec(M_K, v1);
  const g = mat3mulVec(M_G, v2);
  return [k[0] - g[0], k[1] - g[1], k[2] - g[2]];
}

// ── rotor quality analysis ──────────────────────────────────────────────────

export interface RotorAnalysis {
  singularValues: [number, number, number];
  conditionRatio: number; // σ_min / σ_max (1.0 = pure rotation)
  frobeniusNorm: number;
}

// approximate SVD via eigenvalues of M^T M (3×3 symmetric matrix).
// returns singular values in descending order.
export function analyzeRotorQuality(M: Mat3): RotorAnalysis {
  // compute M^T * M (3×3 symmetric)
  const mtm = mat3();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += M[k * 3 + i] * M[k * 3 + j];
      mtm[i * 3 + j] = sum;
    }
  }

  // eigenvalues of 3×3 symmetric matrix via closed-form (Cardano's formula)
  const eigenvalues = symmetricEigenvalues3(mtm);
  const svs = eigenvalues.map(e => Math.sqrt(Math.max(0, e))).sort((a, b) => b - a) as [number, number, number];

  let frob = 0;
  for (let i = 0; i < 9; i++) frob += M[i] * M[i];

  return {
    singularValues: svs,
    conditionRatio: svs[2] > 1e-10 ? svs[2] / svs[0] : 0,
    frobeniusNorm: Math.sqrt(frob),
  };
}

// ── cholesky factorization for 6×6 positive-definite matrix ─────────────────

function cholesky6(A: Float64Array, L: Float64Array): boolean {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * 6 + k] * L[j * 6 + k];
      if (i === j) {
        const diag = A[i * 6 + i] - sum;
        if (diag <= 0) return false;
        L[i * 6 + j] = Math.sqrt(diag);
      } else {
        L[i * 6 + j] = (A[i * 6 + j] - sum) / L[j * 6 + j];
      }
    }
  }
  return true;
}

function choleskySolve6(L: Float64Array, b: Float64Array): Float64Array {
  const y = new Float64Array(6);
  // forward substitution: L y = b
  for (let i = 0; i < 6; i++) {
    let sum = 0;
    for (let j = 0; j < i; j++) sum += L[i * 6 + j] * y[j];
    y[i] = (b[i] - sum) / L[i * 6 + i];
  }
  // back substitution: L^T x = y
  const x = new Float64Array(6);
  for (let i = 5; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < 6; j++) sum += L[j * 6 + i] * x[j];
    x[i] = (y[i] - sum) / L[i * 6 + i];
  }
  return x;
}

// ── eigenvalues of 3×3 symmetric matrix (Cardano's formula) ─────────────────

function symmetricEigenvalues3(A: Mat3): [number, number, number] {
  const a = A[0], b = A[1], c = A[2];
  const d = A[4], e = A[5];
  const f = A[8];
  // characteristic polynomial: λ³ - p·λ² + q·λ - r = 0
  const p = a + d + f; // trace
  const q = a * d + a * f + d * f - b * b - c * c - e * e;
  const r = a * d * f + 2 * b * c * e - a * e * e - d * c * c - f * b * b; // determinant

  // use Cardano-Vieta for depressed cubic
  const p3 = p / 3;
  const q2 = (p * p - 3 * q) / 9;
  const r2 = (2 * p * p * p - 9 * p * q + 27 * r) / 54;

  if (q2 <= 0) return [p3, p3, p3];
  const sq = Math.sqrt(q2);
  const sq3 = q2 * sq;

  if (sq3 < 1e-30) return [p3, p3, p3];
  let phi = Math.acos(Math.max(-1, Math.min(1, r2 / sq3)));

  return [
    -2 * sq * Math.cos(phi / 3) + p3,
    -2 * sq * Math.cos((phi + 2 * Math.PI) / 3) + p3,
    -2 * sq * Math.cos((phi + 4 * Math.PI) / 3) + p3,
  ];
}
