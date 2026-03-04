// file-handoff.ts — local-only file handoff between Lens and Prism.
// Uses IndexedDB to keep the original File object in-browser (no upload).

const HANDOFF_DB_NAME = "woflo.fileHandoff";
const HANDOFF_STORE = "handoffs";
const HANDOFF_DB_VERSION = 1;
const HANDOFF_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const HANDOFF_OPEN_TIMEOUT_MS = 8000;
const HANDOFF_CONSUME_RETRIES = 5;
const HANDOFF_CONSUME_RETRY_DELAY_MS = 100;

export const HANDOFF_QUERY_PARAM = "handoff";
let handoffSupportCheck: Promise<boolean> | null = null;
const handoffMemoryStore = new Map<string, HandoffRecord>();

type HandoffRecordKind = "file" | "prism-queue";

interface HandoffRecordBase {
  id: string;
  kind?: HandoffRecordKind;
  createdAt: number;
}

interface FileHandoffRecord extends HandoffRecordBase {
  kind?: "file"; // Legacy records from v1 may not have kind.
  file: File;
  metadata?: unknown;
}

interface PrismQueueSessionRecord extends HandoffRecordBase {
  kind: "prism-queue";
  files: File[];
  primaryIndex: number;
}

type HandoffRecord = FileHandoffRecord | PrismQueueSessionRecord;

export interface PrismQueueSessionPayload {
  files: File[];
  primaryIndex: number;
}

export interface FileHandoffPayload {
  file: File;
  metadata: unknown | null;
}

function toRequestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openHandoffDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const request = indexedDB.open(HANDOFF_DB_NAME, HANDOFF_DB_VERSION);
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("Timed out opening IndexedDB"));
    }, HANDOFF_OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDOFF_STORE)) {
        db.createObjectStore(HANDOFF_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (timedOut) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("Failed to open IndexedDB"));
    };
    request.onblocked = () => {
      // Keep waiting for the timeout window; users can resolve by closing other tabs.
    };
  });
}

function createHandoffId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED";
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes("quota");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFreshRecord(createdAt: unknown): createdAt is number {
  return isFiniteNumber(createdAt) && Date.now() - createdAt <= HANDOFF_MAX_AGE_MS;
}

function cleanupExpiredMemoryEntries(): void {
  for (const [id, record] of handoffMemoryStore.entries()) {
    if (!isFreshRecord(record.createdAt)) {
      handoffMemoryStore.delete(id);
    }
  }
}

function toFile(value: unknown, fallbackName: string): File | null {
  if (value instanceof File) return value;
  if (!(value instanceof Blob)) return null;

  const maybeNamed = value as Blob & Partial<File>;
  const name = typeof maybeNamed.name === "string" && maybeNamed.name.trim().length > 0
    ? maybeNamed.name
    : fallbackName;
  const lastModified = isFiniteNumber(maybeNamed.lastModified)
    ? Math.floor(maybeNamed.lastModified)
    : Date.now();

  try {
    return new File([value], name, {
      type: value.type || "application/octet-stream",
      lastModified,
    });
  } catch {
    return null;
  }
}

function toFileHandoffPayload(record: FileHandoffRecord): FileHandoffPayload | null {
  if (!isFreshRecord(record.createdAt)) return null;
  const file = toFile(record.file, "handoff.bin");
  if (!file) return null;
  return {
    file,
    metadata: record.metadata ?? null,
  };
}

function toPrismQueueSessionPayload(record: PrismQueueSessionRecord): PrismQueueSessionPayload | null {
  if (!isFreshRecord(record.createdAt)) return null;
  const files = record.files
    .map((file, index) => toFile(file, `handoff-${index + 1}.bin`))
    .filter((file): file is File => file instanceof File);
  if (files.length === 0 || files.length !== record.files.length) return null;
  return {
    files,
    primaryIndex: clampPrimaryIndex(record.primaryIndex, files.length),
  };
}

async function persistRecord(record: HandoffRecord): Promise<void> {
  cleanupExpiredMemoryEntries();
  handoffMemoryStore.set(record.id, record);

  const db = await openHandoffDb();
  try {
    await cleanupExpiredEntries(db);
    await putRecordWithQuotaRetry(db, record);
  } finally {
    db.close();
  }
}

async function getRecordFromDb(id: string): Promise<Partial<HandoffRecord> | undefined> {
  const db = await openHandoffDb();
  try {
    const tx = db.transaction(HANDOFF_STORE, "readonly");
    const store = tx.objectStore(HANDOFF_STORE);
    const record = await toRequestPromise(store.get(id)) as Partial<HandoffRecord> | undefined;
    await waitForTransaction(tx);
    return record;
  } finally {
    db.close();
  }
}

async function consumeWithRetry<T>(
  id: string,
  consumer: (key: string) => Promise<T | null>,
  retries: number,
  retryDelayMs: number,
): Promise<T | null> {
  const key = id.trim();
  if (!key) return null;

  let sawReadResult = false;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const payload = await consumer(key);
      sawReadResult = true;
      if (payload) return payload;
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(retryDelayMs);
  }

  if (!sawReadResult && lastError) throw lastError;
  return null;
}

function consumeFileHandoffFromMemory(id: string): FileHandoffPayload | null {
  cleanupExpiredMemoryEntries();
  const record = handoffMemoryStore.get(id);
  if (!record || !isFileHandoffRecord(record)) return null;
  return toFileHandoffPayload(record);
}

function consumePrismQueueSessionFromMemory(id: string): PrismQueueSessionPayload | null {
  cleanupExpiredMemoryEntries();
  const record = handoffMemoryStore.get(id);
  if (!record || !isPrismQueueSessionRecord(record)) return null;
  return toPrismQueueSessionPayload(record);
}

function clampPrimaryIndex(value: unknown, fileCount: number): number {
  if (fileCount <= 0) return 0;
  if (!isFiniteNumber(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), fileCount - 1);
}

function isFileHandoffRecord(record: Partial<HandoffRecord> | null | undefined): record is FileHandoffRecord {
  if (!record) return false;
  if (record.kind && record.kind !== "file") return false;
  if (!("file" in record)) return false;
  return record.file instanceof Blob;
}

function isPrismQueueSessionRecord(record: Partial<HandoffRecord> | null | undefined): record is PrismQueueSessionRecord {
  if (!record) return false;
  if (record.kind !== "prism-queue") return false;
  if (!("files" in record) || !Array.isArray(record.files) || record.files.length === 0) return false;
  if (!record.files.every((file) => file instanceof Blob)) return false;
  if (!("primaryIndex" in record) || !isFiniteNumber(record.primaryIndex)) return false;
  return true;
}

async function cleanupExpiredEntries(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(HANDOFF_STORE, "readwrite");
  const store = tx.objectStore(HANDOFF_STORE);
  const now = Date.now();
  const cursorRequest = store.openCursor();

  await new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      const value = cursor.value as Partial<HandoffRecord>;
      const createdAt = typeof value.createdAt === "number" ? value.createdAt : 0;
      if (now - createdAt > HANDOFF_MAX_AGE_MS) {
        cursor.delete();
      }
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Failed to scan handoff entries"));
  });

  await waitForTransaction(tx);
}

async function clearAllEntries(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(HANDOFF_STORE, "readwrite");
  tx.objectStore(HANDOFF_STORE).clear();
  await waitForTransaction(tx);
}

async function putRecordWithQuotaRetry(db: IDBDatabase, record: HandoffRecord): Promise<void> {
  const putRecord = async (): Promise<void> => {
    const tx = db.transaction(HANDOFF_STORE, "readwrite");
    tx.objectStore(HANDOFF_STORE).put(record);
    await waitForTransaction(tx);
  };

  try {
    await putRecord();
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    await clearAllEntries(db);
    await putRecord();
  }
}

export async function createFileHandoff(file: File, metadata?: unknown): Promise<string> {
  const id = createHandoffId();
  const record: FileHandoffRecord = {
    id,
    kind: "file",
    file,
    metadata,
    createdAt: Date.now(),
  };
  await persistRecord(record);

  return id;
}

export async function createPrismQueueSession(files: File[], primaryIndex: number): Promise<string> {
  if (files.length === 0 || !files.every((file) => file instanceof File)) {
    throw new Error("Queue session requires at least one File");
  }
  const queueFiles = files.slice();

  const id = createHandoffId();
  const record: PrismQueueSessionRecord = {
    id,
    kind: "prism-queue",
    files: queueFiles,
    primaryIndex: clampPrimaryIndex(primaryIndex, queueFiles.length),
    createdAt: Date.now(),
  };
  await persistRecord(record);

  return id;
}

export async function consumeFileHandoff(id: string): Promise<FileHandoffPayload | null> {
  const key = id.trim();
  if (!key) return null;

  const memoryPayload = consumeFileHandoffFromMemory(key);
  if (memoryPayload) return memoryPayload;

  const record = await getRecordFromDb(key);
  if (!isFileHandoffRecord(record)) return null;
  return toFileHandoffPayload(record);
}

export async function consumeFileHandoffWithRetry(
  id: string,
  retries: number = HANDOFF_CONSUME_RETRIES,
  retryDelayMs: number = HANDOFF_CONSUME_RETRY_DELAY_MS,
): Promise<FileHandoffPayload | null> {
  return consumeWithRetry(id, consumeFileHandoff, retries, retryDelayMs);
}

export async function consumePrismQueueSession(id: string): Promise<PrismQueueSessionPayload | null> {
  const key = id.trim();
  if (!key) return null;

  const memoryPayload = consumePrismQueueSessionFromMemory(key);
  if (memoryPayload) return memoryPayload;

  const record = await getRecordFromDb(key);
  if (!isPrismQueueSessionRecord(record)) return null;
  return toPrismQueueSessionPayload(record);
}

export async function consumePrismQueueSessionWithRetry(
  id: string,
  retries: number = HANDOFF_CONSUME_RETRIES,
  retryDelayMs: number = HANDOFF_CONSUME_RETRY_DELAY_MS,
): Promise<PrismQueueSessionPayload | null> {
  return consumeWithRetry(id, consumePrismQueueSession, retries, retryDelayMs);
}

export async function supportsFileHandoff(): Promise<boolean> {
  if (!handoffSupportCheck) {
    handoffSupportCheck = (async () => {
      try {
        const db = await openHandoffDb();
        db.close();
        return true;
      } catch {
        return false;
      }
    })();
  }

  const supported = await handoffSupportCheck;
  if (!supported) {
    handoffSupportCheck = null;
  }
  return supported;
}

export function buildPrismHandoffUrl(token: string): string {
  const cleanToken = token.trim();
  const url = new URL(window.location.href);
  url.pathname = "/prism";
  url.searchParams.set(HANDOFF_QUERY_PARAM, cleanToken);
  url.hash = "";
  return url.toString();
}

export function buildLensHandoffUrl(token: string): string {
  const cleanToken = token.trim();
  const url = new URL(window.location.href);
  url.pathname = "/lens";
  url.searchParams.set(HANDOFF_QUERY_PARAM, cleanToken);
  url.hash = "";
  return url.toString();
}

export function getHandoffTokenFromCurrentUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(HANDOFF_QUERY_PARAM);
    if (!token) return null;
    const clean = token.trim();
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

export function clearHandoffTokenFromCurrentUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(HANDOFF_QUERY_PARAM)) return;
    url.searchParams.delete(HANDOFF_QUERY_PARAM);
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // Ignore URL rewrite failures.
  }
}
