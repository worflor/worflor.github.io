// prism-draft.ts - prism draft snapshot helpers for Lens <-> Prism handoff.

export type PrismDraftModuleId =
  | "workbench"
  | "shrubber"
  | "audio"
  | "subtitles"
  | "transparency";

const PRISM_DRAFT_VERSION = 2;
const PRISM_DRAFT_MAX_DEPTH = 8;
const PRISM_DRAFT_MAX_ITEMS = 256;

const PRISM_DRAFT_MODULE_IDS: PrismDraftModuleId[] = [
  "workbench",
  "shrubber",
  "audio",
  "subtitles",
  "transparency",
];

export interface PrismFileSignature {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface PrismDraftQueueRef {
  sessionId: string;
  primaryIndex: number;
  signatures: PrismFileSignature[];
}

export interface PrismDraftSnapshot {
  kind: "prism-draft";
  version: number;
  createdAt: number;
  file: PrismFileSignature;
  activeModuleId: PrismDraftModuleId;
  modules: Partial<Record<PrismDraftModuleId, unknown>>;
  queueRef?: PrismDraftQueueRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isModuleId(value: unknown): value is PrismDraftModuleId {
  return typeof value === "string" && PRISM_DRAFT_MODULE_IDS.includes(value as PrismDraftModuleId);
}

function parseFileSignature(value: unknown): PrismFileSignature | null {
  if (!isRecord(value)) return null;
  const name = toText(value.name);
  const type = toText(value.type);
  const size = toFiniteNumber(value.size);
  const lastModified = toFiniteNumber(value.lastModified);
  if (
    name === null ||
    type === null ||
    size === null ||
    lastModified === null
  ) {
    return null;
  }
  return { name, type, size, lastModified };
}

function parseQueueRef(value: unknown): PrismDraftQueueRef | null {
  if (!isRecord(value)) return null;
  const sessionId = toText(value.sessionId)?.trim() ?? "";
  const primaryIndex = toFiniteNumber(value.primaryIndex);
  if (!sessionId || primaryIndex === null || !Array.isArray(value.signatures)) {
    return null;
  }

  const signatures: PrismFileSignature[] = [];
  for (const signatureValue of value.signatures) {
    const signature = parseFileSignature(signatureValue);
    if (!signature) return null;
    signatures.push(signature);
  }

  if (signatures.length === 0) return null;
  return {
    sessionId,
    primaryIndex: Math.max(0, Math.floor(primaryIndex)),
    signatures,
  };
}

function sanitizePrismDraftValueInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown | undefined {
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return value;
  if (valueType === "number") return Number.isFinite(value as number) ? value : undefined;
  if (valueType === "undefined" || valueType === "function" || valueType === "symbol" || valueType === "bigint") {
    return undefined;
  }

  if (depth >= PRISM_DRAFT_MAX_DEPTH) return undefined;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (
    value instanceof Blob ||
    value instanceof File ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);

    const sanitized = value.slice(0, PRISM_DRAFT_MAX_ITEMS).map((entry) => {
      const next = sanitizePrismDraftValueInternal(entry, depth + 1, seen);
      return next === undefined ? null : next;
    });

    seen.delete(value);
    return sanitized;
  }

  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, PRISM_DRAFT_MAX_ITEMS);
  for (const [key, entryValue] of entries) {
    const next = sanitizePrismDraftValueInternal(entryValue, depth + 1, seen);
    if (next !== undefined) sanitized[key] = next;
  }

  seen.delete(value);
  return sanitized;
}

export function sanitizePrismDraftValue(value: unknown): unknown | undefined {
  return sanitizePrismDraftValueInternal(value, 0, new WeakSet<object>());
}

function sanitizeDraftModules(
  modules: Partial<Record<PrismDraftModuleId, unknown>>,
): Partial<Record<PrismDraftModuleId, unknown>> {
  const sanitizedModules: Partial<Record<PrismDraftModuleId, unknown>> = {};
  for (const moduleId of PRISM_DRAFT_MODULE_IDS) {
    if (!Object.prototype.hasOwnProperty.call(modules, moduleId)) continue;
    const sanitized = sanitizePrismDraftValue(modules[moduleId]);
    if (sanitized !== undefined) {
      sanitizedModules[moduleId] = sanitized;
    }
  }
  return sanitizedModules;
}

export function createPrismFileSignature(file: File): PrismFileSignature {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  };
}

export function samePrismFileSignature(file: File, signature: PrismFileSignature): boolean {
  return (
    file.name === signature.name &&
    file.size === signature.size &&
    file.type === signature.type &&
    file.lastModified === signature.lastModified
  );
}

export function createPrismDraftSnapshot(
  file: File,
  activeModuleId: PrismDraftModuleId,
  modules: Partial<Record<PrismDraftModuleId, unknown>>,
  options?: { queueRef?: PrismDraftQueueRef },
): PrismDraftSnapshot {
  const snapshot: PrismDraftSnapshot = {
    kind: "prism-draft",
    version: PRISM_DRAFT_VERSION,
    createdAt: Date.now(),
    file: createPrismFileSignature(file),
    activeModuleId,
    modules: sanitizeDraftModules(modules),
  };

  if (options?.queueRef) {
    snapshot.queueRef = {
      sessionId: options.queueRef.sessionId,
      primaryIndex: Math.max(0, Math.floor(options.queueRef.primaryIndex)),
      signatures: options.queueRef.signatures.map((signature) => ({ ...signature })),
    };
  }

  return snapshot;
}

export function parsePrismDraftSnapshot(value: unknown): PrismDraftSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "prism-draft") return null;

  const version = toFiniteNumber(value.version);
  if (version === null || !Number.isInteger(version) || version < 1) return null;

  const createdAt = toFiniteNumber(value.createdAt);
  if (createdAt === null) return null;

  if (!isModuleId(value.activeModuleId)) return null;

  const file = parseFileSignature(value.file);
  if (!file) return null;

  const modules: Partial<Record<PrismDraftModuleId, unknown>> = {};
  if (isRecord(value.modules)) {
    for (const moduleId of PRISM_DRAFT_MODULE_IDS) {
      if (Object.prototype.hasOwnProperty.call(value.modules, moduleId)) {
        const sanitized = sanitizePrismDraftValue(value.modules[moduleId]);
        if (sanitized !== undefined) {
          modules[moduleId] = sanitized;
        }
      }
    }
  }

  const snapshot: PrismDraftSnapshot = {
    kind: "prism-draft",
    version,
    createdAt,
    file,
    activeModuleId: value.activeModuleId,
    modules,
  };

  const queueRef = parseQueueRef(value.queueRef);
  if (queueRef) {
    snapshot.queueRef = queueRef;
  }

  return snapshot;
}
