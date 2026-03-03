/**
 * PictoCanvas — vector drawing surface for Whisper Live.
 *
 * Standalone module: blank canvas doodles + annotation over images/video frames.
 * Zero smoothing, immediate response, raw pointer fidelity.
 * PictoChat feel: fill, eyedropper, custom colors, pinch-to-zoom, multi-touch gestures.
 */

import { createStrokeSampler, sampleStrokePoint, type StrokeSamplerState } from "./live-draw-stroke";
import { type DrawStreamEventNoSeq, type DrawTool } from "./live-draw-stream";
import { GlyphStreamEncoder } from "./live-wasm-glyph";

/* ── Types ────────────────────────────────────────────────── */

export interface DrawConfig {
  mode: "blank" | "annotate";
  mediaEl?: HTMLImageElement | HTMLVideoElement;
  /** Original filename when annotating — used for output naming + format matching. */
  originalName?: string;
  signal: AbortSignal;
}

export interface DrawCallbacks {
  onSend: (result: { file: File }) => void;
  onEvent?: (event: DrawStreamEventNoSeq) => void;
  onClose: () => void;
}

interface Point { x: number; y: number; p: number }

interface PenStroke { type: "pen"; points: Point[]; color: string; width: number; penId: string; }
interface FillStroke { type: "fill"; seedX: number; seedY: number; color: string; tolerance: number; }
type StrokeEntry = PenStroke | FillStroke;

type ToolId = "pen" | "eraser" | "fill" | "eyedropper";

interface PenType {
  id: string;
  render(ctx: CanvasRenderingContext2D, prev: Point, cur: Point, opts: PenOpts): void;
  composite(isBlank: boolean): GlobalCompositeOperation;
  pressureSensitive: boolean;
  widthScale: number;
}

interface PenOpts {
  color: string;
  baseWidth: number;
  pressure: number;
  pattern?: CanvasPattern;
}

/* ── Pen types ────────────────────────────────────────────── */

const BLANK_BG = "#1a1a1a";

function renderRoundSeg(ctx: CanvasRenderingContext2D, prev: Point, cur: Point, opts: PenOpts, pressureSens: boolean, pattern?: CanvasPattern): void {
  const w = pressureSens ? opts.baseWidth * (0.3 + opts.pressure * 0.7) : opts.baseWidth;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = pattern ?? opts.color;
  ctx.beginPath();
  ctx.moveTo(prev.x, prev.y);
  ctx.lineTo(cur.x, cur.y);
  ctx.stroke();
}

function renderRoundQuadSeg(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  ctrlX: number,
  ctrlY: number,
  toX: number,
  toY: number,
  baseWidth: number,
  pressure: number,
  pressureSens: boolean,
): void {
  const w = pressureSens ? baseWidth * (0.3 + pressure * 0.7) : baseWidth;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.quadraticCurveTo(ctrlX, ctrlY, toX, toY);
  ctx.stroke();
}

const PEN_TYPES: Map<string, PenType> = new Map([
  ["pen", {
    id: "pen",
    render(ctx, prev, cur, opts) { renderRoundSeg(ctx, prev, cur, opts, true); },
    composite(_isBlank) { return "source-over"; },
    pressureSensitive: true,
    widthScale: 1,
  }],
  ["eraser", {
    id: "eraser",
    render(ctx, prev, cur, opts) { renderRoundSeg(ctx, prev, cur, opts, false, opts.pattern); },
    composite(_isBlank) { return "source-over"; },
    pressureSensitive: false,
    widthScale: 2,
  }],
]);

/* ── Color palette ────────────────────────────────────────── */

const PALETTE = [
  "#f5f5f5",   // off-white
  "#00c8ff",   // cyan
  "#7329e0",   // purple
  "#ff4466",   // red-pink
  "#ffcc00",   // gold
];

/* ── Dynamic cursor ───────────────────────────────────────── */

function buildCursor(canvas: HTMLCanvasElement, color: string, size: number, isEraser = false): void {
  const r = Math.max(3, size / 2);
  const d = (r + 2) * 2;
  const c = r + 2;
  const svg = isEraser
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}" opacity="0.6"/></svg>`;
  canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
}

/* ── Checkpoint engine ────────────────────────────────────── */

const CHECKPOINT_EVERY = 20;
const CHECKPOINT_MAX_BYTES = 48 * 1024 * 1024;
const CHECKPOINT_MAX_COUNT = 8;
const NAV_MOUSE_DEDUPE_MS = 40;
const TAP_MOVE_THRESHOLD_SQ = 100;
const DOUBLE_TAP_RADIUS_SQ = 900;
const MULTI_TAP_WINDOW_MS = 300;
const MULTI_TAP_SYNC_MS = 150;
const DRAW_HINT_ONBOARD_MS = 2200;
const DRAW_HINT_SHORT_MS = 1400;
const SWATCH_DRAG_CANCEL_LONGPRESS_SQ = 64;
const SWATCH_DRAG_FULL_RANGE_PX = 180;
const SWATCH_DRAG_MAX_DELTA = 0.95;

let drawHintShown = false;

let drawBodyLockDepth = 0;
let drawBodyLockSnapshot: {
  overflow: string;
  overscrollBehavior: string;
  touchAction: string;
} | null = null;

function lockDrawBodyScroll(): void {
  if (drawBodyLockDepth === 0) {
    drawBodyLockSnapshot = {
      overflow: document.body.style.overflow,
      overscrollBehavior: document.body.style.overscrollBehavior,
      touchAction: document.body.style.touchAction,
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.touchAction = "none";
  }
  drawBodyLockDepth++;
}

function unlockDrawBodyScroll(): void {
  if (drawBodyLockDepth <= 0) return;
  drawBodyLockDepth--;
  if (drawBodyLockDepth > 0) return;
  if (!drawBodyLockSnapshot) return;
  document.body.style.overflow = drawBodyLockSnapshot.overflow;
  document.body.style.overscrollBehavior = drawBodyLockSnapshot.overscrollBehavior;
  document.body.style.touchAction = drawBodyLockSnapshot.touchAction;
  drawBodyLockSnapshot = null;
}

function hexToRgb01(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function rgb01ToHex(r: number, g: number, b: number): string {
  const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  const rr = toByte(r).toString(16).padStart(2, "0");
  const gg = toByte(g).toString(16).padStart(2, "0");
  const bb = toByte(b).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-8) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max <= 1e-8 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 1) + 1) % 1;
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

function hexToHsv(hex: string): [number, number, number] | null {
  const rgb = hexToRgb01(hex);
  if (!rgb) return null;
  return rgbToHsv(rgb[0], rgb[1], rgb[2]);
}

function hsvToHex(h: number, s: number, v: number): string {
  const rgb = hsvToRgb(h, s, v);
  return rgb01ToHex(rgb[0], rgb[1], rgb[2]);
}

/* ── SVG icon helpers ─────────────────────────────────────── */

const ICO_ERASER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 14h7M6 11.5L2.5 8a1.4 1.4 0 010-2l5-5a1.4 1.4 0 012 0L13 4.5a1.4 1.4 0 010 2L9 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11.5l-3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

const ICO_UNDO = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6h7a3 3 0 010 6H8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 3L3 6l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICO_REDO = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13 6H6a3 3 0 000 6h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 3l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICO_PLUS = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

/* ── Main entry ───────────────────────────────────────────── */

export function openDrawSurface(config: DrawConfig, callbacks: DrawCallbacks): void {
  const drawAc = new AbortController();
  const ds = drawAc.signal;
  let closed = false;

  config.signal.addEventListener("abort", () => drawAc.abort(), { signal: ds });

  const isBlank = config.mode === "blank";

  /* ── DOM ───────────────────────────────────────────────── */

  const overlay = document.createElement("div");
  overlay.className = "wl-draw";
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const previouslyFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  previouslyFocused?.blur();
  lockDrawBodyScroll();

  const teardownDraw = (): void => {
    if (closed) return;
    closed = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (closeConfirmTimer) {
      clearTimeout(closeConfirmTimer);
      closeConfirmTimer = null;
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    pointerPressureCache.clear();
    activePenPointerId = -1;
    unlockDrawBodyScroll();
    overlay.classList.remove("--open");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 350);
    strokes = [];
    redoStack = [];
    checkpoints = [];
    if (previouslyFocused && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
    callbacks.onClose();
  };

  ds.addEventListener("abort", teardownDraw, { once: true });

  const canvas = document.createElement("canvas");
  canvas.className = "wl-draw-canvas";
  canvas.style.touchAction = "none";
  canvas.draggable = false;

  const toolbar = document.createElement("div");
  toolbar.className = "wl-draw-toolbar";

  const hint = document.createElement("div");
  hint.className = "wl-draw-hint";
  hint.setAttribute("aria-live", "polite");
  hint.setAttribute("aria-atomic", "true");

  // Color buttons
  const colorBtns: HTMLButtonElement[] = PALETTE.map((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wl-draw-color";
    b.dataset.color = c;
    b.style.background = c;
    b.title = `color ${i + 1} (drag to tune)`;
    b.setAttribute("aria-label", `Color ${i + 1}`);
    return b;
  });

  // Custom color "+" button (long-press = eyedropper)
  const customColorBtn = document.createElement("button");
  customColorBtn.type = "button";
  customColorBtn.className = "wl-draw-color wl-draw-color-custom";
  customColorBtn.title = "custom color (6, drag to tune)";
  customColorBtn.setAttribute("aria-label", "Custom color");
  customColorBtn.innerHTML = ICO_PLUS;

  // Hidden color input
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#ff8800";
  colorInput.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0;pointer-events:none";

  // Tool button helper
  function makeToolBtn(cls: string, title: string, ico: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.title = title;
    b.innerHTML = ico;
    return b;
  }

  const eraserBtn = makeToolBtn("wl-draw-tool", "eraser (e)", ICO_ERASER);
  eraserBtn.setAttribute("aria-label", "Eraser");
  eraserBtn.setAttribute("aria-pressed", "false");

  // Undo / Redo — joint pill button
  const undoRedoGroup = document.createElement("div");
  undoRedoGroup.className = "wl-draw-undoredo";
  const undoBtn = makeToolBtn("wl-draw-undo", "undo (ctrl+z)", ICO_UNDO);
  undoBtn.setAttribute("aria-label", "Undo");
  undoBtn.disabled = true;
  const redoBtn = makeToolBtn("wl-draw-redo", "redo (ctrl+shift+z)", ICO_REDO);
  redoBtn.setAttribute("aria-label", "Redo");
  redoBtn.disabled = true;
  undoRedoGroup.append(undoBtn, redoBtn);

  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "wl-draw-send";
  sendBtn.textContent = "Send";
  sendBtn.setAttribute("aria-label", "Send drawing");
  sendBtn.disabled = true;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "wl-draw-close";
  closeBtn.title = "close (esc)";
  closeBtn.setAttribute("aria-label", "Close drawing");
  closeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4L14 14M14 4L4 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  const touchToggleBtn = document.createElement("button");
  touchToggleBtn.type = "button";
  touchToggleBtn.className = "wl-draw-touch-toggle";
  touchToggleBtn.hidden = true;
  touchToggleBtn.textContent = "Touch draw: on";
  touchToggleBtn.setAttribute("aria-pressed", "false");
  touchToggleBtn.setAttribute("aria-label", "Touch draw on");
  touchToggleBtn.title = "Touch draw on";

  // Flat toolbar — no separators, no groups. Gap handles spacing.
  // Fill tool hidden from toolbar (keyboard B only) — icon is not self-explanatory.
  toolbar.append(...colorBtns, customColorBtn, eraserBtn, undoRedoGroup, sendBtn);
  overlay.append(canvas, toolbar, hint, closeBtn, touchToggleBtn, colorInput);

  /* ── Canvas setup ──────────────────────────────────────── */

  const dpr = window.devicePixelRatio || 1;
  let logicalW: number;
  let logicalH: number;

  if (isBlank) {
    const maxW = window.innerWidth - 48;
    const maxH = window.innerHeight - 140;
    if (maxW / maxH > 4 / 3) {
      logicalH = Math.min(maxH, 800);
      logicalW = Math.round(logicalH * 4 / 3);
    } else {
      logicalW = Math.min(maxW, 1066);
      logicalH = Math.round(logicalW * 3 / 4);
    }
  } else {
    const media = config.mediaEl!;
    const natW = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const natH = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    const aspect = natW / natH || 4 / 3;
    const maxW = window.innerWidth - 48;
    const maxH = window.innerHeight - 140;
    if (maxW / maxH > aspect) {
      logicalH = Math.min(maxH, natH, 900);
      logicalW = Math.round(logicalH * aspect);
    } else {
      logicalW = Math.min(maxW, natW, 1200);
      logicalH = Math.round(logicalW / aspect);
    }
  }

  canvas.width = logicalW * dpr;
  canvas.height = logicalH * dpr;
  canvas.style.width = `${logicalW}px`;
  canvas.style.height = `${logicalH}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);

  if (isBlank) {
    ctx.fillStyle = BLANK_BG;
    ctx.fillRect(0, 0, logicalW, logicalH);
  } else {
    ctx.drawImage(config.mediaEl!, 0, 0, logicalW, logicalH);
  }

  const backgroundSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Background pattern for annotation eraser — paints original image pixels
  let bgPattern: CanvasPattern | null = null;
  if (!isBlank) {
    const patCvs = document.createElement("canvas");
    patCvs.width = canvas.width;
    patCvs.height = canvas.height;
    patCvs.getContext("2d")!.putImageData(backgroundSnapshot, 0, 0);
    bgPattern = ctx.createPattern(patCvs, "no-repeat");
    // Pattern source is at dpr-scaled px, but ctx has scale(dpr). Compensate.
    if (bgPattern) bgPattern.setTransform(new DOMMatrix().scaleSelf(1 / dpr, 1 / dpr));
  }

  /* ── State ─────────────────────────────────────────────── */

  let nextStrokeId = 0;
  let strokes: StrokeEntry[] = [];
  let redoStack: StrokeEntry[] = [];
  let checkpoints: { data: ImageData; idx: number }[] = [];
  const paletteColors = PALETTE.slice();

  let currentColor = PALETTE[0];
  let activePaletteIdx = 0;
  let activeCustomColor = false;
  let currentTool: ToolId = "pen";
  let customColor: string | null = null;
  let baseWidth = 3;

  let activePointerId = -1;
  let currentStroke: PenStroke | null = null;
  let lastPoint: Point | null = null;
  let lastRenderMidX = 0;
  let lastRenderMidY = 0;
  let hasLastRenderMid = false;
  let strokeSampler: StrokeSamplerState | null = null;
  let strokeEncoder: GlyphStreamEncoder | null = null;

  // rAF batching
  let pendingPoints: Point[] = [];
  let rafId = 0;

  // Zoom/pan state
  let viewZoom = 1, viewPanX = 0, viewPanY = 0;

  // Multi-pointer tracking
  const pointers = new Map<number, { x: number; y: number }>();
  const pointerPressureCache = new Map<number, number>();
  let activePenPointerId = -1;
  let penSeen = false;
  let touchDrawEnabled = true;

  // Gesture state
  let pinchActive = false;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchStartMidX = 0;
  let pinchStartMidY = 0;
  let pinchStartPanX = 0;
  let pinchStartPanY = 0;

  // Finger tap tracking
  interface FingerTap { id: number; startX: number; startY: number; startTime: number; moved: boolean }
  let fingerTaps: FingerTap[] = [];

  // Double-tap tracking
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let closeConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressSwatchClickUntil = 0;
  let colorDragPointerId = -1;
  let colorDragBtn: HTMLButtonElement | null = null;
  let colorDragPaletteIdx = -1;
  let colorDragIsCustom = false;
  let colorDragStartX = 0;
  let colorDragStartY = 0;
  let colorDragStartS = 0;
  let colorDragStartV = 0;
  let colorDragHue = 0;
  let colorDragMoved = false;
  let fillVisited: Uint8Array | null = null;
  let fillStack: Int32Array | null = null;

  /* ── Coordinate transform ──────────────────────────────── */

  function screenToCanvasWithOrigin(clientX: number, clientY: number, left: number, top: number): [number, number] {
    return [(clientX - left) / viewZoom, (clientY - top) / viewZoom];
  }

  function screenToCanvas(clientX: number, clientY: number): [number, number] {
    const rect = canvas.getBoundingClientRect();
    return screenToCanvasWithOrigin(clientX, clientY, rect.left, rect.top);
  }

  function applyTransform(): void {
    canvas.style.transform = `translate(${viewPanX}px, ${viewPanY}px) scale(${viewZoom})`;
    canvas.style.transformOrigin = "0 0";
  }

  function eventTs(e: { timeStamp: number }): number {
    return e.timeStamp || performance.now();
  }

  function getFirstTwoPointers(): [{ x: number; y: number }, { x: number; y: number }] | null {
    if (pointers.size < 2) return null;
    const it = pointers.values();
    const first = it.next().value;
    const second = it.next().value;
    if (!first || !second) return null;
    return [first, second];
  }

  function clampPan(): void {
    const minVisX = logicalW * viewZoom * -0.75;
    const maxVisX = logicalW * viewZoom * 0.75;
    const minVisY = logicalH * viewZoom * -0.75;
    const maxVisY = logicalH * viewZoom * 0.75;
    viewPanX = Math.max(minVisX, Math.min(maxVisX, viewPanX));
    viewPanY = Math.max(minVisY, Math.min(maxVisY, viewPanY));
  }

  function isPenEraserContact(e: PointerEvent): boolean {
    return e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
  }

  function normalizePressure(e: PointerEvent, pointerId: number): number {
    if (e.pointerType === "mouse") return 0.5;
    if (e.pointerType === "pen") {
      if (e.pressure > 0) {
        const curved = Math.pow(Math.max(0, Math.min(1, e.pressure)), 0.9);
        pointerPressureCache.set(pointerId, curved);
        return curved;
      }
      if (e.buttons !== 0) {
        const cached = pointerPressureCache.get(pointerId);
        return cached ?? 0.35;
      }
      return 0;
    }
    if (e.pressure > 0) return Math.max(0, Math.min(1, e.pressure));
    return 0.5;
  }

  /* ── Unified toolbar update ────────────────────────────── */

  function updateToolbar(): void {
    undoBtn.disabled = strokes.length === 0;
    redoBtn.disabled = redoStack.length === 0;
    sendBtn.disabled = strokes.length === 0;

    eraserBtn.classList.toggle("--active", currentTool === "eraser");
    eraserBtn.setAttribute("aria-pressed", currentTool === "eraser" ? "true" : "false");

    colorBtns.forEach((b, i) => b.classList.toggle("--active", !activeCustomColor && i === activePaletteIdx && currentTool !== "eraser"));
    colorBtns.forEach((b, i) => b.setAttribute("aria-pressed", !activeCustomColor && i === activePaletteIdx && currentTool !== "eraser" ? "true" : "false"));
    customColorBtn.classList.toggle("--active", activeCustomColor && currentTool !== "eraser");
    customColorBtn.setAttribute("aria-pressed", activeCustomColor && currentTool !== "eraser" ? "true" : "false");

    if (currentTool === "fill" || currentTool === "eyedropper") {
      canvas.style.cursor = "crosshair";
    } else {
      const isEraserTool = currentTool === "eraser";
      const penType = isEraserTool ? "eraser" : "pen";
      const pen = PEN_TYPES.get(penType)!;
      const col = isEraserTool && isBlank ? BLANK_BG : currentColor;
      buildCursor(canvas, col, baseWidth * pen.widthScale, isEraserTool);
    }
  }

  colorBtns.forEach((b, i) => updateSwatchVisualState(b, paletteColors[i]));
  updateSwatchVisualState(customColorBtn, null);
  updateToolbar();
  colorBtns[0].classList.add("--active");

  function currentPenStyle(): { penId: "pen" | "eraser"; color: string; width: number } | null {
    if (currentTool === "fill" || currentTool === "eyedropper") return null;
    const penId: "pen" | "eraser" = currentTool === "eraser" ? "eraser" : "pen";
    const pen = PEN_TYPES.get(penId);
    if (!pen) return null;
    return {
      penId,
      color: currentColor,
      width: baseWidth * pen.widthScale,
    };
  }

  function maybeSplitActiveStrokeForStyleChange(): void {
    if (activePointerId === -1 || !currentStroke || !lastPoint) return;
    const style = currentPenStyle();
    if (!style) return;
    if (
      currentStroke.penId === style.penId &&
      currentStroke.color === style.color &&
      Math.abs(currentStroke.width - style.width) < 0.001
    ) return;

    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    flushPoints();
    finalizeCurrentStrokeTail();
    if (currentStroke.points.length > 0) commitStroke(currentStroke);

    currentStroke = {
      type: "pen",
      points: [{ x: lastPoint.x, y: lastPoint.y, p: lastPoint.p }],
      color: style.color,
      width: style.width,
      penId: style.penId,
    };
    hasLastRenderMid = false;
    pendingPoints.length = 0;
  }

  function setTool(tool: ToolId): void {
    const nextTool = tool;
    const enteringNonStrokeTool = (nextTool === "fill" || nextTool === "eyedropper");
    if (enteringNonStrokeTool && activePointerId !== -1 && currentStroke) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushPoints();
      finalizeCurrentStrokeTail();
      if (currentStroke.points.length > 0) commitStroke(currentStroke);
      currentStroke = null;
      lastPoint = null;
      hasLastRenderMid = false;
      strokeSampler = null;
      pendingPoints.length = 0;
      activePointerId = -1;
    }
    currentTool = nextTool;
    updateToolbar();
    if (!enteringNonStrokeTool) maybeSplitActiveStrokeForStyleChange();
  }

  function showHint(text: string, durationMs = DRAW_HINT_SHORT_MS): void {
    if (!text) return;
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    hint.textContent = text;
    hint.classList.add("--show");
    hintTimer = setTimeout(() => {
      hint.classList.remove("--show");
      hintTimer = null;
    }, durationMs);
  }

  function syncTouchToggleUi(): void {
    touchToggleBtn.textContent = touchDrawEnabled ? "Touch draw: on" : "Touch draw: off";
    touchToggleBtn.setAttribute("aria-pressed", touchDrawEnabled ? "false" : "true");
    touchToggleBtn.setAttribute("aria-label", touchDrawEnabled ? "Touch draw on" : "Touch draw off");
    touchToggleBtn.title = touchDrawEnabled ? "Touch draw on" : "Touch draw off";
    touchToggleBtn.classList.toggle("--off", !touchDrawEnabled);
  }

  function setBrushSize(size: number): void {
    baseWidth = size;
    updateToolbar();
    maybeSplitActiveStrokeForStyleChange();
  }

  function updateSwatchVisualState(btn: HTMLButtonElement, color: string | null): void {
    if (!color) {
      btn.classList.remove("--has-color");
      btn.style.removeProperty("--swatch-sheen-alpha");
      btn.style.removeProperty("--swatch-shade-alpha");
      btn.style.removeProperty("--swatch-ring-alpha");
      return;
    }
    const hsv = hexToHsv(color);
    if (!hsv) return;
    const s = hsv[1];
    const v = hsv[2];
    btn.classList.add("--has-color");
    btn.style.setProperty("--swatch-sheen-alpha", (0.04 + (1 - s) * 0.5).toFixed(3));
    btn.style.setProperty("--swatch-shade-alpha", ((1 - v) * 0.72).toFixed(3));
    btn.style.setProperty("--swatch-ring-alpha", (0.14 + (1 - v) * 0.34 + (1 - s) * 0.1).toFixed(3));
  }

  function applyPaletteColor(idx: number, color: string): void {
    paletteColors[idx] = color;
    colorBtns[idx].style.background = color;
    colorBtns[idx].dataset.color = color;
    updateSwatchVisualState(colorBtns[idx], color);
    currentColor = color;
    activePaletteIdx = idx;
    activeCustomColor = false;
    if (currentTool !== "pen") currentTool = "pen";
    updateToolbar();
    maybeSplitActiveStrokeForStyleChange();
  }

  function applyCustomColor(color: string): void {
    customColor = color;
    currentColor = color;
    activeCustomColor = true;
    customColorBtn.style.background = color;
    customColorBtn.dataset.color = color;
    updateSwatchVisualState(customColorBtn, color);
    customColorBtn.innerHTML = "";
    colorInput.value = color;
    if (currentTool !== "pen") currentTool = "pen";
    updateToolbar();
    maybeSplitActiveStrokeForStyleChange();
  }

  function selectPaletteColor(idx: number): void {
    applyPaletteColor(idx, paletteColors[idx]);
  }

  function shouldSuppressSwatchClick(): boolean {
    if (performance.now() < suppressSwatchClickUntil) return true;
    return false;
  }

  function shapedDragDelta(px: number): number {
    const scaled = px / SWATCH_DRAG_FULL_RANGE_PX;
    return Math.tanh(scaled) * SWATCH_DRAG_MAX_DELTA;
  }

  function beginSwatchColorDrag(e: PointerEvent, btn: HTMLButtonElement, paletteIdx: number | null): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const baseHex = paletteIdx !== null
      ? paletteColors[paletteIdx]
      : (customColor ?? colorInput.value ?? "#ff8800");
    const hsv = hexToHsv(baseHex);
    if (!hsv) return;
    colorDragPointerId = e.pointerId;
    colorDragBtn = btn;
    colorDragPaletteIdx = paletteIdx ?? -1;
    colorDragIsCustom = paletteIdx === null;
    colorDragStartX = e.clientX;
    colorDragStartY = e.clientY;
    colorDragHue = hsv[0];
    colorDragStartS = hsv[1];
    colorDragStartV = hsv[2];
    colorDragMoved = false;
    btn.classList.add("--dragging");
    try { btn.setPointerCapture(e.pointerId); } catch { /* noop */ }
  }

  function endSwatchColorDrag(e: PointerEvent): void {
    if (e.pointerId !== colorDragPointerId) return;
    if (colorDragBtn) colorDragBtn.classList.remove("--dragging");
    if (colorDragBtn && colorDragBtn.hasPointerCapture(e.pointerId)) {
      try { colorDragBtn.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }
    if (colorDragMoved) suppressSwatchClickUntil = performance.now() + 220;
    colorDragPointerId = -1;
    colorDragBtn = null;
    colorDragPaletteIdx = -1;
    colorDragIsCustom = false;
    colorDragMoved = false;
  }

  /* ── Render helpers ────────────────────────────────────── */

  function renderPenStroke(stroke: PenStroke): void {
    const pen = PEN_TYPES.get(stroke.penId);
    if (!pen) return;
    const isEraserStroke = stroke.penId === "eraser";
    const color = isEraserStroke ? BLANK_BG : stroke.color;
    const pat = isEraserStroke && bgPattern ? bgPattern : undefined;
    ctx.save();
    ctx.globalCompositeOperation = pen.composite(isBlank);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = pat ?? color;
    if (stroke.points.length === 1) {
      const pt = stroke.points[0];
      const cx = pt.x * logicalW;
      const cy = pt.y * logicalH;
      const w = pen.pressureSensitive ? stroke.width * (0.3 + pt.p * 0.7) : stroke.width;
      ctx.fillStyle = pat ?? color;
      ctx.beginPath();
      ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      let renderMidX = 0;
      let renderMidY = 0;
      let hasRenderMid = false;
      for (let i = 1; i < stroke.points.length; i++) {
        const prev = stroke.points[i - 1];
        const cur = stroke.points[i];
        const prevX = prev.x * logicalW;
        const prevY = prev.y * logicalH;
        const curX = cur.x * logicalW;
        const curY = cur.y * logicalH;
        const midX = (prevX + curX) * 0.5;
        const midY = (prevY + curY) * 0.5;
        const fromX = hasRenderMid ? renderMidX : prevX;
        const fromY = hasRenderMid ? renderMidY : prevY;
        renderRoundQuadSeg(
          ctx,
          fromX,
          fromY,
          prevX,
          prevY,
          midX,
          midY,
          stroke.width,
          cur.p,
          pen.pressureSensitive,
        );
        renderMidX = midX;
        renderMidY = midY;
        hasRenderMid = true;
      }
      const end = stroke.points[stroke.points.length - 1];
      if (hasRenderMid) {
        const endX = end.x * logicalW;
        const endY = end.y * logicalH;
        renderRoundQuadSeg(
          ctx,
          renderMidX,
          renderMidY,
          endX,
          endY,
          endX,
          endY,
          stroke.width,
          end.p,
          pen.pressureSensitive,
        );
      }
    }
    ctx.restore();
  }

  function finalizeCurrentStrokeTail(): void {
    if (!currentStroke || !lastPoint || !hasLastRenderMid) return;
    const pen = PEN_TYPES.get(currentStroke.penId);
    if (!pen) return;
    const isEraserStroke = currentStroke.penId === "eraser";
    const color = isEraserStroke ? BLANK_BG : currentStroke.color;
    const pat = isEraserStroke && bgPattern ? bgPattern : undefined;

    ctx.save();
    ctx.globalCompositeOperation = pen.composite(isBlank);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = pat ?? color;
    renderRoundQuadSeg(
      ctx,
      lastRenderMidX * logicalW,
      lastRenderMidY * logicalH,
      lastPoint.x * logicalW,
      lastPoint.y * logicalH,
      lastPoint.x * logicalW,
      lastPoint.y * logicalH,
      currentStroke.width,
      lastPoint.p,
      pen.pressureSensitive,
    );
    ctx.restore();
    hasLastRenderMid = false;
  }

  function executeFill(stroke: FillStroke): void {
    const w = canvas.width;
    const h = canvas.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const pixelCount = w * h;

    const fillR = parseInt(stroke.color.slice(1, 3), 16);
    const fillG = parseInt(stroke.color.slice(3, 5), 16);
    const fillB = parseInt(stroke.color.slice(5, 7), 16);

    const sx = Math.round(stroke.seedX * dpr);
    const sy = Math.round(stroke.seedY * dpr);
    if (sx < 0 || sx >= w || sy < 0 || sy >= h) return;

    const seedIdx = (sy * w + sx) * 4;
    const seedR = data[seedIdx];
    const seedG = data[seedIdx + 1];
    const seedB = data[seedIdx + 2];

    if (seedR === fillR && seedG === fillG && seedB === fillB) return;

    const tolSq = stroke.tolerance;
    const ensureFillBuffers = (): { visited: Uint8Array; stack: Int32Array } => {
      if (!fillVisited || fillVisited.length < pixelCount) fillVisited = new Uint8Array(pixelCount);
      else fillVisited.fill(0, 0, pixelCount);
      if (!fillStack || fillStack.length < pixelCount) fillStack = new Int32Array(pixelCount);
      return { visited: fillVisited, stack: fillStack };
    };
    const { visited, stack } = ensureFillBuffers();

    function matches(idx: number): boolean {
      const dr = data[idx] - seedR;
      const dg = data[idx + 1] - seedG;
      const db = data[idx + 2] - seedB;
      return (dr * dr + dg * dg + db * db) <= tolSq;
    }

    let stackTop = 0;
    stack[stackTop++] = sy * w + sx;
    while (stackTop > 0) {
      const pos = stack[--stackTop];
      const py = (pos / w) | 0;
      const px = pos - py * w;
      if (py < 0 || py >= h) continue;

      let left = px;
      let right = px;

      while (left > 0) {
        const vi = py * w + (left - 1);
        if (visited[vi] || !matches(vi * 4)) break;
        left--;
      }
      while (right < w - 1) {
        const vi = py * w + (right + 1);
        if (visited[vi] || !matches(vi * 4)) break;
        right++;
      }

      let aboveOpen = false;
      let belowOpen = false;
      for (let x = left; x <= right; x++) {
        const vi = py * w + x;
        if (visited[vi]) continue;
        visited[vi] = 1;
        const idx = vi * 4;
        data[idx] = fillR;
        data[idx + 1] = fillG;
        data[idx + 2] = fillB;
        data[idx + 3] = 255;

        if (py > 0) {
          const aboveVi = (py - 1) * w + x;
          const aboveMatch = !visited[aboveVi] && matches(aboveVi * 4);
          if (aboveMatch && !aboveOpen) { stack[stackTop++] = (py - 1) * w + x; aboveOpen = true; }
          else if (!aboveMatch) aboveOpen = false;
        }

        if (py < h - 1) {
          const belowVi = (py + 1) * w + x;
          const belowMatch = !visited[belowVi] && matches(belowVi * 4);
          if (belowMatch && !belowOpen) { stack[stackTop++] = (py + 1) * w + x; belowOpen = true; }
          else if (!belowMatch) belowOpen = false;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  function renderStrokeOnCanvas(stroke: StrokeEntry): void {
    if (stroke.type === "fill") executeFill(stroke);
    else renderPenStroke(stroke);
  }

  function restoreToCheckpoint(): void {
    let best: { data: ImageData; idx: number } | null = null;
    for (const cp of checkpoints) {
      if (cp.idx <= strokes.length && (!best || cp.idx > best.idx)) best = cp;
    }
    if (best) {
      ctx.putImageData(best.data, 0, 0);
      for (let i = best.idx; i < strokes.length; i++) renderStrokeOnCanvas(strokes[i]);
    } else {
      ctx.putImageData(backgroundSnapshot, 0, 0);
      for (const s of strokes) renderStrokeOnCanvas(s);
    }
  }

  /* ── Undo/Redo ─────────────────────────────────────────── */

  const checkpointBytes = canvas.width * canvas.height * 4;
  const checkpointCapacity = Math.max(
    1,
    Math.min(CHECKPOINT_MAX_COUNT, Math.floor(CHECKPOINT_MAX_BYTES / Math.max(1, checkpointBytes))),
  );
  const checkpointStride = checkpointCapacity <= 2 ? CHECKPOINT_EVERY * 3 : CHECKPOINT_EVERY;

  function trimCheckpoints(): void {
    if (checkpoints.length <= checkpointCapacity) return;
    checkpoints.splice(0, checkpoints.length - checkpointCapacity);
  }

  function maybeCaptureCheckpoint(): void {
    if (strokes.length === 0 || (strokes.length % checkpointStride) !== 0) return;
    checkpoints.push({ data: ctx.getImageData(0, 0, canvas.width, canvas.height), idx: strokes.length });
    trimCheckpoints();
  }

  function undo(): void {
    if (strokes.length === 0) return;
    redoStack.push(strokes.pop()!);
    while (checkpoints.length > 0 && checkpoints[checkpoints.length - 1]!.idx > strokes.length) {
      checkpoints.pop();
    }
    restoreToCheckpoint();
    updateToolbar();
  }

  function redo(): void {
    if (redoStack.length === 0) return;
    const stroke = redoStack.pop()!;
    strokes.push(stroke);
    renderStrokeOnCanvas(stroke);
    maybeCaptureCheckpoint();
    updateToolbar();
  }

  function commitStroke(stroke: StrokeEntry): void {
    strokes.push(stroke);
    redoStack = [];
    maybeCaptureCheckpoint();
    resetCloseConfirm();
    updateToolbar();
  }

  /* ── Fill tool ─────────────────────────────────────────── */

  function handleFill(canvasX: number, canvasY: number): void {
    const stroke: FillStroke = {
      type: "fill",
      seedX: canvasX,
      seedY: canvasY,
      color: currentColor,
      tolerance: 2700,
    };
    executeFill(stroke);
    commitStroke(stroke);
  }

  /* ── Eyedropper tool ───────────────────────────────────── */

  function handleEyedrop(canvasX: number, canvasY: number): void {
    const pxX = Math.round(canvasX * dpr);
    const pxY = Math.round(canvasY * dpr);
    if (pxX < 0 || pxX >= canvas.width || pxY < 0 || pxY >= canvas.height) return;
    const pixel = ctx.getImageData(pxX, pxY, 1, 1).data;
    const hex = "#" + ((1 << 24) | (pixel[0] << 16) | (pixel[1] << 8) | pixel[2]).toString(16).slice(1);
    applyCustomColor(hex);
  }

  /* ── Clear canvas ──────────────────────────────────────── */

  function clearCanvas(): void {
    if (activePointerId !== -1 || currentStroke) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      currentStroke = null;
      lastPoint = null;
      hasLastRenderMid = false;
      strokeSampler = null;
      pendingPoints.length = 0;
      activePointerId = -1;
      activePenPointerId = -1;
      pointers.clear();
      fingerTaps.length = 0;
      pinchActive = false;
      pointerPressureCache.clear();
    }
    if (strokes.length === 0) return;
    ctx.putImageData(backgroundSnapshot, 0, 0);
    strokes = [];
    redoStack = [];
    checkpoints = [];
    resetCloseConfirm();
    updateToolbar();
  }

  /* ── Pointer events ────────────────────────────────────── */

  function flushPoints(): void {
    rafId = 0;
    if (!currentStroke || pendingPoints.length === 0) return;
    const pen = PEN_TYPES.get(currentStroke.penId);
    if (!pen) return;

    ctx.save();
    ctx.globalCompositeOperation = pen.composite(isBlank);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const isEraserStroke = currentStroke.penId === "eraser";
    const color = isEraserStroke ? BLANK_BG : currentStroke.color;
    const pat = isEraserStroke && bgPattern ? bgPattern : undefined;
    ctx.strokeStyle = pat ?? color;

    for (const pt of pendingPoints) {
      if (strokeEncoder && callbacks.onEvent) {
        const block = strokeEncoder.push(
          Math.round(pt.x * 32767),
          Math.round(pt.y * 32767),
          Math.round(pt.p * 32767),
        );
        if (block) {
          callbacks.onEvent({ kind: "glyph", strokeId: nextStrokeId, data: block });
        }
      }

      if (lastPoint) {
        const lastX = lastPoint.x * logicalW;
        const lastY = lastPoint.y * logicalH;
        const curX = pt.x * logicalW;
        const curY = pt.y * logicalH;
        const midX = (lastX + curX) * 0.5;
        const midY = (lastY + curY) * 0.5;
        const fromX = hasLastRenderMid ? lastRenderMidX * logicalW : lastX;
        const fromY = hasLastRenderMid ? lastRenderMidY * logicalH : lastY;
        renderRoundQuadSeg(
          ctx,
          fromX,
          fromY,
          lastX,
          lastY,
          midX,
          midY,
          currentStroke.width,
          pt.p,
          pen.pressureSensitive,
        );
        lastRenderMidX = (lastPoint.x + pt.x) * 0.5;
        lastRenderMidY = (lastPoint.y + pt.y) * 0.5;
        hasLastRenderMid = true;
      }
      lastPoint = pt;
    }
    ctx.restore();
    pendingPoints.length = 0;
  }

  function cancelActiveStroke(): void {
    if (!currentStroke) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    currentStroke = null;
    lastPoint = null;
    hasLastRenderMid = false;
    strokeSampler = null;
    pendingPoints.length = 0;
    restoreToCheckpoint();
  }

  let lastNavMouseButton = -1;
  let lastNavMouseTs = -1;

  function isNavMouseButton(button: number): boolean {
    return button === 3 || button === 4;
  }

  function triggerNavMouseAction(button: number, ts: number): boolean {
    if (!isNavMouseButton(button)) return false;
    // Pointer + mouse events can both fire for one physical click.
    if (lastNavMouseButton === button && Math.abs(ts - lastNavMouseTs) < NAV_MOUSE_DEDUPE_MS) return true;
    lastNavMouseButton = button;
    lastNavMouseTs = ts;
    if (button === 3) undo();
    else redo();
    return true;
  }

  function onPointerDown(e: PointerEvent): void {
    const ts = eventTs(e);
    if (e.pointerType === "mouse" && triggerNavMouseAction(e.button, ts)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    resetCloseConfirm();

    if (activePenPointerId !== -1 && e.pointerType === "touch") {
      e.preventDefault();
      return;
    }
    if (e.pointerType === "pen") {
      if (!penSeen) {
        penSeen = true;
        touchToggleBtn.hidden = false;
        showHint("Pen detected. Toggle touch drawing under close.");
      }
      if (activePenPointerId === -1) {
        activePenPointerId = e.pointerId;
      }
    }

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    fingerTaps.push({ id: e.pointerId, startX: e.clientX, startY: e.clientY, startTime: ts, moved: false });

    // When touch drawing is disabled, still track the pointer so gestures
    // (pinch-zoom, multi-finger undo/redo) keep working, but skip stroke creation.
    if (!touchDrawEnabled && e.pointerType === "touch") {
      if (pointers.size >= 2) {
        cancelActiveStroke();
        activePointerId = -1;
        if (pointers.size === 2) {
          const pts = getFirstTwoPointers();
          if (!pts) return;
          const dx = pts[1].x - pts[0].x;
          const dy = pts[1].y - pts[0].y;
          pinchStartDist = Math.sqrt(dx * dx + dy * dy);
          pinchStartZoom = viewZoom;
          pinchStartMidX = (pts[0].x + pts[1].x) / 2;
          pinchStartMidY = (pts[0].y + pts[1].y) / 2;
          pinchStartPanX = viewPanX;
          pinchStartPanY = viewPanY;
          pinchActive = false;
        }
      }
      return;
    }

    // Multi-touch: cancel stroke and enter gesture mode
    if (pointers.size >= 2) {
      cancelActiveStroke();
      activePointerId = -1;
      if (pointers.size === 2) {
        const pts = getFirstTwoPointers();
        if (!pts) return;
        const dx = pts[1].x - pts[0].x;
        const dy = pts[1].y - pts[0].y;
        pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoom = viewZoom;
        pinchStartMidX = (pts[0].x + pts[1].x) / 2;
        pinchStartMidY = (pts[0].y + pts[1].y) / 2;
        pinchStartPanX = viewPanX;
        pinchStartPanY = viewPanY;
        pinchActive = false;
      }
      return;
    }

    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (activePointerId !== -1) return;
    e.preventDefault();

    activePointerId = e.pointerId;
    const [cx, cy] = screenToCanvas(e.clientX, e.clientY);

    // Tool dispatch
    if (currentTool === "fill") {
      handleFill(cx, cy);
      activePointerId = -1;
      return;
    }
    if (currentTool === "eyedropper") {
      handleEyedrop(cx, cy);
      activePointerId = -1;
      return;
    }

    // Pen / eraser stroke
    const penId = (currentTool === "eraser" || isPenEraserContact(e)) ? "eraser" : "pen";
    const pen = PEN_TYPES.get(penId)!;
    canvas.setPointerCapture(e.pointerId);
    const pressure = normalizePressure(e, e.pointerId);
    const nx = cx / logicalW;
    const ny = cy / logicalH;

    currentStroke = {
      type: "pen",
      points: [{ x: nx, y: ny, p: pressure }],
      color: currentColor,
      width: baseWidth * pen.widthScale,
      penId,
    };
    lastPoint = { x: nx, y: ny, p: pressure };
    hasLastRenderMid = false;
    strokeEncoder = new GlyphStreamEncoder(
      [Math.round(nx * 32767), Math.round(ny * 32767), Math.round(pressure * 32767)],
      [Math.round(nx * 32767), Math.round(ny * 32767), Math.round(pressure * 32767)]
    );

    if (callbacks.onEvent) {
      callbacks.onEvent({
        kind: "begin",
        strokeId: nextStrokeId,
        tool: penId as DrawTool,
        color: currentColor,
        width: baseWidth * pen.widthScale,
        start: { x: nx, y: ny, p: pressure },
      });
    }
  }

  function handlePinchMove(): void {
    const pts = getFirstTwoPointers();
    if (!pts) return;
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const midX = (pts[0].x + pts[1].x) / 2;
    const midY = (pts[0].y + pts[1].y) / 2;

    pinchActive = true;

    const scale = dist / pinchStartDist;
    viewZoom = Math.max(0.5, Math.min(5, pinchStartZoom * scale));

    viewPanX = pinchStartPanX + (midX - pinchStartMidX);
    viewPanY = pinchStartPanY + (midY - pinchStartMidY);
    clampPan();
    applyTransform();
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePenPointerId !== -1 && e.pointerType === "touch" && e.pointerId !== activePenPointerId) {
      return;
    }

    if (e.pointerType === "touch" && !touchDrawEnabled) {
      e.preventDefault();
      return;
    }
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    const tap = fingerTaps.find(t => t.id === e.pointerId);
    if (tap) {
      const dx = e.clientX - tap.startX;
      const dy = e.clientY - tap.startY;
      if (dx * dx + dy * dy > TAP_MOVE_THRESHOLD_SQ) tap.moved = true;
    }

    if (pointers.size >= 2) {
      handlePinchMove();
      return;
    }

    if (e.pointerId !== activePointerId || !currentStroke) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const samples = coalesced.length > 0 ? coalesced : [e];
    for (const sample of samples) {
      const [cx, cy] = screenToCanvasWithOrigin(sample.clientX, sample.clientY, rect.left, rect.top);
      const pressure = normalizePressure(sample, e.pointerId);
      const nx = cx / logicalW;
      const ny = cy / logicalH;
      const ts = eventTs(sample);

      if (!strokeSampler) {
        strokeSampler = createStrokeSampler({ x: nx, y: ny, p: pressure, t: ts });
      }

      const sampled = sampleStrokePoint(
        strokeSampler,
        { x: nx, y: ny, p: pressure, t: ts },
        logicalW,
        logicalH,
      );
      if (!sampled.keep) continue;

      const pt: Point = sampled.point;
      currentStroke.points.push(pt);
      pendingPoints.push(pt);
    }

    if (!rafId) rafId = requestAnimationFrame(flushPoints);
  }

  function evaluateFingerTap(): void {
    if (fingerTaps.length < 2) return;
    let firstTime = Number.POSITIVE_INFINITY;
    for (let i = 0; i < fingerTaps.length; i++) {
      const start = fingerTaps[i].startTime;
      if (start < firstTime) firstTime = start;
    }
    if (performance.now() - firstTime > MULTI_TAP_WINDOW_MS) { fingerTaps.length = 0; return; }
    for (let i = 0; i < fingerTaps.length; i++) {
      const tap = fingerTaps[i];
      if (tap.startTime - firstTime >= MULTI_TAP_SYNC_MS || tap.moved) {
        fingerTaps.length = 0;
        return;
      }
    }

    if (fingerTaps.length === 2 && !pinchActive) undo();
    else if (fingerTaps.length === 3 && !pinchActive) redo();
    fingerTaps.length = 0;
  }

  function onPointerEnd(e: PointerEvent): void {
    pointerPressureCache.delete(e.pointerId);
    if (e.pointerId === activePenPointerId) activePenPointerId = -1;
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    }

    if (pointers.size === 0 && fingerTaps.length >= 2) {
      evaluateFingerTap();
      pinchActive = false;
      return;
    }

    if (pointers.size === 0) {
      // Double-tap to reset zoom
      const tap = fingerTaps.find(t => t.id === e.pointerId);
      if (tap && !tap.moved && e.pointerType === "touch" && viewZoom !== 1) {
        const now = performance.now();
        const dt = now - lastTapTime;
        const dx = e.clientX - lastTapX;
        const dy = e.clientY - lastTapY;
        if (dt < MULTI_TAP_WINDOW_MS && dx * dx + dy * dy < DOUBLE_TAP_RADIUS_SQ) {
          viewZoom = 1; viewPanX = 0; viewPanY = 0;
          applyTransform();
          lastTapTime = 0;
        } else {
          lastTapTime = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      }
      fingerTaps.length = 0;
      pinchActive = false;
    }

    if (e.pointerId !== activePointerId) return;
    activePointerId = -1;

    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    flushPoints();
    finalizeCurrentStrokeTail();

    if (currentStroke && currentStroke.points.length > 0) {
      if (callbacks.onEvent) {
        callbacks.onEvent({ kind: "end", strokeId: nextStrokeId });
      }
      commitStroke(currentStroke);
      nextStrokeId++;
    }
    currentStroke = null;
    lastPoint = null;
    hasLastRenderMid = false;
    strokeSampler = null;
    strokeEncoder = null;
  }

  canvas.addEventListener("pointerdown", onPointerDown, { signal: ds });
  canvas.addEventListener("pointermove", onPointerMove, { signal: ds });
  canvas.addEventListener("pointerup", onPointerEnd, { signal: ds });
  canvas.addEventListener("pointercancel", onPointerEnd, { signal: ds });
  overlay.addEventListener("selectstart", (e) => e.preventDefault(), { signal: ds });
  overlay.addEventListener("dragstart", (e) => e.preventDefault(), { signal: ds });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal: ds });
  overlay.addEventListener("contextmenu", (e) => e.preventDefault(), { signal: ds });

  // Block browser history navigation on mouse back/forward buttons while draw is open.
  // We capture at window level for broader browser compatibility.
  const onMouseNavCapture = (e: MouseEvent): void => {
    if (!isNavMouseButton(e.button)) return;
    if (e.target instanceof Node && !overlay.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "mousedown" || e.type === "auxclick") {
      triggerNavMouseAction(e.button, eventTs(e));
    }
  };
  window.addEventListener("mousedown", onMouseNavCapture, { capture: true, signal: ds });
  window.addEventListener("mouseup", onMouseNavCapture, { capture: true, signal: ds });
  window.addEventListener("auxclick", onMouseNavCapture, { capture: true, signal: ds });
  overlay.addEventListener("wheel", (e) => e.preventDefault(), { passive: false, signal: ds });

  /* ── Scroll wheel: brush size + zoom ───────────────────── */

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.5, Math.min(5, viewZoom * factor));
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      viewPanX = cx - (cx - viewPanX) * (newZoom / viewZoom);
      viewPanY = cy - (cy - viewPanY) * (newZoom / viewZoom);
      viewZoom = newZoom;
      clampPan();
      applyTransform();
    } else {
      const delta = e.deltaY < 0 ? 0.5 : -0.5;
      setBrushSize(Math.max(1, Math.min(20, baseWidth + delta)));
    }
  }, { passive: false, signal: ds } as AddEventListenerOptions);

  /* ── Toolbar events ────────────────────────────────────── */

  colorBtns.forEach((b, i) => {
    b.addEventListener("pointerdown", (e) => {
      beginSwatchColorDrag(e, b, i);
    }, { signal: ds });
    b.addEventListener("click", () => {
      if (shouldSuppressSwatchClick()) return;
      selectPaletteColor(i);
    }, { signal: ds });
  });

  window.addEventListener("pointermove", (e) => {
    if (e.pointerId !== colorDragPointerId) return;
    const dx = e.clientX - colorDragStartX;
    const dy = e.clientY - colorDragStartY;
    if (dx * dx + dy * dy > SWATCH_DRAG_CANCEL_LONGPRESS_SQ) {
      colorDragMoved = true;
      if (colorDragIsCustom && longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }
    const s = Math.max(0, Math.min(1, colorDragStartS + shapedDragDelta(dx)));
    const v = Math.max(0, Math.min(1, colorDragStartV + shapedDragDelta(-dy)));
    const next = hsvToHex(colorDragHue, s, v);
    if (colorDragIsCustom) applyCustomColor(next);
    else if (colorDragPaletteIdx >= 0) applyPaletteColor(colorDragPaletteIdx, next);
  }, { signal: ds });
  window.addEventListener("pointerup", (e) => endSwatchColorDrag(e), { signal: ds });
  window.addEventListener("pointercancel", (e) => endSwatchColorDrag(e), { signal: ds });

  // Custom color: click = open picker / select; long-press = eyedropper
  let eyedropperViaLongPress = false;

  customColorBtn.addEventListener("pointerdown", (e) => {
    beginSwatchColorDrag(e, customColorBtn, null);
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      eyedropperViaLongPress = true;
      currentTool = "eyedropper";
      updateToolbar();
      showHint("Eyedropper active. Tap a color to pick it.");
    }, 500);
  }, { signal: ds });

  customColorBtn.addEventListener("pointerup", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { signal: ds });

  customColorBtn.addEventListener("pointercancel", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { signal: ds });

  customColorBtn.addEventListener("pointerleave", () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  }, { signal: ds });

  customColorBtn.addEventListener("contextmenu", (e) => e.preventDefault(), { signal: ds });

  customColorBtn.addEventListener("click", () => {
    if (shouldSuppressSwatchClick()) return;
    if (eyedropperViaLongPress) { eyedropperViaLongPress = false; return; }
    if (customColor === null) {
      colorInput.click();
    } else if (currentColor !== customColor) {
      applyCustomColor(customColor);
    } else {
      colorInput.click();
    }
  }, { signal: ds });

  colorInput.addEventListener("input", () => {
    applyCustomColor(colorInput.value);
  }, { signal: ds });

  eraserBtn.addEventListener("click", () => {
    setTool(currentTool === "eraser" ? "pen" : "eraser");
  }, { signal: ds });

  undoBtn.addEventListener("click", () => undo(), { signal: ds });
  redoBtn.addEventListener("click", () => redo(), { signal: ds });

  /* ── Send ───────────────────────────────────────────────── */

  const OUT_MIME = "application/x-whisper-gwyph";
  const OUT_EXT = "gwyph";

  function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function quantQ15(v: number): number {
    return Math.round(clamp01(v) * 32767);
  }

  function zigZagEncode(v: number): number {
    return v >= 0 ? v * 2 : (-v * 2) - 1;
  }

  function parseHexRgb(color: string): [number, number, number] {
    const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!m) return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }

  class ByteWriter {
    private data: number[] = [];

    u8(v: number): void { this.data.push(v & 0xff); }

    u16(v: number): void {
      this.data.push(v & 0xff, (v >>> 8) & 0xff);
    }

    bytes(raw: readonly number[]): void {
      for (let i = 0; i < raw.length; i++) this.u8(raw[i]);
    }

    varUint(v: number): void {
      let n = v >>> 0;
      while (n >= 0x80) {
        this.u8((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      this.u8(n);
    }

    finish(): Uint8Array {
      return Uint8Array.from(this.data);
    }
  }

  function encodeGwyphPayload(): Uint8Array {
    // GWYPH v1 compact stroke stream:
    // magic[4], version[1], mode[1], logicalW[2], logicalH[2], strokeCount[var]
    // stroke pen: tag[1]=0, tool[1], rgb[3], widthQ8[2], pointCount[var], first xyzQ15[2*3], then delta xyz zigzag-varints
    // stroke fill: tag[1]=1, rgb[3], toleranceSq[2], seedXQ15[2], seedYQ15[2]
    const w = new ByteWriter();
    w.bytes([0x47, 0x57, 0x59, 0x50]); // GWYP
    w.u8(1); // version
    w.u8(config.mode === "blank" ? 0 : 1);
    w.u16(Math.max(1, Math.min(65535, logicalW | 0)));
    w.u16(Math.max(1, Math.min(65535, logicalH | 0)));
    w.varUint(strokes.length);

    for (const stroke of strokes) {
      if (stroke.type === "fill") {
        const [r, g, b] = parseHexRgb(stroke.color);
        w.u8(1);
        w.u8(r);
        w.u8(g);
        w.u8(b);
        w.u16(Math.max(0, Math.min(65535, Math.round(stroke.tolerance))));
        w.u16(quantQ15(stroke.seedX));
        w.u16(quantQ15(stroke.seedY));
        continue;
      }

      const pts = stroke.points;
      const [r, g, b] = parseHexRgb(stroke.color);
      w.u8(0);
      w.u8(stroke.penId === "eraser" ? 1 : 0);
      w.u8(r);
      w.u8(g);
      w.u8(b);
      w.u16(Math.max(1, Math.min(65535, Math.round(stroke.width * 256))));
      w.varUint(pts.length);
      if (pts.length === 0) continue;

      let prevX = quantQ15(pts[0].x);
      let prevY = quantQ15(pts[0].y);
      let prevP = quantQ15(pts[0].p);
      w.u16(prevX);
      w.u16(prevY);
      w.u16(prevP);

      for (let i = 1; i < pts.length; i++) {
        const nx = quantQ15(pts[i].x);
        const ny = quantQ15(pts[i].y);
        const np = quantQ15(pts[i].p);
        w.varUint(zigZagEncode(nx - prevX));
        w.varUint(zigZagEncode(ny - prevY));
        w.varUint(zigZagEncode(np - prevP));
        prevX = nx;
        prevY = ny;
        prevP = np;
      }
    }

    return w.finish();
  }

  function resolveOutputName(): string {
    if (!isBlank && config.originalName) {
      const dot = config.originalName.lastIndexOf(".");
      const stem = dot > 0 ? config.originalName.slice(0, dot) : config.originalName;
      // Strip any number of trailing _drawing suffixes (case-insensitive)
      const cleanStem = stem.replace(/(_drawing)+$/i, "");
      // If nothing meaningful is left (e.g. original was "drawing.webp"), keep a simple default.
      if (!cleanStem || cleanStem.toLowerCase() === "drawing") return `drawing.${OUT_EXT}`;
      return `${cleanStem}_drawing.${OUT_EXT}`;
    }
    return `drawing.${OUT_EXT}`;
  }

  sendBtn.addEventListener("click", async () => {
    if (strokes.length === 0) return;

    const name = resolveOutputName();
    const payload = encodeGwyphPayload();
    const stable = new Uint8Array(payload.byteLength);
    stable.set(payload);
    callbacks.onSend({ file: new File([stable.buffer], name, { type: OUT_MIME }) });
    closeDraw();
  }, { signal: ds });

  /* ── Close ──────────────────────────────────────────────── */

  function closeDraw(): void {
    if (closed) return;
    resetCloseConfirm();
    drawAc.abort();
    teardownDraw();
  }

  // Confirm-to-close: first press with strokes enters confirm state, second closes

  function resetCloseConfirm(): void {
    if (closeConfirmTimer) { clearTimeout(closeConfirmTimer); closeConfirmTimer = null; }
    closeBtn.classList.remove("--confirm");
    closeBtn.title = "close (esc)";
    closeBtn.setAttribute("aria-label", "Close drawing");
  }

  function requestClose(): void {
    if (strokes.length === 0) { closeDraw(); return; }
    if (closeConfirmTimer) { resetCloseConfirm(); closeDraw(); return; }
    closeBtn.classList.add("--confirm");
    closeBtn.title = "tap again to discard";
    closeBtn.setAttribute("aria-label", "Tap again to discard drawing");
    showHint("Tap close again to discard.");
    closeConfirmTimer = setTimeout(resetCloseConfirm, 1500);
  }

  closeBtn.addEventListener("click", () => requestClose(), { signal: ds });
  touchToggleBtn.addEventListener("click", () => {
    touchDrawEnabled = !touchDrawEnabled;
    syncTouchToggleUi();
    showHint(touchDrawEnabled ? "Touch drawing enabled." : "Touch drawing disabled.");
  }, { signal: ds });
  syncTouchToggleUi();

  /* ── Keyboard shortcuts ────────────────────────────────── */

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); requestClose(); return; }

    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta && e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); redo(); return; }
    if (isMeta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
    if (isMeta && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
    if (isMeta && e.key === "Delete") { e.preventDefault(); clearCanvas(); return; }

    if (isMeta) return;

    switch (e.key) {
      case "e": case "E":
        setTool(currentTool === "eraser" ? "pen" : "eraser");
        break;
      case "p": case "P": setTool("pen"); break;
      case "b": case "B": setTool("fill"); break;
      case "i": case "I": setTool("eyedropper"); break;
      case "6":
        if (customColor) applyCustomColor(customColor);
        break;
      case "[":
        setBrushSize(Math.max(1, baseWidth - 1));
        break;
      case "]":
        setBrushSize(Math.min(20, baseWidth + 1));
        break;
      default: {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 5) {
          selectPaletteColor(num - 1);
        }
      }
    }
  }, { signal: ds });

  /* ── Mount ──────────────────────────────────────────────── */

  document.body.appendChild(overlay);
  requestAnimationFrame(() => {
    overlay.classList.add("--open");
    overlay.focus({ preventScroll: true });
    if (!drawHintShown) {
      showHint("Pinch to zoom. Two-finger tap undo, three-finger tap redo.", DRAW_HINT_ONBOARD_MS);
      drawHintShown = true;
    }
  });
}
