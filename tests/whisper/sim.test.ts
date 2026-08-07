/**
 * L4 — deterministic simulation of the real Whisper Live protocol.
 *
 * runSim drives both real peers over a reliable, ordered transport with a
 * semantically-aware adversary that injects tampered copies, random garbage,
 * VERBATIM REPLAYS of prior honest wires, and STRUCTURALLY-VALID hostile frames
 * (fresh on-curve pubkeys + in-window counters). It throws on any invariant
 * violation (S1..S5) or a liveness failure.
 *
 * Determinism note (honest scoping): the SCHEDULE, adversary choices, plaintexts,
 * and injection kinds are a pure function of the seed, so the verdict trace is
 * reproducible. The DH key MATERIAL is real/CSPRNG (the harness does not seed the
 * keypair source), so ciphertext bytes are NOT reproduced — but no invariant
 * depends on key bytes, and structural failures replay from the seed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSim, type SimResult } from "./_harness/sim.js";

describe("L4 — deterministic protocol simulation (in-order + injection)", () => {
  it("sweep: 40 seeds — honest stream always delivers, injections never accepted", async () => {
    const kinds: Record<string, number> = {};
    let totalInjections = 0;
    let totalDirChanges = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const steps = 40 + ((seed * 29) % 120); // 40..159
      const r: SimResult = await runSim({ seed, steps, burstMax: 3 }); // throws on any violation

      assert.equal(r.livenessOk, true, `seed ${seed}: honest frame lost — silent desync`);
      assert.equal(r.accepted, r.sent, `seed ${seed}: accepted (${r.accepted}) must equal sent (${r.sent})`);
      assert.equal(r.injectionsRejected, r.injections, `seed ${seed}: an injected frame slipped through`);

      totalInjections += r.injections;
      totalDirChanges += r.directionChanges;
      for (const [k, n] of Object.entries(r.injectionKinds)) kinds[k] = (kinds[k] ?? 0) + n;
    }
    // coverage: the adversary actually exercised each attack class + the DH path
    assert.ok(totalInjections > 0, "no injections across 40 seeds — injector broken");
    assert.ok(totalDirChanges > 0, "no direction changes — DH ratchet path not exercised");
    assert.ok((kinds["hostile-valid"] ?? 0) > 0, "structurally-valid hostile frames never generated");
    assert.ok((kinds["replay"] ?? 0) > 0, "verbatim replays never generated");
  });

  it("reproducibility: same seed → bit-exact identical run (seeded DH keys)", async () => {
    // With the seeded keypair source installed for the whole run, ALL key
    // material is a pure function of the seed, so the run is byte-for-byte
    // reproducible: identical verdict trace (incl. reject reasons), identical
    // injection accounting, and identical honest ciphertext bytes (wireDigest).
    // This is the real deterministic-simulation guarantee the design intended.
    for (const seed of [7, 21, 99]) {
      const a = await runSim({ seed, steps: 120, burstMax: 3 });
      const b = await runSim({ seed, steps: 120, burstMax: 3 });
      assert.deepEqual(a.verdictTrace, b.verdictTrace, `seed ${seed}: verdict trace not reproducible`);
      assert.deepEqual(a.injectionKinds, b.injectionKinds, `seed ${seed}: injection kinds not reproducible`);
      assert.equal(a.accepted, b.accepted, `seed ${seed}: accepted not reproducible`);
      assert.equal(a.wireDigest, b.wireDigest, `seed ${seed}: honest ciphertext bytes not reproducible`);
      assert.equal(a.livenessOk, b.livenessOk, `seed ${seed}: liveness not reproducible`);
    }
  });

  it("distinctness: different seeds produce different key material (wireDigest differs)", async () => {
    const digs = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) digs.add((await runSim({ seed, steps: 60, burstMax: 2 })).wireDigest);
    assert.ok(digs.size >= 4, "distinct seeds should mostly yield distinct wire bytes");
  });

  it("swarm — heavy mixed injection never accepts a forged frame", async () => {
    for (let seed = 300; seed < 312; seed++) {
      const r = await runSim({ seed, steps: 150, injectProb: 0.9, garbageProb: 0.4, burstMax: 4 });
      assert.equal(r.livenessOk, true, `seed ${seed}: honest stream must survive heavy injection`);
      assert.ok(r.injections > 0, "injections should have occurred");
      assert.equal(r.injectionsRejected, r.injections, `seed ${seed}: a forged frame was accepted`);
    }
  });

  it("swarm — pure garbage injection is always rejected safely (S5 totality)", async () => {
    for (let seed = 400; seed < 410; seed++) {
      const r = await runSim({ seed, steps: 120, injectProb: 0.8, garbageProb: 1, burstMax: 2 });
      assert.equal(r.livenessOk, true, `seed ${seed}: honest stream survives garbage injection`);
      assert.equal(r.injectionsRejected, r.injections, `seed ${seed}: garbage frame accepted`);
    }
  });
});
