import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, fakeP256PubKey, generateTestData } from "./_helpers/generators.js";
import {
  HEADER_SIZE,
  HEADER_SIZE_COMPACT,
  LIVE_FLAG_SAME_KEY,
  buildHeader,
  buildNonce,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
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
        const pubKey = fakeP256PubKey();
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
      const pubKey = fakeP256PubKey();
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
        const header = buildHeader(flags, fakeP256PubKey(), 0, 0, randomSalt());
        const parsed = parseHeader(header);
        assert.equal(parsed.flags, flags, `flags=0x${flags.toString(16)}`);
      }
    });

    it("boundary counter/prevChainLen values", () => {
      for (const val of [0, 1, 0xFFFF, 0xFFFFFFFF]) {
        const header = buildHeader(0, fakeP256PubKey(), val, val, randomSalt());
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
      const full = buildHeader(0, fakeP256PubKey(), 42, 10, salt);
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
      assert.throws(() => buildHeader(0, fakeP256PubKey(), 0, 0, new Uint8Array(3)), /invalid salt/);
      assert.throws(() => buildHeader(0, fakeP256PubKey(), 0, 0, new Uint8Array(5)), /invalid salt/);
      assert.throws(() => buildHeader(LIVE_FLAG_SAME_KEY, new Uint8Array(0), 0, 0, new Uint8Array(3)), /invalid salt/);
    });
  });

  describe("minimum packet (header only, empty ciphertext)", () => {
    it("parseHeader returns empty ciphertext for 46-byte full packet", () => {
      const header = buildHeader(0, fakeP256PubKey(), 0, 0, randomSalt());
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
      const header = buildHeader(0, fakeP256PubKey(), counter, 0, salt);
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
});
