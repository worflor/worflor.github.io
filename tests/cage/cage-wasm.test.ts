/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  getLastCageWasmRuntimeInfo,
  profileBytesWithWasm,
  type CageWasmProfile,
} from "../../src/scripts/cage/wasm";
import {
  buildChallengeVectors,
  loadFixtures,
  oracleProfileForBytes,
  sha256Hex,
  type LoadedFixture,
} from "./cage-test-helpers";

function assertProfilesEqual(actual: CageWasmProfile, expected: CageWasmProfile): void {
  assert.equal(actual.scannedLength, expected.scannedLength, "scannedLength mismatch");
  assert.equal(actual.truncated, expected.truncated, "truncated flag mismatch");
  assert.equal(actual.stepBudget, expected.stepBudget, "stepBudget mismatch");
  assert.equal(actual.nullCount, expected.nullCount, "nullCount mismatch");
  assert.equal(actual.slashCount, expected.slashCount, "slashCount mismatch");
  assert.equal(actual.backslashCount, expected.backslashCount, "backslashCount mismatch");
  assert.equal(actual.colonCount, expected.colonCount, "colonCount mismatch");
  assert.equal(actual.semicolonCount, expected.semicolonCount, "semicolonCount mismatch");
  assert.equal(actual.schemePairCount, expected.schemePairCount, "schemePairCount mismatch");
  assert.equal(actual.doubleSlashCount, expected.doubleSlashCount, "doubleSlashCount mismatch");
  assert.equal(actual.schemeTripletCount, expected.schemeTripletCount, "schemeTripletCount mismatch");
  assert.equal(actual.vmTraceScore, expected.vmTraceScore, "vmTraceScore mismatch");
  assert.equal(actual.nearCallCount, expected.nearCallCount, "nearCallCount mismatch");
  assert.equal(actual.relJumpCount, expected.relJumpCount, "relJumpCount mismatch");
  assert.equal(actual.shortJumpCount, expected.shortJumpCount, "shortJumpCount mismatch");
  assert.equal(actual.int3Count, expected.int3Count, "int3Count mismatch");
  assert.equal(actual.retCount, expected.retCount, "retCount mismatch");
  assert.equal(actual.syscallPairCount, expected.syscallPairCount, "syscallPairCount mismatch");
  assert.equal(actual.int80PairCount, expected.int80PairCount, "int80PairCount mismatch");
  assert.equal(actual.rdtscPairCount, expected.rdtscPairCount, "rdtscPairCount mismatch");
  assert.equal(actual.cpuidPairCount, expected.cpuidPairCount, "cpuidPairCount mismatch");
}

function assertFixtureIntegrity(fixture: LoadedFixture): void {
  assert.equal(fixture.bytes.length, fixture.size, `${fixture.id}: size drift`);
  assert.equal(sha256Hex(fixture.bytes), fixture.sha256, `${fixture.id}: sha256 drift`);
}

test("fixture manifest is tamper-evident", () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 2, "expected at least two Cage fixtures");
  for (const fixture of fixtures) {
    assertFixtureIntegrity(fixture);
  }
});

test("empty input returns deterministic fallback metadata", async () => {
  const result = await profileBytesWithWasm(new Uint8Array(0));
  assert.equal(result.profile, null);
  assert.equal(result.runtime.state, "fallback");
  assert.equal(result.runtime.code, "empty-input");
  assert.equal(result.runtime.stage, "profile-run");
  assert.equal(result.sampledBytes, 0);
  assert.equal(result.truncated, false);
});

test("fixture vectors match JS oracle exactly", async () => {
  const fixtures = loadFixtures();
  for (const fixture of fixtures) {
    assertFixtureIntegrity(fixture);
    const expected = oracleProfileForBytes(fixture.bytes);
    const result = await profileBytesWithWasm(fixture.bytes);
    assert.equal(result.runtime.state, "active", `${fixture.id}: runtime not active`);
    assert.equal(result.runtime.code, "ok", `${fixture.id}: runtime not ok`);
    assert.ok(result.profile, `${fixture.id}: profile missing`);
    assertProfilesEqual(result.profile, expected);
  }
});

test("challenge vectors cannot be spoofed with static outputs", async () => {
  const vectors = buildChallengeVectors(24, 4096);
  const expected = vectors.map((bytes) => oracleProfileForBytes(bytes));
  const results = await Promise.all(vectors.map((bytes) => profileBytesWithWasm(bytes)));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const oracle = expected[i];
    assert.equal(result.runtime.state, "active", `vector ${i}: runtime not active`);
    assert.ok(result.profile, `vector ${i}: missing profile`);
    assertProfilesEqual(result.profile, oracle);
  }
});

test("truncation and step budget clamps are enforced", async () => {
  const overLimitSize = (8 * 1024 * 1024) + 777;
  const large = new Uint8Array(overLimitSize);
  for (let i = 0; i < large.length; i++) {
    large[i] = i & 0xff;
  }
  const result = await profileBytesWithWasm(large);
  assert.equal(result.runtime.state, "active");
  assert.ok(result.profile);
  assert.equal(result.profile.truncated, true);
  assert.equal(result.profile.scannedLength, 8 * 1024 * 1024);
  assert.equal(result.profile.stepBudget, 240_000);

  const oracle = oracleProfileForBytes(large);
  assertProfilesEqual(result.profile, oracle);
});

test("runtime state snapshot reflects latest successful run", async () => {
  const [fixture] = loadFixtures();
  const result = await profileBytesWithWasm(fixture.bytes);
  assert.ok(result.profile);
  const runtime = getLastCageWasmRuntimeInfo();
  assert.equal(runtime.state, "active");
  assert.equal(runtime.code, "ok");
  assert.equal(runtime.stage, "ready");
});
