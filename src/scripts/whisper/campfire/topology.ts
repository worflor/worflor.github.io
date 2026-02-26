/**
 * Campfire — Root-only topology management.
 *
 * The Root maintains the full mesh graph and assigns neighbors to each peer.
 * Goal: every peer has 2–4 neighbors; the graph is connected so gossip reaches everyone.
 */

import { toHex } from "../wasm";
import { MAX_NEIGHBORS, MIN_NEIGHBORS } from "./types";

/* ═══════════════════════════════════════════════════════════════════
   Graph Node
   ═══════════════════════════════════════════════════════════════════ */

interface GraphNode {
  peerId: Uint8Array;
  peerIdHex: string;
  neighbors: Set<string>; // hex peer IDs of neighbors
}

/* ═══════════════════════════════════════════════════════════════════
   CampfireTopology
   ═══════════════════════════════════════════════════════════════════ */

export class CampfireTopology {
  private nodes = new Map<string, GraphNode>();
  private rootHex: string;

  constructor(rootPeerId: Uint8Array) {
    this.rootHex = toHex(rootPeerId);
    this.addNode(rootPeerId);
  }

  /** Add a peer to the graph (no neighbors yet). */
  addNode(peerId: Uint8Array): void {
    const hex = toHex(peerId);
    if (this.nodes.has(hex)) return;
    this.nodes.set(hex, { peerId: new Uint8Array(peerId), peerIdHex: hex, neighbors: new Set() });
  }

  /** Remove a peer and all its edges. Returns affected peers that may need re-balancing. */
  removeNode(peerId: Uint8Array): string[] {
    const hex = toHex(peerId);
    const node = this.nodes.get(hex);
    if (!node) return [];

    const affected: string[] = [];
    for (const nHex of node.neighbors) {
      const neighbor = this.nodes.get(nHex);
      if (neighbor) {
        neighbor.neighbors.delete(hex);
        affected.push(nHex);
      }
    }

    this.nodes.delete(hex);
    return affected;
  }

  /** Add a bidirectional edge between two peers. */
  private addEdge(aHex: string, bHex: string): void {
    const a = this.nodes.get(aHex);
    const b = this.nodes.get(bHex);
    if (!a || !b || aHex === bHex) return;
    a.neighbors.add(bHex);
    b.neighbors.add(aHex);
  }

  /**
   * Select neighbors for a newly joined peer.
   * Root is treated as just another candidate — whoever has the lowest
   * degree gets picked first. Returns the list of peer IDs the new peer
   * should connect to.
   */
  selectNeighborsForNewPeer(newPeerId: Uint8Array): Uint8Array[] {
    const newHex = toHex(newPeerId);
    this.addNode(newPeerId);

    // All nodes except the new peer, sorted by degree ascending
    const candidates = Array.from(this.nodes.values())
      .filter((n) => n.peerIdHex !== newHex)
      .sort((a, b) => a.neighbors.size - b.neighbors.size);

    const neighbors: Uint8Array[] = [];
    for (const c of candidates) {
      if (neighbors.length >= MIN_NEIGHBORS) break;
      if (c.neighbors.size >= MAX_NEIGHBORS) continue;
      this.addEdge(newHex, c.peerIdHex);
      neighbors.push(c.peerId);
    }

    return neighbors;
  }

  /**
   * After a peer leaves, check if any affected peers have dropped below
   * MIN_NEIGHBORS and try to assign new neighbors.
   *
   * Returns a list of new edges that need SDP relay: [peerA, peerB] pairs.
   */
  rebalanceAfterRemoval(affectedHexes: string[]): Array<[Uint8Array, Uint8Array]> {
    const newEdges: Array<[Uint8Array, Uint8Array]> = [];

    for (const hex of affectedHexes) {
      const node = this.nodes.get(hex);
      if (!node) continue;
      if (node.neighbors.size >= MIN_NEIGHBORS) continue;

      // Find a peer we're not already connected to (lowest degree first)
      const candidates = Array.from(this.nodes.values())
        .filter((n) => n.peerIdHex !== hex && !node.neighbors.has(n.peerIdHex))
        .sort((a, b) => a.neighbors.size - b.neighbors.size);

      for (const c of candidates) {
        if (node.neighbors.size >= MIN_NEIGHBORS) break;
        if (c.neighbors.size >= MAX_NEIGHBORS) continue;
        this.addEdge(hex, c.peerIdHex);
        newEdges.push([node.peerId, c.peerId]);
      }
    }

    return newEdges;
  }

  /** Get all peers except Root. */
  getPeers(): Array<{ peerId: Uint8Array; peerIdHex: string }> {
    return Array.from(this.nodes.values())
      .filter((n) => n.peerIdHex !== this.rootHex)
      .map((n) => ({ peerId: n.peerId, peerIdHex: n.peerIdHex }));
  }

  /** Get neighbors for a specific peer. */
  getNeighbors(peerIdHex: string): Uint8Array[] {
    const node = this.nodes.get(peerIdHex);
    if (!node) return [];
    return Array.from(node.neighbors)
      .map((hex) => this.nodes.get(hex)?.peerId)
      .filter((id): id is Uint8Array => !!id);
  }

  /** Total number of peers (including Root). */
  get size(): number {
    return this.nodes.size;
  }

  /** Get all peer IDs as hex strings. */
  getAllHexIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /** Check if a peer exists in the graph. */
  has(peerIdHex: string): boolean {
    return this.nodes.has(peerIdHex);
  }
}
