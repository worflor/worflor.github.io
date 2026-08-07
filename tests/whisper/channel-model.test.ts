/**
 * L2 (b) — model-based testing of the real Whisper Live message protocol.
 *
 * Whisper is strictly in-order (the membrane binds each message key to the
 * plaintext history via modelDigest, and it runs over reliable/ordered SCTP), so
 * the model is a per-direction FIFO, and the interesting adversary is INJECTION:
 * replays and tampered copies that must be rejected without disturbing the
 * honest stream. fast-check generates random interleavings of Send / DeliverNext
 * (both directions, driving DH ratchets) / Replay / Tamper against the real
 * protocolEncrypt/protocolDecrypt (the exact functions live.ts runs).
 *
 * Invariants per command:
 *  - DeliverNext (in order): accept + decrypted bytes equal the sent plaintext.
 *  - Replay / Tamper: reject-auth, no plaintext, and state-neutral (the ratchet
 *    fingerprint is unchanged — clone-and-discard), so the honest stream survives.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { assertBytesEqual } from "./_helpers/assertions.js";
import { randomBytes } from "./_helpers/generators.js";
import { establishChannel, encrypt, decrypt, fullStateDigest, type DuplexChannel, type Peer } from "./_harness/channel.js";

const TE = new TextEncoder();
type Dir = "A" | "B";

function plaintextFor(dir: Dir, n: number, seed: number): Uint8Array {
  return TE.encode(`${dir}|${n}|${seed}|` + "x".repeat(n % 41));
}
function salt4(): Uint8Array {
  return randomBytes(4);
}

interface Framed {
  pt: Uint8Array;
  wire: Uint8Array;
}

class Model {
  queues: Record<Dir, Framed[]> = { A: [], B: [] }; // undelivered, in send order
  lastDelivered: Record<Dir, Uint8Array | null> = { A: null, B: null };
  counts: Record<Dir, number> = { A: 0, B: 0 };
}

type Real = DuplexChannel;

function senderOf(r: Real, dir: Dir): Peer {
  return dir === "A" ? r.offerer : r.answerer;
}
function receiverOf(r: Real, dir: Dir): Peer {
  return dir === "A" ? r.answerer : r.offerer;
}

class SendCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly dir: Dir, readonly seed: number) {}
  check(m: Model): boolean {
    return m.queues[this.dir].length < 100;
  }
  async run(m: Model, r: Real): Promise<void> {
    const n = m.counts[this.dir]++;
    const pt = plaintextFor(this.dir, n, this.seed);
    const wire = await encrypt(senderOf(r, this.dir), pt, salt4());
    m.queues[this.dir].push({ pt, wire });
  }
  toString(): string {
    return `Send(${this.dir},${this.seed})`;
  }
}

class DeliverNextCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly dir: Dir) {}
  check(m: Model): boolean {
    return m.queues[this.dir].length > 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    const head = m.queues[this.dir].shift()!;
    const res = await decrypt(receiverOf(r, this.dir), head.wire);
    assert.equal(res.status, "accept", `in-order deliver ${this.dir} must accept`);
    if (res.status === "accept") assertBytesEqual(res.plaintext, head.pt, `plaintext oracle ${this.dir}`);
    m.lastDelivered[this.dir] = head.wire;
  }
  toString(): string {
    return `DeliverNext(${this.dir})`;
  }
}

class ReplayCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly dir: Dir) {}
  check(m: Model): boolean {
    return m.lastDelivered[this.dir] !== null;
  }
  async run(m: Model, r: Real): Promise<void> {
    const recv = receiverOf(r, this.dir);
    const fp = fullStateDigest(recv.state); // FULL state: ratchet+secrets+membrane+skipped+counters
    const res = await decrypt(recv, m.lastDelivered[this.dir]!);
    assert.equal(res.status, "reject-auth", `replay ${this.dir} must fail auth`);
    assert.ok(!("plaintext" in res), "replay must not surface plaintext");
    assert.equal(fullStateDigest(recv.state), fp, `replay ${this.dir} must be state-neutral (full state)`);
  }
  toString(): string {
    return `Replay(${this.dir})`;
  }
}

class TamperCmd implements fc.AsyncCommand<Model, Real> {
  constructor(readonly dir: Dir) {}
  check(m: Model): boolean {
    return m.queues[this.dir].length > 0;
  }
  async run(m: Model, r: Real): Promise<void> {
    const head = m.queues[this.dir][0]; // peek — leave it for a later genuine delivery
    const tampered = head.wire.slice();
    tampered[tampered.length - 1] ^= 0x01; // flip a ciphertext/tag bit
    const recv = receiverOf(r, this.dir);
    const fp = fullStateDigest(recv.state); // FULL state, not just the ratchet fingerprint
    const res = await decrypt(recv, tampered);
    assert.equal(res.status, "reject-auth", `tamper ${this.dir} must fail auth`);
    assert.ok(!("plaintext" in res), "tamper must not surface plaintext");
    assert.equal(fullStateDigest(recv.state), fp, `tamper ${this.dir} must be state-neutral (full state)`);
  }
  toString(): string {
    return `Tamper(${this.dir})`;
  }
}

describe("live-protocol — L2 model-based (in-order + injection)", () => {
  it("random in-order bidirectional sessions with injected replays/tampers match the model", async () => {
    const dir = fc.constantFrom<Dir>("A", "B");
    const commands = [
      fc.tuple(dir, fc.nat(1_000_000)).map(([d, s]) => new SendCmd(d, s)),
      dir.map((d) => new DeliverNextCmd(d)),
      dir.map((d) => new ReplayCmd(d)),
      dir.map((d) => new TamperCmd(d)),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 160, size: "+1" }), async (cmds) => {
        const setup = async () => ({ model: new Model(), real: await establishChannel(randomBytes(32)) });
        await fc.asyncModelRun(setup, cmds);
      }),
      { numRuns: 100 },
    );
  });
});
