import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import {
  chunkMessagePrefixed,
  iterateChunksPrefixed,
  estimateChunkedPrefixedSize,
  ChunkAssembler,
  BUFFERED_AMOUNT_LOW,
} from "../../src/scripts/whisper/live-chunking.js";

const CHUNK_SIZE = 15_360;
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

/** Expected chunk count for multi-chunk messages. */
function expectedChunkCount(dataLen: number): number {
  if (dataLen <= CHUNK_SIZE) return 1;
  const startPayload = Math.min(CHUNK_SIZE - 4, dataLen); // 4 bytes for total length
  const remaining = dataLen - startPayload;
  return 1 + Math.ceil(remaining / CHUNK_SIZE);
}

describe("live-chunking", () => {
  it("BUFFERED_AMOUNT_LOW is 64KB", () => {
    assert.equal(BUFFERED_AMOUNT_LOW, 64 * 1024);
  });

  describe("single-chunk messages (≤ 15360 bytes)", () => {
    it("small message returns single chunk with CHUNK_SINGLE type", () => {
      const data = randomBytes(100);
      const prefix = 0x20;
      const chunks = chunkMessagePrefixed(data, prefix);
      assert.equal(chunks.length, 1, "single chunk");
      assert.equal(chunks[0][0], prefix, "prefix byte");
      assert.equal(chunks[0][1], CHUNK_SINGLE, "chunk type = SINGLE (0x04)");
      assert.equal(chunks[0].length, 2 + data.length, "chunk size = prefix + type + data");

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip content");
    });

    it("exactly 15360 bytes returns single chunk", () => {
      const data = randomBytes(CHUNK_SIZE);
      const chunks = chunkMessagePrefixed(data, 0x20);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data);
    });

    it("1 byte returns single chunk", () => {
      const data = randomBytes(1);
      const chunks = chunkMessagePrefixed(data, 0xFF);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0][0], 0xFF, "prefix");
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data);
    });

    it("empty data returns single chunk with 0 data bytes", () => {
      const data = new Uint8Array(0);
      const chunks = chunkMessagePrefixed(data, 0x20);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].length, 2, "just prefix + type");
      assert.equal(chunks[0][1], CHUNK_SINGLE);
      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assert.equal(reassembled.length, 0);
    });
  });

  describe("multi-chunk messages (> 15360 bytes)", () => {
    it("15361 bytes → 2 chunks (START + END)", () => {
      const data = randomBytes(15361);
      const chunks = chunkMessagePrefixed(data, 0x20);
      assert.equal(chunks.length, expectedChunkCount(15361), "chunk count");

      // Verify chunk types
      assert.equal(chunks[0][1], CHUNK_START, "first chunk is START");
      assert.equal(chunks[chunks.length - 1][1], CHUNK_END, "last chunk is END");

      // Verify total length in start chunk header (bytes 2-5, LE)
      const totalLen = new DataView(chunks[0].buffer, chunks[0].byteOffset).getUint32(2, true);
      assert.equal(totalLen, data.length, "total length in START header");

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip 15361B");
    });

    it("30720 bytes → START + CONTINUE + END", () => {
      const data = randomBytes(30720);
      const chunks = chunkMessagePrefixed(data, 0x20);
      assert.equal(chunks.length, expectedChunkCount(30720));
      assert.ok(chunks.length >= 3, `should be ≥3 chunks, got ${chunks.length}`);

      // Verify chunk type sequence
      assert.equal(chunks[0][1], CHUNK_START);
      for (let i = 1; i < chunks.length - 1; i++) {
        assert.equal(chunks[i][1], CHUNK_CONTINUE, `chunk ${i} should be CONTINUE`);
      }
      assert.equal(chunks[chunks.length - 1][1], CHUNK_END);

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip 30720B");
    });

    it("100KB → correct chunk count and round-trip", () => {
      const data = randomBytes(100 * 1024);
      const chunks = chunkMessagePrefixed(data, 0x20);
      const expected = expectedChunkCount(data.length);
      assert.equal(chunks.length, expected, `expected ${expected} chunks for 100KB`);
      assert.ok(chunks.length >= 7, `100KB should need ≥7 chunks`);

      const reassembled = reassemble(chunks);
      assert.ok(reassembled);
      assertBytesEqual(reassembled, data, "round-trip 100KB");
    });

    it("30 random sizes (15361-200000) all round-trip correctly", () => {
      for (let i = 0; i < 30; i++) {
        const size = 15361 + Math.floor(Math.random() * (200000 - 15361));
        const data = randomBytes(size);
        const chunks = chunkMessagePrefixed(data, 0x20);

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
        const data = randomBytes(40000); // multi-chunk
        const chunks = chunkMessagePrefixed(data, prefix);
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
    it("iterateChunksPrefixed matches chunkMessagePrefixed exactly", () => {
      for (const size of [0, 1, 100, 15360, 15361, 30000, 100000]) {
        const data = randomBytes(size);
        const a = chunkMessagePrefixed(data, 0x20);
        const b = Array.from(iterateChunksPrefixed(data, 0x20));
        assert.equal(b.length, a.length, `chunk count mismatch for ${size}`);
        for (let i = 0; i < a.length; i++) {
          assertBytesEqual(b[i], a[i], `chunk ${i} mismatch for ${size}`);
        }
      }
    });

    it("estimateChunkedPrefixedSize equals actual emitted bytes", () => {
      for (const size of [0, 1, 100, 15360, 15361, 30720, 100000, 200000]) {
        const data = randomBytes(size);
        const chunks = chunkMessagePrefixed(data, 0x20);
        let actual = 0;
        for (const chunk of chunks) actual += chunk.byteLength;
        assert.equal(
          estimateChunkedPrefixedSize(data.length),
          actual,
          `byte estimate mismatch for ${size}B`,
        );
      }
    });
  });

  describe("ChunkAssembler", () => {
    it("reset mid-stream then re-feed works", () => {
      const data = randomBytes(20000);
      const chunks = chunkMessagePrefixed(data, 0x20);
      const assembler = new ChunkAssembler();

      // Feed first chunk (start), then reset
      assembler.feed(chunks[0].subarray(1));
      assembler.reset();

      // Feed all chunks fresh
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
      const data1 = randomBytes(20000);
      const data2 = randomBytes(25000);
      const chunks1 = chunkMessagePrefixed(data1, 0x20);
      const chunks2 = chunkMessagePrefixed(data2, 0x20);
      const assembler = new ChunkAssembler();

      // Feed partial of first message
      assembler.feed(chunks1[0].subarray(1));

      // Feed complete second message (start chunk resets assembler state)
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
        const data = randomBytes(20000 + i * 5000);
        const chunks = chunkMessagePrefixed(data, 0x20);
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
        const chunks = chunkMessagePrefixed(data, 0x20);
        assert.equal(chunks.length, 1);
        const result = assembler.feed(chunks[0].subarray(1));
        assert.ok(result, `single chunk ${i} should return immediately`);
        assertBytesEqual(result!, data, `single chunk ${i} content`);
      }
    });

    it("oversized declared totalLen does not cause OOM, and the mismatch is rejected", () => {
      const assembler = new ChunkAssembler();
      // Craft a START chunk claiming totalLen = 4GB but only providing 10 bytes of payload
      const startChunk = new Uint8Array(5 + 10);
      startChunk[0] = CHUNK_START;
      new DataView(startChunk.buffer).setUint32(1, 0xFFFFFFFF, true); // 4GB declared
      for (let i = 0; i < 10; i++) startChunk[5 + i] = 0x41 + i;

      // Should not throw or allocate 4GB — just buffers the 10 actual bytes
      const result = assembler.feed(startChunk);
      assert.equal(result, null, "incomplete multi-chunk returns null");

      // Feed an END chunk with small payload
      const endChunk = new Uint8Array(1 + 5);
      endChunk[0] = CHUNK_END;
      for (let i = 0; i < 5; i++) endChunk[1 + i] = 0x61 + i;

      // actual assembled bytes (15) never match the declared 4GB, so the assembler must
      // drop the message rather than hand a corrupt/truncated buffer to the decrypt path.
      const complete = assembler.feed(endChunk);
      assert.equal(complete, null, "declared/actual length mismatch is dropped, not returned");
    });

    it("mismatched totalLen in header is dropped on CHUNK_END", () => {
      // Build a real multi-chunk message
      const data = randomBytes(20000);
      const chunks = chunkMessagePrefixed(data, 0x20);

      // Corrupt the totalLen in the START chunk to a wrong value
      const startChunk = new Uint8Array(chunks[0].subarray(1)); // strip prefix
      new DataView(startChunk.buffer, startChunk.byteOffset).setUint32(1, 999999, true);

      const assembler = new ChunkAssembler();
      assembler.feed(startChunk);
      for (let i = 1; i < chunks.length; i++) {
        const result = assembler.feed(chunks[i].subarray(1));
        if (i === chunks.length - 1) {
          // CHUNK_END: 20000 assembled bytes != declared 999999, must drop.
          assert.equal(result, null, "corrupted totalLen causes the assembled message to be dropped");
        } else {
          assert.equal(result, null, "intermediate chunks never return early");
        }
      }
    });

    it("valid totalLen still reassembles correctly (declared matches actual)", () => {
      const data = randomBytes(20000);
      const chunks = chunkMessagePrefixed(data, 0x20);
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
      const partial = randomBytes(20000);
      const partialChunks = chunkMessagePrefixed(partial, 0x20);
      const single = randomBytes(50);
      const singleChunks = chunkMessagePrefixed(single, 0x20); // exactly 1 chunk (CHUNK_SINGLE)
      assert.equal(singleChunks.length, 1);

      const assembler = new ChunkAssembler();
      // feed only the START of the large message, leaving the assembler mid-reassembly
      assembler.feed(partialChunks[0].subarray(1));

      // a single-frame message now arrives (e.g. a small text message interleaved
      // with an in-flight file transfer). it must return its own payload immediately
      // and blow away the abandoned partial state, not silently swallow it.
      const result = assembler.feed(singleChunks[0].subarray(1));
      assert.ok(result, "single-frame message returns immediately");
      assertBytesEqual(result!, single, "single-frame content is correct, not merged with the partial");

      // the partial message's remaining chunks, if fed now, must not resurrect old state:
      // there's no START in this tail alone, so continuing it should fail to reassemble.
      let stragglerResult: Uint8Array | null = null;
      for (let i = 1; i < partialChunks.length; i++) {
        stragglerResult = assembler.feed(partialChunks[i].subarray(1));
      }
      assert.equal(stragglerResult, null, "orphaned continuation chunks from the abandoned message go nowhere");
    });
  });
});
