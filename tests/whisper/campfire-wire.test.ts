import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes, randomPeerId, randomMsgId } from "./_helpers/generators.js";
import {
  buildGroupMsg,
  parseGroupMsgHeader,
  rewrapGroupMsg,
  buildJoinAnnounce,
  parseJoinAnnounce,
  buildLeaveAnnounce,
  parseLeaveAnnounce,
  buildSdpRelay,
  parseSdpRelay,
  buildPeerList,
  parsePeerList,
  buildDmSdpRelay,
  parseDmSdpRelay,
  buildRingWant,
  parseRingWant,
  buildCfReact,
  parseCfReact,
  buildBraidFold,
  parseBraidFold,
  buildBraidWelcome,
  parseBraidWelcome,
  buildJoinReq,
  parseJoinReq,
} from "../../src/scripts/whisper/campfire/wire.js";
import { CF_REACT, CF_UNREACT } from "../../src/scripts/whisper/campfire/types.js";

/** Build a fake 5-byte frontier entry: [seatIndex 1B][seq 4B LE]. */
function frontierEntry(seatIndex: number, seq: number): Uint8Array {
  const b = new Uint8Array(5);
  b[0] = seatIndex;
  new DataView(b.buffer).setUint32(1, seq, true);
  return b;
}

/** Build a fake self-describing frontier: [count 1B][entry 5B]*count. */
function fakeFrontier(entries: Array<[number, number]>): Uint8Array {
  const parts = [new Uint8Array([entries.length]), ...entries.map(([i, s]) => frontierEntry(i, s))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe("campfire/wire", () => {
  describe("GroupMsg", () => {
    it("build + parse round-trip, frontier with 0 entries (10 random iterations)", () => {
      for (let i = 0; i < 10; i++) {
        const msgId = randomMsgId();
        const senderId = randomPeerId();
        const seq = Math.floor(Math.random() * 0xFFFFFFFF);
        const epochId = Math.floor(Math.random() * 0xFFFF);
        const timestamp = Date.now() + Math.floor(Math.random() * 100000);
        const hopCount = Math.floor(Math.random() * 256);
        const contentType = Math.floor(Math.random() * 4);
        const frontier = fakeFrontier([]);
        const ciphertextLen = 1 + Math.floor(Math.random() * 200);
        const ciphertext = randomBytes(ciphertextLen);

        const wire = buildGroupMsg(msgId, senderId, seq, epochId, timestamp, hopCount, contentType, frontier, ciphertext);
        const parsed = parseGroupMsgHeader(wire.subarray(1));

        assertBytesEqual(parsed.msgId, msgId, `msgId iter ${i}`);
        assertBytesEqual(parsed.senderId, senderId, `senderId iter ${i}`);
        assert.equal(parsed.seq, seq, `seq iter ${i}`);
        assert.equal(parsed.epochId, epochId, `epochId iter ${i}`);
        assert.equal(parsed.hopCount, hopCount, `hopCount iter ${i}`);
        assert.equal(parsed.contentType, contentType, `contentType iter ${i}`);
        assertBytesEqual(parsed.frontier, frontier, `frontier iter ${i}`);
        assertBytesEqual(parsed.ciphertext, ciphertext, `ciphertext iter ${i}`);
      }
    });

    it("round-trip, frontier with 1 entry", () => {
      const msgId = randomMsgId();
      const senderId = randomPeerId();
      const frontier = fakeFrontier([[0, 42]]);
      const ciphertext = randomBytes(64);

      const wire = buildGroupMsg(msgId, senderId, 7, 3, Date.now(), 0, 0, frontier, ciphertext);
      const parsed = parseGroupMsgHeader(wire.subarray(1));

      assertBytesEqual(parsed.frontier, frontier, "1-entry frontier");
      assertBytesEqual(parsed.ciphertext, ciphertext, "ciphertext after 1-entry frontier");
    });

    it("round-trip, frontier with 3 entries", () => {
      const msgId = randomMsgId();
      const senderId = randomPeerId();
      const frontier = fakeFrontier([[0, 1], [2, 99], [5, 0xFFFFFFFF]]);
      const ciphertext = randomBytes(128);

      const wire = buildGroupMsg(msgId, senderId, 12, 9, Date.now(), 3, 2, frontier, ciphertext);
      const parsed = parseGroupMsgHeader(wire.subarray(1));

      assertBytesEqual(parsed.frontier, frontier, "3-entry frontier");
      assertBytesEqual(parsed.ciphertext, ciphertext, "ciphertext after 3-entry frontier");
      assert.equal(parsed.hopCount, 3);
      assert.equal(parsed.contentType, 2);
    });

    it("binary ciphertext round-trip", () => {
      const ciphertext = randomBytes(500);
      const frontier = fakeFrontier([[1, 5]]);
      const wire = buildGroupMsg(randomMsgId(), randomPeerId(), 1, 1, Date.now(), 0, 0, frontier, ciphertext);
      const parsed = parseGroupMsgHeader(wire.subarray(1));
      assertBytesEqual(parsed.ciphertext, ciphertext, "binary ciphertext");
    });
  });

  describe("rewrapGroupMsg", () => {
    it("changes only hop count, preserves everything else", () => {
      for (let i = 0; i < 5; i++) {
        const msgId = randomMsgId();
        const senderId = randomPeerId();
        const originalHop = Math.floor(Math.random() * 128);
        const newHop = Math.floor(Math.random() * 128) + 128;
        const frontier = fakeFrontier([[0, 3]]);
        const ciphertext = randomBytes(50);
        const wire = buildGroupMsg(msgId, senderId, 4, 2, Date.now(), originalHop, 0, frontier, ciphertext);

        const rewrapped = rewrapGroupMsg(wire, newHop);
        const parsed = parseGroupMsgHeader(rewrapped.subarray(1));

        assert.equal(parsed.hopCount, newHop, `hop updated iter ${i}`);
        assertBytesEqual(parsed.msgId, msgId, `msgId preserved iter ${i}`);
        assertBytesEqual(parsed.senderId, senderId, `senderId preserved iter ${i}`);
        assertBytesEqual(parsed.ciphertext, ciphertext, `ciphertext preserved iter ${i}`);
      }
    });

    it("hopCount offset (65) matches the new layout", () => {
      const wire = buildGroupMsg(randomMsgId(), randomPeerId(), 1, 1, Date.now(), 11, 0, fakeFrontier([]), randomBytes(10));
      assert.equal(wire[65], 11, "hopCount byte lands at offset 65");
      const rewrapped = rewrapGroupMsg(wire, 99);
      assert.equal(rewrapped[65], 99, "rewrap writes the same offset");
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

  describe("BraidFold", () => {
    it("round-trip 20 random iterations, both reasons", () => {
      for (let i = 0; i < 20; i++) {
        const newEpochId = Math.floor(Math.random() * 0xFFFFFFFF);
        const reason = i % 2 === 0 ? 1 : 2;
        const subjectPeerId = randomPeerId();
        const entropy = randomBytes(32);
        const rosterDigest = randomBytes(32);

        const wire = buildBraidFold(newEpochId, reason, subjectPeerId, entropy, rosterDigest);
        const parsed = parseBraidFold(wire.subarray(1));

        assert.equal(parsed.newEpochId, newEpochId, `newEpochId iter ${i}`);
        assert.equal(parsed.reason, reason, `reason iter ${i}`);
        assertBytesEqual(parsed.subjectPeerId, subjectPeerId, `subjectPeerId iter ${i}`);
        assertBytesEqual(parsed.entropy, entropy, `entropy iter ${i}`);
        assertBytesEqual(parsed.rosterDigest, rosterDigest, `rosterDigest iter ${i}`);
      }
    });

    it("boundary epoch values", () => {
      for (const newEpochId of [0, 1, 0xFFFFFFFF]) {
        const wire = buildBraidFold(newEpochId, 1, randomPeerId(), randomBytes(32), randomBytes(32));
        const parsed = parseBraidFold(wire.subarray(1));
        assert.equal(parsed.newEpochId, newEpochId);
      }
    });
  });

  describe("BraidWelcome", () => {
    it("round-trip with 0, 1, 5, 20 roster entries", () => {
      for (const count of [0, 1, 5, 20]) {
        const epochId = Math.floor(Math.random() * 0xFFFFFFFF);
        const senderPeerId = randomPeerId();
        const root = randomBytes(32);
        const roster = Array.from({ length: count }, () => randomPeerId());

        const wire = buildBraidWelcome(epochId, senderPeerId, root, roster);
        const parsed = parseBraidWelcome(wire.subarray(1));

        assert.equal(parsed.epochId, epochId, `epochId count=${count}`);
        assertBytesEqual(parsed.senderPeerId, senderPeerId, `senderPeerId count=${count}`);
        assertBytesEqual(parsed.root, root, `root count=${count}`);
        assert.equal(parsed.roster.length, count, `roster length count=${count}`);
        for (let i = 0; i < count; i++) {
          assertBytesEqual(parsed.roster[i], roster[i], `roster[${i}] count=${count}`);
        }
      }
    });
  });

  describe("JoinReq", () => {
    it("round-trip 20 iterations with various names", () => {
      const names = [
        "Alice", "Bob", "田中太郎", "José García", "Ünsal", "O'Brien",
        "", "A", "x".repeat(100), "emoji 🎉", "null\x00byte",
      ];
      for (let i = 0; i < 20; i++) {
        const joinerId = randomPeerId();
        const name = names[i % names.length];
        const wire = buildJoinReq(joinerId, name);
        const parsed = parseJoinReq(wire.subarray(1));
        assertBytesEqual(parsed.joinerId, joinerId, `joinerId iter ${i}`);
        assert.equal(parsed.name, name, `name iter ${i}: "${name}"`);
      }
    });
  });
});
