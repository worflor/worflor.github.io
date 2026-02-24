export interface CageWasmProfile {
  wasm: true;
  scannedLength: number;
  truncated: boolean;
  stepBudget: number;
  nullCount: number;
  slashCount: number;
  backslashCount: number;
  colonCount: number;
  semicolonCount: number;
  schemePairCount: number;
  doubleSlashCount: number;
  schemeTripletCount: number;
  vmTraceScore: number;
  nearCallCount: number;
  relJumpCount: number;
  shortJumpCount: number;
  int3Count: number;
  retCount: number;
  syscallPairCount: number;
  int80PairCount: number;
  rdtscPairCount: number;
  cpuidPairCount: number;
}

export type CageWasmStage =
  | "support-check"
  | "module-build"
  | "module-validate"
  | "module-compile"
  | "module-instantiate"
  | "export-check"
  | "runtime-probe"
  | "core-init"
  | "profile-run"
  | "profile-output"
  | "ready";

export type CageWasmRunCode =
  | "ok"
  | "empty-input"
  | "unsupported"
  | "compile-backoff"
  | "compile-failed"
  | "init-backoff"
  | "init-failed"
  | "profile-failed";

type CageWasmFallbackCode = Exclude<CageWasmRunCode, "ok">;
type CageWasmErrorCode = Exclude<CageWasmRunCode, "ok" | "empty-input">;

export interface CageWasmRunInfo {
  state: "active" | "fallback";
  code: CageWasmRunCode;
  stage: CageWasmStage;
  detail: string;
  retryAt: number | null;
  timestamp: string;
}

export interface CageWasmProfileResult {
  profile: CageWasmProfile | null;
  runtime: CageWasmRunInfo;
  sampledBytes: number;
  truncated: boolean;
}

interface CageWasmExports {
  memory: WebAssembly.Memory;
  count_byte: (ptr: number, len: number, target: number) => number;
  count_pair: (ptr: number, len: number, a: number, b: number) => number;
  count_triplet: (ptr: number, len: number, a: number, b: number, c: number) => number;
  vm_trace: (ptr: number, len: number, seed: number, maxSteps: number) => number;
}

interface RetryGate {
  failures: number;
  nextRetryAt: number;
}

const PAGE_SIZE = 64 * 1024;
const I32 = 0x7f;
const BLOCK_VOID = 0x40;

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;
const PAYLOAD_OFFSET = 4096;
const PAYLOAD_PADDING = 128;
const PROBE_OFFSET = 64;
const VM_TRACE_MAX_STEPS = 240_000;
const RETRY_BASE_MS = 1200;
const RETRY_MAX_MS = 30_000;
const LOG_PREFIX = "[cage-wasm]";

let compiledModulePromise: Promise<WebAssembly.Module> | null = null;
let wasmCorePromise: Promise<CageWasmCore> | null = null;
const compileRetryGate: RetryGate = { failures: 0, nextRetryAt: 0 };
const initRetryGate: RetryGate = { failures: 0, nextRetryAt: 0 };
let lastRuntimeLogFingerprint = "";
let lastRuntimeInfo: CageWasmRunInfo = {
  state: "fallback",
  code: "unsupported",
  stage: "support-check",
  detail: "Cage WASM runtime has not initialized.",
  retryAt: null,
  timestamp: new Date().toISOString(),
};

class CageWasmError extends Error {
  constructor(
    readonly code: CageWasmErrorCode,
    readonly stage: CageWasmStage,
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "CageWasmError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown WASM runtime error.";
}

function buildRuntimeInfo(
  state: "active" | "fallback",
  code: CageWasmRunCode,
  stage: CageWasmStage,
  detail: string,
  retryAt: number | null,
): CageWasmRunInfo {
  return {
    state,
    code,
    stage,
    detail,
    retryAt,
    timestamp: nowIso(),
  };
}

function setRuntimeInfo(info: CageWasmRunInfo, shouldLog: boolean): CageWasmRunInfo {
  lastRuntimeInfo = info;
  if (!shouldLog) return info;

  const fingerprint = `${info.code}|${info.stage}|${info.retryAt ?? -1}|${info.detail}`;
  if (fingerprint !== lastRuntimeLogFingerprint) {
    const retryText = info.retryAt ? ` retryAt=${new Date(info.retryAt).toISOString()}` : "";
    console.warn(`${LOG_PREFIX} ${info.code} stage=${info.stage} ${info.detail}${retryText}`);
    lastRuntimeLogFingerprint = fingerprint;
  }
  return info;
}

function reportFallback(
  code: CageWasmFallbackCode,
  stage: CageWasmStage,
  detail: string,
  retryAt: number | null,
): CageWasmRunInfo {
  return setRuntimeInfo(buildRuntimeInfo("fallback", code, stage, detail, retryAt), true);
}

function reportActive(detail: string): CageWasmRunInfo {
  lastRuntimeLogFingerprint = "";
  return setRuntimeInfo(buildRuntimeInfo("active", "ok", "ready", detail, null), false);
}

function snapshotRuntimeInfo(): CageWasmRunInfo {
  return { ...lastRuntimeInfo };
}

function normalizeWasmError(
  error: unknown,
  fallbackCode: CageWasmErrorCode,
  fallbackStage: CageWasmStage,
  retryAt: number | null = null,
): CageWasmError {
  if (error instanceof CageWasmError) return error;
  return new CageWasmError(fallbackCode, fallbackStage, errorMessage(error), retryAt);
}

function resetRetryGate(gate: RetryGate): void {
  gate.failures = 0;
  gate.nextRetryAt = 0;
}

function scheduleRetry(gate: RetryGate): number {
  gate.failures += 1;
  const exponent = Math.min(gate.failures - 1, 6);
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (1 << exponent));
  gate.nextRetryAt = Date.now() + delay;
  return gate.nextRetryAt;
}

function remainingBackoffMs(gate: RetryGate): number {
  return Math.max(0, gate.nextRetryAt - Date.now());
}

function assertWasmSupport(): void {
  if (
    typeof WebAssembly === "undefined" ||
    typeof WebAssembly.Memory !== "function" ||
    typeof WebAssembly.compile !== "function" ||
    typeof WebAssembly.instantiate !== "function" ||
    typeof WebAssembly.validate !== "function"
  ) {
    throw new CageWasmError("unsupported", "support-check", "WebAssembly APIs are unavailable in this browser.");
  }
}

function encodeU32(value: number): number[] {
  let v = value >>> 0;
  const out: number[] = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function encodeS32(value: number): number[] {
  let v = value | 0;
  const out: number[] = [];
  let done = false;
  while (!done) {
    let byte = v & 0x7f;
    v >>= 7;
    const signBitSet = (byte & 0x40) !== 0;
    const shouldStop = (v === 0 && !signBitSet) || (v === -1 && signBitSet);
    if (!shouldStop) byte |= 0x80;
    out.push(byte);
    done = shouldStop;
  }
  return out;
}

function encodeName(name: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(name));
  return [...encodeU32(bytes.length), ...bytes];
}

function makeSection(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function localGet(index: number): number[] {
  return [0x20, ...encodeU32(index)];
}

function localSet(index: number): number[] {
  return [0x21, ...encodeU32(index)];
}

function i32Const(value: number): number[] {
  return [0x41, ...encodeS32(value)];
}

function br(label: number): number[] {
  return [0x0c, ...encodeU32(label)];
}

function brIf(label: number): number[] {
  return [0x0d, ...encodeU32(label)];
}

type LocalDecl = { count: number; type: number };

function encodeLocalDecls(decls: LocalDecl[]): number[] {
  const out: number[] = [...encodeU32(decls.length)];
  for (const decl of decls) {
    out.push(...encodeU32(decl.count), decl.type);
  }
  return out;
}

function encodeFuncBody(decls: LocalDecl[], instructions: number[]): number[] {
  const body = [...encodeLocalDecls(decls), ...instructions];
  return [...encodeU32(body.length), ...body];
}

function buildCountByteBody(): number[] {
  const instructions: number[] = [
    ...i32Const(0), ...localSet(3), // i = 0
    ...i32Const(0), ...localSet(4), // count = 0
    0x02, BLOCK_VOID, // block
    0x03, BLOCK_VOID, // loop
    ...localGet(3), ...localGet(1), 0x4f, ...brIf(1), // i >= len -> break
    ...localGet(0), ...localGet(3), 0x6a, 0x2d, 0x00, 0x00, ...localSet(5), // b = data[i]
    ...localGet(4), ...localGet(5), ...localGet(2), 0x46, 0x6a, ...localSet(4), // count += (b == target)
    ...localGet(3), ...i32Const(1), 0x6a, ...localSet(3), // i++
    ...br(0),
    0x0b, // end loop
    0x0b, // end block
    ...localGet(4),
    0x0b, // end func
  ];
  return encodeFuncBody([{ count: 3, type: I32 }], instructions);
}

function buildCountPairBody(): number[] {
  const instructions: number[] = [
    ...i32Const(0), ...localSet(4), // i = 0
    ...i32Const(0), ...localSet(5), // count = 0
    0x02, BLOCK_VOID, // block
    ...localGet(1), ...i32Const(2), 0x49, ...brIf(0), // if len < 2 break
    0x03, BLOCK_VOID, // loop
    ...localGet(4), ...localGet(1), ...i32Const(1), 0x6b, 0x4f, ...brIf(1), // if i >= len-1 break
    ...localGet(0), ...localGet(4), 0x6a, 0x2d, 0x00, 0x00, ...localSet(6), // b0
    ...localGet(0), ...localGet(4), ...i32Const(1), 0x6a, 0x6a, 0x2d, 0x00, 0x00, ...localSet(7), // b1
    ...localGet(6), ...localGet(2), 0x46,
    ...localGet(7), ...localGet(3), 0x46,
    0x71, // and
    0x04, BLOCK_VOID, // if
    ...localGet(5), ...i32Const(1), 0x6a, ...localSet(5), // count++
    0x0b, // end if
    ...localGet(4), ...i32Const(1), 0x6a, ...localSet(4), // i++
    ...br(0),
    0x0b, // end loop
    0x0b, // end block
    ...localGet(5),
    0x0b, // end func
  ];
  return encodeFuncBody([{ count: 4, type: I32 }], instructions);
}

function buildCountTripletBody(): number[] {
  const instructions: number[] = [
    ...i32Const(0), ...localSet(5), // i = 0
    ...i32Const(0), ...localSet(6), // count = 0
    0x02, BLOCK_VOID, // block
    ...localGet(1), ...i32Const(3), 0x49, ...brIf(0), // if len < 3 break
    0x03, BLOCK_VOID, // loop
    ...localGet(5), ...localGet(1), ...i32Const(2), 0x6b, 0x4f, ...brIf(1), // if i >= len-2 break
    ...localGet(0), ...localGet(5), 0x6a, 0x2d, 0x00, 0x00, ...localSet(7), // b0
    ...localGet(0), ...localGet(5), ...i32Const(1), 0x6a, 0x6a, 0x2d, 0x00, 0x00, ...localSet(8), // b1
    ...localGet(0), ...localGet(5), ...i32Const(2), 0x6a, 0x6a, 0x2d, 0x00, 0x00, ...localSet(9), // b2
    ...localGet(7), ...localGet(2), 0x46,
    ...localGet(8), ...localGet(3), 0x46,
    0x71,
    ...localGet(9), ...localGet(4), 0x46,
    0x71,
    0x04, BLOCK_VOID, // if
    ...localGet(6), ...i32Const(1), 0x6a, ...localSet(6), // count++
    0x0b, // end if
    ...localGet(5), ...i32Const(1), 0x6a, ...localSet(5), // i++
    ...br(0),
    0x0b, // end loop
    0x0b, // end block
    ...localGet(6),
    0x0b, // end func
  ];
  return encodeFuncBody([{ count: 5, type: I32 }], instructions);
}

function buildVmTraceBody(): number[] {
  const instructions: number[] = [
    ...i32Const(0), ...localSet(4), // i = 0
    ...localGet(2), ...localSet(5), // acc = seed
    ...i32Const(0), ...localSet(6), // score = 0
    0x02, BLOCK_VOID, // block
    0x03, BLOCK_VOID, // loop
    ...localGet(4), ...localGet(1), 0x4f, ...brIf(1), // i >= len
    ...localGet(4), ...localGet(3), 0x4f, ...brIf(1), // i >= maxSteps
    ...localGet(0), ...localGet(4), 0x6a, 0x2d, 0x00, 0x00, ...localSet(7), // b
    // acc = rotl(acc xor b, b & 7)
    ...localGet(5), ...localGet(7), 0x73,
    ...localGet(7), ...i32Const(7), 0x71,
    0x77,
    ...localSet(5),
    // score += (b==0x90) + (b==0xcc) + (b==0)
    ...localGet(6),
    ...localGet(7), ...i32Const(0x90), 0x46,
    ...localGet(7), ...i32Const(0xcc), 0x46,
    0x6a,
    ...localGet(7), 0x45,
    0x6a,
    0x6a,
    ...localSet(6),
    // score += (((acc & 0xff) == 0x42) * 2)
    ...localGet(6),
    ...localGet(5), ...i32Const(0xff), 0x71,
    ...i32Const(0x42), 0x46,
    ...i32Const(2), 0x6c,
    0x6a,
    ...localSet(6),
    ...localGet(4), ...i32Const(1), 0x6a, ...localSet(4), // i++
    ...br(0),
    0x0b, // end loop
    0x0b, // end block
    ...localGet(6),
    ...localGet(5), ...i32Const(0x0f), 0x71,
    0x6a,
    0x0b, // end func
  ];
  return encodeFuncBody([{ count: 4, type: I32 }], instructions);
}

function buildCageMicroVmModuleBinary(): Uint8Array {
  const magicAndVersion = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  const typeSection = makeSection(1, [
    ...encodeU32(3),
    // type 0: (i32, i32, i32) -> i32
    0x60, ...encodeU32(3), I32, I32, I32, ...encodeU32(1), I32,
    // type 1: (i32, i32, i32, i32) -> i32
    0x60, ...encodeU32(4), I32, I32, I32, I32, ...encodeU32(1), I32,
    // type 2: (i32, i32, i32, i32, i32) -> i32
    0x60, ...encodeU32(5), I32, I32, I32, I32, I32, ...encodeU32(1), I32,
  ]);

  const functionSection = makeSection(3, [
    ...encodeU32(4),
    ...encodeU32(0), // count_byte
    ...encodeU32(1), // count_pair
    ...encodeU32(2), // count_triplet
    ...encodeU32(1), // vm_trace
  ]);

  const memorySection = makeSection(5, [
    ...encodeU32(1),
    0x00, // min only
    ...encodeU32(2), // 2 pages
  ]);

  const exportSection = makeSection(7, [
    ...encodeU32(5),
    ...encodeName("memory"), 0x02, ...encodeU32(0),
    ...encodeName("count_byte"), 0x00, ...encodeU32(0),
    ...encodeName("count_pair"), 0x00, ...encodeU32(1),
    ...encodeName("count_triplet"), 0x00, ...encodeU32(2),
    ...encodeName("vm_trace"), 0x00, ...encodeU32(3),
  ]);

  const codeSection = makeSection(10, [
    ...encodeU32(4),
    ...buildCountByteBody(),
    ...buildCountPairBody(),
    ...buildCountTripletBody(),
    ...buildVmTraceBody(),
  ]);

  return new Uint8Array([
    ...magicAndVersion,
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ]);
}

function extractExports(instance: WebAssembly.Instance): CageWasmExports | null {
  const exported = instance.exports as unknown as Partial<CageWasmExports>;
  if (
    !exported.memory ||
    typeof exported.count_byte !== "function" ||
    typeof exported.count_pair !== "function" ||
    typeof exported.count_triplet !== "function" ||
    typeof exported.vm_trace !== "function"
  ) {
    return null;
  }
  return exported as CageWasmExports;
}

function ensureMemoryCapacity(memory: WebAssembly.Memory, requiredBytes: number): void {
  if (requiredBytes <= memory.buffer.byteLength) return;
  if (requiredBytes > MAX_MEMORY_BYTES) {
    throw new Error(`Cage WASM arena limit exceeded (${requiredBytes} > ${MAX_MEMORY_BYTES}).`);
  }
  const missing = requiredBytes - memory.buffer.byteLength;
  const pagesNeeded = Math.ceil(missing / PAGE_SIZE);
  memory.grow(pagesNeeded);
}

class CageWasmCore {
  private runTail: Promise<void> = Promise.resolve();
  private lastPayloadLength = 0;
  private poisoned = false;

  private constructor(private readonly exports: CageWasmExports) {}

  static async create(): Promise<CageWasmCore> {
    const module = await getCompiledModule();

    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(module);
    } catch (error) {
      throw new CageWasmError("init-failed", "module-instantiate", errorMessage(error));
    }

    const exports = extractExports(instance);
    if (!exports) {
      throw new CageWasmError("init-failed", "export-check", "Required WASM exports are missing.");
    }
    CageWasmCore.validateRuntime(exports);
    return new CageWasmCore(exports);
  }

  private static validateRuntime(exports: CageWasmExports): void {
    try {
      ensureMemoryCapacity(exports.memory, PROBE_OFFSET + 16);
      const probe = new Uint8Array(exports.memory.buffer, PROBE_OFFSET, 8);
      probe.set([0x00, 0x2f, 0x2f, 0x3a, 0x2f, 0x2f, 0x0f, 0x05]);

      const ptr = PROBE_OFFSET;
      const len = 8;
      if (exports.count_byte(ptr, len, 0x2f) !== 4) {
        throw new Error("Probe mismatch in count_byte.");
      }
      if (exports.count_pair(ptr, len, 0x3a, 0x2f) !== 1) {
        throw new Error("Probe mismatch in count_pair.");
      }
      if (exports.count_triplet(ptr, len, 0x3a, 0x2f, 0x2f) !== 1) {
        throw new Error("Probe mismatch in count_triplet.");
      }
      if (exports.vm_trace(ptr, len, 1, len) < 0) {
        throw new Error("Probe mismatch in vm_trace.");
      }
    } catch (error) {
      throw new CageWasmError("init-failed", "runtime-probe", errorMessage(error));
    }
  }

  private async withRunLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.runTail;
    let release!: () => void;
    this.runTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    if (this.poisoned) {
      release();
      throw new CageWasmError("profile-failed", "profile-run", "WASM core poisoned by prior trap.");
    }
    try {
      return await fn();
    } catch (error) {
      this.poisoned = true;
      throw error;
    } finally {
      release();
    }
  }

  private writePayload(bytes: Uint8Array): { ptr: number; len: number; truncated: boolean } {
    const len = Math.min(bytes.length, MAX_PROFILE_BYTES);
    const truncated = len !== bytes.length;
    const wipeLength = Math.max(this.lastPayloadLength, len) + PAYLOAD_PADDING;
    const requiredBytes = PAYLOAD_OFFSET + wipeLength;
    ensureMemoryCapacity(this.exports.memory, requiredBytes);

    const arena = new Uint8Array(this.exports.memory.buffer, PAYLOAD_OFFSET, wipeLength);
    arena.fill(0);
    arena.set(bytes.subarray(0, len), 0);
    this.lastPayloadLength = len;

    return { ptr: PAYLOAD_OFFSET, len, truncated };
  }

  private validateCounter(name: string, value: number, upperBound: number): number {
    if (!Number.isInteger(value) || value < 0 || value > upperBound) {
      throw new CageWasmError("profile-failed", "profile-output", `Invalid WASM counter '${name}'=${value}.`);
    }
    return value;
  }

  private validateTraceScore(value: number): number {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      throw new CageWasmError("profile-failed", "profile-output", `Invalid WASM trace score '${value}'.`);
    }
    return value;
  }

  profile(bytes: Uint8Array): Promise<CageWasmProfile> {
    return this.withRunLock(() => {
      const { ptr, len, truncated } = this.writePayload(bytes);
      const stepBudget = Math.min(len, VM_TRACE_MAX_STEPS);
      const e = this.exports;

      const nullCount = this.validateCounter("nullCount", e.count_byte(ptr, len, 0x00), len);
      const slashCount = this.validateCounter("slashCount", e.count_byte(ptr, len, 0x2f), len);
      const backslashCount = this.validateCounter("backslashCount", e.count_byte(ptr, len, 0x5c), len);
      const colonCount = this.validateCounter("colonCount", e.count_byte(ptr, len, 0x3a), len);
      const semicolonCount = this.validateCounter("semicolonCount", e.count_byte(ptr, len, 0x3b), len);
      const schemePairCount = this.validateCounter("schemePairCount", e.count_pair(ptr, len, 0x3a, 0x2f), len);
      const doubleSlashCount = this.validateCounter("doubleSlashCount", e.count_pair(ptr, len, 0x2f, 0x2f), len);
      const schemeTripletCount = this.validateCounter("schemeTripletCount", e.count_triplet(ptr, len, 0x3a, 0x2f, 0x2f), len);
      const vmTraceScore = this.validateTraceScore(e.vm_trace(ptr, len, -1640531527, stepBudget));
      const nearCallCount = this.validateCounter("nearCallCount", e.count_byte(ptr, len, 0xe8), len);
      const relJumpCount = this.validateCounter("relJumpCount", e.count_byte(ptr, len, 0xe9), len);
      const shortJumpCount = this.validateCounter("shortJumpCount", e.count_byte(ptr, len, 0xeb), len);
      const int3Count = this.validateCounter("int3Count", e.count_byte(ptr, len, 0xcc), len);
      const retCount = this.validateCounter("retCount", e.count_byte(ptr, len, 0xc3), len);
      const syscallPairCount = this.validateCounter("syscallPairCount", e.count_pair(ptr, len, 0x0f, 0x05), len);
      const int80PairCount = this.validateCounter("int80PairCount", e.count_pair(ptr, len, 0xcd, 0x80), len);
      const rdtscPairCount = this.validateCounter("rdtscPairCount", e.count_pair(ptr, len, 0x0f, 0x31), len);
      const cpuidPairCount = this.validateCounter("cpuidPairCount", e.count_pair(ptr, len, 0x0f, 0xa2), len);

      return {
        wasm: true,
        scannedLength: len,
        truncated,
        stepBudget,
        nullCount,
        slashCount,
        backslashCount,
        colonCount,
        semicolonCount,
        schemePairCount,
        doubleSlashCount,
        schemeTripletCount,
        vmTraceScore,
        nearCallCount,
        relJumpCount,
        shortJumpCount,
        int3Count,
        retCount,
        syscallPairCount,
        int80PairCount,
        rdtscPairCount,
        cpuidPairCount,
      };
    });
  }
}

async function compileModuleBinary(): Promise<WebAssembly.Module> {
  let moduleBinary: Uint8Array;
  try {
    moduleBinary = buildCageMicroVmModuleBinary();
  } catch (error) {
    throw new CageWasmError("compile-failed", "module-build", errorMessage(error));
  }

  if (!WebAssembly.validate(moduleBinary)) {
    const retryAt = scheduleRetry(compileRetryGate);
    throw new CageWasmError(
      "compile-failed",
      "module-validate",
      "Generated Cage micro-VM binary failed WebAssembly.validate().",
      retryAt,
    );
  }

  try {
    const compiled = await WebAssembly.compile(moduleBinary);
    resetRetryGate(compileRetryGate);
    return compiled;
  } catch (error) {
    const retryAt = scheduleRetry(compileRetryGate);
    throw new CageWasmError("compile-failed", "module-compile", errorMessage(error), retryAt);
  }
}

async function getCompiledModule(): Promise<WebAssembly.Module> {
  assertWasmSupport();

  if (Date.now() < compileRetryGate.nextRetryAt) {
    const delay = remainingBackoffMs(compileRetryGate);
    throw new CageWasmError(
      "compile-backoff",
      "module-compile",
      `Compile retry backoff active (${delay}ms remaining).`,
      compileRetryGate.nextRetryAt,
    );
  }

  if (!compiledModulePromise) {
    compiledModulePromise = compileModuleBinary();
  }

  try {
    return await compiledModulePromise;
  } catch (error) {
    compiledModulePromise = null;
    throw normalizeWasmError(error, "compile-failed", "module-compile");
  }
}

async function getWasmCore(): Promise<CageWasmCore> {
  if (Date.now() < initRetryGate.nextRetryAt) {
    const delay = remainingBackoffMs(initRetryGate);
    throw new CageWasmError(
      "init-backoff",
      "core-init",
      `Core init retry backoff active (${delay}ms remaining).`,
      initRetryGate.nextRetryAt,
    );
  }

  if (!wasmCorePromise) {
    wasmCorePromise = (async () => {
      try {
        const core = await CageWasmCore.create();
        resetRetryGate(initRetryGate);
        return core;
      } catch (error) {
        const normalized = normalizeWasmError(error, "init-failed", "core-init");
        if (
          normalized.code === "unsupported" ||
          normalized.code === "compile-backoff" ||
          normalized.code === "compile-failed"
        ) {
          throw normalized;
        }
        const retryAt = normalized.retryAt ?? scheduleRetry(initRetryGate);
        throw new CageWasmError("init-failed", normalized.stage, normalized.message, retryAt);
      }
    })();
  }

  try {
    return await wasmCorePromise;
  } catch (error) {
    wasmCorePromise = null;
    throw error;
  }
}

export function getLastCageWasmRuntimeInfo(): CageWasmRunInfo {
  return snapshotRuntimeInfo();
}

export async function profileBytesWithWasm(bytes: Uint8Array): Promise<CageWasmProfileResult> {
  const sampledBytes = Math.min(bytes.length, MAX_PROFILE_BYTES);
  const truncated = bytes.length > sampledBytes;

  if (bytes.length === 0) {
    return {
      profile: null,
      runtime: reportFallback("empty-input", "profile-run", "Payload was empty; skipping WASM profile.", null),
      sampledBytes: 0,
      truncated: false,
    };
  }

  let core: CageWasmCore;
  try {
    core = await getWasmCore();
  } catch (error) {
    const normalized = normalizeWasmError(error, "init-failed", "core-init");
    return {
      profile: null,
      runtime: reportFallback(normalized.code, normalized.stage, normalized.message, normalized.retryAt),
      sampledBytes,
      truncated,
    };
  }

  try {
    const profile = await core.profile(bytes);
    return {
      profile,
      runtime: reportActive("WASM micro-VM core active."),
      sampledBytes: profile.scannedLength,
      truncated: profile.truncated,
    };
  } catch (error) {
    const retryAt = scheduleRetry(initRetryGate);
    wasmCorePromise = null;
    const normalized = normalizeWasmError(error, "profile-failed", "profile-run", retryAt);
    return {
      profile: null,
      runtime: reportFallback(normalized.code, normalized.stage, normalized.message, normalized.retryAt ?? retryAt),
      sampledBytes,
      truncated,
    };
  }
}
