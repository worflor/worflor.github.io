import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, offCurveP256PubKey, generateTestData } from "./_helpers/generators.js";
import {
  HEADER_SIZE,
  HEADER_SIZE_COMPACT,
  LIVE_FLAG_SAME_KEY,
  buildHeader,
  buildNonce,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
  encodeFilePartPlaintext,
  decodeFilePartPlaintext,
} from "../../src/scripts/whisper/live-wire.js";

function randomSalt(): Uint8Array { return randomBytes(4); }

describe("live-wire", () => {
  it("HEADER_SIZE is 46, HEADER_SIZE_COMPACT is 13", () => {
    assert.equal(HEADER_SIZE, 46);
    assert.equal(HEADER_SIZE_COMPACT, 13);
  });

  describe("buildNonce", () => {
    it("produces 12 bytes with correct layout", () => {
      const salt = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
      const nonce = buildNonce(0x04030201, 1, salt);
      assert.equal(nonce.length, 12);
      // [0..3] counter LE
      assert.equal(nonce[0], 0x01);
      assert.equal(nonce[1], 0x02);
      assert.equal(nonce[2], 0x03);
      assert.equal(nonce[3], 0x04);
      // [4] dirBit
      assert.equal(nonce[4], 1);
      // [5..8] salt
      assertBytesEqual(nonce.subarray(5, 9), salt, "salt in nonce");
      // [9..11] zero padding
      assert.equal(nonce[9], 0);
      assert.equal(nonce[10], 0);
      assert.equal(nonce[11], 0);
    });

    it("different counters produce different nonces", () => {
      const salt = randomSalt();
      const a = buildNonce(0, 0, salt);
      const b = buildNonce(1, 0, salt);
      assert.notDeepStrictEqual(a, b);
    });

    it("different dirBits produce different nonces", () => {
      const salt = randomSalt();
      const a = buildNonce(42, 0, salt);
      const b = buildNonce(42, 1, salt);
      assert.notDeepStrictEqual(a, b);
    });

    it("different salts produce different nonces", () => {
      const a = buildNonce(42, 0, new Uint8Array([1, 2, 3, 4]));
      const b = buildNonce(42, 0, new Uint8Array([5, 6, 7, 8]));
      assert.notDeepStrictEqual(a, b);
    });
  });

  describe("full header buildHeader/parseHeader", () => {
    it("round-trip 100 random iterations with content verification", () => {
      for (let i = 0; i < 100; i++) {
        // Mask out SAME_KEY bit so we get full headers
        const flags = Math.floor(Math.random() * 256) & ~LIVE_FLAG_SAME_KEY;
        const pubKey = offCurveP256PubKey();
        const counter = Math.floor(Math.random() * 0xFFFFFFFF);
        const prevChainLen = Math.floor(Math.random() * 0xFFFFFFFF);
        const salt = randomSalt();

        const header = buildHeader(flags, pubKey, counter, prevChainLen, salt);
        assert.equal(header.length, HEADER_SIZE, `header size iter ${i}`);

        // Append random ciphertext
        const ctLen = Math.floor(Math.random() * 500) + 16;
        const ciphertext = randomBytes(ctLen);
        const packet = new Uint8Array(HEADER_SIZE + ctLen);
        packet.set(header, 0);
        packet.set(ciphertext, HEADER_SIZE);

        const parsed = parseHeader(packet);
        assert.equal(parsed.flags, flags, `flags iter ${i}`);
        assert.ok(parsed.pubKey !== null, `pubKey not null iter ${i}`);
        assertBytesEqual(parsed.pubKey!, pubKey, `pubKey iter ${i}`);
        assert.equal(parsed.counter, counter, `counter iter ${i}`);
        assert.equal(parsed.prevChainLen, prevChainLen, `prevChainLen iter ${i}`);
        assertBytesEqual(parsed.salt, salt, `salt iter ${i}`);
        assertBytesEqual(parsed.ciphertext, ciphertext, `ciphertext iter ${i}`);
      }
    });

    it("header byte layout matches spec", () => {
      const flags = 0xA3;
      const pubKey = offCurveP256PubKey();
      const counter = 0x04030201;
      const prevChainLen = 0x08070605;
      const salt = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);

      const header = buildHeader(flags, pubKey, counter, prevChainLen, salt);

      // [0] flags
      assert.equal(header[0], 0xA3, "flags byte");
      // [1..33] pubKey
      assertBytesEqual(header.subarray(1, 34), pubKey, "pubKey position");
      // [34..37] counter (LE)
      assert.equal(header[34], 0x01);
      assert.equal(header[35], 0x02);
      assert.equal(header[36], 0x03);
      assert.equal(header[37], 0x04);
      // [38..41] prevChainLen (LE)
      assert.equal(header[38], 0x05);
      assert.equal(header[39], 0x06);
      assert.equal(header[40], 0x07);
      assert.equal(header[41], 0x08);
      // [42..45] salt
      assertBytesEqual(header.subarray(42, 46), salt, "salt position");
    });

    it("boundary flags values (excluding SAME_KEY bit)", () => {
      for (const flags of [0, 1, 0x07, 0x70, 0xF7]) {
        const header = buildHeader(flags, offCurveP256PubKey(), 0, 0, randomSalt());
        const parsed = parseHeader(header);
        assert.equal(parsed.flags, flags, `flags=0x${flags.toString(16)}`);
      }
    });

    it("boundary counter/prevChainLen values", () => {
      for (const val of [0, 1, 0xFFFF, 0xFFFFFFFF]) {
        const header = buildHeader(0, offCurveP256PubKey(), val, val, randomSalt());
        const parsed = parseHeader(header);
        assert.equal(parsed.counter, val, `counter=${val}`);
        assert.equal(parsed.prevChainLen, val, `prevChainLen=${val}`);
      }
    });
  });

  describe("compact header (SAME_KEY)", () => {
    it("round-trip 100 random compact headers", () => {
      for (let i = 0; i < 100; i++) {
        const baseFlags = Math.floor(Math.random() * 256);
        const flags = baseFlags | LIVE_FLAG_SAME_KEY;
        const counter = Math.floor(Math.random() * 0xFFFFFFFF);
        const prevChainLen = Math.floor(Math.random() * 0xFFFFFFFF);
        const salt = randomSalt();

        const header = buildHeader(flags, new Uint8Array(0), counter, prevChainLen, salt);
        assert.equal(header.length, HEADER_SIZE_COMPACT, `compact header size iter ${i}`);

        const ctLen = Math.floor(Math.random() * 500) + 16;
        const ciphertext = randomBytes(ctLen);
        const packet = new Uint8Array(HEADER_SIZE_COMPACT + ctLen);
        packet.set(header, 0);
        packet.set(ciphertext, HEADER_SIZE_COMPACT);

        const parsed = parseHeader(packet);
        assert.equal(parsed.flags, flags, `flags iter ${i}`);
        assert.equal(parsed.pubKey, null, `pubKey null iter ${i}`);
        assert.equal(parsed.counter, counter, `counter iter ${i}`);
        assert.equal(parsed.prevChainLen, prevChainLen, `prevChainLen iter ${i}`);
        assertBytesEqual(parsed.salt, salt, `salt iter ${i}`);
        assertBytesEqual(parsed.ciphertext, ciphertext, `ciphertext iter ${i}`);
      }
    });

    it("compact header byte layout", () => {
      const flags = 0x08 | 0x01; // SAME_KEY + FILE
      const counter = 0x04030201;
      const prevChainLen = 0x08070605;
      const salt = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);

      const header = buildHeader(flags, new Uint8Array(0), counter, prevChainLen, salt);
      assert.equal(header.length, 13);

      // [0] flags
      assert.equal(header[0], flags);
      // [1..4] counter (LE)
      assert.equal(header[1], 0x01);
      assert.equal(header[2], 0x02);
      assert.equal(header[3], 0x03);
      assert.equal(header[4], 0x04);
      // [5..8] prevChainLen (LE)
      assert.equal(header[5], 0x05);
      assert.equal(header[6], 0x06);
      assert.equal(header[7], 0x07);
      assert.equal(header[8], 0x08);
      // [9..12] salt
      assertBytesEqual(header.subarray(9, 13), salt, "salt position");
    });

    it("compact header saves 33 bytes vs full header", () => {
      const salt = randomSalt();
      const full = buildHeader(0, offCurveP256PubKey(), 42, 10, salt);
      const compact = buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), 42, 10, salt);
      assert.equal(full.length - compact.length, 33);
    });

    it("empty ciphertext with compact header", () => {
      const header = buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), 0, 0, randomSalt());
      assert.equal(header.length, 13);
      const parsed = parseHeader(header);
      assert.equal(parsed.ciphertext.length, 0);
      assert.equal(parsed.pubKey, null);
    });
  });

  describe("buildHeader rejection", () => {
    it("rejects wrong pubKey length (full header)", () => {
      assert.throws(() => buildHeader(0, new Uint8Array(32), 0, 0, randomSalt()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(34), 0, 0, randomSalt()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(0), 0, 0, randomSalt()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(65), 0, 0, randomSalt()), /invalid ratchet pubkey/);
    });

    it("compact header ignores pubKey (any length accepted)", () => {
      assert.doesNotThrow(() => buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), 0, 0, randomSalt()));
      assert.doesNotThrow(() => buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(99), 0, 0, randomSalt()));
    });

    it("rejects wrong salt length (both formats)", () => {
      assert.throws(() => buildHeader(0, offCurveP256PubKey(), 0, 0, new Uint8Array(3)), /invalid salt/);
      assert.throws(() => buildHeader(0, offCurveP256PubKey(), 0, 0, new Uint8Array(5)), /invalid salt/);
      assert.throws(() => buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), 0, 0, new Uint8Array(3)), /invalid salt/);
    });
  });

  describe("minimum packet (header only, empty ciphertext)", () => {
    it("parseHeader returns empty ciphertext for 46-byte full packet", () => {
      const header = buildHeader(0, offCurveP256PubKey(), 0, 0, randomSalt());
      assert.equal(header.length, 46);
      const parsed = parseHeader(header);
      assert.equal(parsed.ciphertext.length, 0, "empty ciphertext");
      assert.equal(parsed.flags, 0);
      assert.equal(parsed.counter, 0);
      assert.equal(parsed.prevChainLen, 0);
    });

    it("parseHeader throws on severely undersized full-header packets", () => {
      for (const size of [0, 1, 10, 33]) {
        const packet = randomBytes(size);
        packet[0] = packet[0] & ~LIVE_FLAG_SAME_KEY;
        assert.throws(
          () => parseHeader(packet),
          `${size}-byte packet should throw (DataView out of bounds)`,
        );
      }
    });

    it("parseHeader throws on undersized compact-header packets", () => {
      for (const size of [1, 5, 8]) {
        const packet = randomBytes(size);
        packet[0] = packet[0] | LIVE_FLAG_SAME_KEY;
        assert.throws(
          () => parseHeader(packet),
          `${size}-byte compact packet should throw`,
        );
      }
    });
  });

  describe("nonce reconstruction round-trip", () => {
    it("sender and receiver reconstruct same nonce from header fields", () => {
      for (let i = 0; i < 50; i++) {
        const counter = Math.floor(Math.random() * 0xFFFFFFFF);
        const senderDirBit = Math.random() > 0.5 ? 0 : 1;
        const receiverDirBit = senderDirBit; // receiver uses sender's dirBit
        const salt = randomSalt();

        const senderNonce = buildNonce(counter, senderDirBit, salt);
        // Simulate: receiver reads counter and salt from parsed header
        const receiverNonce = buildNonce(counter, receiverDirBit, salt);
        assertBytesEqual(senderNonce, receiverNonce, `nonce match iter ${i}`);
      }
    });

    it("full header → parse → reconstruct nonce", () => {
      const counter = 42;
      const salt = randomSalt();
      const dirBit = 0;
      const header = buildHeader(0, offCurveP256PubKey(), counter, 0, salt);
      const parsed = parseHeader(header);
      const nonce = buildNonce(parsed.counter, dirBit, parsed.salt);
      const expected = buildNonce(counter, dirBit, salt);
      assertBytesEqual(nonce, expected, "reconstructed nonce matches");
    });

    it("compact header → parse → reconstruct nonce", () => {
      const counter = 99;
      const salt = randomSalt();
      const dirBit = 1;
      const header = buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), counter, 0, salt);
      const parsed = parseHeader(header);
      const nonce = buildNonce(parsed.counter, dirBit, parsed.salt);
      const expected = buildNonce(counter, dirBit, salt);
      assertBytesEqual(nonce, expected, "reconstructed nonce matches");
    });
  });

  describe("encodeFilePlaintext/decodeFilePlaintext", () => {
    it("round-trip with various file types", () => {
      const cases = [
        { name: "test.txt", type: "text/plain", data: generateTestData(100, "text") },
        { name: "日本語.pdf", type: "application/pdf", data: generateTestData(50, "random") },
        { name: "empty", type: "", data: new Uint8Array(0) },
        { name: "big.bin", type: "application/octet-stream", data: generateTestData(10000, "random") },
        { name: "image.png", type: "image/png", data: generateTestData(500, "pattern") },
      ];

      for (const c of cases) {
        const encoded = encodeFilePlaintext(c.name, c.type, c.data);
        const decoded = decodeFilePlaintext(encoded);
        assert.equal(decoded.fileType, c.type, `fileType for ${c.name}`);
        assertBytesEqual(decoded.fileBytes, c.data, `fileBytes for ${c.name}`);
      }
    });

    it("round-trip 20 random files with random names and data", () => {
      for (let i = 0; i < 20; i++) {
        const nameLen = 1 + Math.floor(Math.random() * 50);
        const name = `file${i}_${"a".repeat(nameLen)}.dat`;
        const type = `application/x-test-${i}`;
        const dataLen = Math.floor(Math.random() * 5000);
        const data = randomBytes(dataLen);

        const encoded = encodeFilePlaintext(name, type, data);
        const decoded = decodeFilePlaintext(encoded);
        assert.equal(decoded.fileType, type, `type iter ${i}`);
        assertBytesEqual(decoded.fileBytes, data, `data iter ${i} (${dataLen}B)`);
      }
    });

    it("decodeFilePlaintext rejects payload too short", () => {
      assert.throws(() => decodeFilePlaintext(new Uint8Array(0)));
      assert.throws(() => decodeFilePlaintext(new Uint8Array(4)));
    });

    it("decodeFilePlaintext rejects nameLen exceeding payload", () => {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setUint32(0, 1000, true);
      assert.throws(() => decodeFilePlaintext(buf));
    });
  });

  describe("sanitizeFileName", () => {
    it("Windows reserved names are defused with underscore prefix", () => {
      const reservedNames = ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"];
      for (const name of reservedNames) {
        const encoded = encodeFilePlaintext(name, "text/plain", new Uint8Array([0x41]));
        const decoded = decodeFilePlaintext(encoded);
        assert.ok(!(/^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(decoded.fileName)),
          `${name} should be defused, got: ${decoded.fileName}`);
        assert.ok(decoded.fileName.startsWith("_"),
          `${name} should be prefixed with _, got: ${decoded.fileName}`);
      }
    });

    it("Windows reserved with extension also defused", () => {
      for (const name of ["CON.txt", "PRN.log", "NUL.dat"]) {
        const encoded = encodeFilePlaintext(name, "text/plain", new Uint8Array([0x41]));
        const decoded = decodeFilePlaintext(encoded);
        assert.ok(decoded.fileName.startsWith("_"),
          `${name} → ${decoded.fileName} should start with _`);
      }
    });

    it("path traversal: forward and back slashes neutralized", () => {
      const encoded = encodeFilePlaintext("../../../etc/passwd", "text/plain", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.ok(!decoded.fileName.includes("/"), `no forward slash: ${decoded.fileName}`);
      assert.ok(!decoded.fileName.includes("\\"), `no backslash: ${decoded.fileName}`);
    });

    it("control chars stripped", () => {
      const encoded = encodeFilePlaintext("file\x00\x01\x1fname", "text/plain", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.ok(!(/[\x00-\x1f\x7f]/.test(decoded.fileName)),
        `control chars stripped: ${JSON.stringify(decoded.fileName)}`);
    });

    it("Windows-illegal chars replaced", () => {
      const encoded = encodeFilePlaintext('file<>:"|?*name', "text/plain", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.ok(!(/[<>:"|?*]/.test(decoded.fileName)),
        `illegal chars replaced: ${decoded.fileName}`);
    });

    it("trailing dots and whitespace removed", () => {
      const encoded = encodeFilePlaintext("file...", "text/plain", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.ok(!decoded.fileName.endsWith("."),
        `trailing dots removed: ${decoded.fileName}`);
    });

    it("empty name after sanitization returns 'file'", () => {
      const encoded = encodeFilePlaintext("\x00\x01", "text/plain", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.equal(decoded.fileName, "file", "empty name defaults to 'file'");
    });

    it("normal filenames pass through unchanged", () => {
      for (const name of ["hello.txt", "document.pdf", "photo.jpg", "data_2024.csv"]) {
        const encoded = encodeFilePlaintext(name, "text/plain", new Uint8Array([0x41]));
        const decoded = decodeFilePlaintext(encoded);
        assert.equal(decoded.fileName, name, `${name} unchanged`);
      }
    });

    it("Unicode filenames preserved", () => {
      const name = "日本語ファイル.pdf";
      const encoded = encodeFilePlaintext(name, "application/pdf", new Uint8Array([0x41]));
      const decoded = decodeFilePlaintext(encoded);
      assert.equal(decoded.fileName, name, "Unicode preserved");
    });
  });

  describe("FILE_PART header (encodeFilePartPlaintext/decodeFilePartPlaintext)", () => {
    it("round-trips chunk 0 with name/type/data", () => {
      const data = randomBytes(1000);
      const encoded = encodeFilePartPlaintext(42, 0, 3, 50000, data, "video.mp4", "video/mp4");
      const decoded = decodeFilePartPlaintext(encoded);
      assert.equal(decoded.transferId, 42);
      assert.equal(decoded.chunkIndex, 0);
      assert.equal(decoded.totalChunks, 3);
      assert.equal(decoded.totalFileSize, 50000);
      assert.equal(decoded.fileName, "video.mp4");
      assert.equal(decoded.fileType, "video/mp4");
      assertBytesEqual(decoded.chunkData, data, "chunk 0 data");
    });

    it("round-trips a non-zero chunk index without name/type fields", () => {
      const data = randomBytes(500);
      const encoded = encodeFilePartPlaintext(42, 2, 3, 50000, data);
      const decoded = decodeFilePartPlaintext(encoded);
      assert.equal(decoded.chunkIndex, 2);
      assert.equal(decoded.fileName, undefined);
      assertBytesEqual(decoded.chunkData, data, "chunk 2 data");
    });

    it("rejects totalChunks = 0, a zero-chunk transfer would strand an IncomingFileTransfer forever", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 0, 100, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalChunks/);
    });

    it("rejects chunkIndex >= totalChunks", () => {
      const encoded = encodeFilePartPlaintext(1, 5, 3, 100, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /chunkIndex/);
    });

    it("accepts chunkIndex === totalChunks - 1 (the last valid chunk)", () => {
      const encoded = encodeFilePartPlaintext(1, 2, 3, 100, randomBytes(10));
      const decoded = decodeFilePartPlaintext(encoded);
      assert.equal(decoded.chunkIndex, 2);
    });

    it("rejects NaN totalFileSize", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 1, NaN, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalFileSize/);
    });

    it("rejects negative totalFileSize", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 1, -5, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalFileSize/);
    });

    it("rejects Infinity totalFileSize", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 1, Infinity, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalFileSize/);
    });

    it("rejects totalFileSize beyond 2^53", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 1, 2 ** 53 + 1024, randomBytes(10));
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalFileSize/);
    });

    it("accepts totalFileSize exactly at 2^53 (the documented boundary)", () => {
      const encoded = encodeFilePartPlaintext(1, 0, 1, 2 ** 53, randomBytes(10));
      const decoded = decodeFilePartPlaintext(encoded);
      assert.equal(decoded.totalFileSize, 2 ** 53);
    });

    it("all validation runs before any transfer state would be created (chunk 0, totalChunks 0)", () => {
      // the pathological combination the audit called out directly: chunk 0 of a
      // declared-zero-chunk transfer must never reach live.ts's handleFilePartMessage
      // in a way that creates an IncomingFileTransfer.
      const encoded = encodeFilePartPlaintext(7, 0, 0, 0, randomBytes(1), "x.bin", "application/octet-stream");
      assert.throws(() => decodeFilePartPlaintext(encoded), /totalChunks/);
    });

    it("groupCount defaults to 1 (a lone file is a group of one) and round-trips on chunk 0", () => {
      const loneDefault = decodeFilePartPlaintext(encodeFilePartPlaintext(1, 0, 1, 10, randomBytes(4), "a.bin", ""));
      assert.equal(loneDefault.groupCount, 1);
      for (const gc of [1, 2, 10, 255]) {
        const decoded = decodeFilePartPlaintext(encodeFilePartPlaintext(1, 0, 1, 10, randomBytes(4), "a.bin", "", gc));
        assert.equal(decoded.groupCount, gc, `groupCount ${gc}`);
      }
    });

    it("groupCount is clamped into 1..255 on encode", () => {
      assert.equal(decodeFilePartPlaintext(encodeFilePartPlaintext(1, 0, 1, 10, randomBytes(1), "a", "", 0)).groupCount, 1);
      assert.equal(decodeFilePartPlaintext(encodeFilePartPlaintext(1, 0, 1, 10, randomBytes(1), "a", "", 999)).groupCount, 255);
    });

    it("groupCount is not carried on non-zero chunks (only chunk 0 has it)", () => {
      const decoded = decodeFilePartPlaintext(encodeFilePartPlaintext(1, 1, 3, 10, randomBytes(4), undefined, undefined, 5));
      assert.equal(decoded.groupCount, undefined);
    });

    it("packed transferId (groupNonce << 8 | index) round-trips as an opaque uint32", () => {
      // the wire treats transferId as an opaque id; the (nonce, index) split is a
      // consumer convention. verify the packing survives a full round-trip.
      for (const [nonce, index] of [[0, 0], [1, 3], [0xffffff, 255], [0x0abcde, 7]] as const) {
        const tid = ((nonce << 8) | index) >>> 0;
        const decoded = decodeFilePartPlaintext(encodeFilePartPlaintext(tid, 0, 1, 10, randomBytes(2), "f", "", 8));
        assert.equal(decoded.transferId, tid, `tid for nonce=${nonce} index=${index}`);
        assert.equal(decoded.transferId >>> 8, nonce, "recovered nonce");
        assert.equal(decoded.transferId & 0xff, index, "recovered index");
      }
    });

    it("chunk 0 shorter than the fixed header is rejected", () => {
      // valid transferId/chunkIndex=0/totalChunks=1/size=10, but truncated before groupCount+nameLen
      const buf = new Uint8Array(22);
      const v = new DataView(buf.buffer);
      v.setUint32(8, 1, true);     // totalChunks
      v.setFloat64(12, 10, true);  // totalFileSize
      assert.throws(() => decodeFilePartPlaintext(buf), /too short/);
    });

    it("a 3-file group round-trips: each file's chunks carry the shared nonce, its own index, and the batch size", () => {
      // mirrors WhisperLiveSession.sendFileGroup -> sendFileChunked: one 24-bit nonce
      // per gesture, files numbered 0..N-1, groupCount on every chunk 0.
      const CHUNK = 1 << 20;
      const groupNonce = 0x3af219;
      const files = [
        { name: "a.bin", type: "application/octet-stream", bytes: randomBytes(CHUNK + 512) }, // 2 chunks
        { name: "b.png", type: "image/png", bytes: randomBytes(300) },                        // 1 chunk
        { name: "c.txt", type: "text/plain", bytes: randomBytes(CHUNK * 2 + 1) },             // 3 chunks
      ];
      files.forEach((file, index) => {
        const transferId = ((groupNonce << 8) | index) >>> 0;
        const totalChunks = Math.max(1, Math.ceil(file.bytes.length / CHUNK));
        const parts: Uint8Array[] = [];
        for (let c = 0; c < totalChunks; c++) {
          const slice = file.bytes.subarray(c * CHUNK, Math.min((c + 1) * CHUNK, file.bytes.length));
          const wire = encodeFilePartPlaintext(
            transferId, c, totalChunks, file.bytes.length, slice,
            c === 0 ? file.name : undefined,
            c === 0 ? file.type : undefined,
            files.length,
          );
          const decoded = decodeFilePartPlaintext(wire);
          assert.equal(decoded.transferId >>> 8, groupNonce, `nonce on ${file.name} chunk ${c}`);
          assert.equal(decoded.transferId & 0xff, index, `index on ${file.name} chunk ${c}`);
          if (c === 0) {
            assert.equal(decoded.groupCount, 3, `groupCount on ${file.name} chunk 0`);
            assert.equal(decoded.fileName, file.name);
            assert.equal(decoded.fileType, file.type);
          } else {
            assert.equal(decoded.groupCount, undefined);
          }
          parts.push(decoded.chunkData.slice());
        }
        const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let off = 0;
        for (const p of parts) { joined.set(p, off); off += p.length; }
        assertBytesEqual(joined, file.bytes, `${file.name} reassembles`);
      });
    });
  });
});
