/// <reference types="node" />

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CageWasmProfile } from "../../src/scripts/cage/wasm";

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;
const VM_TRACE_MAX_STEPS = 240_000;
const VM_TRACE_SEED = -1640531527;

interface FixtureManifestEntry {
  id: string;
  file: string;
  size: number;
  sha256: string;
  description: string;
}

interface FixtureManifest {
  version: number;
  generatedAt: string;
  fixtures: FixtureManifestEntry[];
}

export interface LoadedFixture {
  id: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
  description: string;
}

function fixtureRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "fixtures");
}

function readManifest(): FixtureManifest {
  const manifestPath = path.join(fixtureRootDir(), "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as FixtureManifest;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function loadFixtures(): LoadedFixture[] {
  const manifest = readManifest();
  const root = fixtureRootDir();
  return manifest.fixtures.map((fixture) => {
    const fixturePath = path.join(root, fixture.file);
    const bytes = new Uint8Array(readFileSync(fixturePath));
    return {
      id: fixture.id,
      bytes,
      size: fixture.size,
      sha256: fixture.sha256.toLowerCase(),
      description: fixture.description,
    };
  });
}

function rotl32(value: number, shift: number): number {
  const s = shift & 31;
  return ((value << s) | (value >>> (32 - s))) | 0;
}

function countByte(bytes: Uint8Array, target: number): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === target) count += 1;
  }
  return count;
}

function countPair(bytes: Uint8Array, a: number, b: number): number {
  if (bytes.length < 2) return 0;
  let count = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === a && bytes[i + 1] === b) count += 1;
  }
  return count;
}

function countTriplet(bytes: Uint8Array, a: number, b: number, c: number): number {
  if (bytes.length < 3) return 0;
  let count = 0;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c) count += 1;
  }
  return count;
}

function vmTrace(bytes: Uint8Array, seed: number, maxSteps: number): number {
  let acc = seed | 0;
  let score = 0;
  const limit = Math.min(bytes.length, Math.max(0, maxSteps | 0));
  for (let i = 0; i < limit; i++) {
    const b = bytes[i];
    acc = rotl32((acc ^ b) | 0, b & 7);
    if (b === 0x90) score += 1;
    if (b === 0xcc) score += 1;
    if (b === 0x00) score += 1;
    if ((acc & 0xff) === 0x42) score += 2;
  }
  return (score + (acc & 0x0f)) | 0;
}

export function oracleProfileForBytes(bytes: Uint8Array): CageWasmProfile {
  const len = Math.min(bytes.length, MAX_PROFILE_BYTES);
  const sampled = bytes.subarray(0, len);
  const stepBudget = Math.min(len, VM_TRACE_MAX_STEPS);
  return {
    wasm: true,
    scannedLength: len,
    truncated: len !== bytes.length,
    stepBudget,
    nullCount: countByte(sampled, 0x00),
    slashCount: countByte(sampled, 0x2f),
    backslashCount: countByte(sampled, 0x5c),
    colonCount: countByte(sampled, 0x3a),
    semicolonCount: countByte(sampled, 0x3b),
    schemePairCount: countPair(sampled, 0x3a, 0x2f),
    doubleSlashCount: countPair(sampled, 0x2f, 0x2f),
    schemeTripletCount: countTriplet(sampled, 0x3a, 0x2f, 0x2f),
    vmTraceScore: vmTrace(sampled, VM_TRACE_SEED, stepBudget),
    nearCallCount: countByte(sampled, 0xe8),
    relJumpCount: countByte(sampled, 0xe9),
    shortJumpCount: countByte(sampled, 0xeb),
    int3Count: countByte(sampled, 0xcc),
    retCount: countByte(sampled, 0xc3),
    syscallPairCount: countPair(sampled, 0x0f, 0x05),
    int80PairCount: countPair(sampled, 0xcd, 0x80),
    rdtscPairCount: countPair(sampled, 0x0f, 0x31),
    cpuidPairCount: countPair(sampled, 0x0f, 0xa2),
  };
}

function hashChainBlock(seedLabel: string, blockIndex: number): Buffer {
  return createHash("sha256")
    .update(`${seedLabel}:${blockIndex}`)
    .digest();
}

export function buildChallengeVectors(vectorCount: number, bytesPerVector: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < vectorCount; i++) {
    const bytes = new Uint8Array(bytesPerVector);
    let offset = 0;
    let block = 0;
    while (offset < bytesPerVector) {
      const digest = hashChainBlock(`cage-challenge-${i}`, block++);
      const take = Math.min(digest.length, bytesPerVector - offset);
      bytes.set(digest.subarray(0, take), offset);
      offset += take;
    }

    // Inject deterministic opcode signatures so challenge vectors hit key scanners.
    for (let p = 96; p < bytes.length - 8; p += 257) {
      bytes[p] = 0x0f;
      bytes[p + 1] = 0x31;
      bytes[p + 2] = 0x0f;
      bytes[p + 3] = 0xa2;
      bytes[p + 4] = 0x0f;
      bytes[p + 5] = 0x05;
      bytes[p + 6] = 0xcd;
      bytes[p + 7] = 0x80;
    }
    out.push(bytes);
  }
  return out;
}
