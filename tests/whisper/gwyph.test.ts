import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GLYPH_MIME, gwyphPngName, isWhisperGlyph, parseGwyphPayload } from "../../src/scripts/whisper/live-gwyph.js";

class ByteWriter {
  private data: number[] = [];

  u8(v: number): void { this.data.push(v & 0xff); }

  u16(v: number): void {
    this.data.push(v & 0xff, (v >>> 8) & 0xff);
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

function buildMinimalGwyph(): Uint8Array {
  const w = new ByteWriter();
  w.u8(0x47); w.u8(0x57); w.u8(0x59); w.u8(0x50); // GWYP
  w.u8(1); // version
  w.u8(0); // mode blank
  w.u16(320);
  w.u16(240);
  w.varUint(1); // stroke count

  // pen stroke with one point
  w.u8(0); // pen tag
  w.u8(0); // tool pen
  w.u8(0xff); w.u8(0xaa); w.u8(0x22); // rgb
  w.u16(512); // width q8 => 2.0
  w.varUint(1); // point count
  w.u16(16384); // x
  w.u16(8192);  // y
  w.u16(32767); // p

  return w.finish();
}

describe("live-gwyph codec", () => {
  it("parses valid gwyph payload", () => {
    const payload = buildMinimalGwyph();
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
      assert.equal(stroke.points.length, 1);
      assert.ok(stroke.points[0].x > 0 && stroke.points[0].x < 1);
      assert.ok(stroke.points[0].y > 0 && stroke.points[0].y < 1);
    }
  });

  it("rejects malformed payload", () => {
    const bad = new Uint8Array([0, 1, 2, 3, 4]);
    assert.equal(parseGwyphPayload(bad), null);
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
