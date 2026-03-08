// prism-metadata-diff.ts — Metadata diff analysis for Prism output.
// Compares metadata between input and output files using the Lens parser,
// producing a structured report of what was removed, changed, or survived.

import type { ExifCategory, ExifField, LensData } from "../lens/exif";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Summary of a single category's metadata changes. */
export interface MetadataDiffCategory {
    id: string;
    title: string;
    /** Fields present in input but absent from output. */
    removed: ExifField[];
    /** Fields still present in the output. */
    surviving: ExifField[];
}

/** Overall result of a metadata diff comparison. */
export interface MetadataDiffResult {
    /** Total populated fields in the input (excluding FILE category). */
    inputFieldCount: number;
    /** Total populated fields in the output (excluding FILE category). */
    outputFieldCount: number;
    /** Number of fields removed. */
    removedCount: number;
    /** Number of fields still present. */
    survivingCount: number;
    /** Per-category breakdown (only categories with at least one removed or surviving field). */
    categories: MetadataDiffCategory[];
    /** Heuristic: "full" if all removed, "partial" if some remain, "none" if nothing removed. */
    cleanLevel: "full" | "partial" | "none";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Categories to exclude from the diff (FILE info changes by nature of re-processing). */
const EXCLUDED_CATEGORY_IDS = new Set(["file"]);

/** Normalize field ID for comparison; strips prefixes and lowercases. */
function normalizeFieldId(field: ExifField): string {
    return `${field.id}::${field.label}`.toLowerCase();
}

/** Build a lookup set of normalized field IDs from a list of categories. */
function buildFieldSet(categories: ExifCategory[]): Set<string> {
    const set = new Set<string>();
    for (const cat of categories) {
        if (EXCLUDED_CATEGORY_IDS.has(cat.id)) continue;
        for (const f of cat.fields) {
            set.add(`${cat.id}::${normalizeFieldId(f)}`);
        }
    }
    return set;
}

/** Collect all non-FILE fields from categories. */
function collectFields(categories: ExifCategory[]): ExifField[] {
    const fields: ExifField[] = [];
    for (const cat of categories) {
        if (EXCLUDED_CATEGORY_IDS.has(cat.id)) continue;
        fields.push(...cat.fields);
    }
    return fields;
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

/**
 * Compare input and output LensData to produce a metadata diff.
 * Uses category IDs and field labels as comparison keys.
 */
export function computeMetadataDiff(
    inputData: LensData,
    outputData: LensData,
): MetadataDiffResult {
    const inputFields = collectFields(inputData.categories);
    const outputFieldSet = buildFieldSet(outputData.categories);

    const diffCategories: MetadataDiffCategory[] = [];
    let removedCount = 0;
    let survivingCount = 0;

    for (const inputCat of inputData.categories) {
        if (EXCLUDED_CATEGORY_IDS.has(inputCat.id)) continue;

        const removed: ExifField[] = [];
        const surviving: ExifField[] = [];

        for (const field of inputCat.fields) {
            const key = `${inputCat.id}::${normalizeFieldId(field)}`;
            if (outputFieldSet.has(key)) {
                surviving.push(field);
                survivingCount++;
            } else {
                removed.push(field);
                removedCount++;
            }
        }

        // Only include categories that had content
        if (removed.length > 0 || surviving.length > 0) {
            diffCategories.push({
                id: inputCat.id,
                title: inputCat.title,
                removed,
                surviving,
            });
        }
    }

    const inputFieldCount = inputFields.length;
    const outputFieldCount = collectFields(outputData.categories).length;

    let cleanLevel: MetadataDiffResult["cleanLevel"];
    if (removedCount === 0) {
        cleanLevel = "none";
    } else if (survivingCount === 0) {
        cleanLevel = "full";
    } else {
        cleanLevel = "partial";
    }

    return {
        inputFieldCount,
        outputFieldCount,
        removedCount,
        survivingCount,
        categories: diffCategories,
        cleanLevel,
    };
}

// ─── File-level Entry Point ──────────────────────────────────────────────────

/**
 * Analyze metadata diff between an input File and output Uint8Array.
 * Lazy-loads the Lens parser to avoid bloating the initial bundle.
 */
export async function analyzeMetadataDiff(
    inputFile: File,
    outputData: Uint8Array,
    outputName: string,
): Promise<MetadataDiffResult> {
    // Skip diff when the output format differs from the input (e.g. md → html).
    // Cross-format diffs produce misleading "all fields removed" results.
    const inputExt = inputFile.name.split(".").pop()?.toLowerCase() || "";
    const outputExt = outputName.split(".").pop()?.toLowerCase() || "";
    if (inputExt !== outputExt) {
        return { inputFieldCount: 0, outputFieldCount: 0, removedCount: 0, survivingCount: 0, categories: [], cleanLevel: "none" };
    }

    const { parseFile } = await import("../lens/exif");

    // Parse input metadata
    const inputLens = await parseFile(inputFile);

    // Wrap output data as a File for parseFile compatibility
    const ext = outputName.split(".").pop() || "";
    const { mimeForExtension } = await import("./engine");
    const mime = mimeForExtension(ext);
    const outputFile = new File([outputData.buffer as any], outputName, { type: mime });
    const outputLens = await parseFile(outputFile);

    return computeMetadataDiff(inputLens, outputLens);
}
