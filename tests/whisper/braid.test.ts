/**
 * braid.test.ts
 *
 * behavioral test suite for live-braid.ts, the n-seat generalization of the
 * kizuna membrane. each seat keeps its own ordered send chain; the group
 * shares a commutative count-model; every message carries the sender's
 * frontier (highest integrated seq per seat) so a receiver can reconstruct
 * the sender's exact view, digest it, and derive the message key. a sender
 * whose history diverged derives a key nobody else can derive, gcm rejects,
 * and after bounded strikes the seat's bond is dead for this epoch.
 *
 * this exercises the full public surface against real crypto (no mocking):
 * braidFold/braidInit lifecycle, braidSeal/braidOpen round trips, cascade
 * delivery, held/wants bookkeeping, tamper -> strike -> divergence, aad
 * binding, frontier hygiene, epoch folding, wipe, store gc, and queue
 * serialization under concurrent calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { makeDeterministicRng, deterministicBytes } from "./_helpers/generators.js";
import { loopInit, loopTrain, modelDigest } from "../../src/scripts/whisper/live-loop.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";
import {
  braidFold,
  braidInit,
  braidSeal,
  braidSealInnerForTest,
  braidOpen,
  braidWants,
  braidStatus,
  braidWipe,
  encodeFrontier,
  parseFrontier,
  BRAID_MAX_STRIKES,
  BRAID_MAX_DECODED_LEN,
  BRAID_STALL_THRESHOLD,
  BRAID_PAD_BUCKET,
  BRAID_STORE_TTL_MS,
} from "../../src/scripts/whisper/live-braid.js";
import type {
  BraidState,
  BraidMessage,
  BraidOpenResult,
  BraidWant,
} from "../../src/scripts/whisper/live-braid.js";

const TE = new TextEncoder();
const TD = new TextDecoder();

// --- harness -------------------------------------------------------------

/** hex seat id in the "01".repeat(16) shape the design doc uses. n in 1..255. */
function hexId(n: number): string {
  const h = n.toString(16).padStart(2, "0");
  return h.repeat(16);
}

function pt(text: string): Uint8Array {
  return TE.encode(text);
}

function cloneMsg(msg: BraidMessage): BraidMessage {
  return {
    attachment: undefined, senderIndex: msg.senderIndex,
    seq: msg.seq,
    epochId: msg.epochId,
    confirm: msg.confirm.slice(),
    frontier: msg.frontier.slice(),
    ciphertext: msg.ciphertext.slice(),
  };
}

function findWant(wants: BraidWant[], seatIndex: number): BraidWant | undefined {
  return wants.find((w) => w.seatIndex === seatIndex);
}

// fisher-yates using a deterministic rng, so permutations are reproducible.
function shuffled<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/** wires labelled seats ("A", "B", "C", ...) to braid state, deriving each
 *  label's seat index from the SORTED roster rather than creation order,
 *  since braidInit normalizes and sorts the roster internally. */
class Circle {
  epochId: number;
  root: Uint8Array;
  roster: string[];
  private idxOf: Map<string, number>;
  states: BraidState[]; // indexed by seat index

  private constructor(
    epochId: number,
    root: Uint8Array,
    roster: string[],
    idxOf: Map<string, number>,
    states: BraidState[],
  ) {
    this.epochId = epochId;
    this.root = root;
    this.roster = roster;
    this.idxOf = idxOf;
    this.states = states;
  }

  static async make(labels: string[], epochId: number, entropySeed: number): Promise<Circle> {
    const hexOf = new Map(labels.map((l, i) => [l, hexId(i + 1)]));
    const roster = Array.from(hexOf.values()).sort();
    const entropy = deterministicBytes(32, entropySeed);
    const root = await braidFold(null, entropy, epochId, roster);

    const idxOf = new Map<string, number>();
    for (const l of labels) idxOf.set(l, roster.indexOf(hexOf.get(l)!));

    const states: BraidState[] = new Array(roster.length);
    for (const l of labels) {
      const idx = idxOf.get(l)!;
      states[idx] = await braidInit(root, epochId, roster, hexOf.get(l)!);
    }
    return new Circle(epochId, root, roster, idxOf, states);
  }

  idx(label: string): number {
    const i = this.idxOf.get(label);
    if (i === undefined) throw new Error(`circle: unknown label ${label}`);
    return i;
  }

  state(label: string): BraidState {
    return this.states[this.idx(label)];
  }

  async send(label: string, plaintext: Uint8Array): Promise<BraidMessage> {
    const st = this.state(label);
    const { seq, frontier, confirm, ciphertext } = await braidSeal(st, plaintext);
    return { attachment: undefined, senderIndex: st.seatIndex, seq, epochId: st.epochId, confirm, frontier, ciphertext };
  }

  recv(label: string, wire: BraidMessage): Promise<BraidOpenResult> {
    return braidOpen(this.state(label), wire);
  }

  /** a frame that AUTHENTICATES (real key, real aad) but whose inner payload is
   *  malformed. the only way to reach the post-authentication fault paths, which
   *  are the only faults a verified tag attributes to the sender. does not
   *  advance the sender's state, so repeated calls target the same seq. */
  async sendMalformed(label: string, inner: Uint8Array): Promise<BraidMessage> {
    const st = this.state(label);
    const { seq, frontier, confirm, ciphertext } = await braidSealInnerForTest(st, inner);
    return { attachment: undefined, senderIndex: st.seatIndex, seq, epochId: st.epochId, confirm, frontier, ciphertext };
  }
}

function readLe32Test(b: Uint8Array): number {
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

// --- tests -----------------------------------------------------------------

describe("braid", () => {
  describe("1. determinism of init", () => {
    it("two braidInit calls for the same seat seal byte-identical ciphertexts", async () => {
      const labels = ["A", "B"];
      const hexOf = new Map(labels.map((l, i) => [l, hexId(i + 1)]));
      const roster = Array.from(hexOf.values()).sort();
      const entropy = deterministicBytes(32, 0x10000001);
      const root = await braidFold(null, entropy, 1, roster);

      const s1 = await braidInit(root, 1, roster, hexOf.get("A")!);
      const s2 = await braidInit(root, 1, roster, hexOf.get("A")!);

      const msg = pt("hello braid");
      const r1 = await braidSeal(s1, msg);
      const r2 = await braidSeal(s2, msg);

      assert.equal(r1.seq, r2.seq, "seq matches");
      assertBytesEqual(r1.frontier, r2.frontier, "frontier matches");
      assertBytesEqual(r1.ciphertext, r2.ciphertext, "ciphertext is byte-identical");
    });
  });

  describe("2. full-mesh conversation", () => {
    it("4 seats, 30 round-robin messages, every seat receives every plaintext exactly once in order", async () => {
      const labels = ["A", "B", "C", "D"];
      const circle = await Circle.make(labels, 1, 0x20000001);

      const sent: Record<string, string[]> = { A: [], B: [], C: [], D: [] };
      const received: Record<string, Record<string, string[]>> = {};
      for (const r of labels) received[r] = { A: [], B: [], C: [], D: [] };

      for (let i = 0; i < 30; i++) {
        const sender = labels[i % labels.length];
        const text = `msg-${i}-from-${sender}`;
        sent[sender].push(text);
        const wire = await circle.send(sender, pt(text));

        for (const r of labels) {
          if (r === sender) continue;
          const res = await circle.recv(r, wire);
          assert.equal(res.status, "delivered", `${sender}->${r} msg ${i} should deliver immediately`);
          if (res.status !== "delivered") continue;
          assert.equal(res.delivered.length, 1, `${sender}->${r} msg ${i}: no cascade expected in full mesh`);
          const d = res.delivered[0];
          assert.equal(d.senderIndex, circle.idx(sender));
          assert.equal(d.seq, sent[sender].length);
          assert.equal(TD.decode(d.plaintext), text, `${sender}->${r} msg ${i} content`);
          received[r][sender].push(TD.decode(d.plaintext));
        }
      }

      for (const r of labels) {
        for (const s of labels) {
          if (r === s) continue;
          assert.deepStrictEqual(received[r][s], sent[s], `${r} received ${s}'s messages in order`);
        }
        const status = braidStatus(circle.state(r));
        for (const s of labels) {
          if (r === s) continue;
          const entry = status[circle.idx(s)];
          assert.equal(entry.delivered, sent[s].length, `${r}'s status for ${s} delivered count`);
          assert.equal(entry.diverged, false);
        }
      }
    });
  });

  describe("3. delayed/reordered delivery", () => {
    it("B receives A's 5 messages shuffled: held wants are exact, cascade completes everything in order", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x30000001);
      const aIdx = circle.idx("A");
      const texts = [0, 1, 2, 3, 4].map((i) => `a-${i}`);
      const wires: BraidMessage[] = [];
      for (const t of texts) wires.push(await circle.send("A", pt(t)));

      const order = shuffled([0, 1, 2, 3, 4], makeDeterministicRng(0x51e5a11));
      assert.notDeepStrictEqual(order, [0, 1, 2, 3, 4], "shuffle must not be identity or the test proves nothing");

      const delivered = new Set<number>();
      for (const i of order) {
        const before = braidStatus(circle.state("B"));
        const expectedNext = before[aIdx].delivered + 1;

        const res = await circle.recv("B", wires[i]);
        if (res.status === "delivered") {
          for (const d of res.delivered) {
            assert.equal(d.senderIndex, aIdx);
            assert.equal(TD.decode(d.plaintext), texts[d.seq - 1], `seq ${d.seq} content`);
            assert.ok(!delivered.has(d.seq), `seq ${d.seq} delivered exactly once`);
            delivered.add(d.seq);
          }
        } else if (res.status === "held") {
          const w = findWant(res.wants, aIdx);
          assert.ok(w, "held result names seat A in wants");
          assert.equal(w!.fromSeq, expectedNext, `held want fromSeq for wire seq ${wires[i].seq}`);
          assert.equal(w!.toSeq, wires[i].seq - 1, `held want toSeq for wire seq ${wires[i].seq}`);
        } else {
          assert.fail(`unexpected status ${res.status} for seq ${wires[i].seq}`);
        }
      }

      assert.equal(delivered.size, 5, "all 5 messages eventually delivered via cascade");
      for (let s = 1; s <= 5; s++) assert.ok(delivered.has(s), `seq ${s} delivered`);
      assert.deepStrictEqual(braidWants(circle.state("B")), [], "no wants remain once complete");
    });
  });

  describe("4. cross-seat frontier starvation", () => {
    it("c1 arriving before a1 holds on B; delivering a1 cascades both into one delivered array", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x40000001);
      const aIdx = circle.idx("A");
      const cIdx = circle.idx("C");

      const a1 = await circle.send("A", pt("a1"));
      const cSeesA1 = await circle.recv("C", a1);
      assert.equal(cSeesA1.status, "delivered", "C sees a1 first");

      const c1 = await circle.send("C", pt("c1")); // C's frontier now names A:1

      const bBefore = await circle.recv("B", c1);
      assert.equal(bBefore.status, "held", "B has not seen a1 yet, so c1 is frontier-starved");
      if (bBefore.status === "held") {
        const w = findWant(bBefore.wants, aIdx);
        assert.ok(w, "wants names seat A");
        assert.equal(w!.fromSeq, 1);
        assert.equal(w!.toSeq, 1);
      }

      const bAfter = await circle.recv("B", a1);
      assert.equal(bAfter.status, "delivered");
      if (bAfter.status === "delivered") {
        assert.equal(bAfter.delivered.length, 2, "cascade delivers a1 and c1 together");
        assert.equal(bAfter.delivered[0].senderIndex, aIdx);
        assert.equal(bAfter.delivered[0].seq, 1);
        assert.equal(TD.decode(bAfter.delivered[0].plaintext), "a1");
        assert.equal(bAfter.delivered[1].senderIndex, cIdx);
        assert.equal(bAfter.delivered[1].seq, 1);
        assert.equal(TD.decode(bAfter.delivered[1].plaintext), "c1");
      }

      assert.deepStrictEqual(braidWants(circle.state("B")), [], "B's wants are empty after the cascade");
    });
  });

  describe("5. deep interleave torture", () => {
    it("5 seats, 60 messages, randomized virtual delivery schedule, eventual completeness", async () => {
      const labels = ["S0", "S1", "S2", "S3", "S4"];
      const circle = await Circle.make(labels, 1, 0x50000001);
      const rng = makeDeterministicRng(0x5eed0005);

      interface Sent { sender: string; senderIdx: number; seq: number; text: string; wire: BraidMessage; }
      const sentBySender: Record<string, number> = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0 };
      const all: Sent[] = [];

      for (let step = 0; step < 60; step++) {
        const sender = labels[Math.floor(rng() * labels.length)];
        sentBySender[sender]++;
        const text = `step${step}:${sender}#${sentBySender[sender]}`;
        const wire = await circle.send(sender, pt(text));
        all.push({ sender, senderIdx: circle.idx(sender), seq: wire.seq, text, wire });
      }

      // queue-based virtual scheduler: every (message, other-seat) pair gets a
      // random future round. processing round by round simulates deliveries
      // arriving at random later times, out of send order.
      const ROUNDS = 10;
      interface Event { round: number; receiver: string; item: Sent; }
      const events: Event[] = [];
      for (const item of all) {
        for (const r of labels) {
          if (r === item.sender) continue;
          events.push({ round: 1 + Math.floor(rng() * ROUNDS), receiver: r, item });
        }
      }

      const deliveredKeys: Record<string, Set<string>> = {};
      for (const r of labels) deliveredKeys[r] = new Set();

      function absorb(receiver: string, res: BraidOpenResult): void {
        if (res.status !== "delivered") return;
        for (const d of res.delivered) {
          const key = `${d.senderIndex}:${d.seq}`;
          assert.ok(!deliveredKeys[receiver].has(key), `${receiver}: ${key} delivered only once`);
          deliveredKeys[receiver].add(key);
          const expected = all.find((it) => it.senderIdx === d.senderIndex && it.seq === d.seq)!;
          assert.equal(TD.decode(d.plaintext), expected.text, `${receiver}: ${key} content`);
        }
      }

      for (let round = 1; round <= ROUNDS; round++) {
        const batch = events.filter((e) => e.round === round);
        for (const e of batch) {
          const res = await circle.recv(e.receiver, e.item.wire);
          absorb(e.receiver, res);
        }
      }

      // drain: re-attempt everything not yet delivered until a full pass makes
      // no progress. a stale resend of an already-delivered wire must return
      // ignored without disturbing the delivered set, which absorb() checks.
      const byReceiver: Record<string, Sent[]> = {};
      for (const r of labels) byReceiver[r] = all.filter((it) => it.sender !== r);

      let progressed = true;
      let passes = 0;
      const MAX_PASSES = 25;
      while (progressed && passes < MAX_PASSES) {
        progressed = false;
        passes++;
        for (const r of labels) {
          for (const item of byReceiver[r]) {
            const key = `${item.senderIdx}:${item.seq}`;
            if (deliveredKeys[r].has(key)) continue;
            const before = deliveredKeys[r].size;
            const res = await circle.recv(r, item.wire);
            absorb(r, res);
            if (deliveredKeys[r].size > before) progressed = true;
          }
        }
      }
      assert.ok(passes < MAX_PASSES, "drain reached quiescence within the pass cap");

      for (const r of labels) {
        assert.equal(deliveredKeys[r].size, byReceiver[r].length, `${r} delivered everything`);
        assert.deepStrictEqual(braidWants(circle.state(r)), [], `${r} has no outstanding wants`);
        const status = braidStatus(circle.state(r));
        for (const entry of status) assert.equal(entry.diverged, false, `${r}: seat ${entry.seatHex} not diverged`);
      }
    });
  });

  describe("6. duplicate, stale, own, wrong-epoch, out-of-range", () => {
    it("redelivering an already-delivered wire is ignored as stale", async () => {
      const circle = await Circle.make(["A", "B"], 1, 0x60000001);
      const wire = await circle.send("A", pt("once"));
      const first = await circle.recv("B", wire);
      assert.equal(first.status, "delivered");
      const second = await circle.recv("B", wire);
      assert.deepStrictEqual(second, { status: "ignored", reason: "stale seq" });
    });

    it("delivering your own wire back to yourself is ignored", async () => {
      const circle = await Circle.make(["A", "B"], 1, 0x60000002);
      const wire = await circle.send("A", pt("mine"));
      const res = await circle.recv("A", wire);
      assert.deepStrictEqual(res, { status: "ignored", reason: "own message" });
    });

    it("wrong epochId is ignored", async () => {
      const circle = await Circle.make(["A", "B"], 1, 0x60000003);
      const wire = await circle.send("A", pt("epoch"));
      const tampered = cloneMsg(wire);
      tampered.epochId = wire.epochId + 1;
      const res = await circle.recv("B", tampered);
      assert.deepStrictEqual(res, { status: "ignored", reason: "wrong epoch" });
    });

    it("senderIndex out of range is ignored", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x60000004);
      const wire = await circle.send("A", pt("range"));

      const tooHigh = cloneMsg(wire);
      tooHigh.senderIndex = circle.roster.length; // one past the end
      assert.deepStrictEqual(await circle.recv("B", tooHigh), { status: "ignored", reason: "unknown seat" });

      const negative = cloneMsg(wire);
      negative.senderIndex = -1;
      assert.deepStrictEqual(await circle.recv("B", negative), { status: "ignored", reason: "unknown seat" });
    });
  });

  describe("7. tampered frames are unattributable and never sever a lane", () => {
    // a failed gcm tag is proof the frame is inauthentic, so it says nothing
    // about the seat named in its header. counting it against that seat would
    // let anyone who can inject frames sever two honest seats on demand.
    it("a flood of tampered copies never diverges the bond; the clean copy still delivers", async () => {
      assert.equal(BRAID_MAX_STRIKES, 3, "sanity: strikes still exist for post-auth faults");

      const circle = await Circle.make(["A", "B", "C"], 1, 0x70000001);
      const aIdx = circle.idx("A");
      const wire = await circle.send("A", pt("tamper me"));

      // far past the old strike threshold, and each copy tampered differently
      // so none can collide with the genuine bytes.
      for (let k = 0; k < BRAID_MAX_STRIKES * 10; k++) {
        const tampered = cloneMsg(wire);
        tampered.ciphertext[k % tampered.ciphertext.length] ^= 0xff;
        const r = await circle.recv("B", tampered);
        assert.equal(r.status, "ignored", `tampered copy ${k}: rejected with no strike and no repair want`);
        if (r.status === "ignored") assert.equal(r.reason, "key mismatch: history diverged");
      }

      const bStatus = braidStatus(circle.state("B"));
      assert.equal(bStatus[aIdx].diverged, false, "the lane survives the flood");

      const clean = await circle.recv("B", wire);
      assert.equal(clean.status, "delivered", "the genuine message still lands");
      if (clean.status === "delivered") {
        assert.equal(TD.decode(clean.delivered[0].plaintext), "tamper me");
      }

      const cRes = await circle.recv("C", wire);
      assert.equal(cRes.status, "delivered");
      if (cRes.status === "delivered") {
        assert.equal(TD.decode(cRes.delivered[0].plaintext), "tamper me");
      }
    });

    it("a clean copy interleaved with tampered ones delivers", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x70000002);
      const wire = await circle.send("A", pt("recoverable"));
      const tampered = cloneMsg(wire);
      tampered.ciphertext[5] ^= 0x01;

      assert.equal((await circle.recv("B", tampered)).status, "ignored");
      assert.equal((await circle.recv("B", tampered)).status, "ignored");

      const r3 = await circle.recv("B", wire);
      assert.equal(r3.status, "delivered", "clean copy delivers");
      if (r3.status === "delivered") {
        assert.equal(TD.decode(r3.delivered[0].plaintext), "recoverable");
      }

      const status = braidStatus(circle.state("B"));
      assert.equal(status[circle.idx("A")].diverged, false, "the bond survives");
    });
  });

  describe("8. aad binding", () => {
    it("lying about integrated history in a well-formed frontier breaks decryption", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x80000001);
      const aIdx = circle.idx("A");
      const cIdx = circle.idx("C");

      const c1 = await circle.send("C", pt("c1"));
      const c2 = await circle.send("C", pt("c2"));
      // B integrates both of C's messages directly: its own store and
      // frontier for C reach 2 without any help from A.
      assert.equal((await circle.recv("B", c1)).status, "delivered");
      assert.equal((await circle.recv("B", c2)).status, "delivered");

      const a1 = await circle.send("A", pt("a1")); // A has not seen any of C's messages yet
      assert.equal((await circle.recv("B", a1)).status, "delivered");

      // A now sees c1 only, then seals a2: its real frontier names C up to 1.
      assert.equal((await circle.recv("A", c1)).status, "delivered");
      const a2 = await circle.send("A", pt("a2"));

      const nSeats = circle.roster.length;
      const realF = parseFrontier(a2.frontier, nSeats)!;
      assert.equal(realF[cIdx], 1, "sanity: a2's true frontier names C up to 1");

      // tamper: claim A had integrated C up to 2, reusing B's own (correct)
      // cache for C:2 to satisfy the structural "wants" gate. every
      // structural precondition still passes; only the derived key differs.
      const lied = realF.slice();
      lied[cIdx] = 2;
      const tampered = cloneMsg(a2);
      tampered.frontier = encodeFrontier(lied);

      const parsedLied = parseFrontier(tampered.frontier, nSeats);
      assert.ok(parsedLied, "tampered frontier still parses as well-formed");
      assert.equal(parsedLied![aIdx], a2.seq - 1, "own-strand check still passes");

      const res = await circle.recv("B", tampered);
      assert.notEqual(res.status, "delivered", "lying about integrated history must never deliver");
      // caught at the decrypt stage, not by an earlier structural gate. the tag
      // failed, so the frame is unattributable: no strike, no repair want.
      // now NAMED rather than anonymous: the lie is a history disagreement at a
      // specific seat and seq, which is what makes a fork attributable.
      assert.deepStrictEqual(
        res, { status: "forked", seatIndex: aIdx, seq: a2.seq, reason: "history disagreement" },
      );

      // the untampered wire still delivers fine.
      const clean = await circle.recv("B", a2);
      assert.equal(clean.status, "delivered");
    });

    it("altered seq never delivers", async () => {
      const circle = await Circle.make(["A", "B"], 1, 0x80000002);
      // a1 is sent but never delivered to B, so B's lane[A].nextSeq stays 1.
      // a2's real frontier names A's own prior strand as 1.
      await circle.send("A", pt("a1"));
      const a2 = await circle.send("A", pt("a2"));
      const tampered = cloneMsg(a2);
      tampered.seq = 1; // claim to be seq 1; passes the seq gate (B's lane[A].nextSeq is 1)
      // the real frontier still says F[A]=1, which now disagrees with the
      // claimed seq-1=0: either the frontier-consistency gate (own-strand
      // mismatch) or the aead itself will reject this. both are valid
      // enforcement points; the safety property under test is that it never
      // delivers.
      const res = await circle.recv("B", tampered);
      assert.notEqual(res.status, "delivered", "altered seq must never deliver");

      // POSITIVE CONTROL: B is not simply refusing everything. The genuine
      // sequence, delivered in order, still opens — so the rejection above is
      // about the ALTERED seq and not about A being unreadable.
      const control = await Circle.make(["A", "B"], 1, 0x80000002);
      const g1 = await control.send("A", pt("a1"));
      const g2 = await control.send("A", pt("a2"));
      assert.equal((await control.recv("B", g1)).status, "delivered", "genuine seq 1 opens");
      assert.equal((await control.recv("B", g2)).status, "delivered", "genuine seq 2 opens");
    });

    it("altered senderIndex (valid range) never delivers", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x80000003);
      const a1 = await circle.send("A", pt("a1")); // first message: empty frontier, trivially well-formed for any claimed sender
      const tampered = cloneMsg(a1);
      tampered.senderIndex = circle.idx("C"); // valid range, wrong seat identity entirely
      const res = await circle.recv("B", tampered);
      // At THIS layer a relabelled frame is indistinguishable from a genuine
      // fork: the confirm tag is keyed on the named seat's chain and is checked
      // before the AEAD, so it is unauthenticated here. That is precisely why
      // "forked" is only an accusation for a caller that has already verified
      // the sender's signature — the campfire layer does, before braidOpen.
      assert.equal(res.status, "forked", "the relabelled frame never delivers");

      // POSITIVE CONTROL: the SAME frame under its true senderIndex delivers, so
      // the rejection is about the relabelling and not about the frame itself.
      assert.equal((await circle.recv("B", a1)).status, "delivered", "the correctly-labelled frame opens");
    });
  });

  describe("9. frontier hygiene", () => {
    it("bad count byte in the frontier is rejected without a strike", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x90000001);
      const a1 = await circle.send("A", pt("a1"));
      assert.equal((await circle.recv("B", a1)).status, "delivered"); // so a2 is B's expected next seq
      const a2 = await circle.send("A", pt("a2")); // real frontier names A:1, one entry
      const tampered = cloneMsg(a2);
      const bad = tampered.frontier.slice();
      bad[0] = bad[0] + 1; // count byte no longer matches the actual byte length
      tampered.frontier = bad;
      assert.equal(parseFrontier(bad, circle.roster.length), null, "sanity: parser rejects this directly");

      const res = await circle.recv("B", tampered);
      assert.deepStrictEqual(res, { status: "ignored", reason: "malformed frontier" });
      // POSITIVE CONTROL: the untampered frame at the SAME position delivers, so
      // the rejection discriminates rather than refusing every frontier.
      assert.equal((await circle.recv("B", a2)).status, "delivered", "the genuine frontier still opens");
    });

    it("non-ascending seat indices in the frontier are rejected without a strike", async () => {
      const circle = await Circle.make(["A", "B", "C", "D"], 1, 0x90000002);
      // hand-built: [count=2][idx=2][seq=1][idx=1][seq=1] -- descending indices
      const bad = new Uint8Array(1 + 5 + 5);
      bad[0] = 2;
      bad[1] = 2; bad.set([1, 0, 0, 0], 2);
      bad[6] = 1; bad.set([1, 0, 0, 0], 7);
      assert.equal(parseFrontier(bad, 4), null, "sanity: parser rejects this directly");

      const a1 = await circle.send("A", pt("a1"));
      const tampered = cloneMsg(a1);
      tampered.frontier = bad;
      const res = await circle.recv("B", tampered);
      assert.deepStrictEqual(res, { status: "ignored", reason: "malformed frontier" });
      assert.equal((await circle.recv("B", a1)).status, "delivered", "the genuine frontier still opens");
    });

    it("zero seq entry in the frontier is rejected without a strike", async () => {
      const bad = new Uint8Array(1 + 5);
      bad[0] = 1;
      bad[1] = 0; // seat index 0
      bad.set([0, 0, 0, 0], 2); // seq = 0, explicitly disallowed
      assert.equal(parseFrontier(bad, 4), null, "sanity: parser rejects this directly");

      const circle = await Circle.make(["A", "B", "C", "D"], 1, 0x90000003);
      const a1 = await circle.send("A", pt("a1"));
      const tampered = cloneMsg(a1);
      tampered.frontier = bad;
      const res = await circle.recv("B", tampered);
      assert.deepStrictEqual(res, { status: "ignored", reason: "malformed frontier" });
      assert.equal((await circle.recv("B", a1)).status, "delivered", "the genuine frontier still opens");
    });

    it("frontier omitting the sender's own strand is rejected without a strike", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x90000004);
      const a1 = await circle.send("A", pt("a1"));
      assert.equal((await circle.recv("B", a1)).status, "delivered");
      const a2 = await circle.send("A", pt("a2")); // real frontier names A:1
      const realF = parseFrontier(a2.frontier, circle.roster.length)!;
      assert.equal(realF[circle.idx("A")], 1, "sanity: a2 genuinely names its own prior seq");

      const tampered = cloneMsg(a2);
      tampered.frontier = encodeFrontier(new Uint32Array(circle.roster.length)); // empty: omits own strand
      const res = await circle.recv("B", tampered);
      assert.deepStrictEqual(res, { status: "ignored", reason: "frontier omits own strand" });
      assert.equal((await circle.recv("B", a2)).status, "delivered", "the genuine frontier still opens");
    });
  });

  describe("10. divergent history (different epoch roots)", () => {
    it("two circles built from different entropy never exchange a deliverable message", async () => {
      const labels = ["A", "B", "C"];
      const circle1 = await Circle.make(labels, 1, 0xa0000001);
      const circle2 = await Circle.make(labels, 1, 0xa0000002); // same roster/epoch, different root
      assert.notDeepStrictEqual(circle1.root, circle2.root, "sanity: roots differ");

      const wire = await circle1.send("A", pt("hello from circle1"));

      // a cross-root frame fails the tag, so it is unattributable: it can never
      // deliver, and it can never sever the lane no matter how often it repeats.
      for (let i = 0; i < BRAID_MAX_STRIKES * 5; i++) {
        const res = await circle2.recv("B", wire);
        // a different epoch root IS a different history, so this is now reported
        // as the disagreement it is rather than an anonymous rejection.
        assert.equal(res.status, "forked", `attempt ${i}: cross-root message named as a disagreement`);
      }
      assert.equal(
        braidStatus(circle2.state("B"))[circle2.idx("A")].diverged,
        false,
        "an outsider replaying cross-root frames cannot kill an honest lane",
      );
    });
  });

  describe("11. beacon (empty plaintext)", () => {
    it("advances seq/frontier, delivers zero-length, and a seat that missed it holds the next message", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0xb0000001);
      const aIdx = circle.idx("A");

      const a1 = await circle.send("A", pt("a1"));
      assert.equal((await circle.recv("B", a1)).status, "delivered");
      assert.equal((await circle.recv("C", a1)).status, "delivered");

      const beacon = await circle.send("A", new Uint8Array(0));
      assert.equal(beacon.seq, 2);

      const bBeacon = await circle.recv("B", beacon);
      assert.equal(bBeacon.status, "delivered");
      if (bBeacon.status === "delivered") {
        assert.equal(bBeacon.delivered[0].plaintext.length, 0, "beacon plaintext is zero-length");
      }
      // C deliberately never sees the beacon.

      const a3 = await circle.send("A", pt("a3")); // frontier now names A:2, the beacon

      const bRes3 = await circle.recv("B", a3);
      assert.equal(bRes3.status, "delivered", "B saw the beacon, so a3 delivers immediately");
      if (bRes3.status === "delivered") {
        assert.equal(TD.decode(bRes3.delivered[0].plaintext), "a3");
      }

      const cRes3 = await circle.recv("C", a3);
      assert.equal(cRes3.status, "held", "C missed the beacon, so a3 must hold");
      if (cRes3.status === "held") {
        assert.deepStrictEqual(cRes3.wants, [{ seatIndex: aIdx, fromSeq: 2, toSeq: 2 }], "C wants exactly the beacon");
      }

      const cBeacon = await circle.recv("C", beacon);
      assert.equal(cBeacon.status, "delivered");
      if (cBeacon.status === "delivered") {
        assert.equal(cBeacon.delivered.length, 2, "beacon delivery cascades straight into a3");
        assert.equal(cBeacon.delivered[0].seq, 2);
        assert.equal(cBeacon.delivered[0].plaintext.length, 0);
        assert.equal(cBeacon.delivered[1].seq, 3);
        assert.equal(TD.decode(cBeacon.delivered[1].plaintext), "a3");
      }

      assert.deepStrictEqual(braidWants(circle.state("C")), [], "C's wants are empty once the beacon lands");
    });
  });

  describe("12. epoch fold chain", () => {
    it("same fold inputs yield the same root; different roster/epoch/entropy yield different roots; epoch 2 is independent", async () => {
      const roster3 = [hexId(1), hexId(2), hexId(3)].sort();
      const roster4 = [hexId(1), hexId(2), hexId(3), hexId(4)].sort();
      const entropy1 = deterministicBytes(32, 0xc0000001);
      const entropy2 = deterministicBytes(32, 0xc0000002);

      const root1a = await braidFold(null, entropy1, 1, roster3);
      const root1b = await braidFold(null, entropy1, 1, roster3);
      assertBytesEqual(root1a, root1b, "identical fold inputs yield an identical root");

      const rootDifferentEntropy = await braidFold(null, entropy2, 1, roster3);
      assert.notDeepStrictEqual(rootDifferentEntropy, root1a, "different entropy -> different root");

      const rootDifferentEpoch = await braidFold(null, entropy1, 2, roster3);
      assert.notDeepStrictEqual(rootDifferentEpoch, root1a, "different epochId -> different root");

      const rootDifferentRoster = await braidFold(null, entropy1, 1, roster4);
      assert.notDeepStrictEqual(rootDifferentRoster, root1a, "different roster -> different root");

      // fold chain: epoch 2 folds forward from epoch 1's root with fresh
      // entropy and a bigger roster.
      const epoch2RootA = await braidFold(root1a, entropy2, 2, roster4);
      const epoch2RootB = await braidFold(root1a, entropy2, 2, roster4);
      assertBytesEqual(epoch2RootA, epoch2RootB, "epoch fold is deterministic given identical inputs");
      assert.notDeepStrictEqual(epoch2RootA, root1a, "the folded root differs from the epoch-1 root");

      // epoch 2 works independently: init every seat, seal, and open.
      const states2 = await Promise.all(roster4.map((h) => braidInit(epoch2RootA, 2, roster4, h)));
      const senderIdx = roster4.indexOf(roster4[0]);
      const sealed = await braidSeal(states2[0], pt("epoch2 hello"));
      const wire2: BraidMessage = { attachment: undefined, senderIndex: senderIdx, seq: sealed.seq, epochId: 2, confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext };
      const openRes = await braidOpen(states2[1], wire2);
      assert.equal(openRes.status, "delivered");
      if (openRes.status === "delivered") {
        assert.equal(TD.decode(openRes.delivered[0].plaintext), "epoch2 hello");
      }

      // a wire from epoch 1 is ignored by an epoch-2 state.
      const states1 = await Promise.all(roster3.map((h) => braidInit(root1a, 1, roster3, h)));
      const sealed1 = await braidSeal(states1[0], pt("epoch1 message"));
      const wire1: BraidMessage = {
        attachment: undefined, senderIndex: roster3.indexOf(roster3[0]),
        seq: sealed1.seq,
        epochId: 1,
        confirm: sealed1.confirm,
        frontier: sealed1.frontier,
        ciphertext: sealed1.ciphertext,
      };
      const crossEpochRes = await braidOpen(states2[1], wire1);
      assert.deepStrictEqual(crossEpochRes, { status: "ignored", reason: "wrong epoch" });
    });
  });

  describe("13. braidWipe", () => {
    it("zeroes chains, views, and frontiers, and clears store/held", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0xd0000001);
      const a1 = await circle.send("A", pt("a1"));
      assert.equal((await circle.recv("B", a1)).status, "delivered");
      await circle.send("B", pt("b1")); // populates B's own store

      await circle.send("C", pt("c1"));
      const c2 = await circle.send("C", pt("c2"));
      const heldRes = await circle.recv("B", c2); // out of order: c2 arrives before c1
      assert.equal(heldRes.status, "held", "sanity: B is holding c2");

      const state = circle.state("B");
      assert.ok(!state.mySendChain.every((b) => b === 0), "sanity: chain non-zero before wipe");
      assert.ok(!state.myView.countsBitM.every((v) => v === 0), "sanity: view non-zero before wipe");
      assert.ok(state.store.size > 0, "sanity: store non-empty before wipe");
      assert.ok(state.held.size > 0, "sanity: held non-empty before wipe");

      braidWipe(state);

      assert.ok(state.mySendChain.every((b) => b === 0), "mySendChain zeroed");
      assert.ok(state.myView.countsBitM.every((v) => v === 0), "myView.countsBitM zeroed");
      assert.ok(state.myView.countsBit1.every((v) => v === 0), "myView.countsBit1 zeroed");
      assert.ok(state.myView.countsBitX.every((v) => v === 0), "myView.countsBitX zeroed");
      assert.ok(state.myFrontier.every((v) => v === 0), "myFrontier zeroed");
      for (const lane of state.lanes) {
        assert.ok(lane.chain.every((b) => b === 0), "lane chain zeroed");
        assert.ok(lane.view.countsBitM.every((v) => v === 0), "lane view countsBitM zeroed");
        assert.ok(lane.view.countsBit1.every((v) => v === 0), "lane view countsBit1 zeroed");
        assert.ok(lane.view.countsBitX.every((v) => v === 0), "lane view countsBitX zeroed");
        assert.ok(lane.frontier.every((v) => v === 0), "lane frontier zeroed");
        assert.equal(lane.strikes.size, 0, "lane strikes cleared");
      }
      assert.equal(state.store.size, 0, "store cleared");
      assert.equal(state.held.size, 0, "held cleared");
    });
  });

  describe("14. store gc observability", () => {
    it("a silent seat's zero lane frontier blocks gc; gc proceeds once it finally sends", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0xe0000001);
      const aIdx = circle.idx("A");
      const bIdx = circle.idx("B");
      const cIdx = circle.idx("C");

      // 40 messages, alternating A/B, delivered immediately and mutually,
      // and also to C, who never sends.
      for (let i = 0; i < 40; i++) {
        const sender = i % 2 === 0 ? "A" : "B";
        const other = sender === "A" ? "B" : "A";
        const wire = await circle.send(sender, pt(`msg-${i}`));
        assert.equal((await circle.recv(other, wire)).status, "delivered", `${sender}->${other} msg ${i}`);
        assert.equal((await circle.recv("C", wire)).status, "delivered", `${sender}->C msg ${i}`);
      }

      const aStoreBefore = circle.state("A").store.size;
      const bStoreBefore = circle.state("B").store.size;
      assert.equal(aStoreBefore, 40, "A retains all 40 messages: C's silent lane pins gc at zero");
      assert.equal(bStoreBefore, 40, "B retains all 40 messages: C's silent lane pins gc at zero");

      assert.ok(circle.state("A").lanes[cIdx].frontier.every((v) => v === 0), "A's lane for C is untouched");
      assert.ok(circle.state("B").lanes[cIdx].frontier.every((v) => v === 0), "B's lane for C is untouched");

      // C finally sends. its frontier references the full 40-message history
      // via A and B's OWN retained stores, not C's.
      const c1 = await circle.send("C", pt("c1"));
      const F = parseFrontier(c1.frontier, circle.roster.length)!;
      assert.equal(F[aIdx], 20, "C's frontier names A's full history");
      assert.equal(F[bIdx], 20, "C's frontier names B's full history");

      const aRes = await circle.recv("A", c1);
      assert.equal(aRes.status, "delivered", "A can still reconstruct C's view from its own retained store");
      if (aRes.status === "delivered") assert.equal(TD.decode(aRes.delivered[0].plaintext), "c1");

      const bRes = await circle.recv("B", c1);
      assert.equal(bRes.status, "delivered", "B can still reconstruct C's view from its own retained store");
      if (bRes.status === "delivered") assert.equal(TD.decode(bRes.delivered[0].plaintext), "c1");

      // now that C has reported a real, non-zero frontier, gc can finally run.
      assert.ok(circle.state("A").store.size < aStoreBefore, "A's store shrinks once C's lane stops pinning gc at zero");
      assert.ok(circle.state("B").store.size < bStoreBefore, "B's store shrinks once C's lane stops pinning gc at zero");
    });
  });

  describe("15. concurrency serialization", () => {
    it("overlapping braidOpen calls without awaiting still serialize and all deliver correctly", async () => {
      const circle = await Circle.make(["A", "B"], 1, 0xf0000001);
      const N = 10;
      const wires: BraidMessage[] = [];
      const texts: string[] = [];
      for (let i = 0; i < N; i++) {
        const text = `concurrent-${i}`;
        texts.push(text);
        wires.push(await circle.send("A", pt(text)));
      }

      const bState = circle.state("B");
      // fire all opens without awaiting between them: braidOpen's internal
      // promise-chain queue must serialize them in call order.
      const results = await Promise.all(wires.map((w) => braidOpen(bState, w)));

      for (let i = 0; i < N; i++) {
        const r = results[i];
        assert.equal(r.status, "delivered", `wire ${i} (seq ${wires[i].seq}) should deliver`);
        if (r.status !== "delivered") continue;
        assert.equal(r.delivered.length, 1, `wire ${i}: exactly one delivery, no cascade needed`);
        assert.equal(r.delivered[0].seq, i + 1);
        assert.equal(TD.decode(r.delivered[0].plaintext), texts[i], `wire ${i} content`);
      }

      const status = braidStatus(bState);
      assert.equal(status[circle.idx("A")].delivered, N, "final delivered count matches");
    });
  });
  describe("15b. strikes and divergence (the positive control for a dead lane)", () => {
    // strike() fires ONLY on a fault found AFTER the tag verifies, because only a
    // verified tag proves the sender holds the lane key. Every tampering test in
    // this file fails at the tag instead, so without an authenticated-but-malformed
    // frame the whole strike/diverge mechanism is unreachable and could be deleted
    // outright with no test failing.
    it("BRAID_MAX_STRIKES authenticated-but-malformed frames kill the lane, and it stays dead", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15b00001);
      const aIdx = circle.idx("A");
      const truncated = new Uint8Array([1, 2, 3]); // inner shorter than the 5-byte minimum

      for (let i = 1; i < BRAID_MAX_STRIKES; i++) {
        const res = await circle.recv("B", await circle.sendMalformed("A", truncated));
        assert.equal(res.status, "held", `strike ${i}: rejected but the lane lives`);
        assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, false, `strike ${i}: not yet dead`);
      }

      const fatal = await circle.recv("B", await circle.sendMalformed("A", truncated));
      assert.equal(fatal.status, "diverged", "the last strike severs the lane");
      if (fatal.status === "diverged") {
        assert.equal(fatal.seatIndex, aIdx);
        assert.equal(fatal.reason, "truncated payload");
      }

      const status = braidStatus(circle.state("B"))[aIdx];
      assert.equal(status.diverged, true, "the lane is marked dead");
      assert.equal(status.divergedReason, "truncated payload");

      // and it STAYS dead: even a perfectly genuine frame is refused now.
      const wire = await circle.send("A", pt("please let me in"));
      assert.deepStrictEqual(await circle.recv("B", wire), { status: "ignored", reason: "diverged seat" });

      // the SAME frame delivers at C: divergence lives in the receiver's own lane,
      // so a dead bond at B says nothing about anyone else.
      assert.equal((await circle.recv("C", wire)).status, "delivered", "C is unaffected by B's dead lane");
    });

    it("an undecodable payload is also a post-auth fault and strikes", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15b00002);
      // well-formed length prefix, garbage coder bytes behind it
      const inner = new Uint8Array(64);
      inner[0] = 32; // decodedLen = 32
      for (let i = 4; i < inner.length; i++) inner[i] = 0xA5;
      let last = await circle.recv("B", await circle.sendMalformed("A", inner));
      for (let i = 1; i < BRAID_MAX_STRIKES; i++) {
        last = await circle.recv("B", await circle.sendMalformed("A", inner));
      }
      assert.equal(last.status, "diverged", "repeated undecodable payloads sever the lane");
      assert.equal(braidStatus(circle.state("B"))[circle.idx("A")].diverged, true);
    });

    it("a clean frame before exhaustion clears the strikes", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15b00003);
      const aIdx = circle.idx("A");
      const truncated = new Uint8Array([1, 2, 3]);

      for (let i = 1; i < BRAID_MAX_STRIKES; i++) {
        assert.equal((await circle.recv("B", await circle.sendMalformed("A", truncated))).status, "held");
      }
      // the genuine frame occupies the same seq, so it clears that seq's strikes.
      assert.equal((await circle.recv("B", await circle.send("A", pt("real")))).status, "delivered");
      assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, false, "the bond survives");

      // a fresh run of strikes is needed to kill it, proving the counter reset.
      for (let i = 1; i < BRAID_MAX_STRIKES; i++) {
        assert.equal((await circle.recv("B", await circle.sendMalformed("A", truncated))).status, "held");
        assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, false);
      }
      assert.equal((await circle.recv("B", await circle.sendMalformed("A", truncated))).status, "diverged");
    });
  });

  describe("15c. resource bounds (a post-auth fault must not be a memory bomb)", () => {
    it("an authenticated frame claiming an absurd decoded length is refused before allocating", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15c00001);
      const aIdx = circle.idx("A");

      // a well-formed inner payload whose length prefix claims 4 GiB. the tag
      // verifies, so this is what a seated-but-hostile member can actually send.
      const inner = new Uint8Array(64);
      inner[0] = 0xFF; inner[1] = 0xFF; inner[2] = 0xFF; inner[3] = 0xFF;
      assert.ok(readLe32Test(inner) > BRAID_MAX_DECODED_LEN, "sanity: the claim exceeds the cap");

      const res = await circle.recv("B", await circle.sendMalformed("A", inner));
      assert.notEqual(res.status, "delivered", "the bomb must never deliver");
      assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, false, "one frame does not sever the lane");

      // it IS attributable (the tag verified), so it strikes like any post-auth
      // fault, and enough of them kill the lane rather than being ignored.
      for (let i = 1; i < BRAID_MAX_STRIKES; i++) await circle.recv("B", await circle.sendMalformed("A", inner));
      assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, true, "repeated bombs strike the lane dead");
    });

    it("a RAW frame whose payload is shorter than its declared length is refused, not truncated", async () => {
      // RAW mode used to do payload.slice(0, len) with no check, so a short
      // payload delivered a TRUNCATED plaintext under a valid tag. Both sides
      // then trained their count models on different bytes and silently desynced
      // from that point on, which is far worse than a rejected frame.
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15c00003);
      const aIdx = circle.idx("A");

      // inner = [4B declaredLen][0xFF RAW marker][payload shorter than declared]
      const payload = new Uint8Array(8).fill(0x41);
      const inner = new Uint8Array(4 + 1 + payload.length);
      const declared = 4096; // far more than the 8 bytes actually present
      inner[0] = declared & 0xFF; inner[1] = (declared >>> 8) & 0xFF;
      inner[4] = 0xFF;
      inner.set(payload, 5);

      const res = await circle.recv("B", await circle.sendMalformed("A", inner));
      assert.notEqual(res.status, "delivered", "a truncated RAW frame must never deliver");
      assert.equal(braidStatus(circle.state("B"))[aIdx].diverged, false, "one such frame does not sever the lane");
    });

    it("a legitimate large message still round-trips, so the cap is not a wall", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x15c00002);
      const big = new Uint8Array(200_000);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xFF;
      const res = await circle.recv("B", await circle.send("A", big));
      assert.equal(res.status, "delivered", "a 200KB message is well under the cap");
      if (res.status === "delivered") assertBytesEqual(res.delivered[0].plaintext, big, "bytes intact");
    });
  });

  describe("16. stall reporting (a fork is visible without being destructive)", () => {
    // the shape of a fork is a lane frozen at one seq with later frames piling up
    // behind it. only the frame AT nextSeq is ever tried, so counting tag failures
    // alone can never exceed one; the holdback is what grows.
    it("a genuine fork is named immediately and never severs the lane", async () => {
      const forkA = await Circle.make(["A", "B", "C"], 1, 0xf0000001);
      const forkB = await Circle.make(["A", "B", "C"], 1, 0xf0000002); // same shape, different root
      const aIdx = forkA.idx("A");

      let stalls = 0;
      let forks = 0;
      for (let i = 1; i <= BRAID_STALL_THRESHOLD + 5; i++) {
        const wire = await forkA.send("A", pt(`msg ${i}`));
        const res = await forkB.recv("B", wire);
        assert.notEqual(res.status, "delivered", `seq ${i} must never open across a fork`);
        if (res.status === "forked") forks++;
        if ((res.status === "held" || res.status === "ignored") && res.stalled) stalls++;
      }
      // the confirmation tag now catches a fork at the FIRST message and names
      // it, so the stall counter (which needed a pile of held frames) no longer
      // fires here. it remains the fallback for frames that pass the tag check
      // but still fail to open.
      assert.ok(forks > 0, "a fork is reported as a named disagreement");
      assert.equal(stalls, 0, "the stall path is superseded for forks");

      const status = braidStatus(forkB.state("B"));
      assert.equal(status[aIdx].diverged, false, "reporting a stall never severs the lane");
      // 0, not 1: the disagreement is now caught at the confirmation tag, which
      // sits BEFORE the AEAD, so no tag failure is ever recorded. That is the
      // point — a fork is identified as a fork rather than as an unexplained
      // decrypt failure.
      assert.equal(status[aIdx].unopened, 0, "a fork never reaches the tag check");
    });

    it("a healthy circle never reports a stall", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0xf0000003);
      for (let i = 1; i <= BRAID_STALL_THRESHOLD + 5; i++) {
        const res = await circle.recv("B", await circle.send("A", pt(`m ${i}`)));
        assert.equal(res.status, "delivered", `message ${i} delivers`);
        assert.ok(!("stalled" in res && res.stalled), "no stall on a healthy lane");
      }
    });

    it("a plain out-of-order gap is not mistaken for a fork", async () => {
      // messages pile up exactly as in a fork, but nothing failed to authenticate,
      // so no fork is claimed and the cascade recovers once the gap is filled.
      const circle = await Circle.make(["A", "B", "C"], 1, 0xf0000004);
      const wires = [];
      for (let i = 1; i <= BRAID_STALL_THRESHOLD + 5; i++) wires.push(await circle.send("A", pt(`g ${i}`)));

      for (const w of wires.slice(1)) {
        const res = await circle.recv("B", w);
        assert.equal(res.status, "held");
        assert.ok(!res.stalled, "a gap alone never claims a fork");
      }
      const fill = await circle.recv("B", wires[0]);
      assert.equal(fill.status, "delivered", "the withheld message unblocks the whole pile");
      if (fill.status === "delivered") {
        assert.equal(fill.delivered.length, wires.length, "every held message is released in order");
      }
    });

    it("a stall clears once the lane recovers, and can be reported again later", async () => {
      // forged frames can stall a perfectly healthy lane: the frame at nextSeq
      // fails its tag and the pile grows behind it. when the genuine frame finally
      // lands the cascade drains the pile and the report must reset, or a seat is
      // marked unreadable forever after one bad frame.
      const circle = await Circle.make(["A", "B", "C"], 1, 0xf0000006);
      const aIdx = circle.idx("A");
      const wires = [];
      for (let i = 1; i <= BRAID_STALL_THRESHOLD + 3; i++) wires.push(await circle.send("A", pt(`r ${i}`)));

      const forged = cloneMsg(wires[0]);
      forged.ciphertext[0] ^= 0xff;
      assert.equal((await circle.recv("B", forged)).status, "ignored", "the forgery never opens");

      let stalls = 0;
      for (const w of wires.slice(1)) {
        const res = await circle.recv("B", w);
        if (res.status === "held" && res.stalled) stalls++;
      }
      assert.equal(stalls, 1, "the pile behind the unopenable frame reports a stall");

      // the genuine frame arrives: everything drains and the lane is healthy again.
      const fill = await circle.recv("B", wires[0]);
      assert.equal(fill.status, "delivered");
      const status = braidStatus(circle.state("B"));
      assert.equal(status[aIdx].unopened, 0, "recovery clears the failure count");
      assert.equal(status[aIdx].diverged, false, "and the bond was never harmed");

      // a fresh stall is reportable again, so the flag really reset.
      const more = [];
      for (let i = 1; i <= BRAID_STALL_THRESHOLD + 3; i++) more.push(await circle.send("A", pt(`s ${i}`)));
      const forged2 = cloneMsg(more[0]);
      forged2.ciphertext[0] ^= 0xff;
      await circle.recv("B", forged2);
      let stalls2 = 0;
      for (const w of more.slice(1)) {
        const res = await circle.recv("B", w);
        if (res.status === "held" && res.stalled) stalls2++;
      }
      assert.equal(stalls2, 1, "a later stall is reported again after recovery");
    });

    it("structural garbage does not count toward a stall: only a failed tag is evidence", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0xf0000005);
      const aIdx = circle.idx("A");
      const a1 = await circle.send("A", pt("hi"));
      for (let i = 0; i < BRAID_STALL_THRESHOLD * 2; i++) {
        const bad = cloneMsg(a1);
        bad.frontier = new Uint8Array([9, 9, 9]);
        assert.deepStrictEqual(await circle.recv("B", bad), { status: "ignored", reason: "malformed frontier" });
      }
      assert.equal(braidStatus(circle.state("B"))[aIdx].unopened, 0, "unparseable bytes are not fork evidence");
    });
  });
  describe("17. the count model is order-blind; the transcript is not", () => {
    // THE ALGEBRA. loopTrain makes the count map a monoid homomorphism from the
    // free monoid of messages into an abelian group. Any such map must kill the
    // commutator subgroup, so it CANNOT distinguish ab from ba — a theorem, not
    // an implementation slip. Exhaustively enumerating all 243 five-byte strings
    // over a 3-letter alphabet yields only 116 distinct count digests, and the
    // collision classes are exactly the permutations preserving the bigram
    // multiset: the fibres of the homomorphism.
    //
    // One object cannot be both order-independent (which the SHARED model must
    // be, or the group needs a sequencing authority) and order-committing (which
    // KEY DERIVATION needs). So there are two: counts for compression, and a
    // per-strand transcript for the commitment.
    it("the count digest still collides — it is a compressor, and that is fine", async () => {
      const block = new Uint8Array(65536);
      for (let i = 0; i < block.length; i++) block[i] = (i * 31 + 7) & 0xff;
      const a = loopInit(block);
      const b = loopInit(block);
      loopTrain(a, Uint8Array.from([0, 1, 0, 2, 0]));
      loopTrain(b, Uint8Array.from([0, 2, 0, 1, 0]));
      assert.equal(
        toHex(await modelDigest(a)), toHex(await modelDigest(b)),
        "transposed bigram multisets are indistinguishable to an abelian map",
      );
    });

    it("KEY DERIVATION no longer inherits that blindness", async () => {
      // the same two histories, established the way a real seat establishes one:
      // by actually delivering messages, which advances the transcript.
      const roster = [hexId(1), hexId(2), hexId(3)].sort();
      const root = await braidFold(null, new Uint8Array(32).fill(3), 1, roster);

      const mk = async (order: string[]) => {
        const sender = await braidInit(root, 1, roster, roster[0]);
        const peer = await braidInit(root, 1, roster, roster[1]);
        for (const text of order) {
          const sealed = await braidSeal(peer, pt(text));
          await braidOpen(sender, {
            attachment: undefined, senderIndex: peer.seatIndex, seq: sealed.seq, epochId: peer.epochId,
            confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
          });
        }
        return braidSeal(sender, pt("same plaintext"));
      };

      // two senders that received the SAME set of messages in a different order
      // within one strand. the count model cannot tell them apart; the strand is
      // ordered, so the transcript can.
      const x = await mk(["alpha", "beta"]);
      const y = await mk(["beta", "alpha"]);
      assert.notEqual(
        toHex(x.ciphertext), toHex(y.ciphertext),
        "different strand order must derive a different key",
      );
    });

    it("but interleaving ACROSS strands still does not matter (the CRDT property)", async () => {
      // this is the property the commutative model existed to give, and the
      // transcript must not destroy it: two seats that integrated the same
      // messages from different senders in different orders must agree.
      const roster = [hexId(1), hexId(2), hexId(3)].sort();
      const root = await braidFold(null, new Uint8Array(32).fill(9), 1, roster);
      const a = await braidInit(root, 1, roster, roster[0]);
      const b = await braidInit(root, 1, roster, roster[1]);

      const wires: BraidMessage[] = [];
      for (const [st, text] of [[a, "from-a"], [b, "from-b"]] as const) {
        const sealed = await braidSeal(st, pt(text));
        wires.push({
          attachment: undefined, senderIndex: st.seatIndex, seq: sealed.seq, epochId: st.epochId,
          confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
        });
      }

      const receiveIn = async (order: number[]) => {
        const c = await braidInit(root, 1, roster, roster[2]);
        for (const i of order) await braidOpen(c, wires[i]);
        return toHex(await braidSeal(c, pt("x")).then((r) => r.ciphertext));
      };
      assert.equal(
        await receiveIn([0, 1]), await receiveIn([1, 0]),
        "arrival order across strands must not change the derived key",
      );
    });
  });
  describe("18. the compression side channel is bucketed", () => {
    // The count model is shared, adaptive and trained by EVERY member, so a
    // hostile seat can seed it with a guess and watch whether the victim's next
    // message compresses better. Ciphertext length is public to every relay.
    // That is CRIME, sharpened by the model being attacker-trainable by design.
    // Measured before bucketing: a matching guess produced 37 bytes and a wrong
    // one 38 — a byte-at-a-time distinguisher.
    it("a matching guess is no longer distinguishable from a wrong one by length", async () => {
      const roster = [hexId(1), hexId(2)].sort();
      const root = await braidFold(null, new Uint8Array(32).fill(1), 1, roster);
      const secret = "s3cr3tvalue";

      const lengthAfterGuess = async (guess: string) => {
        const st = await braidInit(root, 1, roster, roster[0]);
        await braidSeal(st, pt(guess));                       // attacker seeds the model
        return (await braidSeal(st, pt(`token=${secret}`))).ciphertext.length;
      };

      const match = await lengthAfterGuess(`token=${secret}`);
      for (const wrong of [
        "token=zzzzzzzzzzz",
        "token=aaaaaaaaaaa",
        `token=${secret.slice(0, -1)}_`,   // off by the last character only
        "nothing like it at all",
      ]) {
        assert.equal(
          await lengthAfterGuess(wrong), match,
          `a wrong guess (${wrong}) must not be distinguishable from a right one`,
        );
      }
    });

    it("every ciphertext lands on a bucket boundary", async () => {
      const roster = [hexId(1), hexId(2)].sort();
      const root = await braidFold(null, new Uint8Array(32).fill(4), 1, roster);
      const st = await braidInit(root, 1, roster, roster[0]);
      // AES-GCM adds a 16-byte tag to the padded inner payload
      for (const len of [0, 1, 5, 63, 64, 65, 200, 1000]) {
        const sealed = await braidSeal(st, new Uint8Array(len).fill(0x41));
        const innerLen = sealed.ciphertext.length - 16;
        assert.equal(
          innerLen % BRAID_PAD_BUCKET, 0,
          `a ${len}-byte payload produced a ${innerLen}-byte inner, off the bucket grid`,
        );
      }
    });

    it("bucketing does not corrupt anything: payloads still round-trip exactly", async () => {
      const roster = [hexId(1), hexId(2), hexId(3)].sort();
      const root = await braidFold(null, new Uint8Array(32).fill(5), 1, roster);
      const a = await braidInit(root, 1, roster, roster[0]);
      const b = await braidInit(root, 1, roster, roster[1]);
      // sizes either side of every boundary the padder can pick
      for (const len of [0, 1, 59, 60, 61, 123, 124, 125, 512]) {
        const body = new Uint8Array(len);
        for (let i = 0; i < len; i++) body[i] = (i * 37 + len) & 0xff;
        const sealed = await braidSeal(a, body);
        const res = await braidOpen(b, {
          attachment: undefined, senderIndex: a.seatIndex, seq: sealed.seq, epochId: a.epochId,
          confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
        });
        assert.equal(res.status, "delivered", `a ${len}-byte payload must deliver`);
        if (res.status === "delivered") {
          assertBytesEqual(res.delivered[0].plaintext, body, `a ${len}-byte payload round-trips`);
        }
      }
    });
  });
  describe("19. retained plaintext is time-bounded (intra-epoch forward secrecy)", () => {
    // The store exists so a lagging seat can have the sender's view rebuilt, so
    // REPLAY REQUIRES HISTORY: you cannot both serve arbitrary replay and forget
    // what was said. Intra-epoch forward secrecy is therefore bounded by this
    // window, NOT by key zeroization — wiping message keys achieves nothing while
    // the plaintexts they protected are still in memory.
    //
    // CORRECTED. This section first asserted that age ALONE evicts, which was
    // wrong and shipped a real bug: wall-clock time is incomparable to the
    // frontier order, so the sweep discarded history a lagging seat still needed
    // and made a quiet member permanently unreadable for the epoch. The clock may
    // only act at or below the meet of the lane frontiers, so eviction now needs
    // the circle to have MOVED PAST the entry as well as time to have passed.
    // See braid-store-watermark.test.ts for the lattice argument.
    it("age alone does NOT evict while a seat could still ask for it", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x19000001);
      const a = circle.state("A");
      let clock = 1_000_000;
      a.now = () => clock;

      await braidSeal(a, pt("the quick brown fox"));
      assert.ok(a.store.size > 0, "the plaintext is retained for replay");

      clock += BRAID_STORE_TTL_MS + 1;
      await braidSeal(a, pt("later message"));   // any store touch sweeps

      // B and C have acknowledged nothing, so their lanes sit at zero and the
      // meet is zero: every entry is still reachable and the clock is powerless.
      assert.ok([...a.store.keys()].some((k) => k.endsWith(":1")),
        "an aged entry that a behind-lane could still request must survive the sweep");
    });

    it("once the circle has moved past it, age DOES evict, and zeroizes", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x19000011);
      const a = circle.state("A");
      let clock = 1_000_000;
      a.now = () => clock;

      const m1 = await circle.send("A", pt("the quick brown fox"));
      const held = [...a.store.values()][0];
      assert.ok(held.some((b) => b !== 0), "precondition: real bytes are retained");

      // B and C integrate it and then speak, so their declared frontiers rise
      // past A:1 and the meet clears the entry.
      for (const l of ["B", "C"] as const) {
        assert.equal((await circle.recv(l, m1)).status, "delivered");
        const back = await circle.send(l, pt(`ack from ${l}`));
        await circle.recv("A", back);
      }

      clock += BRAID_STORE_TTL_MS + 1;
      await braidSeal(a, pt("trigger the sweep"));

      // Precisely A's own first message. A bare ":1" would also match B's and
      // C's stored frames, whose meet components are still zero because the two
      // of them never heard each other, so they are correctly retained.
      const aKey = `${circle.idx("A")}:1`;
      assert.ok(!a.store.has(aKey),
        `below the meet the clock is free, so ${aKey} must go`);
      assert.ok(held.every((b) => b === 0),
        "and its buffer was zeroized, not just unlinked");
    });

    it("the byte accounting stays correct across expiry", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x19000002);
      const a = circle.state("A");
      let clock = 500_000;
      a.now = () => clock;

      for (let i = 0; i < 5; i++) await braidSeal(a, pt(`message ${i}`));
      assert.ok(a.storeBytes > 0, "bytes are accounted while retained");

      clock += BRAID_STORE_TTL_MS + 1;
      await braidSeal(a, pt("trigger the sweep"));

      let actual = 0;
      for (const v of a.store.values()) actual += v.length;
      assert.equal(a.storeBytes, actual, "storeBytes matches what is actually held");
      assert.equal(a.store.size, a.storeAt.size, "the timestamp index does not leak entries");
    });

    it("within the window replay still works, so the bound is not a wall", async () => {
      const circle = await Circle.make(["A", "B", "C"], 1, 0x19000003);
      const a = circle.state("A");
      let clock = 2_000_000;
      a.now = () => clock;

      const m1 = await circle.send("A", pt("one"));
      clock += BRAID_STORE_TTL_MS / 2;          // still inside the window
      const m2 = await circle.send("A", pt("two"));

      assert.equal((await circle.recv("B", m1)).status, "delivered");
      assert.equal((await circle.recv("B", m2)).status, "delivered", "replay inside the window is unaffected");
    });
  });
});
