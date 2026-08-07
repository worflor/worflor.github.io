/**
 * braid-store-watermark.test.ts — can history be forgotten on a clock?
 *
 * ══ THE STRUCTURE ══
 *
 * A frontier is a vector clock: F ∈ ℕ^seats, ordered componentwise. Vector
 * clocks form a LATTICE under that order, and the braid holds one per lane —
 * `lanes[s].frontier` is this receiver's record of where seat s had reached.
 *
 * The replay in `openOne` walks from `lane.frontier` up to the frontier the
 * incoming message declares, reading each intervening plaintext out of
 * `state.store`. So the store must retain every plaintext at or above
 *
 *     W  =  ⋀ₛ lanes[s].frontier        (the meet, componentwise minimum)
 *
 * W is the STABILITY FRONTIER: history strictly below it is behind every lane
 * and can never be asked for again, history at or above it is still reachable by
 * some seat's next message. That meet is the exact garbage-collection watermark,
 * and it is not a heuristic — it is the greatest lower bound in the lattice, so
 * it is the largest safe thing to forget.
 *
 * ══ THE QUESTION ══
 *
 * `BRAID_STORE_TTL_MS` evicts by wall-clock age. Time is INCOMPARABLE to the
 * frontier order: nothing relates "older than 60s" to "below the meet". So the
 * TTL can evict history that a lagging lane still needs.
 *
 * This is the third appearance of one disease in this codebase — an eviction
 * policy ordered by one thing serving a consumer ordered by another. First the
 * count model (abelian) keyed what needed the trace. Then pendingMeta (arrival
 * order) served the holdback (delivery order). Now the store (wall time) serves
 * the frontier lattice (causal order).
 *
 * MEASURED, and it was real. A member who read without replying for sixty
 * seconds became PERMANENTLY unreadable to the rest of the circle for the whole
 * epoch. The in-code claim that "repair can refill the store and a retransmit
 * lands" was false: the store is written on DELIVERY, and re-supplying an
 * already-integrated seq is ignored, so repair puts nothing back.
 *
 * The fix was not to lengthen the TTL. `storeGc` already computed this exact
 * meet and evicted correctly; the TTL and the cap sweep were later additions
 * that simply did not consult it. All three eviction paths now share one rule,
 * so the clock may only act on what the lattice has already declared dead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicBytes } from "./_helpers/generators.js";
import {
  braidFold, braidInit, braidSeal, braidOpen, braidStatus,
  BRAID_STORE_TTL_MS, BRAID_MAX_STRIKES,
} from "../../src/scripts/whisper/live-braid.js";
import type { BraidState, BraidMessage } from "../../src/scripts/whisper/live-braid.js";

const TE = new TextEncoder();
const hexId = (n: number) => n.toString(16).padStart(2, "0").repeat(16);

interface Circle {
  states: BraidState[];
  idx: Map<string, number>;
}

async function makeCircle(labels: string[], seed: number): Promise<Circle> {
  const hexOf = new Map(labels.map((l, i) => [l, hexId(i + 1)]));
  const roster = Array.from(hexOf.values()).sort();
  const root = await braidFold(null, deterministicBytes(32, seed), 1, roster);
  const idx = new Map(labels.map((l) => [l, roster.indexOf(hexOf.get(l)!)]));
  const states: BraidState[] = new Array(roster.length);
  for (const l of labels) states[idx.get(l)!] = await braidInit(root, 1, roster, hexOf.get(l)!);
  return { states, idx };
}

async function send(c: Circle, label: string, text: string): Promise<BraidMessage> {
  const st = c.states[c.idx.get(label)!];
  const { seq, frontier, confirm, ciphertext } = await braidSeal(st, TE.encode(text));
  return {
    attachment: undefined,
    senderIndex: st.seatIndex, seq, epochId: st.epochId, confirm, frontier, ciphertext,
  };
}

const recv = (c: Circle, label: string, m: BraidMessage) =>
  braidOpen(c.states[c.idx.get(label)!], m);

const clone = (m: BraidMessage): BraidMessage => ({
  attachment: undefined,
  senderIndex: m.senderIndex, seq: m.seq, epochId: m.epochId,
  confirm: m.confirm.slice(), frontier: m.frontier.slice(), ciphertext: m.ciphertext.slice(),
});

describe("the store watermark: forgetting history on a clock", () => {
  it("a seat that stays quiet past the TTL is still understood when it speaks", async () => {
    const c = await makeCircle(["A", "B", "C"], 0x5701);
    const B = c.states[c.idx.get("B")!];

    // drive B's clock explicitly rather than sleeping
    let clock = 1_000_000;
    B.now = () => clock;

    // A talks; B and C both hear it. C stays silent throughout, which is the
    // ordinary behaviour of someone reading without replying.
    const fromA: BraidMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await send(c, "A", `A says ${i}`);
      fromA.push(m);
      assert.equal((await recv(c, "B", clone(m))).status, "delivered");
      assert.equal((await recv(c, "C", clone(m))).status, "delivered");
    }

    // Time passes. B keeps receiving, so the sweep runs and A's plaintexts age
    // out of B's store even though C's lane still sits at the start.
    clock += BRAID_STORE_TTL_MS + 1;
    const filler = await send(c, "A", "A says something later");
    await recv(c, "B", clone(filler));

    // C finally speaks. Its frontier names A's earlier messages, so B must
    // replay them to rebuild C's view — and B no longer has them.
    const fromC = await send(c, "C", "C finally replies");
    const out = await recv(c, "B", clone(fromC));

    // Before the watermark governed eviction, this was the bug: the clock had
    // discarded plaintexts C's view still needed, C could not be opened, and
    // because the store is written on delivery there was no way back inside the
    // epoch. Reading without replying for a minute made you permanently
    // unreadable, which is simply what a lurker does.
    assert.equal(out.status, "delivered",
      "a quiet seat must remain readable: its lane is behind, so the history it " +
      "needs is above the meet and no clock may discard it");
  });

  it("and it does NOT sever the lane, which is the part that was got right", async () => {
    // The rejection is unattributable on purpose: the frontier naming the missing
    // history is unauthenticated, so a forged frontier must not be able to kill a
    // seat. Retrying must therefore be free.
    const c = await makeCircle(["A", "B", "C"], 0x5702);
    const B = c.states[c.idx.get("B")!];
    let clock = 2_000_000;
    B.now = () => clock;

    for (let i = 0; i < 3; i++) {
      const m = await send(c, "A", `msg ${i}`);
      await recv(c, "B", clone(m));
      await recv(c, "C", clone(m));
    }
    clock += BRAID_STORE_TTL_MS + 1;
    await recv(c, "B", clone(await send(c, "A", "later")));

    const fromC = await send(c, "C", "hello");
    for (let i = 0; i < BRAID_MAX_STRIKES * 3; i++) {
      await recv(c, "B", clone(fromC));
    }
    assert.equal(braidStatus(B)[c.idx.get("C")!].diverged, false,
      "an evicted-history rejection must never accumulate strikes: the frontier " +
      "that names the missing history is attacker-controlled");
  });

  it("BELOW the meet, the clock still forgets, so forward secrecy is not lost", async () => {
    /**
     * The fix must not degenerate into "never evict". The TTL exists because
     * retained plaintexts are the real bound on intra-epoch forward secrecy:
     * wiping message keys accomplishes nothing while the plaintexts they
     * protected are still in memory.
     *
     * So the rule has to bite in both directions. Above the meet the clock is
     * powerless; below it, where every lane has already passed and no seat can
     * ever ask again, the clock is free and must actually act.
     */
    const c = await makeCircle(["A", "B", "C"], 0x5703);
    const B = c.states[c.idx.get("B")!];
    let clock = 3_000_000;
    B.now = () => clock;

    // Everyone speaks and everyone hears, so every lane's frontier advances and
    // the meet rises past this traffic.
    for (let round = 0; round < 3; round++) {
      for (const speaker of ["A", "C"] as const) {
        const m = await send(c, speaker, `${speaker} round ${round}`);
        for (const listener of ["A", "B", "C"] as const) {
          if (listener !== speaker) await recv(c, listener, clone(m));
        }
      }
    }

    const retained = [...B.store.values()];
    assert.ok(B.store.size > 0, "precondition: B is retaining history");
    const sample = retained[0];
    assert.ok(sample.some((x) => x !== 0), "precondition: and it is real bytes");

    // age everything out, then touch the store so the sweep runs
    clock += BRAID_STORE_TTL_MS + 1;
    const trailer = await send(c, "A", "one more");
    await recv(c, "B", clone(trailer));

    assert.ok(B.store.size < retained.length + 1,
      `the clock must still collect what is below the meet (held ${B.store.size} of ${retained.length + 1})`);
    assert.ok(sample.every((x) => x === 0),
      "and evicted plaintext must be zeroized, not merely unlinked: forward " +
      "secrecy is about what is left in the heap, not about what is reachable");
  });

  it("the safe watermark is the MEET of the lane frontiers, not an age", async () => {
    // Establishes the structural claim positively: with the clock held still, a
    // quiet seat is understood no matter how much traffic passes, because nothing
    // below the meet has been discarded.
    const c = await makeCircle(["A", "B", "C"], 0x5704);
    const B = c.states[c.idx.get("B")!];
    B.now = () => 5_000_000; // time does not move

    for (let i = 0; i < 12; i++) {
      const m = await send(c, "A", `chatter ${i}`);
      await recv(c, "B", clone(m));
      await recv(c, "C", clone(m));
    }

    const fromC = await send(c, "C", "still readable");
    assert.equal((await recv(c, "B", clone(fromC))).status, "delivered",
      "with nothing aged out, the quiet seat opens fine even far behind the others: " +
      "the requirement is lattice-shaped, so only the meet may be forgotten");
  });
});
