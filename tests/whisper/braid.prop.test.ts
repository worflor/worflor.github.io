/**
 * braid.prop.test.ts — property-based adversarial testing of the n-seat braid.
 *
 * Every other braid test is a hand-written scenario, so it can only find bugs
 * someone already imagined. These drive GENERATED operation sequences (seal,
 * deliver, drop, duplicate, reorder, tamper, replay, cross-seat relabel) against
 * a reference transcript and assert invariants that must hold for EVERY
 * sequence. The generator explores interleavings nobody would write by hand,
 * and fast-check shrinks a failure to a minimal repro.
 *
 * The invariants are chosen so each one names a real failure:
 *   S1 totality        — braidOpen never throws, whatever arrives
 *   S2 no forgery      — a frame not produced by seal is never delivered
 *   S3 state-neutrality— a rejected frame leaves the receiver byte-identical.
 *                        This is the braid analogue of the 1:1 fullStateDigest
 *                        property, and it is the one that catches "the reject
 *                        path advanced something on its way out".
 *   S4 no duplicates   — a seat's delivered stream is duplicate-free and
 *                        strictly increasing in seq
 *   S5 authenticity    — delivered bytes equal what the sender actually sealed
 *   S6 bounded state   — the declared caps are never exceeded, under any
 *                        sequence, including hostile ones
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  braidFold,
  braidInit,
  braidSeal,
  braidOpen,
  braidStatus,
  BRAID_STORE_CAP,
  BRAID_HOLDBACK_CAP,
  type BraidState,
  type BraidMessage,
} from "../../src/scripts/whisper/live-braid.js";
import { modelDigest } from "../../src/scripts/whisper/live-loop.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TD = new TextDecoder();
const TE = new TextEncoder();

function seatHex(i: number): string {
  return (i + 1).toString(16).padStart(2, "0").repeat(16);
}

/**
 * A digest of everything a receive can move.
 *
 * `committedOnly` draws the line that S3 actually needs. Three kinds of state
 * move here and only one of them is a bug:
 *   COMMITTED   chain, nextSeq, frontier, model view, store, holdback. A reject
 *               must never touch these — moving nextSeq on a failed tag is the
 *               eviction bug, and moving the view is a silent desync.
 *   OBSERVED    unopened / strikes. These are REPORTS about rejects, so they are
 *               supposed to move when one happens.
 *   BUFFERED    the holdback. Queuing an out-of-order frame is how out-of-order
 *               delivery works, so it must move on a "held" outcome.
 * Both of the last two were found by the generator failing on correct
 * behaviour, which is the property test earning its keep before it ever caught
 * a bug: it forced the invariant to say what it actually means.
 * The per-lane model view is deliberately included in the committed half: a bug
 * that advanced a lane's counts while rejecting the frame would be invisible to
 * a digest built from counters alone, and that is the class S3 exists to catch.
 */
async function fullBraidDigest(state: BraidState, committedOnly = false): Promise<string> {
  const lanes = [];
  for (let i = 0; i < state.seats.length; i++) {
    const lane = state.lanes[i];
    lanes.push({
      i,
      nextSeq: lane.nextSeq,
      frontier: Array.from(lane.frontier),
      diverged: lane.diverged,
      reason: lane.divergedReason,
      ...(committedOnly ? {} : {
        unopened: lane.unopened,
        strikes: Array.from(lane.strikes.entries()).sort(),
      }),

      view: toHex(await modelDigest(lane.view)),
      chain: toHex(lane.chain), // secret bytes: a reject must not ratchet them
    });
  }
  return JSON.stringify({
    epochId: state.epochId,
    mySeq: state.mySeq,
    myFrontier: Array.from(state.myFrontier),
    myView: toHex(await modelDigest(state.myView)),
    myChain: toHex(state.mySendChain),
    lanes,
    store: Array.from(state.store.keys()).sort(),
    storeBytes: state.storeBytes,
    // The HOLDBACK is a buffer of frames not yet deliverable, not protocol
    // state. Queuing an out-of-order frame is the mechanism that makes
    // out-of-order delivery work, so it MUST move on a "held" outcome; folding
    // it into the committed digest makes S3 fail on correct behaviour. Its
    // growth is bounded, and S6 is what asserts that bound.
    ...(committedOnly ? {} : {
      held: Array.from(state.held.entries()).map(([k, v]) => [k, Array.from(v.keys()).sort()]).sort(),
    }),
  });
}

/** a circle of n seats sharing one epoch root */
async function makeCircle(n: number, entropySeed: number): Promise<{ roster: string[]; states: BraidState[] }> {
  const roster = Array.from({ length: n }, (_, i) => seatHex(i)).sort();
  const entropy = new Uint8Array(32).fill(entropySeed & 0xff);
  const root = await braidFold(null, entropy, 1, roster);
  const states: BraidState[] = [];
  for (const hex of roster) states.push(await braidInit(root, 1, roster, hex));
  return { roster, states };
}

/** the generated alphabet: what an adversary or a bad network can actually do */
type Op =
  | { k: "seal"; seat: number; body: number }
  | { k: "deliver"; msg: number; to: number }
  | { k: "dup"; msg: number; to: number }
  | { k: "tamperCt"; msg: number; to: number; byte: number }
  | { k: "tamperFrontier"; msg: number; to: number }
  | { k: "relabel"; msg: number; to: number; seat: number }
  | { k: "bumpSeq"; msg: number; to: number; delta: number }
  // state-aware ops. Purely random delivery almost never reaches the crypto:
  // a frame is held (seq ahead) or stale (seq behind) long before its tag is
  // checked, so the deep reject paths stay unexplored and the property passes
  // while proving very little. These two target the exact frame a receiver is
  // waiting for, which is the only way in.
  | { k: "deliverNext"; to: number; seat: number }
  | { k: "tamperNext"; to: number; seat: number; byte: number }
  // bring a receiver fully up to date. Without this a tampered frame is HELD
  // at the starvation gate (the sender's frontier names messages the receiver
  // has not integrated) and never reaches the tag check at all, so the deep
  // reject paths stay unexplored no matter how many ops are generated.
  | { k: "sync"; to: number };

const opArb = (n: number) =>
  fc.oneof(
    fc.record({ k: fc.constant("seal" as const), seat: fc.nat(n - 1), body: fc.nat(255) }),
    fc.record({ k: fc.constant("deliver" as const), msg: fc.nat(40), to: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("dup" as const), msg: fc.nat(40), to: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("tamperCt" as const), msg: fc.nat(40), to: fc.nat(n - 1), byte: fc.nat(31) }),
    fc.record({ k: fc.constant("tamperFrontier" as const), msg: fc.nat(40), to: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("relabel" as const), msg: fc.nat(40), to: fc.nat(n - 1), seat: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("bumpSeq" as const), msg: fc.nat(40), to: fc.nat(n - 1), delta: fc.integer({ min: 1, max: 3 }) }),
    // weighted up: these are the ops that actually reach the crypto
    fc.record({ k: fc.constant("deliverNext" as const), to: fc.nat(n - 1), seat: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("deliverNext" as const), to: fc.nat(n - 1), seat: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("tamperNext" as const), to: fc.nat(n - 1), seat: fc.nat(n - 1), byte: fc.nat(31) }),
    fc.record({ k: fc.constant("tamperNext" as const), to: fc.nat(n - 1), seat: fc.nat(n - 1), byte: fc.nat(31) }),
    fc.record({ k: fc.constant("sync" as const), to: fc.nat(n - 1) }),
    fc.record({ k: fc.constant("sync" as const), to: fc.nat(n - 1) }),
  );

describe("braid — property-based adversarial sequences", () => {
  it("holds S1-S6 over generated op sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 1, max: 200 }),
        fc.array(opArb(4), { minLength: 1, maxLength: 60 }),
        async (n, seed, rawOps) => {
          const { states } = await makeCircle(n, seed);
          // a "seal" op has no `to`, and every op's seat/target must be inside
          // this circle: opArb is built for the widest roster so the same
          // generator serves every n.
          const ops = (rawOps as Op[]).filter(
            (o) => ("seat" in o ? o.seat < n : true) && ("to" in o ? o.to < n : true),
          );

          // reference transcript: what was ACTUALLY sealed, by whom
          const sent: Array<{ wire: BraidMessage; from: number; body: Uint8Array }> = [];
          const genuine = new Set<string>();       // authentic (seat,seq,ciphertext)
          const delivered: Array<Set<string>> = states.map(() => new Set());
          const lastSeq: number[][] = states.map(() => new Array(n).fill(0));

          const idOf = (m: BraidMessage) => `${m.senderIndex}:${m.seq}:${toHex(m.ciphertext)}`;

          for (const op of ops) {
            if (op.k === "seal") {
              const st = states[op.seat];
              const body = TE.encode(`m${op.body}`);
              const s = await braidSeal(st, body);
              const wire: BraidMessage = {
                attachment: undefined, senderIndex: st.seatIndex, seq: s.seq, epochId: st.epochId,
                confirm: s.confirm, frontier: s.frontier, ciphertext: s.ciphertext,
              };
              sent.push({ wire, from: op.seat, body });
              genuine.add(idOf(wire));
              continue;
            }
            if (sent.length === 0) continue;

            // drive a receiver to quiescence so later tampering reaches the crypto
            if (op.k === "sync") {
              for (let pass = 0; pass < sent.length + 1; pass++) {
                let progressed = false;
                for (const cand of sent) {
                  if (cand.wire.senderIndex === states[op.to].seatIndex) continue;
                  if (cand.wire.seq !== states[op.to].lanes[cand.wire.senderIndex].nextSeq) continue;
                  const r = await braidOpen(states[op.to], cand.wire);
                  if (r.status === "delivered") {
                    progressed = true;
                    for (const d of r.delivered) {
                      const key = `${d.senderIndex}:${d.seq}`;
                      assert.ok(!delivered[op.to].has(key), `S4: duplicate delivery of ${key}`);
                      delivered[op.to].add(key);
                      assert.ok(d.seq > lastSeq[op.to][d.senderIndex], "S4: seq went backwards");
                      lastSeq[op.to][d.senderIndex] = d.seq;
                    }
                  }
                }
                if (!progressed) break;
              }
              continue;
            }

            // resolve the state-aware ops to the frame the receiver expects next
            if (op.k === "deliverNext" || op.k === "tamperNext") {
              if (op.seat === op.to) continue;
              const want = states[op.to].lanes[op.seat].nextSeq;
              const found = sent.find((x) => x.wire.senderIndex === op.seat && x.wire.seq === want);
              if (!found) continue;
              let m: BraidMessage = { ...found.wire };
              if (op.k === "tamperNext") {
                const ct = found.wire.ciphertext.slice();
                ct[op.byte % ct.length] ^= 0xff;
                m = { ...m, ciphertext: ct };
              }
              const target0 = states[op.to];
              const before0 = await fullBraidDigest(target0, true);
              let r;
              try {
                r = await braidOpen(target0, m);
              } catch (e) {
                throw new Error(`S1 totality violated by ${op.k}: ${(e as Error).message}`);
              }
              if (r.status === "delivered") {
                assert.ok(genuine.has(idOf(m)), `S2: a tampered frame delivered via ${op.k}`);
                for (const d of r.delivered) {
                  const key = `${d.senderIndex}:${d.seq}`;
                  assert.ok(!delivered[op.to].has(key), `S4: duplicate delivery of ${key}`);
                  delivered[op.to].add(key);
                  assert.ok(d.seq > lastSeq[op.to][d.senderIndex], `S4: seq went backwards`);
                  lastSeq[op.to][d.senderIndex] = d.seq;
                  const origin = sent.find((x) => x.wire.senderIndex === d.senderIndex && x.wire.seq === d.seq);
                  assert.ok(origin, "S5: delivered a message with no origin");
                  assert.equal(TD.decode(d.plaintext), TD.decode(origin!.body), "S5: plaintext mismatch");
                }
              } else if (r.status !== "diverged") {
                const after0 = await fullBraidDigest(target0, true);
                assert.equal(after0, before0, `S3: state moved on a '${r.status}' from ${op.k}`);
              }
              assert.ok(target0.store.size <= BRAID_STORE_CAP, "S6: store cap exceeded");
              for (const [, perSeat] of target0.held) {
                assert.ok(perSeat.size <= BRAID_HOLDBACK_CAP, "S6: holdback cap exceeded");
              }
              continue;
            }

            const src = sent[op.msg % sent.length];
            if (src.from === op.to) continue; // own message: braidOpen ignores it

            let msg: BraidMessage = { ...src.wire };
            if (op.k === "tamperCt") {
              const ct = src.wire.ciphertext.slice();
              ct[op.byte % ct.length] ^= 0xff;
              msg = { ...msg, ciphertext: ct };
            } else if (op.k === "tamperFrontier") {
              msg = { ...msg, frontier: new Uint8Array([9, 9, 9]) };
            } else if (op.k === "relabel") {
              if (op.seat === src.wire.senderIndex) continue;
              msg = { ...msg, senderIndex: op.seat };
            } else if (op.k === "bumpSeq") {
              msg = { ...msg, seq: src.wire.seq + op.delta };
            }

            const target = states[op.to];
            const before = await fullBraidDigest(target, true);

            // S1: totality — no input may throw out of braidOpen
            let res;
            try {
              res = await braidOpen(target, msg);
            } catch (e) {
              throw new Error(`S1 totality violated by ${op.k}: ${(e as Error).message}`);
            }

            if (res.status === "delivered") {
              // S2: only genuine frames may deliver
              assert.ok(genuine.has(idOf(msg)), `S2: a non-genuine frame delivered via ${op.k}`);
              for (const d of res.delivered) {
                const key = `${d.senderIndex}:${d.seq}`;
                // S4: duplicate-free, and strictly increasing per sender
                assert.ok(!delivered[op.to].has(key), `S4: duplicate delivery of ${key}`);
                delivered[op.to].add(key);
                assert.ok(d.seq > lastSeq[op.to][d.senderIndex], `S4: seq went backwards for seat ${d.senderIndex}`);
                lastSeq[op.to][d.senderIndex] = d.seq;
                // S5: the bytes are what the sender sealed
                const origin = sent.find((x) => x.wire.senderIndex === d.senderIndex && x.wire.seq === d.seq);
                assert.ok(origin, `S5: delivered a message with no origin in the transcript`);
                assert.equal(TD.decode(d.plaintext), TD.decode(origin!.body), "S5: plaintext mismatch");
              }
            } else if (res.status !== "diverged") {
              // S3: any non-committing outcome leaves the receiver untouched
              const after = await fullBraidDigest(target, true);
              assert.equal(after, before, `S3: state moved on a '${res.status}' from ${op.k}`);
            }

            // S6: declared caps are never exceeded
            assert.ok(target.store.size <= BRAID_STORE_CAP, "S6: store cap exceeded");
            for (const [, perSeat] of target.held) {
              assert.ok(perSeat.size <= BRAID_HOLDBACK_CAP, "S6: holdback cap exceeded");
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  // SEEDED, not generated. Random op sequences explore breadth but reach the
  // deep reject paths only by luck: a frame must arrive exactly at nextSeq AND
  // name a frontier the receiver has fully integrated before its tag is ever
  // checked. This pins the narrow corridor directly, so S3 has power over the
  // path that matters most — the one where a rejected frame could evict an
  // honest seat by advancing its lane.
  it("S3 holds on the exact corridor where a reject reaches the tag check", async () => {
    for (const n of [2, 3, 4]) {
      const { states } = await makeCircle(n, 5);
      const sender = states[0];
      const receiver = states[1];

      // get the receiver caught up so the starvation gate is open
      const first = await braidSeal(sender, TE.encode("one"));
      const w1: BraidMessage = {
        attachment: undefined, senderIndex: sender.seatIndex, seq: first.seq, epochId: sender.epochId,
        confirm: first.confirm, frontier: first.frontier, ciphertext: first.ciphertext,
      };
      assert.equal((await braidOpen(receiver, w1)).status, "delivered", "precondition: caught up");

      const second = await braidSeal(sender, TE.encode("two"));
      const w2: BraidMessage = {
        attachment: undefined, senderIndex: sender.seatIndex, seq: second.seq, epochId: sender.epochId,
        confirm: second.confirm, frontier: second.frontier, ciphertext: second.ciphertext,
      };
      assert.equal(w2.seq, receiver.lanes[sender.seatIndex].nextSeq, "precondition: lands exactly at nextSeq");

      for (let byte = 0; byte < 4; byte++) {
        const ct = w2.ciphertext.slice();
        ct[byte % ct.length] ^= 0xff;
        const before = await fullBraidDigest(receiver, true);
        const res = await braidOpen(receiver, { ...w2, ciphertext: ct });
        assert.notEqual(res.status, "delivered", "a tampered frame must never deliver");
        assert.equal(
          (res as { reason?: string }).reason, "key mismatch: history diverged",
          "precondition: it really did reach the tag check",
        );
        assert.equal(await fullBraidDigest(receiver, true), before, "S3: a failed tag moved committed state");
      }

      // and the honest frame still lands: the rejects cost the sender nothing
      assert.equal((await braidOpen(receiver, w2)).status, "delivered", "the genuine frame still opens");
    }
  });

  it("seats that agree on a frontier agree on the model view (convergence)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 200 }),
        fc.array(fc.record({ seat: fc.nat(2), body: fc.nat(50) }), { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(200), { minLength: 0, maxLength: 40 }),
        async (seed, sends, order) => {
          const n = 3;
          const { states } = await makeCircle(n, seed);
          const wires: BraidMessage[] = [];
          for (const s of sends) {
            const st = states[s.seat];
            const sealed = await braidSeal(st, TE.encode(`b${s.body}`));
            wires.push({
              attachment: undefined, senderIndex: st.seatIndex, seq: sealed.seq, epochId: st.epochId,
              confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
            });
          }
          // deliver everything to everyone, in a generated order per receiver
          for (let to = 0; to < n; to++) {
            const perm = wires.map((_, i) => i).sort((a, b) => {
              const ka = order[a % Math.max(order.length, 1)] ?? a;
              const kb = order[b % Math.max(order.length, 1)] ?? b;
              return ka - kb || a - b;
            });
            for (const i of perm) {
              if (wires[i].senderIndex === states[to].seatIndex) continue;
              await braidOpen(states[to], wires[i]);
            }
          }
          // every seat that reached the same frontier must hold the same view:
          // the count model is commutative, so order must not matter.
          const byFrontier = new Map<string, string>();
          for (let i = 0; i < n; i++) {
            const key = Array.from(states[i].myFrontier).join(",");
            const view = toHex(await modelDigest(states[i].myView));
            const prior = byFrontier.get(key);
            if (prior !== undefined) {
              assert.equal(view, prior, `two seats at frontier ${key} disagree on the model view`);
            }
            byFrontier.set(key, view);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  // S7 LIVENESS. Every property above is a SAFETY property: nothing bad happens.
  // A protocol that rejects everything satisfies all of them. This is the dual:
  // with no adversary present, every honest message must reach every seat. It is
  // what catches a corruption on the COMMIT path — a chain byte quietly altered
  // after a successful open costs nothing immediately and silently kills every
  // later message from that seat.
  it("S7: with no tampering, every message reaches every seat", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.record({ seat: fc.nat(3), body: fc.nat(60) }), { minLength: 1, maxLength: 14 }),
        async (n, seed, rawSends) => {
          const { states } = await makeCircle(n, seed);
          const sends = rawSends.filter((x) => x.seat < n);
          if (sends.length === 0) return;

          const wires: BraidMessage[] = [];
          const bodies: string[] = [];
          for (const s of sends) {
            const st = states[s.seat];
            const text = `b${s.body}`;
            const sealed = await braidSeal(st, TE.encode(text));
            wires.push({
              attachment: undefined, senderIndex: st.seatIndex, seq: sealed.seq, epochId: st.epochId,
              confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
            });
            bodies.push(text);
          }

          for (let to = 0; to < n; to++) {
            const seen: string[] = [];
            // repeat until quiescent: holdback means one delivery can release many
            for (let pass = 0; pass < wires.length + 1; pass++) {
              let progressed = false;
              for (let i = 0; i < wires.length; i++) {
                if (wires[i].senderIndex === states[to].seatIndex) continue;
                const res = await braidOpen(states[to], wires[i]);
                if (res.status === "delivered") {
                  progressed = true;
                  for (const d of res.delivered) seen.push(TD.decode(d.plaintext));
                }
              }
              if (!progressed) break;
            }
            const expected = sends
              .map((x, i) => ({ seat: x.seat, body: bodies[i] }))
              .filter((x) => x.seat !== to)
              .map((x) => x.body)
              .sort();
            assert.deepEqual(
              seen.sort(), expected,
              `S7: seat ${to} did not receive every honest message`,
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("a diverged lane stays diverged and never delivers again", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (seed) => {
        const { states } = await makeCircle(3, seed);
        const [a, b] = states;
        const sealed = await braidSeal(a, TE.encode("x"));
        const wire: BraidMessage = {
          attachment: undefined, senderIndex: a.seatIndex, seq: sealed.seq, epochId: a.epochId,
          confirm: sealed.confirm, frontier: sealed.frontier, ciphertext: sealed.ciphertext,
        };
        // force divergence through the post-auth fault path
        b.lanes[a.seatIndex].diverged = true;
        const res = await braidOpen(b, wire);
        assert.equal(res.status, "ignored");
        assert.equal(braidStatus(b)[a.seatIndex].diverged, true, "divergence is absorbing");
      }),
      { numRuns: 20 },
    );
  });
});
