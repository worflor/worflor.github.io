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

interface FileHandoffRecord {
  id: string;
  file: File;
  createdAt: number;
  source: string;
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
      const value = cursor.value as Partial<FileHandoffRecord>;
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

export async function createFileHandoff(file: File, source: string = "lens"): Promise<string> {
  const db = await openHandoffDb();
  try {
    // Free stale data first to maximize success for large files.
    await cleanupExpiredEntries(db);

    const id = createHandoffId();
    const record: FileHandoffRecord = {
      id,
      file,
      createdAt: Date.now(),
      source,
    };

    const putRecord = async (): Promise<void> => {
      const tx = db.transaction(HANDOFF_STORE, "readwrite");
      tx.objectStore(HANDOFF_STORE).put(record);
      await waitForTransaction(tx);
    };

    try {
      await putRecord();
    } catch (err) {
      // Storage may be full from older entries. Reset and retry once.
      if (!isQuotaError(err)) throw err;
      await clearAllEntries(db);
      await putRecord();
    }

    return id;
  } finally {
    db.close();
  }
}

export async function consumeFileHandoff(id: string): Promise<File | null> {
  const key = id.trim();
  if (!key) return null;

  const db = await openHandoffDb();
  try {
    const tx = db.transaction(HANDOFF_STORE, "readwrite");
    const store = tx.objectStore(HANDOFF_STORE);
    const record = await toRequestPromise(store.get(key)) as FileHandoffRecord | undefined;
    if (record) store.delete(key);
    await waitForTransaction(tx);

    if (!record || !(record.file instanceof File)) return null;
    if (Date.now() - record.createdAt > HANDOFF_MAX_AGE_MS) return null;
    return record.file;
  } finally {
    db.close();
  }
}

export async function consumeFileHandoffWithRetry(
  id: string,
  retries: number = HANDOFF_CONSUME_RETRIES,
  retryDelayMs: number = HANDOFF_CONSUME_RETRY_DELAY_MS,
): Promise<File | null> {
  const key = id.trim();
  if (!key) return null;

  let sawReadResult = false;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const file = await consumeFileHandoff(key);
      sawReadResult = true;
      if (file) return file;
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await sleep(retryDelayMs);
  }

  if (!sawReadResult && lastError) {
    throw lastError;
  }

  return null;
}

export function supportsFileHandoff(): Promise<boolean> {
  if (handoffSupportCheck) return handoffSupportCheck;

  handoffSupportCheck = (async () => {
    try {
      const db = await openHandoffDb();
      db.close();
      return true;
    } catch {
      return false;
    }
  })();

  return handoffSupportCheck.then((supported) => {
    if (!supported) {
      handoffSupportCheck = null;
    }
    return supported;
  });
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
