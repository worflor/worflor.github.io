/**
 * braid-adversary.test.ts — the threat models the rest of the suite does not have.
 *
 * Everything else tests the braid against noise: tampering, truncation, reorder,
 * malformed frames. Those are outsider attacks, and the braid handles them by
 * construction because an outsider has no keys. The interesting adversaries all
 * hold something:
 *
 *   §1 A MEMBER. Holds the epoch root, because every member does.
 *   §2 A PAST SELF. Holds a full state snapshot from earlier in the epoch.
 *   §3 AN EX-MEMBER. Held everything, up to the moment of the fold.
 *   §4 THE NETWORK. Holds nothing, but decides what arrives and what does not.
 *
 * The first of these produces a NEGATIVE result, and it is stated here as a test
 * rather than buried in a comment, because a protocol document that quietly
 * omits it is the more dangerous artifact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDeterministicRng, deterministicBytes } from "./_helpers/generators.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import {
  braidFold,
  braidInit,
  braidSeal,
  braidOpen,
  braidWants,
  braidStatus,
  BRAID_MAX_STRIKES,
} from "../../src/scripts/whisper/live-braid.js";
import type { BraidState, BraidMessage, BraidOpenResult } from "../../src/scripts/whisper/live-braid.js";
import {
  generateIdentity, signBytes, verifyAuthored,
} from "../../src/scripts/whisper/campfire/identity.js";

const TE = new TextEncoder();
const TD = new TextDecoder();

const hexId = (n: number) => n.toString(16).padStart(2, "0").repeat(16);
const pt = (s: string) => TE.encode(s);

function cloneMsg(m: BraidMessage): BraidMessage {
  return {
    attachment: undefined, senderIndex: m.senderIndex, seq: m.seq, epochId: m.epochId,
    confirm: m.confirm.slice(), frontier: m.frontier.slice(), ciphertext: m.ciphertext.slice(),
  };
}

/** minimal circle: label -> seat index over the sorted roster braidInit imposes. */
class Circle {
  constructor(
    readonly epochId: number,
    readonly root: Uint8Array,
    readonly roster: string[],
    readonly hexOf: Map<string, string>,
    readonly idxOf: Map<string, number>,
    readonly states: BraidState[],
  ) {}

  static async make(labels: string[], epochId: number, seed: number, prevRoot: Uint8Array | null = null) {
    const hexOf = new Map(labels.map((l, i) => [l, hexId(i + 1)]));
    const roster = Array.from(hexOf.values()).sort();
    const root = await braidFold(prevRoot, deterministicBytes(32, seed), epochId, roster);
    const idxOf = new Map(labels.map((l) => [l, roster.indexOf(hexOf.get(l)!)]));
    const states: BraidState[] = new Array(roster.length);
    for (const l of labels) states[idxOf.get(l)!] = await braidInit(root, epochId, roster, hexOf.get(l)!);
    return new Circle(epochId, root, roster, hexOf, idxOf, states);
  }

  idx(l: string) { return this.idxOf.get(l)!; }
  state(l: string) { return this.states[this.idx(l)]; }

  async send(l: string, plaintext: Uint8Array): Promise<BraidMessage> {
    const st = this.state(l);
    const { seq, frontier, confirm, ciphertext } = await braidSeal(st, plaintext);
    return { attachment: undefined, senderIndex: st.seatIndex, seq, epochId: st.epochId, confirm, frontier, ciphertext };
  }

  recv(l: string, m: BraidMessage): Promise<BraidOpenResult> {
    return braidOpen(this.state(l), m);
  }
}

/** everything a seat delivered, flattened, in the order it surfaced. */
function delivered(r: BraidOpenResult): string[] {
  if (r.status !== "delivered") return [];
  return r.delivered.map((m) => TD.decode(m.plaintext));
}

/* ========================================================================= */

describe("adversary §1 — a MEMBER of the circle", () => {
  /**
   * THE HONEST NEGATIVE RESULT.
   *
   * Every lane chain is hkdf(epochRoot, seatHex, INFO_SEAT). Every member holds
   * the epoch root, because that is what makes the circle a circle. Therefore
   * every member can derive every OTHER member's send chain, and can mint frames
   * indistinguishable from theirs.
   *
   * This is not a defect to be patched at this layer; it is what "the group
   * shares a key" means. Group-keyed AEAD authenticates GROUP MEMBERSHIP, never
   * individual authorship — the same reason MLS carries per-leaf signatures on
   * top of its group secrets, and the same reason Signal's sender keys ship with
   * a per-sender signing key.
   *
   * The test exists so that nobody reads "AES-GCM authenticated" in the braid and
   * concludes the sender is authenticated. Attribution lives one layer up, and
   * the second test here shows what actually carries it.
   */
  it("any member can mint frames attributed to another seat, using only the epoch root", async () => {
    const circle = await Circle.make(["A", "B", "C"], 1, 0xAD000001);

    // B holds the epoch root like everyone else. It stands up a second copy of
    // A's seat — no stolen state, no side channel, just the group secret.
    const impostor = await braidInit(circle.root, circle.epochId, circle.roster, circle.hexOf.get("A")!);
    const forged = await braidSeal(impostor, pt("A would never say this"));

    const out = await circle.recv("C", {
      attachment: undefined, senderIndex: circle.idx("A"), seq: forged.seq, epochId: circle.epochId,
      confirm: forged.confirm, frontier: forged.frontier, ciphertext: forged.ciphertext,
    });

    assert.equal(out.status, "delivered", "the braid layer accepts it, and this is by design");
    assert.deepEqual(delivered(out), ["A would never say this"]);
    assert.equal(braidStatus(circle.state("C"))[circle.idx("A")].diverged, false,
      "and it leaves no trace at this layer: the frame is cryptographically genuine");
  });

  it("so authorship is carried by a per-seat signature the group key cannot forge", async () => {
    // The campfire layer signs every message body under the SEAT's own key, and
    // peerId commits to that key. Holding the group secret gives an impostor the
    // ciphertext but not the signature, and swapping in its own key changes the
    // peerId, which the roster pins.
    const alice = await generateIdentity();
    const mallory = await generateIdentity();
    const body = pt("ciphertext||seq||epoch as the wire signs it");

    assert.ok(await verifyAuthored(alice.publicKey, alice.peerIdHex, body, await signBytes(alice, body)),
      "alice's own message verifies");
    assert.ok(!(await verifyAuthored(mallory.publicKey, alice.peerIdHex, body, await signBytes(mallory, body))),
      "a member with the group key still cannot sign as alice");
  });

  it("a member CANNOT rewrite a seat's history, because the confirm tag pins it", async () => {
    // The impostor can speak as A going forward. What it cannot do is speak as A
    // about a DIFFERENT past: the message key and the confirm tag both fold in
    // the transcript commitment, so a frame minted against a fabricated history
    // fails against a receiver holding the real one.
    const circle = await Circle.make(["A", "B", "C"], 1, 0xAD000002);
    const m1 = await circle.send("A", pt("the real first message"));
    for (const l of ["B", "C"]) assert.equal((await circle.recv(l, m1)).status, "delivered");

    // impostor builds A's seat but feeds it a different history
    const impostor = await braidInit(circle.root, circle.epochId, circle.roster, circle.hexOf.get("A")!);
    await braidSeal(impostor, pt("a first message that never happened"));
    const forged = await braidSeal(impostor, pt("...and a second built on top of it"));

    const out = await circle.recv("C", {
      attachment: undefined, senderIndex: circle.idx("A"), seq: forged.seq, epochId: circle.epochId,
      confirm: forged.confirm, frontier: forged.frontier, ciphertext: forged.ciphertext,
    });
    assert.notEqual(out.status, "delivered",
      "C holds the true history of A's strand, so a frame minted over a false one does not open");
  });
});

/* ========================================================================= */

describe("adversary §2 — a PAST SELF (state snapshot within an epoch)", () => {
  it("a snapshot taken at frontier F cannot open frames sealed before F", async () => {
    const circle = await Circle.make(["A", "B"], 1, 0xAD000003);

    const captured: BraidMessage[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await circle.send("A", pt(`secret ${i}`));
      captured.push(cloneMsg(m));
      assert.equal((await circle.recv("B", m)).status, "delivered", `frame ${i} was legible when sent`);
    }

    // THE COMPROMISE: B's entire state, exactly as B holds it right now.
    const stolen = circle.state("B");
    const laneChain = stolen.seats.map((_, i) => toHex(braidStatusChain(stolen, i)));

    // Every earlier frame is replayed at the compromised state. The receive lane
    // has ratcheted past each of them, and the ratchet is one-way, so none open.
    for (const old of captured) {
      const r = await braidOpen(stolen, cloneMsg(old));
      assert.notEqual(r.status, "delivered",
        `frame seq ${old.seq} must not reopen at a state that has moved past it`);
    }

    // and the state is genuinely live, not wedged — otherwise the loop above
    // proves only that we broke B.
    const fresh = await circle.send("A", pt("still talking"));
    assert.equal((await braidOpen(stolen, fresh)).status, "delivered",
      "the compromised state still works forward; only the past is shut");
    assert.notDeepEqual(stolen.seats.map((_, i) => toHex(braidStatusChain(stolen, i))), laneChain,
      "and the lanes moved, so 'cannot reopen' is about the ratchet, not about a frozen state");
  });

  it("strikes cannot be farmed by replaying a seat's own genuine old frames", async () => {
    // A replay is not an authentication failure by the SENDER; treating it as one
    // would let anyone who saw a frame on the wire kill the seat that sent it.
    const circle = await Circle.make(["A", "B", "C"], 1, 0xAD000004);
    const m = await circle.send("A", pt("genuine"));
    assert.equal((await circle.recv("C", m)).status, "delivered");

    for (let i = 0; i < BRAID_MAX_STRIKES * 3; i++) {
      await circle.recv("C", cloneMsg(m));
    }
    assert.equal(braidStatus(circle.state("C"))[circle.idx("A")].diverged, false,
      "replaying A's own frames must never sever A");

    const after = await circle.send("A", pt("still trusted"));
    assert.equal((await circle.recv("C", after)).status, "delivered");
  });
});

/** the lane chain is private; read it through the state for snapshot comparison. */
function braidStatusChain(state: BraidState, seatIndex: number): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (state as any).lanes[seatIndex].chain as Uint8Array;
}

/* ========================================================================= */

describe("adversary §3 — an EX-MEMBER across a fold", () => {
  it("frames from a superseded epoch are refused, so a removed seat cannot replay its way back", async () => {
    const before = await Circle.make(["A", "B", "X"], 1, 0xAD000005);
    const stale = await before.send("X", pt("from the epoch X was still in"));
    assert.equal((await before.recv("A", stale)).status, "delivered", "legible before the fold");

    // fold X out. the new root chains off the old one, so the epoch really is a
    // successor rather than an unrelated circle.
    const after = await Circle.make(["A", "B"], 2, 0xAD000006, before.root);

    const replay = cloneMsg(stale);
    replay.epochId = 1;
    assert.notEqual((await after.recv("A", replay)).status, "delivered", "the old epoch is closed");

    // relabelling the frame as current does not help: the key is epoch-derived
    const relabelled = cloneMsg(stale);
    relabelled.epochId = 2;
    relabelled.senderIndex = 0;
    assert.notEqual((await after.recv("A", relabelled)).status, "delivered",
      "and forging the epoch field does not make the key derivable");
  });

  it("the removed seat's own retained state cannot read the epoch it was removed from", async () => {
    const before = await Circle.make(["A", "B", "X"], 1, 0xAD000007);
    const exile = before.state("X");            // X keeps everything it ever had

    const after = await Circle.make(["A", "B"], 2, 0xAD000008, before.root);
    const secret = await after.send("A", pt("post-removal traffic"));

    const r = await braidOpen(exile, cloneMsg(secret));
    assert.notEqual(r.status, "delivered", "removal must be cryptographic, not merely a routing decision");
  });

  it("a READMITTED seat cannot retroactively read the epochs it missed", async () => {
    // Rejoining is not time travel. X is folded out at epoch 2 and back in at
    // epoch 3; traffic from epoch 2 must stay shut even though X is now a member
    // again and holds a legitimate current root.
    const e1 = await Circle.make(["A", "B", "X"], 1, 0xAD000009);
    const e2 = await Circle.make(["A", "B"], 2, 0xAD00000A, e1.root);
    const missed = await e2.send("A", pt("said while X was out"));
    assert.equal((await e2.recv("B", missed)).status, "delivered");

    const e3 = await Circle.make(["A", "B", "X"], 3, 0xAD00000B, e2.root);
    const readmitted = e3.state("X");

    for (const epochId of [2, 3]) {
      const attempt = cloneMsg(missed);
      attempt.epochId = epochId;
      assert.notEqual((await braidOpen(readmitted, attempt)).status, "delivered",
        `readmission must not unlock epoch-2 traffic (tried as epoch ${epochId})`);
    }

    // but the current epoch works, so readmission is a real readmission
    const now = await e3.send("A", pt("welcome back"));
    assert.equal((await braidOpen(readmitted, now)).status, "delivered");
  });
});

/* ========================================================================= */

describe("adversary §4 — the NETWORK decides what arrives", () => {
  it("a permanently lost frame is named in wants, and the gap heals when it is supplied", async () => {
    const circle = await Circle.make(["A", "B"], 1, 0xAD00000C);
    const m1 = await circle.send("A", pt("one"));
    const m2 = await circle.send("A", pt("two"));
    const m3 = await circle.send("A", pt("three"));

    assert.equal((await circle.recv("B", m1)).status, "delivered");
    // m2 is dropped by the network, permanently, and m3 arrives
    const held = await circle.recv("B", m3);
    assert.notEqual(held.status, "delivered", "m3 cannot open before m2 is integrated");

    const wants = braidWants(circle.state("B"));
    const wantA = wants.find((w) => w.seatIndex === circle.idx("A"));
    assert.ok(wantA, "the gap must be reported, or the circle stalls silently");
    assert.ok(wantA!.fromSeq <= 2 && wantA!.toSeq >= 2, `wants must name seq 2, got ${JSON.stringify(wantA)}`);

    // supply it late — the held frame must cascade, in order, exactly once
    const out = await circle.recv("B", m2);
    assert.deepEqual(delivered(out), ["two", "three"],
      "repair delivers the gap and everything it unblocked, in strand order");

    assert.equal(braidWants(circle.state("B")).length, 0, "and the want clears");
  });

  it("randomized chaos: drops, duplicates, reorder and outsider forgeries over many seeds", async () => {
    /**
     * The global invariants, checked against an adversary that reorders freely,
     * duplicates at will, drops permanently, and injects garbage that it has no
     * key for. Nothing here asserts a specific schedule; the point is that NO
     * schedule produces a plaintext nobody sent, an out-of-order strand, or a
     * throw out of the public API.
     */
    for (let seed = 0; seed < 24; seed++) {
      const rng = makeDeterministicRng(0xC4A05000 + seed);
      const labels = ["A", "B", "C"];
      const circle = await Circle.make(labels, 1, 0xAD010000 + seed);

      const sentBy = new Map<string, string[]>(labels.map((l) => [l, []]));
      const seenBy = new Map<string, Map<string, string[]>>(
        labels.map((l) => [l, new Map(labels.map((o) => [o, []]))]),
      );
      const inFlight: Array<{ from: string; msg: BraidMessage }> = [];

      for (let step = 0; step < 120; step++) {
        const roll = rng();

        if (roll < 0.35) {
          // someone speaks
          const from = labels[Math.floor(rng() * labels.length)];
          const text = `${from}#${sentBy.get(from)!.length}`;
          sentBy.get(from)!.push(text);
          const msg = await circle.send(from, pt(text));
          for (const to of labels) if (to !== from) inFlight.push({ from, msg: cloneMsg(msg) });

        } else if (roll < 0.45) {
          // the adversary injects a frame it cannot possibly have keyed
          const to = labels[Math.floor(rng() * labels.length)];
          const from = labels[Math.floor(rng() * labels.length)];
          if (to === from) continue;
          const junk: BraidMessage = {
            attachment: undefined, senderIndex: circle.idx(from),
            seq: 1 + Math.floor(rng() * 6),
            epochId: 1,
            confirm: deterministicBytes(8, 0x9000 + step + seed * 131),
            frontier: deterministicBytes(4 * labels.length, 0xA000 + step + seed * 137),
            ciphertext: deterministicBytes(16 + Math.floor(rng() * 48), 0xB000 + step + seed * 139),
          };
          const r = await braidOpen(circle.state(to), junk);
          assert.notEqual(r.status, "delivered", `seed ${seed}: unkeyed garbage must never deliver`);

        } else if (inFlight.length > 0) {
          // deliver, drop or duplicate something in flight, in any order
          const pick = Math.floor(rng() * inFlight.length);
          const [item] = inFlight.splice(pick, 1);
          const action = rng();
          if (action < 0.12) continue;                       // permanent drop
          if (action < 0.24) inFlight.push({ ...item, msg: cloneMsg(item.msg) }); // duplicate

          const others = labels.filter((l) => l !== item.from);
          const target = others[Math.floor(rng() * others.length)];
          const r = await braidOpen(circle.state(target), item.msg);
          if (r.status === "delivered") {
            for (const d of r.delivered) {
              const text = TD.decode(d.plaintext);
              const author = text.split("#")[0];
              assert.ok(sentBy.get(author)!.includes(text),
                `seed ${seed}: delivered a plaintext nobody sent: ${text}`);
              const log = seenBy.get(target)!.get(author)!;
              const idx = Number(text.split("#")[1]);
              assert.equal(idx, log.length,
                `seed ${seed}: ${target} saw ${author}'s messages out of order or twice`);
              log.push(text);
            }
          }
        }
      }

      // every seat's view of every strand is a PREFIX of what that strand sent:
      // loss may leave a seat behind, but never ahead and never scrambled.
      for (const to of labels) {
        for (const author of labels) {
          if (to === author) continue;
          const seen = seenBy.get(to)!.get(author)!;
          const sent = sentBy.get(author)!;
          assert.deepEqual(seen, sent.slice(0, seen.length),
            `seed ${seed}: ${to}'s view of ${author} is not a prefix of what ${author} sent`);
        }
      }
    }
  });
});
