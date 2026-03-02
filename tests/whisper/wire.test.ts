import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, fakeP256PubKey, randomNonce, generateTestData } from "./_helpers/generators.js";
import {
  HEADER_SIZE,
  buildHeader,
  parseHeader,
  encodeFilePlaintext,
  decodeFilePlaintext,
} from "../../src/scripts/whisper/live-wire.js";

describe("live-wire", () => {
  it("HEADER_SIZE is 86", () => {
    assert.equal(HEADER_SIZE, 86);
  });

  describe("buildHeader/parseHeader", () => {
    it("round-trip 100 random iterations with content verification", () => {
      for (let i = 0; i < 100; i++) {
        const flags = Math.floor(Math.random() * 256);
        const pubKey = fakeP256PubKey();
        const counter = Math.floor(Math.random() * 0xFFFFFFFF);
        const prevChainLen = Math.floor(Math.random() * 0xFFFFFFFF);
        const nonce = randomNonce();

        const header = buildHeader(flags, pubKey, counter, prevChainLen, nonce);
        assert.equal(header.length, HEADER_SIZE, `header size iter ${i}`);

        // Append random ciphertext
        const ctLen = Math.floor(Math.random() * 500) + 16;
        const ciphertext = randomBytes(ctLen);
        const packet = new Uint8Array(HEADER_SIZE + ctLen);
        packet.set(header, 0);
        packet.set(ciphertext, HEADER_SIZE);

        const parsed = parseHeader(packet);
        assert.equal(parsed.flags, flags, `flags iter ${i}`);
        assertBytesEqual(parsed.pubKey, pubKey, `pubKey iter ${i}`);
        assert.equal(parsed.counter, counter, `counter iter ${i}`);
        assert.equal(parsed.prevChainLen, prevChainLen, `prevChainLen iter ${i}`);
        assertBytesEqual(parsed.nonce, nonce, `nonce iter ${i}`);
        assertBytesEqual(parsed.ciphertext, ciphertext, `ciphertext iter ${i}`);
      }
    });

    it("header byte layout matches spec", () => {
      const flags = 0xAB;
      const pubKey = fakeP256PubKey();
      const counter = 0x04030201;
      const prevChainLen = 0x08070605;
      const nonce = randomNonce();

      const header = buildHeader(flags, pubKey, counter, prevChainLen, nonce);

      // [0] flags
      assert.equal(header[0], 0xAB, "flags byte");
      // [1..65] pubKey
      assertBytesEqual(header.subarray(1, 66), pubKey, "pubKey position");
      // [66..69] counter (LE)
      assert.equal(header[66], 0x01);
      assert.equal(header[67], 0x02);
      assert.equal(header[68], 0x03);
      assert.equal(header[69], 0x04);
      // [70..73] prevChainLen (LE)
      assert.equal(header[70], 0x05);
      assert.equal(header[71], 0x06);
      assert.equal(header[72], 0x07);
      assert.equal(header[73], 0x08);
      // [74..85] nonce
      assertBytesEqual(header.subarray(74, 86), nonce, "nonce position");
    });

    it("boundary flags values", () => {
      for (const flags of [0, 1, 0x7F, 0x80, 0xFE, 0xFF]) {
        const header = buildHeader(flags, fakeP256PubKey(), 0, 0, randomNonce());
        const parsed = parseHeader(header);
        assert.equal(parsed.flags, flags, `flags=0x${flags.toString(16)}`);
      }
    });

    it("boundary counter/prevChainLen values", () => {
      for (const val of [0, 1, 0xFFFF, 0xFFFFFFFF]) {
        const header = buildHeader(0, fakeP256PubKey(), val, val, randomNonce());
        const parsed = parseHeader(header);
        assert.equal(parsed.counter, val, `counter=${val}`);
        assert.equal(parsed.prevChainLen, val, `prevChainLen=${val}`);
      }
    });
  });

  describe("buildHeader rejection", () => {
    it("rejects wrong pubKey length", () => {
      assert.throws(() => buildHeader(0, new Uint8Array(64), 0, 0, randomNonce()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(66), 0, 0, randomNonce()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(0), 0, 0, randomNonce()), /invalid ratchet pubkey/);
      assert.throws(() => buildHeader(0, new Uint8Array(100), 0, 0, randomNonce()), /invalid ratchet pubkey/);
    });

    it("rejects wrong nonce length", () => {
      assert.throws(() => buildHeader(0, fakeP256PubKey(), 0, 0, new Uint8Array(11)), /invalid nonce/);
      assert.throws(() => buildHeader(0, fakeP256PubKey(), 0, 0, new Uint8Array(13)), /invalid nonce/);
      assert.throws(() => buildHeader(0, fakeP256PubKey(), 0, 0, new Uint8Array(0)), /invalid nonce/);
    });
  });

  describe("minimum packet (header only, empty ciphertext)", () => {
    it("parseHeader returns empty ciphertext for 86-byte packet", () => {
      const header = buildHeader(0, fakeP256PubKey(), 0, 0, randomNonce());
      assert.equal(header.length, 86);
      const parsed = parseHeader(header);
      assert.equal(parsed.ciphertext.length, 0, "empty ciphertext");
      assert.equal(parsed.flags, 0);
      assert.equal(parsed.counter, 0);
      assert.equal(parsed.prevChainLen, 0);
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
      new DataView(buf.buffer).setUint32(0, 1000, true); // nameLen=1000 but only 4 more bytes
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
        // Should be prefixed with underscore
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
      // Name with only control chars → stripped → empty → "file"
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
