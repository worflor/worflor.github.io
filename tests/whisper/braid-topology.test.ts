import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDeterministicRng } from "./_helpers/generators.js";
import {
  sortRoster,
  computeTopology,
  neighborsOf,
  topologyDiff,
  edgeOfferer,
} from "../../src/scripts/whisper/campfire/topology.js";
import { MAX_NEIGHBORS, MIN_NEIGHBORS } from "../../src/scripts/whisper/campfire/types.js";

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Generate n unique lowercase 32-char hex ids from a seeded rng. */
function genRoster(n: number, seed: number): string[] {
  const rng = makeDeterministicRng(seed);
  const seen = new Set<string>();
  while (seen.size < n) {
    let hex = "";
    for (let i = 0; i < 32; i++) hex += ((rng() * 16) | 0).toString(16);
    seen.add(hex);
  }
  return sortRoster(seen);
}

/** Fisher-Yates shuffle driven by a seeded rng, non-mutating. */
function shuffled<T>(arr: T[], seed: number): T[] {
  const rng = makeDeterministicRng(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function bfsReachable(topology: Map<string, Set<string>>, start: string): Set<string> {
  const visited = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of topology.get(cur) ?? []) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  return visited;
}

function bfsDistances(topology: Map<string, Set<string>>, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const nb of topology.get(cur) ?? []) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

/** Sorted list of undirected edges, as "a|b" keys, for a topology. */
function edgeKeys(topology: Map<string, Set<string>>): string[] {
  const keys = new Set<string>();
  for (const [hex, neighbors] of topology) {
    for (const other of neighbors) {
      const [a, b] = hex < other ? [hex, other] : [other, hex];
      keys.add(`${a}|${b}`);
    }
  }
  return Array.from(keys).sort();
}

/** Ring edges of a sorted roster: consecutive pairs plus the wraparound pair. */
function ringEdgeKeys(sortedRoster: string[]): Set<string> {
  const n = sortedRoster.length;
  const keys = new Set<string>();
  if (n < 3) return keys;
  for (let i = 0; i < n; i++) {
    const a = sortedRoster[i];
    const b = sortedRoster[(i + 1) % n];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    keys.add(`${lo}|${hi}`);
  }
  return keys;
}

function assertValidTopology(topology: Map<string, Set<string>>, roster: string[]): void {
  // symmetry + no self edges
  for (const [hex, neighbors] of topology) {
    assert.ok(!neighbors.has(hex), `${hex} must not be its own neighbor`);
    for (const nb of neighbors) {
      assert.ok(topology.get(nb)?.has(hex), `edge ${hex}->${nb} must be mutual`);
    }
  }
  // connectivity
  if (roster.length > 0) {
    const reached = bfsReachable(topology, roster[0]);
    assert.equal(reached.size, roster.length, "graph must be fully connected");
  }
  // degree bounds
  for (const hex of roster) {
    const deg = topology.get(hex)?.size ?? 0;
    assert.ok(deg <= MAX_NEIGHBORS, `${hex} degree ${deg} must be <= MAX_NEIGHBORS`);
  }
}

/* ── tests ───────────────────────────────────────────────────────────── */

describe("campfire/topology", () => {
  describe("connectivity", () => {
    it("BFS from first seat reaches every seat, n=1..64", () => {
      for (let n = 1; n <= 64; n++) {
        const roster = genRoster(n, 1000 + n);
        const topo = computeTopology(roster);
        const reached = bfsReachable(topo, roster[0]);
        assert.equal(reached.size, n, `n=${n}: expected all ${n} seats reachable, got ${reached.size}`);
      }
    });
  });

  describe("degree bounds", () => {
    it("n=1: degree 0", () => {
      const roster = genRoster(1, 2001);
      const topo = computeTopology(roster);
      assert.equal(topo.get(roster[0])!.size, 0);
    });

    it("n=2: degree 1", () => {
      const roster = genRoster(2, 2002);
      const topo = computeTopology(roster);
      for (const hex of roster) assert.equal(topo.get(hex)!.size, 1, `${hex} degree`);
    });

    it("n=3..64: every seat has degree in [2, 4], never exceeds MAX_NEIGHBORS", () => {
      for (let n = 3; n <= 64; n++) {
        const roster = genRoster(n, 3000 + n);
        const topo = computeTopology(roster);
        for (const hex of roster) {
          const deg = topo.get(hex)!.size;
          assert.ok(deg >= MIN_NEIGHBORS, `n=${n} ${hex}: degree ${deg} must be >= MIN_NEIGHBORS (${MIN_NEIGHBORS})`);
          assert.ok(deg <= MAX_NEIGHBORS, `n=${n} ${hex}: degree ${deg} must be <= MAX_NEIGHBORS (${MAX_NEIGHBORS})`);
          assert.ok(deg <= 4, `n=${n} ${hex}: degree ${deg} must be <= 4`);
        }
      }
    });
  });

  describe("symmetry + no self edges", () => {
    it("edges are mutual and no seat neighbors itself, n=1..40", () => {
      for (let n = 1; n <= 40; n++) {
        const roster = genRoster(n, 4000 + n);
        const topo = computeTopology(roster);
        for (const a of roster) {
          assert.ok(!topo.get(a)!.has(a), `${a} must not be its own neighbor`);
          for (const b of topo.get(a)!) {
            assert.ok(topo.get(b)!.has(a), `edge ${a}<->${b} must be symmetric`);
          }
        }
      }
    });
  });

  describe("determinism", () => {
    it("shuffled input order yields identical topology, n=3..40", () => {
      for (let n = 3; n <= 40; n += 3) {
        const roster = genRoster(n, 5000 + n);
        const baseline = edgeKeys(computeTopology(roster));
        for (let s = 0; s < 5; s++) {
          const shuffledRoster = shuffled(roster, 6000 + n * 10 + s);
          const topo = computeTopology(shuffledRoster);
          assert.deepStrictEqual(edgeKeys(topo), baseline, `n=${n} shuffle seed ${s}`);
        }
      }
    });
  });

  describe("ring locality on join", () => {
    it("adding one seat only disturbs ring edges near the insertion point, n=6..20", () => {
      for (let n = 6; n <= 20; n++) {
        const oldRoster = genRoster(n, 7000 + n);
        const oldTopo = computeTopology(oldRoster);

        // draw a new unique seat hex
        const rng = makeDeterministicRng(8000 + n);
        const oldSet = new Set(oldRoster);
        let newHex = "";
        do {
          newHex = "";
          for (let i = 0; i < 32; i++) newHex += ((rng() * 16) | 0).toString(16);
        } while (oldSet.has(newHex));

        const newRoster = sortRoster([...oldRoster, newHex]);
        const newTopo = computeTopology(newRoster);

        const diff = topologyDiff(oldTopo, newTopo);
        assert.ok(diff.added.length + diff.removed.length > 0, `n=${n}: diff must be nonempty`);

        const oldRingKeys = ringEdgeKeys(oldRoster);
        const newRingKeys = ringEdgeKeys(newRoster);

        const removedRingEdges = diff.removed.filter(([a, b]) => oldRingKeys.has(`${a}|${b}`));
        const addedRingEdges = diff.added.filter(([a, b]) => newRingKeys.has(`${a}|${b}`));

        assert.ok(removedRingEdges.length <= 1, `n=${n}: expected at most 1 ring edge removed, got ${removedRingEdges.length}`);
        assert.ok(addedRingEdges.length <= 2, `n=${n}: expected at most 2 ring edges added, got ${addedRingEdges.length}`);

        assertValidTopology(newTopo, newRoster);
      }
    });
  });

  describe("edgeOfferer", () => {
    it("returns the smaller hex, agrees for both argument orders, is one of the two endpoints", () => {
      const roster = genRoster(30, 9000);
      for (let i = 0; i < roster.length - 1; i++) {
        const a = roster[i];
        const b = roster[i + 1];
        const fwd = edgeOfferer(a, b);
        const rev = edgeOfferer(b, a);
        assert.equal(fwd, rev, "must agree regardless of argument order");
        assert.ok(fwd === a || fwd === b, "must be one of the two endpoints");
        const expectedSmaller = a < b ? a : b;
        assert.equal(fwd, expectedSmaller, "must be the lexicographically smaller hex");
      }
    });
  });

  describe("diameter sanity", () => {
    it("max shortest-path hops stays within the gossip MAX_HOP_COUNT (16), n=8,16,32,64", () => {
      for (const n of [8, 16, 32, 64]) {
        const roster = genRoster(n, 10000 + n);
        const topo = computeTopology(roster);
        let maxHops = 0;
        for (const start of roster) {
          const dist = bfsDistances(topo, start);
          for (const d of dist.values()) maxHops = Math.max(maxHops, d);
        }
        assert.ok(maxHops <= 16, `n=${n}: diameter ${maxHops} must be <= 16`);
      }
    });
  });

  describe("neighborsOf", () => {
    it("returns sorted neighbors, empty for absent seat", () => {
      const roster = genRoster(10, 11000);
      const topo = computeTopology(roster);
      for (const hex of roster) {
        const nbs = neighborsOf(topo, hex);
        assert.deepStrictEqual(nbs, [...nbs].sort(), "must be sorted ascending");
      }
      assert.deepStrictEqual(neighborsOf(topo, "ff".repeat(16)), []);
    });
  });
});
