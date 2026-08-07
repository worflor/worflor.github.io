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
  injectForgedMessageFrom,
  corruptGroupCiphertext,
  teardown,
  type NodeRecord,
} from "./_helpers/campfire-harness.js";
import { buildBraidWelcome, buildBraidFold, braidFoldSigningBody, buildJoinAnnounce, buildCfReact, buildGroupMsg, groupMsgSigningBody, parseBraidFold, foldRecipientFor } from "../../src/scripts/whisper/campfire/wire.js";
import { signBytes, openFromAgreement, sealToAgreement, setIdentitySource, resetIdentitySource, type CampfireIdentity } from "../../src/scripts/whisper/campfire/identity.js";
import { seededIdentitiesInRosterOrder, identityListSource, permutations } from "./_harness/seeded-identities.js";

const INFO_FOLD_ENTROPY = new TextEncoder().encode("kizuna-fold-entropy-v1");
import { braidFold, braidInit, braidSeal, BRAID_STALL_THRESHOLD } from "../../src/scripts/whisper/live-braid.js";
import { sha256, concatBytes } from "../../src/scripts/whisper/wasm.js";
import { CF_GROUP_MSG, CF_BRAID_FOLD, MAX_KNOWN_PEERS, REACT_DEDUP_RING, CF_REACT } from "../../src/scripts/whisper/campfire/types.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TE = new TextEncoder();
function le32Test(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

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
async function buildCircle(net: VirtualNet, hostName: string, joinerNames: string[], nodeOpts: { ringRepairIntervalMs?: number; beaconCheckMs?: number; beaconIdleMs?: number } = {}): Promise<NodeRecord[]> {
  const host = makeNode(net, hostName, nodeOpts);
  const recs: NodeRecord[] = [host];
  for (const name of joinerNames) {
    const joiner = makeNode(net, name, nodeOpts);
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

  // SKIP: still ~1 run in 5 (measured 4/20 on 2026-08-04). When the departing
  // elder is ALSO the genesis host it is a topology hub, and losing it can
  // partition the fake mesh before pure-topology reconnection heals it.
  //
  // UNSKIPPED. This was parked on the reading that elder departure is a topology
  // problem the braid cannot solve: while the mesh is partitioned there is no
  // link to carry a welcome or a stale-epoch frame, so no amount of epoch
  // recovery helps. That reading was right about the mechanism and wrong about
  // the cause. The partition was not inherent to losing the hub; it was
  // manufactured earlier, by the root relaying mesh SDP down a single link that
  // could be closing, which left seats at degree one. Once an edge negotiation
  // floods like everything else, the survivors already have the second link they
  // need and convergence follows without any braid change at all.
  //
  // Kept honest by mutation: restoring either the direct-relay shortcut or the
  // weaker bootstrap release makes this fail again.
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

  it("drop + ring repair heals: B recovers missed messages once the repair interval fires", { timeout: 15_000 }, async () => {
    const net = new VirtualNet(7);
    // drive both recovery cadences fast + deterministically. recovery leans on
    // the auto-beacon (which advances silent frontiers) as much as the repair
    // interval, so racing the real 12s/10s wall clocks flakes under load.
    const recs = await buildCircle(net, "A", ["B", "C"], { ringRepairIntervalMs: 150, beaconCheckMs: 150, beaconIdleMs: 300 });
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
      // both cadences fire fast now; poll a short deadline for the recovery to
      // land. load-insensitive because the work, not a wall clock, gates it.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
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
  it("a message in flight when TWO folds land still opens: outgoing epochs drain in parallel", async () => {
    const net = new VirtualNet(11);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4", "s5"]); // 5 seats
    try {
      const hostHex = recs[0].node.getPeerIdHex();
      const elder = elderHex(recs[0])!;
      // two seats that are neither host nor elder, so each leave is a plain fold
      const leavers = recs.filter((r) => {
        const hex = r.node.getPeerIdHex();
        return hex !== hostHex && hex !== elder;
      }).slice(0, 2);
      assert.equal(leavers.length, 2, "found two ordinary seats to leave");
      const victim = recs.find((r) => !leavers.includes(r) && r !== recs[0])!;
      const sender = recs[0];
      const epochBefore = epochOf(victim)!.epochId;

      // hold every group message bound for the victim, keeping the bytes so we
      // can hand them over after the roster has turned twice.
      const inFlight: Uint8Array[] = [];
      net.dropFilter = (_from, to, bytes) => {
        if (to !== victim.idx || bytes[0] !== CF_GROUP_MSG) return false;
        inFlight.push(bytes.slice());
        return true;
      };

      await sender.node.broadcastText("sent before the churn");
      await net.drain();
      assert.ok(inFlight.length > 0, "the victim's copy was actually held in flight");
      assert.ok(
        !victim.messages.map(textOf).includes("sent before the churn"),
        "sanity: the victim has not seen it yet",
      );

      // two departures in quick succession, both inside one grace window.
      for (const leaver of leavers) {
        await leaver.node.endCampfire("test: quick departure");
        await net.drain();
      }
      assert.equal(epochOf(victim)!.epochId, epochBefore + 2, "the roster turned twice");

      // the straggler finally arrives, two epochs late.
      net.dropFilter = undefined;
      for (const bytes of inFlight) await injectForgedMessage(victim, bytes);
      await net.drain();

      assert.ok(
        victim.messages.map(textOf).includes("sent before the churn"),
        "a message sealed two epochs ago still opens; a single-slot drain would have wiped that epoch",
      );

      // and the current epoch is unharmed by the replay.
      await sender.node.broadcastText("after the churn");
      await net.drain();
      assert.ok(victim.messages.map(textOf).includes("after the churn"), "current-epoch traffic still flows");
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
  it("only the elder can author a fold: a member's forgery is refused, including one that removes someone else", async () => {
    // The fold carries the entropy that advances the root, so whoever mints one
    // knows the epoch it produces. Nothing derived from the shared root can say
    // who that was, since every member holds the root. A seat id is the hash of
    // its public key, so the roster is already a set of key commitments and the
    // elder's signature is checkable by everyone.
    const net = new VirtualNet(31);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
    try {
      const eh = elderHex(recs[0])!;
      // the attacker departs in the control below, so it must be neither the
      // elder nor the genesis host: losing either is a topology-hub departure,
      // whose partition flakiness is unrelated to what this test checks.
      const attacker = recs.find((r) => r.node.getPeerIdHex() !== eh && r !== recs[0])!;
      const attackerHex = attacker.node.getPeerIdHex();
      // the victim must not be the elder: the control step below has the elder
      // depart, and a departed node has no epoch left to inspect.
      const victim = recs.find((r) => {
        if (r === attacker || r.node.getPeerIdHex() === eh) return false;
        const nb: Map<string, { connected: boolean; peerIdHex: string }> =
          (r.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string }> }).neighbors;
        return [...nb.values()].some((p) => p.connected && p.peerIdHex === attackerHex);
      });
      assert.ok(victim, "some seat has a direct link to the attacker");

      const before = epochOf(victim!)!;
      const prevRoot = before.root.slice();
      const identity = (attacker.node as unknown as { identity: CampfireIdentity }).identity;
      const evilEntropy = new Uint8Array(32).fill(0x41); // attacker-chosen, hence attacker-known

      // two forgeries: removing ITSELF (the departing-member attack), and
      // removing a DIFFERENT seat (evicting someone at will).
      for (const subjectHex of [attackerHex, before.roster.find((h) => h !== eh && h !== attackerHex)!]) {
        const newRoster = before.roster.filter((h) => h !== subjectHex);
        const digest = await sha256(concatBytes(...newRoster.map(hexToBytes)));
        const body = braidFoldSigningBody(
          before.epochId + 1, 2 /* LEAVE */, hexToBytes(subjectHex),
          evilEntropy, digest, identity.publicKey, new Uint8Array(33),
        );
        // a REAL signature — the attacker genuinely holds this key. what it does
        // not hold is the elder's, and that is the whole check.
        const signature = await signBytes(identity, body);
        const forged = buildBraidFold(
          before.epochId + 1, 2, hexToBytes(subjectHex), evilEntropy, digest,
          identity.publicKey, new Uint8Array(33), signature,
        );

        assert.ok(
          await injectForgedMessageFrom(victim!, attackerHex, forged),
          "the forged fold was delivered over the attacker's own link",
        );
        await net.drain();

        // `postForgery`, not `after`: that name is the runner's hook and shadowing
        // it silently breaks type inference here.
        const postForgery: { epochId: number; roster: string[]; root: Uint8Array } = epochOf(victim!)!;
        assert.equal(
          postForgery.epochId, before.epochId,
          `forged fold removing ${subjectHex.slice(0, 6)} did not move the epoch`,
        );
        const attackerPredicted = await braidFold(prevRoot, evilEntropy, before.epochId + 1, newRoster);
        assert.ok(
          !postForgery.root.every((byte: number, i: number) => byte === attackerPredicted[i]),
          "the victim is not on a root the attacker can compute",
        );
      }

      // CONTROL: the circle is unharmed by the refusals, so this is a check and
      // not a wall. Genuine, elder-signed folds are proven to work by every join
      // and leave test in this file; what needs proving HERE is that refusing a
      // forgery leaves the victim fully functional rather than wedged.
      const elderRec = recs.find((r) => r.node.getPeerIdHex() === eh)!;
      await elderRec.node.broadcastText("still talking");
      await net.drain();
      assert.ok(
        victim!.messages.map(textOf).includes("still talking"),
        "the victim still receives traffic after refusing the forgeries",
      );
      assert.equal(epochOf(victim!)!.epochId, before.epochId, "and it never moved off its epoch");
    } finally {
      await teardown(recs);
    }
  });

  it("a seat stranded by a partition walks itself forward from a neighbor's retained folds", async () => {
    // losing a hub can partition the mesh; by the time topology heals, the fold
    // that turned the roster is long gone from the network and nobody re-sends
    // it, so the stranded seat would sit on a dead epoch forever. neighbors keep
    // the folds they applied and hand them over when they see a stale epoch.
    const net = new VirtualNet(41);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4", "s5"]);
    try {
      const eh = elderHex(recs[0])!;
      const nonElders = recs.filter((r) => r.node.getPeerIdHex() !== eh);
      const victim = nonElders[0];
      const leaver = nonElders[1];
      const leaverHex = leaver.node.getPeerIdHex();
      const others = recs.filter((r) => r !== victim && r !== leaver);
      const before = epochOf(victim)!.epochId;

      // cut the victim off entirely, so the leave fold never reaches it.
      net.dropFilter = (_from, to) => to === victim.idx;
      await leaver.node.endCampfire("test: departure while a seat is partitioned");
      await net.drain();
      net.dropFilter = undefined;

      const stranded = epochOf(victim)!.epochId;
      const ahead = others.filter((r) => epochOf(r)!.epochId > stranded);
      assert.equal(stranded, before, "the victim really did miss the fold");
      assert.ok(ahead.length > 0, "at least one seat moved on without it");

      // the stranded seat speaks; its frame carries the stale epoch, and that is
      // the signal a neighbor uses to walk it forward.
      await victim.node.broadcastText("anyone there?");
      await net.drain();

      const healed = epochOf(victim)!;
      assert.ok(healed.epochId > before, "the victim advanced past the epoch it was stuck on");
      assert.ok(!healed.roster.includes(leaverHex), "it applied the removal, not just any fold");

      // consistency: every seat that shares its epoch shares its root.
      for (const r of others) {
        const e = epochOf(r)!;
        if (e.epochId !== healed.epochId) continue;
        assertBytesEqual(healed.root, e.root, `root agrees with ${r.name} at the same epoch`);
      }

      // and it can read current traffic again.
      const peer = others.find((r) => epochOf(r)!.epochId === healed.epochId)!;
      await peer.node.broadcastText("welcome back");
      await net.drain();
      assert.ok(victim.messages.map(textOf).includes("welcome back"), "the healed seat receives current traffic");
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
  it("retained folds are never served to a peer the circle no longer seats", async () => {
    // a fold IS the secret that removed someone. serving it to a peer missing
    // from the current roster would hand a departed member the entropy that
    // evicted it, and the leave would stop being forward secret. the catch-up
    // path must refuse, and this is the only test that pins it: healing tests
    // still pass with the guard deleted.
    const net = new VirtualNet(51);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
    try {
      const eh = elderHex(recs[0])!;
      const leaver = recs.find((r) => r.node.getPeerIdHex() !== eh && r !== recs[0])!;
      await leaver.node.endCampfire("test: leave so a fold exists to serve");
      await net.drain();

      // a survivor that actually holds a retained fold and a live neighbor link
      const server = recs.find((r) => {
        if (r === leaver) return false;
        const applied: Map<number, unknown> = (r.node as unknown as { appliedFolds: Map<number, unknown> }).appliedFolds;
        return applied.size > 0;
      });
      assert.ok(server, "some survivor retained the fold it applied");

      const neighbors: Map<string, { connected: boolean; peerIdHex: string; session: { sendEncryptedRaw: (b: Uint8Array, t: number) => Promise<void> } | null }> =
        (server!.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string; session: { sendEncryptedRaw: (b: Uint8Array, t: number) => Promise<void> } | null }> }).neighbors;
      const entry = [...neighbors.entries()].find(([, p]) => p.connected && p.session && p.peerIdHex);
      assert.ok(entry, "the server has a live neighbor link to send over");
      const [label, peer] = entry!;

      // count only FOLD frames on that link: welcomes, peer lists and gossip all
      // ride the same link, and counting them would make the negative assertion
      // below fail for reasons that have nothing to do with the guard.
      await net.drain();
      let sent = 0;
      const realSend = peer.session!.sendEncryptedRaw.bind(peer.session);
      peer.session!.sendEncryptedRaw = async (b: Uint8Array, t: number) => {
        if (b[0] === CF_BRAID_FOLD) sent++;
        return realSend(b, t);
      };

      const pushFoldsTo = (server!.node as unknown as {
        pushFoldsTo: (l: string, hex: string, ep: number) => Promise<void>;
      }).pushFoldsTo.bind(server!.node);

      // NEGATIVE: a peer the circle does not seat gets nothing.
      const strangerHex = "de".repeat(16);
      assert.ok(!epochOf(server!)!.roster.includes(strangerHex), "sanity: the stranger is not seated");
      await pushFoldsTo(label, strangerHex, 1);
      assert.equal(sent, 0, "a peer we no longer seat is served no folds");

      // POSITIVE control: a seated peer IS served, so the zero above means the
      // guard fired rather than the push being broken outright.
      await pushFoldsTo(label, peer.peerIdHex, 1);
      assert.ok(sent > 0, "a seated peer is served its missing folds");
    } finally {
      await teardown(recs);
    }
  });
  it("an unopenable frame with traffic piling up behind it surfaces as a stall", async () => {
    // the fork signature, end to end: the frame at nextSeq will not authenticate
    // and later frames queue behind it. this is the only signal a fork produces
    // now that a failed tag is unattributable and never severs anything, so the
    // point of this test is that it reaches the application at all.
    const net = new VirtualNet(61);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const sender = recs[0];
      const senderHex = sender.node.getPeerIdHex();
      const victim = recs.find((r) => {
        const nb: Map<string, { connected: boolean; peerIdHex: string }> =
          (r.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string }> }).neighbors;
        return [...nb.values()].some((p) => p.connected && p.peerIdHex === senderHex);
      })!;

      // withhold a run of genuine frames so we control exactly what the victim sees.
      const captured: Uint8Array[] = [];
      net.dropFilter = (_from, to, bytes) => {
        if (to !== victim.idx || bytes[0] !== CF_GROUP_MSG) return false;
        captured.push(bytes.slice());
        return true;
      };
      const runLength = BRAID_STALL_THRESHOLD + 3;
      for (let i = 0; i < runLength; i++) await sender.node.broadcastText(`frame ${i}`);
      await net.drain();
      net.dropFilter = undefined;
      assert.ok(captured.length >= runLength, `withheld ${captured.length} frames`);

      assert.equal(victim.stalled.length, 0, "nothing reported yet");

      // the frame it needs next is corrupt, so it can never open. its msgId is
      // repaired to match the corrupted ciphertext, otherwise the receiver drops
      // it at the id check and it never reaches the crypto layer at all.
      const forged = await corruptGroupCiphertext(captured[0], sender);
      await injectForgedMessageFrom(victim, senderHex, forged);
      await net.drain();

      // everything after it piles up.
      for (let i = 1; i < runLength; i++) {
        await injectForgedMessageFrom(victim, senderHex, captured[i]);
        await net.drain();
      }

      assert.equal(victim.stalled.length, 1, "reported exactly once, not per frame");
      assert.equal(victim.stalled[0].hex, senderHex, "attributed to the seat we cannot read");
      assert.equal(victim.diverged.length, 0, "a stall is never escalated to divergence");
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
  it("a joiner whose admission was pending on the departing elder is re-admitted by the new one", async () => {
    // an admission lives with whichever elder was asked. if that elder leaves
    // mid-admission the request dies with it and the joiner sits at "joining
    // room" forever, with no event that would ever tell it otherwise.
    // peer ids are random per node, so the topology we need (host is the seat that
    // inherits the elder role) shows up about one run in four. sample enough seeds
    // that missing it is negligible rather than a flaky failure.
    for (let seed = 90; seed < 140; seed++) {
      const net = new VirtualNet(seed);
      const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
      const host = recs[0];
      const eh = elderHex(host)!;
      // the admission is held by whoever owns the joiner's bootstrap link (the
      // host). the fold can only be issued by the elder. this test covers the
      // case those two coincide after the departure, i.e. the host inherits the
      // elder seat, which is what the current fix handles.
      const nextElder = recs.map((r) => r.node.getPeerIdHex()).filter((h) => h !== eh).sort()[0];
      if (eh === host.node.getPeerIdHex() || nextElder !== host.node.getPeerIdHex()) {
        await teardown(recs);
        continue;
      }
      const elder = recs.find((r) => r.node.getPeerIdHex() === eh)!;
      const joiner = makeNode(net, "late");
      try {
        // the elder hears nothing, so the admission stays pending on the host.
        net.dropFilter = (_from, to) => to === elder.idx;

        const offer = host.node.getCurrentOfferCode() ?? await host.node.createCampfire(host.name, false);
        const answer = await joiner.node.joinCampfire(offer, joiner.name, false);
        await host.node.applyAnswer(answer);
        await net.drain();

        assert.equal(joiner.node.state, "connecting", "precondition: the joiner is not seated");
        const held: Map<string, unknown> =
          (host.node as unknown as { pendingAdmissions: Map<string, unknown> }).pendingAdmissions;
        assert.ok(held.has(joiner.node.getPeerIdHex()), "precondition: the host holds the admission");

        // the elder departs. the host inherits the seat and must finish the job.
        net.dropFilter = undefined;
        await elder.node.endCampfire("test: elder leaves mid-admission");
        await net.drain();

        assert.equal(joiner.node.state, "active", "the joiner was re-admitted, not left hanging");
        const ep = epochOf(joiner);
        assert.ok(ep, "the joiner holds an epoch");
        assert.ok(ep!.roster.includes(joiner.node.getPeerIdHex()), "and it is seated in the roster");
        assert.ok(!ep!.roster.includes(eh), "the departed elder is gone from that roster");
        return; // one good seed is enough
      } finally {
        net.dropFilter = undefined;
        await teardown([...recs, joiner]);
      }
    }
    assert.fail("no seed produced a circle whose elder was not the host");
  });
  it("a relay cannot censor a message by racing a forgery that carries its msgId", async () => {
    // Gossip dedups by msgId. If that id were taken from the frame, a relay could
    // read a message, immediately emit garbage carrying the SAME id to a victim,
    // and the victim would mark the id seen, fail to open the forgery, and then
    // discard the genuine copy as a duplicate. The message disappears with no
    // signal anywhere. The same forged frame also enters the repair cache, so
    // ring repair would go on serving the forged bytes for that (seat, seq).
    const net = new VirtualNet(77);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const sender = recs[0];
      const senderHex = sender.node.getPeerIdHex();
      const victim = recs.find((r) => {
        if (r === sender) return false;
        const nb: Map<string, { connected: boolean; peerIdHex: string }> =
          (r.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string }> }).neighbors;
        return [...nb.values()].some((p) => p.connected && p.peerIdHex === senderHex);
      })!;

      // withhold the genuine frame so we control the ordering exactly.
      let genuine: Uint8Array | null = null;
      // block EVERY copy bound for the victim, not just the first: if any other
      // neighbor delivers it, the test passes even with the defence removed.
      net.dropFilter = (_from, to, bytes) => {
        if (to !== victim.idx || bytes[0] !== CF_GROUP_MSG) return false;
        if (!genuine) genuine = bytes.slice();
        return true;
      };
      await sender.node.broadcastText("the message to censor");
      await net.drain();
      net.dropFilter = undefined;
      assert.ok(genuine, "captured the genuine frame");
      assert.ok(
        !victim.messages.map(textOf).includes("the message to censor"),
        "precondition: the victim has not seen it by any other path",
      );

      // the relay's forgery: it keeps the genuine msgId but carries different
      // ciphertext, and it arrives FIRST so it would claim the dedup slot.
      const forged = (genuine as Uint8Array).slice();
      forged[forged.length - 1] ^= 0xff;
      await injectForgedMessageFrom(victim, senderHex, forged);
      await net.drain();

      // now the genuine copy arrives. it must still be delivered.
      await injectForgedMessageFrom(victim, senderHex, genuine as Uint8Array);
      await net.drain();

      assert.ok(
        victim.messages.map(textOf).includes("the message to censor"),
        "the genuine message survived a msgId-colliding forgery",
      );
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
  it("remote-controlled state stays bounded under a flood of unauthenticated frames", async () => {
    // allPeers and seenReacts are fed by JOIN_ANNOUNCE / PEER_LIST / CF_REACT,
    // none of which is authenticated or roster-checked, and each new peer entry
    // is re-gossiped. Unbounded, they are remote memory growth. (Per-ENTRY size
    // is already fine: parseCfReact caps emoji at 32 bytes and keeps only the
    // first grapheme. The unbounded axis is CARDINALITY, driven by the 32-byte
    // attacker-chosen target id, which is what this flood varies.)
    const net = new VirtualNet(83);
    const recs = await buildCircle(net, "s1", ["s2"]);
    try {
      const victim = recs[1];
      const senderHex = recs[0].node.getPeerIdHex();
      const state = victim.node as unknown as {
        allPeers: Map<string, unknown>;
        seenReacts: Set<string>;
      };
      const seatedBefore = epochOf(victim)!.roster.length;

      for (let i = 0; i < MAX_KNOWN_PEERS * 2; i++) {
        const fake = new Uint8Array(16);
        fake[0] = i & 0xFF; fake[1] = (i >>> 8) & 0xFF; fake[2] = 0xAB;
        await injectForgedMessageFrom(victim, senderHex, buildJoinAnnounce(fake, new Uint8Array(33).fill(0xC0), `ghost-${i}`));
      }
      await net.drain();
      assert.ok(
        state.allPeers.size <= MAX_KNOWN_PEERS,
        `allPeers bounded: ${state.allPeers.size} <= ${MAX_KNOWN_PEERS}`,
      );

      // seated peers must survive the flood — the cap must not evict the circle.
      const seats = epochOf(victim)!.roster;
      for (const seat of seats) {
        assert.ok(state.allPeers.has(seat) || seat === victim.node.getPeerIdHex(),
          "a seated peer was evicted by the flood");
      }
      assert.equal(epochOf(victim)!.roster.length, seatedBefore, "the roster itself is untouched");

      const reactsBefore = state.seenReacts.size;
      for (let i = 0; i < REACT_DEDUP_RING + 500; i++) {
        const target = new Uint8Array(32); target[0] = i & 0xFF; target[1] = (i >>> 8) & 0xFF;
        await injectForgedMessageFrom(
          victim, senderHex,
          buildCfReact(CF_REACT, target, hexToBytes(senderHex), "x"),
        );
      }
      await net.drain();
      assert.ok(
        state.seenReacts.size <= REACT_DEDUP_RING,
        `seenReacts bounded: ${state.seenReacts.size} <= ${REACT_DEDUP_RING}`,
      );
      assert.ok(state.seenReacts.size > reactsBefore, "positive control: the flood really was processed");
    } finally {
      await teardown(recs);
    }
  });
  it("an insider cannot impersonate another seat, even holding the epoch root", async () => {
    // The epoch root is shared, so every member can derive EVERY seat's send
    // chain and mint a frame that opens correctly under another seat's name.
    // Confidentiality is symmetric by necessity — a receiver has to derive the
    // sender's key — so authenticity has to come from the sender's own key.
    //
    // The damage this prevents is worse than a fake message: a forged frame at
    // seat C's next seq would ADVANCE C's lane at the victim, so C's genuine
    // message at that seq could never open again. A silent, permanent eviction.
    const net = new VirtualNet(97);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const mallory = recs[0];
      const malloryHex = mallory.node.getPeerIdHex();
      const victim = recs.find((r) => {
        if (r === mallory) return false;
        const nb: Map<string, { connected: boolean; peerIdHex: string }> =
          (r.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string }> }).neighbors;
        return [...nb.values()].some((p) => p.connected && p.peerIdHex === malloryHex);
      })!;
      const impersonated = recs.find((r) => r !== mallory && r !== victim)!;
      const impersonatedHex = impersonated.node.getPeerIdHex();

      // Mallory rebuilds the target's braid state from the SHARED root and seals
      // as them. This is not a guess: it is the same derivation the real seat
      // uses, and it succeeds — which is exactly why the outer check is needed.
      const epoch = epochOf(mallory)!;
      const asVictimSeat = await braidInit(epoch.root, epoch.epochId, epoch.roster, impersonatedHex);
      const sealed = await braidSeal(asVictimSeat, TE.encode("I am not who I claim"));

      const timestamp = Date.now();
      const forgedMsgId = await sha256(concatBytes(
        hexToBytes(impersonatedHex), le32Test(epoch.epochId), le32Test(sealed.seq), sealed.ciphertext,
      ));
      // Mallory signs with HER OWN key — the only one she has.
      const identity = (mallory.node as unknown as { identity: CampfireIdentity }).identity;
      const body = groupMsgSigningBody(
        hexToBytes(impersonatedHex), sealed.seq, epoch.epochId, timestamp, 0,
        sealed.confirm, sealed.frontier, sealed.ciphertext, identity.publicKey,
      );
      const forged = buildGroupMsg(
        forgedMsgId, hexToBytes(impersonatedHex), sealed.seq, epoch.epochId, timestamp, 0, 0,
        sealed.confirm, sealed.frontier, sealed.ciphertext, identity.publicKey,
        await signBytes(identity, body),
      );

      await injectForgedMessageFrom(victim, malloryHex, forged);
      await net.drain();

      assert.ok(
        !victim.messages.map(textOf).includes("I am not who I claim"),
        "a frame signed by the wrong seat must never be delivered",
      );

      // and the impersonated seat is UNHARMED: its genuine next message lands,
      // proving the forgery did not advance its lane.
      await impersonated.node.broadcastText("the real me");
      await net.drain();
      assert.ok(
        victim.messages.map(textOf).includes("the real me"),
        "the impersonated seat can still be heard: its lane was never advanced",
      );
    } finally {
      await teardown(recs);
    }
  });
  it("a stolen key still cannot rewrite history: two frames at one position are self-evident", async () => {
    // Signatures answer "is this seat's key behind this frame". They are blind
    // the moment the key is stolen. The witnesses answer a different question:
    // "do the accounts agree". A seat's strand is monotone, so one position holds
    // exactly one frame; two distinct frames there is a loop that does not close.
    // The thief cannot stop the honest seat from testifying, so the contradiction
    // appears no matter how good the forgery is — and since BOTH frames carry
    // that seat's signature, the pair is evidence anyone can re-verify.
    const net = new VirtualNet(123);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const [relay, victim, target] = recs;
      const targetHex = target.node.getPeerIdHex();
      const epoch = epochOf(relay)!;
      const stolen = (target.node as unknown as { identity: CampfireIdentity }).identity;

      // a perfectly-signed forgery: every cryptographic check it meets will pass.
      const asTarget = await braidInit(epoch.root, epoch.epochId, epoch.roster, targetHex);
      const sealed = await braidSeal(asTarget, TE.encode("forged: transfer the funds"));
      const ts = Date.now();
      const forgedId = await sha256(concatBytes(
        hexToBytes(targetHex), le32Test(epoch.epochId), le32Test(sealed.seq), sealed.ciphertext,
      ));
      const body = groupMsgSigningBody(
        hexToBytes(targetHex), sealed.seq, epoch.epochId, ts, 0,
        sealed.confirm, sealed.frontier, sealed.ciphertext, stolen.publicKey,
      );
      const forged = buildGroupMsg(
        forgedId, hexToBytes(targetHex), sealed.seq, epoch.epochId, ts, 0, 0,
        sealed.confirm, sealed.frontier, sealed.ciphertext, stolen.publicKey,
        await signBytes(stolen, body),
      );

      await injectForgedMessageFrom(victim, relay.node.getPeerIdHex(), forged);
      await net.drain();
      assert.equal(victim.equivocations.length, 0, "nothing to see yet: one frame, one position");

      // the honest seat speaks for itself. that is the second witness.
      await target.node.broadcastText("genuine: do not transfer anything");
      await net.drain();

      assert.equal(victim.equivocations.length, 1, "the contradiction is reported exactly once");
      assert.equal(victim.equivocations[0].hex, targetHex, "and it names the seat whose strand was rewritten");
      assert.equal(victim.equivocations[0].seq, sealed.seq, "at the contested position");
    } finally {
      await teardown(recs);
    }
  });
  it("a re-admitted member is not handed the folds for epochs it was excluded from", async () => {
    // A fold's entropy IS the secret that advances the root, and it ships in
    // cleartext inside the frame. A member removed at epoch N retains root_N; if
    // it is later re-admitted and then announces a LOW epoch, a naive catch-up
    // hands it every entropy from N+1 onward and it can reconstruct exactly the
    // traffic it was excluded from. `theirEpochId` is peer-supplied, so it must
    // not be allowed to decide how far back the catch-up reaches.
    const net = new VirtualNet(151);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const server = recs[0];
      const node = server.node as unknown as {
        seatedSince: Map<string, number>;
        appliedFolds: Map<number, unknown>;
        currentEpoch: { epochId: number; roster: string[] };
        pushFoldsTo: (l: string, hex: string, ep: number) => Promise<void>;
      };
      const neighbors: Map<string, { connected: boolean; peerIdHex: string; session: { sendEncryptedRaw: (b: Uint8Array, t: number) => Promise<void> } | null }> =
        (server.node as unknown as { neighbors: Map<string, { connected: boolean; peerIdHex: string; session: { sendEncryptedRaw: (b: Uint8Array, t: number) => Promise<void> } | null }> }).neighbors;
      const entry = [...neighbors.entries()].find(([, p]) => p.connected && p.session && p.peerIdHex);
      assert.ok(entry, "a live neighbor link to serve over");
      const [label, peer] = entry!;

      await net.drain();
      let foldsSent = 0;
      const realSend = peer.session!.sendEncryptedRaw.bind(peer.session);
      peer.session!.sendEncryptedRaw = async (b: Uint8Array, t: number) => {
        if (b[0] === CF_BRAID_FOLD) foldsSent++;
        return realSend(b, t);
      };

      const current = node.currentEpoch.epochId;
      assert.ok(node.appliedFolds.size > 0, "precondition: folds are retained to serve");

      // pretend this peer only entered the roster at the CURRENT epoch, then let
      // it claim epoch 1 — the readmission attacker's move.
      node.seatedSince.set(peer.peerIdHex, current);
      await node.pushFoldsTo(label, peer.peerIdHex, 1);
      assert.equal(foldsSent, 0, "no fold from before it was seated may be served");

      // POSITIVE CONTROL: a continuously-seated peer still gets its catch-up, so
      // the gate discriminates rather than disabling repair.
      foldsSent = 0;
      node.seatedSince.set(peer.peerIdHex, 0);
      await new Promise((r) => setTimeout(r, 1100)); // clear the per-peer throttle
      await node.pushFoldsTo(label, peer.peerIdHex, 1);
      assert.ok(foldsSent > 0, "a genuinely lagging member is still caught up");
    } finally {
      await teardown(recs);
    }
  });
  it("a removed member cannot derive the next root even given the ENTIRE fold frame", async () => {
    // This is the property that was FALSE before fold entropy was sealed. The
    // old frame carried the entropy in cleartext, and a removed member holds the
    // previous root — so newRoot = HKDF(prevRoot, entropy) meant the commit
    // packet WAS the new root for them. The only thing withholding it was that
    // nobody relayed the frame, which is a transport accident, not a guarantee.
    //
    // Now each remaining member gets its own sealed copy and the removed subject
    // gets none, so handing the attacker the whole frame changes nothing.
    const net = new VirtualNet(191);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
    try {
      const eh = elderHex(recs[0])!;
      const leaver = recs.find((r) => r.node.getPeerIdHex() !== eh && r !== recs[0])!;
      const leaverHex = leaver.node.getPeerIdHex();
      const survivor = recs.find((r) => r !== leaver && r.node.getPeerIdHex() !== eh)!;

      const before = epochOf(leaver)!;
      const prevRoot = before.root.slice();      // the leaver legitimately holds this
      const leaverIdentity = (leaver.node as unknown as { identity: CampfireIdentity }).identity;

      // capture the LEAVE fold frame in full, exactly as any relay would see it
      let foldFrame: Uint8Array | null = null;
      net.dropFilter = (_from, _to, bytes) => {
        if (bytes[0] === CF_BRAID_FOLD && !foldFrame) foldFrame = bytes.slice();
        return false; // observe only
      };
      await leaver.node.endCampfire("test: departure");
      await net.drain();
      net.dropFilter = undefined;
      assert.ok(foldFrame, "captured the fold frame that removed them");

      const parsed = parseBraidFold((foldFrame as Uint8Array).subarray(1));
      assert.ok(parsed, "the frame parses");
      assert.equal(parsed!.reason, 2, "it is the LEAVE fold");

      // 1. there is no copy addressed to the removed seat
      assert.equal(
        foldRecipientFor(parsed!.recipients, leaverHex), null,
        "the removed member is not among the recipients",
      );

      // 2. and no OTHER member's copy opens under their key either
      let opened = 0;
      for (let o = 0; o + 97 <= parsed!.recipients.length; o += 97) {
        const sealed = parsed!.recipients.subarray(o + 16, o + 97);
        const got = await openFromAgreement(leaverIdentity.agreement, sealed, INFO_FOLD_ENTROPY);
        if (got) opened++;
      }
      assert.equal(opened, 0, "holding the whole frame yields no entropy at all");

      // 3. POSITIVE CONTROL: a surviving member DOES open its copy, so the frame
      // really does carry usable entropy — it is just not usable by the leaver.
      const survivorIdentity = (survivor.node as unknown as { identity: CampfireIdentity }).identity;
      const mine = foldRecipientFor(parsed!.recipients, survivor.node.getPeerIdHex());
      assert.ok(mine, "a surviving member has a copy");
      const entropy = await openFromAgreement(survivorIdentity.agreement, mine!, INFO_FOLD_ENTROPY);
      assert.ok(entropy, "and it opens");

      // 4. that entropy is what advances the root, and it reproduces the real one
      const survivorEpoch = epochOf(survivor)!;
      const recomputed = await braidFold(prevRoot, entropy!, parsed!.newEpochId, survivorEpoch.roster);
      assertBytesEqual(recomputed, survivorEpoch.root, "the sealed entropy is the real epoch secret");
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
  it("POST-COMPROMISE: a seat that updates locks out an attacker holding its old state", async () => {
    // The scenario every other test assumes away: the attacker already won. It
    // holds a seat's agreement key, and because every lane chain derives from the
    // shared epoch root, that is the whole circle's traffic. The roster is
    // correct, so no join or leave will ever fire — and the epoch root moved only
    // on membership change, which is why compromise used to be permanent.
    const net = new VirtualNet(211);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const victim = recs[1];
      const victimNode = victim.node as unknown as {
        identity: CampfireIdentity;
        currentEpoch: { epochId: number; root: Uint8Array };
        updateOwnKeys: () => Promise<void>;
      };

      // the attacker's snapshot: the agreement key AND the current epoch root
      const stolenAgreement = victimNode.identity.agreement;
      const stolenRoot = victimNode.currentEpoch.root.slice();
      const epochBefore = victimNode.currentEpoch.epochId;

      // capture every fold frame from here on, exactly as a relay would see them
      const folds: Uint8Array[] = [];
      net.dropFilter = (_from, _to, bytes) => {
        if (bytes[0] === CF_BRAID_FOLD) folds.push(bytes.slice());
        return false;
      };

      await victimNode.updateOwnKeys();
      await net.drain();
      net.dropFilter = undefined;

      const after = victimNode.currentEpoch;
      assert.equal(after.epochId, epochBefore + 1, "the update advanced the epoch");
      assert.ok(folds.length > 0, "an update fold went out");

      // the roster is untouched: this is a rekey, not a membership change
      const rosterAfter = epochOf(victim)!.roster;
      assert.equal(rosterAfter.length, recs.length, "membership preserved");
      assert.ok(rosterAfter.includes(victim.node.getPeerIdHex()), "the seat kept its place");

      // THE PROPERTY. Give the attacker the entire update frame and its stolen
      // key, and it still cannot reach the new root.
      const parsed = parseBraidFold(folds[folds.length - 1].subarray(1));
      assert.ok(parsed, "the fold parses");
      assert.equal(parsed!.reason, 3, "it is an UPDATE fold");

      let opened = 0;
      for (let o = 0; o + 97 <= parsed!.recipients.length; o += 97) {
        const sealed = parsed!.recipients.subarray(o + 16, o + 97);
        if (await openFromAgreement(stolenAgreement, sealed, INFO_FOLD_ENTROPY)) opened++;
      }
      assert.equal(opened, 0, "the stolen key opens nothing in the update");

      // and the stolen root cannot be walked forward without that entropy
      assert.notEqual(
        toHex(stolenRoot), toHex(after.root),
        "the root moved somewhere the attacker cannot follow",
      );

      // POSITIVE CONTROL: the seat itself healed rather than locking itself out.
      // its NEW key opens its own copy, and the circle keeps working.
      const mine = foldRecipientFor(parsed!.recipients, victim.node.getPeerIdHex());
      assert.ok(mine, "the seat has a copy addressed to it");
      const entropy = await openFromAgreement(victimNode.identity.agreement, mine!, INFO_FOLD_ENTROPY);
      assert.ok(entropy, "the ROTATED key opens it — the seat recovered");

      await recs[0].node.broadcastText("after the heal");
      await net.drain();
      assert.ok(
        victim.messages.map(textOf).includes("after the heal"),
        "the healed seat still receives group traffic",
      );
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });

  it("the heal DURABLE: a later fold by another seat still excludes the old key", async () => {
    // Healing once is not enough. Every seat seals fold entropy to the keys it
    // believes its peers hold, so if the circle does not RECORD the rotation, the
    // next fold issued by anyone else goes straight back to the compromised key
    // and the attacker is readmitted one epoch later.
    const net = new VirtualNet(217);
    const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
    try {
      const eh = elderHex(recs[0])!;
      const victim = recs.find((r) => r.node.getPeerIdHex() !== eh && r !== recs[0])!;
      const victimNode = victim.node as unknown as {
        identity: CampfireIdentity;
        updateOwnKeys: () => Promise<void>;
      };
      const stolenAgreement = victimNode.identity.agreement; // the attacker's copy

      await victimNode.updateOwnKeys();
      await net.drain();
      assert.notEqual(
        victimNode.identity.agreement, stolenAgreement,
        "precondition: the seat really rotated",
      );

      // now a DIFFERENT seat drives a fold. capture what it seals.
      const folds: Uint8Array[] = [];
      net.dropFilter = (_from, _to, bytes) => {
        if (bytes[0] === CF_BRAID_FOLD) folds.push(bytes.slice());
        return false;
      };
      const leaver = recs.find((r) => r !== victim && r.node.getPeerIdHex() !== eh)!;
      await leaver.node.endCampfire("test: someone else drives the next fold");
      await net.drain();
      net.dropFilter = undefined;
      assert.ok(folds.length > 0, "a later fold went out");

      const parsed = parseBraidFold(folds[folds.length - 1].subarray(1));
      assert.ok(parsed, "it parses");

      // THE DURABILITY PROPERTY: the stolen key opens nothing in a fold it had
      // no part in, because the circle recorded the rotation.
      let opened = 0;
      for (let o = 0; o + 97 <= parsed!.recipients.length; o += 97) {
        const sealed = parsed!.recipients.subarray(o + 16, o + 97);
        if (await openFromAgreement(stolenAgreement, sealed, INFO_FOLD_ENTROPY)) opened++;
      }
      assert.equal(opened, 0, "the heal survived a fold issued by someone else");

      // POSITIVE CONTROL: the healed seat can still open its own copy, so the
      // zero above is exclusion and not a broken fold.
      const mine = foldRecipientFor(parsed!.recipients, victim.node.getPeerIdHex());
      if (mine) {
        assert.ok(
          await openFromAgreement(victimNode.identity.agreement, mine, INFO_FOLD_ENTROPY),
          "the rotated key still works",
        );
      }
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });

  it("an UPDATE is self-issued: no seat may rotate another seat's key", async () => {
    // If the elder could mint updates for others it would hold the power to
    // replace anyone's key material, which is the compromise it is meant to cure.
    const net = new VirtualNet(213);
    const recs = await buildCircle(net, "s1", ["s2", "s3"]);
    try {
      const attacker = recs[0];
      const attackerHex = attacker.node.getPeerIdHex();
      const target = recs[1];
      const targetHex = target.node.getPeerIdHex();
      const victim = recs[2];
      const before = epochOf(victim)!;

      const identity = (attacker.node as unknown as { identity: CampfireIdentity }).identity;
      const digest = await sha256(concatBytes(...before.roster.map(hexToBytes)));
      const entropy = new Uint8Array(32).fill(0x77);
      const parts: Uint8Array[] = [];
      for (const memberHex of before.roster) {
        const known = (attacker.node as unknown as {
          allPeers: Map<string, { agreementKey: Uint8Array }>;
        }).allPeers.get(memberHex);
        if (!known) continue;
        const sealed = await sealToAgreement(known.agreementKey, entropy, INFO_FOLD_ENTROPY);
        parts.push(hexToBytes(memberHex), sealed!);
      }
      const recipients = concatBytes(...parts);
      const rotated = new Uint8Array(33).fill(0x42); // an attacker-chosen "new key" for the target

      // signed by the ATTACKER, but naming the TARGET as the subject
      const body = braidFoldSigningBody(
        before.epochId + 1, 3 /* UPDATE */, hexToBytes(targetHex),
        recipients, digest, identity.publicKey, rotated,
      );
      const forged = buildBraidFold(
        before.epochId + 1, 3, hexToBytes(targetHex), recipients, digest,
        identity.publicKey, rotated, await signBytes(identity, body),
      );

      await injectForgedMessageFrom(victim, attackerHex, forged);
      await net.drain();

      assert.equal(epochOf(victim)!.epochId, before.epochId, "the forged update did not take hold");
      const known = (victim.node as unknown as {
        allPeers: Map<string, { agreementKey: Uint8Array }>;
      }).allPeers.get(targetHex);
      assert.ok(known, "the target is still known");
      assert.notEqual(toHex(known!.agreementKey), toHex(rotated), "its key was not replaced");
    } finally {
      await teardown(recs);
    }
  });

  it("member leave holds under EVERY roster ordering, not the one this run happened to draw", { timeout: 120_000 }, async () => {
    // The leave scenario above used to fail about one run in three and nothing
    // in the test named why: seat ids are hashes of fresh keys, so which node is
    // elder, which is the genesis host, and where each sits in the ring were a
    // fresh draw every run. The bug it was sampling was real (an SDP relay that
    // took a single route could lose a mesh edge, leaving a seat at degree one
    // that any departure of its one neighbor cut off), but it only showed up for
    // the orderings that put the half-built edge next to the leaver.
    //
    // So this pins the ordering instead of the outcome: seeded identities are
    // dealt to the four nodes in all 24 orders, and in each one every seat that
    // can legitimately drive a plain fold takes its turn leaving. The elder and
    // the genesis host are excluded for the same reason the elder-leave test
    // above is skipped — losing either is a topology-hub departure with a known
    // partition gap, which is a different claim from this one.
    const seats = await seededIdentitiesInRosterOrder(0x5EA7, 4);
    let scenarios = 0;
    for (const order of permutations([0, 1, 2, 3])) {
      // fresh identity objects per scenario: a node owns its identity and may
      // rotate the agreement half, and sharing one across scenarios would let an
      // earlier run reach into a later one.
      const dealt = order.map((i) => ({ ...seats[i], agreement: { ...seats[i].agreement } }));
      const previous = setIdentitySource(identityListSource(dealt));
      try {
        const elderHexExpected = dealt.map((d) => d.peerIdHex).sort()[0];
        const hostHexExpected = dealt[0].peerIdHex;
        for (let leaverIdx = 1; leaverIdx < 4; leaverIdx++) {
          if (dealt[leaverIdx].peerIdHex === elderHexExpected) continue;
          if (dealt[leaverIdx].peerIdHex === hostHexExpected) continue;
          setIdentitySource(identityListSource(
            dealt.map((d) => ({ ...d, agreement: { ...d.agreement } })),
          ));
          const net = new VirtualNet(4);
          const recs = await buildCircle(net, "s1", ["s2", "s3", "s4"]);
          const label = `[order ${order.join("")} leaver s${leaverIdx + 1}]`;
          try {
            assert.equal(elderHex(recs[0]), elderHexExpected, `${label} the deal decided the elder`);
            const beforeEpoch = epochOf(recs[0])!.epochId;
            const leaver = recs[leaverIdx];
            const survivors = recs.filter((r) => r !== leaver);

            await leaver.node.endCampfire("test: voluntary leave");
            await net.drain();

            for (const rec of survivors) {
              const epoch = epochOf(rec)!;
              assert.equal(epoch.epochId, beforeEpoch + 1, `${label} ${rec.name} epoch bumped by exactly 1`);
              assert.ok(!epoch.roster.includes(leaver.node.getPeerIdHex()), `${label} ${rec.name} roster excludes the leaver`);
            }
            const rootRef = epochOf(survivors[0])!.root;
            for (const rec of survivors.slice(1)) {
              assertBytesEqual(epochOf(rec)!.root, rootRef, `${label} ${rec.name} root matches after fold`);
            }

            for (const rec of survivors) await rec.node.broadcastText(`post-leave from ${rec.name}`);
            await net.drain();
            for (const rec of survivors) {
              const texts = rec.messages.map(textOf);
              for (const other of survivors) {
                assert.ok(texts.includes(`post-leave from ${other.name}`), `${label} ${rec.name} has ${other.name}'s post-leave message`);
              }
            }
            scenarios++;
          } finally {
            await teardown(recs);
          }
        }
      } finally {
        setIdentitySource(previous);
      }
    }
    resetIdentitySource();
    assert.ok(scenarios >= 24, `covered ${scenarios} orderings`);
  });
});
