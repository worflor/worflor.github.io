// Fog Worker - Handles fog computation off the main thread
// Used by void-game.ts for the 404 page

/// <reference lib="webworker" />

// Worker-specific self reference
declare const self: Worker & typeof globalThis;
export {}; // Make this a module

// ============================================================================
// TYPES
// ============================================================================

interface FogConfig {
  readonly revealRes: number;
  readonly revealDecay: number;
}

interface CreatureData {
  readonly x: number;
  readonly y: number;
  readonly revealRadius: number;
  readonly glow: number;
  readonly warmth: number;
}

interface MonolithData {
  readonly x: number;
  readonly y: number;
  readonly presence: number;
}

interface RevealPoint {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

// Messages from main thread
type WorkerInMessage =
  | { readonly type: "init"; readonly width: number; readonly height: number; readonly config: FogConfig }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "updateEntities"; readonly creatures: readonly CreatureData[]; readonly monoliths: readonly MonolithData[] }
  | { readonly type: "reveal"; readonly points: readonly RevealPoint[] }
  | { readonly type: "decay" }
  | { readonly type: "render" }
  | { readonly type: "getRevealMap" }
  | { readonly type: "setRevealMap"; readonly data: Float32Array };

// Messages to main thread
type WorkerOutMessage =
  | { readonly type: "ready" }
  | { readonly type: "rendered"; readonly bitmap: ImageBitmap; readonly changed: boolean }
  | { readonly type: "revealMap"; readonly data: Float32Array }
  | { readonly type: "fogDirty"; readonly dirty: boolean };

// ============================================================================
// CONSTANTS
// ============================================================================

// Bayer 4x4 ordered dithering matrix (normalized 0-1)
const BAYER_4X4: readonly number[] = [
  0 / 16, 8 / 16, 2 / 16, 10 / 16,
  12 / 16, 4 / 16, 14 / 16, 6 / 16,
  3 / 16, 11 / 16, 1 / 16, 9 / 16,
  15 / 16, 7 / 16, 13 / 16, 5 / 16,
] as const;

const FOG_COLOR = { r: 10, g: 10, b: 10 } as const;

// ============================================================================
// STATE
// ============================================================================

let config: FogConfig = { revealRes: 8, revealDecay: 0.0004 };
let width = 0;
let height = 0;
let revealW = 0;
let revealH = 0;
let revealMap: Float32Array | null = null;
let lastRevealTime: Float32Array | null = null; // Track when each cell was last revealed
let frameCounter = 0;
let fogDirty = true;

// How long revealed cells stay protected after creature leaves (in frames, ~3 seconds at 60fps)
const LINGER_DURATION = 180;

let offscreen: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
let imageData: ImageData | null = null;

// Pre-allocated for protected cells
const protectedCells = new Set<number>();

// Cached entity data
let cachedCreatures: readonly CreatureData[] = [];
let cachedMonoliths: readonly MonolithData[] = [];

// ============================================================================
// INITIALIZATION
// ============================================================================

function init(w: number, h: number, cfg: FogConfig): void {
  config = cfg;
  resize(w, h);
  self.postMessage({ type: "ready" } as WorkerOutMessage);
}

function resize(w: number, h: number): void {
  const oldRevealMap = revealMap;
  const oldLastRevealTime = lastRevealTime;
  const oldRevealW = revealW;
  const oldRevealH = revealH;

  width = w;
  height = h;
  revealW = Math.ceil(w / config.revealRes);
  revealH = Math.ceil(h / config.revealRes);
  revealMap = new Float32Array(revealW * revealH);
  lastRevealTime = new Float32Array(revealW * revealH);

  // Preserve old reveal data if possible
  if (oldRevealMap && oldRevealW > 0 && oldRevealH > 0) {
    const scaleX = oldRevealW / revealW;
    const scaleY = oldRevealH / revealH;
    for (let gy = 0; gy < revealH; gy++) {
      for (let gx = 0; gx < revealW; gx++) {
        const ox = Math.floor(gx * scaleX);
        const oy = Math.floor(gy * scaleY);
        if (ox < oldRevealW && oy < oldRevealH) {
          const oldIdx = oy * oldRevealW + ox;
          const newIdx = gy * revealW + gx;
          revealMap[newIdx] = oldRevealMap[oldIdx];
          if (oldLastRevealTime) {
            lastRevealTime[newIdx] = oldLastRevealTime[oldIdx];
          }
        }
      }
    }
  }

  offscreen = new OffscreenCanvas(w, h);
  offscreenCtx = offscreen.getContext("2d");
  if (offscreenCtx) {
    imageData = offscreenCtx.createImageData(w, h);
  }
  fogDirty = true;
}

// ============================================================================
// REVEAL UPDATES
// ============================================================================

function updateEntities(creatures: readonly CreatureData[], monoliths: readonly MonolithData[]): void {
  cachedCreatures = creatures;
  cachedMonoliths = monoliths;
  frameCounter++;

  if (!revealMap || !lastRevealTime) return;

  const { revealRes } = config;
  const revealResSq = revealRes * revealRes;

  // Update reveal from creatures (warmth-based additive system)
  for (const c of creatures) {
    // Warmth-based reveal - warm creatures illuminate more
    const warmthMultiplier = 0.4 + c.warmth * 0.9;
    const radius = c.revealRadius * warmthMultiplier;
    const revealIntensity = 0.014 + c.warmth * 0.016;
    const emissionIntensity = c.glow * (0.5 + c.warmth * 0.5);

    const cx = Math.floor(c.x / revealRes);
    const cy = Math.floor(c.y / revealRes);
    const r = Math.ceil(radius / revealRes);
    const radiusSq = radius * radius;
    const invRadius = 1 / radius;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) continue;

        const distSq = (dx * dx + dy * dy) * revealResSq;
        if (distSq < radiusSq) {
          const d = Math.sqrt(distSq);
          const idx = gy * revealW + gx;
          const falloff = 1 - d * invRadius;
          const intensity = falloff * revealIntensity * emissionIntensity;
          const newVal = Math.min(1, revealMap[idx] + intensity);
          if (newVal > revealMap[idx]) {
            revealMap[idx] = newVal;
            fogDirty = true;
          }
          // Track when this cell was revealed (for lingering)
          if (intensity > 0.05) {
            lastRevealTime[idx] = frameCounter;
          }
        }
      }
    }
  }

  // Update reveal from monoliths
  for (const m of monoliths) {
    if (m.presence <= 0.05) continue;

    const cx = Math.floor(m.x / revealRes);
    const cy = Math.floor(m.y / revealRes);
    const effectiveRadius = 30 + m.presence * 70;
    const r = Math.ceil(effectiveRadius / revealRes);
    const radiusSq = effectiveRadius * effectiveRadius;
    const invRadius = 1 / effectiveRadius;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) continue;

        const distSq = (dx * dx + dy * dy) * revealResSq;
        if (distSq < radiusSq) {
          const d = Math.sqrt(distSq);
          const idx = gy * revealW + gx;
          const falloff = 1 - d * invRadius;
          const intensity = falloff * (0.5 + m.presence * 0.5);
          if (intensity > revealMap[idx]) {
            revealMap[idx] = intensity;
            fogDirty = true;
          }
          // Track when this cell was revealed (for lingering)
          if (intensity > 0.1) {
            lastRevealTime[idx] = frameCounter;
          }
        }
      }
    }
  }
}

function addRevealPoints(points: readonly RevealPoint[]): void {
  if (!revealMap || !lastRevealTime) return;

  const { revealRes } = config;
  const revealResSq = revealRes * revealRes;

  for (const point of points) {
    const cx = Math.floor(point.x / revealRes);
    const cy = Math.floor(point.y / revealRes);
    const r = Math.ceil(point.radius / revealRes);
    const radiusSq = point.radius * point.radius;
    const invRadius = 1 / point.radius;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) continue;

        const distSq = (dx * dx + dy * dy) * revealResSq;
        if (distSq < radiusSq) {
          const d = Math.sqrt(distSq);
          const idx = gy * revealW + gx;
          const falloff = 1 - d * invRadius;
          const newVal = Math.min(1, revealMap[idx] + falloff * point.intensity);
          if (newVal > revealMap[idx]) {
            revealMap[idx] = newVal;
            fogDirty = true;
          }
          // Track when this cell was revealed (for lingering)
          if (falloff * point.intensity > 0.1) {
            lastRevealTime[idx] = frameCounter;
          }
        }
      }
    }
  }
}

// ============================================================================
// FOG DECAY
// ============================================================================

function computeDecay(): void {
  if (!revealMap || !lastRevealTime) return;

  const { revealRes, revealDecay } = config;
  const revealResSq = revealRes * revealRes;

  // Build protected cells set (cells currently near entities)
  protectedCells.clear();

  // Protect cells near creatures
  for (const c of cachedCreatures) {
    const cx = Math.floor(c.x / revealRes);
    const cy = Math.floor(c.y / revealRes);
    const r = Math.ceil(c.revealRadius / revealRes);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx >= 0 && gx < revealW && gy >= 0 && gy < revealH) {
          protectedCells.add(gy * revealW + gx);
        }
      }
    }
  }

  // Protect cells near active monoliths
  for (const m of cachedMonoliths) {
    if (m.presence <= 0.05) continue;

    const mx = Math.floor(m.x / revealRes);
    const my = Math.floor(m.y / revealRes);
    const protectRadius = 30 + m.presence * 70;
    const protectRadiusSq = protectRadius * protectRadius;
    const r = Math.ceil(protectRadius / revealRes);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gx = mx + dx;
        const gy = my + dy;
        if (gx >= 0 && gx < revealW && gy >= 0 && gy < revealH) {
          const dSq = (dx * dx + dy * dy) * revealResSq;
          if (dSq < protectRadiusSq) {
            protectedCells.add(gy * revealW + gx);
          }
        }
      }
    }
  }

  // Apply decay to cells that are:
  // 1. Not currently near an entity (not in protectedCells)
  // 2. Not recently revealed (outside linger duration)
  const decayAmount = revealDecay * 3;
  const lingerThreshold = frameCounter - LINGER_DURATION;

  for (let i = 0; i < revealMap.length; i++) {
    if (revealMap[i] > 0 && !protectedCells.has(i)) {
      // Check if this cell was revealed recently (within linger duration)
      if (lastRevealTime[i] < lingerThreshold) {
        revealMap[i] = Math.max(0, revealMap[i] - decayAmount);
        fogDirty = true;
      }
    }
  }
}

// ============================================================================
// RENDERING
// ============================================================================

function render(): void {
  if (!revealMap || !offscreen || !offscreenCtx || !imageData) return;

  if (!fogDirty) return;

  if (fogDirty) {
    const data = imageData.data;
    const { revealRes } = config;

    // Clear to transparent
    data.fill(0);

    for (let gy = 0; gy < revealH; gy++) {
      const py = gy * revealRes;
      const pyEnd = Math.min(py + revealRes, height);

      for (let gx = 0; gx < revealW; gx++) {
        const revealed = revealMap[gy * revealW + gx];
        if (revealed >= 0.98) continue;

        const darkness = (1 - revealed) * 0.95;
        if (darkness < 0.01) continue;

        const px = gx * revealRes;
        const pxEnd = Math.min(px + revealRes, width);
        const isEdge = darkness <= 0.05 || darkness >= 0.85;

        for (let y = py; y < pyEnd; y++) {
          const rowOffset = y * width * 4;
          for (let x = px; x < pxEnd; x++) {
            if (isEdge) {
              const bx = x & 3;
              const by = y & 3;
              const threshold = BAYER_4X4[by * 4 + bx];
              if (darkness < threshold) continue;
            }

            const i = rowOffset + x * 4;
            data[i] = FOG_COLOR.r;
            data[i + 1] = FOG_COLOR.g;
            data[i + 2] = FOG_COLOR.b;
            data[i + 3] = isEdge ? 242 : Math.floor(darkness * 255);
          }
        }
      }
    }

    offscreenCtx.putImageData(imageData, 0, 0);
    fogDirty = false;
  }

  // Create bitmap and transfer only when fog changed
  const bitmap = offscreen.transferToImageBitmap();
  self.postMessage(
    { type: "rendered", bitmap, changed: true } as WorkerOutMessage,
    { transfer: [bitmap] }
  );
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  try {
    const msg = e.data;

    switch (msg.type) {
      case "init":
        init(msg.width, msg.height, msg.config);
        break;

      case "resize":
        resize(msg.width, msg.height);
        break;

      case "updateEntities":
        updateEntities(msg.creatures, msg.monoliths);
        break;

      case "reveal":
        addRevealPoints(msg.points);
        break;

      case "decay":
        computeDecay();
        break;

      case "render":
        render();
        break;

      case "getRevealMap":
        if (revealMap) {
          const copy = new Float32Array(revealMap);
          self.postMessage(
            { type: "revealMap", data: copy } as WorkerOutMessage,
            { transfer: [copy.buffer] }
          );
        }
        break;

      case "setRevealMap":
        if (revealMap && msg.data.length === revealMap.length) {
          revealMap.set(msg.data);
          fogDirty = true;
        }
        break;

      default:
        break;
    }
  } catch {
    // Worker continues
  }
};

// Export types for main thread
export type { WorkerInMessage, WorkerOutMessage, FogConfig, CreatureData, MonolithData, RevealPoint };
