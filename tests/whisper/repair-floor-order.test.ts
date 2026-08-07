/**
 * repair-floor-order.test.ts — the eviction order at the CALL SITE.
 *
 * `slotIsDead` is unit-tested in retention-law.test.ts, but a shared comparison
 * only helps if the sites actually feed it the right floor. Mutating the order
 * showed the gap: inverting either epoch clause killed only the unit test, so
 * the repair cache and the outstanding-wants purge were free to disagree with it
 * — which is exactly how the two had already drifted apart before they were
 * consolidated (one treated a LATER epoch as alive, the other as dead).
 *
 * So these tests drive the private methods with a hand-built floor and check the
 * three things a cache serving ring repair must get right:
 *
 *   PAST     a closed epoch is unreachable, because a fold restarts every strand
 *            and nobody will ever ask along the old numbering again.
 *   FUTURE   an epoch ahead of the floor is never behind anyone. Dropping it is
 *            data loss aimed at the seats that have already moved on.
 *   SEAT     the meet is per strand. One busy seat's progress must not authorize
 *            forgetting a quiet seat's history.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CampfireNode } from "../../src/scripts/whisper/campfire/gossip.js";
import { DEDUP_RING_SIZE } from "../../src/scripts/whisper/campfire/types.js";

const SEAT_A = "aa".repeat(16);
const SEAT_B = "bb".repeat(16);
const ME = "cc".repeat(16);

/**
 * The smallest object `rememberRecent` actually reads. Building it by hand
 * rather than standing up a mesh keeps the test aimed at the ORDER: everything
 * that could smear the result (real frontiers, timing, delivery) is pinned.
 */
function stubNode(opts: { epochId: number; frontiers: Record<string, number[]> }) {
  const roster = [SEAT_A, SEAT_B, ME].sort();
  // rememberRecent reaches repairFloor through `this`, so the stub carries the
  // REAL method rather than a substitute: the floor computation is half of what
  // is under test, and reimplementing it here would test the reimplementation.
  const self = {
    repairFloor: (hex: string) =>
      (CampfireNode.prototype as unknown as { repairFloor(h: string): number })
        .repairFloor.call(self, hex),
    recentBySeq: new Map<string, Uint8Array>(),
    currentEpoch: { epochId: opts.epochId, roster },
    peerIdHex: ME,
    peerFrontier: new Map<string, Uint32Array>(
      Object.entries(opts.frontiers).map(([hex, f]) => [hex, Uint32Array.from(f)]),
    ),
  };
  const proto = CampfireNode.prototype as unknown as {
    rememberRecent(e: number, hex: string, seq: number, raw: Uint8Array): void;
    repairFloor(hex: string): number;
  };
  return {
    roster,
    store: self.recentBySeq,
    remember: (epoch: number, hex: string, seq: number) =>
      proto.rememberRecent.call(self, epoch, hex, seq, new Uint8Array([seq & 0xff])),
    floorFor: (hex: string) => proto.repairFloor.call(self, hex),
  };
}

/** enough entries to force the cap to bite, so eviction is actually exercised. */
const OVERFILL = DEDUP_RING_SIZE + 40;

describe("the repair cache evicts along (epoch, seat, seq)", () => {
  it("keeps a FUTURE epoch even under full cap pressure", () => {
    // The clause a mutant could invert with no call-site test noticing. A frame
    // from an epoch ahead of ours is not behind any reader by definition, so no
    // amount of pressure may justify dropping it.
    const n = stubNode({ epochId: 5, frontiers: { [SEAT_A]: [0, 0, 0], [SEAT_B]: [0, 0, 0] } });
    assert.equal(n.floorFor(SEAT_A), 0, "precondition: nobody has advanced, so the meet is 0");

    n.remember(6, SEAT_A, 1); // one message from the epoch after ours
    for (let i = 1; i <= OVERFILL; i++) n.remember(4, SEAT_A, i); // a closed epoch, all droppable

    assert.ok(n.store.has(`6:${SEAT_A}:1`),
      "an entry from a later epoch is ahead of every reader and must survive eviction");
    assert.ok(n.store.size <= DEDUP_RING_SIZE + 1,
      `the closed epoch should have absorbed the pressure, held ${n.store.size}`);
  });

  it("drops a CLOSED epoch freely, since the numbering it used is retired", () => {
    const n = stubNode({ epochId: 9, frontiers: { [SEAT_A]: [0, 0, 0], [SEAT_B]: [0, 0, 0] } });
    for (let i = 1; i <= OVERFILL; i++) n.remember(8, SEAT_A, i);
    assert.ok(n.store.size <= DEDUP_RING_SIZE,
      `a closed epoch is unreachable and must be collectable, held ${n.store.size}`);
  });

  it("a busy seat's progress does not authorize forgetting a QUIET seat", () => {
    // The cross-principal shape the floor exists to prevent: volume from one
    // party, loss landing on another. Both peers have passed seat A's strand,
    // and neither has touched seat B's.
    const roster = [SEAT_A, SEAT_B, ME].sort();
    const f = new Array(roster.length).fill(0);
    f[roster.indexOf(SEAT_A)] = 10_000; // everyone is far past seat A
    f[roster.indexOf(SEAT_B)] = 0;      // and nobody has heard seat B at all
    const n = stubNode({ epochId: 3, frontiers: { [SEAT_A]: f, [SEAT_B]: f } });

    n.remember(3, SEAT_B, 1); // the quiet seat's single, precious frame
    for (let i = 1; i <= OVERFILL; i++) n.remember(3, SEAT_A, i);

    assert.ok(n.store.has(`3:${SEAT_B}:1`),
      "seat B's meet is 0, so its frame is still reachable no matter how loud seat A is");
  });

  it("within the live epoch, a seat's own meet is the cut", () => {
    const roster = [SEAT_A, SEAT_B, ME].sort();
    const f = new Array(roster.length).fill(0);
    f[roster.indexOf(SEAT_A)] = 100; // both peers have passed seat A's seq 100
    const n = stubNode({ epochId: 3, frontiers: { [SEAT_A]: f, [SEAT_B]: f } });

    assert.equal(n.floorFor(SEAT_A), 100, "the floor is the meet of the peers' declared frontiers");

    // Sized so the cap wants EXACTLY the dead prefix gone: DEDUP_RING_SIZE + 100
    // entries, meet at 100. The sweep therefore has to stop precisely at the
    // boundary, which pins the comparison to `<=` rather than `<` — an off-by-one
    // either strands one dead entry or eats seq 101, and both show up below.
    const total = DEDUP_RING_SIZE + 100;
    for (let i = 1; i <= total; i++) n.remember(3, SEAT_A, i);

    assert.equal(n.store.size, DEDUP_RING_SIZE,
      "there is exactly enough dead history to satisfy the cap, so the sweep must reach it");
    for (let i = 1; i <= total; i++) {
      assert.equal(n.store.has(`3:${SEAT_A}:${i}`), i > 100,
        i > 100
          ? `seq ${i} is above the meet (100) and is still owed to a reader`
          : `seq ${i} is at or below the meet (100) and is reachable by nobody`);
    }
  });

  it("a seat that is not in the roster is owed nothing", () => {
    // Nobody can name it in a RING_WANT, so its floor is the top element.
    const n = stubNode({ epochId: 3, frontiers: {} });
    assert.equal(n.floorFor("ff".repeat(16)), Infinity,
      "an unseated peer's history is unreachable by construction");
  });
});
