/**
 * retention.ts — one rule for every bounded structure in the protocol.
 *
 * ══ THE THEOREM ══
 *
 * A cache exists to answer a future question. Whether an entry may be dropped is
 * therefore not a question about the entry, it is a question about the ORDER the
 * asker searches in.
 *
 * Let a structure be read by parties p ∈ P, and let each party's demand be
 * described by a position dₚ in some partial order (D, ≤). An entry at position
 * x is still reachable exactly when
 *
 *     ∃p ∈ P .  x > dₚ
 *
 * so it is dead exactly when x ≤ ⋀ₚ dₚ. That meet — the greatest lower bound of
 * the demands — is the RETENTION FLOOR. It is not a heuristic watermark chosen
 * for comfort: being the greatest lower bound makes it the LARGEST safe thing to
 * forget, so any policy that drops more is losing data someone will ask for, and
 * any policy that drops less is merely wasteful.
 *
 * ══ WHY THIS MODULE EXISTS ══
 *
 * The bug it prevents appeared four times in this codebase, each time as a cache
 * evicting along an order its reader does not search in:
 *
 *   count model (abelian, order-blind)   keyed what needed the trace     → collisions
 *   pendingMeta (arrival order)          served the holdback (delivery)  → 89/600 wrong ids
 *   store (wall-clock age)               served the frontier lattice     → lurker unreadable
 *   appliedFolds (insertion count)       served an epoch-contiguous run  → seat stranded
 *
 * None was fixable by enlarging a cap. Arrival and delivery are anti-correlated,
 * because the holdback exists precisely to decouple them. Wall time and
 * causality are not even comparable. A count is not an order on the domain at
 * all. The failure is categorical, so the remedy has to be categorical: name the
 * order, compute the meet, evict along it.
 *
 * ══ THE CONTRACT ══
 *
 * `evictBelowFloor` takes a soft cap and a predicate saying whether a key is at
 * or below the floor. It drops only such keys, oldest first, and STOPS when the
 * cap cannot be met without crossing the floor. That stopping condition is the
 * design decision made once, here, so that no call site has to make it again:
 *
 *     memory over the cap is recoverable; an entry someone still needs is not.
 *
 * A structure that stays over its cap is not a leak, it is a MEASUREMENT: some
 * party has fallen far enough behind that serving it and staying small are no
 * longer both possible. That is information the layer above wants (fold the
 * epoch, remove the seat, surface a stall), and `overCap` reports it rather than
 * resolving it by quietly breaking someone.
 */

/** Outcome of one sweep, so callers can act on sustained pressure. */
export interface SweepResult {
  /** entries actually dropped. */
  dropped: number;
  /** entries still held that the cap wanted gone but the floor protects. */
  overCap: number;
}

/**
 * Evict oldest-first, but only at or below the retention floor.
 *
 * `isDead(key)` must be exactly the floor test for this structure: true when no
 * reader can ever ask for that key again. Getting it wrong in the safe direction
 * (too few deaths) costs memory; getting it wrong in the unsafe direction is the
 * bug this module exists to prevent, so express it as a meet over the readers'
 * demands rather than as a guess.
 *
 * Insertion order is only a tiebreak among ALREADY-DEAD entries, never a reason
 * to drop a live one.
 */
export function evictBelowFloor<K, V>(
  entries: Map<K, V>,
  softCap: number,
  isDead: (key: K) => boolean,
  onDrop?: (key: K, value: V) => void,
): SweepResult {
  let dropped = 0;
  while (entries.size > softCap) {
    let victim: K | undefined;
    for (const key of entries.keys()) {
      if (isDead(key)) { victim = key; break; }
    }
    if (victim === undefined) break; // everything left is still reachable
    const value = entries.get(victim)!;
    entries.delete(victim);
    onDrop?.(victim, value);
    dropped++;
  }
  return { dropped, overCap: Math.max(0, entries.size - softCap) };
}

/**
 * Drop every dead entry regardless of the cap.
 *
 * The counterpart sweep: below the floor nothing is owed to anyone, so a
 * structure may forget as eagerly as it likes. This is where a time bound or a
 * forward-secrecy policy gets to act — on what the order has already declared
 * dead, never above it.
 */
export function purgeDead<K, V>(
  entries: Map<K, V>,
  isDead: (key: K) => boolean,
  onDrop?: (key: K, value: V) => void,
): number {
  let dropped = 0;
  for (const key of Array.from(entries.keys())) {
    if (!isDead(key)) continue;
    const value = entries.get(key)!;
    entries.delete(key);
    onDrop?.(key, value);
    dropped++;
  }
  return dropped;
}

/**
 * The meet of a family of positions in ℕ, treating an absent party as 0.
 *
 * Absence is the bottom element on purpose. A party we have no news of might be
 * anywhere, so it constrains everything, and retention grows until it either
 * speaks or is removed. The alternative — assuming a silent party is caught up —
 * is exactly the assumption that stranded a seat behind sixteen epochs.
 */
export function meetOf(positions: Iterable<number | undefined>): number {
  let meet = Infinity;
  for (const p of positions) {
    const v = p ?? 0;
    if (v < meet) meet = v;
  }
  return meet === Infinity ? 0 : meet;
}
