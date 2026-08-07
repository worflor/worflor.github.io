/**
 * Random-access derived randomness for the Whisper deterministic test harness.
 *
 * The design rule (from the DST analysis): there is ONE root seed, and every
 * decision the harness makes is `prng(hash(rootSeed, label, eventId))` — a
 * pure function of an independent coordinate, never a draw off one shared
 * stream. This matters because a single shared PRNG consumed in program order
 * reshuffles every later decision the moment you add one draw anywhere: the
 * seed corpus dies on every code change and per-fault minimization becomes
 * impossible. With per-decision derived randomness, faults/schedules/payloads
 * are independent axes you can toggle and shrink one at a time.
 *
 * All state is a single 32-bit word advanced by mulberry32 — adequate for
 * tests, and (unlike Math.random) fully reproducible. No Date.now, no crypto
 * entropy: a `DerivedRandom` built from the same root always replays identically.
 */

// FNV-1a over a label string → 32-bit. Deterministic, dependency-free.
function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// splitmix32 finalizer — mixes three coordinates into one well-distributed seed.
function mixSeed(root: number, labelHash: number, eventId: number): number {
  let z = (root ^ Math.imul(labelHash, 0x9e3779b1) ^ Math.imul(eventId | 0, 0x85ebca77)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** A single reproducible pseudo-random stream (mulberry32). */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform 32-bit unsigned integer. */
  uint32(): number {
    return (this.next() * 4294967296) >>> 0;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** Integer in [lo, hiInclusive]. */
  intBetween(lo: number, hiInclusive: number): number {
    if (hiInclusive <= lo) return lo;
    return lo + this.int(hiInclusive - lo + 1);
  }

  /** True with probability p. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /**
   * Weighted pick. `weights[i]` is the relative weight of `items[i]`.
   * Weights need not sum to 1.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Exponentially distributed positive value with the given mean. */
  exponential(mean: number): number {
    // inverse-CDF; guard against next()===0 producing Infinity by nudging.
    const u = 1 - this.next();
    return -Math.log(u <= 0 ? Number.MIN_VALUE : u) * mean;
  }

  /** n fresh random bytes. */
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int(256);
    return out;
  }

  /** A deterministic child stream, keyed by a label. */
  fork(label: string): Rng {
    return new Rng(mixSeed(this.s, hashLabel(label), 0));
  }
}

/**
 * The root of a deterministic run. Hands out independent, random-access
 * streams keyed by (label, eventId). Two DerivedRandoms with the same root
 * produce byte-identical everything.
 */
export class DerivedRandom {
  constructor(private readonly root: number) {}

  /**
   * A fully independent value stream for a single decision coordinate.
   * `at("faults.drop", 42)` is independent of `at("faults.drop", 43)` and of
   * `at("payload", 42)`; adding new coordinates never perturbs existing ones.
   */
  at(label: string, eventId: number): Rng {
    return new Rng(mixSeed(this.root, hashLabel(label), eventId));
  }

  /** A named sequential substream (for a concern consumed in order). */
  stream(label: string): Rng {
    return new Rng(mixSeed(this.root, hashLabel(label), 0));
  }

  /** The raw root seed, for logging into a failure artifact. */
  get seed(): number {
    return this.root;
  }
}

/** Build a DerivedRandom from an integer (or string) root seed. */
export function derivedRandom(root: number | string): DerivedRandom {
  const r = typeof root === "string" ? hashLabel(root) : root >>> 0;
  return new DerivedRandom(r);
}
