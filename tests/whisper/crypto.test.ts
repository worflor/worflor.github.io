import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, randomKey, randomNonce } from "./_helpers/generators.js";
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  kdfChainDirect,
  hkdf,
} from "../../src/scripts/whisper/live-crypto.js";

describe("live-crypto", () => {
  describe("AES-GCM", () => {
    it("encrypt/decrypt round-trip (30 random iterations, varying sizes)", async () => {
      for (let i = 0; i < 30; i++) {
        const key = randomKey();
        const size = Math.floor(Math.random() * 2000) + 1;
        const plaintext = randomBytes(size);
        const nonce = randomNonce();
        const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);
        const decrypted = await aesGcmDecrypt(key, ciphertext, nonce);
        assertBytesEqual(decrypted, plaintext, `round-trip iter ${i} (${size}B)`);
      }
    });

    it("ciphertext is exactly plaintext.length + 16 (auth tag)", async () => {
      for (const size of [0, 1, 16, 100, 1000, 4096]) {
        const key = randomKey();
        const plaintext = randomBytes(size);
        const nonce = randomNonce();
        const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);
        assert.equal(
          ciphertext.length, size + 16,
          `ciphertext for ${size}B plaintext should be ${size + 16}B (got ${ciphertext.length})`
        );
      }
    });

    it("encrypt/decrypt with AAD (20 random iterations)", async () => {
      for (let i = 0; i < 20; i++) {
        const key = randomKey();
        const plaintext = randomBytes(50 + Math.floor(Math.random() * 200));
        const nonce = randomNonce();
        const aad = randomBytes(10 + Math.floor(Math.random() * 50));
        const ciphertext = await aesGcmEncrypt(key, plaintext, nonce, aad);
        const decrypted = await aesGcmDecrypt(key, ciphertext, nonce, aad);
        assertBytesEqual(decrypted, plaintext, `AAD round-trip iter ${i}`);
      }
    });

    it("wrong key rejects", async () => {
      const key = randomKey();
      const wrongKey = randomKey();
      const plaintext = randomBytes(64);
      const nonce = randomNonce();
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);
      await assert.rejects(() => aesGcmDecrypt(wrongKey, ciphertext, nonce));
    });

    it("wrong nonce rejects", async () => {
      const key = randomKey();
      const plaintext = randomBytes(64);
      const nonce = randomNonce();
      const wrongNonce = randomNonce();
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);
      await assert.rejects(() => aesGcmDecrypt(key, ciphertext, wrongNonce));
    });

    it("wrong AAD rejects", async () => {
      const key = randomKey();
      const plaintext = randomBytes(64);
      const nonce = randomNonce();
      const aad = randomBytes(20);
      const wrongAad = randomBytes(20);
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce, aad);
      await assert.rejects(() => aesGcmDecrypt(key, ciphertext, nonce, wrongAad));
    });

    it("missing AAD when AAD was used rejects", async () => {
      const key = randomKey();
      const plaintext = randomBytes(64);
      const nonce = randomNonce();
      const aad = randomBytes(20);
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce, aad);
      // Decrypt without AAD should fail
      await assert.rejects(() => aesGcmDecrypt(key, ciphertext, nonce));
    });

    it("tampered ciphertext rejects", async () => {
      const key = randomKey();
      const plaintext = randomBytes(100);
      const nonce = randomNonce();
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);

      // Flip a random byte in the ciphertext
      const tampered = new Uint8Array(ciphertext);
      const flipIdx = Math.floor(Math.random() * tampered.length);
      tampered[flipIdx] ^= 0x01;
      await assert.rejects(() => aesGcmDecrypt(key, tampered, nonce));
    });

    it("tampered auth tag rejects", async () => {
      const key = randomKey();
      const plaintext = randomBytes(100);
      const nonce = randomNonce();
      const ciphertext = await aesGcmEncrypt(key, plaintext, nonce);

      // Flip a byte in the last 16 bytes (auth tag)
      const tampered = new Uint8Array(ciphertext);
      tampered[tampered.length - 1] ^= 0xFF;
      await assert.rejects(() => aesGcmDecrypt(key, tampered, nonce));
    });

    it("empty plaintext round-trip (auth tag only)", async () => {
      const key = randomKey();
      const nonce = randomNonce();
      const ciphertext = await aesGcmEncrypt(key, new Uint8Array(0), nonce);
      assert.equal(ciphertext.length, 16, "empty plaintext → 16B auth tag only");
      const decrypted = await aesGcmDecrypt(key, ciphertext, nonce);
      assert.equal(decrypted.length, 0);
    });

    it("same plaintext with different nonces produces different ciphertext", async () => {
      const key = randomKey();
      const plaintext = randomBytes(64);
      const ct1 = await aesGcmEncrypt(key, plaintext, randomNonce());
      const ct2 = await aesGcmEncrypt(key, plaintext, randomNonce());
      assert.notDeepStrictEqual(ct1, ct2, "different nonces should produce different ciphertext");
    });
  });

  describe("kdfChainDirect", () => {
    it("produces two 32-byte outputs", async () => {
      for (let i = 0; i < 10; i++) {
        const chainKey = randomKey();
        const [newChainKey, messageKey] = await kdfChainDirect(chainKey);
        assert.equal(newChainKey.length, 32, `newChainKey length iter ${i}`);
        assert.equal(messageKey.length, 32, `messageKey length iter ${i}`);
      }
    });

    it("outputs differ from each other and from input", async () => {
      for (let i = 0; i < 10; i++) {
        const chainKey = randomKey();
        const [newChainKey, messageKey] = await kdfChainDirect(chainKey);
        assert.notDeepStrictEqual(newChainKey, messageKey, `chain ≠ message iter ${i}`);
        assert.notDeepStrictEqual(new Uint8Array(newChainKey), chainKey, `newChain ≠ input iter ${i}`);
        assert.notDeepStrictEqual(new Uint8Array(messageKey), chainKey, `message ≠ input iter ${i}`);
      }
    });

    it("deterministic: same input → same outputs", async () => {
      for (let i = 0; i < 5; i++) {
        const chainKey = randomKey();
        const copy = new Uint8Array(chainKey);
        const [a1, a2] = await kdfChainDirect(chainKey);
        const [b1, b2] = await kdfChainDirect(copy);
        assertBytesEqual(a1, b1, `newChainKey deterministic iter ${i}`);
        assertBytesEqual(a2, b2, `messageKey deterministic iter ${i}`);
      }
    });

    it("chain forward: each step produces unique keys", async () => {
      let chainKey = randomKey();
      const allChainKeys: Uint8Array[] = [];
      const allMessageKeys: Uint8Array[] = [];

      for (let step = 0; step < 20; step++) {
        const [nextChain, msgKey] = await kdfChainDirect(chainKey);
        allChainKeys.push(new Uint8Array(nextChain));
        allMessageKeys.push(new Uint8Array(msgKey));
        chainKey = nextChain;
      }

      // Every chain key should be unique
      for (let i = 0; i < allChainKeys.length; i++) {
        for (let j = i + 1; j < allChainKeys.length; j++) {
          assert.notDeepStrictEqual(allChainKeys[i], allChainKeys[j],
            `chain keys at step ${i} and ${j} should differ`);
        }
      }
      // Every message key should be unique
      for (let i = 0; i < allMessageKeys.length; i++) {
        for (let j = i + 1; j < allMessageKeys.length; j++) {
          assert.notDeepStrictEqual(allMessageKeys[i], allMessageKeys[j],
            `message keys at step ${i} and ${j} should differ`);
        }
      }
    });

    it("different input keys produce different outputs", async () => {
      const [a1, a2] = await kdfChainDirect(randomKey());
      const [b1, b2] = await kdfChainDirect(randomKey());
      assert.notDeepStrictEqual(a1, b1, "different inputs → different chain keys");
      assert.notDeepStrictEqual(a2, b2, "different inputs → different message keys");
    });
  });

  describe("HKDF", () => {
    it("correct output length for various sizes", async () => {
      const ikm = randomKey();
      const salt = randomKey();
      const info = new TextEncoder().encode("test-info");
      for (const len of [1, 16, 32, 48, 64, 128]) {
        const result = await hkdf(ikm, salt, info, len);
        assert.equal(result.length, len, `output length should be ${len}`);
      }
    });

    it("deterministic: same inputs → same output", async () => {
      for (let i = 0; i < 5; i++) {
        const ikm = randomKey();
        const salt = randomKey();
        const info = new TextEncoder().encode(`info-${i}`);
        const a = await hkdf(new Uint8Array(ikm), new Uint8Array(salt), info, 32);
        const b = await hkdf(new Uint8Array(ikm), new Uint8Array(salt), info, 32);
        assertBytesEqual(a, b, `deterministic iter ${i}`);
      }
    });

    it("different info strings produce different outputs", async () => {
      const ikm = randomKey();
      const salt = randomKey();
      const results: Uint8Array[] = [];
      for (let i = 0; i < 5; i++) {
        const info = new TextEncoder().encode(`info-${i}`);
        results.push(await hkdf(ikm, salt, info, 32));
      }
      for (let i = 0; i < results.length; i++) {
        for (let j = i + 1; j < results.length; j++) {
          assert.notDeepStrictEqual(results[i], results[j],
            `info "${i}" vs "${j}" should differ`);
        }
      }
    });

    it("different salts produce different outputs", async () => {
      const ikm = randomKey();
      const info = new TextEncoder().encode("same-info");
      const a = await hkdf(ikm, randomKey(), info, 32);
      const b = await hkdf(ikm, randomKey(), info, 32);
      assert.notDeepStrictEqual(a, b, "different salts → different output");
    });

    it("different IKMs produce different outputs", async () => {
      const salt = randomKey();
      const info = new TextEncoder().encode("same-info");
      const a = await hkdf(randomKey(), salt, info, 32);
      const b = await hkdf(randomKey(), salt, info, 32);
      assert.notDeepStrictEqual(a, b, "different IKMs → different output");
    });

    it("output bytes are non-trivial (not all zeros)", async () => {
      for (let i = 0; i < 10; i++) {
        const result = await hkdf(randomKey(), randomKey(), new TextEncoder().encode("test"), 32);
        const allZero = result.every(b => b === 0);
        assert.equal(allZero, false, `HKDF output should not be all zeros (iter ${i})`);
      }
    });
  });
});
