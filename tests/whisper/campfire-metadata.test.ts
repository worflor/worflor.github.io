/**
 * campfire-metadata.test.ts — message metadata must outlive the message it describes.
 *
 * THE INVARIANT. A group message is tracked by TWO structures between arrival and
 * delivery, in two different modules:
 *
 *   the HOLDBACK   live-braid.ts   held: seatIndex -> seq -> BraidMessage
 *                                  bounded at BRAID_HOLDBACK_CAP = 256 PER SEAT,
 *                                  so up to 256 x 64 seats = 16,384 messages
 *
 *   the METADATA   gossip.ts       pendingMeta: "epoch:seat:seq" -> {msgId,
 *                                  timestamp, hopCount, contentType}
 *                                  bounded at PENDING_META_CAP = 512 TOTAL, FIFO
 *
 * Delivery reads from the first and looks up the second, so correctness demands
 * dom(holdback) is a subset of dom(pendingMeta) at every delivery. Nothing
 * maintains that. The capacities differ by a factor of 32 and the eviction
 * policies are unrelated: the braid evicts per-seat and by byte budget and by
 * TTL, pendingMeta evicts FIFO by global count. Three lagging seats are enough
 * to break it, because 3 x 256 = 768 > 512.
 *
 * WHY THE SYMPTOM IS SILENT. The lookup miss is not treated as a miss. A partial
 * function is totalized by substituting values that are IN-BAND, meaning they are
 * indistinguishable from legitimate ones:
 *
 *   contentType = meta?.contentType ?? ContentType.Text
 *   msgId       = meta?.msgId       ?? sha256(senderId || epochId || seq)
 *   timestamp   = meta?.timestamp   ?? Date.now()
 *
 * The canonical msgId includes the ciphertext. The fallback does not, so it is a
 * perfectly well-formed identifier that NO OTHER PEER AGREES WITH. Reactions and
 * read receipts are keyed on msgId, so they attach to nothing. ContentType.Text
 * is 0x00, a real type, so a File arrives as text; and the guard that suppresses
 * silent System beacons stops firing, surfacing empty bubbles.
 *
 * This test drives the msgId symptom, because it needs only the public send path
 * and it is checkable against another node's view of the same message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VirtualNet, makeNode, connect, teardown, type NodeRecord } from "./_helpers/campfire-harness.js";
import { CF_GROUP_MSG } from "../../src/scripts/whisper/campfire/types.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TD = new TextDecoder();

/** text -> msgId, as one node saw it. */
function msgIdsByText(rec: NodeRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rec.messages) out.set(TD.decode(m.plaintext), toHex(m.msgId));
  return out;
}

describe("campfire — metadata must outlive the message it describes", () => {
  it("a lagging seat delivers messages whose msgId nobody else agrees with", async () => {
    const net = new VirtualNet(0x9E7A);
    // A blocked seat broadcasts a RING_WANT for every message it is holding, so a
    // deep backlog amplifies into the mesh and the default ceiling trips for an
    // honest reason rather than a loop. That amplification is worth its own look;
    // here it just means the scenario needs headroom.
    net.deliveryCeiling = 3_000_000;
    const host = makeNode(net, "host");
    const senders: NodeRecord[] = [];
    for (const name of ["s1", "s2", "s3"]) {
      const n = makeNode(net, name);
      await connect(host, n);
      senders.push(n);
    }
    // Ring repair is switched off for the victim, and that is the SCENARIO, not a
    // convenience. Repair heals a gap by asking a neighbour for the missing
    // (seat, seq), which works whenever someone reachable still holds it. The
    // holdback exists for when nobody does: the sender left, the mesh is
    // partitioned, or repair is outpaced by a fast talker. Leaving repair on
    // simply means the gap closes and nothing is held, which tests the repair
    // path rather than the retention path.
    const victim = makeNode(net, "victim", { ringRepairIntervalMs: 60 * 60 * 1000 });
    await connect(host, victim);
    const witness = makeNode(net, "witness");
    await connect(host, witness);
    const recs = [host, ...senders, victim, witness];

    try {
      await net.drain();

      // ISOLATE THE VICTIM, then replay into it directly.
      //
      // Letting the victim participate live is unaffordable, and the reason is
      // itself worth recording: a seat that is holding broadcasts a RING_WANT for
      // its gaps, neighbours answer by RESENDING the missing frames, and those
      // resends re-flood the mesh. With a backlog of hundreds the run does not
      // finish. So the victim is cut off while the circle talks, every frame
      // addressed to it is captured, and the backlog is fed to it afterwards in
      // an order that forces the holdback. Its own wants go nowhere.
      const captured: Uint8Array[] = [];
      net.dropFilter = (from, to, bytes) => {
        if (from === victim.idx) return true;               // it talks to no one
        if (to !== victim.idx) return false;
        if (bytes[0] === CF_GROUP_MSG) captured.push(bytes.slice());
        return true;                                        // and hears nothing live
      };

      // 3 senders x 200 = 600 frames held at once: over the 512-entry metadata
      // cap, under the 256-per-seat holdback cap.
      const PER_SENDER = 200;
      for (let i = 0; i < PER_SENDER; i++) {
        for (const s of senders) await s.node.broadcastText(`${s.name}-msg-${i}`);
      }
      await net.drain();

      const seenIds = new Set<string>();
      const frames = captured.filter((f) => {
        const id = toHex(f.subarray(1, 33));
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      assert.ok(frames.length >= 600, `expected the full backlog captured, got ${frames.length}`);

      const inject = (victim.node as unknown as {
        handleCampfireMessage(p: Uint8Array, label: string): Promise<void>;
      }).handleCampfireMessage.bind(victim.node);

      // hold everything by withholding each strand's FIRST frame
      const firstOfSender = new Map<string, Uint8Array>();
      const rest: Uint8Array[] = [];
      for (const f of frames) {
        const senderKey = toHex(f.subarray(33, 49));
        if (!firstOfSender.has(senderKey)) firstOfSender.set(senderKey, f);
        else rest.push(f);
      }
      for (const f of rest) await inject(f, "join-root");
      await net.drain();

      assert.equal(victim.messages.length, 0,
        `precondition: with each strand's first frame withheld nothing may deliver ` +
        `(got ${victim.messages.length})`);

      // release the openers; the cascade delivers the whole backlog at once
      for (const f of firstOfSender.values()) await inject(f, "join-root");
      await net.drain();

      const oracle = msgIdsByText(witness);
      const got = msgIdsByText(victim);

      assert.ok(got.size > 500,
        `the victim must actually have delivered the backlog, got ${got.size}`);

      const mismatched: string[] = [];
      for (const [text, id] of got) {
        const truth = oracle.get(text);
        if (truth && truth !== id) mismatched.push(text);
      }

      assert.deepEqual(mismatched, [],
        `${mismatched.length} messages were delivered with a msgId no other peer agrees with ` +
        `(first few: ${mismatched.slice(0, 3).join(", ")}). Reactions and read receipts are ` +
        `keyed on msgId, so they attach to nothing for these messages.`);
    } finally {
      net.dropFilter = undefined;
      await teardown(recs);
    }
  });
});
