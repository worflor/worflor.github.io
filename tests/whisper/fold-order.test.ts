/**
 * fold-order.test.ts — concurrent folds must converge without a coordinator.
 *
 * Epoch ids form a total order, but the EVENTS that mint them do not: two seats
 * can each author a fold for the same id. Keeping whichever arrived first makes
 * the outcome a function of the network, which is exactly the thing the mesh
 * does not agree on, so the two halves settle on different roots.
 *
 * The remedy is to make the choice a function of the FOLDS, not of the delivery
 * schedule. That requires a comparison which is TOTAL over distinct folds — a
 * partial one only relocates the arrival dependence into its ties. This file
 * checks totality by enumeration, because the first version compared roster
 * digests alone and two concurrent UPDATEs (which preserve membership, hence
 * share a digest) fell straight back to arrival order.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CampfireNode } from "../../src/scripts/whisper/campfire/gossip.js";

/** the shape foldPrecedes compares; only these four fields participate. */
interface FoldLike {
  rosterDigest: Uint8Array;
  subjectPeerId: Uint8Array;
  reason: number;
  authorPublicKey: Uint8Array;
}

const B = (...xs: number[]) => Uint8Array.from(xs);

/** reach the private comparison the way the fold path calls it. */
function precedes(a: FoldLike, b: FoldLike): boolean {
  const fn = (CampfireNode.prototype as unknown as {
    foldPrecedes(x: FoldLike, y: FoldLike): boolean;
  }).foldPrecedes;
  return fn.call({}, a, b);
}

function mk(digest: number, subject: number, reason: number, author: number): FoldLike {
  return {
    rosterDigest: B(digest, 0),
    subjectPeerId: B(subject, 0),
    reason,
    authorPublicKey: B(author, 0),
  };
}

/** every distinct fold over a small product of the four fields. */
const UNIVERSE: FoldLike[] = [];
for (const d of [1, 2]) for (const s of [1, 2]) for (const r of [1, 3]) for (const a of [1, 2]) {
  UNIVERSE.push(mk(d, s, r, a));
}

describe("concurrent folds resolve by a total, content-derived order", () => {
  it("is TOTAL: any two distinct folds are comparable, one strictly before the other", () => {
    for (const x of UNIVERSE) {
      for (const y of UNIVERSE) {
        if (x === y) continue;
        const xy = precedes(x, y);
        const yx = precedes(y, x);
        assert.notEqual(xy, yx,
          `distinct folds must be strictly ordered, got precedes both ways = ${xy}/${yx}`);
      }
    }
  });

  it("is ANTISYMMETRIC and REFLEXIVE on identical folds", () => {
    const f = mk(1, 1, 1, 1);
    const g = mk(1, 1, 1, 1);
    assert.equal(precedes(f, g), true, "identical folds: either copy will do");
    assert.equal(precedes(g, f), true);
  });

  it("is TRANSITIVE, so the winner does not depend on comparison order", () => {
    for (const x of UNIVERSE) {
      for (const y of UNIVERSE) {
        for (const z of UNIVERSE) {
          if (precedes(x, y) && precedes(y, z)) {
            assert.ok(precedes(x, z),
              "x<y and y<z must imply x<z, or the minimum is not well defined");
          }
        }
      }
    }
  });

  it("separates two concurrent UPDATEs, which share a roster digest", () => {
    // The case that broke the first version. An UPDATE preserves membership, so
    // digest alone cannot tell two of them apart and the tie fell to arrival.
    const bySeatA = mk(7, 1, 3, 1);
    const bySeatB = mk(7, 2, 3, 2);
    assert.notEqual(precedes(bySeatA, bySeatB), precedes(bySeatB, bySeatA),
      "two seats rotating keys at the same instant must still be strictly ordered");
  });

  it("CONVERGES: every arrival order picks the same winner", () => {
    // The property that actually matters. Take a set of rival folds for one
    // epoch, feed them in every permutation, and require the same survivor.
    const rivals = [mk(3, 1, 1, 1), mk(1, 2, 3, 2), mk(2, 1, 3, 1), mk(1, 2, 1, 2)];

    const winnerOf = (order: FoldLike[]): FoldLike => {
      let best = order[0];
      for (const f of order.slice(1)) if (!precedes(best, f)) best = f;
      return best;
    };

    const permute = (xs: FoldLike[]): FoldLike[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) =>
        permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));

    const perms = permute(rivals);
    assert.equal(perms.length, 24, "all 4! orders");
    const winners = new Set(perms.map((p) => JSON.stringify(winnerOf(p).rosterDigest[0]
      + ":" + winnerOf(p).subjectPeerId[0] + ":" + winnerOf(p).reason)));
    assert.equal(winners.size, 1,
      `every arrival order must select one canonical fold, got ${[...winners].join(" | ")}`);
  });

  it("the winner is the least element, so two partitioned halves agree", () => {
    const rivals = [mk(3, 1, 1, 1), mk(1, 2, 3, 2), mk(2, 1, 3, 1)];
    let least = rivals[0];
    for (const f of rivals) if (precedes(f, least)) least = f;
    for (const f of rivals) {
      assert.ok(precedes(least, f), "the selected fold must precede every rival");
    }
    assert.equal(least.rosterDigest[0], 1, "smallest digest wins, as documented");
  });
});
