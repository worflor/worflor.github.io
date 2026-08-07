/**
 * L4 (b) — stateful, structure-aware injection against the FULL protocolDecrypt.
 *
 * The fresh-eyes review's #1 gap: every fuzz/property target hit pure parsers,
 * so the stateful transform's adversarial branches (DH-ratchet-before-auth,
 * prevChainLen lies, counter jumps past MAX_SKIP, compact-vs-full confusion) were
 * reached only by honest frames and single-bit tampers. This drives a real
 * ProtocolState with a semantically-aware attacker that builds hostile frames
 * FROM the receiver's public state (see _harness/adversary.ts).
 *
 * Security invariants on EVERY injected frame (attacker holds no session key):
 *   - never `accept`
 *   - never surfaces plaintext
 *   - decrypt stays total: it RETURNS an outcome and never escapes by exception
 *     (checked via DecryptResult.threw — the harness records the distinction now
 *     instead of laundering a crash into an ordinary rejection)
 *   - FULL-state-neutral: the receiver's committed state (ratchet + secret keys +
 *     membrane + skipped keys + counters) is byte-identical before/after. NOTE
 *     this is guaranteed by the caller's clone-and-commit, not by the transform,
 *     so it is a guard on commit discipline rather than a test of protocolDecrypt.
 *   - the receiver is still ALIVE: live.ts counts consecutive decrypt failures
 *     outside ProtocolState and tears down at three, so that counter — not the
 *     ratchet — is what an injection attack can actually move.
 * Honest messages are interleaved throughout and must keep delivering, which is
 * the F1 invariant in its strongest form: no injected frame can end the session,
 * because every honest frame in between resets the counter.
 * It also asserts coverage: every adversary kind was actually generated + rejected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivedRandom } from "./_harness/rng.js";
import {
  establishChannel, encrypt, decrypt, fullStateDigest,
  DESYNC_MIN_FAILURES, DESYNC_GRACE_MS,
  type DuplexChannel, type Peer,
} from "./_harness/channel.js";
import { buildHostile, ALL_KINDS, type AdversaryKind } from "./_harness/adversary.js";
import { craftAuthenticated } from "./_harness/channel.js";

const TE = new TextEncoder();

async function bootstrap(ch: DuplexChannel): Promise<Uint8Array[]> {
  // deliver one honest full-header message each way so both receivers have a
  // cached peer key (real ordered-transport baseline) and a DH ratchet has fired.
  const wires: Uint8Array[] = [];
  const w0 = await encrypt(ch.offerer, TE.encode("hello-0"), new Uint8Array([1, 2, 3, 4]));
  await decrypt(ch.answerer, w0);
  wires.push(w0);
  const w1 = await encrypt(ch.answerer, TE.encode("hello-1"), new Uint8Array([5, 6, 7, 8]));
  await decrypt(ch.offerer, w1);
  wires.push(w1);
  return wires;
}

describe("L4b — stateful protocolDecrypt injection", () => {
  it("hostile frames of every kind are rejected, leak nothing, and never mutate committed state", async () => {
    const kindsSeen: Record<string, number> = {};
    let total = 0;

    for (let seed = 1; seed <= 30; seed++) {
      const rng = derivedRandom(seed * 2654435761);
      const ch = await establishChannel(rng.stream("secret").bytes(32));
      const priorWires = await bootstrap(ch);

      // a mixed honest + hostile stream; hostile frames target both receivers.
      let nextOfferer = 2; // continue honest counters past bootstrap
      let nextAnswerer = 2;
      for (let step = 0; step < 40; step++) {
        const er = rng.at("step", step);
        // ~55% of steps inject a hostile frame at a chosen receiver
        if (er.bool(0.55)) {
          const targetOfferer = er.bool();
          const recv: Peer = targetOfferer ? ch.offerer : ch.answerer;
          const kind: AdversaryKind = er.pick(ALL_KINDS);
          const wire = await buildHostile(kind, recv, er.fork("hostile"), priorWires);

          const before = fullStateDigest(recv.state);
          let res: Awaited<ReturnType<typeof decrypt>>;
          try {
            res = await decrypt(recv, wire);
          } catch (e) {
            assert.fail(`decrypt threw (totality violated) on ${kind}: ${(e as Error).message}`);
          }
          const after = fullStateDigest(recv.state);

          assert.notEqual(res.status, "accept", `hostile ${kind} must never be accepted`);
          assert.ok(!("plaintext" in res), `hostile ${kind} must not surface plaintext`);

          // State neutrality is real, and it is provided by clone-and-commit in
          // the caller rather than by anything protocolDecrypt does — the
          // transform is documented to leave `s` partially advanced on failure.
          // So this assertion holds identically whatever the transform does, and
          // it is kept only as a regression guard on the COMMIT discipline.
          assert.equal(after, before, `hostile ${kind} must not mutate committed state (full digest)`);

          // The assertions that can actually fail. `threw` distinguishes a
          // rejection the protocol decided from one it escaped by exception:
          // the harness used to convert the second into the first, which made
          // "decrypt stays total" unfalsifiable while it was being violated on
          // roughly half of all tampered headers.
          assert.ok(!res.threw, `hostile ${kind} escaped by exception rather than being rejected`);

          // And the state the attack actually targets: the caller's consecutive
          // failure counter, which live.ts tears the session down on. Committed
          // ProtocolState is not reachable by a rejected frame, but this is.
          assert.ok(recv.alive,
            `hostile ${kind} ended the session — F1 in the form that matters`);
          kindsSeen[kind] = (kindsSeen[kind] ?? 0) + 1;
          total++;
        } else {
          // an honest in-order message keeps the session live (and grows priorWires)
          const fromOfferer = er.bool();
          const from = fromOfferer ? ch.offerer : ch.answerer;
          const to = fromOfferer ? ch.answerer : ch.offerer;
          const n = fromOfferer ? nextOfferer++ : nextAnswerer++;
          const pt = TE.encode(`honest-${fromOfferer ? "A" : "B"}-${n}`);
          const wire = await encrypt(from, pt, er.bytes(4));
          const res = await decrypt(to, wire);
          assert.equal(res.status, "accept", `honest message ${n} must still deliver`);
          if (res.status === "accept") {
            assert.deepEqual(Array.from(res.plaintext), Array.from(pt), "honest plaintext intact");
            priorWires.push(wire);
          }
        }
      }
    }

    // coverage: every adversary kind was actually generated and rejected
    for (const kind of ALL_KINDS) {
      assert.ok((kindsSeen[kind] ?? 0) > 0, `adversary kind '${kind}' was never exercised`);
    }
    assert.ok(total > 100, `expected many injections, got ${total}`);
  });

  /**
   * A SECOND THREAT MODEL: a peer that holds the keys and misuses them.
   *
   * Everything above assumes an outsider, and an outsider's frames die at the
   * AEAD tag. That leaves the guards AFTER authentication completely unreached:
   * `payload too short`, `decodedLen exceeds safety limit`, `no receiving loop
   * state after step`. They exist for input that IS authentic and still hostile,
   * which is what you get from a peer running modified software, or an honest
   * peer with a bug, and nothing in the suite produced one.
   *
   * These frames carry a real tag under the real key, so they prove something the
   * outsider tests cannot: that authentication is not treated as permission. A
   * frame being genuinely from the peer says nothing about whether its contents
   * are sane, and the length fields inside it are still attacker-chosen.
   */
  describe("a keyed but malicious peer reaches the post-authentication guards", () => {
    async function sendCrafted(payload: Uint8Array) {
      const ch = await establishChannel(derivedRandom("crafted").stream("s").bytes(32));
      await bootstrap(ch);
      const before = fullStateDigest(ch.answerer.state);
      const wire = await craftAuthenticated(ch.offerer, payload, new Uint8Array([9, 9, 9, 9]));
      const res = await decrypt(ch.answerer, wire);
      return { res, before, after: fullStateDigest(ch.answerer.state), peer: ch.answerer };
    }

    it("an authentic frame with a truncated payload is refused, not parsed", async () => {
      // fewer than the 4 bytes the decodedLen prefix needs. reading it anyway
      // would be an out-of-bounds read on data that passed authentication, which
      // is exactly when a reader is most likely to trust it.
      for (const len of [0, 1, 2, 3]) {
        const { res } = await sendCrafted(new Uint8Array(len));
        assert.notEqual(res.status, "accept", `a ${len}-byte authentic payload must not be accepted`);
        assert.match((res as { reason: string }).reason, /payload too short/,
          `a ${len}-byte payload must be diagnosed as short, not as an auth failure`);
      }
    });

    it("an authentic frame claiming a 4GB decode is refused before allocating", async () => {
      // the decodedLen bomb. the field is 4 bytes of attacker-chosen length and
      // the decoder would allocate it; the cap is the only thing between a
      // compromised peer and the receiver's memory.
      const payload = new Uint8Array(64);
      new DataView(payload.buffer).setUint32(0, 0xFFFFFFFF, true);
      const { res, before, after } = await sendCrafted(payload);
      assert.notEqual(res.status, "accept");
      assert.match((res as { reason: string }).reason, /decodedLen exceeds safety limit/);
      assert.equal(after, before, "and the refusal left committed state untouched");
    });

    it("the cap is a boundary: one byte over is refused by the cap itself", async () => {
      const MAX = 8 * 1024 * 1024; // matches MAX_DECODED_LEN
      const payload = new Uint8Array(64);
      new DataView(payload.buffer).setUint32(0, MAX + 1, true);
      const { res } = await sendCrafted(payload);
      assert.notEqual(res.status, "accept");
      assert.match((res as { reason: string }).reason, /exceeds safety limit/,
        "MAX+1 must be stopped by the cap, not by something downstream");
    });

    it("MEASURED: the cap is the only bound on decode amplification, and it is loose", async () => {
      /**
       * A frame that authenticates carries a 4-byte attacker-chosen decodedLen,
       * and the decoder will produce that many bytes from whatever follows. So a
       * compromised peer trades a tiny frame for a large allocation and a large
       * amount of BLOCKING cpu, since the decode is synchronous and there is no
       * event loop underneath it to keep a UI alive.
       *
       * Measured on this harness from a 110-byte frame:
       *     claimed 64KB ->  15ms   (   596x)
       *     claimed  1MB -> 134ms   (  9533x)
       *     claimed  4MB -> 535ms   ( 38130x)
       * roughly linear in the claim. At the former 64MB cap that implied about
       * eight seconds of frozen main thread per frame, and a libFuzzer timeout
       * found exactly that as a six-second single input.
       *
       * MAX_DECODED_LEN is now 8MB, sized to the largest legitimate payload (a
       * 4MB file chunk) with a factor of two of headroom, which cuts the worst
       * case by 8x with no effect on honest traffic. This test pins the cost so
       * the bound stays tied to the traffic rather than drifting back to a round
       * number.
       */
      const claim = 1 << 20; // 1MB: big enough to measure, small enough for CI
      const payload = new Uint8Array(48);
      new DataView(payload.buffer).setUint32(0, claim, true);

      const ch = await establishChannel(derivedRandom("amp").stream("s").bytes(32));
      await bootstrap(ch);
      const wire = await craftAuthenticated(ch.offerer, payload, new Uint8Array([1, 2, 3, 4]));

      const started = Date.now();
      const res = await decrypt(ch.answerer, wire);
      const elapsed = Date.now() - started;

      assert.ok(!res.threw, "a large claimed decode must not escape by exception");
      assert.ok(claim / wire.length > 1000,
        `expected large amplification from a ${wire.length}B frame, got ${(claim / wire.length).toFixed(0)}x`);
      // a generous ceiling: this is a regression tripwire on decode cost, not a
      // benchmark. if 1MB ever takes seconds, the cap needs revisiting urgently.
      assert.ok(elapsed < 10_000,
        `decoding a claimed 1MB took ${elapsed}ms; at the 64MB cap that is a frozen session`);
    });

    it("an authentic frame whose coder stream is garbage fails without throwing", async () => {
      // survives the tag, survives the length checks, and is nonsense to the
      // decoder. totality has to hold here too, and this is the only way to get
      // hostile bytes past authentication to find out.
      const rng = derivedRandom("coder-garbage");
      for (let i = 0; i < 12; i++) {
        const payload = rng.at("p", i).bytes(40);
        new DataView(payload.buffer).setUint32(0, rng.at("len", i).intBetween(1, 4096), true);
        const { res, before, after } = await sendCrafted(payload);
        assert.ok(!res.threw, `iteration ${i} escaped by exception rather than being rejected`);
        assert.equal(after, before, `iteration ${i} moved committed state`);
      }
    });
  });

  /**
   * THE TEARDOWN RULE, FROM BOTH SIDES.
   *
   * The `alive` assertion in the sweep above is only worth anything if teardown
   * is reachable at all — an unreachable teardown makes "no injection ended the
   * session" true for the same reason that a machine with no off switch is never
   * switched off. These three pin the rule from both directions: it fires when a
   * session is genuinely dead, and it does not fire for either witness alone.
   */
  describe("desync teardown needs two witnesses", () => {
    async function freshPeers(seed: string) {
      const rng = derivedRandom(seed);
      const ch = await establishChannel(rng.stream("secret").bytes(32));
      await bootstrap(ch);
      let clock = 1_000_000;
      for (const p of [ch.offerer, ch.answerer]) {
        p.now = () => clock;
        p.lastSuccessAt = clock;
      }
      return { ch, rng, tick: (ms: number) => { clock += ms; } };
    }

    it("FIRES for a genuinely desynced session: many failures and nothing delivered", async () => {
      const { ch, rng, tick } = await freshPeers("desync-positive");
      // a desynced peer's frames all fail forever. simulate that literally.
      for (let i = 0; i < DESYNC_MIN_FAILURES + 2; i++) {
        const wire = await buildHostile("garbage", ch.offerer, rng.at("g", i), []);
        const res = await decrypt(ch.offerer, wire);
        assert.notEqual(res.status, "accept");
        tick(DESYNC_GRACE_MS / 4); // time passes with nothing ever delivering
      }
      assert.equal(ch.offerer.alive, false,
        "a session that has delivered nothing for a long time must be declared dead");
    });

    it("does NOT fire on a burst: many failures inside a healthy moment", async () => {
      const { ch, rng } = await freshPeers("desync-burst");
      for (let i = 0; i < DESYNC_MIN_FAILURES * 4; i++) {
        const wire = await buildHostile("garbage", ch.offerer, rng.at("b", i), []);
        assert.notEqual((await decrypt(ch.offerer, wire)).status, "accept");
      }
      assert.ok(ch.offerer.failures >= DESYNC_MIN_FAILURES, "the counter witness is satisfied");
      assert.equal(ch.offerer.alive, true,
        "but no time passed, so the session is plainly healthy and must survive");
    });

    it("does NOT fire when honest traffic keeps flowing between failures", async () => {
      const { ch, rng, tick } = await freshPeers("desync-interleaved");
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < DESYNC_MIN_FAILURES - 1; i++) {
          const wire = await buildHostile("garbage", ch.answerer, rng.at(`i${round}`, i), []);
          assert.notEqual((await decrypt(ch.answerer, wire)).status, "accept");
          tick(DESYNC_GRACE_MS);   // plenty of time; the counter is what saves us
        }
        const pt = TE.encode(`honest-round-${round}`);
        const wire = await encrypt(ch.offerer, pt, rng.at("h", round).bytes(4));
        assert.equal((await decrypt(ch.answerer, wire)).status, "accept",
          "the session is still working, which is exactly the point");
      }
      assert.equal(ch.answerer.alive, true,
        "an attacker who cannot suppress honest traffic can never satisfy both witnesses");
    });
  });
});
