// prism-draft.ts - prism draft snapshot helpers for Lens <-> Prism handoff.

export type PrismDraftModuleId =
  | "workbench"
  | "shrubber"
  | "audio"
  | "subtitles"
  | "transparency";

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

export interface PrismDraftSnapshot {
  kind: "prism-draft";
  version: 1;
  createdAt: number;
  file: PrismFileSignature;
  activeModuleId: PrismDraftModuleId;
  modules: Partial<Record<PrismDraftModuleId, unknown>>;
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
): PrismDraftSnapshot {
  return {
    kind: "prism-draft",
    version: 1,
    createdAt: Date.now(),
    file: createPrismFileSignature(file),
    activeModuleId,
    modules,
  };
}

export function parsePrismDraftSnapshot(value: unknown): PrismDraftSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "prism-draft") return null;
  if (value.version !== 1) return null;

  const createdAt = toFiniteNumber(value.createdAt);
  if (createdAt === null) return null;

  if (!isModuleId(value.activeModuleId)) return null;

  if (!isRecord(value.file)) return null;
  const fileName = toText(value.file.name);
  const fileType = toText(value.file.type);
  const fileSize = toFiniteNumber(value.file.size);
  const fileLastModified = toFiniteNumber(value.file.lastModified);
  if (
    fileName === null ||
    fileType === null ||
    fileSize === null ||
    fileLastModified === null
  ) {
    return null;
  }

  const modules: Partial<Record<PrismDraftModuleId, unknown>> = {};
  if (isRecord(value.modules)) {
    for (const moduleId of PRISM_DRAFT_MODULE_IDS) {
      if (Object.prototype.hasOwnProperty.call(value.modules, moduleId)) {
        modules[moduleId] = value.modules[moduleId];
      }
    }
  }

  return {
    kind: "prism-draft",
    version: 1,
    createdAt,
    file: {
      name: fileName,
      size: fileSize,
      type: fileType,
      lastModified: fileLastModified,
    },
    activeModuleId: value.activeModuleId,
    modules,
  };
}
