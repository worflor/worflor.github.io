import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomKey } from "./_helpers/generators.js";
import {
  generateDHKeyPair,
  initRatchetAsOfferer,
  initRatchetAsReceiver,
  dhRatchetStep,
  skipMessageKeys,
  trySkippedKey,
} from "../../src/scripts/whisper/live-ratchet.js";

describe("live-ratchet", () => {
  describe("generateDHKeyPair", () => {
    it("produces 65-byte uncompressed P-256 pubkey", async () => {
      for (let i = 0; i < 5; i++) {
        const kp = await generateDHKeyPair();
        assert.equal(kp.publicKey.length, 65, `pubkey length iter ${i}`);
        assert.equal(kp.publicKey[0], 0x04, `uncompressed prefix iter ${i}`);
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
        assert.equal(state.dhSelf.publicKey.length, 65);
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
});
