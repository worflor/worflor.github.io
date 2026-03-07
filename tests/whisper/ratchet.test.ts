import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomKey, randomBytes, randomNonce } from "./_helpers/generators.js";
import {
  generateDHKeyPair,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
  dhRatchetStep,
  skipMessageKeys,
  trySkippedKey,
} from "../../src/scripts/whisper/live-ratchet.js";
import { kdfChainDirect, aesGcmEncrypt, aesGcmDecrypt } from "../../src/scripts/whisper/live-crypto.js";

describe("live-ratchet", () => {
  describe("generateDHKeyPair", () => {
    it("produces 33-byte compressed P-256 pubkey", async () => {
      for (let i = 0; i < 5; i++) {
        const kp = await generateDHKeyPair();
        assert.equal(kp.publicKey.length, 33, `pubkey length iter ${i}`);
        assert.ok(kp.publicKey[0] === 0x02 || kp.publicKey[0] === 0x03, `compressed prefix iter ${i}`);
        assert.ok(kp.privateKey, `privateKey exists iter ${i}`);
      }
    });

    it("generates unique keypairs each time", async () => {
      const keys: Uint8Array[] = [];
      for (let i = 0; i < 10; i++) {
        keys.push((await generateDHKeyPair()).publicKey);
      }
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          assert.notDeepStrictEqual(keys[i], keys[j],
            `keypair ${i} and ${j} should have different pubkeys`);
        }
      }
    });

    it("pubkey bytes are non-trivial (not all zeros after prefix)", async () => {
      const kp = await generateDHKeyPair();
      const body = kp.publicKey.subarray(1);
      assert.ok(!body.every(b => b === 0), "pubkey body should not be all zeros");
    });
  });

  describe("initRatchetAsOfferer", () => {
    it("correct initial state shape and values", async () => {
      for (let i = 0; i < 3; i++) {
        const sharedSecret = randomKey();
        const dhSelf = await generateDHKeyPair();
        const state = await initRatchetAsOfferer(sharedSecret, dhSelf);

        assert.ok(state.rootKey instanceof Uint8Array);
        assert.equal(state.rootKey.length, 32);
        assert.ok(state.dhSelf);
        assert.equal(state.dhSelf.publicKey.length, 33);
        assert.equal(state.dhPeer, null);
        assert.equal(state.dhPeerHex, "");
        assert.equal(state.chainKeySend, null);
        assert.equal(state.chainKeyRecv, null);
        assert.equal(state.nSend, 0);
        assert.equal(state.nRecv, 0);
        assert.equal(state.prevChainLength, 0);
        assert.ok(state.skippedKeys instanceof Map);
        assert.equal(state.skippedKeys.size, 0);
      }
    });

    it("does not alias the caller's shared secret into rootKey", async () => {
      const sharedSecret = randomKey();
      const secretSnapshot = new Uint8Array(sharedSecret);
      const dhSelf = await generateDHKeyPair();
      const state = await initRatchetAsOfferer(sharedSecret, dhSelf);

      state.rootKey.fill(0);

      assertBytesEqual(sharedSecret, secretSnapshot, "offerer init should not mutate caller shared secret");
    });
  });

  describe("initRatchetAsReceiver", () => {
    it("establishes chainKeySend and knows peer pubKey", async () => {
      for (let i = 0; i < 3; i++) {
        const sharedSecret = randomKey();
        const offererKP = await generateDHKeyPair();
        const receiver = await initRatchetAsReceiver(
          new Uint8Array(sharedSecret), offererKP.publicKey,
        );

        assert.ok(receiver.rootKey instanceof Uint8Array);
        assert.equal(receiver.rootKey.length, 32);
        assert.ok(receiver.chainKeySend, "receiver should have chainKeySend");
        assert.equal(receiver.chainKeySend!.length, 32);
        assert.equal(receiver.chainKeyRecv, null, "no recv chain yet");
        assert.ok(receiver.dhPeer, "should know offerer pubKey");
        assertBytesEqual(receiver.dhPeer!, offererKP.publicKey, "dhPeer matches offerer");
        assert.ok(receiver.dhPeerHex.length > 0, "dhPeerHex populated");
        assert.equal(receiver.nSend, 0);
        assert.equal(receiver.nRecv, 0);
      }
    });

    it("does not wipe the caller's shared secret", async () => {
      const sharedSecret = randomKey();
      const secretSnapshot = new Uint8Array(sharedSecret);
      const offererKP = await generateDHKeyPair();

      await initRatchetAsReceiver(sharedSecret, offererKP.publicKey);

      assertBytesEqual(sharedSecret, secretSnapshot, "receiver init should preserve caller shared secret");
    });
  });

  describe("full handshake (offerer + receiver)", () => {
    it("handshake with 5 random shared secrets", async () => {
      for (let i = 0; i < 5; i++) {
        const sharedSecret = randomKey();
        const dhOfferer = await generateDHKeyPair();
        const offerer = await initRatchetAsOfferer(new Uint8Array(sharedSecret), dhOfferer);
        const receiver = await initRatchetAsReceiver(new Uint8Array(sharedSecret), dhOfferer.publicKey);

        // Offerer does DH ratchet step with receiver's pubKey
        await dhRatchetStep(offerer, receiver.dhSelf.publicKey);

        // After step, offerer has both chain keys
        assert.ok(offerer.chainKeyRecv, `offerer chainKeyRecv iter ${i}`);
        assert.equal(offerer.chainKeyRecv!.length, 32);
        assert.ok(offerer.chainKeySend, `offerer chainKeySend iter ${i}`);
        assert.equal(offerer.chainKeySend!.length, 32);
        assert.equal(offerer.nSend, 0);
        assert.equal(offerer.nRecv, 0);
      }
    });
  });

  describe("dhRatchetStep", () => {
    it("resets nSend/nRecv and records prevChainLength", async () => {
      const sharedSecret = randomKey();
      const dhSelf = await generateDHKeyPair();
      const state = await initRatchetAsOfferer(sharedSecret, dhSelf);

      state.nSend = 17;
      state.nRecv = 8;

      const peerKP = await generateDHKeyPair();
      await dhRatchetStep(state, peerKP.publicKey);

      assert.equal(state.nSend, 0, "nSend reset");
      assert.equal(state.nRecv, 0, "nRecv reset");
      assert.equal(state.prevChainLength, 17, "prevChainLength = old nSend");
    });

    it("generates new DH keypair (pubkey changes)", async () => {
      const sharedSecret = randomKey();
      const dhSelf = await generateDHKeyPair();
      const state = await initRatchetAsOfferer(sharedSecret, dhSelf);
      const oldPub = new Uint8Array(state.dhSelf.publicKey);

      const peerKP = await generateDHKeyPair();
      await dhRatchetStep(state, peerKP.publicKey);

      assert.notDeepStrictEqual(state.dhSelf.publicKey, oldPub,
        "pubkey should change after DH step");
    });

    it("multiple DH rounds produce unique root/chain keys each time", async () => {
      const sharedSecret = randomKey();
      const dhSelf = await generateDHKeyPair();
      const state = await initRatchetAsOfferer(sharedSecret, dhSelf);

      const rootKeys: Uint8Array[] = [];
      const chainSendKeys: Uint8Array[] = [];
      const chainRecvKeys: Uint8Array[] = [];

      for (let round = 0; round < 5; round++) {
        state.nSend = round * 3; // simulate some sends
        const peerKP = await generateDHKeyPair();
        await dhRatchetStep(state, peerKP.publicKey);

        rootKeys.push(new Uint8Array(state.rootKey));
        chainSendKeys.push(new Uint8Array(state.chainKeySend!));
        chainRecvKeys.push(new Uint8Array(state.chainKeyRecv!));

        assert.equal(state.nSend, 0, `nSend reset round ${round}`);
        assert.equal(state.nRecv, 0, `nRecv reset round ${round}`);
      }

      // All root keys should be unique
      for (let i = 0; i < rootKeys.length; i++) {
        for (let j = i + 1; j < rootKeys.length; j++) {
          assert.notDeepStrictEqual(rootKeys[i], rootKeys[j],
            `rootKey round ${i} vs ${j}`);
        }
      }
      // All chain send keys should be unique
      for (let i = 0; i < chainSendKeys.length; i++) {
        for (let j = i + 1; j < chainSendKeys.length; j++) {
          assert.notDeepStrictEqual(chainSendKeys[i], chainSendKeys[j],
            `chainKeySend round ${i} vs ${j}`);
        }
      }
    });

    it("updates dhPeer and dhPeerHex", async () => {
      const sharedSecret = randomKey();
      const dhSelf = await generateDHKeyPair();
      const state = await initRatchetAsOfferer(sharedSecret, dhSelf);

      assert.equal(state.dhPeer, null);
      assert.equal(state.dhPeerHex, "");

      const peerKP = await generateDHKeyPair();
      await dhRatchetStep(state, peerKP.publicKey);

      assert.ok(state.dhPeer);
      assert.ok(state.dhPeerHex.length > 0);
      assertBytesEqual(state.dhPeer!, peerKP.publicKey, "dhPeer matches");
    });
  });

  describe("skipMessageKeys", () => {
    async function setupWithRecvChain() {
      const secret = randomKey();
      const dhOff = await generateDHKeyPair();
      const offerer = await initRatchetAsOfferer(new Uint8Array(secret), dhOff);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secret), dhOff.publicKey);
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      return offerer;
    }

    it("skips exact count and stores unique keys", async () => {
      const state = await setupWithRecvChain();
      assert.ok(state.chainKeyRecv);

      await skipMessageKeys(state, 10);
      assert.equal(state.nRecv, 10);
      assert.equal(state.skippedKeys.size, 10);

      // Every skipped key should be unique and 32 bytes
      const keyValues = Array.from(state.skippedKeys.values());
      for (let i = 0; i < keyValues.length; i++) {
        assert.equal(keyValues[i].length, 32, `skipped key ${i} is 32 bytes`);
        for (let j = i + 1; j < keyValues.length; j++) {
          assert.notDeepStrictEqual(keyValues[i], keyValues[j],
            `skipped keys ${i} and ${j} should be unique`);
        }
      }
    });

    it("incremental skips accumulate", async () => {
      const state = await setupWithRecvChain();
      await skipMessageKeys(state, 5);
      assert.equal(state.skippedKeys.size, 5);
      assert.equal(state.nRecv, 5);

      await skipMessageKeys(state, 8);
      assert.equal(state.skippedKeys.size, 8);
      assert.equal(state.nRecv, 8);
    });

    it("rejects excessive skip (> MAX_SKIP=256)", async () => {
      const state = await setupWithRecvChain();
      await assert.rejects(
        () => skipMessageKeys(state, 257),
        /Too many skipped/,
      );
    });

    it("skip exactly 256 succeeds", async () => {
      const state = await setupWithRecvChain();
      await skipMessageKeys(state, 256);
      assert.equal(state.nRecv, 256);
      assert.equal(state.skippedKeys.size, 256);
    });

    it("chain key advances with each skip", async () => {
      const state = await setupWithRecvChain();
      const chainBefore = new Uint8Array(state.chainKeyRecv!);
      await skipMessageKeys(state, 1);
      assert.notDeepStrictEqual(state.chainKeyRecv!, chainBefore,
        "chain key should advance after skip");
    });
  });

  describe("trySkippedKey", () => {
    it("retrieves and removes skipped key", async () => {
      const secret = randomKey();
      const dhOff = await generateDHKeyPair();
      const offerer = await initRatchetAsOfferer(new Uint8Array(secret), dhOff);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secret), dhOff.publicKey);
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      await skipMessageKeys(offerer, 5);

      // Retrieve key at nRecv=0
      const mk = trySkippedKey(offerer, offerer.dhPeerHex, 0);
      assert.ok(mk, "should find skipped key at index 0");
      assert.equal(mk!.length, 32, "message key is 32 bytes");

      // Second retrieval returns null (deleted)
      const mk2 = trySkippedKey(offerer, offerer.dhPeerHex, 0);
      assert.equal(mk2, null, "key should be deleted after first retrieval");

      // Map size should have decreased by 1
      assert.equal(offerer.skippedKeys.size, 4);
    });

    it("retrieves different key for each index", async () => {
      const secret = randomKey();
      const dhOff = await generateDHKeyPair();
      const offerer = await initRatchetAsOfferer(new Uint8Array(secret), dhOff);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secret), dhOff.publicKey);
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      await skipMessageKeys(offerer, 5);

      const keys: Uint8Array[] = [];
      for (let i = 0; i < 5; i++) {
        const mk = trySkippedKey(offerer, offerer.dhPeerHex, i);
        assert.ok(mk, `should find key at index ${i}`);
        keys.push(mk!);
      }

      // All retrieved keys should be unique
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          assert.notDeepStrictEqual(keys[i], keys[j],
            `key at index ${i} vs ${j} should differ`);
        }
      }
      assert.equal(offerer.skippedKeys.size, 0, "all keys consumed");
    });

    it("returns null for non-existent pubKeyHex", async () => {
      const secret = randomKey();
      const dhOff = await generateDHKeyPair();
      const offerer = await initRatchetAsOfferer(new Uint8Array(secret), dhOff);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secret), dhOff.publicKey);
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      await skipMessageKeys(offerer, 3);

      const mk = trySkippedKey(offerer, "nonexistent_hex", 0);
      assert.equal(mk, null, "non-existent pubKeyHex returns null");
    });

    it("returns null for non-existent counter", async () => {
      const secret = randomKey();
      const dhOff = await generateDHKeyPair();
      const offerer = await initRatchetAsOfferer(new Uint8Array(secret), dhOff);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secret), dhOff.publicKey);
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      await skipMessageKeys(offerer, 3);

      const mk = trySkippedKey(offerer, offerer.dhPeerHex, 999);
      assert.equal(mk, null, "non-existent counter returns null");
    });
  });

  describe("two-party encrypt/decrypt exchange", () => {
    /**
     * Simulates what live.ts does: derive a message key from the chain,
     * encrypt with AES-GCM, and decrypt on the other side. This proves
     * two independently initialized ratchet states can actually communicate.
     */
    async function chainEncrypt(
      chainKey: Uint8Array,
    ): Promise<{ newChainKey: Uint8Array; messageKey: Uint8Array }> {
      const [newChainKey, messageKey] = await kdfChainDirect(chainKey);
      return { newChainKey, messageKey };
    }

    it("offerer encrypts, receiver decrypts (initial handshake)", async () => {
      const sharedSecret = randomKey();
      const dhOfferer = await generateDHKeyPair();

      // Both sides init from same shared secret
      const offerer = await initRatchetAsOfferer(new Uint8Array(sharedSecret), dhOfferer);
      const receiver = await initRatchetAsReceiver(new Uint8Array(sharedSecret), dhOfferer.publicKey);

      // Offerer performs DH ratchet step with receiver's public key
      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);

      // Now offerer has chainKeySend, receiver has chainKeySend
      // But offerer's chainKeySend corresponds to receiver's chainKeyRecv (after receiver does its DH step)
      // Receiver needs to do a DH step with offerer's NEW pubkey to derive chainKeyRecv
      await dhRatchetStep(receiver, offerer.dhSelf.publicKey);

      // Now: offerer.chainKeySend should derive same message keys as receiver.chainKeyRecv
      assert.ok(offerer.chainKeySend, "offerer has chainKeySend");
      assert.ok(receiver.chainKeyRecv, "receiver has chainKeyRecv");

      // Offerer sends 5 messages, receiver decrypts each
      let offererChain = new Uint8Array(offerer.chainKeySend!);
      let receiverChain = new Uint8Array(receiver.chainKeyRecv!);

      for (let i = 0; i < 5; i++) {
        const plaintext = randomBytes(50 + i * 30);
        const nonce = randomNonce();

        // Offerer: derive message key, encrypt
        const send = await chainEncrypt(offererChain);
        offererChain = send.newChainKey;
        const ciphertext = await aesGcmEncrypt(
          send.messageKey.subarray(0, 32), plaintext, nonce,
        );

        // Receiver: derive same message key, decrypt
        const recv = await chainEncrypt(receiverChain);
        receiverChain = recv.newChainKey;
        const decrypted = await aesGcmDecrypt(
          recv.messageKey.subarray(0, 32), ciphertext, nonce,
        );

        assertBytesEqual(decrypted, plaintext, `message ${i} round-trip`);
        // Message keys should be identical
        assertBytesEqual(send.messageKey, recv.messageKey, `message key ${i} matches`);
      }
    });

    it("chain key symmetry: both sides derive identical send/recv chains after DH exchange", async () => {
      // This tests the core ratchet invariant: after both sides complete
      // a DH ratchet step with each other's pubkey, the sender's chainKeySend
      // must match the receiver's chainKeyRecv so message keys align.
      const sharedSecret = randomKey();
      const dhOfferer = await generateDHKeyPair();

      const offerer = await initRatchetAsOfferer(new Uint8Array(sharedSecret), dhOfferer);
      const receiver = await initRatchetAsReceiver(new Uint8Array(sharedSecret), dhOfferer.publicKey);

      // Offerer sees receiver's pubkey and ratchets
      const receiverPub = new Uint8Array(receiver.dhSelf.publicKey);
      await dhRatchetStep(offerer, receiverPub);

      // Receiver sees offerer's NEW pubkey (post-ratchet) and ratchets
      const offererNewPub = new Uint8Array(offerer.dhSelf.publicKey);
      await dhRatchetStep(receiver, offererNewPub);

      // offerer.chainKeySend should match receiver.chainKeyRecv
      assert.ok(offerer.chainKeySend, "offerer has chainKeySend");
      assert.ok(receiver.chainKeyRecv, "receiver has chainKeyRecv");

      // Derive 5 message keys from each and verify they match
      let sendChain = new Uint8Array(offerer.chainKeySend!);
      let recvChain = new Uint8Array(receiver.chainKeyRecv!);

      for (let i = 0; i < 5; i++) {
        const [newSend, sendMK] = await kdfChainDirect(sendChain);
        const [newRecv, recvMK] = await kdfChainDirect(recvChain);
        sendChain = newSend;
        recvChain = newRecv;

        assertBytesEqual(sendMK, recvMK, `message key ${i} must match between offerer send and receiver recv`);

        // Prove actual encrypt/decrypt works
        const plaintext = randomBytes(100 + i * 50);
        const nonce = randomNonce();
        const ct = await aesGcmEncrypt(sendMK, plaintext, nonce);
        const pt = await aesGcmDecrypt(recvMK, ct, nonce);
        assertBytesEqual(pt, plaintext, `encrypt/decrypt ${i}`);
      }
    });

    it("wrong shared secret prevents communication", async () => {
      const secretA = randomKey();
      const secretB = randomKey(); // different secret!
      const dhOfferer = await generateDHKeyPair();

      const offerer = await initRatchetAsOfferer(new Uint8Array(secretA), dhOfferer);
      const receiver = await initRatchetAsReceiver(new Uint8Array(secretB), dhOfferer.publicKey);

      await dhRatchetStep(offerer, receiver.dhSelf.publicKey);
      await dhRatchetStep(receiver, offerer.dhSelf.publicKey);

      // Derive message keys from each side
      const [, sendMK] = await kdfChainDirect(offerer.chainKeySend!);
      const [, recvMK] = await kdfChainDirect(receiver.chainKeyRecv!);

      // Keys should NOT match — different root secrets
      assert.notDeepStrictEqual(
        Array.from(sendMK), Array.from(recvMK),
        "different shared secrets must produce different message keys",
      );

      // Encryption with one key, decryption with other should fail
      const plaintext = randomBytes(64);
      const nonce = randomNonce();
      const ct = await aesGcmEncrypt(sendMK, plaintext, nonce);
      await assert.rejects(
        () => aesGcmDecrypt(recvMK, ct, nonce),
        "cross-secret decryption must fail",
      );
    });
  });
});
