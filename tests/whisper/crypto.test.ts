import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import { randomBytes, randomKey, randomNonce } from "./_helpers/generators.js";
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  kdfChainDirect,
  hkdf,
  hmacSha256,
  pbkdf2,
  constantTimeEqual,
  importCtrlKey,
  sealCtrl,
  openCtrl,
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

    it("same key+nonce+plaintext is deterministic (proves nonce is sole randomness source)", async () => {
      const key = randomKey();
      const plaintext = randomBytes(128);
      const nonce = randomNonce();
      const ct1 = await aesGcmEncrypt(new Uint8Array(key), new Uint8Array(plaintext), new Uint8Array(nonce));
      const ct2 = await aesGcmEncrypt(new Uint8Array(key), new Uint8Array(plaintext), new Uint8Array(nonce));
      assertBytesEqual(ct1, ct2, "identical inputs must produce identical ciphertext");
    });

    it("same key+nonce on different plaintexts leaks XOR relationship (nonce reuse hazard proof)", async () => {
      const key = randomKey();
      const nonce = randomNonce();
      const p1 = randomBytes(64);
      const p2 = randomBytes(64);
      const ct1 = await aesGcmEncrypt(key, p1, nonce);
      const ct2 = await aesGcmEncrypt(key, p2, nonce);
      const ctBody1 = ct1.subarray(0, ct1.length - 16);
      const ctBody2 = ct2.subarray(0, ct2.length - 16);
      const ctXor = new Uint8Array(64);
      const ptXor = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        ctXor[i] = ctBody1[i] ^ ctBody2[i];
        ptXor[i] = p1[i] ^ p2[i];
      }
      assertBytesEqual(ctXor, ptXor,
        "nonce reuse leaks plaintext XOR — this test proves why unique nonces are critical");
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

  describe("constantTimeEqual", () => {
    it("returns true for identical arrays", () => {
      for (let i = 0; i < 10; i++) {
        const a = randomBytes(32);
        assert.equal(constantTimeEqual(a, new Uint8Array(a)), true, `iter ${i}`);
      }
    });

    it("returns false for different arrays", () => {
      for (let i = 0; i < 10; i++) {
        const a = randomBytes(32);
        const b = randomBytes(32);
        assert.equal(constantTimeEqual(a, b), false, `iter ${i}`);
      }
    });

    it("returns false for single-bit difference", () => {
      const a = randomBytes(32);
      const b = new Uint8Array(a);
      // Flip one bit in a random position
      const pos = Math.floor(Math.random() * 32);
      b[pos] ^= 0x01;
      assert.equal(constantTimeEqual(a, b), false);
    });

    it("returns false for different lengths", () => {
      assert.equal(constantTimeEqual(randomBytes(16), randomBytes(32)), false);
      assert.equal(constantTimeEqual(new Uint8Array(0), randomBytes(1)), false);
    });

    it("handles empty arrays", () => {
      assert.equal(constantTimeEqual(new Uint8Array(0), new Uint8Array(0)), true);
    });
  });

  describe("hmacSha256", () => {
    it("produces 32-byte output", async () => {
      const mac = await hmacSha256(randomKey(), randomBytes(100));
      assert.equal(mac.length, 32);
    });

    it("deterministic: same key+data → same MAC", async () => {
      const key = randomKey();
      const data = randomBytes(64);
      const a = await hmacSha256(new Uint8Array(key), new Uint8Array(data));
      const b = await hmacSha256(new Uint8Array(key), new Uint8Array(data));
      assertBytesEqual(a, b, "same inputs → same MAC");
    });

    it("different keys → different MACs", async () => {
      const data = randomBytes(64);
      const a = await hmacSha256(randomKey(), data);
      const b = await hmacSha256(randomKey(), data);
      assert.notDeepStrictEqual(a, b);
    });

    it("different data → different MACs", async () => {
      const key = randomKey();
      const a = await hmacSha256(key, randomBytes(64));
      const b = await hmacSha256(key, randomBytes(64));
      assert.notDeepStrictEqual(a, b);
    });
  });

  describe("pbkdf2", () => {
    it("produces correct output length", async () => {
      const secret = new TextEncoder().encode("password");
      const salt = randomBytes(16);
      for (const len of [16, 32, 64]) {
        const result = await pbkdf2(secret, salt, 1000, len);
        assert.equal(result.length, len);
      }
    });

    it("deterministic: same inputs → same output", async () => {
      const secret = new TextEncoder().encode("test-phrase");
      const salt = randomBytes(16);
      const a = await pbkdf2(secret, new Uint8Array(salt), 1000, 32);
      const b = await pbkdf2(secret, new Uint8Array(salt), 1000, 32);
      assertBytesEqual(a, b, "deterministic");
    });

    it("different salts → different output", async () => {
      const secret = new TextEncoder().encode("same-password");
      const a = await pbkdf2(secret, randomBytes(16), 1000, 32);
      const b = await pbkdf2(secret, randomBytes(16), 1000, 32);
      assert.notDeepStrictEqual(a, b);
    });

    it("different iteration counts → different output", async () => {
      const secret = new TextEncoder().encode("password");
      const salt = randomBytes(16);
      const a = await pbkdf2(secret, new Uint8Array(salt), 1000, 32);
      const b = await pbkdf2(secret, new Uint8Array(salt), 2000, 32);
      assert.notDeepStrictEqual(a, b);
    });
  });

  describe("sealCtrl / openCtrl with chain ratchet", () => {
    /** Derive role-swapped chain pairs from a shared root, mirroring live.ts init. */
    async function deriveChains(root: Uint8Array): Promise<{
      offSend: Uint8Array; offRecv: Uint8Array;
      ansSend: Uint8Array; ansRecv: Uint8Array;
    }> {
      const chainA = await hkdf(root, new Uint8Array(32), new TextEncoder().encode("ctrl-send"), 32);
      const chainB = await hkdf(root, new Uint8Array(32), new TextEncoder().encode("ctrl-recv"), 32);
      return {
        offSend: new Uint8Array(chainA), offRecv: new Uint8Array(chainB),
        ansSend: new Uint8Array(chainB), ansRecv: new Uint8Array(chainA),
      };
    }

    /** Chain-step: advance chain, derive ephemeral key, return it + old chain as AAD. */
    async function chainStep(chain: Uint8Array): Promise<{ newChain: Uint8Array; ck: CryptoKey; aad: Uint8Array }> {
      const aad = chain.slice();  // capture old chain key before wipe — mirrors live.ts sendSealed
      const [newChain, msgKey] = await kdfChainDirect(chain);
      chain.fill(0);
      const ck = await importCtrlKey(msgKey);
      msgKey.fill(0);
      return { newChain, ck, aad };
    }

    it("chain ratchet round-trip: 30 messages each direction", async () => {
      const { offSend, offRecv, ansSend, ansRecv } = await deriveChains(randomKey());
      let oS = offSend, aR = new Uint8Array(ansRecv); // offerer→answerer
      let aS = ansSend, oR = new Uint8Array(offRecv); // answerer→offerer

      for (let i = 0; i < 30; i++) {
        const payload = randomBytes(1 + Math.floor(Math.random() * 100));
        // offerer sends
        const s1 = await chainStep(oS); oS = s1.newChain;
        const sealed = await sealCtrl(s1.ck, payload, i, 0, s1.aad);
        s1.aad.fill(0);
        // answerer receives (aad matches: both chains start equal and advance in lockstep)
        const r1 = await chainStep(aR); aR = r1.newChain;
        const opened = await openCtrl(r1.ck, sealed, i, 0, r1.aad);
        r1.aad.fill(0);
        assertBytesEqual(opened, payload, `off→ans msg ${i}`);
      }

      for (let i = 0; i < 30; i++) {
        const payload = randomBytes(1 + Math.floor(Math.random() * 100));
        // answerer sends
        const s2 = await chainStep(aS); aS = s2.newChain;
        const sealed = await sealCtrl(s2.ck, payload, i, 1, s2.aad);
        s2.aad.fill(0);
        // offerer receives
        const r2 = await chainStep(oR); oR = r2.newChain;
        const opened = await openCtrl(r2.ck, sealed, i, 1, r2.aad);
        r2.aad.fill(0);
        assertBytesEqual(opened, payload, `ans→off msg ${i}`);
      }
    });

    /**
     * WHAT FORWARD SECRECY ACTUALLY CLAIMS.
     *
     * The test that used to live here advanced a snapshot, sealed with it, and
     * asserted the receiver could not open the result. That is a DESYNC test:
     * it shows two parties holding different chain states disagree, which is
     * true of any keyed construction whatsoever, including one that never
     * ratcheted at all. It would pass if kdfChain returned its input unchanged,
     * because the AAD alone carries the step.
     *
     * Forward secrecy is the opposite direction in time. Give the attacker the
     * FULL sender state at step N — everything the honest party holds, no
     * snapshot games — and require that the frames already sent at steps < N
     * stay shut. That is a statement about the one-wayness of the chain KDF, and
     * it fails loudly for any construction that keeps old key material reachable.
     */
    it("forward secrecy: total state capture at step N does not open frames before N", async () => {
      const { offSend, ansRecv } = await deriveChains(randomKey());
      let oS = offSend, aR = new Uint8Array(ansRecv);

      // the honest transcript: five frames, ciphertexts kept as an attacker would
      const CAPTURED: Array<{ sealed: Uint8Array; plain: Uint8Array; seq: number }> = [];
      for (let i = 0; i < 5; i++) {
        const plain = randomBytes(24);
        const s = await chainStep(oS); oS = s.newChain;
        CAPTURED.push({ sealed: await sealCtrl(s.ck, plain, i, 0, s.aad), plain, seq: i });
        s.aad.fill(0);
        const r = await chainStep(aR); aR = r.newChain;
        // the receiver really could read them at the time — otherwise the test
        // below would be about frames that were never legible in the first place
        assertBytesEqual(await openCtrl(r.ck, CAPTURED[i].sealed, i, 0, r.aad), plain, `frame ${i} was legible`);
        r.aad.fill(0);
      }

      // COMPROMISE. The attacker now owns both chain states in full.
      const stolenSend = new Uint8Array(oS);
      const stolenRecv = new Uint8Array(aR);

      // It can of course read everything from here forward — forward secrecy has
      // never claimed otherwise, and asserting it makes the compromise real
      // rather than a variable we declared and never used.
      {
        const future = randomBytes(24);
        const s = await chainStep(new Uint8Array(stolenSend));
        const sealed = await sealCtrl(s.ck, future, 5, 0, s.aad);
        const a = await chainStep(new Uint8Array(stolenSend));
        assertBytesEqual(await openCtrl(a.ck, sealed, 5, 0, a.aad), future,
          "sanity: the stolen state is genuinely live state, not junk");
        s.aad.fill(0); a.aad.fill(0);
      }

      // THE CLAIM. Walk the stolen state forward as far as the attacker likes —
      // that is the only direction the KDF runs — and try every key it yields
      // against every captured frame. Also try the raw stolen chains directly, in
      // case the construction ever leaks a usable key without a step.
      const candidates: CryptoKey[] = [];
      for (const seed of [stolenSend, stolenRecv]) {
        let walk = new Uint8Array(seed);
        const [, direct] = await kdfChainDirect(walk);
        candidates.push(await importCtrlKey(direct));
        for (let step = 0; step < 8; step++) {
          const [next, mk] = await kdfChainDirect(walk);
          candidates.push(await importCtrlKey(mk));
          walk = next;
        }
      }

      for (const frame of CAPTURED) {
        for (const key of candidates) {
          // every AAD the attacker could plausibly try, including the stolen chains
          for (const aad of [stolenSend, stolenRecv, new Uint8Array(32)]) {
            await assert.rejects(
              () => openCtrl(key, frame.sealed, frame.seq, 0, aad),
              `frame ${frame.seq} must stay sealed after total state capture`,
            );
          }
        }
      }
    });

    /**
     * The companion property: the chain KDF is one-way in the sense the above
     * relies on. Stated directly so a failure points at the KDF rather than at
     * the twenty-frame search loop.
     */
    it("chain steps never revisit a previous chain or message key", async () => {
      const { offSend } = await deriveChains(randomKey());
      let chain = new Uint8Array(offSend);
      const chains = new Set<string>([toHex(chain)]);
      const keys = new Set<string>();

      for (let i = 0; i < 64; i++) {
        const [next, mk] = await kdfChainDirect(chain);
        const ch = toHex(next), kh = toHex(mk);
        assert.ok(!chains.has(ch), `chain state repeated at step ${i} — the ratchet is cyclic`);
        assert.ok(!keys.has(kh), `message key repeated at step ${i}`);
        assert.ok(kh !== ch, "the message key must not BE the next chain state");
        chains.add(ch); keys.add(kh);
        chain = next;
      }
    });

    it("desync on skip: receiver fails if sender advances without it", async () => {
      const { offSend, ansRecv } = await deriveChains(randomKey());
      let oS = offSend, aR = new Uint8Array(ansRecv);

      // Sender advances 3 steps
      let lastSealed: Uint8Array | undefined;
      for (let i = 0; i < 3; i++) {
        const s = await chainStep(oS); oS = s.newChain;
        lastSealed = await sealCtrl(s.ck, randomBytes(10), i, 0, s.aad);
        s.aad.fill(0);
      }

      // Receiver only at step 0 — chain desynced, aad mismatch guarantees rejection
      const r = await chainStep(aR); aR = r.newChain;
      await assert.rejects(() => openCtrl(r.ck, lastSealed!, 2, 0, r.aad),
        "desynced chain must fail");
      r.aad.fill(0);
    });

    it("ciphertext is plaintext.length + 4 (32-bit tag)", async () => {
      let chain = randomKey();
      for (const size of [0, 1, 3, 6, 20, 100, 255]) {
        const s = await chainStep(chain); chain = s.newChain;
        const sealed = await sealCtrl(s.ck, randomBytes(size), 0, 0, s.aad);
        s.aad.fill(0);
        assert.equal(sealed.length, size + 4,
          `${size}B plaintext → ${size + 4}B sealed (got ${sealed.length})`);
      }
    });

    it("wrong direction rejection", async () => {
      let chain = randomKey();
      const s = await chainStep(chain); chain = s.newChain;
      const sealed = await sealCtrl(s.ck, randomBytes(10), 0, 0, s.aad);
      // Same key and aad but wrong direction — direction bit in nonce causes auth failure
      await assert.rejects(() => openCtrl(s.ck, sealed, 0, 1, s.aad),
        "wrong direction must fail");
      s.aad.fill(0);
    });

    it("determinism: same chain + plaintext + counter → same ciphertext", async () => {
      const root = randomKey();
      const plaintext = randomBytes(15);

      const [chainA1] = await kdfChainDirect(new Uint8Array(root));
      const [, msgKeyA] = await kdfChainDirect(chainA1);
      const ckA = await importCtrlKey(msgKeyA);

      const [chainB1] = await kdfChainDirect(new Uint8Array(root));
      const [, msgKeyB] = await kdfChainDirect(chainB1);
      const ckB = await importCtrlKey(msgKeyB);

      // aad = chain key input to the msgKey derivation step (chainA1 == chainB1 by construction)
      const a = await sealCtrl(ckA, new Uint8Array(plaintext), 7, 1, chainA1);
      const b = await sealCtrl(ckB, new Uint8Array(plaintext), 7, 1, chainB1);
      assertBytesEqual(a, b, "identical chain state must produce identical ciphertext");
    });

    it("empty plaintext round-trip with chain ratchet", async () => {
      const { offSend, ansRecv } = await deriveChains(randomKey());
      const s = await chainStep(offSend);
      const sealed = await sealCtrl(s.ck, new Uint8Array(0), 0, 0, s.aad);
      assert.equal(sealed.length, 4, "empty plaintext → 4B tag");
      const r = await chainStep(new Uint8Array(ansRecv));
      const opened = await openCtrl(r.ck, sealed, 0, 0, r.aad);
      s.aad.fill(0); r.aad.fill(0);
      assert.equal(opened.length, 0);
    });

    it("two-party simulation: 20+ messages each direction with chain ratchet", async () => {
      const { offSend, offRecv, ansSend, ansRecv } = await deriveChains(randomKey());
      let oS = offSend, aR = new Uint8Array(ansRecv);
      let aS = ansSend, oR = new Uint8Array(offRecv);
      let offCounter = 0, ansCounter = 0;

      for (let round = 0; round < 25; round++) {
        // Alternate: even rounds offerer sends, odd rounds answerer sends
        if (round % 2 === 0) {
          const payload = randomBytes(1 + Math.floor(Math.random() * 50));
          const s = await chainStep(oS); oS = s.newChain;
          const sealed = await sealCtrl(s.ck, payload, offCounter, 0, s.aad);
          s.aad.fill(0);
          const r = await chainStep(aR); aR = r.newChain;
          const opened = await openCtrl(r.ck, sealed, offCounter, 0, r.aad);
          r.aad.fill(0);
          assertBytesEqual(opened, payload, `round ${round} off→ans #${offCounter}`);
          offCounter++;
        } else {
          const payload = randomBytes(1 + Math.floor(Math.random() * 50));
          const s = await chainStep(aS); aS = s.newChain;
          const sealed = await sealCtrl(s.ck, payload, ansCounter, 1, s.aad);
          s.aad.fill(0);
          const r = await chainStep(oR); oR = r.newChain;
          const opened = await openCtrl(r.ck, sealed, ansCounter, 1, r.aad);
          r.aad.fill(0);
          assertBytesEqual(opened, payload, `round ${round} ans→off #${ansCounter}`);
          ansCounter++;
        }
      }
    });
  });
});
