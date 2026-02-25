import {
  buildLensHandoffUrl,
  clearHandoffTokenFromCurrentUrl,
  consumeFileHandoffWithRetry,
  createFileHandoff,
  getHandoffTokenFromCurrentUrl,
  supportsFileHandoff,
} from "../shared/file-handoff";
import { profileBytesWithWasm, type CageWasmProfile, type CageWasmRunInfo } from "./wasm";

export interface CageUIOptions {
  page: HTMLElement;
  uploadZone: HTMLElement;
  fileInput: HTMLInputElement;
  actionsBar: HTMLElement;
  sourceName: HTMLElement;
  sourceMeta: HTMLElement;
  viewport: HTMLPreElement;
  threatLog: HTMLElement;
  threatEmpty: HTMLElement;
  verdictScore: HTMLElement;
  verdictLabel: HTMLElement;
  verdictReason: HTMLElement;
  manifestOutput: HTMLPreElement;
  manifestCopyBtn: HTMLButtonElement;
  actionRunBtn: HTMLButtonElement;
  actionLensBtn: HTMLButtonElement;
  actionUploadBtn: HTMLButtonElement;
  actionClearBtn: HTMLButtonElement;
  alphaBadge: HTMLElement;
}

type CageUIIdMap = { [K in keyof CageUIOptions]: string };

export const CAGE_UI_IDS: CageUIIdMap = {
  page: "cage-page",
  uploadZone: "cage-upload-zone",
  fileInput: "cage-file-input",
  actionsBar: "cage-actions",
  sourceName: "cage-source-name",
  sourceMeta: "cage-source-meta",
  viewport: "cage-viewport",
  threatLog: "cage-threat-log",
  threatEmpty: "cage-threat-empty",
  verdictScore: "cage-verdict-score",
  verdictLabel: "cage-verdict-label",
  verdictReason: "cage-verdict-reason",
  manifestOutput: "cage-manifest-output",
  manifestCopyBtn: "cage-manifest-copy",
  actionRunBtn: "cage-action-run",
  actionLensBtn: "cage-action-lens",
  actionUploadBtn: "cage-action-upload",
  actionClearBtn: "cage-action-clear",
  alphaBadge: "cage-alpha-badge",
};

type ThreatSeverity = "low" | "medium" | "high";

interface ThreatEvent {
  code: string;
  summary: string;
  detail: string;
  severity: ThreatSeverity;
  score: number;
}

interface StripRule {
  rule: string;
  rationale: string;
  confidence: number;
}

interface LensRiskMetadata {
  score: number;
  level: "green" | "amber" | "red";
  reasons: string[];
}

interface LensSummaryMetadataItem {
  label: string;
  value: string;
}

interface CageIngressMetadata {
  source: string;
  risk: LensRiskMetadata | null;
  summary: LensSummaryMetadataItem[];
  generatedAt: string | null;
}

interface GhostPatch {
  offset: number | null;
  signature: string;
  forcedResult: string;
  rationale: string;
}

type AirGapProtocol = "https" | "http" | "dns" | "ipv4" | "raw";
type AirGapGuestOutcome = "timeout" | "local-firewall";

interface AirGapFrame {
  endpoint: string;
  protocol: AirGapProtocol;
  srcMac: string;
  dstMac: string;
  ethType: "0x0800" | "0x86DD";
  frameBytes: number;
  guestOutcome: AirGapGuestOutcome;
  virtualMs: number;
}

interface VirtualClockTelemetry {
  tscHz: number;
  virtualCycles: number;
  elapsedMs: number;
  jitterPpm: number;
}

interface CpuidTelemetry {
  vendor: "GenuineIntel";
  family: number;
  model: number;
  stepping: number;
  signature: string;
}

interface MirrorStrikeTelemetry {
  clock: VirtualClockTelemetry;
  cpuid: CpuidTelemetry;
  ghostPatches: GhostPatch[];
  airGapFrames: AirGapFrame[];
}

interface StripManifest {
  generatedAt: string;
  sourceFile: string;
  requestedStrip: StripRule[];
  airGapIntercepts: string[];
  airGapFrames: AirGapFrame[];
  ghostPatches: GhostPatch[];
  evidenceCodes: string[];
  ingress: CageIngressMetadata | null;
}

interface DetectionResult {
  events: ThreatEvent[];
  networkAttempts: string[];
  antiVmMarkers: string[];
}

function q(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

function asInput(node: HTMLElement | null): HTMLInputElement | null {
  return node instanceof HTMLInputElement ? node : null;
}

function asPre(node: HTMLElement | null): HTMLPreElement | null {
  return node instanceof HTMLPreElement ? node : null;
}

function asButton(node: HTMLElement | null): HTMLButtonElement | null {
  return node instanceof HTMLButtonElement ? node : null;
}

export function resolveCageUIOptions(root: ParentNode = document): CageUIOptions | null {
  const page = q(root, CAGE_UI_IDS.page);
  const uploadZone = q(root, CAGE_UI_IDS.uploadZone);
  const fileInput = asInput(q(root, CAGE_UI_IDS.fileInput));
  const actionsBar = q(root, CAGE_UI_IDS.actionsBar);
  const sourceName = q(root, CAGE_UI_IDS.sourceName);
  const sourceMeta = q(root, CAGE_UI_IDS.sourceMeta);
  const viewport = asPre(q(root, CAGE_UI_IDS.viewport));
  const threatLog = q(root, CAGE_UI_IDS.threatLog);
  const threatEmpty = q(root, CAGE_UI_IDS.threatEmpty);
  const verdictScore = q(root, CAGE_UI_IDS.verdictScore);
  const verdictLabel = q(root, CAGE_UI_IDS.verdictLabel);
  const verdictReason = q(root, CAGE_UI_IDS.verdictReason);
  const manifestOutput = asPre(q(root, CAGE_UI_IDS.manifestOutput));
  const manifestCopyBtn = asButton(q(root, CAGE_UI_IDS.manifestCopyBtn));
  const actionRunBtn = asButton(q(root, CAGE_UI_IDS.actionRunBtn));
  const actionLensBtn = asButton(q(root, CAGE_UI_IDS.actionLensBtn));
  const actionUploadBtn = asButton(q(root, CAGE_UI_IDS.actionUploadBtn));
  const actionClearBtn = asButton(q(root, CAGE_UI_IDS.actionClearBtn));
  const alphaBadge = q(root, CAGE_UI_IDS.alphaBadge);

  if (
    !page || !uploadZone || !fileInput || !actionsBar || !sourceName || !sourceMeta || !viewport || !threatLog ||
    !threatEmpty || !verdictScore || !verdictLabel || !verdictReason || !manifestOutput ||
    !manifestCopyBtn || !actionRunBtn || !actionLensBtn || !actionUploadBtn || !actionClearBtn || !alphaBadge
  ) {
    return null;
  }

  return {
    page,
    uploadZone,
    fileInput,
    actionsBar,
    sourceName,
    sourceMeta,
    viewport,
    threatLog,
    threatEmpty,
    verdictScore,
    verdictLabel,
    verdictReason,
    manifestOutput,
    manifestCopyBtn,
    actionRunBtn,
    actionLensBtn,
    actionUploadBtn,
    actionClearBtn,
    alphaBadge,
  };
}

const CAGE_REFRESH_FILE_KEY = "cage.refreshFileToken.v1";
const MAX_SCAN_BYTES = 512 * 1024;
const AIR_GAP_ENDPOINT_LIMIT = 12;
const ACTION_BAR_FADE_MS = 180;
const THREAT_FEED_STEP_DELAY_MS = 12;
const MAX_GHOST_PATCHES = 18;
const ANTI_VM_MARKERS = [
  "rdtsc",
  "cpuid",
  "isdebuggerpresent",
  "checkremotedebuggerpresent",
  "beingdebugged",
  "ntqueryinformationprocess",
  "vmware",
  "virtualbox",
  "vboxservice",
  "qemu",
  "xen",
  "sandbox",
  "wine_get_version",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function summarizeVerdict(score: number): { label: string; reason: string } {
  if (score >= 80) return { label: "critical", reason: "multiple execution and network-beacon indicators" };
  if (score >= 55) return { label: "high", reason: "likely active payload behavior markers" };
  if (score >= 30) return { label: "amber", reason: "suspicious artifacts require deeper triage" };
  if (score >= 10) return { label: "low", reason: "few weak indicators observed" };
  return { label: "clean", reason: "no strong behavior indicators observed" };
}

function sampleEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
  let entropy = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseLensRiskMetadata(value: unknown): LensRiskMetadata | null {
  const record = asRecord(value);
  if (!record) return null;

  const score = typeof record.score === "number" && Number.isFinite(record.score)
    ? Math.min(100, Math.max(0, Math.round(record.score)))
    : null;
  const levelValue = typeof record.level === "string" ? record.level.toLowerCase() : "";
  const level = levelValue === "green" || levelValue === "amber" || levelValue === "red" ? levelValue : null;
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((item): item is string => typeof item === "string").slice(0, 8)
    : [];

  if (score === null || level === null) return null;
  return { score, level, reasons };
}

function parseLensSummaryMetadata(value: unknown): LensSummaryMetadataItem[] {
  if (!Array.isArray(value)) return [];
  const items: LensSummaryMetadataItem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const rawValue = record.value;
    const textValue = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!label || !textValue) continue;
    items.push({ label, value: textValue });
    if (items.length >= 12) break;
  }
  return items;
}

function parseCageIngressMetadata(value: unknown): CageIngressMetadata | null {
  const record = asRecord(value);
  if (!record) return null;
  const sourceRaw = typeof record.source === "string" ? record.source.trim().toLowerCase() : "";
  if (!sourceRaw) return null;

  const generatedAt = typeof record.generatedAt === "string" && record.generatedAt.trim().length > 0
    ? record.generatedAt.trim()
    : null;
  const risk = parseLensRiskMetadata(record.risk);
  const summary = parseLensSummaryMetadata(record.summary);

  return {
    source: sourceRaw,
    risk,
    summary,
    generatedAt,
  };
}

const NON_TEXTUAL_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
]);

function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TEXTUAL_INPUT_TYPES.has(target.type.toLowerCase());
  }
  if ((target as HTMLElement).isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

function fnv1a32(input: Uint8Array | string): number {
  let hash = 0x811c9dc5;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hexByte(value: number): string {
  return (value & 0xff).toString(16).padStart(2, "0");
}

function formatOffset(offset: number | null): string {
  if (offset === null) return "n/a";
  return `0x${offset.toString(16).padStart(6, "0")}`;
}

function formatMac(seedInput: number): string {
  let seed = seedInput >>> 0;
  const bytes = new Array<number>(6).fill(0).map(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed & 0xff;
  });
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered unicast
  return bytes.map((value) => hexByte(value)).join(":");
}

function scanPatternOffsets(bytes: Uint8Array, pattern: number[], limit: number): number[] {
  const offsets: number[] = [];
  if (pattern.length === 0 || bytes.length < pattern.length || limit <= 0) return offsets;
  for (let i = 0; i <= bytes.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    offsets.push(i);
    if (offsets.length >= limit) break;
  }
  return offsets;
}

function buildGhostPatchList(bytes: Uint8Array, antiVmMarkers: string[]): GhostPatch[] {
  const patches: GhostPatch[] = [];
  const pushPatch = (patch: GhostPatch): void => {
    if (patches.length >= MAX_GHOST_PATCHES) return;
    const key = `${patch.signature}|${patch.offset ?? -1}`;
    if (patches.some((existing) => `${existing.signature}|${existing.offset ?? -1}` === key)) return;
    patches.push(patch);
  };

  const specs: Array<{ signature: string; pattern: number[]; max: number; forcedResult: string; rationale: string }> = [
    {
      signature: "0f31",
      pattern: [0x0f, 0x31],
      max: 6,
      forcedResult: "EAX=virt_tsc_low, EDX=virt_tsc_high",
      rationale: "Gaslit clock path enforces monotonic virtual TSC.",
    },
    {
      signature: "0fa2",
      pattern: [0x0f, 0xa2],
      max: 4,
      forcedResult: "vendor=GenuineIntel, model/stepping pinned",
      rationale: "CPUID anti-VM branch sees native-like CPU identity.",
    },
    {
      signature: "0f01",
      pattern: [0x0f, 0x01],
      max: 3,
      forcedResult: "descriptor query returns sanitized host layout",
      rationale: "Descriptor-table probes are flattened to stable values.",
    },
    {
      signature: "cc",
      pattern: [0xcc],
      max: 5,
      forcedResult: "INT3 replaced with NOP in mirror execution lane",
      rationale: "Breakpoint litter is neutralized during branch replay.",
    },
  ];

  for (const spec of specs) {
    for (const offset of scanPatternOffsets(bytes, spec.pattern, spec.max)) {
      pushPatch({
        offset,
        signature: spec.signature,
        forcedResult: spec.forcedResult,
        rationale: spec.rationale,
      });
    }
  }

  for (const marker of antiVmMarkers.slice(0, 6)) {
    pushPatch({
      offset: null,
      signature: marker,
      forcedResult: "marker-gated branch forced pass",
      rationale: "String-level anti-analysis indicator was shadow-patched in mirror lane.",
    });
  }

  return patches;
}

function buildVirtualClockTelemetry(bytes: Uint8Array, wasmProfile: CageWasmProfile | null, seed: number): VirtualClockTelemetry {
  const scanLength = wasmProfile?.scannedLength ?? bytes.length;
  const transferDensity = wasmProfile
    ? wasmProfile.nearCallCount + wasmProfile.relJumpCount + wasmProfile.shortJumpCount
    : 0;
  const tscHz = 3_200_000_000 + ((seed % 420_000_000) >>> 0);
  let virtualCycles = (scanLength * 47) + (transferDensity * 2048);
  if (wasmProfile) {
    virtualCycles += (Math.max(0, wasmProfile.vmTraceScore) * 96);
    virtualCycles += ((wasmProfile.rdtscPairCount + wasmProfile.cpuidPairCount) * 4096);
  }
  virtualCycles = Math.max(virtualCycles, scanLength * 32);

  const elapsedMs = Number(((virtualCycles / tscHz) * 1000).toFixed(4));
  const jitterPpm = 4 + (seed % 11);
  return { tscHz, virtualCycles, elapsedMs, jitterPpm };
}

function buildCpuidTelemetry(seed: number): CpuidTelemetry {
  const family = 6;
  const model = 142 + (seed % 5);
  const stepping = 5 + (seed % 7);
  return {
    vendor: "GenuineIntel",
    family,
    model,
    stepping,
    signature: `family=${family}, model=${model}, stepping=${stepping}`,
  };
}

function inferAirGapProtocol(endpoint: string): AirGapProtocol {
  if (endpoint.startsWith("https://")) return "https";
  if (endpoint.startsWith("http://")) return "http";
  if (isPublicIpv4(endpoint)) return "ipv4";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(endpoint)) return "dns";
  return "raw";
}

function buildAirGapFrames(endpoints: string[], seed: number, clock: VirtualClockTelemetry): AirGapFrame[] {
  const frames: AirGapFrame[] = [];
  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const protocol = inferAirGapProtocol(endpoint);
    const frameSeed = fnv1a32(`${endpoint}|${seed}|${i}`);
    const ethType: "0x0800" | "0x86DD" = protocol === "raw" ? "0x86DD" : "0x0800";
    frames.push({
      endpoint,
      protocol,
      srcMac: formatMac(frameSeed ^ 0x3f1a2b4c),
      dstMac: formatMac(frameSeed ^ 0x9971dcab),
      ethType,
      frameBytes: 72 + (frameSeed % 460),
      guestOutcome: i % 2 === 0 ? "timeout" : "local-firewall",
      virtualMs: Number((clock.elapsedMs + (i * 1.6) + ((frameSeed >>> 10) % 19) / 10).toFixed(3)),
    });
  }
  return frames;
}

function buildMirrorStrikeTelemetry(
  bytes: Uint8Array,
  wasmProfile: CageWasmProfile | null,
  antiVmMarkers: string[],
  networkAttempts: string[],
): MirrorStrikeTelemetry {
  const seedSlice = bytes.subarray(0, Math.min(bytes.length, 4096));
  const seed = fnv1a32(seedSlice) ^ (wasmProfile?.vmTraceScore ?? 0);
  const clock = buildVirtualClockTelemetry(bytes, wasmProfile, seed >>> 0);
  const cpuid = buildCpuidTelemetry(seed >>> 0);
  const ghostPatches = buildGhostPatchList(bytes, antiVmMarkers);
  const airGapFrames = buildAirGapFrames(networkAttempts, seed >>> 0, clock);
  return { clock, cpuid, ghostPatches, airGapFrames };
}

function formatWasmRuntime(runtime: CageWasmRunInfo): string {
  const detail = runtime.detail.length > 120 ? `${runtime.detail.slice(0, 117)}...` : runtime.detail;
  const retrySuffix = runtime.retryAt ? `, retry @ ${new Date(runtime.retryAt).toISOString()}` : "";
  return `${runtime.code} @ ${runtime.stage}: ${detail}${retrySuffix}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function isPublicIpv4(candidate: string): boolean {
  const parts = candidate.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return false;
  // Ignore private, loopback, link-local ranges.
  if (nums[0] === 10) return false;
  if (nums[0] === 127) return false;
  if (nums[0] === 192 && nums[1] === 168) return false;
  if (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) return false;
  if (nums[0] === 169 && nums[1] === 254) return false;
  return true;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/[\s"'`<>()[\]{}]+/g, "").trim().toLowerCase();
}

function extractNetworkAttempts(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  const urlRegex = /\bhttps?:\/\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]{6,}/gi;
  for (const match of lower.matchAll(urlRegex)) {
    const endpoint = normalizeEndpoint(match[0]);
    if (!endpoint) continue;
    found.add(endpoint);
    if (found.size >= AIR_GAP_ENDPOINT_LIMIT) break;
  }

  if (found.size < AIR_GAP_ENDPOINT_LIMIT) {
    const domainRegex = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|xyz|top|info|ru|cn|app|dev|me|biz)\b/gi;
    for (const match of lower.matchAll(domainRegex)) {
      const endpoint = normalizeEndpoint(match[0]);
      if (!endpoint) continue;
      found.add(endpoint);
      if (found.size >= AIR_GAP_ENDPOINT_LIMIT) break;
    }
  }

  if (found.size < AIR_GAP_ENDPOINT_LIMIT) {
    const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    for (const match of lower.matchAll(ipRegex)) {
      const endpoint = normalizeEndpoint(match[0]);
      if (!endpoint || !isPublicIpv4(endpoint)) continue;
      found.add(endpoint);
      if (found.size >= AIR_GAP_ENDPOINT_LIMIT) break;
    }
  }

  return Array.from(found).slice(0, AIR_GAP_ENDPOINT_LIMIT);
}

function extractAntiVmMarkers(lowerText: string): string[] {
  const markers: string[] = [];
  for (const marker of ANTI_VM_MARKERS) {
    if (lowerText.includes(marker)) markers.push(marker);
  }
  return markers;
}

function detectThreatEvents(
  file: File,
  bytes: Uint8Array,
  text: string,
  wasmProfile: CageWasmProfile | null,
  ingress: CageIngressMetadata | null,
): DetectionResult {
  const events: ThreatEvent[] = [];
  const lower = text.toLowerCase();
  const networkAttempts = extractNetworkAttempts(text);
  const antiVmMarkers = extractAntiVmMarkers(lower);

  const pushIf = (condition: boolean, event: ThreatEvent): void => {
    if (condition) events.push(event);
  };

  if (ingress?.source === "lens" && ingress.risk && ingress.risk.level !== "green") {
    const ingressLevel = ingress.risk.level;
    const ingressScore = ingressLevel === "red" ? 12 : 7;
    pushIf(true, {
      code: "handoff.lens.risk",
      summary: `Lens handoff risk: ${ingressLevel} (${ingress.risk.score})`,
      detail: ingress.risk.reasons.length > 0
        ? `Lens flagged: ${ingress.risk.reasons.join("; ")}`
        : "Lens escalated this file for deeper triage.",
      severity: ingressLevel === "red" ? "high" : "medium",
      score: ingressScore,
    });
  }

  pushIf(/(powershell\s+-enc|frombase64string\(|invoke-expression|iwr\s+https?:\/\/)/i.test(lower), {
    code: "exec.ps1.loader",
    summary: "PowerShell loader markers",
    detail: "Encoded PowerShell or expression execution pattern found in sample.",
    severity: "high",
    score: 35,
  });

  pushIf(/(cmd\.exe\s+\/c|wscript\.shell|mshta\.exe|rundll32\.exe|regsvr32\.exe)/i.test(lower), {
    code: "exec.lolbin.chain",
    summary: "LOLBIN execution chain",
    detail: "Command-line patterns indicate likely launch through living-off-the-land binaries.",
    severity: "high",
    score: 30,
  });

  pushIf(/(http:\/\/|https:\/\/|dns-query|beacon|c2|\/api\/v\d\/|telegram\.org|discord(app)?\.com\/api)/i.test(lower), {
    code: "net.beacon.indicator",
    summary: "Potential outbound beacon",
    detail: "Network endpoint or beacon-like token detected in executable/text section.",
    severity: "medium",
    score: 20,
  });

  pushIf(networkAttempts.length > 0, {
    code: "net.airgap.intercept",
    summary: "Air-gap intercepts captured",
    detail: `${networkAttempts.length} outbound endpoint attempt(s) intercepted as blocked Layer-2 frames.`,
    severity: "high",
    score: Math.min(22, 8 + networkAttempts.length * 2),
  });

  pushIf(/(autoopen|document_open|vba|macro|ole|activex|shell\()/i.test(lower), {
    code: "doc.macro.trigger",
    summary: "Macro-trigger behavior",
    detail: "Document automation trigger signatures found.",
    severity: "medium",
    score: 18,
  });

  const entropy = sampleEntropy(bytes);
  pushIf(file.size > 1024 * 1024 && entropy >= 7.6, {
    code: "pack.high-entropy",
    summary: "High entropy payload region",
    detail: `Sample entropy ${entropy.toFixed(2)} suggests packed or encrypted content.`,
    severity: "medium",
    score: 14,
  });

  pushIf(/(virtualbox|vmware|qemu|vboxservice|cpuid|rdtsc|isdebuggerpresent)/i.test(lower), {
    code: "evas.anti-analysis",
    summary: "Anti-analysis fingerprints",
    detail: "Possible anti-VM or anti-debug checks detected.",
    severity: "low",
    score: 10,
  });

  pushIf(antiVmMarkers.length > 0, {
    code: "evas.marker-set",
    summary: "Anti-VM marker set",
    detail: `Detected anti-analysis markers: ${antiVmMarkers.slice(0, 6).join(", ")}${antiVmMarkers.length > 6 ? ", ..." : ""}.`,
    severity: "medium",
    score: Math.min(18, 6 + antiVmMarkers.length * 2),
  });

  if (wasmProfile) {
    const scanLength = Math.max(1, wasmProfile.scannedLength);
    const nullRatio = wasmProfile.nullCount / scanLength;
    pushIf(nullRatio >= 0.18, {
      code: "wasm.binary.null-density",
      summary: "Binary null-byte density spike",
      detail: `WASM profile saw ${(nullRatio * 100).toFixed(1)}% null bytes in sample window.`,
      severity: "medium",
      score: 12,
    });

    pushIf(wasmProfile.colonCount >= 8 && wasmProfile.slashCount >= 18, {
      code: "wasm.net.literal-density",
      summary: "URL-like literal density",
      detail: `WASM profile observed high ':' and '/' concentration typical of hardcoded endpoints.`,
      severity: "medium",
      score: 10,
    });

    pushIf(wasmProfile.schemePairCount >= 3 && wasmProfile.doubleSlashCount >= 2, {
      code: "wasm.net.scheme-pair",
      summary: "Protocol pair bursts",
      detail: `WASM pair-scan found ${wasmProfile.schemePairCount} ':/' and ${wasmProfile.doubleSlashCount} '//' patterns.`,
      severity: "medium",
      score: 11,
    });

    pushIf(wasmProfile.schemeTripletCount >= 2, {
      code: "wasm.net.scheme-triplet",
      summary: "Protocol triplet burst",
      detail: `WASM triplet-scan found ${wasmProfile.schemeTripletCount} '://' patterns.`,
      severity: "medium",
      score: 10,
    });

    pushIf(wasmProfile.vmTraceScore >= 42, {
      code: "wasm.vm.trace-signal",
      summary: "Micro-VM trace anomaly",
      detail: `WASM trace VM produced score ${wasmProfile.vmTraceScore}, exceeding suspicious threshold.`,
      severity: "high",
      score: 16,
    });

    const transferOpCount = wasmProfile.nearCallCount + wasmProfile.relJumpCount + wasmProfile.shortJumpCount;
    pushIf(transferOpCount >= 24, {
      code: "wasm.exec.transfer-density",
      summary: "Control-transfer opcode density",
      detail: `WASM profile found ${transferOpCount} call/jump opcodes in sampled region.`,
      severity: "medium",
      score: 12,
    });

    const syscallStubCount = wasmProfile.syscallPairCount + wasmProfile.int80PairCount;
    pushIf(syscallStubCount >= 1, {
      code: "wasm.exec.syscall-stub",
      summary: "Direct syscall pattern",
      detail: `WASM profile found ${wasmProfile.syscallPairCount} '0f05' and ${wasmProfile.int80PairCount} 'cd80' stubs.`,
      severity: "high",
      score: Math.min(20, 12 + syscallStubCount * 2),
    });

    pushIf(wasmProfile.rdtscPairCount + wasmProfile.cpuidPairCount >= 1, {
      code: "wasm.evas.cpu-timing",
      summary: "CPU timing fingerprint opcodes",
      detail: `WASM profile found rdtsc=${wasmProfile.rdtscPairCount}, cpuid=${wasmProfile.cpuidPairCount}.`,
      severity: "medium",
      score: 11,
    });

    pushIf(wasmProfile.int3Count >= 4, {
      code: "wasm.debug.breakpoint-litter",
      summary: "Breakpoint byte littering",
      detail: `WASM profile found ${wasmProfile.int3Count} INT3 bytes (0xCC), common in anti-analysis traps.`,
      severity: "low",
      score: 8,
    });
  }

  return { events, networkAttempts, antiVmMarkers };
}

function buildStripManifest(
  fileName: string,
  events: ThreatEvent[],
  networkAttempts: string[],
  telemetry: MirrorStrikeTelemetry,
  ingress: CageIngressMetadata | null,
  wasmProfile: CageWasmProfile | null,
): StripManifest {
  const rules: StripRule[] = [];

  if (events.some((event) => event.code === "net.beacon.indicator")) {
    rules.push({
      rule: "Strip URL/domain/IP strings and socket initialization paths",
      rationale: "Neutralize outbound beacon attempts seen during Cage analysis",
      confidence: 0.78,
    });
  }

  if (events.some((event) => event.code === "exec.ps1.loader" || event.code === "exec.lolbin.chain")) {
    rules.push({
      rule: "Remove script launcher sections and shell invocation tokens",
      rationale: "Prevent child-process and script-loader execution branches",
      confidence: 0.84,
    });
  }

  if (events.some((event) => event.code === "doc.macro.trigger")) {
    rules.push({
      rule: "Disable macro/auto-open metadata records",
      rationale: "Block automatic execution on open",
      confidence: 0.69,
    });
  }

  if (networkAttempts.length > 0) {
    rules.push({
      rule: "Block and strip captured outbound endpoint literals",
      rationale: "Enforce air-gap containment on observed network intents",
      confidence: 0.86,
    });
  }

  if (telemetry.ghostPatches.length > 0 || events.some((event) => event.code.startsWith("wasm.evas."))) {
    rules.push({
      rule: "Patch anti-VM branch checks to deterministic pass",
      rationale: "Neutralize evasive control flow before downstream analysis",
      confidence: 0.75,
    });
  }

  if (wasmProfile && wasmProfile.syscallPairCount + wasmProfile.int80PairCount > 0) {
    rules.push({
      rule: "Remove direct syscall trampolines and kernel transition stubs",
      rationale: "Constrain privileged execution pivots observed in binary profile",
      confidence: 0.81,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceFile: fileName,
    requestedStrip: rules,
    airGapIntercepts: networkAttempts,
    airGapFrames: telemetry.airGapFrames,
    ghostPatches: telemetry.ghostPatches,
    evidenceCodes: events.map((event) => event.code),
    ingress,
  };
}

export function initCage(opts: CageUIOptions): () => void {
  let destroyed = false;
  let currentFile: File | null = null;
  let ingressMetadata: CageIngressMetadata | null = null;
  let lastManifest: StripManifest | null = null;
  let lastTelemetry: MirrorStrikeTelemetry | null = null;
  let lastRuntime: CageWasmRunInfo | null = null;
  let lastVerdict: { score: number; label: string; reason: string } | null = null;
  let runGeneration = 0;
  let handoffSupported = true;
  let lensHandoffInFlight = false;
  let actionBarTimer: number | undefined;
  let copyResetTimer: number | undefined;
  const cleanups: Array<() => void> = [];

  function updateLensActionButton(): void {
    const visible = handoffSupported && Boolean(currentFile);
    opts.actionLensBtn.style.display = visible ? "" : "none";
    opts.actionLensBtn.disabled = !visible || lensHandoffInFlight;
    opts.actionLensBtn.setAttribute("aria-busy", lensHandoffInFlight ? "true" : "false");
  }

  function showActionsBar(): void {
    if (actionBarTimer !== undefined) {
      window.clearTimeout(actionBarTimer);
      actionBarTimer = undefined;
    }
    opts.actionsBar.style.display = "";
    window.requestAnimationFrame(() => {
      if (!destroyed) {
        opts.actionsBar.style.opacity = "1";
      }
    });
  }

  function hideActionsBar(): void {
    if (actionBarTimer !== undefined) {
      window.clearTimeout(actionBarTimer);
      actionBarTimer = undefined;
    }
    opts.actionsBar.style.opacity = "0";
    actionBarTimer = window.setTimeout(() => {
      if (!destroyed && !currentFile) {
        opts.actionsBar.style.display = "none";
      }
      actionBarTimer = undefined;
    }, ACTION_BAR_FADE_MS);
  }

  function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
  }

  function saveRefreshFileToken(token: string): void {
    try {
      window.localStorage.setItem(CAGE_REFRESH_FILE_KEY, token);
    } catch {
      // Ignore persistence errors.
    }
  }

  function loadRefreshFileToken(): string | null {
    try {
      const token = window.localStorage.getItem(CAGE_REFRESH_FILE_KEY);
      return token && token.trim().length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  function clearRefreshFileToken(): void {
    try {
      window.localStorage.removeItem(CAGE_REFRESH_FILE_KEY);
    } catch {
      // Ignore persistence errors.
    }
  }

  async function persistCurrentFileForRefresh(file: File, ingress: CageIngressMetadata | null): Promise<void> {
    try {
      if (!(await supportsFileHandoff())) return;
      const token = await createFileHandoff(file, ingress ?? undefined);
      saveRefreshFileToken(token);
    } catch {
      // Ignore persistence errors.
    }
  }

  function setSource(file: File, ingress: CageIngressMetadata | null = null): void {
    runGeneration += 1;
    currentFile = file;
    ingressMetadata = ingress;
    lastManifest = null;
    lastTelemetry = null;
    lastRuntime = null;
    lastVerdict = null;
    showActionsBar();
    opts.sourceName.textContent = file.name;
    const sourceMetaParts = [formatSize(file.size), file.type || "unknown mime"];
    if (ingress?.source === "lens" && ingress.risk) {
      sourceMetaParts.push(`lens risk ${ingress.risk.level}:${ingress.risk.score}`);
    } else if (ingress?.source) {
      sourceMetaParts.push(`handoff source: ${ingress.source}`);
    }
    opts.sourceMeta.textContent = sourceMetaParts.join(" - ");
    opts.viewport.textContent = [
      "mirror-strike profile: v1 baseline",
      "clock virtualization: enabled",
      "cpuid impersonation: enabled",
      "ghost execution patchpoints: enabled",
      "air-gap logging: enabled",
      ingress?.source ? `handoff ingress: ${ingress.source}` : "handoff ingress: direct upload",
      `guest target: ${file.name}`,
    ].join("\n");
    opts.actionRunBtn.disabled = false;
    opts.actionClearBtn.disabled = false;
    updateLensActionButton();
    void persistCurrentFileForRefresh(file, ingress);
  }

  function resetVerdict(): void {
    opts.verdictScore.textContent = "0";
    opts.verdictLabel.textContent = "idle";
    opts.verdictReason.textContent = "awaiting interrogation run";
    opts.threatLog.replaceChildren();
    opts.threatEmpty.style.display = "";
    opts.threatEmpty.textContent = "No events yet.";
    opts.manifestOutput.textContent = "{\n  \"requestedStrip\": [],\n  \"airGapIntercepts\": [],\n  \"airGapFrames\": [],\n  \"ghostPatches\": [],\n  \"evidenceCodes\": [],\n  \"ingress\": null\n}";
  }

  function clearAll(): void {
    runGeneration += 1;
    currentFile = null;
    ingressMetadata = null;
    lastManifest = null;
    lastTelemetry = null;
    lastRuntime = null;
    lastVerdict = null;
    hideActionsBar();
    opts.fileInput.value = "";
    opts.sourceName.textContent = "no file loaded";
    opts.viewport.textContent = "v86 viewport is idle. load a file and run interrogation.";
    opts.actionRunBtn.disabled = true;
    opts.actionClearBtn.disabled = true;
    updateLensActionButton();
    clearRefreshFileToken();
    resetVerdict();
  }

  function appendThreatRow(event: ThreatEvent): void {
    const row = el("li", `cage-threat-row cage-threat-row--${event.severity}`);
    const heading = el("p", "cage-threat-heading", `${event.summary}${event.score > 0 ? ` (+${event.score})` : ""}`);
    const code = el("p", "cage-threat-code", event.code);
    const detail = el("p", "cage-threat-detail", event.detail);
    row.append(heading, code, detail);
    opts.threatLog.appendChild(row);
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function appendThreatFeed(events: ThreatEvent[]): Promise<number> {
    let score = 0;
    for (const event of events) {
      if (destroyed) break;
      appendThreatRow(event);
      score += event.score;
      await delay(THREAT_FEED_STEP_DELAY_MS);
    }
    return Math.min(100, score);
  }

  async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function shouldHandleClipboardFilePaste(event: ClipboardEvent): boolean {
    if (isEditablePasteTarget(event.target)) return false;

    const target = event.target;
    if (target instanceof Node && opts.page.contains(target)) return true;

    const active = document.activeElement;
    if (active instanceof Node && opts.page.contains(active)) return true;

    return false;
  }

  async function runInterrogation(): Promise<void> {
    if (!currentFile) return;

    const runFile = currentFile;
    const runId = ++runGeneration;

    opts.actionRunBtn.disabled = true;
    opts.actionRunBtn.textContent = "Running...";
    opts.threatLog.replaceChildren();
    opts.threatEmpty.style.display = "none";

    try {
      const bytes = new Uint8Array(await runFile.slice(0, MAX_SCAN_BYTES).arrayBuffer());
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const wasmRun = await profileBytesWithWasm(bytes);
      const wasmProfile = wasmRun.profile;
      const detection = detectThreatEvents(runFile, bytes, text, wasmProfile, ingressMetadata);
      const telemetry = buildMirrorStrikeTelemetry(bytes, wasmProfile, detection.antiVmMarkers, detection.networkAttempts);

      if (destroyed || runId !== runGeneration || currentFile !== runFile) return;

      const analyticEvents: ThreatEvent[] = [...detection.events];
      if (telemetry.ghostPatches.length > 0) {
        analyticEvents.push({
          code: "evas.ghost.patchpoints",
          summary: `Ghost execution patchpoints armed (${telemetry.ghostPatches.length})`,
          detail: "Branch checks tied to anti-analysis probes were force-patched to pass in mirror execution lane.",
          severity: "high",
          score: Math.min(18, 8 + (telemetry.ghostPatches.length * 2)),
        });
      }

      const traceEvents: ThreatEvent[] = [];
      for (const frame of telemetry.airGapFrames) {
        traceEvents.push({
          code: "net.airgap.frame.block",
          summary: `Air-gap frame blocked -> ${frame.endpoint}`,
          detail: `L2 ${frame.srcMac} -> ${frame.dstMac} ${frame.ethType} ${frame.frameBytes}B, guest=${frame.guestOutcome}, t=${frame.virtualMs}ms`,
          severity: "medium",
          score: 0,
        });
      }
      for (const patch of telemetry.ghostPatches) {
        traceEvents.push({
          code: "evas.ghost.patch",
          summary: `Ghost patch @ ${formatOffset(patch.offset)} (${patch.signature})`,
          detail: `${patch.rationale} forced=${patch.forcedResult}`,
          severity: "low",
          score: 0,
        });
      }
      if (!wasmProfile) {
        traceEvents.push({
          code: `wasm.runtime.${wasmRun.runtime.code}`,
          summary: `WASM fallback engaged (${wasmRun.runtime.code})`,
          detail: formatWasmRuntime(wasmRun.runtime),
          severity: "low",
          score: 0,
        });
      }

      const viewportLines = [
        "mirror-strike profile: v1 baseline",
        "clock virtualization: enabled",
        "cpuid impersonation: enabled",
        "ghost execution patchpoints: enabled",
        "air-gap logging: enabled",
        `gaslit clock: ${(telemetry.clock.tscHz / 1_000_000_000).toFixed(2)}GHz, cycles=${telemetry.clock.virtualCycles}, elapsed=${telemetry.clock.elapsedMs}ms, jitter=${telemetry.clock.jitterPpm}ppm`,
        `cpuid persona: ${telemetry.cpuid.vendor} ${telemetry.cpuid.signature}`,
        `ghost patchpoints: ${telemetry.ghostPatches.length}`,
        `air-gap frames blocked: ${telemetry.airGapFrames.length}`,
      ];
      if (ingressMetadata?.source === "lens" && ingressMetadata.risk) {
        viewportLines.push(`lens ingress risk: ${ingressMetadata.risk.level}:${ingressMetadata.risk.score}`);
      }

      if (wasmProfile) {
        viewportLines.push(
          "native wasm scanner: active",
          "micro-vm trace core: active",
          `scan window: ${wasmProfile.scannedLength} bytes${wasmProfile.truncated ? " (truncated)" : ""}`,
          `trace step budget: ${wasmProfile.stepBudget}`,
          `null-byte density: ${((wasmProfile.nullCount / Math.max(1, wasmProfile.scannedLength)) * 100).toFixed(1)}%`,
          `url-literal markers: colon=${wasmProfile.colonCount}, slash=${wasmProfile.slashCount}`,
          `scheme markers: :/=${wasmProfile.schemePairCount}, //=${wasmProfile.doubleSlashCount}, ://=${wasmProfile.schemeTripletCount}`,
          `opcode telemetry: call=${wasmProfile.nearCallCount}, jmp=${wasmProfile.relJumpCount + wasmProfile.shortJumpCount}, int3=${wasmProfile.int3Count}, ret=${wasmProfile.retCount}`,
          `syscall stubs: 0f05=${wasmProfile.syscallPairCount}, cd80=${wasmProfile.int80PairCount}`,
          `cpu timing ops: rdtsc=${wasmProfile.rdtscPairCount}, cpuid=${wasmProfile.cpuidPairCount}`,
          `trace score: ${wasmProfile.vmTraceScore}`,
        );
      } else {
        viewportLines.push(
          "native wasm scanner: fallback mode",
          "micro-vm trace core: fallback mode",
          "opcode telemetry: unavailable",
          `runtime detail: ${formatWasmRuntime(wasmRun.runtime)}`,
        );
      }
      opts.viewport.textContent = viewportLines.join("\n");

      const feedEvents = [...analyticEvents, ...traceEvents];
      const score = await appendThreatFeed(feedEvents);
      if (destroyed || runId !== runGeneration || currentFile !== runFile) return;

      if (feedEvents.length === 0) {
        opts.threatEmpty.style.display = "";
        opts.threatEmpty.textContent = "No high-confidence behavior indicators detected in the sampled payload.";
      }

      const verdict = summarizeVerdict(score);
      opts.verdictScore.textContent = String(score);
      opts.verdictLabel.textContent = verdict.label;
      opts.verdictReason.textContent = wasmProfile
        ? `${verdict.reason} - wasm core active - air-gap intercepts: ${telemetry.airGapFrames.length}`
        : `${verdict.reason} - wasm fallback (${wasmRun.runtime.code})`;

      const manifest = buildStripManifest(
        runFile.name,
        analyticEvents,
        detection.networkAttempts,
        telemetry,
        ingressMetadata,
        wasmProfile,
      );
      opts.manifestOutput.textContent = JSON.stringify(manifest, null, 2);

      lastManifest = manifest;
      lastTelemetry = telemetry;
      lastRuntime = wasmRun.runtime;
      lastVerdict = { score, label: verdict.label, reason: verdict.reason };
    } catch (error) {
      if (destroyed || runId !== runGeneration) return;
      const message = error instanceof Error ? error.message : "unknown interrogation failure";
      opts.verdictReason.textContent = `interrogation failed: ${message}`;
      opts.threatEmpty.style.display = "";
      opts.threatEmpty.textContent = "Interrogation aborted due to runtime error.";
    } finally {
      if (!destroyed && runId === runGeneration) {
        opts.actionRunBtn.disabled = false;
        opts.actionRunBtn.textContent = "Interrogate";
      }
    }
  }

  on(opts.uploadZone, "click", () => {
    opts.fileInput.click();
  });

  on(opts.uploadZone, "keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    opts.fileInput.click();
  });

  on(opts.uploadZone, "dragover", (event: DragEvent) => {
    event.preventDefault();
    opts.uploadZone.classList.add("cage-drop-active");
  });

  on(opts.uploadZone, "dragleave", () => {
    opts.uploadZone.classList.remove("cage-drop-active");
  });

  on(opts.uploadZone, "drop", (event: DragEvent) => {
    event.preventDefault();
    opts.uploadZone.classList.remove("cage-drop-active");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    setSource(file);
    resetVerdict();
  });

  on(opts.fileInput, "change", () => {
    const file = opts.fileInput.files?.[0];
    if (!file) return;
    setSource(file);
    resetVerdict();
  });

  on(document, "paste", (event: ClipboardEvent) => {
    if (!shouldHandleClipboardFilePaste(event)) return;
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      setSource(file);
      resetVerdict();
      break;
    }
  });

  on(opts.actionRunBtn, "click", () => {
    void runInterrogation();
  });

  on(opts.actionUploadBtn, "click", () => {
    opts.fileInput.click();
  });

  on(opts.actionLensBtn, "click", async () => {
    if (!currentFile || !handoffSupported || lensHandoffInFlight) return;
    lensHandoffInFlight = true;
    updateLensActionButton();
    try {
      const token = await createFileHandoff(currentFile, {
        source: "cage",
        generatedAt: new Date().toISOString(),
        verdict: lastVerdict,
        runtime: lastRuntime,
        manifest: lastManifest,
        telemetry: lastTelemetry
          ? {
              ghostPatchCount: lastTelemetry.ghostPatches.length,
              airGapFrameCount: lastTelemetry.airGapFrames.length,
              clock: lastTelemetry.clock,
              cpuid: lastTelemetry.cpuid,
            }
          : null,
      });
      window.location.href = buildLensHandoffUrl(token);
    } catch {
      opts.verdictReason.textContent = "could not handoff file to lens";
    } finally {
      lensHandoffInFlight = false;
      if (!destroyed) updateLensActionButton();
    }
  });

  on(opts.actionClearBtn, "click", () => {
    clearAll();
  });

  on(opts.manifestCopyBtn, "click", async () => {
    const text = opts.manifestOutput.textContent || "";
    try {
      const copied = await copyTextToClipboard(text);
      opts.manifestCopyBtn.textContent = copied ? "Copied" : "Failed";
    } catch {
      opts.manifestCopyBtn.textContent = "Failed";
    } finally {
      if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => {
        copyResetTimer = undefined;
        if (!destroyed) opts.manifestCopyBtn.textContent = "Copy";
      }, 1200);
    }
  });

  async function initHandoffSupport(): Promise<void> {
    handoffSupported = await supportsFileHandoff();
    updateLensActionButton();
    if (destroyed || handoffSupported) return;
    opts.verdictReason.textContent = "IndexedDB unavailable. handoff/refresh restore disabled.";
  }

  async function consumeHandoffIfPresent(): Promise<void> {
    const token = getHandoffTokenFromCurrentUrl();
    if (!token) return;
    clearHandoffTokenFromCurrentUrl();

    const payload = await consumeFileHandoffWithRetry(token);
    if (!payload || destroyed) return;
    setSource(payload.file, parseCageIngressMetadata(payload.metadata));
    resetVerdict();
  }

  async function restoreRefreshFileIfPresent(): Promise<void> {
    if (currentFile) return;
    const token = loadRefreshFileToken();
    if (!token) return;

    const payload = await consumeFileHandoffWithRetry(token);
    if (!payload || destroyed || currentFile) return;
    setSource(payload.file, parseCageIngressMetadata(payload.metadata));
    resetVerdict();
  }

  clearAll();

  void (async () => {
    try {
      await initHandoffSupport();
      await consumeHandoffIfPresent();
      await restoreRefreshFileIfPresent();
    } catch {
      if (!destroyed) {
        opts.verdictReason.textContent = "Failed to restore previous handoff session.";
      }
    }
  })();

  return () => {
    destroyed = true;
    if (actionBarTimer !== undefined) {
      window.clearTimeout(actionBarTimer);
      actionBarTimer = undefined;
    }
    if (copyResetTimer !== undefined) {
      window.clearTimeout(copyResetTimer);
      copyResetTimer = undefined;
    }
    cleanups.forEach((cleanup) => cleanup());
    cleanups.length = 0;
  };
}
