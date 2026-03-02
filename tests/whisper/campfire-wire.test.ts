import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, randomPeerId, randomMsgId, randomKey } from "./_helpers/generators.js";
import {
  buildRootHeartbeat,
  parseRootHeartbeat,
  buildGroupMsg,
  parseGroupMsgHeader,
  decryptGroupMsg,
  rewrapGroupMsg,
  buildJoinAnnounce,
  parseJoinAnnounce,
  buildLeaveAnnounce,
  parseLeaveAnnounce,
  buildTopologyAssign,
  parseTopologyAssign,
  buildSdpRelay,
  parseSdpRelay,
  buildGroupKey,
  parseGroupKey,
  buildPeerList,
  parsePeerList,
  buildDmSdpRelay,
  parseDmSdpRelay,
  buildRingWant,
  parseRingWant,
  buildCfReact,
  parseCfReact,
} from "../../src/scripts/whisper/campfire/wire.js";
import { CF_REACT, CF_UNREACT } from "../../src/scripts/whisper/campfire/types.js";

describe("campfire/wire", () => {
  describe("RootHeartbeat", () => {
    it("round-trip 20 random iterations", () => {
      for (let i = 0; i < 20; i++) {
        const epoch = Math.floor(Math.random() * 0xFFFFFFFF);
        const peerCount = Math.floor(Math.random() * 256);
        const rootPeerId = randomPeerId();
        const seq = Math.floor(Math.random() * 0xFFFFFFFF);

        const wire = buildRootHeartbeat(epoch, peerCount, rootPeerId, seq);
        const parsed = parseRootHeartbeat(wire.subarray(1));

        assert.equal(parsed.epoch, epoch, `epoch iter ${i}`);
        assert.equal(parsed.peerCount, peerCount, `peerCount iter ${i}`);
        assertBytesEqual(parsed.rootPeerId, rootPeerId, `rootPeerId iter ${i}`);
        assert.equal(parsed.seq, seq, `seq iter ${i}`);
      }
    });

    it("boundary values", () => {
      for (const [epoch, peerCount, seq] of [[0, 0, 0], [0xFFFFFFFF, 255, 0xFFFFFFFF]]) {
        const rootPeerId = randomPeerId();
        const wire = buildRootHeartbeat(epoch, peerCount, rootPeerId, seq);
        const parsed = parseRootHeartbeat(wire.subarray(1));
        assert.equal(parsed.epoch, epoch);
        assert.equal(parsed.peerCount, peerCount);
        assert.equal(parsed.seq, seq);
      }
    });
  });

  describe("GroupMsg", () => {
    it("build + parse + decrypt round-trip (10 random iterations)", async () => {
      for (let i = 0; i < 10; i++) {
        const msgId = randomMsgId();
        const senderId = randomPeerId();
        const timestamp = Date.now() + Math.floor(Math.random() * 100000);
        const hopCount = Math.floor(Math.random() * 256);
        const epoch = Math.floor(Math.random() * 0xFFFF);
        const contentType = Math.floor(Math.random() * 4);
        const textLen = 1 + Math.floor(Math.random() * 200);
        const plaintext = new TextEncoder().encode("x".repeat(textLen));
        const groupKey = randomKey();

        const wire = await buildGroupMsg(msgId, senderId, timestamp, hopCount, epoch, contentType, plaintext, groupKey);
        const parsed = parseGroupMsgHeader(wire.subarray(1));

        assertBytesEqual(parsed.msgId, msgId, `msgId iter ${i}`);
        assertBytesEqual(parsed.senderId, senderId, `senderId iter ${i}`);
        assert.equal(parsed.hopCount, hopCount, `hopCount iter ${i}`);
        assert.equal(parsed.epoch, epoch, `epoch iter ${i}`);
        assert.equal(parsed.contentType, contentType, `contentType iter ${i}`);

        const decrypted = await decryptGroupMsg(parsed.ciphertext, parsed.nonce, groupKey);
        assertBytesEqual(decrypted, plaintext, `plaintext iter ${i}`);
      }
    });

    it("wrong key fails to decrypt", async () => {
      const msgId = randomMsgId();
      const senderId = randomPeerId();
      const groupKey = randomKey();
      const wrongKey = randomKey();
      const plaintext = new TextEncoder().encode("secret message");

      const wire = await buildGroupMsg(msgId, senderId, Date.now(), 0, 1, 0, plaintext, groupKey);
      const parsed = parseGroupMsgHeader(wire.subarray(1));

      await assert.rejects(
        () => decryptGroupMsg(parsed.ciphertext, parsed.nonce, wrongKey),
        undefined,
        "wrong key should fail to decrypt",
      );
    });

    it("binary plaintext round-trip", async () => {
      const plaintext = randomBytes(500);
      const groupKey = randomKey();
      const wire = await buildGroupMsg(randomMsgId(), randomPeerId(), Date.now(), 0, 1, 0, plaintext, groupKey);
      const parsed = parseGroupMsgHeader(wire.subarray(1));
      const decrypted = await decryptGroupMsg(parsed.ciphertext, parsed.nonce, groupKey);
      assertBytesEqual(decrypted, plaintext, "binary plaintext");
    });
  });

  describe("rewrapGroupMsg", () => {
    it("changes only hop count, preserves everything else", async () => {
      for (let i = 0; i < 5; i++) {
        const msgId = randomMsgId();
        const senderId = randomPeerId();
        const groupKey = randomKey();
        const originalHop = Math.floor(Math.random() * 128);
        const newHop = Math.floor(Math.random() * 128) + 128;
        const wire = await buildGroupMsg(msgId, senderId, Date.now(), originalHop, 1, 0, randomBytes(50), groupKey);

        const rewrapped = rewrapGroupMsg(wire, newHop);
        const parsed = parseGroupMsgHeader(rewrapped.subarray(1));

        assert.equal(parsed.hopCount, newHop, `hop updated iter ${i}`);
        assertBytesEqual(parsed.msgId, msgId, `msgId preserved iter ${i}`);
        assertBytesEqual(parsed.senderId, senderId, `senderId preserved iter ${i}`);

        // Ciphertext should still decrypt with original key
        const decrypted = await decryptGroupMsg(parsed.ciphertext, parsed.nonce, groupKey);
        assert.ok(decrypted.length > 0, `ciphertext still valid iter ${i}`);
      }
    });
  });

  describe("JoinAnnounce", () => {
    it("round-trip 20 iterations with various names", () => {
      const names = [
        "Alice", "Bob", "田中太郎", "José García", "Ünsal", "O'Brien",
        "", "A", "x".repeat(100), "emoji 🎉", "null\x00byte",
      ];
      for (let i = 0; i < 20; i++) {
        const peerId = randomPeerId();
        const name = names[i % names.length];
        const wire = buildJoinAnnounce(peerId, name);
        const parsed = parseJoinAnnounce(wire.subarray(1));
        assertBytesEqual(parsed.peerId, peerId, `peerId iter ${i}`);
        assert.equal(parsed.name, name, `name iter ${i}: "${name}"`);
      }
    });
  });

  describe("LeaveAnnounce", () => {
    it("round-trip 20 random iterations", () => {
      for (let i = 0; i < 20; i++) {
        const peerId = randomPeerId();
        const wire = buildLeaveAnnounce(peerId);
        const parsed = parseLeaveAnnounce(wire.subarray(1));
        assertBytesEqual(parsed.peerId, peerId, `peerId iter ${i}`);
      }
    });
  });

  describe("TopologyAssign", () => {
    it("round-trip with 0, 1, 5, 20 peers", () => {
      for (const count of [0, 1, 5, 20]) {
        const ids = Array.from({ length: count }, () => randomPeerId());
        const wire = buildTopologyAssign(ids);
        const parsed = parseTopologyAssign(wire.subarray(1));
        assert.equal(parsed.neighborPeerIds.length, count, `count=${count}`);
        for (let i = 0; i < count; i++) {
          assertBytesEqual(parsed.neighborPeerIds[i], ids[i], `peer ${i} in ${count}-list`);
        }
      }
    });
  });

  describe("SdpRelay", () => {
    it("round-trip 10 random iterations", () => {
      for (let i = 0; i < 10; i++) {
        const target = randomPeerId();
        const origin = randomPeerId();
        const sdpType = Math.floor(Math.random() * 4);
        const sdpCode = `v=0\r\no=- ${Math.floor(Math.random() * 100000)} 2 IN IP4 127.0.0.1\r\n`;

        const wire = buildSdpRelay(target, origin, sdpType, sdpCode);
        const parsed = parseSdpRelay(wire.subarray(1));
        assertBytesEqual(parsed.targetPeerId, target, `target iter ${i}`);
        assertBytesEqual(parsed.originPeerId, origin, `origin iter ${i}`);
        assert.equal(parsed.sdpType, sdpType, `sdpType iter ${i}`);
        assert.equal(parsed.sdpCode, sdpCode, `sdpCode iter ${i}`);
      }
    });
  });

  describe("GroupKey", () => {
    it("round-trip 20 random iterations", () => {
      for (let i = 0; i < 20; i++) {
        const epoch = Math.floor(Math.random() * 0xFFFFFFFF);
        const groupKey = randomKey();
        const wire = buildGroupKey(epoch, groupKey);
        const parsed = parseGroupKey(wire.subarray(1));
        assert.equal(parsed.epoch, epoch, `epoch iter ${i}`);
        assertBytesEqual(parsed.groupKey, groupKey, `groupKey iter ${i}`);
      }
    });

    it("boundary epoch values", () => {
      for (const epoch of [0, 1, 0xFFFFFFFF]) {
        const groupKey = randomKey();
        const wire = buildGroupKey(epoch, groupKey);
        const parsed = parseGroupKey(wire.subarray(1));
        assert.equal(parsed.epoch, epoch);
        assertBytesEqual(parsed.groupKey, groupKey);
      }
    });
  });

  describe("PeerList", () => {
    it("round-trip with 0, 1, 10 peers including Unicode names", () => {
      const allPeers = [
        { peerId: randomPeerId(), name: "Alice" },
        { peerId: randomPeerId(), name: "Bob" },
        { peerId: randomPeerId(), name: "チャーリー" },
        { peerId: randomPeerId(), name: "Diégo" },
        { peerId: randomPeerId(), name: "Eve 🔐" },
        { peerId: randomPeerId(), name: "Frank" },
        { peerId: randomPeerId(), name: "Grace" },
        { peerId: randomPeerId(), name: "Hank" },
        { peerId: randomPeerId(), name: "Ivy" },
        { peerId: randomPeerId(), name: "Jack" },
      ];

      for (const count of [0, 1, 3, 10]) {
        const peers = allPeers.slice(0, count);
        const wire = buildPeerList(peers);
        const parsed = parsePeerList(wire.subarray(1));
        assert.equal(parsed.peers.length, count, `count=${count}`);
        for (let i = 0; i < count; i++) {
          assertBytesEqual(parsed.peers[i].peerId, peers[i].peerId, `peerId ${i}`);
          assert.equal(parsed.peers[i].name, peers[i].name, `name ${i}: "${peers[i].name}"`);
        }
      }
    });
  });

  describe("DmSdpRelay", () => {
    it("round-trip 10 random iterations", () => {
      for (let i = 0; i < 10; i++) {
        const target = randomPeerId();
        const origin = randomPeerId();
        const sdpType = Math.floor(Math.random() * 4);
        const sdpCode = `candidate:1 1 UDP ${Math.floor(Math.random() * 4294967295)} 192.168.${i}.1 ${12345 + i} typ host`;

        const wire = buildDmSdpRelay(target, origin, sdpType, sdpCode);
        const parsed = parseDmSdpRelay(wire.subarray(1));
        assertBytesEqual(parsed.targetPeerId, target, `target iter ${i}`);
        assertBytesEqual(parsed.originPeerId, origin, `origin iter ${i}`);
        assert.equal(parsed.sdpType, sdpType, `sdpType iter ${i}`);
        assert.equal(parsed.sdpCode, sdpCode, `sdpCode iter ${i}`);
      }
    });
  });

  describe("RingWant", () => {
    it("round-trip 10 random iterations", () => {
      for (let i = 0; i < 10; i++) {
        const origin = randomPeerId();
        const target = randomPeerId();
        const fromSeq = Math.floor(Math.random() * 0xFFFFFFFF);
        const toSeq = fromSeq + Math.floor(Math.random() * 1000);

        const wire = buildRingWant(origin, target, fromSeq, toSeq);
        const parsed = parseRingWant(wire.subarray(1));
        assertBytesEqual(parsed.originPeerId, origin, `origin iter ${i}`);
        assertBytesEqual(parsed.targetPeerId, target, `target iter ${i}`);
        assert.equal(parsed.fromSeq, fromSeq, `fromSeq iter ${i}`);
        assert.equal(parsed.toSeq, toSeq, `toSeq iter ${i}`);
      }
    });

    it("boundary values", () => {
      const wire = buildRingWant(randomPeerId(), randomPeerId(), 0, 0xFFFFFFFF);
      const parsed = parseRingWant(wire.subarray(1));
      assert.equal(parsed.fromSeq, 0);
      assert.equal(parsed.toSeq, 0xFFFFFFFF);
    });
  });

  describe("CfReact", () => {
    it("round-trip CF_REACT with 10 random iterations", () => {
      for (let i = 0; i < 10; i++) {
        const targetMsgId = randomMsgId();
        const senderId = randomPeerId();
        const emojis = ["🔥", "👍", "❤️", "😂", "🎉", "💯", "👀", "🙏", "✨", "🤔"];
        const emoji = emojis[i % emojis.length];
        const hopCount = Math.floor(Math.random() * 256);

        const wire = buildCfReact(CF_REACT, targetMsgId, senderId, emoji, hopCount);
        const parsed = parseCfReact(wire.subarray(1));
        assert.ok(parsed, `should parse iter ${i}`);
        assertBytesEqual(parsed!.targetMsgIdFull, targetMsgId, `targetMsgId iter ${i}`);
        assertBytesEqual(parsed!.senderId, senderId, `senderId iter ${i}`);
        assert.equal(parsed!.hopCount, hopCount, `hopCount iter ${i}`);
        assert.equal(parsed!.emoji, emoji, `emoji "${emoji}" iter ${i}`);
      }
    });

    it("round-trip CF_UNREACT", () => {
      for (let i = 0; i < 5; i++) {
        const targetMsgId = randomMsgId();
        const senderId = randomPeerId();
        const emoji = "👍";

        const wire = buildCfReact(CF_UNREACT, targetMsgId, senderId, emoji);
        const parsed = parseCfReact(wire.subarray(1));
        assert.ok(parsed, `should parse UNREACT iter ${i}`);
        assert.equal(parsed!.emoji, emoji, `emoji iter ${i}`);
        assertBytesEqual(parsed!.targetMsgIdFull, targetMsgId, `targetMsgId iter ${i}`);
        assertBytesEqual(parsed!.senderId, senderId, `senderId iter ${i}`);
      }
    });

    it("ZWJ emoji round-trip", () => {
      const zwjEmojis = ["👨‍👩‍👧‍👦", "🧑‍💻", "👩‍🔬", "🏳️‍🌈"];
      for (const emoji of zwjEmojis) {
        const wire = buildCfReact(CF_REACT, randomMsgId(), randomPeerId(), emoji);
        const parsed = parseCfReact(wire.subarray(1));
        assert.ok(parsed, `ZWJ ${emoji}`);
        assert.ok(parsed!.emoji.length > 0, `emoji non-empty for ${emoji}`);
      }
    });

    it("hopCount boundary values", () => {
      for (const hop of [0, 1, 127, 128, 255]) {
        const wire = buildCfReact(CF_REACT, randomMsgId(), randomPeerId(), "🔥", hop);
        const parsed = parseCfReact(wire.subarray(1));
        assert.ok(parsed);
        assert.equal(parsed!.hopCount, hop, `hopCount=${hop}`);
      }
    });

    it("rejects short data", () => {
      // Minimum: 32 (msgId) + 16 (senderId) + 1 (hop) + 1 (emoji) = 50 bytes
      assert.equal(parseCfReact(new Uint8Array(49)), null, "49 bytes too short");
      assert.equal(parseCfReact(new Uint8Array(10)), null, "10 bytes too short");
      assert.equal(parseCfReact(new Uint8Array(0)), null, "0 bytes too short");
    });

    it("rejects empty emoji", () => {
      // Build manually: 32B msgId + 16B senderId + 1B hop + 0B emoji
      const buf = new Uint8Array(32 + 16 + 1);
      assert.equal(parseCfReact(buf), null, "no emoji bytes");
    });
  });
});
