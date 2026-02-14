// THE VOID - Creature Simulation
// TypeScript port of 404.astro inline game

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

// Structural type for Hole references (class defined inside initVoidGame)
interface HoleRef {
  x: number;
  y: number;
  radius: number;
}

// Structural type for Creature references (class defined inside initVoidGame)
interface CreatureRef {
  id: string;
  x: number;
  y: number;
  isDead: boolean;
}

// Mouse state
interface MouseState {
  x: number;
  y: number;
  down: boolean;
  rightDown: boolean;
  holdTime: number;
  rightHoldTime: number;
  tappedHole: HoleRef | null;
}

// Creature memory system
interface MemorySpot {
  x: number;
  y: number;
  strength: number;
}

interface CreatureMemory {
  goodSpots: MemorySpot[];
  badSpots: MemorySpot[];
  fedCount: number;
  petCount: number;
  droppedInDark: number;
  lastFedTime: number;
  lastPetTime: number;
}

// Social systems
interface Bond {
  strength: number;
  sharedTime: number;
  sharedMeals: number;
  lastSeen: number;
}

interface SocialMemory {
  helpedMe: number;
  iHelped: number;
  lastPositive: number;
}

interface SocialContext {
  nearbyHunger: number;
  nearbyFear: number;
  nearbyLoneliness: number;
  neediest: CreatureRef | null;
  neediestType: "hunger" | "fear" | "loneliness" | null;
  lastUpdate: number;
}

// Structure details
interface Sparkle {
  angle: number;
  dist: number;
  phase: number;
  speed: number;
}

interface Rune {
  y: number;
  width: number;
  phase: number;
  speed: number;
}

interface Debris {
  angle: number;
  dist: number;
  size: number;
  hue: number;
}

interface FissureSegment {
  x: number;
  y: number;
  width?: number;
}

interface FissureBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Terrain
interface TerrainFeature {
  type: "safeZone" | "glow";
  x: number;
  y: number;
  radius: number;
  intensity: number;
  hue?: number;
}

// Spawn config
interface SpawnPositionConfig {
  margin?: number;
  maxAttempts?: number;
  avoidPoints?: Array<{ x: number; y: number; radius: number }>;
  avoidCreatures?: boolean;
  creatureBuffer?: number;
  seeded?: boolean;
}

// Serialization
interface SerializedCreature {
  id: string;
  x: number;
  y: number;
  name: string;
  generation: number;
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  stability: number;
  roundness: number;
  glow: number;
  hue: number;
  energy: number;
  happiness: number;
  age: number;
  size: number;
  targetSize: number;
  friends: string[];
  bonds: [string, Bond][];
  parentId: string | null;
  trust: number;
  fear: number;
  stress: number;
  attachment: number;
  fatigue: number;
  restedness: number;
  moodBaseline: number;
  homeX: number;
  homeY: number;
  homeStrength: number;
  sleeping: boolean;
  memories: CreatureMemory;
  comforted: number;
  lonely: number;
  anticipation: number;
  vx: number;
  vy: number;
}

interface SaveData {
  creatures: SerializedCreature[];
  revealMap: number[] | null;
  revealDims: { w: number; h: number } | null;
}

// Init options
interface GameInitOptions {
  canvas: HTMLCanvasElement;
  lostPath: HTMLElement;
  titleSub: HTMLElement;
  title: HTMLElement;
  toast: HTMLElement;
  tooltip: HTMLElement;
  pickupRing: HTMLCanvasElement;
  homeBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
}

// Type aliases
type FoodType = "white" | "green" | "purple" | "cyan";
type ParticleType = "birth" | "death" | "eat" | "pet" | "ripple" | "void";
type Expression =
  | "neutral"
  | "happy"
  | "scared"
  | "nervous"
  | "sleepy"
  | "eating"
  | "sad"
  | "surprised"
  | "loved";
type LifeStage = "baby" | "child" | "adult" | "elder";

// ============================================================================
// FOG WORKER TYPES
// ============================================================================

interface FogWorkerConfig {
  readonly revealRes: number;
  readonly revealDecay: number;
}

interface FogCreatureData {
  readonly x: number;
  readonly y: number;
  readonly revealRadius: number;
  readonly glow: number;
  readonly warmth: number;
}

interface FogMonolithData {
  readonly x: number;
  readonly y: number;
  readonly presence: number;
}

interface FogRevealPoint {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

type FogWorkerInMessage =
  | { readonly type: "init"; readonly width: number; readonly height: number; readonly config: FogWorkerConfig }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "updateEntities"; readonly creatures: readonly FogCreatureData[]; readonly monoliths: readonly FogMonolithData[] }
  | { readonly type: "reveal"; readonly points: readonly FogRevealPoint[] }
  | { readonly type: "decay" }
  | { readonly type: "render" }
  | { readonly type: "getRevealMap" }
  | { readonly type: "setRevealMap"; readonly data: Float32Array };

type FogWorkerOutMessage =
  | { readonly type: "ready" }
  | { readonly type: "rendered"; readonly changed: boolean; readonly bitmap?: ImageBitmap }
  | { readonly type: "revealMap"; readonly data: Float32Array }
  | { readonly type: "fogDirty"; readonly dirty: boolean };

// ============================================================================
// GAME CONSTANTS
// ============================================================================

const CONFIG = {
  // Timing
  PICKUP_HOLD_TIME: 35,
  FOOD_DROP_INTERVAL: 12,
  TOOLTIP_DURATION: 3000,
  RESPAWN_DELAY: 2000,
  SAVE_INTERVAL: 400,

  // Simulation
  BASE_ENERGY_DRAIN: 0.008,
  COMFORT_RADIUS: 100,
  SOCIAL_RADIUS: 45,
  FRIEND_RADIUS: 22,
  FOOD_SEEK_RADIUS: 150,
  WANDER_RADIUS: 70,

  // Reproduction
  MIN_REPRODUCE_AGE: 2400,
  REPRODUCE_CHANCE: 0.00015,
  REPRODUCE_ENERGY_COST: 40,

  // Life stages (in ticks, ~60/sec)
  BABY_AGE: 600,
  CHILD_AGE: 3600,
  ADULT_AGE: 36000,
  ELDER_AGE: 108000,
  MAX_AGE: 180000,

  // Reveal system
  REVEAL_RES: 8,
  REVEAL_DECAY: 0.0004,

  // Depth/Holes system
  HOLE_SPAWN_CHANCE: 0.0001,
  MIN_HOLE_DIST: 100,

  // Structures
  STRUCTURE_HOLE_BUFFER: 80,
  NEST_MONOLITH_DIST: 45,

  // Array caps
  MAX_FOODS: 200,
  MAX_PARTICLES: 500,
  MAX_EMOTES: 100,
  MAX_CREATURES: 80,
} as const;

const BLOB_SOUNDS = {
  onsets: [
    "b",
    "m",
    "p",
    "l",
    "w",
    "n",
    "f",
    "bl",
    "pl",
    "fl",
    "br",
    "pr",
    "fr",
    "bw",
    "mw",
    "mb",
  ],
  nuclei: [
    "o",
    "u",
    "a",
    "i",
    "e",
    "oo",
    "uu",
    "aa",
    "ou",
    "au",
    "oa",
    "ua",
    "io",
  ],
  codas: ["", "", "", "", "b", "m", "p", "n", "l", "f", "mp", "ff", "bb"],
  suffixes: [
    "by",
    "ly",
    "fy",
    "my",
    "ling",
    "let",
    "ble",
    "bun",
    "moo",
    "loo",
    "boo",
    "pop",
    "puff",
  ],
};

const EMOTE_STYLES: Record<string, { symbol: string; color: string }> = {
  heart: { symbol: "♥", color: "#ffaaaa" },
  zzz: { symbol: "z", color: "#aaccff" },
  sparkle: { symbol: "✦", color: "#ffffcc" },
  "!": { symbol: "!", color: "#ffcc88" },
  pet: { symbol: "♥", color: "#ffccdd" },
};

// Bayer 4x4 ordered dithering matrix (normalized 0-1)
const BAYER_4X4 = [
  0 / 16,
  8 / 16,
  2 / 16,
  10 / 16,
  12 / 16,
  4 / 16,
  14 / 16,
  6 / 16,
  3 / 16,
  11 / 16,
  1 / 16,
  9 / 16,
  15 / 16,
  7 / 16,
  13 / 16,
  5 / 16,
];

// Precomputed 8-direction unit vectors
const DIRS_8: Array<{ x: number; y: number }> = [];
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  DIRS_8.push({ x: Math.cos(angle), y: Math.sin(angle) });
}

// Precomputed cos/sin for body segment drawing
const BODY_COS: number[] = [];
const BODY_SIN: number[] = [];
const BODY_SEGMENTS = 48;
for (let i = 0; i <= BODY_SEGMENTS; i++) {
  const angle = (i / BODY_SEGMENTS) * Math.PI * 2;
  BODY_COS.push(Math.cos(angle));
  BODY_SIN.push(Math.sin(angle));
}

const PARTICLE_COLORS: Record<string, (h: number, a: number) => string> = {
  birth: (h, a) => `hsla(${h}, 40%, 80%, ${a})`,
  death: (h, a) => `rgba(130, 120, 140, ${a * 0.35})`,
  eat: (h, a) => `hsla(${h}, 45%, 70%, ${a})`,
  pet: (h, a) => `hsla(${h}, 50%, 85%, ${a})`,
  ripple: (h, a) => `rgba(180, 180, 200, ${a * 0.4})`,
  void: (h, a) => `hsla(${h}, 50%, 35%, ${a * 0.7})`,
};

// ============================================================================
// FOG WORKER - Offloads fog computation to a worker thread
// ============================================================================

class FogWorker {
  private worker: Worker | null = null;
  private bitmap: ImageBitmap | null = null;
  private ready = false;
  private initialized = false;
  private pendingRender = false;
  private pendingRevealMapRequest = false;
  private pendingRevealMapSync: Float32Array | null = null;
  private _onRevealMapReceived: ((data: Float32Array) => void) | null = null;

  constructor() {
    // Only init if browser supports required APIs
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      return;
    }

    try {
      this.worker = new Worker(
        new URL("./fog-worker.ts", import.meta.url),
        { type: "module" }
      );

      this.worker.onmessage = (e: MessageEvent<FogWorkerOutMessage>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          this.ready = true;
          if (this.pendingRevealMapSync) {
            const pending = this.pendingRevealMapSync;
            this.pendingRevealMapSync = null;
            this.postRevealMap(pending);
          }
        } else if (msg.type === "rendered") {
          this.pendingRender = false;
          if (msg.changed && msg.bitmap) {
            if (this.bitmap) this.bitmap.close();
            this.bitmap = msg.bitmap;
          }
        } else if (msg.type === "revealMap") {
          this.pendingRevealMapRequest = false;
          if (this._onRevealMapReceived) {
            this._onRevealMapReceived(msg.data);
          }
        }
      };

      this.worker.onerror = () => {
        this.ready = false;
        if (this.worker) {
          this.worker.onmessage = null;
          this.worker.onerror = null;
          this.worker.terminate();
          this.worker = null;
        }
      };
    } catch {
      this.worker = null;
    }
  }

  set onRevealMapReceived(callback: ((data: Float32Array) => void) | null) {
    this._onRevealMapReceived = callback;
  }

  get isActive(): boolean {
    return this.worker !== null && this.ready;
  }

  init(width: number, height: number, config: FogWorkerConfig): void {
    this.initialized = true;
    this.worker?.postMessage({ type: "init", width, height, config } satisfies FogWorkerInMessage);
  }

  resize(width: number, height: number): void {
    if (!this.initialized) return;
    this.worker?.postMessage({ type: "resize", width, height } satisfies FogWorkerInMessage);
  }

  updateEntities(creatures: readonly FogCreatureData[], monoliths: readonly FogMonolithData[]): void {
    this.worker?.postMessage({ type: "updateEntities", creatures, monoliths } satisfies FogWorkerInMessage);
  }

  addRevealPoints(points: readonly FogRevealPoint[]): void {
    if (points.length > 0) {
      this.worker?.postMessage({ type: "reveal", points } satisfies FogWorkerInMessage);
    }
  }

  decay(): void {
    this.worker?.postMessage({ type: "decay" } satisfies FogWorkerInMessage);
  }

  requestRender(): void {
    if (!this.pendingRender && this.worker) {
      this.pendingRender = true;
      this.worker.postMessage({ type: "render" } satisfies FogWorkerInMessage);
    }
  }

  get hasBitmap(): boolean {
    return this.bitmap !== null;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.bitmap) {
      ctx.drawImage(this.bitmap, 0, 0);
    }
  }

  private postRevealMap(data: Float32Array): void {
    const copy = new Float32Array(data);
    this.worker?.postMessage({ type: "setRevealMap", data: copy } satisfies FogWorkerInMessage, [copy.buffer]);
  }

  setRevealMap(data: Float32Array): void {
    if (!this.worker) return;

    if (this.ready) {
      this.postRevealMap(data);
      this.pendingRevealMapSync = null;
      return;
    }

    this.pendingRevealMapSync = new Float32Array(data);
  }

  requestRevealMap(): void {
    if (!this.pendingRevealMapRequest && this.worker) {
      this.pendingRevealMapRequest = true;
      this.worker.postMessage({ type: "getRevealMap" } satisfies FogWorkerInMessage);
    }
  }

  destroy(): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.initialized = false;
    this.pendingRender = false;
    this.pendingRevealMapSync = null;
    if (this.bitmap) {
      this.bitmap.close();
      this.bitmap = null;
    }
  }
}

// ============================================================================
// MAIN GAME FUNCTION
// ============================================================================

let activeVoidGameCleanup: (() => void) | null = null;

export function initVoidGame(options: GameInitOptions): () => void {
  if (activeVoidGameCleanup) {
    activeVoidGameCleanup();
  }

  const { canvas, lostPath, titleSub, title, toast, tooltip, pickupRing, homeBtn, resetBtn } =
    options;

  const ctx = canvas.getContext("2d")!;
  if (!ctx) throw new Error("Canvas not supported");

  // Core State
  let W = window.innerWidth;
  let H = window.innerHeight;
  let time = 0;
  const lostPathStr = window.location.pathname.replace(/^\//, "") || "nowhere";
  const pathSeed = lostPathStr
    .split("")
    .reduce((acc, char, i) => acc + char.charCodeAt(0) * (i + 1), 0);

  // Global seeded random
  let _worldSeed = pathSeed;
  function worldRandom(): number {
    _worldSeed = (_worldSeed * 1103515245 + 12345) & 0x7fffffff;
    return (_worldSeed % 10000) / 10000;
  }
  function initWorldRandom(seed: number): void {
    _worldSeed = seed;
  }

  // Entities
  let creatures: Creature[] = [];
  let foods: Food[] = [];
  let particles: Particle[] = [];
  let emotes: Emote[] = [];

  // Input
  const mouse: MouseState = {
    x: -100,
    y: -100,
    down: false,
    rightDown: false,
    holdTime: 0,
    rightHoldTime: 0,
    tappedHole: null,
  };

  // Interaction
  let heldCreature: Creature | null = null;
  let tooltipCreature: Creature | null = null;
  let rightClickTarget: Creature | null = null;
  let touchCreature: Creature | null = null;
  let pickupProgress = 0;

  // World State
  let revealMap: Float32Array | null = null;
  let lastRevealTime: Float32Array | null = null; // For linger mechanism in fallback mode
  let revealW: number;
  let revealH: number;
  const revealRes = CONFIG.REVEAL_RES;
  const LINGER_DURATION = 180; // Frames to keep fog revealed after creature leaves (~3s at 60fps)
  const PICKUP_HOLD_TIME = CONFIG.PICKUP_HOLD_TIME;
  let respawnPending = false;
  let fadingToBlack = false;

  // Fog Rendering - uses worker thread when available
  const fogWorker = new FogWorker();
  let fogCanvas: HTMLCanvasElement | null = null;
  let fogCtx: CanvasRenderingContext2D | null = null;
  let fogImageData: ImageData | null = null;
  let workerFogDirty = true;
  let fogWorkerInitialized = false;

  // AbortController for clean event listener removal
  const eventAbortController = new AbortController();
  let fogDirty = true;
  let destroyed = false;

  // Async task tracking
  const pendingTimeouts = new Set<number>();
  let pendingIdleSave: number | null = null;

  function scheduleTimeout(callback: () => void, delay: number): number {
    const id = window.setTimeout(() => {
      pendingTimeouts.delete(id);
      if (destroyed) return;
      callback();
    }, delay);
    pendingTimeouts.add(id);
    return id;
  }

  function clearPendingAsyncTasks(): void {
    for (const timeoutId of pendingTimeouts) {
      window.clearTimeout(timeoutId);
    }
    pendingTimeouts.clear();

    if (pendingIdleSave !== null && typeof cancelIdleCallback !== "undefined") {
      cancelIdleCallback(pendingIdleSave);
    }
    pendingIdleSave = null;
  }

  // Cache static UI references used each frame
  const tooltipNameEl = tooltip.querySelector(".name") as HTMLElement | null;
  const tooltipDetailsEl = tooltip.querySelector(".details") as HTMLElement | null;
  const tooltipStatsEl = tooltip.querySelector(".stats") as HTMLElement | null;
  const tooltipPersonalityEl = tooltip.querySelector(".personality") as HTMLElement | null;
  const pickupRingCtx = pickupRing.getContext("2d");

  // Pre-allocated collections
  const _protectedCells = new Set<number>();
  const _newCreatures: Creature[] = [];

  // Depth/Dungeon System
  function parseDepthFromPath(): number {
    const path = window.location.pathname;
    const depthMatch = path.match(/\/depth\/(\d+)/);
    if (depthMatch) return parseInt(depthMatch[1], 10);
    return 0;
  }

  function getBasePath(): string {
    const path = window.location.pathname;
    const cleaned = path.replace(/\/depth\/.*$/, "");
    return cleaned || "/404";
  }

  let currentDepth = parseDepthFromPath();
  let holes: Hole[] = [];
  let fissures: Fissure[] = [];
  let monoliths: Monolith[] = [];
  let nests: Nest[] = [];
  let terrainSeed = 0;
  let terrainFeatures: TerrainFeature[] = [];

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  function generateName(parentName: string | null = null): string {
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const syl = () =>
      pick(BLOB_SOUNDS.onsets) + pick(BLOB_SOUNDS.nuclei) + pick(BLOB_SOUNDS.codas);

    let name: string;
    const r = Math.random();

    if (r < 0.12) {
      const s = pick(BLOB_SOUNDS.onsets) + pick(BLOB_SOUNDS.nuclei);
      name = s + s;
    } else if (r < 0.55) {
      name = syl() + pick(BLOB_SOUNDS.onsets) + pick(BLOB_SOUNDS.nuclei);
    } else {
      name = syl() + pick(BLOB_SOUNDS.suffixes);
    }

    if (parentName && Math.random() < 0.3) {
      const p2 = parentName.slice(0, 2).toLowerCase();
      const p1 = parentName[0].toLowerCase();
      const inherit = BLOB_SOUNDS.onsets.includes(p2)
        ? p2
        : BLOB_SOUNDS.onsets.includes(p1)
          ? p1
          : null;
      if (inherit) {
        const cur =
          BLOB_SOUNDS.onsets.find((o) => name.toLowerCase().startsWith(o)) || name[0];
        name = inherit + name.slice(cur.length);
      }
    }

    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function getPersonalityDescription(p: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    stability: number;
  }): string {
    const traits: string[] = [];

    if (p.openness > 0.7) traits.push("curious");
    else if (p.openness < 0.4) traits.push("cautious");

    if (p.conscientiousness > 0.7) traits.push("diligent");
    else if (p.conscientiousness < 0.4) traits.push("carefree");

    if (p.extraversion > 0.7) traits.push("social");
    else if (p.extraversion < 0.4) traits.push("shy");

    if (p.agreeableness > 0.7) traits.push("friendly");
    else if (p.agreeableness < 0.4) traits.push("independent");

    if (p.stability > 0.7) traits.push("calm");
    else if (p.stability < 0.4) traits.push("sensitive");

    return traits.length ? traits.join(", ") : "balanced";
  }

  function formatAge(ticks: number): string {
    const minutes = Math.floor(ticks / 3600);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d old`;
    if (hours > 0) return `${hours}h old`;
    if (minutes > 0) return `${minutes}m old`;
    return "newborn";
  }

  function mutate(value: number, variance: number): number {
    return Math.max(0.2, Math.min(1.2, value + (Math.random() - 0.5) * variance * 2));
  }

  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    h = (((h % 360) + 360) % 360) / 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;

    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }

    const hue2rgb = (p: number, q: number, t: number): number => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  function distSq(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return dx * dx + dy * dy;
  }

  function dist(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pointToSegmentDist(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): number {
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function getLightAt(x: number, y: number): number {
    if (!revealMap) return 0;
    const gx = Math.floor(x / revealRes);
    const gy = Math.floor(y / revealRes);
    if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) return 0;
    return revealMap[gy * revealW + gx];
  }

  // ============================================================================
  // EMOTE CLASS
  // ============================================================================

  class Emote {
    x: number;
    y: number;
    startY: number;
    type: string;
    life: number;
    age: number;
    vx: number;

    constructor(x: number, y: number, type: string) {
      this.x = x;
      this.y = y;
      this.startY = y;
      this.type = type;
      this.life = 1;
      this.age = 0;
      this.vx = (Math.random() - 0.5) * 0.5;
    }

    update(): boolean {
      this.age++;
      this.x += this.vx;
      this.y = this.startY - this.age * 0.4;
      this.life = Math.max(0, 1 - this.age / 50);
      return this.life > 0;
    }

    draw(): void {
      ctx.save();
      ctx.globalAlpha = this.life;
      ctx.font = `${11 + this.age * 0.08}px sans-serif`;
      ctx.textAlign = "center";
      const style = EMOTE_STYLES[this.type] || { symbol: "·", color: "#ffffff" };
      ctx.fillStyle = style.color;
      ctx.fillText(style.symbol, this.x, this.y);
      ctx.restore();
    }
  }

  // ============================================================================
  // PARTICLE CLASS
  // ============================================================================

  class Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    age: number;
    type: ParticleType;
    hue: number;
    size: number;
    easeInDuration: number;

    constructor(
      x: number,
      y: number,
      type: ParticleType,
      hue = 0,
      vxOverride: number | null = null,
      vyOverride: number | null = null
    ) {
      this.x = x;
      this.y = y;
      this.vx = vxOverride !== null ? vxOverride : (Math.random() - 0.5) * 2;
      this.vy = vyOverride !== null ? vyOverride : (Math.random() - 0.5) * 2;
      this.life = 1;
      this.age = 0;
      this.type = type;
      this.hue = hue;
      this.size = 1.2 + Math.random() * 1.2;
      this.easeInDuration = 8 + Math.random() * 4;

      if (type === "birth") {
        this.vy = -1.2 - Math.random() * 0.5;
        this.vx *= 0.4;
      } else if (type === "death") {
        this.vy = Math.random() * 0.3;
        this.size *= 0.7;
      } else if (type === "pet") {
        this.vy = -0.8 - Math.random() * 0.8;
        this.vx = (Math.random() - 0.5) * 1.5;
      } else if (type === "ripple") {
        this.size = 2;
        this.easeInDuration = 12;
      } else if (type === "void") {
        this.size *= 0.8;
        this.life = 0.7 + Math.random() * 0.3;
      }
    }

    update(): boolean {
      this.age++;
      this.x += this.vx;
      this.y += this.vy;
      this.vx *= 0.95;
      this.vy *= 0.95;
      if (this.type === "death") this.vy += 0.012;
      if (this.type === "birth" || this.type === "pet") this.vy += 0.015;
      if (this.type === "ripple") {
        this.vx *= 0.92;
        this.vy *= 0.92;
      }
      this.life -= 0.022;
      return this.life > 0;
    }

    draw(): void {
      const easeIn =
        this.age >= this.easeInDuration
          ? 1
          : 1 - Math.pow(1 - this.age / this.easeInDuration, 3);

      const s = this.size * this.life * easeIn;
      const alpha = this.life * easeIn;
      const colorFn =
        PARTICLE_COLORS[this.type] || ((h: number, a: number) => `rgba(255, 255, 255, ${a * 0.3})`);
      const col = colorFn(this.hue, alpha);
      ctx.beginPath();
      ctx.arc(this.x, this.y, Math.max(0.1, s), 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
  }

  // ============================================================================
  // SPAWNABLE UTILS
  // ============================================================================

  const SpawnableUtils = {
    getRevealAt(x: number, y: number): number {
      if (!revealMap) return 0;
      const gx = Math.floor(x / revealRes);
      const gy = Math.floor(y / revealRes);
      if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) return 0;
      return revealMap[gy * revealW + gx];
    },

    easeIn(age: number, duration = 60): number {
      if (age >= duration) return 1;
      return 1 - Math.pow(1 - age / duration, 3);
    },

    findSpawnPosition(config: SpawnPositionConfig): { x: number; y: number } | null {
      const {
        margin = 50,
        maxAttempts = 30,
        avoidPoints = [],
        avoidCreatures = true,
        creatureBuffer = 60,
        seeded = false,
      } = config;

      const rng = seeded ? worldRandom : Math.random;
      let attempts = maxAttempts;
      while (attempts-- > 0) {
        const x = margin + rng() * (W - margin * 2);
        const y = margin + rng() * (H - margin * 2);

        let valid = true;

        for (const point of avoidPoints) {
          if (Math.hypot(x - point.x, y - point.y) < point.radius) {
            valid = false;
            break;
          }
        }

        if (valid && avoidCreatures) {
          for (const c of creatures) {
            if (Math.hypot(x - c.x, y - c.y) < creatureBuffer) {
              valid = false;
              break;
            }
          }
        }

        if (valid) return { x, y };
      }
      return null;
    },
  };

  // ============================================================================
  // FOOD CLASS
  // ============================================================================

  class Food {
    x: number;
    y: number;
    vy: number;
    size: number;
    sizeMultiplier: number;
    life: number;
    pulse: number;
    landed: boolean;
    groundY: number;
    claimedBy: Creature | null;
    type: FoodType;
    hue: number;
    sat: number;

    constructor(x: number, y: number) {
      this.x = x + (Math.random() - 0.5) * 20;
      this.y = y + (Math.random() - 0.5) * 20;
      this.vy = -0.5 - Math.random() * 0.5;
      const sizeRoll = Math.random();
      this.size =
        sizeRoll < 0.2
          ? 1.5 + Math.random()
          : sizeRoll < 0.85
            ? 2.5 + Math.random()
            : 3.5 + Math.random();
      this.sizeMultiplier = this.size / 3;
      this.life = 1;
      this.pulse = Math.random() * Math.PI * 2;
      this.landed = false;
      this.groundY = y + 5 + Math.random() * 15;
      this.claimedBy = null;

      const roll = Math.random();
      const inDarkness = getLightAt(this.x, this.y) < 0.3;

      if (inDarkness && roll < 0.12) {
        this.type = "purple";
        this.hue = 280 + Math.random() * 20;
        this.sat = 60;
      } else if (roll < 0.03) {
        this.type = "cyan";
        this.hue = 175 + Math.random() * 15;
        this.sat = 55;
      } else if (roll < 0.18) {
        this.type = "green";
        this.hue = 115 + Math.random() * 25;
        this.sat = 50;
      } else {
        this.type = "white";
        this.hue = 60 + Math.random() * 30;
        this.sat = 8;
      }
    }

    update(): boolean {
      this.pulse += 0.04;

      if (!this.landed) {
        this.vy += 0.06;
        this.y += this.vy;
        if (this.y >= this.groundY) {
          this.y = this.groundY;
          this.landed = true;
        }
      }

      this.life -= 0.0003;

      for (const c of creatures) {
        if (c === heldCreature || c.isDead) continue;

        const dx = c.x - this.x;
        const dy = c.y - this.y;
        if (dx > 30 || dx < -30 || dy > 30 || dy < -30) continue;

        const d = Math.hypot(dx, dy);
        if (d < c.displaySize + this.size + 2) {
          const hunger = 1 - c._energyNorm;

          const typeMultiplier =
            this.type === "white"
              ? 0.8
              : this.type === "green"
                ? 1.0
                : this.type === "cyan"
                  ? 1.4
                  : this.type === "purple"
                    ? 1.4
                    : 1.0;
          const baseFill = (18 + hunger * 10) * this.sizeMultiplier * typeMultiplier;
          const happinessBoost = (3 + hunger * 7) * this.sizeMultiplier;

          c.energy = Math.min(100, c.energy + baseFill);
          c.happiness = Math.min(100, c.happiness + happinessBoost);

          if (this.type === "green") {
            c.stress = Math.max(0, c.stress - 0.15);
            c.fear = Math.max(0, c.fear - 0.12);
            c.comforted = Math.min(1, c.comforted + 0.2);
          } else if (this.type === "cyan") {
            const waveRadius = 120;
            // Use worker for reveal if active
            if (fogWorker.isActive) {
              fogWorker.addRevealPoints([{ x: this.x, y: this.y, radius: waveRadius, intensity: 0.8 }]);
            } else if (revealMap) {
              // Fallback: direct reveal map manipulation
              const cx = Math.floor(this.x / revealRes);
              const cy = Math.floor(this.y / revealRes);
              const gridRadius = Math.ceil(waveRadius / revealRes);
              const maxDistSq = gridRadius * gridRadius;
              const invMaxDistSq = 1 / maxDistSq;
              for (let dy = -gridRadius; dy <= gridRadius; dy++) {
                for (let dx = -gridRadius; dx <= gridRadius; dx++) {
                  const gx = cx + dx;
                  const gy = cy + dy;
                  if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) continue;
                  const distSq = dx * dx + dy * dy;
                  if (distSq <= maxDistSq) {
                    const falloff = 1 - Math.sqrt(distSq * invMaxDistSq);
                    const idx = gy * revealW + gx;
                    revealMap[idx] = Math.min(1, revealMap[idx] + falloff * 0.8);
                  }
                }
              }
              fogDirty = true;
            }
            for (let i = 0; i < 8 && particles.length < CONFIG.MAX_PARTICLES; i++) {
              const angle = (i / 8) * Math.PI * 2;
              particles.push(
                new Particle(
                  this.x + Math.cos(angle) * 15,
                  this.y + Math.sin(angle) * 15,
                  "eat",
                  this.hue
                )
              );
            }
          } else if (this.type === "purple") {
            c._voidChorusTimer = 300;
            c._voidChorusStrength = 0.8;
            if (emotes.length < CONFIG.MAX_EMOTES) {
              emotes.push(new Emote(c.x, c.y - c.displaySize, "heart"));
            }
          }
          c.expression = "eating";
          c.expressionTimer = 20 + Math.floor(hunger * 15);
          c.targetSquash = 1.1 + hunger * 0.08;

          c.fear = Math.max(0, c.fear - 0.05 * (1 + hunger));

          const trustGain = 0.006 + hunger * 0.008;
          c.trust = Math.min(1, c.trust + trustGain);

          c.stress = Math.max(0, c.stress - 0.02 * (0.5 + hunger));
          c.fatigue = Math.max(0, c.fatigue - 0.01 * hunger);

          c.memories.fedCount++;
          c.memories.lastFedTime = c.age;
          c.addMemory("good", this.x, this.y, 0.2 + hunger * 0.3);

          if (hunger > 0.3) {
            c.attachment = Math.min(1, c.attachment + 0.003 * hunger);
          }

          if (c.anticipation > 0.2) {
            c.happiness = Math.min(100, c.happiness + c.anticipation * 3);
            c.anticipation = 0;
          }

          for (const other of creatures) {
            if (other.id === c.id) continue;
            const odx = other.x - c.x;
            const ody = other.y - c.y;
            if (odx > 60 || odx < -60 || ody > 60 || ody < -60) continue;

            const otherDist = Math.hypot(odx, ody);
            if (otherDist < 40 && other.expression === "eating") {
              c.updateBond(other.id, "meal");
              other.updateBond(c.id, "meal");
            }
            if (otherDist < 60 && hunger > 0.3 && c.socialMemory) {
              c.recordSocialPositive(other.id);
            }
          }

          const particleCount = 1 + Math.floor(hunger * 2);
          for (let i = 0; i < particleCount && particles.length < CONFIG.MAX_PARTICLES; i++) {
            particles.push(new Particle(this.x, this.y, "eat", this.hue));
          }
          if (Math.random() < 0.15 + hunger * 0.25 && emotes.length < CONFIG.MAX_EMOTES) {
            emotes.push(new Emote(c.x, c.y - c.displaySize, "sparkle"));
          }
          this.life = 0;
          if (this.claimedBy) {
            if (this.claimedBy._claimedFood === this) this.claimedBy._claimedFood = null;
            this.claimedBy = null;
          }
          return false;
        }
      }

      if (this.life <= 0 && this.claimedBy) {
        if (this.claimedBy._claimedFood === this) this.claimedBy._claimedFood = null;
        this.claimedBy = null;
      }

      return this.life > 0;
    }

    draw(): void {
      const s = this.size * (0.9 + Math.sin(this.pulse) * 0.1) * Math.min(1, this.life * 2.5);

      const glowSat = Math.min(100, this.sat + 30);
      const [r, g, b] = hslToRgb(this.hue, glowSat, 60);
      const glowAlpha = this.life * 0.35;
      const glowRadius = s * 4;

      const glow = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, glowRadius);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha * 1.2})`);
      glow.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${glowAlpha * 0.5})`);
      glow.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${glowAlpha * 0.15})`);
      glow.addColorStop(1, "transparent");
      ctx.beginPath();
      ctx.arc(this.x, this.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(this.x, this.y, s, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${this.hue}, ${this.sat}%, 75%, ${this.life})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(this.x, this.y, s * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${this.hue}, ${Math.max(0, this.sat - 10)}%, 90%, ${this.life * 0.8})`;
      ctx.fill();
    }
  }

  // ============================================================================
  // HOLE CLASS
  // ============================================================================

  class Hole {
    static TYPE = "hole";
    static EASE_IN_DURATION = 60;

    x: number;
    y: number;
    radius: number;
    pulsePhase: number;
    age: number;
    hoverProgress: number;
    sparkles: Sparkle[];

    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
      this.radius = 18 + Math.random() * 8;
      this.pulsePhase = Math.random() * Math.PI * 2;
      this.age = 0;
      this.hoverProgress = 0;
      this.sparkles = [];
      this.initSparkles();
    }

    initSparkles(): void {
      this.sparkles = [];
      for (let i = 0; i < 5; i++) {
        this.sparkles.push({
          angle: Math.random() * Math.PI * 2,
          dist: this.radius * 0.8 + Math.random() * this.radius * 0.6,
          phase: Math.random() * Math.PI * 2,
          speed: 0.01 + Math.random() * 0.02,
        });
      }
    }

    getEaseIn(): number {
      return SpawnableUtils.easeIn(this.age, Hole.EASE_IN_DURATION);
    }

    getRevealLevel(): number {
      return SpawnableUtils.getRevealAt(this.x, this.y);
    }

    update(): boolean {
      this.age++;
      this.pulsePhase += 0.02;
      this.updateSparkles();
      this.updateHover();
      this.updateCreatureInteractions();
      return true;
    }

    updateSparkles(): void {
      for (const s of this.sparkles) {
        s.phase += s.speed;
        s.angle += 0.003;
      }
    }

    updateHover(): void {
      const d = Math.hypot(mouse.x - this.x, mouse.y - this.y);
      if (d < this.radius + 10) {
        this.hoverProgress = Math.min(1, this.hoverProgress + 0.05);
      } else {
        this.hoverProgress = Math.max(0, this.hoverProgress - 0.03);
      }
    }

    updateCreatureInteractions(): void {
      for (const c of creatures) {
        const cdist = Math.hypot(c.x - this.x, c.y - this.y);

        if (cdist < this.radius * 0.85 && c !== heldCreature) {
          this.onCreatureFallIn(c);
          continue;
        }

        this.applyMesmerization(c, cdist);
      }
    }

    onCreatureFallIn(creature: Creature): void {
      creature.die("fell into the void");
      for (let i = 0; i < 15 && particles.length < CONFIG.MAX_PARTICLES; i++) {
        const angle = Math.random() * Math.PI * 2;
        const d = 5 + Math.random() * 15;
        const px = creature.x + Math.cos(angle) * d;
        const py = creature.y + Math.sin(angle) * d;
        const vx = (this.x - creature.x) * 0.03 + Math.cos(angle) * 0.5;
        const vy = (this.y - creature.y) * 0.03 + Math.sin(angle) * 0.5;
        particles.push(new Particle(px, py, "void", creature.hue, vx, vy));
      }
    }

    applyMesmerization(creature: Creature, d: number): void {
      const mesmerizeRange = this.radius + 70;
      if (d < mesmerizeRange && d > this.radius + 20 && !creature.gazeTarget) {
        const voidCall =
          creature.openness * 0.4 + (1 - creature.stability) * creature.stress * 0.4;
        const resistance = creature.fear * 0.5 * creature.stability;
        const gazeChance = (1 - d / mesmerizeRange) * 0.1 * Math.max(0, voidCall - resistance);
        if (Math.random() < gazeChance) {
          creature.gazeTarget = { x: this.x, y: this.y };
          const baseDuration = 15 + creature.openness * 25;
          const instability = 1 + (1 - creature.stability) * 0.8;
          creature.gazeTimer = baseDuration * instability * (0.8 + Math.random() * 0.4);
        }
      }
    }

    drawThroughFog(): void {
      const easeIn = this.getEaseIn();
      if (easeIn < 0.01) return;

      for (const s of this.sparkles) {
        const sparkleX = this.x + Math.cos(s.angle) * s.dist;
        const sparkleY = this.y + Math.sin(s.angle) * s.dist;
        const brightness = (Math.sin(s.phase) + 1) * 0.5;
        const alpha = (0.06 + brightness * 0.1) * easeIn;
        const size = (0.8 + brightness * 1.2) * easeIn;

        ctx.beginPath();
        ctx.arc(sparkleX, sparkleY, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100, 85, 130, ${alpha})`;
        ctx.fill();
      }
    }

    draw(): void {
      const revealLevel = this.getRevealLevel();
      if (revealLevel < 0.15) return;

      const easeIn = this.getEaseIn();
      const pulse = 1 + Math.sin(this.pulsePhase) * 0.08;
      const r = this.radius * pulse * (0.5 + easeIn * 0.5);
      const visAlpha = Math.min(1, revealLevel * 1.5) * easeIn;

      const glowR = r * 2.5;
      const glow = ctx.createRadialGradient(this.x, this.y, r * 0.5, this.x, this.y, glowR);
      glow.addColorStop(0, `rgba(20, 10, 40, ${0.6 * visAlpha})`);
      glow.addColorStop(0.5, `rgba(40, 20, 60, ${0.2 * visAlpha})`);
      glow.addColorStop(1, "transparent");
      ctx.beginPath();
      ctx.arc(this.x, this.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      const holeGrad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
      holeGrad.addColorStop(0, `rgba(0, 0, 0, ${visAlpha})`);
      holeGrad.addColorStop(0.7, `rgba(10, 5, 20, ${0.95 * visAlpha})`);
      holeGrad.addColorStop(1, `rgba(30, 15, 50, ${0.7 * visAlpha})`);
      ctx.beginPath();
      ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
      ctx.fillStyle = holeGrad;
      ctx.fill();

      ctx.strokeStyle = `rgba(80, 50, 120, ${(0.3 + this.hoverProgress * 0.4) * visAlpha})`;
      ctx.lineWidth = 2 + this.hoverProgress * 2;
      ctx.beginPath();
      ctx.arc(this.x, this.y, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    contains(x: number, y: number): boolean {
      if (this.getRevealLevel() < 0.15) return false;
      return Math.hypot(x - this.x, y - this.y) < this.radius + 5;
    }
  }

  // ============================================================================
  // FISSURE CLASS
  // ============================================================================

  class Fissure {
    segments: FissureSegment[];
    branches: Fissure[];
    direction: number;
    maxLength: number;
    baseWidth: number;
    jaggedness: number;
    bounds: FissureBounds;

    constructor(
      startX: number,
      startY: number,
      direction: number,
      maxLength: number,
      width: number,
      jaggedness: number | null = null
    ) {
      this.segments = [{ x: startX, y: startY }];
      this.branches = [];
      this.direction = direction;
      this.maxLength = maxLength;
      this.baseWidth = width;
      this.jaggedness = jaggedness ?? 0.3 + Math.random() * 0.5;
      this.bounds = {
        minX: startX,
        maxX: startX,
        minY: startY,
        maxY: startY,
      };

      this.generatePath();
      this.computeBounds();
    }

    generatePath(): void {
      const taperStart = 0.7;

      while (true) {
        const last = this.segments[this.segments.length - 1];
        const progress = (this.segments.length * 10) / this.maxLength;

        this.direction += (Math.random() - 0.5) * this.jaggedness;

        const stepSize = 6 + Math.random() * 8;
        const newX = last.x + Math.cos(this.direction) * stepSize;
        const newY = last.y + Math.sin(this.direction) * stepSize;

        if (newX < 0 || newX > W || newY < 0 || newY > H) {
          break;
        }

        let segmentWidth = this.baseWidth;
        if (progress > taperStart) {
          segmentWidth *= 1 - ((progress - taperStart) / (1 - taperStart)) * 0.6;
        }
        if (this.segments.length < 3) {
          segmentWidth *= 0.5 + this.segments.length * 0.2;
        }

        this.segments.push({ x: newX, y: newY, width: segmentWidth });

        const branchChance = progress > 0.2 && progress < 0.8 ? 0.06 : 0.02;
        if (Math.random() < branchChance && this.branches.length < 3) {
          const branchDir =
            this.direction + (Math.random() > 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.6);
          const branch = new Fissure(
            newX,
            newY,
            branchDir,
            this.maxLength * (0.25 + Math.random() * 0.2),
            this.baseWidth * 0.6,
            this.jaggedness * (0.8 + Math.random() * 0.4)
          );
          this.branches.push(branch);
        }

        if (progress >= 1) {
          break;
        }
      }
    }

    computeBounds(): void {
      for (const seg of this.segments) {
        this.bounds.minX = Math.min(this.bounds.minX, seg.x);
        this.bounds.maxX = Math.max(this.bounds.maxX, seg.x);
        this.bounds.minY = Math.min(this.bounds.minY, seg.y);
        this.bounds.maxY = Math.max(this.bounds.maxY, seg.y);
      }
      for (const branch of this.branches) {
        this.bounds.minX = Math.min(this.bounds.minX, branch.bounds.minX);
        this.bounds.maxX = Math.max(this.bounds.maxX, branch.bounds.maxX);
        this.bounds.minY = Math.min(this.bounds.minY, branch.bounds.minY);
        this.bounds.maxY = Math.max(this.bounds.maxY, branch.bounds.maxY);
      }
      const pad = this.baseWidth + 5;
      this.bounds.minX -= pad;
      this.bounds.maxX += pad;
      this.bounds.minY -= pad;
      this.bounds.maxY += pad;
    }

    isNearBounds(x: number, y: number, margin = 0): boolean {
      return (
        x >= this.bounds.minX - margin &&
        x <= this.bounds.maxX + margin &&
        y >= this.bounds.minY - margin &&
        y <= this.bounds.maxY + margin
      );
    }

    draw(): void {
      if (this.segments.length < 2) return;

      let maxReveal = 0;
      for (const seg of this.segments) {
        const r = getLightAt(seg.x, seg.y);
        if (r > maxReveal) maxReveal = r;
        if (maxReveal > 0.3) break;
      }
      if (maxReveal < 0.05) return;

      const alpha = Math.min(1, maxReveal * 1.2);

      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 * alpha})`;
      ctx.lineWidth = this.baseWidth + 3;
      ctx.beginPath();
      ctx.moveTo(this.segments[0].x + 1, this.segments[0].y + 1);
      for (let i = 1; i < this.segments.length; i++) {
        ctx.lineTo(this.segments[i].x + 1, this.segments[i].y + 1);
      }
      ctx.stroke();

      ctx.strokeStyle = `rgba(2, 2, 5, ${0.9 * alpha})`;
      ctx.lineWidth = this.baseWidth;
      ctx.beginPath();
      ctx.moveTo(this.segments[0].x, this.segments[0].y);
      for (let i = 1; i < this.segments.length; i++) {
        ctx.lineTo(this.segments[i].x, this.segments[i].y);
      }
      ctx.stroke();

      if (this.baseWidth > 1.5) {
        ctx.strokeStyle = `rgba(15, 10, 20, ${0.5 * alpha})`;
        ctx.lineWidth = Math.max(0.5, this.baseWidth * 0.4);
        ctx.beginPath();
        ctx.moveTo(this.segments[0].x, this.segments[0].y);
        for (let i = 1; i < this.segments.length; i++) {
          ctx.lineTo(this.segments[i].x, this.segments[i].y);
        }
        ctx.stroke();
      }

      for (const branch of this.branches) {
        branch.draw();
      }
    }

    getDistanceTo(x: number, y: number): number {
      if (!this.isNearBounds(x, y, 50)) return Infinity;

      let minDist = Infinity;
      for (let i = 1; i < this.segments.length; i++) {
        const a = this.segments[i - 1];
        const b = this.segments[i];
        const d = pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
        if (d < minDist) minDist = d;
      }
      for (const branch of this.branches) {
        const d = branch.getDistanceTo(x, y);
        if (d < minDist) minDist = d;
      }
      return minDist;
    }

    checkCollision(x: number, y: number): boolean {
      if (!this.isNearBounds(x, y)) return false;

      const hitWidth = this.baseWidth + 2;
      for (let i = 1; i < this.segments.length; i++) {
        const a = this.segments[i - 1];
        const b = this.segments[i];
        const d = pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
        if (d < hitWidth) return true;
      }
      for (const branch of this.branches) {
        if (branch.checkCollision(x, y)) return true;
      }
      return false;
    }

    update(): void {
      for (const c of creatures) {
        if (c === heldCreature) continue;

        if (!this.isNearBounds(c.x, c.y, 40)) continue;

        const d = this.getDistanceTo(c.x, c.y);

        if (d < this.baseWidth + 2) {
          c.die("fell into a fissure");
          for (let i = 0; i < 10 && particles.length < CONFIG.MAX_PARTICLES; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.2 + Math.random() * 0.4;
            particles.push(
              new Particle(c.x, c.y, "void", c.hue, Math.cos(angle) * speed, Math.sin(angle) * speed)
            );
          }
          continue;
        }

        const fearRange = 30;
        if (d < fearRange) {
          const proximity = 1 - d / fearRange;
          c.fear = Math.min(1, c.fear + proximity * 0.004 * (1 - c.stability * 0.5));
        }
      }
    }

    getAvoidanceForce(
      x: number,
      y: number,
      creatureFear: number,
      creatureStability: number
    ): { fx: number; fy: number } | null {
      if (!this.isNearBounds(x, y, 60)) return null;

      const d = this.getDistanceTo(x, y);
      const avoidRange = 40 + creatureFear * 20;

      if (d < avoidRange && d > 0) {
        let closestSeg: { ax: number; ay: number; bx: number; by: number } | null = null;
        let closestDist = Infinity;
        for (let i = 1; i < this.segments.length; i++) {
          const a = this.segments[i - 1];
          const b = this.segments[i];
          const segDist = pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
          if (segDist < closestDist) {
            closestDist = segDist;
            closestSeg = { ax: a.x, ay: a.y, bx: b.x, by: b.y };
          }
        }

        if (closestSeg) {
          const mx = (closestSeg.ax + closestSeg.bx) / 2;
          const my = (closestSeg.ay + closestSeg.by) / 2;
          const awayAngle = Math.atan2(y - my, x - mx);
          const strength =
            (1 - d / avoidRange) * 0.012 * (1 + creatureFear * 0.5) * (1 - creatureStability * 0.3);
          return {
            fx: Math.cos(awayAngle) * strength,
            fy: Math.sin(awayAngle) * strength,
          };
        }
      }

      for (const branch of this.branches) {
        const force = branch.getAvoidanceForce(x, y, creatureFear, creatureStability);
        if (force) return force;
      }

      return null;
    }
  }

  // ============================================================================
  // MONOLITH CLASS
  // ============================================================================

  class Monolith {
    static TYPE = "monolith";
    static EASE_IN_DURATION = 90;

    x: number;
    y: number;
    width: number;
    height: number;
    age: number;
    runes: Rune[];
    presence: number;

    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
      this.width = 7 + Math.random() * 3;
      this.height = 26 + Math.random() * 8;
      this.age = 0;

      this.runes = [];
      const runeCount = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < runeCount; i++) {
        this.runes.push({
          y: 0.2 + (i / runeCount) * 0.55 + Math.random() * 0.08,
          width: 0.3 + Math.random() * 0.2,
          phase: Math.random() * Math.PI * 2,
          speed: 0.01 + Math.random() * 0.006,
        });
      }

      this.presence = 0;
    }

    getEaseIn(): number {
      return SpawnableUtils.easeIn(this.age, Monolith.EASE_IN_DURATION);
    }

    getRevealLevel(): number {
      return SpawnableUtils.getRevealAt(this.x, this.y);
    }

    update(): boolean {
      this.age++;

      for (const rune of this.runes) {
        rune.phase += rune.speed;
      }

      let targetPresence = 0;
      const innerRange = 40;
      const outerRange = 90;
      for (const c of creatures) {
        const d = Math.hypot(c.x - this.x, c.y - this.y);
        if (d < outerRange) {
          const contribution = d < innerRange ? 1 : 1 - (d - innerRange) / (outerRange - innerRange);
          targetPresence += contribution * 0.4;
        }
      }
      targetPresence = Math.min(1, targetPresence);
      const transitionRate = targetPresence > this.presence ? 0.08 : 0.03;
      this.presence += (targetPresence - this.presence) * transitionRate;

      // Worker handles monolith reveal in updateEntities
      if (!fogWorker.isActive && revealMap && this.presence > 0.05 && this.age > 20) {
        const cx = Math.floor(this.x / revealRes);
        const cy = Math.floor(this.y / revealRes);
        const effectiveRadius = 30 + this.presence * 70;
        const r = Math.ceil(effectiveRadius / revealRes);
        const radiusSq = effectiveRadius * effectiveRadius;
        const revealResSq = revealRes * revealRes;
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
              const intensity = falloff * (0.5 + this.presence * 0.5);
              revealMap[idx] = Math.max(revealMap[idx], intensity);
            }
          }
        }
        fogDirty = true;
      }

      for (const c of creatures) {
        const d = Math.hypot(c.x - this.x, c.y - this.y);
        if (d < 70 && d > 12 && !c.gazeTarget) {
          const mysticalDraw = c.openness * 0.5 + (1 - c.stability) * c.stress * 0.3;
          const fearAvoidance = c.fear * 0.3;
          const gazeChance = (1 - d / 70) * 0.03 * Math.max(0, mysticalDraw - fearAvoidance);
          if (Math.random() < gazeChance) {
            c.gazeTarget = { x: this.x, y: this.y - this.height * 0.5 };
            const baseDuration = 20 + c.openness * 40;
            const steadiness = 0.7 + c.stability * 0.6;
            c.gazeTimer = baseDuration * steadiness * (0.8 + Math.random() * 0.4);
          }
        }
      }

      return true;
    }

    drawThroughFog(): void {
      const easeIn = this.getEaseIn();
      if (easeIn < 0.1) return;

      const h = this.height * easeIn;
      const w = this.width;

      for (const rune of this.runes) {
        const runeY = this.y - h * rune.y;
        const runeW = w * rune.width;
        const pulse = (Math.sin(rune.phase) + 1) * 0.5;

        const baseAlpha = 0.08 + pulse * 0.08;
        const activeBonus = this.presence * 0.15;
        const alpha = (baseAlpha + activeBonus) * easeIn;

        ctx.strokeStyle = `rgba(140, 100, 180, ${alpha})`;
        ctx.lineWidth = 1.5 + pulse + this.presence * 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(this.x - runeW / 2, runeY);
        ctx.lineTo(this.x + runeW / 2, runeY);
        ctx.stroke();

        if (alpha > 0.1) {
          const glowSize = runeW * 0.8;
          ctx.beginPath();
          ctx.arc(this.x, runeY, glowSize, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(120, 80, 160, ${alpha * 0.3})`;
          ctx.fill();
        }
      }
    }

    draw(): void {
      const revealLevel = this.getRevealLevel();
      if (revealLevel < 0.15) return;

      const easeIn = this.getEaseIn();
      const visAlpha = Math.min(1, revealLevel * 1.5) * easeIn;
      const h = this.height * easeIn;
      const w = this.width;

      ctx.beginPath();
      ctx.ellipse(this.x, this.y + 2, w * 0.85, 3, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 0, 0, ${0.3 * visAlpha})`;
      ctx.fill();

      if (this.presence > 0.02) {
        const auraSize = w * (2.5 + this.presence * 2);
        const auraGrad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, auraSize);
        auraGrad.addColorStop(0, `rgba(80, 50, 120, ${0.15 * visAlpha * this.presence})`);
        auraGrad.addColorStop(0.5, `rgba(60, 30, 90, ${0.06 * visAlpha * this.presence})`);
        auraGrad.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(this.x, this.y, auraSize, 0, Math.PI * 2);
        ctx.fillStyle = auraGrad;
        ctx.fill();
      }

      const bodyGrad = ctx.createLinearGradient(this.x - w / 2, 0, this.x + w / 2, 0);
      bodyGrad.addColorStop(0, `rgba(25, 22, 30, ${visAlpha})`);
      bodyGrad.addColorStop(0.3, `rgba(35, 32, 42, ${visAlpha})`);
      bodyGrad.addColorStop(0.7, `rgba(30, 27, 35, ${visAlpha})`);
      bodyGrad.addColorStop(1, `rgba(20, 18, 25, ${visAlpha})`);

      ctx.beginPath();
      ctx.moveTo(this.x - w / 2, this.y);
      ctx.lineTo(this.x - w / 2 + 1, this.y - h);
      ctx.lineTo(this.x + w / 2 - 1, this.y - h);
      ctx.lineTo(this.x + w / 2, this.y);
      ctx.closePath();
      ctx.fillStyle = bodyGrad;
      ctx.fill();

      ctx.strokeStyle = `rgba(60, 55, 70, ${0.4 * visAlpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const rune of this.runes) {
        const runeY = this.y - h * rune.y;
        const runeW = w * rune.width;
        const pulse = (Math.sin(rune.phase) + 1) * 0.5;
        const dormantAlpha = 0.15;
        const activeAlpha = 0.3 + pulse * 0.7;
        const runeAlpha = (dormantAlpha + (activeAlpha - dormantAlpha) * this.presence) * visAlpha;

        if (this.presence > 0.05) {
          const glowSize = runeW * (1.5 + this.presence * 1.5);
          const glowGrad = ctx.createRadialGradient(this.x, runeY, 0, this.x, runeY, glowSize);
          glowGrad.addColorStop(0, `rgba(100, 70, 140, ${runeAlpha * 0.4 * this.presence})`);
          glowGrad.addColorStop(0.5, `rgba(80, 50, 120, ${runeAlpha * 0.15 * this.presence})`);
          glowGrad.addColorStop(1, "transparent");
          ctx.beginPath();
          ctx.arc(this.x, runeY, glowSize, 0, Math.PI * 2);
          ctx.fillStyle = glowGrad;
          ctx.fill();
        }

        ctx.strokeStyle = `rgba(140, 110, 180, ${runeAlpha})`;
        ctx.lineWidth = 1 + pulse * 0.6 * this.presence;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(this.x - runeW / 2, runeY);
        ctx.lineTo(this.x + runeW / 2, runeY);
        ctx.stroke();
      }
    }
  }

  // ============================================================================
  // NEST CLASS
  // ============================================================================

  class Nest {
    static TYPE = "nest";
    static EASE_IN_DURATION = 70;

    x: number;
    y: number;
    radius: number;
    age: number;
    debris: Debris[];
    occupants: Set<string>;
    occupancyGlow: number;
    warmthPulse: number;

    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
      this.radius = 18 + Math.random() * 6;
      this.age = 0;

      this.debris = [];
      const debrisCount = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < debrisCount; i++) {
        this.debris.push({
          angle: (i / debrisCount) * Math.PI * 2 + Math.random() * 0.5,
          dist: this.radius * (0.7 + Math.random() * 0.4),
          size: 1 + Math.random() * 1.5,
          hue: 25 + Math.random() * 20,
        });
      }

      this.occupants = new Set();
      this.occupancyGlow = 0;
      this.warmthPulse = Math.random() * Math.PI * 2;
    }

    getEaseIn(): number {
      return SpawnableUtils.easeIn(this.age, Nest.EASE_IN_DURATION);
    }

    getRevealLevel(): number {
      return SpawnableUtils.getRevealAt(this.x, this.y);
    }

    update(): boolean {
      this.age++;
      this.warmthPulse += 0.012;

      this.occupants.clear();

      for (const c of creatures) {
        const d = Math.hypot(c.x - this.x, c.y - this.y);

        if (d < this.radius) {
          this.occupants.add(c.id);

          const isStill = c._cachedSpeed < 0.3;
          const tiredEnough = c.fatigue > 0.4 || c.restedness < 0.3 || c.energy < 30;
          if (tiredEnough && isStill && heldCreature !== c && !c.sleeping) {
            c.sleeping = true;
            // Release any claimed food when falling asleep
            if (c._claimedFood) {
              if (c._claimedFood.claimedBy === c) {
                c._claimedFood.claimedBy = null;
              }
              c._claimedFood = null;
            }
          }

          if (c.sleeping) {
            const sleepQuality = 1 + c.stability * 0.5;
            c.fatigue = Math.max(0, c.fatigue - 0.005 * sleepQuality);
            c.restedness = Math.min(1, c.restedness + 0.002 * sleepQuality);
            c.energy = Math.min(100, c.energy + 0.008 * sleepQuality);
            c.stress = Math.max(0, c.stress - 0.002);

            const wellRested = c.fatigue < 0.1;
            const fullyRested = c.restedness > 0.9;
            const energized = c.energy > 70;
            const conditionsMet = (wellRested ? 1 : 0) + (fullyRested ? 1 : 0) + (energized ? 1 : 0);
            if (conditionsMet >= 2 || c.fatigue < 0.05) {
              c.sleeping = false;
            }
          } else {
            const stillNow = c._cachedSpeed < 0.3;
            if (stillNow) {
              const recoveryRate = 0.001 + c.stability * 0.002;
              c.fatigue = Math.max(0, c.fatigue - recoveryRate);
              c.restedness = Math.min(1, c.restedness + recoveryRate * 0.5);
            }
          }

          const calmingRate = 0.0005 + c.stability * 0.001 + c.agreeableness * 0.0005;
          c.stress = Math.max(0, c.stress - calmingRate);

          const attachmentRate =
            0.0005 + c.conscientiousness * 0.001 + (1 - c.openness) * 0.0005;
          const attachmentThreshold = 0.2 + c.openness * 0.3;
          if (c.homeStrength < attachmentThreshold || Math.random() < attachmentRate * 0.1) {
            c.homeX = this.x;
            c.homeY = this.y;
            c.homeStrength = Math.min(1, c.homeStrength + attachmentRate);
          }
        }
      }

      if (this.occupants.size > 1) {
        for (let i = 0; i < creatures.length; i++) {
          const a = creatures[i];
          if (!this.occupants.has(a.id)) continue;
          for (let j = i + 1; j < creatures.length; j++) {
            const b = creatures[j];
            if (!this.occupants.has(b.id)) continue;
            a.updateBond(b.id, "proximity");
            b.updateBond(a.id, "proximity");
          }
        }
      }

      const targetGlow = this.occupants.size > 0 ? Math.min(1, this.occupants.size * 0.4) : 0;
      this.occupancyGlow += (targetGlow - this.occupancyGlow) * 0.05;

      return true;
    }

    drawThroughFog(): void {
      const easeIn = this.getEaseIn();
      if (easeIn < 0.3 || this.occupancyGlow < 0.1) return;

      const alpha = 0.03 * this.occupancyGlow * easeIn;
      ctx.beginPath();
      ctx.arc(this.x, this.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180, 140, 100, ${alpha})`;
      ctx.fill();
    }

    draw(): void {
      const revealLevel = this.getRevealLevel();
      if (revealLevel < 0.15) return;

      const easeIn = this.getEaseIn();
      const visAlpha = Math.min(1, revealLevel * 1.5) * easeIn;
      const r = this.radius * (0.7 + easeIn * 0.3);

      ctx.beginPath();
      ctx.ellipse(this.x, this.y + 2, r * 1.1, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 0, 0, ${0.25 * visAlpha})`;
      ctx.fill();

      const bowlGrad = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, r);
      bowlGrad.addColorStop(0, `rgba(45, 38, 32, ${visAlpha})`);
      bowlGrad.addColorStop(0.6, `rgba(35, 30, 26, ${visAlpha})`);
      bowlGrad.addColorStop(1, `rgba(28, 24, 22, ${0.8 * visAlpha})`);

      ctx.beginPath();
      ctx.ellipse(this.x, this.y, r, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = bowlGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.ellipse(this.x, this.y, r, r * 0.4, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(70, 60, 50, ${0.4 * visAlpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.ellipse(this.x, this.y + 1, r * 0.85, r * 0.3, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(25, 22, 20, ${0.3 * visAlpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const d of this.debris) {
        const dx = this.x + Math.cos(d.angle) * d.dist;
        const dy = this.y + Math.sin(d.angle) * d.dist * 0.4;
        ctx.beginPath();
        ctx.arc(dx, dy, d.size * easeIn, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${60 + d.hue}, ${50 + d.hue * 0.5}, ${40}, ${0.5 * visAlpha})`;
        ctx.fill();
      }

      if (this.occupancyGlow > 0.01) {
        const pulse = 1 + Math.sin(this.warmthPulse) * 0.15 * this.occupancyGlow;
        const warmGrad = ctx.createRadialGradient(
          this.x,
          this.y,
          0,
          this.x,
          this.y,
          r * 1.6 * pulse
        );
        warmGrad.addColorStop(0, `rgba(210, 170, 110, ${0.1 * this.occupancyGlow * visAlpha})`);
        warmGrad.addColorStop(0.4, `rgba(190, 150, 100, ${0.05 * this.occupancyGlow * visAlpha})`);
        warmGrad.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(this.x, this.y, r * 1.6 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = warmGrad;
        ctx.fill();
      }
    }
  }

  // ============================================================================
  // CREATURE CLASS
  // ============================================================================

  // Face proportions constants
  const FACE_CENTER = -0.02;
  const EYE_SPACING = 0.22;
  const EYE_SIZE = 0.13;
  const EYE_Y = -0.1;
  const MOUTH_OFFSET = 0.18;

  class Creature {
    // Identity
    id: string;
    name: string;
    generation: number;
    parentId: string | null;

    // Position & Movement
    x: number;
    y: number;
    vx: number;
    vy: number;
    targetX: number | null;
    targetY: number | null;
    wanderAngle: number;
    wanderTimer: number;
    seekingFood: boolean;

    // Personality (Big Five)
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    stability: number;

    // Appearance
    hue: number;
    roundness: number;
    glow: number;
    warmth: number;
    bodySkew: number;
    idleTilt: number;
    idleTiltTarget: number;
    idleTiltTimer: number;

    // Size & Growth
    size: number;
    targetSize: number;
    displaySize: number;
    revealRadius: number;

    // Needs & Stats
    energy: number;
    happiness: number;
    age: number;
    trust: number;
    fear: number;
    stress: number;
    attachment: number;
    fatigue: number;
    restedness: number;
    moodBaseline: number;

    // Deep Systems
    comforted: number;
    lonely: number;
    anticipation: number;
    petted: number;

    // Home
    homeX: number;
    homeY: number;
    homeStrength: number;

    // Memory
    memories: CreatureMemory;
    socialMemory: Map<string, SocialMemory>;
    socialContext: SocialContext;

    // Social
    friends: Set<string>;
    bonds: Map<string, Bond>;

    // Animation & State
    squash: number;
    targetSquash: number;
    lagX: number;
    lagY: number;
    expression: Expression;
    expressionTimer: number;
    blinking: boolean;
    blinkTimer: number;
    gazeX: number;
    gazeY: number;
    gazeTarget: { x: number; y: number } | null;
    gazeTimer: number;
    sleeping: boolean;
    isDead: boolean;

    // Cached values
    _cachedSpeed: number;
    _energyNorm: number;
    _claimedFood: Food | null;
    _voidChorusTimer: number;
    _voidChorusStrength: number;

    constructor(x: number, y: number, parent: Creature | null = null) {
      this.id = Math.random().toString(36).substring(2, 11);
      this.x = x;
      this.y = y;
      this.vx = (Math.random() - 0.5) * 0.5;
      this.vy = (Math.random() - 0.5) * 0.5;
      this.targetX = null;
      this.targetY = null;
      this.wanderAngle = Math.random() * Math.PI * 2;
      this.wanderTimer = 0;
      this.seekingFood = false;

      // Personality - inherited with mutation or random
      if (parent) {
        this.openness = mutate(parent.openness, 0.15);
        this.conscientiousness = mutate(parent.conscientiousness, 0.15);
        this.extraversion = mutate(parent.extraversion, 0.15);
        this.agreeableness = mutate(parent.agreeableness, 0.15);
        this.stability = mutate(parent.stability, 0.15);
        this.hue = (parent.hue + (Math.random() - 0.5) * 40 + 360) % 360;
        this.roundness = mutate(parent.roundness, 0.1);
        this.glow = mutate(parent.glow, 0.1);
        this.generation = parent.generation + 1;
        this.parentId = parent.id;
        this.name = generateName(parent.name);
      } else {
        this.openness = 0.3 + Math.random() * 0.5;
        this.conscientiousness = 0.3 + Math.random() * 0.5;
        this.extraversion = 0.3 + Math.random() * 0.5;
        this.agreeableness = 0.3 + Math.random() * 0.5;
        this.stability = 0.3 + Math.random() * 0.5;
        this.hue = Math.random() * 360;
        this.roundness = 0.7 + Math.random() * 0.3;
        this.glow = 0.6 + Math.random() * 0.4;
        this.generation = 0;
        this.parentId = null;
        this.name = generateName();
      }

      this.warmth = 0.3 + Math.random() * 0.4;
      this.bodySkew = (Math.random() - 0.5) * 0.3;
      this.idleTilt = 0;
      this.idleTiltTarget = 0;
      this.idleTiltTimer = 0;

      // Size
      this.size = 0.4 + Math.random() * 0.2;
      this.targetSize = 0.7 + Math.random() * 0.3;
      this.displaySize = this.size * 20;
      this.revealRadius = 50 + this.glow * 30;

      // Stats
      this.energy = 70 + Math.random() * 20;
      this.happiness = 50 + Math.random() * 30;
      this.age = 0;
      this.trust = 0.2 + Math.random() * 0.2;
      this.fear = 0;
      this.stress = 0;
      this.attachment = 0;
      this.fatigue = 0;
      this.restedness = 1;
      this.moodBaseline = 40 + Math.random() * 30;

      // Deep systems
      this.comforted = 0;
      this.lonely = 0;
      this.anticipation = 0;
      this.petted = 0;

      // Home
      this.homeX = x;
      this.homeY = y;
      this.homeStrength = 0;

      // Memory
      this.memories = {
        goodSpots: [],
        badSpots: [],
        fedCount: 0,
        petCount: 0,
        droppedInDark: 0,
        lastFedTime: 0,
        lastPetTime: 0,
      };
      this.socialMemory = new Map();
      this.socialContext = {
        nearbyHunger: 0,
        nearbyFear: 0,
        nearbyLoneliness: 0,
        neediest: null,
        neediestType: null,
        lastUpdate: 0,
      };

      // Social
      this.friends = new Set();
      this.bonds = new Map();

      // Animation
      this.squash = 1;
      this.targetSquash = 1;
      this.lagX = 0;
      this.lagY = 0;
      this.expression = "neutral";
      this.expressionTimer = 0;
      this.blinking = false;
      this.blinkTimer = 60 + Math.random() * 120;
      this.gazeX = 0;
      this.gazeY = 0;
      this.gazeTarget = null;
      this.gazeTimer = 0;
      this.sleeping = false;
      this.isDead = false;

      // Cached
      this._cachedSpeed = 0;
      this._energyNorm = this.energy / 100;
      this._claimedFood = null;
      this._voidChorusTimer = 0;
      this._voidChorusStrength = 0;
    }

    getLifeStage(): LifeStage {
      if (this.age < CONFIG.BABY_AGE) return "baby";
      if (this.age < CONFIG.CHILD_AGE) return "child";
      if (this.age < CONFIG.ADULT_AGE) return "adult";
      return "elder";
    }

    addMemory(type: "good" | "bad", x: number, y: number, strength: number): void {
      const spots = type === "good" ? this.memories.goodSpots : this.memories.badSpots;
      const existing = spots.find(
        (s) => Math.hypot(s.x - x, s.y - y) < 30
      );
      if (existing) {
        existing.strength = Math.min(1, existing.strength + strength);
      } else {
        spots.push({ x, y, strength });
        if (spots.length > 10) spots.shift();
      }
    }

    updateBond(otherId: string, type: "proximity" | "meal" | "help"): void {
      let bond = this.bonds.get(otherId);
      if (!bond) {
        bond = { strength: 0, sharedTime: 0, sharedMeals: 0, lastSeen: this.age };
        this.bonds.set(otherId, bond);
      }

      bond.lastSeen = this.age;

      if (type === "proximity") {
        bond.sharedTime++;
        bond.strength = Math.min(1, bond.strength + 0.0001);
      } else if (type === "meal") {
        bond.sharedMeals++;
        bond.strength = Math.min(1, bond.strength + 0.01);
      } else if (type === "help") {
        bond.strength = Math.min(1, bond.strength + 0.02);
      }

      if (bond.strength > 0.5 && !this.friends.has(otherId)) {
        this.friends.add(otherId);
      }
    }

    recordSocialPositive(otherId: string): void {
      let mem = this.socialMemory.get(otherId);
      if (!mem) {
        mem = { helpedMe: 0, iHelped: 0, lastPositive: this.age };
        this.socialMemory.set(otherId, mem);
      }
      mem.helpedMe++;
      mem.lastPositive = this.age;
    }

    pickup(): void {
      this.sleeping = false;
      this.expression = "surprised";
      this.expressionTimer = 30;
      this.targetSquash = 1.15;
      this.fear = Math.min(1, this.fear + 0.1 * (1 - this.trust));
    }

    putdown(): void {
      this.targetSquash = 0.85;

      const lightLevel = getLightAt(this.x, this.y);
      if (lightLevel < 0.2) {
        this.memories.droppedInDark++;
        this.fear = Math.min(1, this.fear + 0.15);
        this.trust = Math.max(0, this.trust - 0.02);
        this.addMemory("bad", this.x, this.y, 0.3);
      } else {
        this.trust = Math.min(1, this.trust + 0.01);
      }
    }

    pet(clickX: number, clickY: number): void {
      const dx = clickX - this.x;
      const dirX = dx > 0 ? 1 : -1;
      this.targetSquash = 0.75 + Math.random() * 0.1;
      this.vx += dirX * 0.3;

      const happinessGain = 5 + this.trust * 10;
      this.happiness = Math.min(100, this.happiness + happinessGain);

      const trustGain = 0.01 + (1 - this.fear) * 0.02;
      this.trust = Math.min(1, this.trust + trustGain);

      this.fear = Math.max(0, this.fear - 0.03);
      this.stress = Math.max(0, this.stress - 0.05);

      this.petted = 1;
      this.comforted = Math.min(1, this.comforted + 0.3);

      this.memories.petCount++;
      this.memories.lastPetTime = this.age;
      this.addMemory("good", this.x, this.y, 0.15);

      this.expression = "happy";
      this.expressionTimer = 40;

      if (particles.length < CONFIG.MAX_PARTICLES) {
        particles.push(new Particle(this.x, this.y - this.displaySize * 0.5, "pet", this.hue));
      }
      if (Math.random() < 0.4 && emotes.length < CONFIG.MAX_EMOTES) {
        emotes.push(new Emote(this.x, this.y - this.displaySize, "pet"));
      }

      for (const other of creatures) {
        if (other.id === this.id) continue;
        const d = Math.hypot(other.x - this.x, other.y - this.y);
        if (d < 50) {
          other.happiness = Math.min(100, other.happiness + 2);
          other.comforted = Math.min(1, other.comforted + 0.1);
        }
      }
    }

    die(reason: string): void {
      this.isDead = true;

      // Release any claimed food so other creatures can claim it
      if (this._claimedFood) {
        if (this._claimedFood.claimedBy === this) {
          this._claimedFood.claimedBy = null;
        }
        this._claimedFood = null;
      }

      for (let i = 0; i < 20 && particles.length < CONFIG.MAX_PARTICLES; i++) {
        particles.push(new Particle(this.x, this.y, "death", this.hue));
      }

      for (const other of creatures) {
        if (other.friends.has(this.id)) {
          other.happiness = Math.max(0, other.happiness - 15);
          other.stress = Math.min(1, other.stress + 0.2);
        }
        // Clean up social memory references to dead creature
        if (other.socialMemory.has(this.id)) {
          other.socialMemory.delete(this.id);
        }
        // Clean up bond references
        if (other.bonds.has(this.id)) {
          other.bonds.delete(this.id);
        }
        // Clean up friend references
        if (other.friends.has(this.id)) {
          other.friends.delete(this.id);
        }
      }
    }

    update(): "die" | Creature | null {
      if (this.isDead) return "die";

      this.age++;
      this._energyNorm = this.energy / 100;

      // Aging effects
      const lifeProgress = this.age / CONFIG.MAX_AGE;
      if (this.age > CONFIG.ELDER_AGE) {
        const elderProgress = (this.age - CONFIG.ELDER_AGE) / (CONFIG.MAX_AGE - CONFIG.ELDER_AGE);
        if (Math.random() < elderProgress * 0.0001) {
          this.die("old age");
          return "die";
        }
      }

      // Energy drain
      const activityDrain = this._cachedSpeed * 0.002;
      const stressDrain = this.stress * 0.003;
      const ageDrain = lifeProgress * 0.002;
      this.energy -= CONFIG.BASE_ENERGY_DRAIN + activityDrain + stressDrain + ageDrain;

      // Starvation
      if (this.energy <= 0) {
        this.die("starvation");
        return "die";
      }

      // Growth
      if (this.age < CONFIG.ADULT_AGE) {
        const growthRate = 0.0001 * (1 - this.age / CONFIG.ADULT_AGE);
        this.size = Math.min(this.targetSize, this.size + growthRate);
      }

      // Update display size
      this.displaySize = this.size * 20;
      this.revealRadius = 50 + this.glow * 30 + this.displaySize;

      // Movement
      this.updateMovement();

      // Reveal fog
      this.updateReveal();

      // Mood and state
      this.updateMood();

      // Expression
      this.updateExpression();

      // Animation
      this.updateAnimation();

      // Reproduction
      const baby = this.updateReproduction();
      if (baby) return baby;

      // Social
      this.updateSocial();

      return null;
    }

    updateMovement(): void {
      if (this === heldCreature) {
        const targetX = mouse.x;
        const targetY = mouse.y;
        this.vx += (targetX - this.x) * 0.15;
        this.vy += (targetY - this.y) * 0.15;
        this.vx *= 0.7;
        this.vy *= 0.7;
        this.x += this.vx;
        this.y += this.vy;
        this._cachedSpeed = Math.hypot(this.vx, this.vy);
        return;
      }

      if (this.sleeping) {
        this.vx *= 0.9;
        this.vy *= 0.9;
        this.x += this.vx;
        this.y += this.vy;
        this._cachedSpeed = Math.hypot(this.vx, this.vy);
        return;
      }

      // Speed based on personality and state
      let baseSpeed = 0.3 + this.extraversion * 0.2;
      baseSpeed *= 1 - this.fatigue * 0.4;
      baseSpeed *= 0.7 + this._energyNorm * 0.3;

      // Hunger-driven food seeking
      const hunger = 1 - this._energyNorm;
      if (hunger > 0.3) {
        let nearestFood: Food | null = null;
        let nearestDist: number = CONFIG.FOOD_SEEK_RADIUS;

        for (const f of foods) {
          if (f.claimedBy && f.claimedBy !== this) continue;
          const d = Math.hypot(f.x - this.x, f.y - this.y);
          if (d < nearestDist) {
            nearestDist = d;
            nearestFood = f;
          }
        }

        if (nearestFood) {
          if (!nearestFood.claimedBy) {
            nearestFood.claimedBy = this;
            this._claimedFood = nearestFood;
          }
          this.targetX = nearestFood.x;
          this.targetY = nearestFood.y;
          this.seekingFood = true;
          baseSpeed *= 1 + hunger * 0.5;
        } else {
          this.seekingFood = false;
          if (this._claimedFood) {
            if (this._claimedFood.claimedBy === this) {
              this._claimedFood.claimedBy = null;
            }
            this._claimedFood = null;
          }
        }
      } else {
        this.seekingFood = false;
        // Clear any claimed food when no longer hungry
        if (this._claimedFood) {
          if (this._claimedFood.claimedBy === this) {
            this._claimedFood.claimedBy = null;
          }
          this._claimedFood = null;
        }
      }

      // Wander if no target
      if (!this.targetX && !this.seekingFood) {
        this.wanderTimer--;
        if (this.wanderTimer <= 0) {
          this.wanderTimer = 60 + Math.random() * 120;

          // Home pull
          if (this.homeStrength > 0.3 && Math.random() < this.homeStrength * 0.3) {
            this.targetX = this.homeX + (Math.random() - 0.5) * 40;
            this.targetY = this.homeY + (Math.random() - 0.5) * 40;
          } else {
            this.wanderAngle += (Math.random() - 0.5) * 1.5;
            const wanderDist = CONFIG.WANDER_RADIUS * (0.5 + this.openness * 0.5);
            this.targetX = this.x + Math.cos(this.wanderAngle) * wanderDist;
            this.targetY = this.y + Math.sin(this.wanderAngle) * wanderDist;
          }
        }
      }

      // Move toward target
      if (this.targetX !== null && this.targetY !== null) {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const d = Math.hypot(dx, dy);

        if (d > 5) {
          const moveX = (dx / d) * baseSpeed;
          const moveY = (dy / d) * baseSpeed;
          this.vx += moveX * 0.1;
          this.vy += moveY * 0.1;
        } else {
          this.targetX = null;
          this.targetY = null;
        }
      }

      // Hole avoidance
      for (const hole of holes) {
        const hd = Math.hypot(this.x - hole.x, this.y - hole.y);
        const avoidRange = hole.radius + 30 + this.fear * 20;
        if (hd < avoidRange && hd > 0) {
          const strength = (1 - hd / avoidRange) * 0.02 * (1 + this.fear);
          this.vx += ((this.x - hole.x) / hd) * strength;
          this.vy += ((this.y - hole.y) / hd) * strength;
          this.fear = Math.min(1, this.fear + 0.002 * (1 - this.stability));
        }
      }

      // Fissure avoidance
      for (const f of fissures) {
        const force = f.getAvoidanceForce(this.x, this.y, this.fear, this.stability);
        if (force) {
          this.vx += force.fx;
          this.vy += force.fy;
        }
      }

      // Social forces
      for (const other of creatures) {
        if (other.id === this.id) continue;
        const odx = other.x - this.x;
        const ody = other.y - this.y;
        if (Math.abs(odx) > 100 || Math.abs(ody) > 100) continue;

        const od = Math.hypot(odx, ody);
        if (od < 15 && od > 0) {
          // Separation
          this.vx -= (odx / od) * 0.02;
          this.vy -= (ody / od) * 0.02;
        } else if (od < 60 && this.extraversion > 0.4) {
          // Cohesion
          this.vx += (odx / od) * 0.003 * this.extraversion;
          this.vy += (ody / od) * 0.003 * this.extraversion;
        }
      }

      // Void chorus attraction
      if (this._voidChorusTimer > 0) {
        this._voidChorusTimer--;
        for (const other of creatures) {
          if (other.id === this.id || other._voidChorusTimer > 0) continue;
          const od = Math.hypot(other.x - this.x, other.y - this.y);
          if (od < 150 && od > 20) {
            const pull = this._voidChorusStrength * 0.01 * (1 - od / 150);
            other.vx += ((this.x - other.x) / od) * pull;
            other.vy += ((this.y - other.y) / od) * pull;
          }
        }
      }

      // Apply velocity
      this.vx *= 0.92;
      this.vy *= 0.92;
      this.x += this.vx;
      this.y += this.vy;

      // Bounds
      const margin = 20;
      if (this.x < margin) { this.x = margin; this.vx *= -0.5; }
      if (this.x > W - margin) { this.x = W - margin; this.vx *= -0.5; }
      if (this.y < margin) { this.y = margin; this.vy *= -0.5; }
      if (this.y > H - margin) { this.y = H - margin; this.vy *= -0.5; }

      this._cachedSpeed = Math.hypot(this.vx, this.vy);
    }

    updateReveal(): void {
      // Worker handles reveal in updateEntities
      if (fogWorker.isActive) return;

      if (!revealMap || !lastRevealTime) return;

      // Warmth-based reveal (matches original JS version)
      // Warm creatures illuminate more, cold creatures barely reveal
      const warmthMultiplier = 0.4 + this.warmth * 0.9;
      const radius = this.revealRadius * warmthMultiplier;
      const revealIntensity = 0.014 + this.warmth * 0.016;
      const emissionIntensity = this.glow * (0.5 + this.warmth * 0.5);

      const cx = Math.floor(this.x / revealRes);
      const cy = Math.floor(this.y / revealRes);
      const r = Math.ceil(radius / revealRes);
      const radiusSq = radius * radius;
      const revealResSq = revealRes * revealRes;
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
            revealMap[idx] = Math.min(1, revealMap[idx] + intensity);
            // Track when this cell was revealed (for lingering)
            if (intensity > 0.05) {
              lastRevealTime[idx] = time;
            }
          }
        }
      }
      fogDirty = true;
    }

    updateMood(): void {
      // Comfort decay
      this.comforted = Math.max(0, this.comforted - 0.002);
      this.petted = Math.max(0, this.petted - 0.03);

      // Loneliness
      let nearbyCount = 0;
      for (const other of creatures) {
        if (other.id !== this.id && Math.hypot(other.x - this.x, other.y - this.y) < CONFIG.SOCIAL_RADIUS) {
          nearbyCount++;
        }
      }

      const desiredCompanions = this.extraversion * 3;
      if (nearbyCount < desiredCompanions) {
        this.lonely = Math.min(1, this.lonely + 0.001 * (1 - nearbyCount / Math.max(1, desiredCompanions)));
      } else {
        this.lonely = Math.max(0, this.lonely - 0.002);
      }

      // Fatigue
      if (this._cachedSpeed > 0.5) {
        this.fatigue = Math.min(1, this.fatigue + 0.0002);
        this.restedness = Math.max(0, this.restedness - 0.0001);
      }

      // Happiness drift toward baseline
      const targetHappy = this.moodBaseline + this.comforted * 20 - this.stress * 15 - this.lonely * 10;
      this.happiness += (targetHappy - this.happiness) * 0.001;
      this.happiness = Math.max(0, Math.min(100, this.happiness));

      // Fear decay
      this.fear = Math.max(0, this.fear - 0.001 * this.stability);

      // Stress from various sources
      if (this.energy < 30) {
        this.stress = Math.min(1, this.stress + 0.001);
      }
      if (this.lonely > 0.5) {
        this.stress = Math.min(1, this.stress + 0.0005);
      }
      this.stress = Math.max(0, this.stress - 0.0005 * this.stability);
    }

    updateExpression(): void {
      if (this.expressionTimer > 0) {
        this.expressionTimer--;
        return;
      }

      if (this.sleeping) {
        this.expression = "sleepy";
        return;
      }

      if (this.fear > 0.5) {
        this.expression = "scared";
      } else if (this.fear > 0.2) {
        this.expression = "nervous";
      } else if (this.happiness > 80 || this.comforted > 0.6) {
        this.expression = this.petted > 0.3 ? "loved" : "happy";
      } else if (this.happiness < 30 || this.lonely > 0.6) {
        this.expression = "sad";
      } else if (this.energy < 25 || this.fatigue > 0.7) {
        this.expression = "sleepy";
      } else {
        this.expression = "neutral";
      }
    }

    updateAnimation(): void {
      // Squash animation
      this.squash += (this.targetSquash - this.squash) * 0.15;
      this.targetSquash += (1 - this.targetSquash) * 0.1;

      // Jelly lag
      const targetLagX = -this.vx * 3;
      const targetLagY = -this.vy * 3;
      this.lagX += (targetLagX - this.lagX) * 0.1;
      this.lagY += (targetLagY - this.lagY) * 0.1;

      // Blinking
      this.blinkTimer--;
      if (this.blinking) {
        // Already blinking, check if blink duration is over
        if (this.blinkTimer <= 0) {
          this.blinking = false;
          this.blinkTimer = 60 + Math.random() * 180;
        }
      } else {
        // Not blinking, check if it's time to start a blink
        if (this.blinkTimer <= 0) {
          this.blinking = true;
          this.blinkTimer = 4 + Math.random() * 4;
        }
      }

      // Gaze
      if (this.gazeTarget) {
        this.gazeTimer--;
        if (this.gazeTimer <= 0) {
          this.gazeTarget = null;
        } else {
          const gdx = this.gazeTarget.x - this.x;
          const gdy = this.gazeTarget.y - this.y;
          const gd = Math.hypot(gdx, gdy);
          if (gd > 0) {
            const maxGaze = this.displaySize * 0.15;
            this.gazeX += ((gdx / gd) * maxGaze - this.gazeX) * 0.1;
            this.gazeY += ((gdy / gd) * maxGaze - this.gazeY) * 0.1;
          }
        }
      } else {
        this.gazeX *= 0.95;
        this.gazeY *= 0.95;
      }

      // Idle tilt
      this.idleTiltTimer--;
      if (this.idleTiltTimer <= 0) {
        this.idleTiltTarget = (Math.random() - 0.5) * 0.15;
        this.idleTiltTimer = 60 + Math.random() * 120;
      }
      this.idleTilt += (this.idleTiltTarget - this.idleTilt) * 0.02;
    }

    updateReproduction(): Creature | null {
      if (this.age < CONFIG.MIN_REPRODUCE_AGE) return null;
      if (this.energy < CONFIG.REPRODUCE_ENERGY_COST + 30) return null;
      if (this.happiness < 60) return null;
      if (this.stress > 0.4) return null;
      if (creatures.length >= CONFIG.MAX_CREATURES) return null;

      const healthBonus = (this.energy / 100) * (this.happiness / 100);
      const socialBonus = this.friends.size > 0 ? 1.5 : 1;
      const chance = CONFIG.REPRODUCE_CHANCE * healthBonus * socialBonus;

      if (Math.random() < chance) {
        this.energy -= CONFIG.REPRODUCE_ENERGY_COST;

        const baby = new Creature(
          this.x + (Math.random() - 0.5) * 30,
          this.y + (Math.random() - 0.5) * 30,
          this
        );

        for (let i = 0; i < 15 && particles.length < CONFIG.MAX_PARTICLES; i++) {
          particles.push(new Particle(baby.x, baby.y, "birth", baby.hue));
        }

        if (emotes.length < CONFIG.MAX_EMOTES) {
          emotes.push(new Emote(this.x, this.y - this.displaySize, "heart"));
        }

        return baby;
      }

      return null;
    }

    updateSocial(): void {
      // Update bonds with nearby creatures
      for (const other of creatures) {
        if (other.id === this.id) continue;
        const d = Math.hypot(other.x - this.x, other.y - this.y);
        if (d < CONFIG.FRIEND_RADIUS) {
          this.updateBond(other.id, "proximity");
        }
      }
    }

    draw(): void {
      if (this.isDead) return;

      const size = this.displaySize;
      const bodyR = size * this.roundness;
      const hunger = 1 - this._energyNorm;

      // Energy affects opacity
      const energyAlpha = 0.6 + this._energyNorm * 0.4;

      // Animation phases
      const creatureTime = this.age;
      const phase = creatureTime * 0.08;
      const bulge = 0.3 + this._cachedSpeed * 0.4;

      // Squash/stretch
      const petSquashAmount = Math.max(0, 1 - this.squash);
      const currentSquashX = 1 / this.squash;
      const currentSquashY = this.squash;

      // Lag for jelly effect
      const lagX = this.lagX;
      const lagY = this.lagY;

      // Breathing/wobble
      const breathe = Math.sin(creatureTime * 0.05) * 0.02;
      const wY = breathe * size;

      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.idleTilt);
      ctx.scale(currentSquashX, currentSquashY);

      // Body outline
      ctx.beginPath();
      for (let i = 0; i <= BODY_SEGMENTS; i++) {
        const cosA = BODY_COS[i];
        const sinA = BODY_SIN[i];

        let r = bodyR;
        const angle2 = (i / BODY_SEGMENTS) * Math.PI * 4;
        const organicWave = Math.sin(angle2 + phase) * bulge * 0.06;
        r += bodyR * organicWave;

        let px = cosA * r;
        let py = sinA * r;

        const lagInfluence = (sinA + 1) * 0.5;
        const sideLagInfluence = 1 - Math.abs(sinA);

        px += lagX * lagInfluence * 0.6;
        py += lagY * lagInfluence * 0.4 + wY;

        const compensateBulge = Math.abs(lagX) * 0.08 * sideLagInfluence;
        px += cosA * compensateBulge;

        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      // Body color
      const baseSat = 24 + this.happiness * 0.22;
      const comfortBoost = this.comforted * 5 + this.trust * 3;
      const fearDesaturation = this.fear * 14;
      const fatigueDesaturation = this.fatigue * 7;
      const stressDesaturation = this.stress * 9;
      const lonelinessDesaturation = this.lonely * 8;
      const hungerDesaturation = hunger * 10;
      const sat = Math.max(
        6,
        baseSat + comfortBoost - fearDesaturation - fatigueDesaturation - stressDesaturation - lonelinessDesaturation - hungerDesaturation
      );

      const baseLight = 72 + this.comforted * 7 + this.petted * 9;
      const fearPale = this.fear * 9;
      const fatigueDark = this.fatigue * 5;
      const lonelyDark = this.lonely * 4;
      const light = Math.min(90, Math.max(54, baseLight + fearPale - fatigueDark - lonelyDark));

      const bodyGrad = ctx.createRadialGradient(
        -size * 0.25 + lagX * 0.3, -size * 0.3 + lagY * 0.2, 0,
        size * 0.1, size * 0.1, size * 1.1
      );
      bodyGrad.addColorStop(0, `hsla(${this.hue}, ${sat}%, ${light + 4}%, ${energyAlpha})`);
      bodyGrad.addColorStop(0.45, `hsla(${this.hue}, ${Math.max(6, sat - 2)}%, ${light - 6}%, ${energyAlpha})`);
      bodyGrad.addColorStop(1, `hsla(${this.hue}, ${Math.max(6, sat - 5)}%, ${light - 16}%, ${energyAlpha * 0.92})`);

      ctx.fillStyle = bodyGrad;
      ctx.fill();

      // Specular highlight
      const hlLagX = lagX * 0.3;
      const hlLagY = lagY * 0.25;
      const highlightX = -bodyR * 0.28 + hlLagX;
      const highlightY = -bodyR * 0.45 + wY + hlLagY;
      const hlSizeBase = size * 0.32;

      const highlight = ctx.createRadialGradient(highlightX, highlightY, 0, highlightX, highlightY, hlSizeBase);
      const baseHighlight = (0.2 + this.happiness * 0.0015 + this.comforted * 0.06) * (1 - this.fatigue * 0.25) * (1 - this.stress * 0.15);
      const impactFlash = petSquashAmount * 0.4;
      const highlightStrength = baseHighlight + impactFlash;
      highlight.addColorStop(0, `rgba(255, 255, 255, ${highlightStrength * energyAlpha})`);
      highlight.addColorStop(0.5, `rgba(255, 255, 255, ${(highlightStrength * 0.35 + impactFlash * 0.2) * energyAlpha})`);
      highlight.addColorStop(1, "transparent");

      ctx.beginPath();
      ctx.ellipse(highlightX, highlightY, hlSizeBase * Math.sqrt(currentSquashX), hlSizeBase * 0.65 * Math.sqrt(currentSquashY), -0.25, 0, Math.PI * 2);
      ctx.fillStyle = highlight;
      ctx.fill();

      // Face
      const faceLagX = lagX * 0.15;
      const faceLagY = lagY * 0.12;
      const faceY = size * FACE_CENTER + wY + faceLagY;
      const eyeSpacing = size * EYE_SPACING;
      const eyeSize = size * EYE_SIZE;
      const eyeY = size * EYE_Y + wY + faceLagY;

      const isScared = this.expression === "scared" || this.expression === "nervous";
      const isHappy = this.expression === "happy" || this.expression === "loved";
      const isSleepy = this.expression === "sleepy";

      let eyeScaleX = 1;
      let eyeScaleY = 1.08;
      if (isScared) { eyeScaleX = 1.15; eyeScaleY = 1.3; }
      else if (isHappy) { eyeScaleX = 1.02; eyeScaleY = 0.92; }
      else if (isSleepy) { eyeScaleY = 0.55; }

      const boopReact = petSquashAmount * 1.5;
      eyeScaleX += boopReact * 0.15;
      eyeScaleY += boopReact * 0.1;

      const showEyes = !this.blinking && this.expression !== "loved";

      if (showEyes && !isSleepy) {
        // Eye whites
        ctx.fillStyle = `rgba(255, 255, 255, ${0.93 * energyAlpha})`;
        const leftEyeX = -eyeSpacing + faceLagX;
        const rightEyeX = eyeSpacing + faceLagX;

        ctx.beginPath();
        ctx.ellipse(leftEyeX, eyeY, eyeSize * eyeScaleX, eyeSize * eyeScaleY, -0.03 - this.idleTilt * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(rightEyeX, eyeY, eyeSize * eyeScaleX, eyeSize * eyeScaleY, 0.03 - this.idleTilt * 0.3, 0, Math.PI * 2);
        ctx.fill();

        // Pupils
        const lookX = this.gazeX;
        const lookY = this.gazeY;
        let pupilMult = 0.46 + this.trust * 0.06;
        if (isScared) pupilMult = 0.3;
        else {
          pupilMult += this.fatigue * 0.04;
          pupilMult -= this.stress * 0.05;
          pupilMult -= this.lonely * 0.03;
          pupilMult += hunger * 0.06;
        }
        const pupilSize = eyeSize * Math.max(0.25, Math.min(0.55, pupilMult));

        ctx.fillStyle = `rgba(18, 18, 28, ${energyAlpha})`;
        ctx.beginPath();
        ctx.arc(leftEyeX + lookX, eyeY + lookY, pupilSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(rightEyeX + lookX, eyeY + lookY, pupilSize, 0, Math.PI * 2);
        ctx.fill();

        // Eye shine
        const shineTrack = 0.15;
        const shineOffX = -pupilSize * 0.3 + lookX * shineTrack;
        const shineOffY = -pupilSize * 0.35 + lookY * shineTrack;
        const hungerDim = hunger * 0.2;
        const shineBrightness = (0.55 + this.restedness * 0.25) * (1 - this.lonely * 0.15) * (1 - hungerDim);

        ctx.fillStyle = `rgba(255, 255, 255, ${shineBrightness * energyAlpha})`;
        ctx.beginPath();
        ctx.arc(leftEyeX + shineOffX, eyeY + shineOffY, pupilSize * 0.36, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(rightEyeX + shineOffX, eyeY + shineOffY, pupilSize * 0.36, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Closed eyes
        ctx.strokeStyle = `rgba(55, 45, 65, ${energyAlpha})`;
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        const closedLeftX = -eyeSpacing + faceLagX;
        const closedRightX = eyeSpacing + faceLagX;

        if (isSleepy) {
          ctx.beginPath();
          ctx.arc(closedLeftX, eyeY + 1, eyeSize * 0.48, 0.2 * Math.PI, 0.8 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(closedRightX, eyeY + 1, eyeSize * 0.48, 0.2 * Math.PI, 0.8 * Math.PI);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(closedLeftX, eyeY + 2, eyeSize * 0.52, 1.15 * Math.PI, 1.85 * Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(closedRightX, eyeY + 2, eyeSize * 0.52, 1.15 * Math.PI, 1.85 * Math.PI);
          ctx.stroke();
        }
      }

      // Mouth
      const mouthX = faceLagX;
      const mouthY = faceY + size * MOUTH_OFFSET;
      ctx.strokeStyle = `rgba(55, 45, 65, ${energyAlpha * 0.75})`;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";

      if (this.expression === "happy" || this.expression === "loved") {
        ctx.beginPath();
        ctx.arc(mouthX, mouthY - 1, size * 0.1, 0.1 * Math.PI, 0.9 * Math.PI);
        ctx.stroke();
      } else if (this.expression === "sleepy") {
        ctx.beginPath();
        ctx.ellipse(mouthX, mouthY + 1, size * 0.05, size * 0.04, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (this.expression === "eating") {
        ctx.beginPath();
        ctx.ellipse(mouthX, mouthY, size * 0.08, size * 0.09, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(35, 30, 45, ${energyAlpha * 0.45})`;
        ctx.fill();
        ctx.stroke();
      } else if (this.expression === "sad") {
        ctx.beginPath();
        ctx.arc(mouthX, mouthY + 3.5, size * 0.08, 1.2 * Math.PI, 1.8 * Math.PI);
        ctx.stroke();
      } else if (this.expression === "surprised") {
        ctx.beginPath();
        ctx.ellipse(mouthX, mouthY, size * 0.06, size * 0.08, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(35, 30, 45, ${energyAlpha * 0.35})`;
        ctx.fill();
        ctx.stroke();
      } else if (this.expression === "scared") {
        ctx.beginPath();
        ctx.ellipse(mouthX, mouthY + 1, size * 0.09, size * 0.11, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(25, 22, 35, ${energyAlpha * 0.55})`;
        ctx.fill();
        ctx.stroke();
      } else if (this.expression === "nervous") {
        const nerveWobble = Math.sin(creatureTime * 0.18) * 0.4;
        ctx.beginPath();
        ctx.moveTo(mouthX - size * 0.06, mouthY + nerveWobble);
        ctx.quadraticCurveTo(mouthX - size * 0.02, mouthY + 2 + nerveWobble, mouthX, mouthY + 0.5 + nerveWobble);
        ctx.quadraticCurveTo(mouthX + size * 0.02, mouthY - 1 + nerveWobble, mouthX + size * 0.06, mouthY + 0.8 + nerveWobble);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(mouthX - size * 0.05, mouthY);
        ctx.quadraticCurveTo(mouthX, mouthY + 0.8, mouthX + size * 0.05, mouthY);
        ctx.stroke();
      }

      // Blush
      const blushTrigger = Math.max(
        this.comforted * 0.8,
        this.petted * 1.2,
        ((this.happiness - 60) / 60) * 0.5,
        this.trust > 0.7 ? (this.trust - 0.7) * 0.8 : 0
      );

      if (blushTrigger > 0.15) {
        const blushA = Math.min(0.32, (blushTrigger - 0.15) * 0.45) * energyAlpha;
        const blushY = eyeY + size * 0.13;
        const blushSpacing = eyeSpacing + size * 0.1;
        const warmthShift = (this.warmth - 0.5) * 30;
        const blushHue = 355 + this.hue * 0.04 + warmthShift;
        ctx.fillStyle = `hsla(${blushHue}, 60%, 75%, ${blushA})`;

        ctx.beginPath();
        ctx.ellipse(-blushSpacing + faceLagX, blushY, size * 0.09, size * 0.055, -0.12, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(blushSpacing + faceLagX, blushY, size * 0.09, size * 0.055, 0.12, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  // ============================================================================
  // TERRAIN & SPAWNING FUNCTIONS
  // ============================================================================

  function generateTerrain(depth: number, seed: number): { baseLight: number; safeZoneCount: number } {
    terrainSeed = seed;
    terrainFeatures = [];
    initWorldRandom(seed);

    const safeZoneCount = Math.round(4 * Math.exp(-depth * 0.15) + 0.5);
    const baseLight = 0.4 * Math.exp(-depth * 0.08);

    for (let i = 0; i < safeZoneCount; i++) {
      const margin = 60;
      terrainFeatures.push({
        type: "safeZone",
        x: margin + worldRandom() * (W - margin * 2),
        y: margin + worldRandom() * (H - margin * 2),
        radius: 50 + worldRandom() * 60,
        intensity: 0.3 + worldRandom() * 0.3,
      });
    }

    const glowCount = 2 + Math.floor(worldRandom() * 3);
    for (let i = 0; i < glowCount; i++) {
      terrainFeatures.push({
        type: "glow",
        x: worldRandom() * W,
        y: worldRandom() * H,
        radius: 30 + worldRandom() * 40,
        intensity: 0.1 + worldRandom() * 0.15,
        hue: 240 + worldRandom() * 60,
      });
    }

    // Reveal safe zones in fog
    const safeZoneRevealPoints: Array<{ x: number; y: number; radius: number; intensity: number }> = [];
    for (const feature of terrainFeatures) {
      if (feature.type === "safeZone") {
        safeZoneRevealPoints.push({
          x: feature.x,
          y: feature.y,
          radius: feature.radius,
          intensity: feature.intensity * 0.5,
        });
      }
    }

    if (fogWorker.isActive) {
      // Use worker for reveal
      fogWorker.addRevealPoints(safeZoneRevealPoints);
    } else if (revealMap) {
      // Fallback: direct reveal map manipulation
      for (const point of safeZoneRevealPoints) {
        const cx = Math.floor(point.x / revealRes);
        const cy = Math.floor(point.y / revealRes);
        const r = Math.ceil(point.radius / revealRes);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const gx = cx + dx;
            const gy = cy + dy;
            if (gx < 0 || gx >= revealW || gy < 0 || gy >= revealH) continue;
            const d = Math.sqrt(dx * dx + dy * dy) * revealRes;
            if (d < point.radius) {
              const idx = gy * revealW + gx;
              const intensity = (1 - d / point.radius) * point.intensity;
              revealMap[idx] = Math.max(revealMap[idx], intensity);
            }
          }
        }
      }
      fogDirty = true;
    }

    return { baseLight, safeZoneCount };
  }

  function spawnHole(forceSpawn = false, seeded = false): boolean {
    if (!forceSpawn) {
      const densityPenalty = Math.exp(-holes.length * 0.5);
      if (Math.random() > densityPenalty) return false;
    }

    const protectionRadius = 60 + Math.max(0, 80 - creatures.length * 2);

    const avoidPoints: Array<{ x: number; y: number; radius: number }> = [
      { x: W / 2, y: H * 0.28, radius: protectionRadius },
    ];
    for (const hole of holes) {
      avoidPoints.push({ x: hole.x, y: hole.y, radius: CONFIG.MIN_HOLE_DIST });
    }

    const pos = SpawnableUtils.findSpawnPosition({
      margin: 50,
      maxAttempts: 30,
      avoidPoints,
      avoidCreatures: true,
      creatureBuffer: 60,
      seeded,
    });

    if (pos) {
      holes.push(new Hole(pos.x, pos.y));
      return true;
    }
    return false;
  }

  function spawnStructures(seeded = false): void {
    if (holes.length === 0) return;

    const rng = seeded ? worldRandom : Math.random;

    const avoidPoints: Array<{ x: number; y: number; radius: number }> = [];
    for (const hole of holes) {
      avoidPoints.push({ x: hole.x, y: hole.y, radius: hole.radius + CONFIG.STRUCTURE_HOLE_BUFFER });
    }
    avoidPoints.push({ x: W / 2, y: H * 0.28, radius: 100 });

    const monolithPos = SpawnableUtils.findSpawnPosition({
      margin: 40,
      maxAttempts: 40,
      avoidPoints,
      avoidCreatures: false,
      seeded,
    });

    if (!monolithPos) return;

    const monolith = new Monolith(monolithPos.x, monolithPos.y);
    monoliths.push(monolith);

    let nestPos: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const angle = rng() * Math.PI * 2;
      const d = CONFIG.NEST_MONOLITH_DIST * (0.8 + rng() * 0.4);
      const testX = monolithPos.x + Math.cos(angle) * d;
      const testY = monolithPos.y + Math.sin(angle) * d;

      const margin = 30;
      if (testX < margin || testX > W - margin || testY < margin || testY > H - margin) continue;

      let valid = true;
      for (const hole of holes) {
        if (Math.hypot(testX - hole.x, testY - hole.y) < hole.radius + 40) {
          valid = false;
          break;
        }
      }

      if (valid) {
        nestPos = { x: testX, y: testY };
        break;
      }
    }

    if (nestPos) {
      nests.push(new Nest(nestPos.x, nestPos.y));
    }
  }

  // ============================================================================
  // NAVIGATION FUNCTIONS
  // ============================================================================

  function descendIntoHole(): void {
    if (heldCreature) {
      heldCreature.putdown();
      heldCreature = null;
    }
    tooltipCreature = null;
    rightClickTarget = null;
    touchCreature = null;
    mouse.down = false;
    mouse.rightDown = false;
    mouse.holdTime = 0;
    mouse.rightHoldTime = 0;
    mouse.tappedHole = null;
    pickupProgress = 0;
    respawnPending = false;

    const creatureData = creatures.map((c) => ({
      ...serializeCreature(c),
      x: W / 2 + (Math.random() - 0.5) * 100,
      y: H / 2 + (Math.random() - 0.5) * 100,
    }));

    currentDepth++;

    const newUrl = currentDepth > 0 ? `${getBasePath()}/depth/${currentDepth}` : getBasePath();
    history.pushState({ depth: currentDepth }, "", newUrl);

    holes = [];
    fissures = [];
    monoliths = [];
    nests = [];
    foods = [];
    particles = [];
    emotes = [];
    initRevealMap();
    generateTerrain(currentDepth, pathSeed + currentDepth * 12345);

    spawnHole(true, true);
    spawnStructures(true);

    creatures = [];
    for (const data of creatureData) {
      const c = new Creature(data.x, data.y);
      deserializeCreature(c, data);
      c.homeX = c.x;
      c.homeY = c.y;
      c.homeStrength = 0;
      c.memories.goodSpots = [];
      c.memories.badSpots = [];
      creatures.push(c);
    }

    const displayPath = newUrl.replace(/^\//, "") || "nowhere";
    lostPath.textContent = `404 - /${displayPath} - page not found`;

    showToast(`depth ${currentDepth}`);
  }

  function navigateToDepth(targetDepth: number): void {
    if (heldCreature) {
      heldCreature.putdown();
      heldCreature = null;
    }
    tooltipCreature = null;
    respawnPending = false;
    rightClickTarget = null;
    pickupProgress = 0;

    const creatureData = creatures.map((c) => ({
      ...serializeCreature(c),
      x: W / 2 + (Math.random() - 0.5) * 100,
      y: H / 2 + (Math.random() - 0.5) * 100,
    }));

    currentDepth = targetDepth;

    holes = [];
    fissures = [];
    monoliths = [];
    nests = [];
    foods = [];
    particles = [];
    emotes = [];
    terrainFeatures = [];
    initRevealMap();
    if (currentDepth > 0) {
      generateTerrain(currentDepth, pathSeed + currentDepth * 12345);
    } else {
      initWorldRandom(pathSeed);
    }

    spawnHole(true, true);
    spawnStructures(true);

    creatures = [];
    for (const data of creatureData) {
      const c = new Creature(data.x, data.y);
      deserializeCreature(c, data);
      c.homeX = c.x;
      c.homeY = c.y;
      c.homeStrength = 0;
      c.memories.goodSpots = [];
      c.memories.badSpots = [];
      creatures.push(c);
    }

    const displayPath = window.location.pathname.replace(/^\//, "") || "nowhere";
    lostPath.textContent = `404 - /${displayPath} - page not found`;

    showToast(currentDepth > 0 ? `depth ${currentDepth}` : "surface");
  }

  // ============================================================================
  // SERIALIZATION FUNCTIONS
  // ============================================================================

  function serializeCreature(c: Creature): SerializedCreature {
    return {
      id: c.id,
      x: c.x,
      y: c.y,
      name: c.name,
      generation: c.generation,
      openness: c.openness,
      conscientiousness: c.conscientiousness,
      extraversion: c.extraversion,
      agreeableness: c.agreeableness,
      stability: c.stability,
      roundness: c.roundness,
      glow: c.glow,
      hue: c.hue,
      energy: c.energy,
      happiness: c.happiness,
      age: c.age,
      size: c.size,
      targetSize: c.targetSize,
      friends: Array.from(c.friends),
      bonds: Array.from(c.bonds.entries()),
      parentId: c.parentId,
      trust: c.trust,
      fear: c.fear,
      stress: c.stress,
      attachment: c.attachment,
      fatigue: c.fatigue,
      restedness: c.restedness,
      moodBaseline: c.moodBaseline,
      homeX: c.homeX,
      homeY: c.homeY,
      homeStrength: c.homeStrength,
      sleeping: c.sleeping,
      memories: c.memories,
      comforted: c.comforted,
      lonely: c.lonely,
      anticipation: c.anticipation,
      vx: c.vx,
      vy: c.vy,
    };
  }

  function deserializeCreature(c: Creature, data: Partial<SerializedCreature>): void {
    c.id = data.id || c.id;
    c.name = data.name || c.name;
    c.generation = data.generation || 0;
    c.openness = data.openness ?? 0.5;
    c.conscientiousness = data.conscientiousness ?? 0.5;
    c.extraversion = data.extraversion ?? 0.5;
    c.agreeableness = data.agreeableness ?? 0.5;
    c.stability = data.stability ?? 0.5;
    c.roundness = data.roundness ?? 0.8;
    c.glow = data.glow ?? 0.8;
    c.hue = data.hue ?? Math.random() * 360;
    c.energy = data.energy ?? 70;
    c.happiness = data.happiness ?? 60;
    c.age = data.age ?? 0;
    c.size = data.size ?? 0.5;
    c.targetSize = data.targetSize ?? 0.8;
    c.friends = new Set(data.friends || []);
    c.bonds = new Map(data.bonds || []);
    c.parentId = data.parentId || null;
    c.trust = data.trust ?? 0.3;
    c.fear = data.fear ?? 0;
    c.stress = data.stress ?? 0;
    c.attachment = data.attachment ?? 0;
    c.fatigue = data.fatigue ?? 0;
    c.restedness = data.restedness ?? 1;
    c.moodBaseline = data.moodBaseline ?? 50;
    c.homeX = data.homeX ?? c.x;
    c.homeY = data.homeY ?? c.y;
    c.homeStrength = data.homeStrength ?? 0;
    c.sleeping = data.sleeping ?? false;
    c.memories = data.memories ?? {
      goodSpots: [],
      badSpots: [],
      fedCount: 0,
      petCount: 0,
      droppedInDark: 0,
      lastFedTime: 0,
      lastPetTime: 0,
    };
    c.comforted = data.comforted ?? 0;
    c.lonely = data.lonely ?? 0;
    c.anticipation = data.anticipation ?? 0;
    c.vx = data.vx ?? (Math.random() - 0.5) * 0.5;
    c.vy = data.vy ?? (Math.random() - 0.5) * 0.5;
  }

  // ============================================================================
  // REVEAL MAP / FOG FUNCTIONS
  // ============================================================================

  function initializeFogWorkerIfNeeded(): void {
    if (fogWorkerInitialized) return;

    fogWorker.init(W, H, {
      revealRes: CONFIG.REVEAL_RES,
      revealDecay: CONFIG.REVEAL_DECAY,
    });

    fogWorker.onRevealMapReceived = (data: Float32Array) => {
      if (destroyed) return;
      if (revealMap && data.length === revealMap.length) {
        revealMap.set(data);
      }
    };

    fogWorkerInitialized = true;
  }

  function initRevealMap(syncWorker = true): void {
    revealW = Math.ceil(W / revealRes);
    revealH = Math.ceil(H / revealRes);
    revealMap = new Float32Array(revealW * revealH);
    lastRevealTime = new Float32Array(revealW * revealH);

    initializeFogWorkerIfNeeded();

    // Keep worker fog state in sync with the newly initialized world map.
    // Depth transitions/world resets should start with a fresh fog map.
    if (syncWorker && revealMap) {
      fogWorker.setRevealMap(revealMap);
    }

    workerFogDirty = true;
  }

  function resetFog(): void {
    // Clear main thread fog state
    if (revealMap) {
      revealMap.fill(0);
    }
    if (lastRevealTime) {
      lastRevealTime.fill(0);
    }
    fogDirty = true;

    // Clear worker fog state (queues if worker is not ready yet)
    if (revealMap) {
      fogWorker.setRevealMap(new Float32Array(revealMap.length));
      workerFogDirty = true;
    }
  }

  function drawFog(): void {
    // Worker-based rendering (preferred)
    if (fogWorker.isActive) {
      // Send entity data to worker
      const creatureData: FogCreatureData[] = creatures.map((c) => ({
        x: c.x,
        y: c.y,
        revealRadius: c.revealRadius,
        glow: c.glow,
        warmth: c.warmth,
      }));
      const monolithData: FogMonolithData[] = monoliths.map((m) => ({
        x: m.x,
        y: m.y,
        presence: m.presence,
      }));

      fogWorker.updateEntities(creatureData, monolithData);
      if (creatureData.length > 0 || monolithData.length > 0) {
        workerFogDirty = true;
      }

      if (workerFogDirty) {
        fogWorker.requestRender();
        workerFogDirty = false;
      }

      if (fogWorker.hasBitmap) {
        fogWorker.draw(ctx);
        return;
      }
    }

    // Canvas fallback
    if (!revealMap) return;

    if (!fogCanvas || fogCanvas.width !== W || fogCanvas.height !== H) {
      fogCanvas = document.createElement("canvas");
      fogCanvas.width = W;
      fogCanvas.height = H;
      fogCtx = fogCanvas.getContext("2d");
      if (fogCtx) {
        fogImageData = fogCtx.createImageData(W, H);
      }
      fogDirty = true;
    }

    if (fogDirty && fogImageData && fogCtx) {
      const data = fogImageData.data;
      const fogColor = { r: 10, g: 10, b: 10 };

      data.fill(0);

      for (let gy = 0; gy < revealH; gy++) {
        const py = gy * revealRes;
        const pyEnd = Math.min(py + revealRes, H);

        for (let gx = 0; gx < revealW; gx++) {
          const revealed = revealMap[gy * revealW + gx];
          if (revealed >= 0.98) continue;

          const darkness = (1 - revealed) * 0.95;
          if (darkness < 0.01) continue;

          const px = gx * revealRes;
          const pxEnd = Math.min(px + revealRes, W);

          const isEdge = darkness <= 0.05 || darkness >= 0.85;

          for (let y = py; y < pyEnd; y++) {
            const rowOffset = y * W * 4;
            for (let x = px; x < pxEnd; x++) {
              if (isEdge) {
                const bx = x & 3;
                const by = y & 3;
                const threshold = BAYER_4X4[by * 4 + bx];
                if (darkness < threshold) continue;
              }

              const i = rowOffset + x * 4;
              data[i] = fogColor.r;
              data[i + 1] = fogColor.g;
              data[i + 2] = fogColor.b;
              data[i + 3] = isEdge ? 242 : Math.floor(darkness * 255);
            }
          }
        }
      }

      fogCtx.putImageData(fogImageData, 0, 0);
      fogDirty = false;
    }

    if (fogCanvas) {
      ctx.drawImage(fogCanvas, 0, 0);
    }
  }

  function updateFogDecay(): void {
    if (!revealMap || !lastRevealTime) return;

    // Rapid fade to black when all creatures died (ignores worker, protection, linger)
    if (fadingToBlack) {
      const fadeRate = 0.025; // Fade to black over ~2 seconds (40 frames at decay every 3 frames)
      let anyChanged = false;
      for (let i = 0; i < revealMap.length; i++) {
        if (revealMap[i] > 0) {
          revealMap[i] = Math.max(0, revealMap[i] - fadeRate);
          anyChanged = true;
        }
      }
      if (anyChanged) {
        fogDirty = true;
        // Sync to worker so it renders the fade (queues until ready)
        fogWorker.setRevealMap(revealMap);
        workerFogDirty = true;
      }
      return;
    }

    // Worker handles decay internally
    if (fogWorker.isActive) {
      fogWorker.decay();
      workerFogDirty = true;
      return;
    }

    // Canvas fallback decay
    _protectedCells.clear();
    for (const c of creatures) {
      const cx = Math.floor(c.x / revealRes);
      const cy = Math.floor(c.y / revealRes);
      const r = Math.ceil(c.revealRadius / revealRes);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const gx = cx + dx;
          const gy = cy + dy;
          if (gx >= 0 && gx < revealW && gy >= 0 && gy < revealH) {
            _protectedCells.add(gy * revealW + gx);
          }
        }
      }
    }

    const revealResSq = revealRes * revealRes;
    for (const m of monoliths) {
      if (m.presence > 0.05) {
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
                _protectedCells.add(gy * revealW + gx);
              }
            }
          }
        }
      }
    }

    // Apply decay to cells not near entities AND not recently revealed
    const lingerThreshold = time - LINGER_DURATION;
    let anyChanged = false;
    for (let i = 0; i < revealMap.length; i++) {
      if (revealMap[i] > 0 && !_protectedCells.has(i)) {
        // Only decay if not recently revealed (outside linger duration)
        if (lastRevealTime[i] < lingerThreshold) {
          revealMap[i] = Math.max(0, revealMap[i] - CONFIG.REVEAL_DECAY * 3);
          anyChanged = true;
        }
      }
    }
    if (anyChanged) fogDirty = true;
  }

  function compressRevealMap(map: Float32Array): number[] {
    const result: number[] = [];
    let i = 0;
    while (i < map.length) {
      const val = Math.round(map[i] * 100) / 100;
      let count = 1;
      while (i + count < map.length && Math.round(map[i + count] * 100) / 100 === val && count < 255) {
        count++;
      }
      result.push(val, count);
      i += count;
    }
    return result;
  }

  function decompressRevealMap(compressed: number[], targetLength: number): Float32Array {
    const result = new Float32Array(targetLength);
    let idx = 0;
    for (let i = 0; i < compressed.length; i += 2) {
      const val = compressed[i];
      const count = compressed[i + 1];
      for (let j = 0; j < count && idx < targetLength; j++) {
        result[idx++] = val;
      }
    }
    return result;
  }

  // ============================================================================
  // SAVE / LOAD / RESET
  // ============================================================================

  function save(): void {
    const data: SaveData = {
      creatures: creatures.map((c) => serializeCreature(c)),
      revealMap: revealMap ? compressRevealMap(revealMap) : null,
      revealDims: revealMap ? { w: revealW, h: revealH } : null,
    };

    const doSave = () => {
      try {
        localStorage.setItem("void404_save", JSON.stringify(data));
      } catch {
        // Storage quota exceeded - silently fail
      }
    };

    if (typeof requestIdleCallback !== "undefined") {
      if (pendingIdleSave !== null && typeof cancelIdleCallback !== "undefined") {
        cancelIdleCallback(pendingIdleSave);
        pendingIdleSave = null;
      }

      pendingIdleSave = requestIdleCallback(() => {
        pendingIdleSave = null;
        if (destroyed) return;
        doSave();
      }, { timeout: 1000 });
    } else {
      scheduleTimeout(doSave, 0);
    }
  }

  function load(): boolean {
    try {
      const saved = localStorage.getItem("void404_save");
      if (!saved) return false;
      const data = JSON.parse(saved) as SaveData;

      for (const c of data.creatures) {
        const creature = new Creature(c.x, c.y);
        deserializeCreature(creature, c);
        creatures.push(creature);
      }

      const creatureIds = new Set(creatures.map((c) => c.id));
      for (const creature of creatures) {
        creature._claimedFood = null;
        for (const friendId of creature.friends) {
          if (!creatureIds.has(friendId)) {
            creature.friends.delete(friendId);
          }
        }
        for (const bondId of creature.bonds.keys()) {
          if (!creatureIds.has(bondId)) {
            creature.bonds.delete(bondId);
          }
        }
      }

      if (currentDepth === 0 && data.revealMap) {
        if (data.revealDims && data.revealDims.w === revealW && data.revealDims.h === revealH) {
          revealMap = decompressRevealMap(data.revealMap, revealW * revealH);
        } else if (Array.isArray(data.revealMap) && data.revealMap.length === revealW * revealH) {
          revealMap = new Float32Array(data.revealMap);
        }
        // Sync loaded reveal map to worker (queues until ready)
        if (revealMap) {
          fogWorker.setRevealMap(revealMap);
        }
        fogCanvas = null;
        fogDirty = true;
      }
      return creatures.length > 0;
    } catch {
      return false;
    }
  }

  function reset(): void {
    try {
      localStorage.removeItem("void404_save");
    } catch {
      // Storage unavailable
    }
    window.location.href = getBasePath();
  }

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  function showToast(text: string): void {
    if (destroyed) return;
    toast.textContent = text;
    toast.classList.add("show");
    scheduleTimeout(() => {
      toast.classList.remove("show");
    }, 2000);
  }

  function getCreatureAt(x: number, y: number, extraPadding = 0): Creature | null {
    let hit: Creature | null = null;
    let hitIndex = -1;

    for (let i = 0; i < creatures.length; i++) {
      const c = creatures[i];
      const d = Math.hypot(c.x - x, c.y - y);
      if (d >= c.displaySize + 8 + extraPadding) continue;

      if (!hit || c.y > hit.y || (c.y === hit.y && i > hitIndex)) {
        hit = c;
        hitIndex = i;
      }
    }

    return hit;
  }

  function createRipple(x: number, y: number): void {
    for (let i = 0; i < 8 && particles.length < CONFIG.MAX_PARTICLES; i++) {
      const p = new Particle(x, y, "ripple", 200);
      p.vx = DIRS_8[i].x * 1.5;
      p.vy = DIRS_8[i].y * 1.5;
      particles.push(p);
    }

    const radius = 60;

    // Use worker for reveal if active
    if (fogWorker.isActive) {
      fogWorker.addRevealPoints([{ x, y, radius, intensity: 0.15 }]);
      workerFogDirty = true;
    } else if (revealMap) {
      // Fallback: direct reveal map manipulation
      const cx = Math.floor(x / revealRes);
      const cy = Math.floor(y / revealRes);
      const r = Math.ceil(radius / revealRes);
      const radiusSq = radius * radius;
      const revealResSq = revealRes * revealRes;
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
            const intensity = (1 - d * invRadius) * 0.15;
            revealMap[idx] = Math.min(1, revealMap[idx] + intensity);
          }
        }
      }
      fogDirty = true;
    }

    for (const c of creatures) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < 100) {
        const proximity = 1 - d * 0.01;

        const startleChance = (1 - c.stability) * proximity;
        if (Math.random() < startleChance) {
          c.expression = "surprised";
          c.expressionTimer = 20 + Math.floor((1 - c.stability) * 25);
          c.fear = Math.min(1, c.fear + 0.05 * (1 - c.stability));
          if (emotes.length < CONFIG.MAX_EMOTES) {
            emotes.push(new Emote(c.x, c.y - c.displaySize, "!"));
          }
        }

        const curiosity = (c.openness * 0.6 + c.trust * 0.4) * (1 - c.fear);
        if (curiosity * proximity > 0.25) {
          c.wanderAngle = Math.atan2(y - c.y, x - c.x);
        }
      }
    }
  }

  // ============================================================================
  // GAME LOOP
  // ============================================================================

  function update(): void {
    if (destroyed) return;
    time++;

    if (mouse.down && !heldCreature) {
      mouse.holdTime++;
      if (mouse.holdTime % CONFIG.FOOD_DROP_INTERVAL === 0 && foods.length < CONFIG.MAX_FOODS) {
        let inHazard = false;
        for (const hole of holes) {
          if (dist(mouse.x, mouse.y, hole.x, hole.y) < hole.radius + 5) {
            inHazard = true;
            break;
          }
        }
        if (!inHazard) {
          for (const f of fissures) {
            if (f.checkCollision(mouse.x, mouse.y)) {
              inHazard = true;
              break;
            }
          }
        }
        if (!inHazard) {
          foods.push(new Food(mouse.x, mouse.y));
        }
      }
    }

    if (mouse.rightDown && rightClickTarget && !heldCreature) {
      if (rightClickTarget.isDead || !creatures.includes(rightClickTarget)) {
        rightClickTarget = null;
        tooltipCreature = null;
        pickupProgress = 0;
        mouse.rightHoldTime = 0;
      } else {
        mouse.rightHoldTime++;
        pickupProgress = Math.min(1, mouse.rightHoldTime / PICKUP_HOLD_TIME);

        if (mouse.rightHoldTime >= PICKUP_HOLD_TIME) {
          heldCreature = rightClickTarget;
          heldCreature.pickup();
          tooltipCreature = null;
          pickupProgress = 0;
        }
      }
    } else if (!mouse.rightDown) {
      pickupProgress = 0;
      mouse.rightHoldTime = 0;
    }

    _newCreatures.length = 0;
    for (let i = creatures.length - 1; i >= 0; i--) {
      const result = creatures[i].update();
      if (result === "die") {
        const deadCreature = creatures[i];
        // Release held creature if it died
        if (deadCreature === heldCreature) {
          heldCreature = null;
          tooltipCreature = null;
          pickupProgress = 0;
        }
        // Clear other references to dead creature
        if (deadCreature === rightClickTarget) {
          rightClickTarget = null;
        }
        if (deadCreature === touchCreature) {
          touchCreature = null;
        }
        if (deadCreature === tooltipCreature) {
          tooltipCreature = null;
        }
        creatures.splice(i, 1);
      } else if (result instanceof Creature) {
        _newCreatures.push(result);
      }
    }
    if (_newCreatures.length > 0) {
      creatures.push(..._newCreatures);
    }

    let activeCount = 0;
    for (let i = 0; i < foods.length; i++) {
      if (foods[i].update()) {
        foods[activeCount++] = foods[i];
      }
    }
    foods.length = activeCount;

    activeCount = 0;
    for (let i = 0; i < particles.length; i++) {
      if (particles[i].update()) {
        particles[activeCount++] = particles[i];
      }
    }
    particles.length = activeCount;

    activeCount = 0;
    for (let i = 0; i < emotes.length; i++) {
      if (emotes[i].update()) {
        emotes[activeCount++] = emotes[i];
      }
    }
    emotes.length = activeCount;

    for (const hole of holes) hole.update();
    for (const m of monoliths) m.update();
    for (const n of nests) n.update();

    if (creatures.length > 0) {
      const ecosystemFactor = 1 + creatures.length * 0.02;
      if (Math.random() < CONFIG.HOLE_SPAWN_CHANCE * ecosystemFactor) {
        spawnHole();
      }
    }

    if (currentDepth >= 2) {
      const fissureChance = 0.0003 * currentDepth;
      const maxFissures = Math.min(currentDepth + 2, 8);

      if (Math.random() < fissureChance && fissures.length < maxFissures) {
        let x: number, y: number, dir: number;

        const fromHole = holes.length > 0 && Math.random() < 0.4;

        if (fromHole) {
          const hole = holes[Math.floor(Math.random() * holes.length)];
          const angle = Math.random() * Math.PI * 2;
          const d = hole.radius + 15 + Math.random() * 30;
          x = hole.x + Math.cos(angle) * d;
          y = hole.y + Math.sin(angle) * d;
          dir = angle + (Math.random() - 0.5) * 1.2;
        } else {
          const edge = Math.floor(Math.random() * 4);
          if (edge === 0) { x = 0; y = Math.random() * H; dir = 0; }
          else if (edge === 1) { x = W; y = Math.random() * H; dir = Math.PI; }
          else if (edge === 2) { x = Math.random() * W; y = 0; dir = Math.PI / 2; }
          else { x = Math.random() * W; y = H; dir = -Math.PI / 2; }
          dir += (Math.random() - 0.5) * 0.8;
        }

        const depthScale = 1 + currentDepth * 0.12;
        const maxLength = (180 + Math.random() * 350) * depthScale;
        const width = (1.2 + Math.random() * 1.8) * (1 + currentDepth * 0.08);

        if (x >= 0 && x <= W && y >= 0 && y <= H) {
          fissures.push(new Fissure(x, y, dir, maxLength, width));
        }
      }
    }

    for (const f of fissures) {
      f.update();
    }

    if (creatures.length === 0 && !respawnPending) {
      respawnPending = true;
      fadingToBlack = true;
      scheduleTimeout(() => {
        if (creatures.length === 0) {
          resetFog();
          fadingToBlack = false;
          creatures.push(new Creature(W / 2, H * 0.28));
          showToast("another wanders in");
        }
        respawnPending = false;
      }, CONFIG.RESPAWN_DELAY);
    }

    // Fog decay - every 3 frames
    if (time % 3 === 0) {
      updateFogDecay();
    }

    // Sync worker's revealMap to main thread for getLightAt() - every 6 frames
    if (time % 6 === 0 && fogWorker.isActive) {
      fogWorker.requestRevealMap();
    }

    if (time % CONFIG.SAVE_INTERVAL === 0) save();

    updateUI();
  }

  function updateUI(): void {
    if (destroyed) return;

    const pop = creatures.length;

    document.title = pop === 0 ? "404 - Lost" : `404 - ${pop} Lost too`;

    const lingerFrames = 510;
    const fadeFrames = 120;
    const titleFade = time < lingerFrames ? 1 : Math.max(0, 1 - (time - lingerFrames) / fadeFrames);
    title.style.opacity = String(titleFade);

    const showCreature = tooltipCreature || heldCreature;

    if (showCreature && !showCreature.isDead) {
      const c = showCreature;
      tooltip.classList.add("visible");
      if (tooltipNameEl) tooltipNameEl.textContent = c.name;
      if (tooltipDetailsEl) tooltipDetailsEl.textContent = `gen ${c.generation} · ${formatAge(c.age)}`;

      const trustWord =
        c.trust > 0.8 ? "devoted" :
        c.trust > 0.6 ? "trusting" :
        c.trust > 0.4 ? "warming" :
        c.trust > 0.2 ? "wary" : "fearful";
      const visibleFear = Math.min(1, c.fear * (1.2 - c.stability * 0.4));
      const fearInfo = visibleFear > 0.35 ? " · scared!" : visibleFear > 0.2 ? " · nervous" : "";
      if (tooltipStatsEl) {
        tooltipStatsEl.innerHTML = `<span>energy ${Math.round(c.energy)}%</span><span>happy ${Math.round(c.happiness)}%</span><span>${trustWord}${fearInfo}</span>`;
      }
      if (tooltipPersonalityEl) tooltipPersonalityEl.textContent = getPersonalityDescription(c);

      const tooltipW = 140, tooltipH = 80;
      const tx = Math.min(W - tooltipW, Math.max(10, c.x + c.displaySize + 15));
      const ty = Math.min(H - tooltipH, Math.max(10, c.y - 40));
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";
    } else {
      tooltip.classList.remove("visible");
    }

    updatePickupRing();
  }

  function updatePickupRing(): void {
    if (destroyed || !pickupRingCtx) return;

    if (rightClickTarget && !rightClickTarget.isDead && pickupProgress > 0 && !heldCreature) {
      pickupRing.style.opacity = "1";
      pickupRing.style.left = rightClickTarget.x - 30 + "px";
      pickupRing.style.top = rightClickTarget.y - 30 + "px";

      pickupRingCtx.clearRect(0, 0, 60, 60);
      pickupRingCtx.strokeStyle = "rgba(255, 200, 150, 0.6)";
      pickupRingCtx.lineWidth = 2;
      pickupRingCtx.beginPath();
      pickupRingCtx.arc(30, 30, 25, -Math.PI / 2, -Math.PI / 2 + pickupProgress * Math.PI * 2);
      pickupRingCtx.stroke();
    } else {
      pickupRing.style.opacity = "0";
    }
  }

  function draw(): void {
    if (destroyed) return;

    const depthDarkness = Math.min(1, currentDepth * 0.08);
    const baseR = Math.floor(10 * (1 - depthDarkness * 0.6));
    const baseG = Math.floor(10 * (1 - depthDarkness * 0.6));
    const baseB = Math.floor(10 * (1 - depthDarkness * 0.5));
    ctx.fillStyle = `rgb(${baseR}, ${baseG}, ${baseB})`;
    ctx.fillRect(0, 0, W, H);

    if (revealMap) {
      for (let gy = 0; gy < revealH; gy++) {
        for (let gx = 0; gx < revealW; gx++) {
          const idx = gy * revealW + gx;
          const r = revealMap[idx];
          if (r > 0.05) {
            ctx.fillStyle = `rgba(35, 35, 42, ${r * 0.55})`;
            ctx.fillRect(gx * revealRes, gy * revealRes, revealRes, revealRes);
          }
        }
      }
    }

    for (const feature of terrainFeatures) {
      if (feature.type === "glow" && feature.hue !== undefined) {
        const glow = ctx.createRadialGradient(feature.x, feature.y, 0, feature.x, feature.y, feature.radius);
        glow.addColorStop(0, `hsla(${feature.hue}, 40%, 30%, ${feature.intensity * 0.4})`);
        glow.addColorStop(0.5, `hsla(${feature.hue}, 30%, 20%, ${feature.intensity * 0.2})`);
        glow.addColorStop(1, "transparent");
        ctx.beginPath();
        ctx.arc(feature.x, feature.y, feature.radius, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      }
    }

    for (const f of fissures) f.draw();
    for (const hole of holes) hole.draw();
    for (const n of nests) n.draw();
    for (const m of monoliths) m.draw();
    for (const f of foods) f.draw();

    const renderCreatures = [...creatures].sort((a, b) => a.y - b.y);
    for (const c of renderCreatures) c.draw();

    for (const p of particles) p.draw();
    for (const e of emotes) e.draw();

    drawFog();

    for (const hole of holes) hole.drawThroughFog();
    for (const m of monoliths) m.drawThroughFog();
    for (const n of nests) n.drawThroughFog();

    if (mouse.down && mouse.holdTime > 0) {
      const pulse = Math.sin(time * 0.2) * 0.2 + 0.8;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, 6 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(150, 255, 150, ${0.12 * pulse})`;
      ctx.fill();
    }
  }

  let gameLoopId: number | null = null;

  function gameLoop(): void {
    if (destroyed) return;

    update();
    draw();
    gameLoopId = requestAnimationFrame(gameLoop);
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  function resize(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;

    const oldReveal = revealMap;
    const oldLastRevealTime = lastRevealTime;
    const oldW = revealW;
    const oldH = revealH;

    initRevealMap(false);
    fogWorker.resize(W, H);

    if (oldReveal && oldW && oldH && revealW && revealH && revealMap && lastRevealTime) {
      const scaleX = oldW / revealW;
      const scaleY = oldH / revealH;
      for (let gy = 0; gy < revealH; gy++) {
        for (let gx = 0; gx < revealW; gx++) {
          const ox = Math.floor(gx * scaleX);
          const oy = Math.floor(gy * scaleY);
          if (ox < oldW && oy < oldH) {
            const oldIdx = oy * oldW + ox;
            const newIdx = gy * revealW + gx;
            revealMap[newIdx] = oldReveal[oldIdx];
            if (oldLastRevealTime) {
              lastRevealTime[newIdx] = oldLastRevealTime[oldIdx];
            }
          }
        }
      }
      // Sync scaled reveal map to worker (queues until worker is ready)
      fogWorker.setRevealMap(revealMap);
      workerFogDirty = true;
    }

    fogDirty = true;
    fogCanvas = null;
  }

  // Register event handlers (use signal for cleanup)
  const signal = eventAbortController.signal;

  window.addEventListener("resize", resize, { signal });

  window.addEventListener("popstate", () => {
    const newDepth = parseDepthFromPath();
    if (newDepth !== currentDepth) {
      navigateToDepth(newDepth);
    }
  }, { signal });

  document.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }, { signal });

  document.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" || (e.target as HTMLElement).tagName === "A") return;

    mouse.x = e.clientX;
    mouse.y = e.clientY;

    const creature = getCreatureAt(mouse.x, mouse.y);

    if (e.button === 2) {
      e.preventDefault();
      mouse.rightDown = true;
      mouse.rightHoldTime = 0;

      if (creature) {
        if (tooltipCreature === creature) {
          tooltipCreature = null;
          rightClickTarget = null;
          return;
        }
        rightClickTarget = creature;
        tooltipCreature = creature;
      } else {
        rightClickTarget = null;
        tooltipCreature = null;
        createRipple(mouse.x, mouse.y);
      }
      return;
    }

    if (heldCreature) return;

    if (creature) {
      creature.pet(e.clientX, e.clientY);
      return;
    }

    for (const hole of holes) {
      if (hole.contains(mouse.x, mouse.y)) {
        descendIntoHole();
        return;
      }
    }

    mouse.down = true;
    mouse.holdTime = 0;

    if (foods.length < CONFIG.MAX_FOODS) {
      foods.push(new Food(mouse.x, mouse.y));
    }
  }, { signal });

  document.addEventListener("mouseup", (e) => {
    if (e.button === 0) {
      mouse.down = false;
      mouse.holdTime = 0;
    } else if (e.button === 2) {
      if (heldCreature) {
        heldCreature.putdown();
        heldCreature = null;
      }

      scheduleTimeout(() => {
        if (!mouse.rightDown && !heldCreature) {
          tooltipCreature = null;
        }
      }, CONFIG.TOOLTIP_DURATION);

      mouse.rightDown = false;
      mouse.rightHoldTime = 0;
      rightClickTarget = null;
      pickupProgress = 0;
    }
  }, { signal });

  // Touch handlers
  let touchStartTime = 0;
  const touchStartPos = { x: 0, y: 0 };

  document.addEventListener(
    "touchstart",
    (e) => {
      if ((e.target as HTMLElement).closest("#home, #btn-reset, #controls")) return;
      if (e.touches.length === 0) return;

      // Ignore multi-touch gestures to keep interactions deterministic.
      if (e.touches.length > 1) {
        mouse.down = false;
        mouse.rightDown = false;
        mouse.holdTime = 0;
        mouse.rightHoldTime = 0;
        mouse.tappedHole = null;
        tooltipCreature = null;
        rightClickTarget = null;
        touchCreature = null;
        pickupProgress = 0;
        return;
      }

      e.preventDefault();
      const touch = e.touches[0];
      mouse.x = touch.clientX;
      mouse.y = touch.clientY;
      touchStartPos.x = mouse.x;
      touchStartPos.y = mouse.y;
      touchStartTime = Date.now();

      touchCreature = getCreatureAt(mouse.x, mouse.y, 12);

      if (touchCreature) {
        tooltipCreature = touchCreature;
        rightClickTarget = touchCreature;
        mouse.rightDown = true;
        mouse.rightHoldTime = 0;
      } else {
        let tappedHole: Hole | null = null;
        for (const hole of holes) {
          if (hole.contains(mouse.x, mouse.y)) {
            tappedHole = hole;
            break;
          }
        }

        if (tappedHole) {
          mouse.tappedHole = tappedHole;
        } else {
          mouse.down = true;
          mouse.holdTime = 0;
          if (foods.length < CONFIG.MAX_FOODS) {
            foods.push(new Food(mouse.x, mouse.y));
          }
        }
      }
    },
    { passive: false, signal }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 0) return;

      const touch = e.touches[0];
      mouse.x = touch.clientX;
      mouse.y = touch.clientY;

      if (mouse.tappedHole) {
        const d = Math.hypot(mouse.x - touchStartPos.x, mouse.y - touchStartPos.y);
        if (d > 40) {
          mouse.tappedHole = null;
        }
      }

      if (touchCreature && !heldCreature && mouse.rightDown) {
        const d = Math.hypot(mouse.x - touchStartPos.x, mouse.y - touchStartPos.y);
        // Use larger threshold (60px) to allow some finger drift during pickup hold
        if (d > 60) {
          pickupProgress = 0;
          mouse.rightHoldTime = 0;
          mouse.rightDown = false;
          tooltipCreature = null;
          rightClickTarget = null;
          touchCreature = null;
        }
      }
    },
    { passive: false, signal }
  );

  document.addEventListener("touchend", () => {
    const holdDuration = Date.now() - touchStartTime;
    const touched = touchCreature;

    if (touched && !touched.isDead && !heldCreature) {
      if (holdDuration < 200) {
        touched.pet(touchStartPos.x, touchStartPos.y);
        tooltipCreature = null;
      } else {
        scheduleTimeout(() => {
          if (tooltipCreature === touched) {
            tooltipCreature = null;
          }
        }, CONFIG.TOOLTIP_DURATION);
      }
    } else if (mouse.tappedHole && holdDuration < 300) {
      const tapDist = Math.hypot(mouse.x - touchStartPos.x, mouse.y - touchStartPos.y);
      if (tapDist < 40) {
        descendIntoHole();
      }
    }

    if (heldCreature) {
      heldCreature.putdown();
      heldCreature = null;
    }

    mouse.down = false;
    mouse.rightDown = false;
    mouse.holdTime = 0;
    mouse.rightHoldTime = 0;
    pickupProgress = 0;
    rightClickTarget = null;
    touchCreature = null;
    mouse.tappedHole = null;
  }, { signal });

  document.addEventListener("touchcancel", () => {
    if (heldCreature) {
      heldCreature.putdown();
      heldCreature = null;
    }
    mouse.down = false;
    mouse.rightDown = false;
    mouse.holdTime = 0;
    mouse.rightHoldTime = 0;
    pickupProgress = 0;
    rightClickTarget = null;
    touchCreature = null;
    mouse.tappedHole = null;
  }, { signal });

  homeBtn.addEventListener("click", () => {
    window.location.href = "/";
  }, { signal });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      window.location.href = "/";
    }
  }, { signal });

  resetBtn.addEventListener("click", () => {
    if (confirm("Start over? All your little guys will be gone.")) {
      reset();
    }
  }, { signal });

  document.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      fogCanvas = null;
      fogDirty = true;
    }
  }, { signal });

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  resize();

  fogCanvas = null;
  fogDirty = true;

  lostPath.textContent = `404 - /${lostPathStr} - page not found`;

  const isReturning = load();
  if (isReturning) {
    titleSub.textContent = "There you are.";
  } else {
    titleSub.textContent = "Are you supposed to be here?";
    creatures.push(new Creature(W / 2, H * 0.28));
  }

  if (currentDepth > 0 && terrainFeatures.length === 0) {
    generateTerrain(currentDepth, pathSeed + currentDepth * 12345);
  } else if (holes.length === 0) {
    initWorldRandom(pathSeed);
  }

  if (holes.length === 0) {
    spawnHole(true, true);
  }

  if (monoliths.length === 0) {
    spawnStructures(true);
  }

  const handleBeforeUnload = (): void => {
    cleanup();
  };
  const handlePageHide = (): void => {
    cleanup();
  };

  // Cleanup function
  function cleanup(): void {
    if (destroyed) return;
    destroyed = true;

    eventAbortController.abort();
    window.removeEventListener("beforeunload", handleBeforeUnload);
    window.removeEventListener("pagehide", handlePageHide);
    clearPendingAsyncTasks();

    if (gameLoopId !== null) {
      cancelAnimationFrame(gameLoopId);
      gameLoopId = null;
    }

    fogWorker.onRevealMapReceived = null;
    fogWorker.destroy();

    if (activeVoidGameCleanup === cleanup) {
      activeVoidGameCleanup = null;
    }
  }

  // No signal - these trigger cleanup which calls abort()
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("pagehide", handlePageHide);

  activeVoidGameCleanup = cleanup;
  gameLoop();

  return cleanup;
}
