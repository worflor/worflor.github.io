/**
 * rendezvous-order.test.ts — who offers and who answers, decided identically on
 * two machines that share nothing.
 *
 * The rendezvous has no coordinator. Both peers see the same pair of attempt
 * keys and must independently pick opposite roles, so the comparison deciding it
 * has to be a pure function of those bytes: total (never a tie between distinct
 * keys), antisymmetric (each side gets the opposite answer), and above all
 * IDENTICAL on both hosts.
 *
 * It was `localeCompare`, which is none of those across hosts. With no locale
 * argument it uses the host's own, and the peers are different hosts. Measured
 * over ids of the exact shape used here, `en` and `sv` order 4.79% of pairs
 * oppositely; `da` 4.56%, `lt` 1.61%. Every disagreement gives both peers the
 * same role, and `handleMatchAck` turns both-answerer into both-offerer, so the
 * two sides end up disagreeing about who is who — which is precisely what the
 * confirm proof binds and refuses.
 *
 * The ids make it sharper than a textbook collation hazard: `randomBinId` is raw
 * bytes through `String.fromCharCode`, so these strings are dense with control
 * characters and punctuation — the code points collation treats as ignorable or
 * variable-weighted instead of as data. Against code-unit order, the host
 * default disagrees on 39% of random pairs here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareAttemptOrder, compareAttemptKeys, attemptKey, randomBinId, createRendezvousId,
} from "../../src/scripts/whisper/live-tracker.js";
import { makeDeterministicRng } from "./_helpers/generators.js";

/** ids exactly as the rendezvous makes them: 20 raw bytes as latin-1 chars. */
function binId(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 20; i++) s += String.fromCharCode(Math.floor(rng() * 256));
  return s;
}

/** the reference order: code units, which is what every host agrees on. */
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function pairs(seed: number, n: number): Array<[string, string, string, string]> {
  const rng = makeDeterministicRng(seed);
  const out: Array<[string, string, string, string]> = [];
  for (let i = 0; i < n; i++) out.push([binId(rng), binId(rng), binId(rng), binId(rng)]);
  return out;
}

describe("the rendezvous role order is a pure function of the bytes", () => {
  it("is ANTISYMMETRIC, so the two peers never claim the same role", () => {
    // Each peer calls this with itself first. Opposite signs are the whole
    // contract: one offerer, one answerer, agreed without talking about it.
    for (const [aP, aA, bP, bA] of pairs(0x1017, 5000)) {
      const mine = compareAttemptOrder(aP, aA, bP, bA);
      const theirs = compareAttemptOrder(bP, bA, aP, aA);
      assert.equal(Math.sign(mine), -Math.sign(theirs),
        "both peers must not read the same order, or both take the same branch");
    }
  });

  it("is TOTAL: distinct attempts are never tied", () => {
    // A tie sends both peers down the `else` branch — both answerer — which the
    // match-ack path then converts into both offerer.
    for (const [aP, aA, bP, bA] of pairs(0x2027, 5000)) {
      assert.notEqual(compareAttemptOrder(aP, aA, bP, bA), 0,
        "two distinct attempts must be strictly ordered");
    }
  });

  it("agrees with CODE-UNIT order, which is the only order two hosts share", () => {
    // The mutant-killer. Any collation-based implementation disagrees with this
    // on a large fraction of random ids (39% for the host default here), so
    // reintroducing localeCompare cannot survive this loop.
    for (const [aP, aA, bP, bA] of pairs(0x3037, 5000)) {
      const a = attemptKey(aP, aA);
      const b = attemptKey(bP, bA);
      assert.equal(Math.sign(compareAttemptOrder(aP, aA, bP, bA)), codeUnit(a, b),
        "the order must be locale-independent: two peers are two hosts");
    }
  });

  it("is the SAME order the rendezvous id is built from", () => {
    // These were two different orderings over one pair of strings, in one file:
    // the id sorted by code units while the role was chosen by collation. Fusing
    // them is the fix; this pins that they cannot drift apart again.
    for (const [aP, aA, bP, bA] of pairs(0x4047, 2000)) {
      const a = attemptKey(aP, aA);
      const b = attemptKey(bP, bA);
      const sortedFirst = [a, b].sort(compareAttemptKeys)[0];
      const chosenFirst = compareAttemptOrder(aP, aA, bP, bA) < 0 ? a : b;
      assert.equal(sortedFirst, chosenFirst,
        "the seat the id names first must be the seat the role logic picks first");
    }
  });

  it("is TRANSITIVE, so three concurrent attempts cannot cycle", () => {
    const rng = makeDeterministicRng(0x7A11);
    for (let i = 0; i < 2000; i++) {
      const keys = [binId(rng), binId(rng), binId(rng)];
      const [x, y, z] = keys;
      if (compareAttemptKeys(x, y) < 0 && compareAttemptKeys(y, z) < 0) {
        assert.ok(compareAttemptKeys(x, z) < 0, "a cycle would leave no consistent assignment");
      }
    }
  });

  it("the rendezvous id is checkable WITHOUT committing to anyone", () => {
    // Why this matters at the call site: the peer lock is sticky, so binding to
    // a peer and then rejecting the frame that caused the binding lets a refused
    // message decide who this attempt may talk to for its whole lifetime. The
    // check has to be possible before the commit, which it is precisely because
    // the id is a pure function of the two attempt keys — both sides can compute
    // the same value from what is already in hand.
    for (const [aP, aA, bP, bA] of pairs(0x5057, 2000)) {
      const mine = createRendezvousId(aP, aA, bP, bA);
      const theirs = createRendezvousId(bP, bA, aP, aA);
      assert.equal(mine, theirs,
        "both peers must derive the same rendezvous id from opposite viewpoints");
      assert.notEqual(mine, createRendezvousId(aP, aA, bP, randomBinId()),
        "and a different attempt must produce a different id, or the check is vacuous");
    }
  });

  it("holds on ids from the REAL generator, not just synthetic ones", () => {
    // randomBinId pulls from the crypto source the rendezvous actually uses, so
    // this checks the property against the true byte distribution.
    for (let i = 0; i < 2000; i++) {
      const aP = randomBinId(), aA = randomBinId();
      const bP = randomBinId(), bA = randomBinId();
      const mine = compareAttemptOrder(aP, aA, bP, bA);
      const theirs = compareAttemptOrder(bP, bA, aP, aA);
      assert.notEqual(mine, 0);
      assert.equal(Math.sign(mine), -Math.sign(theirs));
      assert.equal(Math.sign(mine), codeUnit(attemptKey(aP, aA), attemptKey(bP, bA)));
    }
  });
});
