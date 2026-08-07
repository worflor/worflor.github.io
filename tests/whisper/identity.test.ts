/**
 * identity.test.ts — the two asymmetric halves a seat carries, and why they are
 * two rather than one.
 *
 * SIGNING half: peerId = sha256(signing pubkey), so the roster is already a set
 * of public-key commitments and a fold's or message's author is checkable by
 * anyone with no key distribution at all. It must never rotate — rotating it
 * would make the seat a different seat.
 *
 * AGREEMENT half: deliberately NOT committed to by peerId, precisely so it CAN
 * rotate. Two protocol properties depend on that:
 *   REMOVAL becomes cryptographic. A fold's entropy is the secret that advances
 *   the epoch root. Shipped in cleartext, the only thing withholding it from a
 *   removed member is that nobody relayed the frame — and they still hold the
 *   previous root, so the commit packet IS the secret. Sealed to each REMAINING
 *   member, a removed seat cannot derive the new root even given the whole frame.
 *   HEALING becomes possible. An attacker holding a compromised seat's old
 *   agreement key cannot read anything sealed to its replacement, so the seat
 *   recovers without changing identity.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateIdentity,
  generateAgreementKey,
  peerIdFromPublicKey,
  signBytes,
  verifyAuthored,
  sealToAgreement,
  openFromAgreement,
  PUBKEY_LEN,
  SIGNATURE_LEN,
  PEER_ID_LEN,
} from "../../src/scripts/whisper/campfire/identity.js";
import { toHex } from "../../src/scripts/whisper/wasm.js";

const TE = new TextEncoder();
const INFO = TE.encode("kizuna-fold-entropy-v1");

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

describe("identity — the signing half (self-certifying names)", () => {
  it("a seat id is the commitment to its signing key", async () => {
    const id = await generateIdentity();
    assert.equal(id.publicKey.length, PUBKEY_LEN);
    assert.equal(id.peerId.length, PEER_ID_LEN);
    assert.equal(toHex(await peerIdFromPublicKey(id.publicKey)), id.peerIdHex,
      "the roster entry IS the key commitment; that is why no directory is needed");
  });

  it("a signature verifies only under the seat the roster names", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const body = TE.encode("an epoch fold");
    const sig = await signBytes(alice, body);

    assert.equal(sig.length, SIGNATURE_LEN);
    assert.ok(await verifyAuthored(alice.publicKey, alice.peerIdHex, body, sig), "genuine");
    // THE attack the commitment prevents: sign with your own key, claim another seat
    assert.ok(!(await verifyAuthored(bob.publicKey, alice.peerIdHex, body, await signBytes(bob, body))),
      "key substitution: bob signs, claims alice's seat");
    assert.ok(!(await verifyAuthored(alice.publicKey, bob.peerIdHex, body, sig)),
      "alice's signature under bob's claimed identity");
  });

  it("stays total on malformed keys and signatures", async () => {
    const id = await generateIdentity();
    const body = TE.encode("x");
    const sig = await signBytes(id, body);
    const tampered = body.slice(); tampered[0] ^= 0xff;
    const badSig = sig.slice(); badSig[0] ^= 0xff;

    assert.ok(!(await verifyAuthored(id.publicKey, id.peerIdHex, tampered, sig)), "tampered body");
    assert.ok(!(await verifyAuthored(id.publicKey, id.peerIdHex, body, badSig)), "tampered signature");
    assert.ok(!(await verifyAuthored(id.publicKey.subarray(0, 32), id.peerIdHex, body, sig)), "short key");
    assert.ok(!(await verifyAuthored(new Uint8Array(33).fill(9), id.peerIdHex, body, sig)),
      "a point not on the curve is rejected, not thrown");
  });
});

describe("identity — the agreement half (removal and healing)", () => {
  it("seals to a recipient and only that recipient opens it", async () => {
    const bob = await generateIdentity();
    const eve = await generateIdentity();
    const entropy = new Uint8Array(32).fill(0x5a);

    const sealed = await sealToAgreement(bob.agreement.publicKey, entropy, INFO);
    assert.ok(sealed, "seal succeeded");
    assert.equal(sealed!.length, PUBKEY_LEN + 48, "[ephemeral 33][ciphertext+tag 48]");
    assert.ok(bytesEqual(await openFromAgreement(bob.agreement, sealed!, INFO), entropy), "recipient opens");

    // THIS is what makes a removal cryptographic rather than transport-conditional
    assert.equal(await openFromAgreement(eve.agreement, sealed!, INFO), null,
      "a removed member cannot open the entropy even holding the whole frame");
  });

  it("ROTATION HEALS: the old key cannot open what the new key can", async () => {
    const bob = await generateIdentity();
    const compromised = bob.agreement;           // what an attacker took
    const rotated = await generateAgreementKey(); // bob's recovery
    const entropy = new Uint8Array(32).fill(0x11);

    const sealed = await sealToAgreement(rotated.publicKey, entropy, INFO);
    assert.ok(bytesEqual(await openFromAgreement(rotated, sealed!, INFO), entropy), "bob recovers");
    assert.equal(await openFromAgreement(compromised, sealed!, INFO), null,
      "the attacker's copy of the old key is now worthless");
    // and the seat keeps its name, so the roster does not churn
    assert.equal(toHex(await peerIdFromPublicKey(bob.publicKey)), bob.peerIdHex,
      "identity survives rotation: peerId commits to the SIGNING key only");
  });

  it("every seal is fresh, so the same secret never repeats on the wire", async () => {
    const bob = await generateIdentity();
    const entropy = new Uint8Array(32).fill(7);
    const a = await sealToAgreement(bob.agreement.publicKey, entropy, INFO);
    const b = await sealToAgreement(bob.agreement.publicKey, entropy, INFO);
    assert.notEqual(toHex(a!), toHex(b!), "a fresh ephemeral per seal");
    // both still open: freshness is not at the cost of correctness
    assert.ok(bytesEqual(await openFromAgreement(bob.agreement, a!, INFO), entropy));
    assert.ok(bytesEqual(await openFromAgreement(bob.agreement, b!, INFO), entropy));
  });

  it("open stays total on tampered, truncated and wrong-context input", async () => {
    const bob = await generateIdentity();
    const entropy = new Uint8Array(32).fill(3);
    const sealed = (await sealToAgreement(bob.agreement.publicKey, entropy, INFO))!;

    const badCt = sealed.slice(); badCt[40] ^= 0xff;
    const badEph = sealed.slice(); badEph[0] ^= 0xff;
    assert.equal(await openFromAgreement(bob.agreement, badCt, INFO), null, "tampered ciphertext");
    assert.equal(await openFromAgreement(bob.agreement, badEph, INFO), null, "tampered ephemeral");
    assert.equal(await openFromAgreement(bob.agreement, sealed.subarray(0, 80), INFO), null, "truncated");
    assert.equal(await openFromAgreement(bob.agreement, sealed, TE.encode("other context")), null,
      "the info string binds the seal to its purpose");
    assert.equal(await sealToAgreement(new Uint8Array(10), entropy, INFO), null, "short recipient key");
  });
});
