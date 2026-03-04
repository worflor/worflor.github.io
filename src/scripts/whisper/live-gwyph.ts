export const GLYPH_MIME = "application/x-whisper-gwyph";

export interface GlyphPoint {
  x: number;
  y: number;
  p: number;
}

export interface GlyphStrokePen {
  type: "pen";
  tool: "pen" | "eraser";
  color: string;
  width: number;
  points: GlyphPoint[];
}

export interface GlyphStrokeFill {
  type: "fill";
  color: string;
  tolerance: number;
  seedX: number;
  seedY: number;
}

export type GlyphStroke = GlyphStrokePen | GlyphStrokeFill;

export interface GlyphPayload {
  mode: "blank" | "annotate";
  logicalW: number;
  logicalH: number;
  strokes: GlyphStroke[];
}

interface GlyphRenderScratch {
  bgCanvas: HTMLCanvasElement;
  bgCtx: CanvasRenderingContext2D;
  drawCanvas: HTMLCanvasElement;
  drawCtx: CanvasRenderingContext2D;
  tempCanvas: HTMLCanvasElement;
  tempCtx: CanvasRenderingContext2D;
  fillVisited: Uint8Array;
  fillStack: Int32Array;
}

let glyphRenderScratch: GlyphRenderScratch | null = null;

function ensureGlyphRenderScratch(W: number, H: number): GlyphRenderScratch {
  if (!glyphRenderScratch) {
    const bgCanvas = document.createElement("canvas");
    const drawCanvas = document.createElement("canvas");
    const tempCanvas = document.createElement("canvas");
    const bgCtx = bgCanvas.getContext("2d");
    const drawCtx = drawCanvas.getContext("2d");
    const tempCtx = tempCanvas.getContext("2d");
    if (!bgCtx || !drawCtx || !tempCtx) {
      throw new Error("glyph: canvas context unavailable");
    }
    glyphRenderScratch = {
      bgCanvas,
      bgCtx,
      drawCanvas,
      drawCtx,
      tempCanvas,
      tempCtx,
      fillVisited: new Uint8Array(0),
      fillStack: new Int32Array(0),
    };
  }

  const s = glyphRenderScratch;
  if (s.bgCanvas.width !== W || s.bgCanvas.height !== H) {
    s.bgCanvas.width = W;
    s.bgCanvas.height = H;
  }
  if (s.drawCanvas.width !== W || s.drawCanvas.height !== H) {
    s.drawCanvas.width = W;
    s.drawCanvas.height = H;
  }
  if (s.tempCanvas.width !== W || s.tempCanvas.height !== H) {
    s.tempCanvas.width = W;
    s.tempCanvas.height = H;
  }

  return s;
}

class GlyphReader {
  private off = 0;
  constructor(private readonly data: Uint8Array) { }

  private ensure(n: number): void {
    if (this.off + n > this.data.length) throw new Error("glyph: truncated");
  }

  u8(): number {
    this.ensure(1);
    return this.data[this.off++];
  }

  u16(): number {
    this.ensure(2);
    const v = this.data[this.off] | (this.data[this.off + 1] << 8);
    this.off += 2;
    return v;
  }

  varUint(): number {
    let shift = 0;
    let out = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      out |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return out >>> 0;
      shift += 7;
    }
    throw new Error("glyph: varuint overflow");
  }
}

function zigZagDecode(v: number): number {
  return (v & 1) === 0 ? (v >>> 1) : -((v >>> 1) + 1);
}

function q15ToNorm(v: number): number {
  return Math.max(0, Math.min(1, v / 32767));
}

function rgbToHex(r: number, g: number, b: number): string {
  const rr = (r & 0xff).toString(16).padStart(2, "0");
  const gg = (g & 0xff).toString(16).padStart(2, "0");
  const bb = (b & 0xff).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

export function parseGwyphPayload(bytes: Uint8Array): GlyphPayload | null {
  try {
    const r = new GlyphReader(bytes);
    const g = r.u8();
    const w = r.u8();
    const y = r.u8();
    const p = r.u8();
    if (g !== 0x47 || w !== 0x57 || y !== 0x59 || p !== 0x50) return null;
    const version = r.u8();
    if (version !== 1) return null;
    const modeByte = r.u8();
    const logicalW = Math.max(1, r.u16());
    const logicalH = Math.max(1, r.u16());
    const strokeCount = r.varUint();
    const strokes: GlyphStroke[] = [];

    for (let i = 0; i < strokeCount; i++) {
      const tag = r.u8();
      if (tag === 1) {
        const cr = r.u8();
        const cg = r.u8();
        const cb = r.u8();
        const tolSq = r.u16();
        const sx = q15ToNorm(r.u16());
        const sy = q15ToNorm(r.u16());
        strokes.push({
          type: "fill",
          color: rgbToHex(cr, cg, cb),
          tolerance: Math.max(0, Math.min(65535, tolSq)),
          seedX: sx,
          seedY: sy,
        });
        continue;
      }
      if (tag !== 0) return null;
      const tool = r.u8() === 1 ? "eraser" : "pen";
      const cr = r.u8();
      const cg = r.u8();
      const cb = r.u8();
      const width = Math.max(0.25, r.u16() / 256);
      const pointCount = r.varUint();
      const points: GlyphPoint[] = [];
      if (pointCount > 0) {
        let x = r.u16();
        let yv = r.u16();
        let pv = r.u16();
        points.push({ x: q15ToNorm(x), y: q15ToNorm(yv), p: q15ToNorm(pv) });
        for (let pi = 1; pi < pointCount; pi++) {
          x += zigZagDecode(r.varUint());
          yv += zigZagDecode(r.varUint());
          pv += zigZagDecode(r.varUint());
          points.push({
            x: q15ToNorm(x),
            y: q15ToNorm(yv),
            p: q15ToNorm(pv),
          });
        }
      }
      strokes.push({
        type: "pen",
        tool,
        color: rgbToHex(cr, cg, cb),
        width,
        points,
      });
    }

    return {
      mode: modeByte === 0 ? "blank" : "annotate",
      logicalW,
      logicalH,
      strokes,
    };
  } catch {
    return null;
  }
}

function renderGlyphStroke(ctx: CanvasRenderingContext2D, stroke: GlyphStrokePen, W: number, H: number): void {
  if (stroke.points.length === 0) return;
  const pressureSens = stroke.tool !== "eraser";
  ctx.save();
  ctx.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.tool === "eraser" ? "rgba(0,0,0,1)" : stroke.color;
  ctx.fillStyle = stroke.color;

  if (stroke.points.length === 1) {
    const pt = stroke.points[0];
    const r = (pressureSens ? stroke.width * (0.3 + pt.p * 0.7) : stroke.width) / 2;
    ctx.beginPath();
    ctx.arc(pt.x * W, pt.y * H, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  let lastX = stroke.points[0].x * W;
  let lastY = stroke.points[0].y * H;
  let hasLastMid = false;
  let lastMidX = 0;
  let lastMidY = 0;
  for (let i = 1; i < stroke.points.length; i++) {
    const cur = stroke.points[i];
    const cx = cur.x * W;
    const cy = cur.y * H;
    const midX = (lastX + cx) * 0.5;
    const midY = (lastY + cy) * 0.5;
    const fromX = hasLastMid ? lastMidX : lastX;
    const fromY = hasLastMid ? lastMidY : lastY;
    const lw = pressureSens ? stroke.width * (0.3 + cur.p * 0.7) : stroke.width;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.quadraticCurveTo(lastX, lastY, midX, midY);
    ctx.stroke();
    lastMidX = midX;
    lastMidY = midY;
    hasLastMid = true;
    lastX = cx;
    lastY = cy;
  }
  ctx.restore();
}

function renderGlyphFill(
  ctx: CanvasRenderingContext2D,
  stroke: GlyphStrokeFill,
  W: number,
  H: number,
  backgroundLayer: HTMLCanvasElement | null,
  scratch: GlyphRenderScratch,
): void {
  const tempCtx = scratch.tempCtx;
  tempCtx.clearRect(0, 0, W, H);
  if (backgroundLayer) tempCtx.drawImage(backgroundLayer, 0, 0, W, H);
  tempCtx.drawImage(ctx.canvas, 0, 0, W, H);
  const composite = tempCtx.getImageData(0, 0, W, H).data;

  const imgData = ctx.getImageData(0, 0, W, H);
  const data = imgData.data;
  const pixelCount = W * H;
  const sx = Math.round(stroke.seedX * (W - 1));
  const sy = Math.round(stroke.seedY * (H - 1));
  if (sx < 0 || sx >= W || sy < 0 || sy >= H) return;

  const fillR = parseInt(stroke.color.slice(1, 3), 16);
  const fillG = parseInt(stroke.color.slice(3, 5), 16);
  const fillB = parseInt(stroke.color.slice(5, 7), 16);

  const seedIdx = (sy * W + sx) * 4;
  const seedR = composite[seedIdx];
  const seedG = composite[seedIdx + 1];
  const seedB = composite[seedIdx + 2];
  if (seedR === fillR && seedG === fillG && seedB === fillB) return;

  const tolSq = Math.max(0, stroke.tolerance);
  if (scratch.fillVisited.length < pixelCount) scratch.fillVisited = new Uint8Array(pixelCount);
  else scratch.fillVisited.fill(0, 0, pixelCount);
  if (scratch.fillStack.length < pixelCount) scratch.fillStack = new Int32Array(pixelCount);
  const visited = scratch.fillVisited;
  const stack = scratch.fillStack;

  const matches = (idx: number): boolean => {
    const dr = composite[idx] - seedR;
    const dg = composite[idx + 1] - seedG;
    const db = composite[idx + 2] - seedB;
    return (dr * dr + dg * dg + db * db) <= tolSq;
  };

  let top = 0;
  stack[top++] = sy * W + sx;
  while (top > 0) {
    const pos = stack[--top];
    const py = (pos / W) | 0;
    const px = pos - py * W;
    if (py < 0 || py >= H) continue;

    let left = px;
    let right = px;
    while (left > 0) {
      const vi = py * W + (left - 1);
      if (visited[vi] || !matches(vi * 4)) break;
      left--;
    }
    while (right < W - 1) {
      const vi = py * W + (right + 1);
      if (visited[vi] || !matches(vi * 4)) break;
      right++;
    }

    let aboveOpen = false;
    let belowOpen = false;
    for (let x = left; x <= right; x++) {
      const vi = py * W + x;
      if (visited[vi]) continue;
      visited[vi] = 1;
      const idx = vi * 4;
      data[idx] = fillR;
      data[idx + 1] = fillG;
      data[idx + 2] = fillB;
      data[idx + 3] = 255;

      if (py > 0) {
        const aboveVi = (py - 1) * W + x;
        const aboveMatch = !visited[aboveVi] && matches(aboveVi * 4);
        if (aboveMatch && !aboveOpen) { stack[top++] = (py - 1) * W + x; aboveOpen = true; }
        else if (!aboveMatch) aboveOpen = false;
      }
      if (py < H - 1) {
        const belowVi = (py + 1) * W + x;
        const belowMatch = !visited[belowVi] && matches(belowVi * 4);
        if (belowMatch && !belowOpen) { stack[top++] = (py + 1) * W + x; belowOpen = true; }
        else if (!belowMatch) belowOpen = false;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

export function renderGwyphScene(ctx: CanvasRenderingContext2D, glyph: GlyphPayload, W: number, H: number): void {
  const scratch = ensureGlyphRenderScratch(W, H);
  const { bgCanvas, bgCtx, drawCanvas, drawCtx } = scratch;

  bgCtx.clearRect(0, 0, W, H);
  drawCtx.clearRect(0, 0, W, H);

  if (glyph.mode === "blank") {
    bgCtx.fillStyle = "#1a1a1a";
    bgCtx.fillRect(0, 0, W, H);
  }

  for (const stroke of glyph.strokes) {
    if (stroke.type === "pen") renderGlyphStroke(drawCtx, stroke, W, H);
    else renderGlyphFill(drawCtx, stroke, W, H, glyph.mode === "blank" ? bgCanvas : null, scratch);
  }

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, W, H);
  if (glyph.mode === "blank") ctx.drawImage(bgCanvas, 0, 0, W, H);
  ctx.drawImage(drawCanvas, 0, 0, W, H);
  ctx.restore();
}

export function isWhisperGlyph(fileType?: string, fileName?: string): boolean {
  const t = (fileType ?? "").toLowerCase();
  const n = (fileName ?? "").toLowerCase();
  return t === GLYPH_MIME || t.includes("whisper-gwyph") || n.endsWith(".gwyph");
}

export function gwyphPngName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem || "drawing"}.png`;
}

export async function exportGwyphToPngBlob(bytes: Uint8Array, maxEdge = 4096): Promise<Blob | null> {
  const glyph = parseGwyphPayload(bytes);
  if (!glyph) return null;
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  const W = Math.max(1, Math.min(maxEdge, Math.round(glyph.logicalW)));
  const H = Math.max(1, Math.min(maxEdge, Math.round(glyph.logicalH)));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  renderGwyphScene(ctx, glyph, W, H);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? null), "image/png");
  });
}
