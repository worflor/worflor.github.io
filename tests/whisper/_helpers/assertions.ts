/**
 * Test assertion helpers for Whisper test suite.
 */

import assert from "node:assert/strict";

/** Compare two Uint8Arrays byte-by-byte with a descriptive message on failure. */
export function assertBytesEqual(a: Uint8Array, b: Uint8Array, msg?: string): void {
  const label = msg ? `${msg}: ` : "";
  assert.equal(a.length, b.length, `${label}length mismatch (${a.length} vs ${b.length})`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}byte mismatch at index ${i}: 0x${a[i].toString(16).padStart(2, "0")} vs 0x${b[i].toString(16).padStart(2, "0")}`);
    }
  }
}

/** Generic encode/decode round-trip helper. */
export function assertRoundTrip<T>(
  encode: (data: T) => Uint8Array,
  decode: (encoded: Uint8Array, ...extra: any[]) => T,
  data: T,
  label: string,
  compare?: (a: T, b: T) => void,
  ...decodeExtra: any[]
): void {
  const encoded = encode(data);
  const decoded = decode(encoded, ...decodeExtra);
  if (compare) {
    compare(data, decoded);
  } else if (data instanceof Uint8Array && decoded instanceof Uint8Array) {
    assertBytesEqual(data, decoded, label);
  } else {
    assert.deepStrictEqual(decoded, data, `${label}: round-trip mismatch`);
  }
}
