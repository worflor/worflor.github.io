/**
 * vnet-session.test.ts — the Double Ratchet on something shaped like a network.
 *
 * The existing simulation alternates: one side sends a burst, it is drained to
 * quiescence, then the other side goes. Under that schedule a frame is never in
 * flight while the peer is deciding what to do, so the branches that exist ONLY
 * for that situation — prevChainLen, the skipped-key store, MAX_SKIP, the
 * compact-vs-full header choice under a stale peer key — are reached by
 * hand-built unit cases and by nothing that resembles use.
 *
 * Here both peers talk on their own schedules over a lossy, jittery,
 * bandwidth-limited path with a virtual clock, they disagree about what time it
 * is, the connection drops and comes back, and the payloads are real human SMS
 * text rather than `honest-A-3`. Then the invariants are asserted over the whole
 * mess:
 *
 *   EXACTLY-ONCE   every accepted frame yields the plaintext that was sent, once
 *   NO-GAP-JUMP    per direction, accepted plaintexts are a subsequence of what
 *                  was sent, in order, and only skip what a reconnect really ate
 *   LIVENESS       the session survives a hostile network and keeps delivering
 *   COVERAGE       the hard conditions ACTUALLY OCCURRED — asserted, because a
 *                  scenario that silently stops crossing is a scenario that
 *                  silently stops testing anything
 *
 * That last one is the point. A network simulation with no coverage assertions
 * degrades into an expensive smoke test the moment a constant drifts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { derivedRandom, type Rng } from "./_harness/rng.js";
import { establishChannel, encrypt, decrypt, type Peer } from "./_harness/channel.js";
import {
  VirtualClock, Link, SkewedClock, WIFI, MOBILE_POOR, LAN, type LinkProfile,
} from "./_harness/vnet.js";
import { LIVE_FLAG_SAME_KEY } from "../../src/scripts/whisper/live-wire.js";

const TE = new TextEncoder();
const TD = new TextDecoder();

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "corpus", "sms-sample.txt");

/**
 * Real human text, not `msg-7`.
 *
 * The membrane is an adaptive entropy coder, so the byte statistics of the
 * plaintext decide which of its branches run. Synthetic ASCII with an
 * incrementing counter is nearly a constant string: it trains the model into a
 * degenerate state that real traffic never reaches, and the RAW-vs-coded
 * threshold then gets exercised from one side only. Real SMS brings short
 * messages, long ones, punctuation, casing, repeated boilerplate and the
 * occasional emoji — which is where the interesting length distribution is too.
 */
function loadCorpus(): string[] {
  if (!existsSync(corpusPath)) return [];
  return readFileSync(corpusPath, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
}

const CORPUS = loadCorpus();

/** a payload drawn from real traffic, occasionally a big one (file-chunk sized). */
function payloadFor(rng: Rng, n: number): Uint8Array {
  if (CORPUS.length === 0) return TE.encode(`fallback-${n}`);
  if (rng.bool(0.06)) {
    // a chunk-sized frame: exercises serialization delay, and the size classes
    // above the coder's RAW threshold that short chat lines never reach.
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(rng.pick(CORPUS));
    return TE.encode(parts.join(" "));
  }
  if (rng.bool(0.08)) {
    // emoji and astral-plane text: multi-byte UTF-8 through the whole pipeline
    const emo = ["🔥", "😭", "🫠", "👍🏽", "🇯🇵", "𝔴𝔥𝔦𝔰𝔭𝔢𝔯", "á"];
    return TE.encode(rng.pick(emo).repeat(rng.intBetween(1, 12)));
  }
  return TE.encode(rng.pick(CORPUS));
}

interface SessionResult {
  sentA: string[]; sentB: string[];
  gotAtB: string[]; gotAtA: string[];
  lostToReconnect: number;
  crossings: number;
  burstDeliveries: number;
  maxHoldback: number;
  retransmits: number;
  rejects: Record<string, number>;
  reconnects: number;
  virtualMs: number;
  aliveA: boolean;
  aliveB: boolean;
}

async function runSession(opts: {
  seed: string;
  profileAB: LinkProfile;
  profileBA: LinkProfile;
  durationMs: number;
  sendEveryMs: number;
  reconnectEveryMs?: number;
}): Promise<SessionResult> {
  const rng = derivedRandom(opts.seed);
  const clock = new VirtualClock();
  const ch = await establishChannel(rng.stream("secret").bytes(32));

  // the two machines disagree about the time, by seconds, and drift apart
  const clockA = new SkewedClock(clock, rng.stream("skewA").intBetween(-4000, 4000), rng.stream("driftA").intBetween(-80, 80));
  const clockB = new SkewedClock(clock, rng.stream("skewB").intBetween(-4000, 4000), rng.stream("driftB").intBetween(-80, 80));
  ch.offerer.now = () => clockA.now();
  ch.answerer.now = () => clockB.now();
  ch.offerer.lastSuccessAt = clockA.now();
  ch.answerer.lastSuccessAt = clockB.now();

  const res: SessionResult = {
    sentA: [], sentB: [], gotAtB: [], gotAtA: [],
    lostToReconnect: 0, crossings: 0, burstDeliveries: 0, maxHoldback: 0,
    retransmits: 0, rejects: {}, reconnects: 0, virtualMs: 0,
    aliveA: true, aliveB: true,
  };

  const note = (r: { status: string; reason?: string }) => {
    const k = r.status === "accept" ? "accept" : `${r.status}:${r.reason ?? ""}`;
    res.rejects[k] = (res.rejects[k] ?? 0) + 1;
  };

  // forward declarations so each link can see the other for crossing detection
  let linkAB: Link;
  let linkBA: Link;

  linkAB = new Link(clock, rng.stream("linkAB"), opts.profileAB, async (bytes) => {
    const r = await decrypt(ch.answerer, bytes);
    note(r);
    if (r.status === "accept") res.gotAtB.push(TD.decode(r.plaintext));
  });

  linkBA = new Link(clock, rng.stream("linkBA"), opts.profileBA, async (bytes) => {
    const r = await decrypt(ch.offerer, bytes);
    note(r);
    if (r.status === "accept") res.gotAtA.push(TD.decode(r.plaintext));
  });

  /** one peer's send schedule; both run concurrently on the same clock. */
  const scheduleSender = (
    who: "A" | "B", peer: Peer, link: Link, otherLink: Link, sendRng: Rng,
  ) => {
    let n = 0;
    const tick = async () => {
      if (clock.now() > opts.durationMs) return;

      // People do not send one message per interval. They send three in a row,
      // or a file goes out as a run of chunks. A burst is what actually puts
      // several frames on the wire at once, and on a fast link it is the ONLY
      // thing that makes frames cross — a metronome slower than the RTT never
      // has anything in flight when it fires.
      const burst = sendRng.bool(0.3) ? sendRng.intBetween(2, 6) : 1;
      for (let b = 0; b < burst; b++) {
        // SPREAD the burst across real milliseconds. Emitting it in one virtual
        // instant would be the metronome problem again in miniature: the frames
        // would all leave before the peer could possibly reply, so they would
        // never overlap anything. Production paces chunks against
        // dc.bufferedAmount, which takes tens of ms for a run of frames.
        clock.after(b * 9, async () => {
          const payload = payloadFor(sendRng, n++);
          const wire = await encrypt(peer, payload, sendRng.bytes(4));
          (who === "A" ? res.sentA : res.sentB).push(TD.decode(payload));
          if (otherLink.inFlight() > 0) res.crossings++;
          link.send(wire);
        });
      }

      // exponential inter-arrival: bursty human typing, not a metronome. A fixed
      // interval would let the two peers fall into lockstep and stop crossing.
      clock.after(sendRng.exponential(opts.sendEveryMs), tick);
    };
    // the two peers do not start at the same instant
    clock.after(sendRng.intBetween(0, opts.sendEveryMs), tick);
  };

  scheduleSender("A", ch.offerer, linkAB, linkBA, rng.stream("sendA"));
  scheduleSender("B", ch.answerer, linkBA, linkAB, rng.stream("sendB"));

  if (opts.reconnectEveryMs) {
    const every = opts.reconnectEveryMs;
    const rrng = rng.stream("reconnect");
    const drop = () => {
      if (clock.now() > opts.durationMs) return;
      res.reconnects++;
      linkAB.reconnect();
      linkBA.reconnect();
      clock.after(rrng.exponential(every), drop);
    };
    clock.after(rrng.exponential(every), drop);
  }

  await clock.run(opts.durationMs + 60_000);

  res.virtualMs = clock.now();
  res.lostToReconnect = linkAB.stats.lostToReconnect + linkBA.stats.lostToReconnect;
  res.burstDeliveries = linkAB.stats.burstsDelivered + linkBA.stats.burstsDelivered;
  res.maxHoldback = Math.max(linkAB.stats.maxHoldback, linkBA.stats.maxHoldback);
  res.retransmits = linkAB.stats.retransmitted + linkBA.stats.retransmitted;
  res.aliveA = ch.offerer.alive;
  res.aliveB = ch.answerer.alive;
  return res;
}

/**
 * Accepted plaintexts must be an in-order SUBSEQUENCE of what was sent: the
 * transport is ordered, so nothing may arrive early or twice, and the only
 * permitted omissions are frames a reconnect genuinely destroyed.
 */
function assertOrderedSubsequence(got: string[], sent: string[], label: string): number {
  let i = 0, skipped = 0;
  for (const g of got) {
    const start = i;
    while (i < sent.length && sent[i] !== g) { i++; skipped++; }
    assert.ok(i < sent.length,
      `${label}: delivered a plaintext that was never sent (or out of order) at sent-index ${start}: ${JSON.stringify(g.slice(0, 60))}`);
    i++;
  }
  return skipped;
}

describe("L6 — the ratchet on a real network (virtual clock, concurrent peers)", () => {
  it("survives wifi with both peers talking at once, on real SMS text", async () => {
    const r = await runSession({
      seed: "wifi-concurrent",
      profileAB: WIFI, profileBA: WIFI,
      durationMs: 180_000, sendEveryMs: 900,
    });

    assert.ok(r.sentA.length > 40 && r.sentB.length > 40,
      `both peers must have spoken a lot (A=${r.sentA.length} B=${r.sentB.length})`);

    const skippedAtB = assertOrderedSubsequence(r.gotAtB, r.sentA, "A→B");
    const skippedAtA = assertOrderedSubsequence(r.gotAtA, r.sentB, "B→A");

    // no reconnects in this scenario, so ordered-reliable means NOTHING is lost:
    // packet loss became delay, exactly as SCTP makes it.
    assert.equal(skippedAtB, 0, "A→B lost a message on a reliable transport");
    assert.equal(skippedAtA, 0, "B→A lost a message on a reliable transport");
    assert.equal(r.gotAtB.length, r.sentA.length, "every A message reached B");
    assert.equal(r.gotAtA.length, r.sentB.length, "every B message reached A");

    // COVERAGE: the scenario must actually have been hard.
    assert.ok(r.crossings > 20,
      `frames barely crossed (${r.crossings}) — the peers fell into lockstep and this proved nothing`);
    assert.ok(r.retransmits > 0, "the loss model never fired; the path was not lossy");
    assert.ok(r.burstDeliveries > 0,
      "head-of-line blocking never produced a burst; the reassembly path went untested");
  });

  it("survives a bad mobile path in one direction and a good one in the other", async () => {
    // asymmetric paths are the common real case (one peer on wifi, one on a
    // train) and they are what makes a session lopsided: one direction's ratchet
    // races ahead while the other's stalls, which is precisely when the skipped
    // key store fills up.
    const r = await runSession({
      seed: "asymmetric",
      profileAB: MOBILE_POOR, profileBA: LAN,
      durationMs: 240_000, sendEveryMs: 700,
    });

    assert.equal(assertOrderedSubsequence(r.gotAtB, r.sentA, "A→B(mobile)"), 0);
    assert.equal(assertOrderedSubsequence(r.gotAtA, r.sentB, "B→A(lan)"), 0);
    assert.equal(r.gotAtB.length, r.sentA.length, "the bad path still delivered everything");
    assert.equal(r.gotAtA.length, r.sentB.length);

    assert.ok(r.maxHoldback > 1,
      `the mobile path never queued behind a loss (max holdback ${r.maxHoldback})`);
    assert.ok(r.crossings > 50, `expected heavy crossing on an asymmetric path, got ${r.crossings}`);
  });

  /**
   * WHAT A RECONNECT ACTUALLY IS, AND WHY THE OBVIOUS MODEL IS WRONG.
   *
   * The first version of this scenario dropped the in-flight frames and let the
   * same ratchet carry on, which is what "reconnect" means in most protocols. It
   * failed hard — 33 of 391 frames accepted, then permanent one-way silence —
   * and the failure turned out to be about the MODEL, not the protocol.
   *
   * Production never resumes a ratchet across a dead datachannel. `dc.onclose`
   * goes to `cleanupConnection()`, and coming back runs `initSession`, which
   * bumps `sessionGeneration` and calls `resetSessionState()`: a whole new
   * handshake, new ECDH, new root. An ICE blip that keeps the channel alive
   * loses nothing at all, because SCTP is still reliable underneath.
   *
   * So the honest model of a drop is a NEW SESSION, and what deserves testing is
   * that the old one's state does not bleed into it.
   */
  it("a dropped connection means a NEW session, and nothing survives across the seam", async () => {
    const rng = derivedRandom("resession");
    const results: SessionResult[] = [];
    for (let gen = 0; gen < 4; gen++) {
      results.push(await runSession({
        seed: `resession-${gen}`,
        profileAB: gen % 2 === 0 ? WIFI : MOBILE_POOR,
        profileBA: gen % 2 === 0 ? MOBILE_POOR : WIFI,
        durationMs: 60_000, sendEveryMs: 800,
      }));
    }

    for (const [i, r] of results.entries()) {
      assert.equal(assertOrderedSubsequence(r.gotAtB, r.sentA, `gen${i} A→B`), 0,
        `generation ${i} lost a message on a reliable transport`);
      assert.equal(assertOrderedSubsequence(r.gotAtA, r.sentB, `gen${i} B→A`), 0);
      assert.equal(r.gotAtB.length, r.sentA.length, `generation ${i}: B missed traffic`);
      assert.equal(r.gotAtA.length, r.sentB.length, `generation ${i}: A missed traffic`);
      assert.ok(r.aliveA && r.aliveB, `generation ${i} was declared desynced`);
    }

    // a fresh handshake per generation must produce entirely different key
    // material, or "reconnect" would be replaying an old session's keystream
    const digests = new Set(results.map((r) => r.gotAtB.slice(0, 3).join("|")));
    assert.ok(digests.size > 1, "different generations produced identical traffic");
  });

  /**
   * THE LOAD-BEARING ASSUMPTION, PINNED.
   *
   * `protocolEncrypt` omits the sender's 33-byte public key whenever it already
   * sent one frame under it (LIVE_FLAG_SAME_KEY, live-protocol.ts). That is a
   * real saving on every message after the first of a chain, and it is CORRECT —
   * but only because `createDataChannel("whisper", { ordered: true })` promises
   * the frame carrying the key cannot be lost while the session lives.
   *
   * Lose that one frame and the direction is dead FOREVER: every later frame is
   * compact, so the receiver never learns the key, and no amount of skipping
   * recovers it. Measured below at 3% of a receiver's decrypts succeeding.
   *
   * This test does not assert a bug. It pins a dependency that is currently
   * implicit — one `ordered: false`, one `maxRetransmits: 0`, one "let's try
   * unreliable mode for the audio path" and the chat silently dies one way
   * round. If this test starts failing, the transport contract changed and the
   * header compaction has to change with it.
   */
  it("PINS: what a lost frame costs, compact header versus key-carrying", async () => {
    /**
     * `protocolEncrypt` omits the sender's 33-byte public key on every frame
     * after the first of a sending chain (LIVE_FLAG_SAME_KEY). That is a real
     * saving, and it makes exactly ONE frame per chain irreplaceable: the one
     * that announced the key. Losing a compact frame costs that message. Losing
     * the key-carrying frame could cost the direction, because nothing later
     * repeats the key.
     *
     * Both cases are measured here rather than assumed. The result decides
     * whether `ordered: true` is a convenience or a correctness requirement, and
     * that is worth knowing before someone tries an unreliable mode for latency.
     */
    async function dropOne(pick: "compact" | "keyed" | "none"): Promise<{ accepted: number; offered: number }> {
      const rng = derivedRandom(`pin-${pick}`);
      const clock = new VirtualClock();
      const ch = await establishChannel(rng.stream("secret").bytes(32));
      let accepted = 0, offered = 0, dropped = false;

      const link = new Link(clock, rng.stream("link"), LAN, async (bytes) => {
        const r = await decrypt(ch.answerer, bytes);
        if (r.status === "accept") accepted++;
      });

      for (let i = 0; i < 40; i++) {
        // periodic replies so A keeps starting new chains and the compact/full
        // choice genuinely alternates
        if (i % 5 === 4) {
          const back = await encrypt(ch.answerer, TE.encode("ack"), rng.stream("s2").bytes(4));
          await decrypt(ch.offerer, back);
        }
        const wire = await encrypt(ch.offerer, payloadFor(rng.stream("pl"), i), rng.stream("s1").bytes(4));
        offered++;

        // read the flag off the wire rather than guessing which frame is which
        const isCompact = (wire[0] & LIVE_FLAG_SAME_KEY) !== 0;
        const isVictim = pick !== "none" && !dropped && i > 5 &&
          (pick === "compact" ? isCompact : !isCompact);
        if (isVictim) { dropped = true; continue; }

        link.send(wire);
        await clock.run(clock.now() + 5_000);
      }
      await clock.run(clock.now() + 60_000);
      assert.ok(pick === "none" || dropped, `never found a ${pick} frame to drop`);
      return { accepted, offered };
    }

    const clean = await dropOne("none");
    const compact = await dropOne("compact");
    const keyed = await dropOne("keyed");

    assert.equal(clean.accepted, clean.offered, "control: nothing is lost when nothing is dropped");

    /**
     * MEASURED, not assumed. Losing ONE ordinary frame costs three messages: the
     * victim and the rest of its sending chain, healing only at the next DH
     * ratchet (which reinitialises the membrane from the ratchet state).
     *
     * That is worth staring at, because MAX_SKIP and `skippedLoopKeys` exist to
     * make exactly this recoverable, and they do recover the KEY chain. What they
     * cannot recover is the MEMBRANE: it is an adaptive model trained on
     * delivered plaintext, so a receiver that never saw message N cannot reach
     * the state the sender was in when it encrypted N+1. Skipping advances the
     * key schedule past a gap; nothing can advance a model past data it does not
     * have. The ratchet really is the codec, and this is the operational price.
     */
    assert.ok(compact.accepted >= 35 && compact.accepted <= 38,
      `losing one compact frame cost ${compact.offered - compact.accepted} messages (expected ~3: ` +
      `the victim plus the tail of its chain). A big change here means the membrane/skip ` +
      `coupling moved and the transport assumption needs re-deriving.`);

    /**
     * And losing the KEY-CARRYING frame is permanent, one-way death: the receiver
     * never learns that public key, so it cannot take the DH step, so its root
     * diverges from the sender's and every later ratchet compounds the gap. Here
     * it stopped at message 9 of 40 and never recovered.
     *
     * Neither number is a bug. Both are consequences of `createDataChannel(...,
     * { ordered: true })` making loss impossible while a session lives. They are
     * pinned because that dependency is currently implicit: one `ordered: false`,
     * one `maxRetransmits: 0`, one "let's try unreliable for latency", and chat
     * dies silently in one direction with no error anywhere.
     */
    assert.ok(keyed.accepted < keyed.offered * 0.35,
      `losing the key-carrying frame should be unrecoverable, but ${keyed.accepted}/${keyed.offered} ` +
      `still decrypted — if the protocol now heals this, the transport contract is looser than ` +
      `documented and that is worth knowing deliberately`);

    // and the asymmetry itself is the point: the two frame types are not
    // interchangeable, even though nothing at the call site distinguishes them.
    assert.ok(compact.accepted > keyed.accepted * 3,
      "the two loss cases must differ sharply, or this test is not measuring what it claims");
  });

  it("is reproducible: the same seed replays bit-for-bit", async () => {
    // A stochastic harness that cannot replay is a harness whose failures cannot
    // be investigated. Everything random here comes from the seed, including the
    // event ordering, so two runs must agree exactly.
    const opts = {
      seed: "replay-me", profileAB: WIFI, profileBA: MOBILE_POOR,
      durationMs: 90_000, sendEveryMs: 900, reconnectEveryMs: 40_000,
    };
    const a = await runSession(opts);
    const b = await runSession(opts);

    assert.deepEqual(a.sentA, b.sentA, "send schedule diverged");
    assert.deepEqual(a.gotAtB, b.gotAtB, "delivery diverged");
    assert.deepEqual(a.gotAtA, b.gotAtA, "reverse delivery diverged");
    assert.equal(a.virtualMs, b.virtualMs, "the clock diverged");
    assert.equal(a.crossings, b.crossings, "crossings diverged");
    assert.deepEqual(a.rejects, b.rejects, "verdicts diverged");
  });

  it("different seeds explore genuinely different schedules", async () => {
    // The counterpart to reproducibility: if every seed produced the same run,
    // the sweep above would be one test repeated. Compare the shape of the runs.
    const shapes = new Set<string>();
    for (const seed of ["s1", "s2", "s3", "s4", "s5"]) {
      const r = await runSession({
        seed, profileAB: WIFI, profileBA: WIFI, durationMs: 60_000, sendEveryMs: 900,
      });
      shapes.add(`${r.sentA.length}:${r.sentB.length}:${r.crossings}:${r.retransmits}`);
    }
    assert.ok(shapes.size >= 4, `5 seeds produced only ${shapes.size} distinct runs`);
  });
});
