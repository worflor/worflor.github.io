/**
 * Deterministic simulator for the REAL Whisper Live message protocol
 * (live-protocol.ts, the exact functions live.ts drives).
 *
 * Whisper runs over reliable, ordered SCTP DataChannels and binds each message
 * key to the plaintext history (membrane modelDigest), so it is STRICTLY IN
 * ORDER — there is no drop/reorder tolerance to simulate (a lost message desyncs
 * by design, caught by AEAD). The realistic adversary is therefore INJECTION: an
 * on-path/malicious party splicing tampered or malformed frames into the stream.
 *
 * One seed (random-access derived randomness) drives the whole run, so it is
 * reproducible. The simulator delivers every honest frame in order and, around
 * each, may inject a tampered copy or random garbage. It asserts:
 *   S1 no plaintext on any non-accept (the #1 E2EE invariant)
 *   S2 an injected (tampered/garbage) frame is NEVER accepted
 *   S3 an accepted honest frame decrypts to exactly what was sent (oracle)
 *   S4 no honest frame is accepted more than once
 *   S5 decrypt is total on adversarial input (never escapes by exception)
 *   S6 injections interleaved with honest traffic never end the session
 *   L  liveness: every honest in-order frame IS accepted (no silent desync)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { derivedRandom, type Rng } from "./rng.js";
import { TEST_EMOJIS } from "../_helpers/generators.js";
import {
  establishChannel, encrypt, decrypt, assertClocksWereLive,
  type DuplexChannel, type Peer,
} from "./channel.js";
import { generateDHKeyPair, setDHKeyPairSource, resetDHKeyPairSource } from "../../../src/scripts/whisper/live-ratchet.js";
import { buildHeader, HEADER_SIZE } from "../../../src/scripts/whisper/live-wire.js";
import { makeSeededKeyPairSource } from "./seeded-keys.js";

type KeyPair = Awaited<ReturnType<typeof generateDHKeyPair>>;
import { MAX_SKIP } from "../../../src/scripts/whisper/live-ratchet.js";

const TE = new TextEncoder();
const TD = new TextDecoder();

export interface SimConfig {
  seed: number;
  steps: number;
  injectProb?: number; // chance of an adversarial injection around a step
  garbageProb?: number; // of injections, the fraction that are random garbage (vs tampered copies)
  burstMax?: number; // max consecutive sends from one direction before delivery (in-order)
}

export interface SimResult {
  seed: number;
  sent: number;
  accepted: number;
  injections: number;
  injectionsRejected: number;
  injectionKinds: Record<string, number>; // tampered / garbage / replay / hostile-valid
  directionChanges: number;
  rejects: Record<string, number>;
  verdictTrace: string[];
  livenessOk: boolean; // every honest frame accepted exactly once
  wireDigest: string; // FNV of every honest wire's bytes — a bit-exact determinism probe
}

interface LedgerEntry {
  id: number;
  sender: "A" | "B";
  plaintext: Uint8Array;
  accepted: number;
}

/**
 * REAL TRAFFIC, not `A#3:~~~~`.
 *
 * The membrane is an adaptive entropy coder, so the plaintext's byte statistics
 * decide which of its branches run. The old generator emitted short pure-ASCII
 * strings that were mostly one repeated character, which trains the model into a
 * degenerate state real traffic never reaches and crosses the RAW-vs-coded
 * threshold from one side only. It is also, for a compression-coupled ratchet,
 * close to a best case: highly predictable input keeps the coder in its easiest
 * regime for every single message of every single run.
 *
 * So: real human SMS (the vendored UCI sample, already in the repo and already
 * licensed), plus the emoji fixtures that were sitting unused in generators.ts,
 * plus occasional long messages that clear the size classes short chat lines
 * never reach. Selection is driven by the seeded rng, so runs stay replayable.
 */
const CORPUS_LINES: string[] = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "corpus", "sms-sample.txt"), "utf8");
    return raw.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return []; // a fresh checkout without the corpus still runs, just less well
  }
})();

function plaintextFor(id: number, sender: string, r?: Rng): Uint8Array {
  if (CORPUS_LINES.length === 0 || !r) {
    return TE.encode(`${sender}#${id}:${"~".repeat(id % 31)}`);
  }
  const roll = r.next();
  if (roll < 0.08) {
    // multi-byte UTF-8 all the way through the pipeline, including the
    // grapheme clusters (ZWJ, skin tone, regional indicator) that a naive
    // byte-slicing bug would split
    return TE.encode(r.pick(TEST_EMOJIS).repeat(r.intBetween(1, 10)));
  }
  if (roll < 0.14) {
    // a long message: several size classes above a chat line
    const parts: string[] = [];
    for (let i = 0; i < r.intBetween(10, 45); i++) parts.push(r.pick(CORPUS_LINES));
    return TE.encode(parts.join(" "));
  }
  if (roll < 0.18) {
    // incompressible bytes: the RAW path, which real traffic hits via images
    return r.bytes(r.intBetween(32, 400));
  }
  return TE.encode(r.pick(CORPUS_LINES));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function corrupt(wire: Uint8Array, r: Rng): Uint8Array {
  const out = wire.slice();
  const pos = r.int(out.length);
  out[pos] ^= 1 << r.int(8);
  return out;
}

export async function runSim(config: SimConfig): Promise<SimResult> {
  // deterministic keygen for the whole run: the source drives establishChannel's
  // offerer key, every ratchet-internal keygen, the rogue pool, and direction-
  // change ratchets, so the run — including all ciphertext bytes — is bit-exactly
  // reproducible from its seed. Reset in finally so it never leaks to other tests.
  const keySource = makeSeededKeyPairSource(config.seed);
  setDHKeyPairSource(keySource);
  try {
    return await runSimBody(config, keySource);
  } finally {
    resetDHKeyPairSource();
  }
}

async function runSimBody(config: SimConfig, keySource: () => Promise<KeyPair>): Promise<SimResult> {
  const injectProb = config.injectProb ?? 0.4;
  const garbageProb = config.garbageProb ?? 0.5;
  const burstMax = config.burstMax ?? 1;

  const rng = derivedRandom(config.seed);
  const ch: DuplexChannel = await establishChannel(rng.stream("secret").bytes(32), keySource);

  // GIVE THE SESSION A CLOCK, or S6 below is a tautology.
  //
  // Teardown needs two witnesses: a run of failures AND a long silence. Peers
  // are constructed with `now: () => 0`, so the second witness reads
  // `0 - 0 >= 30000` and is permanently false — meaning "injections never end
  // the session" would hold no matter what the protocol did. The step is
  // deliberately larger than one frame's worth of real time so that an attacker
  // who CAN suppress honest traffic long enough would in fact trip it, and S6
  // would then be reporting a real teardown rather than an unreachable one.
  let simClock = 1_000_000;
  const advance = () => { simClock += 250; return simClock; };
  for (const p of [ch.offerer, ch.answerer]) {
    p.now = () => simClock;
    p.lastSuccessAt = simClock;
  }

  const ledger: LedgerEntry[] = [];
  const result: SimResult = {
    seed: config.seed,
    sent: 0,
    accepted: 0,
    injections: 0,
    injectionsRejected: 0,
    injectionKinds: {},
    directionChanges: 0,
    rejects: {},
    verdictTrace: [],
    livenessOk: false,
    wireDigest: "",
  };

  // a small pool of valid, on-curve rogue DH keypairs for structurally-valid
  // hostile injections (a semantically-aware attacker, not just noise), and a
  // history of delivered honest wires for verbatim-replay injections.
  const roguePool: KeyPair[] = [];
  for (let i = 0; i < 6; i++) roguePool.push(await generateDHKeyPair());
  const deliveredWires: Uint8Array[] = [];

  // in-order per-direction FIFOs (reliable ordered transport). We enqueue a
  // burst of sends from one direction then deliver them in order, exercising
  // multi-step receive-chain advancement and DH ratchets on direction change.
  const queue: Record<"A" | "B", { id: number; wire: Uint8Array }[]> = { A: [], B: [] };
  let lastSender: "A" | "B" | null = null;

  const deliverInOrder = async (dir: "A" | "B"): Promise<void> => {
    const toPeer: Peer = dir === "A" ? ch.answerer : ch.offerer;
    while (queue[dir].length > 0) {
      const item = queue[dir].shift()!;
      const fr = rng.at(`fault-${dir}`, item.id);

      // adversarial injection immediately before the honest frame. A
      // semantically-aware attacker: tampered copy, random garbage, a verbatim
      // replay of a prior honest wire, or a STRUCTURALLY-VALID hostile frame
      // (fresh on-curve pubkey + in-window counter) — the last two reach branches
      // random noise never does.
      if (fr.bool(injectProb)) {
        let inj: Uint8Array;
        let kind: string;
        const roll = fr.next();
        if (roll < garbageProb * 0.5) {
          inj = fr.bytes(fr.intBetween(0, 80));
          kind = "garbage";
        } else if (roll < garbageProb) {
          inj = corrupt(item.wire, fr);
          kind = "tampered";
        } else if (deliveredWires.length > 0 && fr.bool(0.5)) {
          inj = deliveredWires[fr.int(deliveredWires.length)].slice(); // verbatim replay
          kind = "replay";
        } else {
          // structurally-valid hostile frame: valid rogue pubkey, counter/prevChainLen
          // biased around the receiver's window and the MAX_SKIP boundary.
          const rogue = roguePool[fr.int(roguePool.length)];
          const counter = fr.weighted([0, 1, MAX_SKIP - 1, MAX_SKIP, MAX_SKIP + 1, fr.int(2000)], [3, 2, 1, 1, 1, 1]);
          const prev = fr.weighted([0, 1, MAX_SKIP, MAX_SKIP + 1], [3, 1, 1, 1]);
          const hdr = buildHeader(0, rogue.publicKey, counter, prev, fr.bytes(4));
          const body = new Uint8Array(hdr.length + fr.intBetween(16, 48));
          body.set(hdr, 0);
          body.set(fr.bytes(body.length - hdr.length), hdr.length);
          inj = body;
          kind = "hostile-valid";
        }

        advance();
        const ir = await safeDecrypt(toPeer, inj);
        result.injections++;
        result.injectionKinds[kind] = (result.injectionKinds[kind] ?? 0) + 1;
        result.verdictTrace.push(`inj:${kind}:${ir.status}`);
        if (ir.status === "accept") {
          throw new Error(`INVARIANT S2 violated: injected ${kind} frame accepted (honest id ${item.id})`);
        }
        if ("plaintext" in ir) throw new Error(`INVARIANT S1 violated: plaintext on ${ir.status}`);
        // S1 in the form that can actually fire. The line above inspects a result
        // object the harness constructs itself, so it re-checks a shape the type
        // system already guarantees and could never catch a real leak. The channel
        // the failure path DOES populate from internal state is `reason`, which is
        // interpolated straight from exception text — so that is where plaintext
        // would surface if it ever surfaced at all.
        if ("reason" in ir && leaksPlaintext(ir.reason, ledger)) {
          throw new Error(`INVARIANT S1 violated: reject reason leaks plaintext: ${ir.reason}`);
        }
        // S5, in the form that can actually fire: see safeDecrypt.
        if (ir.threw) {
          throw new Error(`INVARIANT S5 violated: decrypt escaped by exception on ${kind}: ${ir.reason}`);
        }
        result.injectionsRejected++;
      }

      // honest, in-order delivery
      advance();
      const res = await safeDecrypt(toPeer, item.wire);
      result.verdictTrace.push(res.status);
      if (res.status === "accept") deliveredWires.push(item.wire);
      if (res.status !== "accept") {
        result.rejects[res.status] = (result.rejects[res.status] ?? 0) + 1;
        if ("plaintext" in res) throw new Error("INVARIANT S1 violated: plaintext on non-accept");
        if (res.threw) throw new Error(`INVARIANT S5 violated: honest frame ${item.id} threw: ${res.reason}`);
        throw new Error(`LIVENESS violated: honest in-order frame ${item.id} rejected (${res.status})`);
      }
      // S3 oracle
      if (!bytesEqual(res.plaintext, ledger[item.id].plaintext)) {
        throw new Error(`INVARIANT S3 violated: plaintext mismatch for id ${item.id}`);
      }
      // S4 no double-accept
      ledger[item.id].accepted++;
      if (ledger[item.id].accepted > 1) throw new Error(`INVARIANT S4 violated: id ${item.id} accepted twice`);
      result.accepted++;
    }
  };

  for (let step = 0; step < config.steps; step++) {
    const er = rng.at("step", step);
    const sender: "A" | "B" = er.bool() ? "A" : "B";
    if (lastSender !== null && sender !== lastSender) result.directionChanges++;
    lastSender = sender;

    const fromPeer: Peer = sender === "A" ? ch.offerer : ch.answerer;
    const burst = 1 + er.int(burstMax);
    for (let b = 0; b < burst; b++) {
      const id = ledger.length;
      const pt = plaintextFor(id, sender, er.fork ? er.fork(`pl${b}`) : er);
      const wire = await encrypt(fromPeer, pt, er.bytes(4));
      ledger.push({ id, sender, plaintext: pt, accepted: 0 });
      result.sent++;
      queue[sender].push({ id, wire });
    }
    // deliver this direction's queued frames in order
    await deliverInOrder(sender);
  }

  result.livenessOk = ledger.every((e) => e.accepted === 1);
  // fold every honest wire's bytes into a digest: with seeded keys this is a
  // pure function of the seed, so it proves bit-exact reproducibility.
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x1000193 >>> 0;
  for (const w of deliveredWires) {
    for (let i = 0; i < w.length; i++) {
      h1 = Math.imul(h1 ^ w[i], 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ w[i], 0x85ebca77) >>> 0;
    }
  }
  result.wireDigest = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");

  // S6: the session outlives the attack. Injections are interleaved with honest
  // traffic here, and an honest frame resets the caller's failure counter, so an
  // attacker who cannot land three rejections BACK TO BACK cannot end the session.
  // This is the invariant the old harness could not express at all, because it
  // did not model the counter that teardown reads.
  for (const [who, peer] of [["offerer", ch.offerer], ["answerer", ch.answerer]] as const) {
    if (!peer.alive) throw new Error(`INVARIANT S6 violated: ${who} was torn down by injected frames`);
  }
  // and S6 must have been ANSWERABLE: a frozen clock makes it hold for free
  assertClocksWereLive();
  return result;
}

/**
 * Totality has TWO failure modes and this only ever saw the second.
 *
 * `decrypt` contains its own catch-all, so an exception out of protocolDecrypt
 * was converted to an ordinary rejection long before this wrapper could observe
 * it — and an ordinary rejection is what the sim expects, so it counted as a
 * pass. The invariant was structurally unable to fire while the exact condition
 * it names was occurring on a large share of tampered frames, because a flipped
 * bit in a full header lands in the 33 pubkey bytes and P-256 point decompression
 * throws.
 *
 * The condition is now surfaced as `DecryptResult.threw` and checked at both
 * call sites. This wrapper remains as the outer floor: a throw from the HARNESS
 * itself (a bug in the mirror of live.ts, not in the protocol) still lands here.
 */
async function safeDecrypt(peer: Peer, wire: Uint8Array) {
  try {
    return await decrypt(peer, wire);
  } catch (e) {
    throw new Error(`INVARIANT S5 violated: decrypt threw out of the harness: ${(e as Error).message}`);
  }
}

/** does a reject reason contain any plaintext the ledger knows about? */
function leaksPlaintext(reason: string, ledger: Array<{ plaintext: Uint8Array }>): boolean {
  for (const entry of ledger) {
    if (entry.plaintext.length >= 4 && reason.includes(TD.decode(entry.plaintext))) return true;
  }
  return false;
}

// exported for potential debugging use
export { plaintextFor, TD };
