/**
 * admission-survival.test.ts — an admission must outlive the elder that was asked.
 *
 * Seating a joiner needs two different seats to cooperate, and nothing forces
 * them to be the same seat:
 *
 *   the ADMITTER holds the joiner's bootstrap link and is the only member that
 *   can still reach it, since an unseated joiner has exactly one edge.
 *
 *   the ELDER is roster[0], and is the only member allowed to mint the fold
 *   that seats anyone.
 *
 * So the request crosses a relay, and `handleJoinReq` has the elder CONSUME it
 * without forwarding — correctly, since re-flooding a request the elder is
 * already acting on is pure amplification. The consequence is that the elder can
 * become the sole holder of that fact. If it stops being elder before the fold
 * lands, the fact is gone: its successor may never have seen the request, and
 * the admitter has no reason to speak again. The joiner sits at "joining room"
 * with a live link and nobody on the other end who remembers it exists.
 *
 * The repair is the ADMITTER asking again. That is the only route that works in
 * general, and measurement rather than argument says so: an inheriting seat can
 * also drain the copies it relayed, but removing that drain changes no outcome
 * here, because seating a joiner is useless without the admitter — the welcome
 * can only come from the seat holding the link. The drain remains as a fast
 * path. The two scenarios below differ in whether other seats saw the request,
 * and the second exists to pin that the extra copies cost nothing.
 *
 * The retry hangs off the roster: every fold is a roster change, hence exactly
 * the event that can move the elder, so every fold re-reads what is still
 * unseated. Level-triggered on the roster rather than edge-triggered on the
 * elder role — and since the roster is also what records success, the retry
 * silences itself with no flag to maintain.
 *
 * The joiner ALSO re-announces whenever it hears a departure, which covers most
 * real cases. That path is blocked throughout this file on purpose: it needs the
 * joiner to receive gossip, and the joiner is the participant whose connectivity
 * is least established. What is under test is whether the seated MEMBERS can
 * repair an admission without the joiner's help.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VirtualNet, makeNode, connect, epochOf, elderHex, findByHex,
  teardown, type NodeRecord,
} from "./_helpers/campfire-harness.js";
import { CF_JOIN_REQ, CF_LEAVE_ANNOUNCE } from "../../src/scripts/whisper/campfire/types.js";

const TD = new TextDecoder();

/**
 * A room whose root is neither the elder nor the heir.
 *
 * The root is the only seat that accepts bootstrap links, so it is always the
 * admitter. If it were also the elder the request would never cross a relay; if
 * it were the heir, inheriting the role would repair the admission by itself and
 * neither route below would be under test.
 *
 * Elder is roster[0] and identities are random, so this needs two members whose
 * ids sort below the root's. Adding members and hoping is not good enough: a
 * root that lands near the bottom of the id space needs an unbounded number of
 * them, which is exactly the flake this originally shipped with. Instead the
 * ROOT is drawn until it sits in the upper half, after which each member is an
 * independent coin flip and a handful always suffices.
 */
async function roomWhereRootIsNotElder(net: VirtualNet): Promise<{
  root: NodeRecord; all: NodeRecord[];
}> {
  let root: NodeRecord | null = null;
  for (let i = 0; i < 40 && !root; i++) {
    const candidate = makeNode(net, "root");
    await candidate.node.createCampfire("root", false);
    if (candidate.node.getPeerIdHex() >= "80") root = candidate;
    else await candidate.node.endCampfire();
  }
  assert.ok(root, "could not draw a root id in the upper half of the space");

  const members: NodeRecord[] = [];
  for (let i = 0; i < 16; i++) {
    const m = makeNode(net, `m${i}`);
    await connect(root, m);
    members.push(m);
    const epoch = epochOf(root);
    if (!epoch) continue;
    // two seats ahead of the root: one is the elder, the next inherits.
    if (epoch.roster.length >= 3 && epoch.roster.indexOf(root.node.getPeerIdHex()) >= 2) {
      return { root, all: [root, ...members] };
    }
  }
  // Reported rather than skipped: a vacuous pass here would hide the file.
  assert.fail("could not build a room whose root is neither elder nor heir");
}

interface Stranded {
  net: VirtualNet;
  root: NodeRecord;
  all: NodeRecord[];
  joiner: NodeRecord;
  elder: NodeRecord;
}

/**
 * Drive the room to the moment of the bug: a joiner holding a live link to the
 * root, unseated, with the elder about to leave.
 *
 * `reqReaches` decides which seats saw the relayed request, which is precisely
 * what selects between the two repair routes.
 */
async function strand(reqReaches: "nobody" | "everyone-but-the-elder"): Promise<Stranded> {
  const net = new VirtualNet();
  net.deliveryCeiling = 400_000;
  const { root, all } = await roomWhereRootIsNotElder(net);
  const elder = findByHex(all, elderHex(root)!)!;
  assert.notEqual(elder, root, "precondition: the admitter is not the elder");

  const joiner = makeNode(net, "joiner");
  net.dropFilter = (_from, to, bytes) => {
    if (to === joiner.idx && bytes[0] === CF_LEAVE_ANNOUNCE) return true; // no self-rescue
    if (bytes[0] !== CF_JOIN_REQ) return false;
    return reqReaches === "nobody" ? true : to === elder.idx;
  };

  await connect(root, joiner);
  await net.drain();

  assert.equal(epochOf(joiner), null, "precondition: the joiner is unseated and waiting");
  assert.ok(!epochOf(root)!.roster.includes(joiner.node.getPeerIdHex()),
    "precondition: no seat believes the joiner is in");

  return { net, root, all, joiner, elder };
}

/** the elder departs; from here only the seated members can repair anything. */
async function elderDeparts(s: Stranded): Promise<void> {
  // requests flow again — the point is that nobody has a reason to send one.
  s.net.dropFilter = (_from, to, bytes) =>
    to === s.joiner.idx && bytes[0] === CF_LEAVE_ANNOUNCE;

  await s.elder.node.endCampfire();
  await s.net.drain();

  const heir = elderHex(s.root);
  assert.ok(heir && heir !== s.elder.node.getPeerIdHex(), "precondition: the role actually moved");
  assert.notEqual(heir, s.root.node.getPeerIdHex(),
    "precondition: the heir is not the admitter, so inheriting is not what repairs this");
  await s.net.drain();
}

function assertSeated(s: Stranded): void {
  const roster = epochOf(s.root)!.roster;
  assert.ok(roster.includes(s.joiner.node.getPeerIdHex()),
    `the admission must survive the elder that was asked; ${roster.length} seats and the joiner is not among them`);
  assert.ok(epochOf(s.joiner) !== null,
    "and the joiner must receive the welcome, not merely be listed by others");
  assert.equal(s.joiner.states.at(-1), "active",
    `the joiner must leave "joining room"; it ended at ${s.joiner.states.at(-1)}`);
}

describe("a pending admission survives the elder that was asked", () => {
  it("RE-ASKED: the admitter speaks again when the elder was the only seat that knew", async () => {
    // The hard route. No other seat ever saw the request, so `relayedJoinReqs`
    // is empty everywhere and inheritance has nothing to drain. The only member
    // that still knows the joiner exists is the one holding its link.
    const s = await strand("nobody");
    await elderDeparts(s);
    assertSeated(s);

    s.net.dropFilter = undefined;
    await s.root.node.broadcastText("after the repair");
    await s.net.drain();
    for (const r of [...s.all, s.joiner]) {
      if (r === s.root || r === s.elder) continue;
      assert.ok(r.messages.some((m) => m.plaintext && TD.decode(m.plaintext) === "after the repair"),
        `${r.name} must receive traffic in the repaired epoch`);
    }
    await teardown([...s.all, s.joiner]);
  });

  it("repairs the same way when other seats DID see the request", async () => {
    // The heir is holding a relayed copy here, so there is a second route: it
    // can drain `relayedJoinReqs` on inheriting. Removing that drain does not
    // change the outcome of either scenario, measured — seating a joiner is
    // useless without the admitter, since the welcome can only come from the
    // seat holding the link, and that seat is now re-asking anyway. The drain
    // survives as a fast path, not as the thing that makes this pass.
    //
    // This case is kept because it is the COMMON one in a real room, and it
    // pins that the extra copies cause no harm: no duplicate fold, no epoch
    // inflation, one seat.
    const s = await strand("everyone-but-the-elder");
    const before = epochOf(s.root)!.epochId;
    await elderDeparts(s);
    assertSeated(s);

    // one fold removes the elder, one seats the joiner. Every seat holding a
    // relayed copy could have minted its own; if any did, the count runs over.
    const after = epochOf(s.root)!.epochId;
    assert.ok(after - before <= 2,
      `at most a leave fold and a join fold should have been minted, saw ${after - before}`);
    const rosterHexes = new Set(epochOf(s.root)!.roster);
    assert.equal(rosterHexes.size, epochOf(s.root)!.roster.length, "no seat may appear twice");

    await teardown([...s.all, s.joiner]);
  });

  it("goes quiet once the joiner is seated, instead of re-folding every epoch", async () => {
    // The retry runs on every fold, so what stops it is the roster check rather
    // than a flag. If that check were wrong, ordinary traffic would mint an
    // epoch per fold forever.
    const net = new VirtualNet();
    const root = makeNode(net, "root");
    const a = makeNode(net, "a");
    const b = makeNode(net, "b");
    await connect(root, a);
    await connect(root, b);
    await net.drain();

    const settled = epochOf(root)!.epochId;
    for (let i = 0; i < 5; i++) {
      await root.node.broadcastText(`chatter ${i}`);
      await net.drain();
    }
    assert.equal(epochOf(root)!.epochId, settled,
      "a seated room must not mint epochs: the retry has to silence itself");
    await teardown([root, a, b]);
  });

  it("a dead bootstrap link drops the admission rather than re-asking forever", async () => {
    // The retry re-reads the held admissions on every fold, so an entry whose
    // link is gone would be re-asked for the rest of the session. Built on the
    // same non-elder root, since a root that is elder seats the joiner at once
    // and clears the entry for an unrelated reason.
    const s = await strand("nobody");
    const admissions: Map<string, unknown> =
      (s.root.node as unknown as { pendingAdmissions: Map<string, unknown> }).pendingAdmissions;
    assert.equal(admissions.size, 1, "precondition: the root is holding exactly this admission");

    await s.joiner.node.endCampfire();
    await s.net.drain();

    assert.equal(admissions.size, 0,
      "an admission whose link died is unanswerable and must not be retained");
    await teardown([...s.all, s.joiner]);
  });
});
