/**
 * retention-law.test.ts — the retention floor as a law, not four coincidences.
 *
 * THE LAW. A cache answers future questions, so whether an entry may be dropped
 * is a question about the ORDER its readers search in. With readers p ∈ P at
 * demand positions dₚ, an entry at x is reachable iff ∃p. x > dₚ, hence dead iff
 *
 *     x ≤ ⋀ₚ dₚ
 *
 * The meet is the greatest lower bound, so it is the LARGEST safe thing to
 * forget: drop more and a reader starves, drop less and you only waste memory.
 *
 * Every bounded structure in the protocol now evicts through `retention.ts`
 * against its own floor:
 *
 *   braid store        frontier lattice ⋀ lanes[s].frontier
 *   appliedFolds       epoch meet over seated peers
 *   recentBySeq        per-seat repair meet over peer frontiers
 *   draining           each window's own expiry, never a newer arrival
 *   skippedLoopKeys    the two live DH generations
 *
 * These tests exercise the law itself, so a fifth structure added later has a
 * specification to be held to rather than a precedent to be copied.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evictBelowFloor, purgeDead, meetOf, slotIsDead,
  type Floor,
} from "../../src/scripts/whisper/retention.js";
import { pruneSkippedLoopKeys } from "../../src/scripts/whisper/live-protocol.js";
import { makeDeterministicRng } from "./_helpers/generators.js";

describe("the retention law", () => {
  describe("slotIsDead: the position order, stated once", () => {
    // (epoch, seq) lexicographic. Epoch first because a fold restarts every
    // strand at 1, so the same seq in a later epoch is a different place.
    const floor: Floor<number> = { epoch: 5, seqAt: (seat) => [10, 20, 0][seat] ?? 0 };

    it("a closed epoch is wholly dead, whatever the seq", () => {
      for (const seq of [0, 1, 999, 0xFFFFFFFF]) {
        assert.equal(slotIsDead({ epoch: 4, seat: 0, seq }, floor), true,
          `epoch 4 is behind floor epoch 5, so seq ${seq} is unreachable`);
      }
    });

    it("a FUTURE epoch is never dead, whatever the seq", () => {
      // The direction one call site had backwards: it treated any epoch that was
      // not the current one as dead, which would discard the future as well as
      // the past.
      for (const seq of [0, 1, 999]) {
        assert.equal(slotIsDead({ epoch: 6, seat: 0, seq }, floor), false,
          `epoch 6 is ahead of the floor, so seq ${seq} cannot be behind every reader`);
      }
    });

    it("within the floor's epoch, the seat's own meet decides", () => {
      assert.equal(slotIsDead({ epoch: 5, seat: 0, seq: 10 }, floor), true, "at the meet is dead");
      assert.equal(slotIsDead({ epoch: 5, seat: 0, seq: 11 }, floor), false, "one past is alive");
      assert.equal(slotIsDead({ epoch: 5, seat: 1, seq: 20 }, floor), true, "seats are independent");
      assert.equal(slotIsDead({ epoch: 5, seat: 1, seq: 21 }, floor), false);
    });

    it("a seat nobody has heard from pins its whole strand", () => {
      // seat 2's meet is 0, so every seq from 1 up is still reachable.
      assert.equal(slotIsDead({ epoch: 5, seat: 2, seq: 1 }, floor), false,
        "a zero meet must protect the entire strand, not expose it");
      assert.equal(slotIsDead({ epoch: 5, seat: 2, seq: 0 }, floor), true,
        "seq 0 is before any real message and is trivially behind");
    });

    it("is MONOTONE in the floor: raising it never resurrects a dead slot", () => {
      const rng = makeDeterministicRng(0x5107);
      for (let t = 0; t < 400; t++) {
        const slot = {
          epoch: Math.floor(rng() * 8),
          seat: Math.floor(rng() * 4),
          seq: Math.floor(rng() * 50),
        };
        const lowEpoch = Math.floor(rng() * 8);
        const low: Floor<number> = { epoch: lowEpoch, seqAt: () => Math.floor(rng() * 25) };
        if (!slotIsDead(slot, low)) continue;
        // any floor at least as high must still call it dead
        const high: Floor<number> = { epoch: lowEpoch + 1, seqAt: () => 0 };
        assert.equal(slotIsDead(slot, high), true,
          `slot ${JSON.stringify(slot)} died under a lower floor but revived under a higher one`);
      }
    });
  });

  describe("meetOf: absence is the bottom element", () => {
    it("is the minimum over known positions", () => {
      assert.equal(meetOf([5, 3, 9]), 3);
      assert.equal(meetOf([7]), 7);
    });

    it("treats an unheard-of party as 0, pinning everything", () => {
      // A party we have no news of might be anywhere, so it constrains all of
      // it. Assuming a silent party is caught up is exactly what stranded a
      // seat sixteen epochs behind.
      assert.equal(meetOf([100, undefined, 50]), 0);
      assert.equal(meetOf([]), 0, "no readers at all is the degenerate floor");
    });
  });

  describe("evictBelowFloor: the cap never outranks the floor", () => {
    it("drops dead entries oldest-first until the cap is met", () => {
      const m = new Map<number, string>();
      for (let i = 1; i <= 10; i++) m.set(i, `v${i}`);
      const r = evictBelowFloor(m, 6, (k) => k <= 8);
      assert.equal(r.dropped, 4);
      assert.equal(r.overCap, 0);
      assert.deepEqual([...m.keys()], [5, 6, 7, 8, 9, 10], "the four oldest dead entries went");
    });

    it("STOPS at the floor rather than meeting the cap", () => {
      // The whole point. Over-cap memory is recoverable; an entry a reader
      // still needs is not.
      const m = new Map<number, string>();
      for (let i = 1; i <= 10; i++) m.set(i, `v${i}`);
      const r = evictBelowFloor(m, 2, (k) => k <= 3);
      assert.equal(r.dropped, 3, "only the three dead entries were droppable");
      assert.equal(m.size, 7);
      assert.equal(r.overCap, 5, "and the pressure is REPORTED, not resolved by breaking someone");
    });

    it("never drops a live entry even when nothing is dead", () => {
      const m = new Map<number, string>();
      for (let i = 1; i <= 5; i++) m.set(i, `v${i}`);
      const r = evictBelowFloor(m, 1, () => false);
      assert.equal(r.dropped, 0);
      assert.equal(m.size, 5, "a floor that admits nothing means nothing may go");
      assert.equal(r.overCap, 4);
    });

    it("insertion order only breaks ties AMONG the dead", () => {
      // Entry 1 is oldest but live; 2 and 3 are younger but dead. A pure FIFO
      // would take 1 first, which is the bug this law exists to prevent.
      const m = new Map<number, string>([[1, "live"], [2, "dead"], [3, "dead"]]);
      evictBelowFloor(m, 1, (k) => k !== 1);
      assert.deepEqual([...m.keys()], [1], "the live entry outlived both older-cap pressures");
    });

    it("hands the value to onDrop so resources can be released", () => {
      const m = new Map<number, Uint8Array>([[1, Uint8Array.from([1, 2, 3])]]);
      const held = m.get(1)!;
      evictBelowFloor(m, 0, () => true, (_k, v) => v.fill(0));
      assert.deepEqual([...held], [0, 0, 0], "the callback must receive the removed value");
    });
  });

  describe("purgeDead: below the floor, forget as eagerly as you like", () => {
    it("drops every dead entry regardless of the cap", () => {
      const m = new Map<number, string>();
      for (let i = 1; i <= 10; i++) m.set(i, `v${i}`);
      assert.equal(purgeDead(m, (k) => k % 2 === 0), 5);
      assert.deepEqual([...m.keys()], [1, 3, 5, 7, 9]);
    });

    it("is a no-op when the floor admits nothing", () => {
      const m = new Map<number, string>([[1, "a"], [2, "b"]]);
      assert.equal(purgeDead(m, () => false), 0);
      assert.equal(m.size, 2);
    });
  });

  describe("skippedLoopKeys: the floor is the live DH generation pair", () => {
    const KEY = () => Uint8Array.from([7, 7, 7, 7]);
    // The sweep is guarded on MAX_SKIP, because it runs on every catch-up and an
    // unguarded scan makes skipping quadratic in the number of skips. So a test
    // must push past that guard to observe it at all.
    const MAX_SKIP = 256;
    const padTo = (m: Map<string, Uint8Array>, gen: string, n: number) => {
      for (let i = 0; i < n; i++) m.set(`${gen}:pad${i}`, KEY());
    };

    it("keeps the current generation and its predecessor, drops older ones", () => {
      const m = new Map<string, Uint8Array>();
      for (const gen of ["genA", "genB", "genC"]) {
        for (let c = 0; c < 3; c++) m.set(`${gen}:${c}`, KEY());
      }
      padTo(m, "genC", MAX_SKIP + 1);
      pruneSkippedLoopKeys(m, "genC");
      const gens = new Set([...m.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))));
      assert.deepEqual([...gens].sort(), ["genB", "genC"],
        "a frame from genA can no longer be accepted at all, so its keys are dead");
    });

    it("zeroizes the message keys it drops", () => {
      // Three generations, so one is genuinely past the live pair. With only two
      // present both are live by definition and nothing may be dropped.
      const m = new Map<string, Uint8Array>();
      const doomed = KEY();
      m.set("gen0:0", doomed);
      m.set("gen1:0", KEY());
      m.set("gen2:0", KEY());
      padTo(m, "gen2", MAX_SKIP + 1);
      pruneSkippedLoopKeys(m, "gen2");
      assert.ok(!m.has("gen0:0"), "the generation past the live pair is dropped");
      assert.deepEqual([...doomed], [0, 0, 0, 0],
        "a dropped message key must not survive in the heap: that is the whole of what forward secrecy buys");
    });

    it("keeps BOTH when only two generations exist, since both are live", () => {
      const m = new Map<string, Uint8Array>([["prev:0", KEY()], ["cur:0", KEY()]]);
      pruneSkippedLoopKeys(m, "cur");
      assert.equal(m.size, 2, "the predecessor is still reachable via prevChainLen");
    });

    it("is stable when only one generation exists", () => {
      const m = new Map<string, Uint8Array>([["only:0", KEY()], ["only:1", KEY()]]);
      pruneSkippedLoopKeys(m, "only");
      assert.equal(m.size, 2, "nothing to prune, and nothing wrongly pruned");
    });

    it("is idempotent", () => {
      const m = new Map<string, Uint8Array>();
      for (const gen of ["a", "b", "c", "d"]) m.set(`${gen}:0`, KEY());
      padTo(m, "d", MAX_SKIP + 1);
      pruneSkippedLoopKeys(m, "d");
      const after = [...m.keys()];
      pruneSkippedLoopKeys(m, "d");
      assert.deepEqual([...m.keys()], after, "a second sweep must find nothing new to do");
    });
  });

  describe("the law composes: repeated sweeps converge and never over-drop", () => {
    it("a rising floor releases exactly what it should, monotonically", () => {
      const m = new Map<number, string>();
      for (let i = 1; i <= 100; i++) m.set(i, `v${i}`);

      let floor = 0;
      const sizes: number[] = [];
      for (let step = 0; step < 10; step++) {
        floor += 10;
        purgeDead(m, (k) => k <= floor);
        sizes.push(m.size);
        for (const k of m.keys()) {
          assert.ok(k > floor, `retained ${k} at or below floor ${floor}: over-dropping's mirror image`);
        }
      }
      assert.deepEqual(sizes, [90, 80, 70, 60, 50, 40, 30, 20, 10, 0]);
    });

    it("a STUCK floor holds everything, which is the honest outcome", () => {
      // One silent party pins the meet, so retention grows without bound. That
      // is a measurement, not a leak: the remedy belongs to the layer that can
      // remove the party, and a sweep must never take it unilaterally.
      const m = new Map<number, string>();
      for (let i = 1; i <= 50; i++) m.set(i, `v${i}`);
      const floor = meetOf([40, undefined]); // one party never heard from
      assert.equal(floor, 0);
      const r = evictBelowFloor(m, 5, (k) => k <= floor);
      assert.equal(r.dropped, 0);
      assert.equal(m.size, 50);
      assert.equal(r.overCap, 45, "pressure surfaces so the layer above can act");
    });
  });
});
