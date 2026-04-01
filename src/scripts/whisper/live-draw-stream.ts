import { GLYPH_CHANNELS, GLYPH_CHANNEL_NAMES, type GlyphChannelName } from "./live-wasm-glyph";

export const DRAW_STREAM_VERSION = 1;

export const DRAW_STREAM_KIND = {
  BEGIN: 0x01,
  GLYPH: 0x02,
  END: 0x03,
  CLEAR: 0x04,
  UNDO: 0x05,
  REDO: 0x06,
  PRESENCE: 0x07,
  BASE_START: 0x08,
  BASE_CHUNK: 0x09,
  BASE_END: 0x0a,
} as const;

type DrawStreamKindCode = typeof DRAW_STREAM_KIND[keyof typeof DRAW_STREAM_KIND];

export type DrawTool = "pen" | "eraser";

// shape derived from codec channel names — add a channel to the codec,
// it appears here automatically
export type DrawNormPoint = Record<GlyphChannelName, number>;

export interface DrawStreamBeginEvent {
  kind: "begin";
  seq: number;
  strokeId: number;
  tool: DrawTool;
  color: string;
  width: number;
  start: DrawNormPoint;
}

export interface DrawStreamGlyphEvent {
  kind: "glyph";
  seq: number;
  strokeId: number;
  data: Uint8Array; // Packed GlyphBlock
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

export type DrawBaseMime = "image/jpeg" | "image/webp" | "image/png";

export interface DrawStreamBaseStartEvent {
  kind: "base-start";
  seq: number;
  snapshotId: number;
  width: number;
  height: number;
  mime: DrawBaseMime;
  chunkCount: number;
}

export interface DrawStreamBaseChunkEvent {
  kind: "base-chunk";
  seq: number;
  snapshotId: number;
  chunkIndex: number;
  data: Uint8Array;
}

export interface DrawStreamBaseEndEvent {
  kind: "base-end";
  seq: number;
  snapshotId: number;
}

export type DrawStreamEvent =
  | DrawStreamBeginEvent
  | DrawStreamGlyphEvent
  | DrawStreamEndEvent
  | DrawStreamClearEvent
  | DrawStreamUndoEvent
  | DrawStreamRedoEvent
  | DrawStreamPresenceEvent
  | DrawStreamBaseStartEvent
  | DrawStreamBaseChunkEvent
  | DrawStreamBaseEndEvent;

/** Distributive Omit — each union member has its own `seq` stripped individually. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DrawStreamEventNoSeq = DistributiveOmit<DrawStreamEvent, "seq">;

export interface DrawStreamApplyResult {
  applied: boolean;
  reason?: "stale-seq" | "invalid-order";
}

export interface DrawStreamTrackerState {
  lastSeq: number;
  activeStrokeId: number | null;
  activeBaseSnapshotId: number | null;
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

function encodeBaseMime(mime: DrawBaseMime): number {
  switch (mime) {
    case "image/jpeg": return 0;
    case "image/webp": return 1;
    case "image/png": return 2;
  }
}

function decodeBaseMime(code: number): DrawBaseMime | null {
  switch (code) {
    case 0: return "image/jpeg";
    case 1: return "image/webp";
    case 2: return "image/png";
    default: return null;
  }
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
      // 14 fixed bytes + 2 bytes per channel
      const out = new Uint8Array(14 + GLYPH_CHANNELS * 2);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.BEGIN, evt.seq);
      view.setUint16(6, evt.strokeId & 0xffff, true);
      view.setUint8(8, TOOL_CODE[evt.tool]);
      const [r, g, b] = encodeHexColorRgb(evt.color);
      view.setUint8(9, r);
      view.setUint8(10, g);
      view.setUint8(11, b);
      view.setUint16(12, Math.round(clamp(evt.width, 0, 655.35) * 100), true);
      for (let c = 0; c < GLYPH_CHANNELS; c++) {
        view.setUint16(14 + c * 2, q16(evt.start[GLYPH_CHANNEL_NAMES[c]]), true);
      }
      return out;
    }
    case "glyph": {
      const out = new Uint8Array(8 + evt.data.length);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.GLYPH, evt.seq);
      view.setUint16(6, evt.strokeId & 0xffff, true);
      out.set(evt.data, 8);
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
    case "base-start": {
      const out = new Uint8Array(15);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.BASE_START, evt.seq);
      view.setUint16(6, evt.snapshotId & 0xffff, true);
      view.setUint16(8, Math.max(1, Math.min(65535, Math.round(evt.width))), true);
      view.setUint16(10, Math.max(1, Math.min(65535, Math.round(evt.height))), true);
      view.setUint8(12, encodeBaseMime(evt.mime));
      view.setUint16(13, Math.max(1, Math.min(65535, evt.chunkCount | 0)), true);
      return out;
    }
    case "base-chunk": {
      const out = new Uint8Array(10 + evt.data.length);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.BASE_CHUNK, evt.seq);
      view.setUint16(6, evt.snapshotId & 0xffff, true);
      view.setUint16(8, evt.chunkIndex & 0xffff, true);
      out.set(evt.data, 10);
      return out;
    }
    case "base-end": {
      const out = new Uint8Array(8);
      const view = new DataView(out.buffer);
      writeBaseHeader(view, DRAW_STREAM_KIND.BASE_END, evt.seq);
      view.setUint16(6, evt.snapshotId & 0xffff, true);
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
      if (bytes.length !== 14 + GLYPH_CHANNELS * 2) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const toolCode = view.getUint8(8);
      const tool: DrawTool | null = toolCode === 0 ? "pen" : (toolCode === 1 ? "eraser" : null);
      if (!tool) return null;
      const color = decodeHexColorRgb(view.getUint8(9), view.getUint8(10), view.getUint8(11));
      const start = {} as DrawNormPoint;
      for (let c = 0; c < GLYPH_CHANNELS; c++) {
        start[GLYPH_CHANNEL_NAMES[c]] = uq16(view.getUint16(14 + c * 2, true));
      }
      return {
        kind: "begin",
        seq,
        strokeId: view.getUint16(6, true),
        tool,
        color,
        width: view.getUint16(12, true) / 100,
        start,
      };
    }
    case DRAW_STREAM_KIND.GLYPH: {
      if (bytes.length < 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        kind: "glyph",
        seq,
        strokeId: view.getUint16(6, true),
        data: bytes.slice(8),
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
    case DRAW_STREAM_KIND.BASE_START: {
      if (bytes.length !== 15) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const mime = decodeBaseMime(view.getUint8(12));
      if (!mime) return null;
      return {
        kind: "base-start",
        seq,
        snapshotId: view.getUint16(6, true),
        width: view.getUint16(8, true),
        height: view.getUint16(10, true),
        mime,
        chunkCount: view.getUint16(13, true),
      };
    }
    case DRAW_STREAM_KIND.BASE_CHUNK: {
      if (bytes.length < 10) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        kind: "base-chunk",
        seq,
        snapshotId: view.getUint16(6, true),
        chunkIndex: view.getUint16(8, true),
        data: bytes.slice(10),
      };
    }
    case DRAW_STREAM_KIND.BASE_END: {
      if (bytes.length !== 8) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { kind: "base-end", seq, snapshotId: view.getUint16(6, true) };
    }
    default:
      return null;
  }
}

export class DrawStreamTracker {
  private state: DrawStreamTrackerState = {
    lastSeq: -1,
    activeStrokeId: null,
    activeBaseSnapshotId: null,
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
      case "glyph":
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
        if (!evt.active) {
          this.state.activeStrokeId = null;
          this.state.activeBaseSnapshotId = null;
        }
        break;
      case "base-start":
        this.state.activeBaseSnapshotId = evt.snapshotId;
        this.state.peerActive = true;
        break;
      case "base-chunk":
        if (this.state.activeBaseSnapshotId !== evt.snapshotId) {
          return { applied: false, reason: "invalid-order" };
        }
        this.state.peerActive = true;
        break;
      case "base-end":
        if (this.state.activeBaseSnapshotId !== evt.snapshotId) {
          return { applied: false, reason: "invalid-order" };
        }
        this.state.activeBaseSnapshotId = null;
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
