export const DRAW_STREAM_VERSION = 1;

export const DRAW_STREAM_KIND = {
  BEGIN: 0x01,
  POINTS: 0x02,
  END: 0x03,
  CLEAR: 0x04,
  UNDO: 0x05,
  REDO: 0x06,
  PRESENCE: 0x07,
} as const;

type DrawStreamKindCode = typeof DRAW_STREAM_KIND[keyof typeof DRAW_STREAM_KIND];

export type DrawTool = "pen" | "eraser";

export interface DrawNormPoint {
  x: number;
  y: number;
  p: number;
}

export interface DrawStreamBeginEvent {
  kind: "begin";
  seq: number;
  strokeId: number;
  tool: DrawTool;
  color: string;
  width: number;
  start: DrawNormPoint;
}

export interface DrawStreamPointsEvent {
  kind: "points";
  seq: number;
  strokeId: number;
  points: DrawNormPoint[];
}

export interface DrawStreamEndEvent {
  kind: "end";
  seq: number;
  strokeId: number;
}

export interface DrawStreamClearEvent {
  kind: "clear";
  seq: number;
}

export interface DrawStreamUndoEvent {
  kind: "undo";
  seq: number;
}

export interface DrawStreamRedoEvent {
  kind: "redo";
  seq: number;
}

export interface DrawStreamPresenceEvent {
  kind: "presence";
  seq: number;
  active: boolean;
  strokeId?: number;
}

export type DrawStreamEvent =
  | DrawStreamBeginEvent
  | DrawStreamPointsEvent
  | DrawStreamEndEvent
  | DrawStreamClearEvent
  | DrawStreamUndoEvent
  | DrawStreamRedoEvent
  | DrawStreamPresenceEvent;

export interface DrawStreamApplyResult {
  applied: boolean;
  reason?: "stale-seq" | "invalid-order";
}

export interface DrawStreamTrackerState {
  lastSeq: number;
  activeStrokeId: number | null;
  peerActive: boolean;
}

const TOOL_CODE = {
  pen: 0,
  eraser: 1,
} as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v);
}

function q16(v: number): number {
  return Math.round(clamp(v, 0, 1) * 65535);
}

function uq16(v: number): number {
  return clamp(v, 0, 65535) / 65535;
}

function encodeHexColorRgb(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) throw new Error("invalid draw color");
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function decodeHexColorRgb(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function writeBaseHeader(view: DataView, kind: DrawStreamKindCode, seq: number): void {
  view.setUint8(0, DRAW_STREAM_VERSION);
  view.setUint8(1, kind);
  view.setUint32(2, seq >>> 0, true);
}

function readBaseHeader(bytes: Uint8Array): { kind: number; seq: number } | null {
  if (bytes.length < 6) return null;
  if (bytes[0] !== DRAW_STREAM_VERSION) return null;
  const kind = bytes[1];
  const seq = new DataView(bytes.buffer, bytes.byteOffset + 2, 4).getUint32(0, true);
  return { kind, seq };
}

export function encodeDrawStreamEvent(evt: DrawStreamEvent): Uint8Array {
  switch (evt.kind) {
    case "begin": {
      const out = new Uint8Array(20);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.BEGIN, evt.seq);
      view.setUint16(6, evt.strokeId & 0xffff, true);
      view.setUint8(8, TOOL_CODE[evt.tool]);
      const [r, g, b] = encodeHexColorRgb(evt.color);
      view.setUint8(9, r);
      view.setUint8(10, g);
      view.setUint8(11, b);
      view.setUint16(12, Math.round(clamp(evt.width, 0, 655.35) * 100), true);
      view.setUint16(14, q16(evt.start.x), true);
      view.setUint16(16, q16(evt.start.y), true);
      view.setUint16(18, q16(evt.start.p), true);
      return out;
    }
    case "points": {
      const count = evt.points.length;
      if (count <= 0 || count > 40) throw new Error("draw points frame must contain 1..40 points");
      const out = new Uint8Array(9 + count * 6);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.POINTS, evt.seq);
      view.setUint16(6, evt.strokeId & 0xffff, true);
      view.setUint8(8, count);
      let offset = 9;
      for (let i = 0; i < count; i++) {
        const p = evt.points[i];
        view.setUint16(offset, q16(p.x), true);
        view.setUint16(offset + 2, q16(p.y), true);
        view.setUint16(offset + 4, q16(p.p), true);
        offset += 6;
      }
      return out;
    }
    case "end": {
      const out = new Uint8Array(8);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.END, evt.seq);
      view.setUint16(6, evt.strokeId & 0xffff, true);
      return out;
    }
    case "clear": {
      const out = new Uint8Array(6);
      writeBaseHeader(new DataView(out.buffer), DRAW_STREAM_KIND.CLEAR, evt.seq);
      return out;
    }
    case "undo": {
      const out = new Uint8Array(6);
      writeBaseHeader(new DataView(out.buffer), DRAW_STREAM_KIND.UNDO, evt.seq);
      return out;
    }
    case "redo": {
      const out = new Uint8Array(6);
      writeBaseHeader(new DataView(out.buffer), DRAW_STREAM_KIND.REDO, evt.seq);
      return out;
    }
    case "presence": {
      const hasStroke = typeof evt.strokeId === "number";
      const out = new Uint8Array(hasStroke ? 10 : 8);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.PRESENCE, evt.seq);
      view.setUint8(6, evt.active ? 1 : 0);
      view.setUint8(7, hasStroke ? 1 : 0);
      if (hasStroke) view.setUint16(8, (evt.strokeId as number) & 0xffff, true);
      return out;
    }
  }
}

export function decodeDrawStreamEvent(bytes: Uint8Array): DrawStreamEvent | null {
  const header = readBaseHeader(bytes);
  if (!header) return null;
  const { kind, seq } = header;

  switch (kind) {
    case DRAW_STREAM_KIND.BEGIN: {
      if (bytes.length !== 20) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const toolCode = view.getUint8(8);
      const tool: DrawTool | null = toolCode === 0 ? "pen" : (toolCode === 1 ? "eraser" : null);
      if (!tool) return null;
      const color = decodeHexColorRgb(view.getUint8(9), view.getUint8(10), view.getUint8(11));
      return {
        kind: "begin",
        seq,
        strokeId: view.getUint16(6, true),
        tool,
        color,
        width: view.getUint16(12, true) / 100,
        start: {
          x: uq16(view.getUint16(14, true)),
          y: uq16(view.getUint16(16, true)),
          p: uq16(view.getUint16(18, true)),
        },
      };
    }
    case DRAW_STREAM_KIND.POINTS: {
      if (bytes.length < 9) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = view.getUint8(8);
      if (count <= 0 || count > 40) return null;
      if (bytes.length !== 9 + count * 6) return null;
      const points: DrawNormPoint[] = [];
      let offset = 9;
      for (let i = 0; i < count; i++) {
        points.push({
          x: uq16(view.getUint16(offset, true)),
          y: uq16(view.getUint16(offset + 2, true)),
          p: uq16(view.getUint16(offset + 4, true)),
        });
        offset += 6;
      }
      return {
        kind: "points",
        seq,
        strokeId: view.getUint16(6, true),
        points,
      };
    }
    case DRAW_STREAM_KIND.END: {
      if (bytes.length !== 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { kind: "end", seq, strokeId: view.getUint16(6, true) };
    }
    case DRAW_STREAM_KIND.CLEAR:
      return bytes.length === 6 ? { kind: "clear", seq } : null;
    case DRAW_STREAM_KIND.UNDO:
      return bytes.length === 6 ? { kind: "undo", seq } : null;
    case DRAW_STREAM_KIND.REDO:
      return bytes.length === 6 ? { kind: "redo", seq } : null;
    case DRAW_STREAM_KIND.PRESENCE: {
      if (bytes.length !== 8 && bytes.length !== 10) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const active = view.getUint8(6) === 1;
      const hasStroke = view.getUint8(7) === 1;
      if (hasStroke && bytes.length !== 10) return null;
      if (!hasStroke && bytes.length !== 8) return null;
      return {
        kind: "presence",
        seq,
        active,
        strokeId: hasStroke ? view.getUint16(8, true) : undefined,
      };
    }
    default:
      return null;
  }
}

export function chunkDrawPoints(
  strokeId: number,
  startSeq: number,
  points: DrawNormPoint[],
  maxPointsPerFrame = 24,
): DrawStreamPointsEvent[] {
  const maxPts = Math.max(1, Math.min(40, maxPointsPerFrame | 0));
  const out: DrawStreamPointsEvent[] = [];
  let seq = startSeq >>> 0;
  for (let i = 0; i < points.length; i += maxPts) {
    out.push({
      kind: "points",
      seq,
      strokeId,
      points: points.slice(i, i + maxPts),
    });
    seq = (seq + 1) >>> 0;
  }
  return out;
}

export class DrawStreamTracker {
  private state: DrawStreamTrackerState = {
    lastSeq: -1,
    activeStrokeId: null,
    peerActive: false,
  };

  snapshot(): DrawStreamTrackerState {
    return { ...this.state };
  }

  apply(evt: DrawStreamEvent): DrawStreamApplyResult {
    if (evt.seq <= this.state.lastSeq) return { applied: false, reason: "stale-seq" };

    switch (evt.kind) {
      case "begin":
        this.state.activeStrokeId = evt.strokeId;
        this.state.peerActive = true;
        break;
      case "points":
        if (this.state.activeStrokeId !== evt.strokeId) {
          return { applied: false, reason: "invalid-order" };
        }
        this.state.peerActive = true;
        break;
      case "end":
        if (this.state.activeStrokeId !== evt.strokeId) {
          return { applied: false, reason: "invalid-order" };
        }
        this.state.activeStrokeId = null;
        this.state.peerActive = false;
        break;
      case "presence":
        this.state.peerActive = evt.active;
        if (typeof evt.strokeId === "number") this.state.activeStrokeId = evt.strokeId;
        if (!evt.active) this.state.activeStrokeId = null;
        break;
      case "clear":
      case "undo":
      case "redo":
        break;
    }

    this.state.lastSeq = evt.seq;
    return { applied: true };
  }
}
