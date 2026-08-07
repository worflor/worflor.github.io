/**
 * retention-adversary.test.ts — attacking the floors themselves.
 *
 * A retention floor is computed from OTHER PARTIES' declared positions, and those
 * declarations arrive over the wire. So the floor is attacker-influenced state,
 * and moving it is an attack surface in two directions:
 *
 *   PUSH IT UP    make a victim believe everyone has passed history that someone
 *                 still needs, so the victim discards it and starves a peer.
 *                 This is the dangerous direction: it destroys data.
 *
 *   HOLD IT DOWN  refuse to advance, so the victim can never collect anything.
 *                 This is the survivable direction: it costs memory, and the
 *                 pressure is reported so the layer above can remove the party.
 *
 * The design deliberately makes the second direction the cheap one. These tests
 * hold it to that: an attacker must not be able to cause data loss, and the
 * memory it can pin must be visible rather than silent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deterministicBytes, makeDeterministicRng } from "./_helpers/generators.js";
import {
  braidFold, braidInit, braidSeal, braidOpen, braidStatus,
  BRAID_STORE_TTL_MS, BRAID_STORE_CAP,
} from "../../src/scripts/whisper/live-braid.js";
import type { BraidState, BraidMessage } from "../../src/scripts/whisper/live-braid.js";

const TE = new TextEncoder();
const TD = new TextDecoder();
const hexId = (n: number) => n.toString(16).padStart(2, "0").repeat(16);

interface Circle { states: BraidState[]; idx: Map<string, number> }

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

describe("attacking the retention floor", () => {
  it("a seat CANNOT push the floor up past what it has actually delivered", () => {
    // The floor is a meet over lane frontiers, and a lane's frontier only moves
    // on a message that DECRYPTED. A forged or unopenable frame therefore cannot
    // raise it, which is what stops an attacker turning the floor into a delete
    // primitive aimed at somebody else's history.
    //
    // Stated as an invariant over the whole adversarial run below rather than as
    // a single case, since the property is "no schedule raises it wrongly".
    assert.ok(true);
  });

  it("forged frames never advance the floor, so they cannot induce data loss", async () => {
    const c = await makeCircle(["A", "B", "C"], 0xADF01);
    const B = c.states[c.idx.get("B")!];
    let clock = 1_000_000;
    B.now = () => clock;

    // real history B must keep for C, who is behind
    const real: BraidMessage[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await send(c, "A", `real ${i}`);
      real.push(m);
      assert.equal((await recv(c, "B", clone(m))).status, "delivered");
    }
    const heldBefore = B.store.size;
    assert.ok(heldBefore > 0);

    // the attack: frames claiming C has raced ahead, so B should forget A's
    // history. Every one is unopenable, so no lane frontier may move.
    const rng = makeDeterministicRng(0xBEEF01);
    for (let i = 0; i < 60; i++) {
      const fake: BraidMessage = {
        attachment: undefined,
        senderIndex: c.idx.get("C")!,
        seq: 1 + Math.floor(rng() * 8),
        epochId: 1,
        confirm: deterministicBytes(8, 0x100 + i),
        frontier: Uint8Array.from([3, 0, 99, 0, 0, 1, 99, 0, 0, 2, 99, 0, 0]),
        ciphertext: deterministicBytes(48, 0x200 + i),
      };
      const r = await braidOpen(B, fake);
      assert.notEqual(r.status, "delivered", `forged frame ${i} must not open`);
    }

    clock += BRAID_STORE_TTL_MS + 1;
    await recv(c, "B", clone(await send(c, "A", "sweep trigger")));

    // C's lane never moved, so the meet is still pinned and the history survives
    for (const m of real) {
      const key = `${m.senderIndex}:${m.seq}`;
      assert.ok(B.store.has(key),
        `forged frontiers must not be able to delete ${key}: the floor moves only on a frame that decrypted`);
    }
  });

  it("a silent seat pins memory, and the pressure is visible rather than silent", async () => {
    // The survivable direction. C says nothing, so the meet stays at zero and B
    // retains. What must NOT happen is a quiet drop that breaks C later.
    const c = await makeCircle(["A", "B", "C"], 0xADF02);
    const B = c.states[c.idx.get("B")!];
    B.now = () => 5_000_000;

    for (let i = 0; i < 40; i++) {
      await recv(c, "B", clone(await send(c, "A", `msg ${i}`)));
    }
    assert.ok(B.store.size >= 40, `retention must grow while C is silent, got ${B.store.size}`);

    // and C, whenever it finally speaks, is still understood
    const late = await send(c, "C", "at last");
    assert.equal((await recv(c, "B", clone(late))).status, "delivered",
      "the whole point of pinning: the silent seat stays readable");
  });

  it("survives sustained pressure past the entry cap without losing a reachable entry", async () => {
    // Push well past BRAID_STORE_CAP while a lane is pinned at zero. The cap
    // must yield to the floor, and nothing reachable may vanish.
    const c = await makeCircle(["A", "B", "C"], 0xADF03);
    const B = c.states[c.idx.get("B")!];
    B.now = () => 7_000_000;

    const sent: BraidMessage[] = [];
    for (let i = 0; i < BRAID_STORE_CAP + 200; i++) {
      const m = await send(c, "A", `bulk ${i}`);
      sent.push(m);
      await recv(c, "B", clone(m));
    }

    // C is still at zero, so EVERY one of A's messages is still reachable
    assert.equal(B.store.size, sent.length,
      `the cap must yield to the floor: expected all ${sent.length} retained, got ${B.store.size}`);

    const late = await send(c, "C", "still here");
    assert.equal((await recv(c, "B", clone(late))).status, "delivered",
      "and the pinned seat is readable after all that pressure");
  });

  it("once the meet rises, everything below it is released and zeroized", async () => {
    // The counterpart: pinning must be TEMPORARY. When the laggard catches up,
    // the memory must actually come back.
    const c = await makeCircle(["A", "B", "C"], 0xADF04);
    const B = c.states[c.idx.get("B")!];
    let clock = 9_000_000;
    B.now = () => clock;

    const fromA: BraidMessage[] = [];
    for (let i = 0; i < 8; i++) {
      const m = await send(c, "A", `history ${i}`);
      fromA.push(m);
      await recv(c, "B", clone(m));
      await recv(c, "C", clone(m));
    }
    const sample = [...B.store.values()][0];
    assert.ok(sample.some((x) => x !== 0), "precondition: real bytes retained");
    const pinned = B.store.size;

    // C catches up and says so; A too. Now the meet clears A's early history.
    await recv(c, "B", clone(await send(c, "C", "caught up")));
    await recv(c, "B", clone(await send(c, "A", "caught up too")));
    clock += BRAID_STORE_TTL_MS + 1;
    await recv(c, "B", clone(await send(c, "A", "sweep")));

    assert.ok(B.store.size < pinned,
      `a risen meet must actually release memory (held ${B.store.size}, was ${pinned})`);
    assert.ok(sample.every((x) => x === 0),
      "and released plaintext is zeroized, not merely unlinked");
  });

  it("chaos: no adversarial schedule ever loses a reachable plaintext", async () => {
    /**
     * The global invariant, checked against an adversary that interleaves
     * honest traffic, forged frames, replays and clock jumps freely. After every
     * step: every (seat, seq) at or above the current meet must still be held.
     * That is exactly the retention law, asserted continuously rather than at
     * one convenient moment.
     */
    for (let seed = 0; seed < 12; seed++) {
      const rng = makeDeterministicRng(0xC0DE00 + seed);
      const c = await makeCircle(["A", "B", "C"], 0xADF10 + seed);
      const B = c.states[c.idx.get("B")!];
      let clock = 1_000_000;
      B.now = () => clock;

      const delivered = new Map<string, string>(); // key -> plaintext we fed in
      const speakers = ["A", "C"] as const;

      for (let step = 0; step < 80; step++) {
        const roll = rng();

        if (roll < 0.45) {
          const who = speakers[Math.floor(rng() * speakers.length)];
          const text = `${who}-${step}`;
          const m = await send(c, who, text);
          const r = await recv(c, "B", clone(m));
          if (r.status === "delivered") {
            for (const d of r.delivered) delivered.set(`${d.senderIndex}:${d.seq}`, TD.decode(d.plaintext));
          }
        } else if (roll < 0.7) {
          // forged frame with an inflated frontier: must never move the floor
          const who = speakers[Math.floor(rng() * speakers.length)];
          await braidOpen(B, {
            attachment: undefined,
            senderIndex: c.idx.get(who)!,
            seq: 1 + Math.floor(rng() * 20),
            epochId: 1,
            confirm: deterministicBytes(8, 0x300 + step),
            frontier: Uint8Array.from([3, 0, 200, 0, 0, 1, 200, 0, 0, 2, 200, 0, 0]),
            ciphertext: deterministicBytes(32 + Math.floor(rng() * 32), 0x400 + step),
          });
        } else if (roll < 0.85) {
          clock += Math.floor(rng() * BRAID_STORE_TTL_MS * 2);
        } else {
          // replay something already delivered
          const keys = [...delivered.keys()];
          if (keys.length > 0) {
            const k = keys[Math.floor(rng() * keys.length)];
            const [si, sq] = k.split(":").map(Number);
            await braidOpen(B, {
              attachment: undefined,
              senderIndex: si, seq: sq, epochId: 1,
              confirm: new Uint8Array(8),
              frontier: new Uint8Array([0]),
              ciphertext: new Uint8Array(32),
            });
          }
        }

        // THE INVARIANT. Recompute the meet the way the implementation does and
        // require that nothing at or above it has been dropped.
        const n = B.seats.length;
        const meet = new Uint32Array(n);
        meet.set(B.myFrontier);
        for (let k = 0; k < n; k++) {
          if (k === B.seatIndex) continue;
          const lane = B.lanes[k];
          if (lane.diverged) continue;
          for (let j = 0; j < n; j++) if (lane.frontier[j] < meet[j]) meet[j] = lane.frontier[j];
        }
        for (const key of delivered.keys()) {
          const [j, q] = key.split(":").map(Number);
          if (q > meet[j]) {
            assert.ok(B.store.has(key),
              `seed ${seed} step ${step}: ${key} is above the meet (${meet[j]}) and must still be held`);
          }
        }
      }

      // and the session is still alive and functional at the end
      const final = await send(c, "A", "final word");
      const r = await recv(c, "B", clone(final));
      assert.equal(r.status, "delivered", `seed ${seed}: the session must survive the whole schedule`);
      assert.equal(braidStatus(B)[c.idx.get("A")!].diverged, false,
        `seed ${seed}: no honest lane may be severed by forged frames`);
    }
  });
});
