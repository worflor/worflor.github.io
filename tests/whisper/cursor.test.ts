/**
 * cursor.test.ts — the algebra that makes a truncated frame unreadable.
 *
 * The parsers that read relay-supplied bytes used to carry their own hand-written
 * length checks, and the bug class was simply "someone forgot one". These tests
 * pin the structure that replaced that discipline, so the guarantee lives in one
 * place instead of once per parser:
 *
 *   MONOTONE FAILURE  once a read runs out of bytes the cursor is failed, and
 *                     nothing can un-fail it. This is the load-bearing property:
 *                     safety does not come from short-circuiting (an
 *                     optimisation) but from the flag only ever going one way.
 *   GATED RESULT      finish() is the ONLY way to produce a value, and it
 *                     refuses on a failed cursor, so half-read fields cannot
 *                     escape even if a parser ignores every intermediate result.
 *   HARMLESS ZEROS    a read on a failed cursor returns a benign value rather
 *                     than undefined/NaN. `data[o]` on a short frame gave
 *                     undefined, `1 + undefined * 5` gave NaN, and
 *                     `subarray(NaN)` returned the WHOLE buffer — that chain is
 *                     how a truncated frame came back with the entire frame as
 *                     its ciphertext.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Cursor } from "../../src/scripts/whisper/campfire/cursor.js";

describe("Cursor — the parsing algebra", () => {
  it("reads in sequence while the bytes are there", () => {
    // little-endian throughout: u32 3 is [3,0,0,0], u16 9 is [9,0]
    const c = new Cursor(Uint8Array.from([1, 2, 3, 0, 0, 0, 9, 0, 9]));
    assert.equal(c.u8(), 1);
    assert.equal(c.u8(), 2);
    assert.equal(c.u32(), 3);
    assert.equal(c.u16(), 9);
    assert.equal(c.ok, true);
    assert.deepEqual(Array.from(c.rest()), [9]);
  });

  it("a read past the end fails the cursor instead of throwing or inventing a value", () => {
    for (const read of [
      (c: Cursor) => c.u8(),
      (c: Cursor) => c.u16(),
      (c: Cursor) => c.u32(),
      (c: Cursor) => c.f64(),
      (c: Cursor) => c.bytes(4),
    ]) {
      const c = new Cursor(new Uint8Array(0));
      const v = read(c); // must not throw
      assert.equal(c.ok, false, "the cursor is failed");
      // a benign zero, never undefined/NaN: those are what produced subarray(NaN)
      if (typeof v === "number") assert.ok(Number.isFinite(v) && v === 0, `got ${v}`);
      else assert.equal(v.length, 0);
    }
  });

  it("FAILURE IS MONOTONE: a later in-range read cannot un-fail it", () => {
    // this is the property everything else rests on. short-circuiting is an
    // optimisation; correctness comes from the flag only moving one way.
    const c = new Cursor(new Uint8Array(8));
    c.bytes(99);              // overruns → failed
    assert.equal(c.ok, false);
    c.u8();                   // plenty of bytes remain, but it must stay failed
    c.u32();
    c.bytes(2);
    assert.equal(c.ok, false, "a failed cursor never recovers");
    assert.equal(c.finish({ any: "value" }), null, "and it yields nothing");
  });

  it("finish() is the only exit and it refuses on failure", () => {
    const good = new Cursor(Uint8Array.from([7]));
    assert.deepEqual(good.finish({ v: good.u8() }), { v: 7 });

    const bad = new Cursor(new Uint8Array(0));
    const half = { v: bad.u8() }; // a parser that ignores intermediate state
    assert.equal(bad.finish(half), null, "half-read fields cannot escape");
  });

  it("a dependent length cannot read past the end (the frontier/roster shape)", () => {
    // the exact shape of the bug: a count read FROM the frame decides how much
    // more to read. believing it is how parsePeerList accepted a 3-byte frame
    // claiming 65535 entries.
    const c = new Cursor(Uint8Array.from([0xff, 1, 2, 3]));
    const count = c.u8();          // claims 255 entries
    const body = c.bytes(count * 5);
    assert.equal(count, 255);
    assert.equal(body.length, 0, "the claim is not honoured");
    assert.equal(c.finish({ count, body }), null);
  });

  it("expect() reserves without consuming; expectEnd() rejects trailing bytes", () => {
    const c = new Cursor(new Uint8Array(20));
    c.bytes(4);
    c.expect(16);
    assert.equal(c.ok, true, "exactly enough remains");
    const d = new Cursor(new Uint8Array(19));
    d.bytes(4);
    d.expect(16);
    assert.equal(d.ok, false, "one byte short");

    const e = new Cursor(new Uint8Array(4));
    e.bytes(4);
    e.expectEnd();
    assert.equal(e.ok, true);
    const f = new Cursor(new Uint8Array(5));
    f.bytes(4);
    f.expectEnd();
    assert.equal(f.ok, false, "trailing bytes are a malformed frame");
  });

  it("stays total on adversarial widths", () => {
    for (const n of [-1, 0, 1, 0x7fffffff, Number.MAX_SAFE_INTEGER]) {
      const c = new Cursor(new Uint8Array(8));
      assert.doesNotThrow(() => c.bytes(n), `bytes(${n}) must not throw`);
      if (n !== 0) assert.equal(c.ok, n > 0 && n <= 8, `bytes(${n}) ok-state`);
    }
  });
});
