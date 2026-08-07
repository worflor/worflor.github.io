/**
 * campfire-concurrency.test.ts — the gossip mesh under genuinely concurrent input.
 *
 * WHY THIS FILE EXISTS. Every other campfire test runs through the harness's
 * delivery queue, which processes one frame at a time and AWAITS each inbound
 * handler. Production does neither. Every neighbour edge is its own
 * WhisperLiveSession, and live.ts fires `onRawDecrypted(plaintext)` without
 * awaiting it, so a node genuinely has several copies of `handleCampfireMessage`
 * in flight at once. In a mesh that is not an edge case: the SAME message
 * arriving from two neighbours at nearly the same moment is the normal way
 * gossip works.
 *
 * WHAT WAS SUSPECTED, AND WHAT IS ACTUALLY TRUE. The dedup in `handleGroupMsg`
 * looked like a check-then-set split by an await:
 *
 *     const expectedMsgId = await sha256(...);   // <-- yields
 *     if (!constantTimeEqual(...)) return;
 *     if (this.hasSeen(id)) return;              // check
 *     this.markSeen(id);                         // set
 *
 * It is not. The await sits BEFORE the check, and check-and-mark are adjacent
 * synchronous statements, so whichever copy reaches the check first also reaches
 * the mark before it can yield again.
 *
 * Then the interesting part, found by inserting a yield between those two lines
 * and measuring rather than reasoning: BOTH copies get past the dedup, and the
 * behaviour asserted below stays correct anyway. Duplicate suppression is
 * LAYERED. The msgId ring is a cheap early exit that saves a signature check and
 * a braid open per redundant mesh path; the braid lane is what actually
 * guarantees a message is delivered once, because a seq already integrated is
 * ignored no matter how many copies arrive.
 *
 * So these assertions are end-to-end, and they are deliberately not a test of
 * the msgId ring in isolation. A test that could only fail if the ring broke
 * would be claiming the ring is load-bearing for correctness, and the
 * measurement says it is not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VirtualNet, makeNode, connect, teardown, type NodeRecord } from "./_helpers/campfire-harness.js";
import { CF_GROUP_MSG } from "../../src/scripts/whisper/campfire/types.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TD = new TextDecoder();

async function buildCircle(net: VirtualNet, hostName: string, joinerNames: string[]): Promise<NodeRecord[]> {
  const host = makeNode(net, hostName);
  const recs: NodeRecord[] = [host];
  for (const name of joinerNames) {
    const joiner = makeNode(net, name);
    await connect(host, joiner);
    recs.push(joiner);
  }
  return recs;
}

function neighborLabels(rec: NodeRecord): string[] {
  const neighbors: Map<string, { connected: boolean }> =
    (rec.node as unknown as { neighbors: Map<string, { connected: boolean }> }).neighbors;
  const out: string[] = [];
  for (const [label, peer] of neighbors) if (peer.connected) out.push(label);
  return out;
}

describe("campfire — concurrent inbound frames", () => {
  it("two copies of one message, delivered concurrently, are deduped exactly once", async () => {
    const net = new VirtualNet(101);
    const recs = await buildCircle(net, "A", ["B", "C"]);
    const [A, , C] = recs;
    try {
      // hold every group frame bound for C so C stays clean, keeping the bytes.
      const held: Uint8Array[] = [];
      net.dropFilter = (_from, to, bytes) => {
        if (to !== C.idx || bytes[0] !== CF_GROUP_MSG) return false;
        held.push(bytes.slice());
        return true;
      };
      await A.node.broadcastText("racy");
      await net.drain();
      net.dropFilter = undefined;

      const texts0 = C.messages.map((m) => TD.decode(m.plaintext));
      assert.ok(held.length > 0, "captured at least one frame bound for C");

      const labels = neighborLabels(C);
      assert.ok(labels.length >= 2, "C has two live neighbor edges");

      const frame = held[0];
      const msgIdHex = toHex(frame.subarray(1, 33));
      let forwards = 0;
      net.dropFilter = (from, _to, bytes) => {
        if (from === C.idx && bytes[0] === CF_GROUP_MSG && toHex(bytes.subarray(1, 33)) === msgIdHex) forwards++;
        return false;
      };

      const handle = (C.node as unknown as {
        handleCampfireMessage(p: Uint8Array, label: string): Promise<void>;
      }).handleCampfireMessage.bind(C.node);

      // fire-and-forget both copies, exactly like live.ts:2035 does per session.
      const p1 = handle(frame.slice(), labels[0]);
      const p2 = handle(frame.slice(), labels[1]);
      await Promise.all([p1, p2]);
      await net.drain();

      const texts = C.messages.map((m) => TD.decode(m.plaintext));
      const n = texts.filter((t) => t === "racy").length;
      assert.equal(n, 1, `C delivered "racy" exactly once (got ${n})`);
      assert.equal(C.equivocations.length, 0, "no equivocation reported for a genuine duplicate");
      assert.equal(forwards, 1, `C relayed the frame exactly once (got ${forwards}) — only one copy got past the dedup`);
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
});
