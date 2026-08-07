/**
 * Seed corpus for protocol-decrypt.fuzz.cjs.
 *
 * Random bytes essentially never form a parseable full header — the flag byte
 * must clear LIVE_FLAG_SAME_KEY and 46 bytes must be present — so an unseeded
 * fuzzer spends its whole budget in the length check and never reaches the DH
 * ratchet, which is where the interesting failures live. These seeds put it
 * there on the first input: real frames, and frames that are real everywhere
 * except the 33 bytes claiming to be a P-256 point.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { establishChannel, encrypt, decrypt } from "../_harness/channel.js";

const outDir = join(import.meta.dirname, "corpus", "protocol-decrypt");
mkdirSync(outDir, { recursive: true });

const TE = new TextEncoder();
const ch = await establishChannel(new Uint8Array(32).fill(0x5a));

// bootstrap so both directions have fired a DH ratchet
await decrypt(ch.answerer, await encrypt(ch.offerer, TE.encode("boot-0"), new Uint8Array([1, 2, 3, 4])));
await decrypt(ch.offerer, await encrypt(ch.answerer, TE.encode("boot-1"), new Uint8Array([5, 6, 7, 8])));

let n = 0;
const write = (name: string, bytes: Uint8Array) => {
  writeFileSync(join(outDir, `${name}.bin`), bytes);
  n++;
};

for (let i = 0; i < 6; i++) {
  const wire = await encrypt(ch.offerer, TE.encode(`seed payload ${i} ${"x".repeat(i * 7)}`),
    new Uint8Array([i, 1, 2, 3]));
  write(`real-${i}`, wire);

  // the pubkey field, bit-flipped: the shape that was escaping by exception
  for (const bit of [0, 3, 7]) {
    const bad = wire.slice();
    bad[1 + ((i * 5 + bit) % 33)] ^= 1 << bit;
    write(`badkey-${i}-${bit}`, bad);
  }

  // a header that is structurally fine but truncated mid-ciphertext
  write(`short-${i}`, wire.slice(0, 46 + 16));

  // counter jumped far ahead: drives the skip path toward MAX_SKIP
  const jumped = wire.slice();
  jumped[34] = 0xff; jumped[35] = 0xff;
  write(`jump-${i}`, jumped);
}

console.log(`wrote ${n} seeds to ${outDir}`);
