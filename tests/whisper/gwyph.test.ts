import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GLYPH_MIME, gwyphPngName, isWhisperGlyph, parseGwyphPayload } from "../../src/scripts/whisper/live-gwyph.js";
import { GlyphCodec, GLYPH_CHANNELS } from "../../src/scripts/whisper/live-wasm-glyph.js";
import { encode0D } from "../../src/scripts/whisper/live-wasm-logos.js";

class ByteWriter {
  private data: number[] = [];

  u8(v: number): void { this.data.push(v & 0xff); }

  u16(v: number): void {
    this.data.push(v & 0xff, (v >>> 8) & 0xff);
  }

  u32(v: number): void {
    this.data.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  bytes(raw: ArrayLike<number>): void {
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

function buildMinimalGwyphV3(): Uint8Array {
  const raw = new ByteWriter();
  raw.u8(0); // mode blank
  raw.u16(320);
  raw.u16(240);

  // palette
  raw.varUint(1);
  raw.u8(0xff); raw.u8(0xaa); raw.u8(0x22);

  // one pen stroke
  raw.varUint(1);
  raw.u8(0x00); // pen
  raw.varUint(0); // palette index
  raw.u16(512); // width q8 => 2.0
  raw.varUint(3); // point count

  const CH = GLYPH_CHANNELS;
  // seeds: x, y, p active, rest zero
  const seed0 = [12000, 9000, 32767];
  const seed1 = [14000, 9200, 32000];
  for (let c = 0; c < CH; c++) raw.u16(seed0[c] ?? 0);
  for (let c = 0; c < CH; c++) raw.u16(seed1[c] ?? 0);

  // packed tail from GlyphCodec (point index >= 2)
  const pt2 = [17000, 9800, 30000];
  const q = new Int32Array(3 * CH);
  for (let c = 0; c < CH; c++) {
    q[c] = seed0[c] ?? 0;
    q[CH + c] = seed1[c] ?? 0;
    q[2 * CH + c] = pt2[c] ?? 0;
  }
  const packed = GlyphCodec.pack(GlyphCodec.encode(q));
  raw.varUint(packed.length);
  raw.bytes(packed);

  const rawBytes = raw.finish();
  const compressed = encode0D(rawBytes);

  const out = new ByteWriter();
  out.u8(0x47); out.u8(0x57); out.u8(0x59); out.u8(0x50); // GWYP
  out.u8(3); // version 3
  out.u32(rawBytes.length);
  out.bytes(compressed);
  return out.finish();
}

describe("live-gwyph codec", () => {
  it("rejects malformed payload", () => {
    const bad = new Uint8Array([0, 1, 2, 3, 4]);
    assert.equal(parseGwyphPayload(bad), null);
  });

  it("rejects legacy v1 payload", () => {
    // v1 format is no longer supported — parser should return null
    const w = new ByteWriter();
    w.u8(0x47); w.u8(0x57); w.u8(0x59); w.u8(0x50);
    w.u8(1); // version 1
    w.u8(0); w.u16(320); w.u16(240); w.varUint(0);
    assert.equal(parseGwyphPayload(w.finish()), null);
  });

  it("parses valid compressed gwyph v3 payload", () => {
    const payload = buildMinimalGwyphV3();
    const parsed = parseGwyphPayload(payload);
    assert.ok(parsed);
    assert.equal(parsed.mode, "blank");
    assert.equal(parsed.logicalW, 320);
    assert.equal(parsed.logicalH, 240);
    assert.equal(parsed.strokes.length, 1);
    const stroke = parsed.strokes[0];
    assert.equal(stroke.type, "pen");
    if (stroke.type === "pen") {
      assert.equal(stroke.tool, "pen");
      assert.equal(stroke.color, "#ffaa22");
      assert.equal(stroke.points.length, 3);
      assert.ok(stroke.points[0].x >= 0 && stroke.points[0].x <= 1);
      assert.ok(stroke.points[2].y >= 0 && stroke.points[2].y <= 1);
    }
  });

  it("detects gwyph mime and extension", () => {
    assert.equal(isWhisperGlyph(GLYPH_MIME, "drawing.gwyph"), true);
    assert.equal(isWhisperGlyph("application/octet-stream", "foo.gwyph"), true);
    assert.equal(isWhisperGlyph("image/png", "foo.png"), false);
  });

  it("maps gwyph filenames to png export names", () => {
    assert.equal(gwyphPngName("drawing.gwyph"), "drawing.png");
    assert.equal(gwyphPngName("annotated"), "annotated.png");
    assert.equal(gwyphPngName(".gwyph"), ".gwyph.png");
  });
});
