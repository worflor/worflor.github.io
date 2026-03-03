export interface DrawExportStats {
  mode: "blank" | "annotate";
  logicalPixels: number;
  strokeCount: number;
  pointCount: number;
  coverageRatio: number;
  uniquePenColors: number;
  inkEntropyProxy: number;
}

export interface DrawExportPlan {
  primaryQuality: number;
  fallbackQuality: number;
  tryFallback: boolean;
  fallbackSavingsRatio: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}

function q(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Build adaptive WebP quality plan.
 *
 * Goals:
 * - Keep draw feel untouched (export-only change, no pointer path mutation).
 * - Stabilize payload size behavior across sparse vs dense drawings.
 * - Bias toward smaller payloads, but avoid aggressive quality cliffs.
 */
export function buildDrawExportPlan(stats: DrawExportStats): DrawExportPlan {
  const coverage = clamp(stats.coverageRatio, 0, 1);
  const logicalPixels = Math.max(1, stats.logicalPixels | 0);
  const strokes = Math.max(0, stats.strokeCount | 0);
  const points = Math.max(0, stats.pointCount | 0);
  const uniquePenColors = Math.max(1, stats.uniquePenColors | 0);
  const inkEntropy = clamp(stats.inkEntropyProxy, 0, 1);

  let quality = stats.mode === "annotate" ? 0.89 : 0.84;
  let fallbackDelta = 0.08;
  let fallbackSavingsRatio = 0.07;

  // Size pressure from resolution.
  if (logicalPixels > 900_000) quality -= 0.03;
  else if (logicalPixels > 600_000) quality -= 0.02;
  else if (logicalPixels < 250_000) quality += 0.01;

  // Coverage + path complexity tuning.
  if (coverage < 0.08 && strokes < 40) quality -= 0.03;
  else if (coverage < 0.16) quality -= 0.015;
  else if (coverage > 0.42 || points > 5000) quality += 0.02;
  else if (points > 2500) quality += 0.01;

  // Blank scribbles with many colors are highly incompressible. Favor smaller payloads.
  if (stats.mode === "blank") {
    quality -= inkEntropy * 0.05;
    fallbackDelta += inkEntropy * 0.025;
    fallbackSavingsRatio = Math.max(0.01, fallbackSavingsRatio - inkEntropy * 0.03);

    if (points > 5000 || coverage > 0.42) quality -= 0.035;
    else if (points > 2500) quality -= 0.015;

    if (uniquePenColors >= 3 && points >= 1200) {
      quality -= 0.025;
      fallbackDelta += 0.02;
      fallbackSavingsRatio = 0.03;
    }
    if (uniquePenColors >= 4 && coverage >= 0.16) {
      quality -= 0.015;
      fallbackDelta += 0.015;
      fallbackSavingsRatio = 0.02;
    }
  }

  // For annotations, the base image carries detail; sparse ink can tolerate lower Q.
  if (stats.mode === "annotate" && coverage < 0.14) quality -= 0.015;
  if (stats.mode === "annotate") {
    quality -= inkEntropy * 0.012;
  }

  const minPrimaryQuality = stats.mode === "annotate" ? 0.76 : 0.70;
  const minFallbackQuality = stats.mode === "annotate" ? 0.70 : 0.62;
  quality = clamp(quality, minPrimaryQuality, 0.93);
  const fallback = clamp(quality - fallbackDelta, minFallbackQuality, 0.89);

  const tryFallback =
    logicalPixels >= 300_000 ||
    points >= 1400 ||
    coverage <= 0.22 ||
    coverage >= 0.55 ||
    uniquePenColors >= 3 ||
    inkEntropy >= 0.42;

  return {
    primaryQuality: q(quality),
    fallbackQuality: q(fallback),
    tryFallback,
    fallbackSavingsRatio: q(clamp(fallbackSavingsRatio, 0.01, 0.10)),
  };
}
