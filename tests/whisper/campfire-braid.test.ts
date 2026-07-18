/**
 * campfire-braid.test.ts
 *
 * deterministic multi-node integration tests for the campfire gossip stack
 * (../../src/scripts/whisper/campfire/gossip.ts) over the braid crypto core
 * (../../src/scripts/whisper/live-braid.ts). every node in a scenario is a
 * real CampfireNode wired to a fake in-process transport (./_helpers/
 * campfire-harness.ts) instead of webrtc, so join, fold, gossip, repair,
 * and leave all run through the exact production code path — the harness
 * only replaces the network.
 *
 * scenarios exercise: genesis + join, five-seat convergence, reordered
 * gossip, member leave, elder leave, joining mid-conversation with no
 * history replay, drop + ring repair healing, and welcome cross-check
 * integrity against a forged epoch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import {
  VirtualNet,
  makeNode,
  connect,
  epochOf,
  elderHex,
  connectedNeighborCount,
  findByHex,
  injectForgedMessage,
  teardown,
  type NodeRecord,
} from "./_helpers/campfire-harness.js";
import { buildBraidWelcome } from "../../src/scripts/whisper/campfire/wire.js";
import { CF_GROUP_MSG } from "../../src/scripts/whisper/campfire/types.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TD = new TextDecoder();

function textOf(msg: { plaintext: Uint8Array }): string {
  return TD.decode(msg.plaintext);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** build a circle: a host plus sequential joiners, connecting (and draining)
 *  one at a time — each join goes through the host's current root slot,
 *  which only exists once the previous join has fully settled. */
async function buildCircle(net: VirtualNet, hostName: string, joinerNames: string[]): Promise<NodeRecord[]> {
  const host = makeNode(net, hostName);
  const recs: NodeRecord[] = [host];
  for (const name of joinerNames) {
    const joiner = makeNode(net, name);
    await connect(host, joiner);
    recs.push(joiner);
  }
  return recs;
}

describe("campfire braid integration", () => {
  it("genesis + first join: converge to epoch 2 with identical roots and rosters", async () => {
    const net = new VirtualNet(1);
    const recs = await buildCircle(net, "ember-host", ["joiner-1"]);
    const [host, joiner] = recs;
    try {
      assert.equal(host.node.state, "active", "host active");
      assert.equal(joiner.node.state, "active", "joiner active");

      const hostEpoch = epochOf(host)!;
      const joinerEpoch = epochOf(joiner)!;
      assert.ok(hostEpoch, "host seated");
      assert.ok(joinerEpoch, "joiner seated");
      assert.equal(hostEpoch.epochId, 2, "host epoch: genesis(1) + join fold(2)");
      assert.equal(joinerEpoch.epochId, 2, "joiner epoch: genesis(1) + join fold(2)");
      assertBytesEqual(hostEpoch.root, joinerEpoch.root, "epoch roots match");
      assert.deepStrictEqual(hostEpoch.roster, joinerEpoch.roster, "rosters match");

      await host.node.broadcastText("hello from host");
      await joiner.node.broadcastText("hello from joiner");
      await net.drain();

      for (const rec of recs) {
        const texts = rec.messages.map(textOf);
        assert.ok(texts.includes("hello from host"), `${rec.name} sees host's message`);
        assert.ok(texts.includes("hello from joiner"), `${rec.name} sees joiner's message`);
        for (const msg of rec.messages) {
          const sender = msg.senderIdHex === host.node.getPeerIdHex() ? host : joiner;
          assert.equal(msg.senderIdHex, sender.node.getPeerIdHex(), `${rec.name}: message carries correct senderIdHex`);
        }
        // beacons/system messages (contentType 0x02, ContentType.System) never surface here.
        for (const msg of rec.messages) assert.notEqual(msg.contentType, 0x02, `${rec.name}: no system messages leak into onMessage`);
      }
    } finally {
      await teardown(recs);
    }
  });

  it("five seats converge to the same epoch, roster, and root; all messages propagate; mesh forms", async () => {
    const net = new VirtualNet(2);
    const joinerNames = ["s2", "s3", "s4", "s5"];
    const recs = await buildCircle(net, "s1", joinerNames);
    try {
      // genesis (epoch 1) plus one fold per successful join.
      const expectedEpoch = 1 + joinerNames.length;
      for (const rec of recs) {
        assert.equal(rec.node.state, "active", `${rec.name} active`);
        assert.equal(epochOf(rec)!.epochId, expectedEpoch, `${rec.name} epoch`);
      }

      const rootRef = epochOf(recs[0])!.root;
      const rosterRef = epochOf(recs[0])!.roster;
      assert.equal(rosterRef.length, 5, "five seats in the roster");
      for (const rec of recs.slice(1)) {
        assertBytesEqual(epochOf(rec)!.root, rootRef, `${rec.name} root matches`);
        assert.deepStrictEqual(epochOf(rec)!.roster, rosterRef, `${rec.name} roster matches`);
      }

      for (const rec of recs) await rec.node.broadcastText(`hi from ${rec.name}`);
      await net.drain();

      for (const rec of recs) {
        const texts = rec.messages.map(textOf);
        for (const other of recs) {
          assert.ok(texts.includes(`hi from ${other.name}`), `${rec.name} has ${other.name}'s message`);
        }
      }

      for (const rec of recs) {
        assert.ok(connectedNeighborCount(rec) >= 1, `${rec.name} has at least one connected neighbor (topology formed)`);
      }
    } finally {
      await teardown(recs);
    }
  });

  it("reordered gossip still converges: 12 messages across 5 seats, no divergence", async () => {
    const net = new VirtualNet(3);
    const joinerNames = ["s2", "s3", "s4", "s5"];
    // joins stay strict FIFO — the handshake sequence is order-sensitive.
    const recs = await buildCircle(net, "s1", joinerNames);
    try {
      const expectedEpoch = 1 + joinerNames.length;
      for (const rec of recs) assert.equal(epochOf(rec)!.epochId, expectedEpoch, `${rec.name} epoch before messages`);

      // reorder only the message phase — bounded reorder via the seeded rng.
      net.reorder = true;
      const senders = [
        recs[0], recs[2], recs[4], recs[1], recs[3],
        recs[0], recs[1], recs[4], recs[2], recs[3],
        recs[0], recs[4],
      ];
      const sentTexts: string[] = [];
      for (let i = 0; i < senders.length; i++) {
        const text = `msg-${i}-from-${senders[i].name}`;
        sentTexts.push(text);
        await senders[i].node.broadcastText(text);
      }
      await net.drain();
      net.reorder = false;

      for (const rec of recs) {
        const texts = rec.messages.map(textOf);
        for (const text of sentTexts) assert.ok(texts.includes(text), `${rec.name} has "${text}"`);
        assert.equal(rec.diverged.length, 0, `${rec.name}: no seat diverged under reordered delivery`);
      }
    } finally {
      await teardown(recs);
    }
  });

  it("member leave folds the circle: epoch bumps by 1, roster excludes the leaver, survivors keep messaging", async () => {
    const net = new VirtualNet(4);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]); // 4 seats
    try {
      const beforeEpoch = epochOf(recs[0])!.epochId;
      const hostHex = recs[0].node.getPeerIdHex();
      const elder = elderHex(recs[0])!;

      const leaver = recs.find((r) => {
        const hex = r.node.getPeerIdHex();
        return hex !== hostHex && hex !== elder;
      });
      assert.ok(leaver, "found a non-host, non-elder seat to leave");
      const survivors = recs.filter((r) => r !== leaver);

      await leaver!.node.endCampfire("test: voluntary leave");
      await net.drain();

      for (const rec of survivors) {
        const epoch = epochOf(rec)!;
        assert.equal(epoch.epochId, beforeEpoch + 1, `${rec.name} epoch bumped by exactly 1`);
        assert.ok(!epoch.roster.includes(leaver!.node.getPeerIdHex()), `${rec.name} roster excludes the leaver`);
      }
      const rootRef = epochOf(survivors[0])!.root;
      for (const rec of survivors.slice(1)) assertBytesEqual(epochOf(rec)!.root, rootRef, `${rec.name} root matches after fold`);

      for (const rec of survivors) await rec.node.broadcastText(`post-leave from ${rec.name}`);
      await net.drain();
      for (const rec of survivors) {
        const texts = rec.messages.map(textOf);
        for (const other of survivors) {
          assert.ok(texts.includes(`post-leave from ${other.name}`), `${rec.name} has ${other.name}'s post-leave message`);
        }
      }
    } finally {
      await teardown(recs);
    }
  });

  it("elder leave: the new elder issues the fold, survivors converge and keep messaging", async () => {
    const net = new VirtualNet(5);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]); // 4 seats
    try {
      const beforeEpoch = epochOf(recs[0])!.epochId;
      const oldElderHex = elderHex(recs[0])!;
      const leaver = findByHex(recs, oldElderHex)!;
      assert.ok(leaver, "found the elder seat");
      const survivors = recs.filter((r) => r !== leaver);
      const expectedNewElder = epochOf(survivors[0])!.roster.filter((h) => h !== oldElderHex)[0];

      await leaver.node.endCampfire("test: elder leaves");
      await net.drain();

      for (const rec of survivors) {
        const epoch = epochOf(rec)!;
        assert.equal(epoch.epochId, beforeEpoch + 1, `${rec.name} epoch bumped after elder leave`);
        assert.equal(epoch.roster[0], expectedNewElder, `${rec.name} sees the new elder in seat 0`);
        assert.ok(!epoch.roster.includes(oldElderHex), `${rec.name} roster excludes the old elder`);
      }

      for (const rec of survivors) await rec.node.broadcastText(`still here: ${rec.name}`);
      await net.drain();
      for (const rec of survivors) {
        const texts = rec.messages.map(textOf);
        for (const other of survivors) {
          assert.ok(texts.includes(`still here: ${other.name}`), `${rec.name} has ${other.name}'s message`);
        }
      }
    } finally {
      await teardown(recs);
    }
  });

  it("join mid-conversation: the joiner gets no pre-join history, only messages sent after it seats", async () => {
    const net = new VirtualNet(6);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]); // 3 seats
    try {
      const preJoinTexts = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
      for (let i = 0; i < preJoinTexts.length; i++) {
        await recs[i % recs.length].node.broadcastText(preJoinTexts[i]);
      }
      await net.drain();
      for (const rec of recs) {
        const texts = rec.messages.map(textOf);
        for (const text of preJoinTexts) assert.ok(texts.includes(text), `${rec.name} has pre-join "${text}"`);
      }

      const joiner = makeNode(net, "s4");
      await connect(recs[0], joiner);
      recs.push(joiner);

      const joinerTextsAtJoin = joiner.messages.map(textOf);
      for (const text of preJoinTexts) {
        assert.ok(!joinerTextsAtJoin.includes(text), `joiner must not see pre-join "${text}"`);
      }

      const postJoinTexts = ["post-1", "post-2", "post-3"];
      for (let i = 0; i < postJoinTexts.length; i++) {
        await recs[i % recs.length].node.broadcastText(postJoinTexts[i]);
      }
      await net.drain();

      const joinerTextsAfter = joiner.messages.map(textOf);
      for (const text of postJoinTexts) assert.ok(joinerTextsAfter.includes(text), `joiner sees post-join "${text}"`);
      for (const text of preJoinTexts) assert.ok(!joinerTextsAfter.includes(text), `joiner still lacks pre-join "${text}"`);
      assert.equal(joinerTextsAfter.length, postJoinTexts.length, "joiner has exactly the post-join messages, nothing else");

      const rootRef = epochOf(recs[0])!.root;
      for (const rec of recs) assertBytesEqual(epochOf(rec)!.root, rootRef, `${rec.name} root matches after joiner seated`);
    } finally {
      await teardown(recs);
    }
  });

  it("drop + ring repair heals: B recovers missed messages once the repair interval fires", { timeout: 60_000 }, async () => {
    const net = new VirtualNet(7);
    const recs = await buildCircle(net, "A", ["B", "C"]); // 3 seats, full triangle mesh
    const [A, B] = recs;
    try {
      await A.node.broadcastText("m1");
      const hex1 = toHex(A.messages[A.messages.length - 1].msgId);
      await A.node.broadcastText("m2");
      const hex2 = toHex(A.messages[A.messages.length - 1].msgId);

      // drop by content (msgId match) on every edge into B, so B genuinely
      // never receives m1/m2 regardless of whether it comes direct from A
      // or forwarded through C.
      net.dropFilter = (_from, to, bytes) => {
        if (to !== B.idx) return false;
        if (bytes[0] !== CF_GROUP_MSG) return false;
        const hex = toHex(bytes.subarray(1, 33));
        return hex === hex1 || hex === hex2;
      };
      await net.drain();

      let bTexts = B.messages.map(textOf);
      assert.ok(!bTexts.includes("m1"), "B has not received m1 (dropped)");
      assert.ok(!bTexts.includes("m2"), "B has not received m2 (dropped)");

      await A.node.broadcastText("m3");
      await net.drain();

      bTexts = B.messages.map(textOf);
      assert.ok(!bTexts.includes("m3"), "B holds m3 behind the frontier gap (frontier starvation)");

      net.dropFilter = undefined;
      // the 12s repair interval fires on the real clock; under full-suite
      // load its firing can slip past a fixed wait, so poll with a deadline
      // instead of trusting one sleep.
      const deadline = Date.now() + 24_000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        await net.drain();
        if (B.messages.map(textOf).includes("m3")) break;
      }

      bTexts = B.messages.map(textOf);
      assert.ok(bTexts.includes("m1"), "B recovered m1 via ring repair");
      assert.ok(bTexts.includes("m2"), "B recovered m2 via ring repair");
      assert.ok(bTexts.includes("m3"), "B recovered m3 via ring repair");
      const i1 = bTexts.indexOf("m1");
      const i2 = bTexts.indexOf("m2");
      const i3 = bTexts.indexOf("m3");
      assert.ok(i1 < i2 && i2 < i3, "B recovered m1, m2, m3 in order");
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });

  it("welcome cross-check integrity: a forged BRAID_WELCOME with the wrong root ends only that member", async () => {
    const net = new VirtualNet(8);
    const recs = await buildCircle(net, "A", ["B", "C"]); // 3 seats
    const [A, B, C] = recs;
    try {
      const epoch = epochOf(B)!;
      const wrongRoot = new Uint8Array(32).fill(0xEE); // definitely not the real root
      const forged = buildBraidWelcome(
        epoch.epochId,
        hexToBytes(A.node.getPeerIdHex()),
        wrongRoot,
        epoch.roster.map(hexToBytes),
      );

      await injectForgedMessage(B, forged);
      await net.drain();

      assert.equal(B.node.state, "ended", "B ended after the forged welcome disagreed on shape");
      const lastDetail = B.stateDetails[B.stateDetails.length - 1]?.detail ?? "";
      assert.ok(lastDetail.includes("would not agree on its shape"), `B's ended detail explains why: "${lastDetail}"`);

      assert.equal(A.node.state, "active", "A survives");
      assert.equal(C.node.state, "active", "C survives");

      await A.node.broadcastText("still going");
      await net.drain();
      assert.ok(C.messages.map(textOf).includes("still going"), "C still receives traffic after B's exit");
    } finally {
      await teardown(recs);
    }
  });
});
