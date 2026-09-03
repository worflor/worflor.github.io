import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  chunkMessagePrefixed,
  iterateChunksPrefixed,
  estimateChunkedPrefixedSize,
  ChunkAssembler,
  CHUNK_SIZE,
  BUFFERED_AMOUNT_LOW,
  BUFFERED_AMOUNT_HIGH,
} from "../../src/scripts/whisper/live-chunking.js";

// a small frame size the chunking state machine is exercised at — the real default
// (CHUNK_SIZE) is negotiated up from here and is too big to hit START/CONTINUE/END
// with the modestly sized payloads these tests use.
const SMALL = 15_360;

const CHUNK_SINGLE = 0x04;
const CHUNK_START = 0x01;
const CHUNK_CONTINUE = 0x02;
const CHUNK_END = 0x03;

/** Simulate receiving chunks through a ChunkAssembler (strips 1-byte prefix). */
function reassemble(chunks: Uint8Array[]): Uint8Array | null {
  const assembler = new ChunkAssembler();
  for (const chunk of chunks) {
    const result = assembler.feed(chunk.subarray(1));
    if (result) return result;
  }
  return null;
}

/** Expected chunk count for a payload at a given frame size. */
function expectedChunkCount(dataLen: number, cs = SMALL): number {
  if (dataLen <= cs) return 1;
  const startPayload = Math.min(cs - 4, dataLen); // 4 bytes for total length
  const remaining = dataLen - startPayload;
  return 1 + Math.ceil(remaining / cs);
}

describe("live-chunking", () => {
  it("backpressure thresholds have hysteresis (low-water below high-water)", () => {
    assert.ok(BUFFERED_AMOUNT_LOW > 0);
    assert.ok(BUFFERED_AMOUNT_HIGH > BUFFERED_AMOUNT_LOW,
      `high-water ${BUFFERED_AMOUNT_HIGH} must exceed low-water ${BUFFERED_AMOUNT_LOW}`);
  });

  it("the default CHUNK_SIZE stays under the RFC 8841 assumed 64 KB max-message-size", () => {
    assert.ok(CHUNK_SIZE + 6 <= 65_536, `${CHUNK_SIZE} + 6-byte header exceeds 64 KB`);
  });

  describe("single-frame messages (payload ≤ frame size)", () => {
    it("small message returns single chunk with CHUNK_SINGLE type", () => {
      const data = randomBytes(100);
      const prefix = 0x20;
      const chunks = chunkMessagePrefixed(data, prefix, SMALL);
      assert.equal(chunks.length, 1, "single chunk");
      assert.equal(chunks[0][0], prefix, "prefix byte");
      assert.equal(chunks[0][1], CHUNK_SINGLE, "chunk type = SINGLE (0x04)");
      assert.equal(chunks[0].length, 2 + data.length, "chunk size = prefix + type + data");

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip content");
    });

    it("exactly the frame size returns a single chunk", () => {
      const data = randomBytes(SMALL);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data);
    });

    it("1 byte returns single chunk", () => {
      const data = randomBytes(1);
      const chunks = chunkMessagePrefixed(data, 0xFF, SMALL);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0][0], 0xFF, "prefix");
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data);
    });

    it("empty data returns single chunk with 0 data bytes", () => {
      const data = new Uint8Array(0);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].length, 2, "just prefix + type");
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assert.equal(reassembled.length, 0);
    });
  });

  describe("multi-frame messages (payload > frame size)", () => {
    it("one byte over the frame size → 2 chunks (START + END)", () => {
      const data = randomBytes(SMALL + 1);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      assert.equal(chunks.length, expectedChunkCount(SMALL + 1), "chunk count");

      assert.equal(chunks[0][1], CHUNK_START, "first chunk is START");
      assert.equal(chunks[chunks.length - 1][1], CHUNK_END, "last chunk is END");

      const totalLen = new DataView(chunks[0].buffer, chunks[0].byteOffset).getUint32(2, true);
      assert.equal(totalLen, data.length, "total length in START header");

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip");
    });

    it("two frames' worth → START + CONTINUE + END", () => {
      const data = randomBytes(SMALL * 2);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      assert.equal(chunks.length, expectedChunkCount(SMALL * 2));
      assert.ok(chunks.length >= 3, `should be ≥3 chunks, got ${chunks.length}`);

      assert.equal(chunks[0][1], CHUNK_START);
      for (let i = 1; i < chunks.length - 1; i++) {
        assert.equal(chunks[i][1], CHUNK_CONTINUE, `chunk ${i} should be CONTINUE`);
      }
      assert.equal(chunks[chunks.length - 1][1], CHUNK_END);

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip");
    });

    it("~7 frames → correct chunk count and round-trip", () => {
      const data = randomBytes(SMALL * 6 + 500);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      const expected = expectedChunkCount(data.length);
      assert.equal(chunks.length, expected, `expected ${expected} chunks`);
      assert.ok(chunks.length >= 7, `should need ≥7 chunks, got ${chunks.length}`);

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip");
    });

    it("30 random sizes all round-trip correctly", () => {
      for (let i = 0; i < 30; i++) {
        const size = SMALL + 1 + Math.floor(Math.random() * (SMALL * 12));
        const data = randomBytes(size);
        const chunks = chunkMessagePrefixed(data, 0x20, SMALL);

        assert.equal(chunks.length, expectedChunkCount(size),
          `chunk count for ${size}B iter ${i}`);

        const reassembled = reassemble(chunks);
        assert.ok(reassembled, `reassembly returned null for ${size}B iter ${i}`);
        assertBytesEqual(reassembled, data, `round-trip ${size}B iter ${i}`);
      }
    });
  });

  describe("prefix byte", () => {
    it("all chunks carry the specified prefix byte", () => {
      for (const prefix of [0x00, 0x20, 0x42, 0xFF]) {
        const data = randomBytes(SMALL * 3); // multi-chunk
        const chunks = chunkMessagePrefixed(data, prefix, SMALL);
        for (let i = 0; i < chunks.length; i++) {
          assert.equal(chunks[i][0], prefix,
            `chunk ${i} prefix should be 0x${prefix.toString(16)}`);
        }
      }
    });

    it("single-chunk message has correct prefix", () => {
      const data = randomBytes(100);
      for (const prefix of [0x00, 0x50, 0xFF]) {
        const chunks = chunkMessagePrefixed(data, prefix);
        assert.equal(chunks[0][0], prefix);
      }
    });
  });

  describe("streaming helpers", () => {
    it("iterateChunksPrefixed matches chunkMessagePrefixed exactly, at any frame size", () => {
      for (const cs of [SMALL, CHUNK_SIZE, 200_000]) {
        for (const size of [0, 1, 100, cs, cs + 1, cs * 2 + 7, cs * 5]) {
          const data = randomBytes(size);
          const a = chunkMessagePrefixed(data, 0x20, cs);
          const b = Array.from(iterateChunksPrefixed(data, 0x20, cs));
          assert.equal(b.length, a.length, `chunk count mismatch for ${size} @ cs=${cs}`);
          for (let i = 0; i < a.length; i++) {
            assertBytesEqual(b[i], a[i], `chunk ${i} mismatch for ${size} @ cs=${cs}`);
          }
        }
      }
    });

    it("estimateChunkedPrefixedSize equals actual emitted bytes, at any frame size", () => {
      for (const cs of [SMALL, CHUNK_SIZE, 200_000]) {
        for (const size of [0, 1, 100, cs, cs + 1, cs * 2, cs * 6 + 1]) {
          const data = randomBytes(size);
          const chunks = chunkMessagePrefixed(data, 0x20, cs);
          let actual = 0;
          for (const chunk of chunks) actual += chunk.byteLength;
          assert.equal(
            estimateChunkedPrefixedSize(data.length, cs),
            actual,
            `byte estimate mismatch for ${size}B @ cs=${cs}`,
          );
        }
      }
    });

    it("estimateChunkedPrefixedSize defaults to the module CHUNK_SIZE", () => {
      const data = randomBytes(CHUNK_SIZE * 3 + 11);
      const chunks = chunkMessagePrefixed(data, 0x20); // default size
      const actual = chunks.reduce((n, c) => n + c.byteLength, 0);
      assert.equal(estimateChunkedPrefixedSize(data.length), actual);
    });
  });

  describe("ChunkAssembler", () => {
    it("reset mid-stream then re-feed works", () => {
      const data = randomBytes(SMALL * 2);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      const assembler = new ChunkAssembler();

      assembler.feed(chunks[0].subarray(1));
      assembler.reset();

      for (const chunk of chunks) {
        const result = assembler.feed(chunk.subarray(1));
        if (result) {
          assertBytesEqual(result, data, "round-trip after reset");
          return;
        }
      }
      assert.fail("should have reassembled after reset");
    });

    it("orphan continue/end without start returns null", () => {
      const assembler = new ChunkAssembler();
      assert.equal(assembler.feed(new Uint8Array([CHUNK_CONTINUE, 0x41, 0x42])), null);
      assert.equal(assembler.feed(new Uint8Array([CHUNK_END, 0x41, 0x42])), null);
    });

    it("interleaved messages: second start resets state", () => {
      const data1 = randomBytes(SMALL * 2);
      const data2 = randomBytes(SMALL * 2 + 5000);
      const chunks1 = chunkMessagePrefixed(data1, 0x20, SMALL);
      const chunks2 = chunkMessagePrefixed(data2, 0x20, SMALL);
      const assembler = new ChunkAssembler();

      assembler.feed(chunks1[0].subarray(1)); // partial of the first message

      let result: Uint8Array | null = null;
      for (const chunk of chunks2) {
        const r = assembler.feed(chunk.subarray(1));
        if (r) { result = r; break; }
      }
      assert.ok(result, "should reassemble second message");
      assertBytesEqual(result!, data2, "second message content");
    });

    it("multiple complete messages in sequence", () => {
      const assembler = new ChunkAssembler();
      for (let i = 0; i < 5; i++) {
        const data = randomBytes(SMALL * 2 + i * 5000);
        const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
        let result: Uint8Array | null = null;
        for (const chunk of chunks) {
          const r = assembler.feed(chunk.subarray(1));
          if (r) { result = r; break; }
        }
        assert.ok(result, `message ${i} should reassemble`);
        assertBytesEqual(result!, data, `message ${i} content`);
      }
    });

    it("single-chunk messages pass through directly", () => {
      const assembler = new ChunkAssembler();
      for (let i = 0; i < 10; i++) {
        const data = randomBytes(100 + i * 50);
        const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
        assert.equal(chunks.length, 1);
        const result = assembler.feed(chunks[0].subarray(1));
        assert.ok(result, `single chunk ${i} should return immediately`);
        assertBytesEqual(result!, data, `single chunk ${i} content`);
      }
    });

    it("oversized declared totalLen does not cause OOM, and the mismatch is rejected", () => {
      const assembler = new ChunkAssembler();
      const startChunk = new Uint8Array(5 + 10);
      startChunk[0] = CHUNK_START;
      new DataView(startChunk.buffer).setUint32(1, 0xFFFFFFFF, true); // 4GB declared
      for (let i = 0; i < 10; i++) startChunk[5 + i] = 0x41 + i;

      const result = assembler.feed(startChunk);
      assert.equal(result, null, "incomplete multi-chunk returns null");

      const endChunk = new Uint8Array(1 + 5);
      endChunk[0] = CHUNK_END;
      for (let i = 0; i < 5; i++) endChunk[1 + i] = 0x61 + i;

      const complete = assembler.feed(endChunk);
      assert.equal(complete, null, "declared/actual length mismatch is dropped, not returned");
    });

    it("mismatched totalLen in header is dropped on CHUNK_END", () => {
      const data = randomBytes(SMALL * 2);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);

      const startChunk = new Uint8Array(chunks[0].subarray(1)); // strip prefix
      new DataView(startChunk.buffer, startChunk.byteOffset).setUint32(1, 999999, true);

      const assembler = new ChunkAssembler();
      assembler.feed(startChunk);
      for (let i = 1; i < chunks.length; i++) {
        const result = assembler.feed(chunks[i].subarray(1));
        if (i === chunks.length - 1) {
          assert.equal(result, null, "corrupted totalLen causes the assembled message to be dropped");
        } else {
          assert.equal(result, null, "intermediate chunks never return early");
        }
      }
    });

    it("valid totalLen still reassembles correctly (declared matches actual)", () => {
      const data = randomBytes(SMALL * 2);
      const chunks = chunkMessagePrefixed(data, 0x20, SMALL);
      const assembler = new ChunkAssembler();
      let result: Uint8Array | null = null;
      for (const chunk of chunks) {
        result = assembler.feed(chunk.subarray(1));
        if (result) break;
      }
      assert.ok(result, "should reassemble when declared length matches actual");
      assertBytesEqual(result!, data, "content matches");
    });

    it("CHUNK_SINGLE arriving mid-reassembly resets in-progress state instead of merging", () => {
      const partial = randomBytes(SMALL * 2);
      const partialChunks = chunkMessagePrefixed(partial, 0x20, SMALL);
      const single = randomBytes(50);
      const singleChunks = chunkMessagePrefixed(single, 0x20, SMALL);
      assert.equal(singleChunks.length, 1);

      const assembler = new ChunkAssembler();
      assembler.feed(partialChunks[0].subarray(1)); // START only, mid-reassembly

      const result = assembler.feed(singleChunks[0].subarray(1));
      assert.ok(result, "single-frame message returns immediately");
      assertBytesEqual(result!, single, "single-frame content is correct, not merged with the partial");

      let stragglerResult: Uint8Array | null = null;
      for (let i = 1; i < partialChunks.length; i++) {
        stragglerResult = assembler.feed(partialChunks[i].subarray(1));
      }
      assert.equal(stragglerResult, null, "orphaned continuation chunks from the abandoned message go nowhere");
    });
  });
});
