// radar-ui.ts — Local signal detection tool.
// Uses every browser API that provides real signal data:
// Web Bluetooth LE scan (RSSI), Bluetooth device picker (GATT),
// WebRTC ICE candidate gathering, Network Information API,
// DeviceOrientation (compass heading), Geolocation, Ambient Light Sensor.
// All state scoped inside initRadar() for clean lifecycle.

export interface RadarUIOptions {
  canvas: HTMLCanvasElement;
  modeEl: HTMLElement;
  bluetoothEl: HTMLElement;
  modelEl: HTMLElement;
  totalEl: HTMLElement;
  bluetoothCountEl: HTMLElement;
  wifiCountEl: HTMLElement;
  radioCountEl: HTMLElement;
  activeEl: HTMLElement;
  measuredEl: HTMLElement;
  inferredEl: HTMLElement;
  nearestEl: HTMLElement;
  triageProtocolEl: HTMLSelectElement;
  triageEvidenceEl: HTMLSelectElement;
  triageStateEl: HTMLSelectElement;
  triageSortEl: HTMLSelectElement;
  triageMinConfidenceEl: HTMLInputElement;
  triageMinConfidenceValueEl: HTMLElement;
  triageActiveOnlyEl: HTMLInputElement;
  contactsEl: HTMLElement;
  lockEl: HTMLElement;
  eventsEl: HTMLElement;
  capabilitiesEl: HTMLElement;
  startBtn: HTMLButtonElement;
  stopBtn: HTMLButtonElement;
  bluetoothScanBtn: HTMLButtonElement;
  bluetoothPickBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  selfLocEl: HTMLElement;
  compassEl: HTMLElement;
  ambientEl: HTMLElement;
}

type RadarUIIdMap = { [K in keyof RadarUIOptions]: string };

export const RADAR_UI_IDS: RadarUIIdMap = {
  canvas: "radar-canvas",
  modeEl: "radar-mode",
  bluetoothEl: "radar-bluetooth",
  modelEl: "radar-model",
  totalEl: "radar-total",
  bluetoothCountEl: "radar-bt-count",
  wifiCountEl: "radar-wifi-count",
  radioCountEl: "radar-radio-count",
  activeEl: "radar-active",
  measuredEl: "radar-measured",
  inferredEl: "radar-inferred",
  nearestEl: "radar-nearest",
  triageProtocolEl: "radar-triage-protocol",
  triageEvidenceEl: "radar-triage-evidence",
  triageStateEl: "radar-triage-state",
  triageSortEl: "radar-triage-sort",
  triageMinConfidenceEl: "radar-triage-min-confidence",
  triageMinConfidenceValueEl: "radar-triage-min-confidence-value",
  triageActiveOnlyEl: "radar-triage-active-only",
  contactsEl: "radar-contacts",
  lockEl: "radar-lock",
  eventsEl: "radar-events",
  capabilitiesEl: "radar-capabilities",
  startBtn: "radar-start",
  stopBtn: "radar-stop",
  bluetoothScanBtn: "radar-bt-scan",
  bluetoothPickBtn: "radar-bt-pick",
  clearBtn: "radar-clear",
  selfLocEl: "radar-self-loc",
  compassEl: "radar-compass",
  ambientEl: "radar-ambient",
};

// ─── External type interfaces ────────────────────────────────────────────────

interface BluetoothAdvertisementLike {
  device?: { id?: string; name?: string };
  rssi?: number;
  txPower?: number;
  uuids?: string[];
}

interface BluetoothScanHandleLike {
  stop: () => void;
}

interface BluetoothDeviceLike {
  id: string;
  name?: string | null;
  gatt?: {
    connect: () => Promise<BluetoothGattServerLike>;
    connected?: boolean;
    disconnect: () => void;
  };
}

interface BluetoothGattServerLike {
  getPrimaryServices: () => Promise<Array<{ uuid: string }>>;
  disconnect: () => void;
}

interface BluetoothLike {
  requestLEScan?: (options: {
    acceptAllAdvertisements: boolean;
    keepRepeatedDevices?: boolean;
  }) => Promise<BluetoothScanHandleLike>;
  requestDevice?: (options: {
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }) => Promise<BluetoothDeviceLike>;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface NetworkConnectionLike {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

interface NDEFReadingEventLike extends Event {
  serialNumber: string;
  message: { records: Array<{ recordType: string }> };
}

interface NavigatorLike extends Navigator {
  bluetooth?: BluetoothLike;
  connection?: NetworkConnectionLike;
  usb?: unknown;
  serial?: unknown;
}

interface DeviceOrientationLike extends Event {
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
}

interface AmbientLightSensorLike extends EventTarget {
  illuminance: number | null;
  start: () => void;
  stop: () => void;
}

interface DeviceOrientationEventLike {
  requestPermission?: () => Promise<string>;
}

// ─── Domain types ────────────────────────────────────────────────────────────

type RadarProtocol = "self" | "bluetooth" | "wifi" | "radio";
type EvidenceKind = "measured" | "inferred";
type TrendState = "approaching" | "receding" | "stable" | "unknown";
type ContactLifecycleState = "new" | "acquiring" | "stable" | "degrading" | "lost";
type TriageProtocolFilter = "all" | Exclude<RadarProtocol, "self">;
type TriageEvidenceFilter = "all" | EvidenceKind;
type TriageStateFilter = "all" | ContactLifecycleState;
type TriageSortMode = "priority" | "nearest" | "confidence" | "recent";

function isContactLifecycleState(value: unknown): value is ContactLifecycleState {
  return value === "new" ||
    value === "acquiring" ||
    value === "stable" ||
    value === "degrading" ||
    value === "lost";
}

function coerceContactLifecycleState(value: unknown): ContactLifecycleState {
  return isContactLifecycleState(value) ? value : "new";
}

interface RssiStats {
  count: number;
  mean: number;
  m2: number;
}

interface KalmanRssi {
  x: number;
  p: number;
  q: number;
  r: number;
}

interface TargetHistorySample {
  time: number;
  distanceM: number | null;
  rssi: number;
}

interface RadarTriageModel {
  protocol: TriageProtocolFilter;
  evidence: TriageEvidenceFilter;
  state: TriageStateFilter;
  sort: TriageSortMode;
  minConfidence: number;
  activeOnly: boolean;
}

interface RadarTarget {
  id: string;
  label: string;
  protocol: RadarProtocol;
  evidence: EvidenceKind;
  txPower: number;
  rssiRaw: number;
  rssiFiltered: number;
  rssiSigma: number;
  distanceM: number | null;
  sigmaM: number | null;
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  meta: string;
  angleRad: number;
  stats: RssiStats;
  filter: KalmanRssi;
  history: TargetHistorySample[];
  updateHz: number;
  distanceRateMps: number | null;
  trend: TrendState;
  state: ContactLifecycleState;
  stateSince: number;
}

interface ContactRow {
  target: RadarTarget;
  ageMs: number;
  ageSec: number;
  priority: number;
  state: ContactLifecycleState;
  active: boolean;
}

interface RadarEvent {
  id: string;
  message: string;
  time: number;
  repeatCount?: number;
}

interface Capability {
  key: string;
  available: boolean;
  quality: "full" | "partial" | "none";
  note: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TX_POWER = -59;
const RSSI_MIN = -100;
const RSSI_MAX = -15;
const MIN_DISTANCE_M = 0.3;
const MAX_DISTANCE_M = 80;
const PATH_LOSS_N = 2.2;
const STALE_TARGET_MS = 30_000;
const NETWORK_POLL_MS = 7_000;
const STALE_PURGE_MS = 4_000;
const EVENT_COALESCE_WINDOW_MS = 15_000;
const CONTACT_ACTIVE_WINDOW_MS = 10_000;
const LOST_CONTACT_RETENTION_MS = 12_000;
const TARGET_HISTORY_LIMIT = 14;
const RANGE_RATE_EPSILON_MPS = 0.16;
const MAP_RANGE_FLOOR_M = 16;
const MAP_RANGE_PADDING = 1.35;
const STABLE_SIGMA_MEASURED_DB = 5.2;
const STABLE_SIGMA_INFERRED_DB = 8.8;
const DEGRADING_SIGMA_MEASURED_DB = 8.5;
const DEGRADING_SIGMA_INFERRED_DB = 13.5;
const STABLE_SAMPLE_MIN_MEASURED = 6;
const STABLE_SAMPLE_MIN_INFERRED = 4;
const ACQUIRING_SAMPLE_MIN_MEASURED = 2;
const ACQUIRING_SAMPLE_MIN_INFERRED = 1;
const STABLE_UPDATE_HZ_MIN_MEASURED = 0.2;
const STABLE_UPDATE_HZ_MIN_INFERRED = 0.08;

// ─── Utility ─────────────────────────────────────────────────────────────────

function queryById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

function queryButtonById(root: ParentNode, id: string): HTMLButtonElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLButtonElement ? node : null;
}

function queryInputById(root: ParentNode, id: string): HTMLInputElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLInputElement ? node : null;
}

function querySelectById(root: ParentNode, id: string): HTMLSelectElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLSelectElement ? node : null;
}

function queryCanvasById(root: ParentNode, id: string): HTMLCanvasElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLCanvasElement ? node : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRssi(value: number): number {
  return clamp(value, RSSI_MIN, RSSI_MAX);
}

function hashAngle(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return ((Math.abs(hash) % 360) / 360) * Math.PI * 2;
}

function hashUnit(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
}

// ─── Statistics (Welford online) ─────────────────────────────────────────────

function initStats(x: number): RssiStats {
  return { count: 1, mean: x, m2: 0 };
}

function updateStats(stats: RssiStats, x: number): void {
  stats.count += 1;
  const delta = x - stats.mean;
  stats.mean += delta / stats.count;
  const delta2 = x - stats.mean;
  stats.m2 += delta * delta2;
}

function variance(stats: RssiStats): number {
  if (stats.count < 2) return 0;
  return stats.m2 / (stats.count - 1);
}

function stddev(stats: RssiStats): number {
  return Math.sqrt(variance(stats));
}

// ─── Kalman filter (single state RSSI) ───────────────────────────────────────

function initFilter(x: number): KalmanRssi {
  return { x, p: 16, q: 1.2, r: 9 };
}

function updateFilter(filter: KalmanRssi, z: number): number {
  filter.p += filter.q;
  const k = filter.p / (filter.p + filter.r);
  filter.x = filter.x + k * (z - filter.x);
  filter.p = (1 - k) * filter.p;
  return filter.x;
}

// ─── Physics: path-loss model ────────────────────────────────────────────────

function rssiToDistanceMeters(rssi: number, txPower: number, pathLossN: number): number {
  const exponent = (txPower - rssi) / (10 * pathLossN);
  return clamp(10 ** exponent, MIN_DISTANCE_M, MAX_DISTANCE_M);
}

function sigmaDistanceMeters(distanceM: number, sigmaRssi: number, pathLossN: number): number {
  const dddr = (Math.log(10) / (10 * pathLossN)) * distanceM;
  return clamp(Math.abs(dddr) * sigmaRssi, 0.2, 14);
}

function confidenceScore(sampleCount: number, sigmaRssi: number, evidence: EvidenceKind): number {
  const sampleTerm = clamp(sampleCount / 18, 0, 1);
  const stabilityTerm = clamp(1 - sigmaRssi / 16, 0, 1);
  const evidenceTerm = evidence === "measured" ? 1 : 0.55;
  return clamp((sampleTerm * 0.5 + stabilityTerm * 0.5) * evidenceTerm, 0.05, 0.99);
}

// ICE candidate SDP line format:
// candidate:foundation component protocol priority address port typ type [raddr rport] ...
// Modern browsers often use mDNS (.local) instead of real IPs.
interface ParsedIceCandidate {
  address: string;
  port: number;
  protocol: string;
  type: string; // "host" | "srflx" | "relay" | "prflx"
  isMdns: boolean;
  isIp: boolean;
}

function parseIceCandidate(candidate: string): ParsedIceCandidate | null {
  // SDP a]= line fields: foundation component protocol priority address port typ type ...
  const parts = candidate.split(/\s+/);
  // Minimum: foundation(0) component(1) protocol(2) priority(3) address(4) port(5) "typ"(6) type(7)
  if (parts.length < 8 || parts[6] !== "typ") return null;

  // Strip IPv6 zone identifier before any checks (e.g. fe80::1%eth0 → fe80::1)
  const address = (parts[4] ?? "").replace(/%[a-zA-Z0-9.]+$/, "");
  const port = parseInt(parts[5], 10);
  const protocol = parts[2]?.toLowerCase() || "udp";
  const type = parts[7]?.toLowerCase() || "host";
  const isMdns = address.endsWith(".local");
  // IPv4: dotted-decimal. IPv6: contains colon with only hex/colon chars.
  const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) ||
    (address.includes(":") && /^[0-9a-f:]+$/i.test(address));

  return { address, port, protocol, type, isMdns, isIp };
}

// Classify an IP address string. Returns "loopback", "private", or "public".
// Handles both IPv4 and IPv6 without any browser-specific branching.
function classifyIp(rawAddr: string): "loopback" | "private" | "public" {
  // Strip IPv6 zone identifier (e.g. fe80::1%eth0, fe80::1%2)
  const addr = rawAddr.replace(/%[a-zA-Z0-9.]+$/, "");
  // IPv6 loopback
  if (addr === "::1") return "loopback";
  // IPv4 loopback
  if (addr.startsWith("127.")) return "loopback";
  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return "private";
  // IPv6 unique local (fc00::/7 — fc and fd prefixes)
  if (/^f[cd]/i.test(addr)) return "private";
  // IPv4-mapped IPv6 ::ffff:x.x.x.x — recurse on the v4 part
  const v4mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return classifyIp(v4mapped[1]);
  // IPv4 private ranges
  if (addr.startsWith("10.")) return "private";
  if (addr.startsWith("192.168.")) return "private";
  if (addr.startsWith("169.254.")) return "private"; // link-local
  const m = addr.match(/^172\.(\d+)\./);
  if (m && parseInt(m[1], 10) >= 16 && parseInt(m[1], 10) <= 31) return "private";
  return "public";
}

function isLocalBrowserTarget(target: RadarTarget): boolean {
  if (target.id.startsWith("hw:")) return true;
  if (target.id.startsWith("self:")) return true;
  if (target.id.startsWith("net:uplink:")) return true;
  if (target.id.startsWith("route:mdns:")) return true;

  if (target.id.startsWith("route:")) {
    const addr = target.id.slice("route:".length);
    return classifyIp(addr) !== "public";
  }

  return false;
}

function connectionToInferredRssi(effectiveType: string | undefined, connType: string | undefined): number | null {
  // effectiveType is Chrome/Android only; connType is Firefox/broader support
  switch (effectiveType) {
    case "4g": return -56;
    case "3g": return -69;
    case "2g": return -85;
    case "slow-2g": return -92;
  }
  // Fallback: use connection.type (available in Firefox)
  switch (connType) {
    case "ethernet": return -42;
    case "wifi": return -55;
    case "wimax": return -58;
    case "cellular": return -72;
    case "bluetooth": return -65;
    default: return null;
  }
}

function rangeToCanvasRadius(distanceM: number, scopeRadiusPx: number, mapRangeM = MAX_DISTANCE_M): number {
  const clampedRange = clamp(mapRangeM, MAP_RANGE_FLOOR_M, MAX_DISTANCE_M);
  const normalized = Math.log1p(distanceM) / Math.log1p(clampedRange);
  return clamp(normalized, 0.03, 0.98) * scopeRadiusPx;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function formatDistance(meters: number): string {
  if (meters < 1) return `${Math.round(meters * 100)}cm`;
  if (meters < 10) return `${meters.toFixed(1)}m`;
  return `${Math.round(meters)}m`;
}

function formatCoord(deg: number, posChar: string, negChar: string): string {
  const dir = deg >= 0 ? posChar : negChar;
  return `${Math.abs(deg).toFixed(5)}${dir}`;
}

function normalizeDegrees(degrees: number): number {
  const normalized = degrees % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function angleRadToBearingDeg(angleRad: number): number {
  return normalizeDegrees((angleRad * 180) / Math.PI + 90);
}

function bearingToCardinal(bearingDeg: number): string {
  const cardinals = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(normalizeDegrees(bearingDeg) / 45) % cardinals.length;
  return cardinals[index];
}

function relativeBearingLabel(bearingDeg: number, headingDeg: number | null): string | null {
  if (headingDeg === null) return null;
  const delta = normalizeDegrees(bearingDeg - headingDeg);
  if (delta < 22.5 || delta >= 337.5) return "ahead";
  if (delta < 67.5) return "ahead-right";
  if (delta < 112.5) return "right";
  if (delta < 157.5) return "rear-right";
  if (delta < 202.5) return "rear";
  if (delta < 247.5) return "rear-left";
  if (delta < 292.5) return "left";
  return "ahead-left";
}

function trendFromRate(rateMps: number | null): TrendState {
  if (rateMps === null || !Number.isFinite(rateMps)) return "unknown";
  if (rateMps <= -RANGE_RATE_EPSILON_MPS) return "approaching";
  if (rateMps >= RANGE_RATE_EPSILON_MPS) return "receding";
  return "stable";
}

function formatRate(rateMps: number | null): string {
  if (rateMps === null || !Number.isFinite(rateMps)) return "--";
  const magnitude = Math.abs(rateMps);
  const precision = magnitude >= 10 ? 0 : magnitude >= 1 ? 1 : 2;
  const suffix = trendFromRate(rateMps);
  if (suffix === "stable") return `${magnitude.toFixed(precision)}m/s stable`;
  return `${magnitude.toFixed(precision)}m/s ${suffix === "approaching" ? "closing" : "opening"}`;
}

function formatUpdateRate(updateHz: number): string {
  if (!Number.isFinite(updateHz) || updateHz <= 0) return "--";
  if (updateHz >= 10) return `${updateHz.toFixed(1)}Hz`;
  if (updateHz >= 1) return `${updateHz.toFixed(2)}Hz`;
  return `${updateHz.toFixed(3)}Hz`;
}

function sanitizeProtocolFilter(value: string): TriageProtocolFilter {
  if (value === "bluetooth" || value === "wifi" || value === "radio") return value;
  return "all";
}

function sanitizeEvidenceFilter(value: string): TriageEvidenceFilter {
  if (value === "measured" || value === "inferred") return value;
  return "all";
}

function sanitizeStateFilter(value: string): TriageStateFilter {
  if (
    value === "new" ||
    value === "acquiring" ||
    value === "stable" ||
    value === "degrading" ||
    value === "lost"
  ) {
    return value;
  }
  return "all";
}

function sanitizeSortMode(value: string): TriageSortMode {
  if (value === "nearest" || value === "confidence" || value === "recent") return value;
  return "priority";
}

function formatContactState(state: ContactLifecycleState): string {
  return coerceContactLifecycleState(state);
}

function stateWeight(state: ContactLifecycleState): number {
  switch (coerceContactLifecycleState(state)) {
    case "stable":
      return 1;
    case "acquiring":
      return 0.82;
    case "new":
      return 0.7;
    case "degrading":
      return 0.52;
    case "lost":
      return 0.2;
    default:
      return 0.7;
  }
}

function isTargetStableCandidate(target: RadarTarget, ageMs: number): boolean {
  const sampleMin = target.evidence === "measured" ? STABLE_SAMPLE_MIN_MEASURED : STABLE_SAMPLE_MIN_INFERRED;
  const sigmaMax = target.evidence === "measured" ? STABLE_SIGMA_MEASURED_DB : STABLE_SIGMA_INFERRED_DB;
  const updateMin = target.evidence === "measured" ? STABLE_UPDATE_HZ_MIN_MEASURED : STABLE_UPDATE_HZ_MIN_INFERRED;
  return (
    target.stats.count >= sampleMin &&
    target.rssiSigma <= sigmaMax &&
    target.updateHz >= updateMin &&
    ageMs <= CONTACT_ACTIVE_WINDOW_MS * 0.45
  );
}

function isTargetAcquiringCandidate(target: RadarTarget, ageMs: number): boolean {
  const sampleMin = target.evidence === "measured" ? ACQUIRING_SAMPLE_MIN_MEASURED : ACQUIRING_SAMPLE_MIN_INFERRED;
  const sigmaMax = target.evidence === "measured" ? DEGRADING_SIGMA_MEASURED_DB : DEGRADING_SIGMA_INFERRED_DB;
  return target.stats.count >= sampleMin && target.rssiSigma <= sigmaMax && ageMs <= CONTACT_ACTIVE_WINDOW_MS;
}

function deriveNextTargetState(target: RadarTarget, now: number): ContactLifecycleState {
  const currentState = coerceContactLifecycleState(target.state);
  if (target.state !== currentState) {
    target.state = currentState;
    target.stateSince = Number.isFinite(target.stateSince) ? target.stateSince : now;
  }
  const ageMs = Math.max(0, now - target.lastSeen);
  if (ageMs >= STALE_TARGET_MS) return "lost";

  const stable = isTargetStableCandidate(target, ageMs);
  const acquiring = isTargetAcquiringCandidate(target, ageMs);

  switch (currentState) {
    case "new":
      if (ageMs > CONTACT_ACTIVE_WINDOW_MS * 0.7) return "degrading";
      return acquiring ? "acquiring" : "new";
    case "acquiring":
      if (stable) return "stable";
      if (ageMs > CONTACT_ACTIVE_WINDOW_MS * 0.8) return "degrading";
      return "acquiring";
    case "stable":
      if (stable) return "stable";
      return "degrading";
    case "degrading":
      if (stable) return "stable";
      if (acquiring) return "acquiring";
      if (ageMs > CONTACT_ACTIVE_WINDOW_MS) return "lost";
      return "degrading";
    case "lost":
      return acquiring ? "acquiring" : "lost";
  }
}

function syncTargetState(target: RadarTarget, now: number): boolean {
  const next = deriveNextTargetState(target, now);
  if (next === target.state) return false;
  target.state = next;
  target.stateSince = now;
  return true;
}

function isTargetActive(target: RadarTarget, now: number): boolean {
  return now - target.lastSeen <= CONTACT_ACTIVE_WINDOW_MS && target.state !== "lost";
}

function computeTargetPriority(target: RadarTarget, now: number): number {
  const ageMs = Math.max(0, now - target.lastSeen);
  const freshness = clamp(1 - ageMs / STALE_TARGET_MS, 0, 1);
  const confidence = target.confidence;
  const stability = clamp(1 - target.rssiSigma / 18, 0, 1);
  const proximity = target.distanceM === null ? 0.45 : clamp(1 - target.distanceM / MAX_DISTANCE_M, 0, 1);
  const evidenceWeight = target.evidence === "measured" ? 1 : 0.7;
  const stateTerm = stateWeight(target.state);
  const lostPenalty = target.state === "lost" ? 0.4 : 1;
  return clamp(
    (confidence * 0.37 + freshness * 0.22 + proximity * 0.18 + stability * 0.11 + stateTerm * 0.12) *
    evidenceWeight *
    lostPenalty,
    0.02,
    0.99,
  );
}

function matchesTriage(row: ContactRow, triage: RadarTriageModel): boolean {
  if (row.target.id === "self:device") return true;
  if (triage.protocol !== "all" && row.target.protocol !== triage.protocol) return false;
  if (triage.evidence !== "all" && row.target.evidence !== triage.evidence) return false;
  if (triage.state !== "all" && row.state !== triage.state) return false;
  if (triage.activeOnly && !row.active) return false;
  if (Math.round(row.target.confidence * 100) < triage.minConfidence) return false;
  return true;
}

function compareRowsByPriority(a: ContactRow, b: ContactRow): number {
  const measuredDelta = Number(b.target.evidence === "measured") - Number(a.target.evidence === "measured");
  if (measuredDelta !== 0) return measuredDelta;
  const priorityDelta = b.priority - a.priority;
  if (Math.abs(priorityDelta) > 0.0001) return priorityDelta;
  if (a.target.distanceM !== null && b.target.distanceM !== null) return a.target.distanceM - b.target.distanceM;
  return b.target.lastSeen - a.target.lastSeen;
}

function sortContactRows(rows: ContactRow[], mode: TriageSortMode): ContactRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (mode === "nearest") {
      const aDistance = a.target.distanceM ?? Number.POSITIVE_INFINITY;
      const bDistance = b.target.distanceM ?? Number.POSITIVE_INFINITY;
      if (aDistance !== bDistance) return aDistance - bDistance;
      return compareRowsByPriority(a, b);
    }
    if (mode === "confidence") {
      const confidenceDelta = b.target.confidence - a.target.confidence;
      if (Math.abs(confidenceDelta) > 0.0001) return confidenceDelta;
      return compareRowsByPriority(a, b);
    }
    if (mode === "recent") {
      if (a.target.lastSeen !== b.target.lastSeen) return b.target.lastSeen - a.target.lastSeen;
      return compareRowsByPriority(a, b);
    }
    return compareRowsByPriority(a, b);
  });
  return sorted;
}

function resolveFilteredRows(
  targets: Iterable<RadarTarget>,
  now: number,
  triage: RadarTriageModel,
): { allRows: ContactRow[]; filteredRows: ContactRow[] } {
  const allRows: ContactRow[] = [];
  for (const target of targets) {
    if (target.protocol === "self" && target.id !== "self:device") continue;
    const ageMs = Math.max(0, now - target.lastSeen);
    const row: ContactRow = {
      target,
      ageMs,
      ageSec: Math.max(0, Math.floor(ageMs / 1000)),
      priority: computeTargetPriority(target, now),
      state: coerceContactLifecycleState(target.state),
      active: isTargetActive(target, now),
    };
    allRows.push(row);
  }

  const filteredRows = sortContactRows(allRows.filter((row) => matchesTriage(row, triage)), triage.sort);
  return { allRows, filteredRows };
}

function resolveMapRangeMeters(targets: Iterable<RadarTarget>): number {
  let farthestMeasured = 0;
  for (const target of targets) {
    if (target.protocol === "self") continue;
    if (target.evidence !== "measured" || target.distanceM === null) continue;
    farthestMeasured = Math.max(farthestMeasured, target.distanceM);
  }

  if (farthestMeasured <= 0) return MAX_DISTANCE_M;
  return clamp(farthestMeasured * MAP_RANGE_PADDING, MAP_RANGE_FLOOR_M, MAX_DISTANCE_M);
}

function buildRangeRings(mapRangeM: number): number[] {
  const fractions = [0.1, 0.24, 0.42, 0.67, 1];
  const rings: number[] = [];
  for (const fraction of fractions) {
    const raw = mapRangeM * fraction;
    const rounded = raw < 1 ? Math.max(0.2, Number(raw.toFixed(1))) : Math.max(1, Math.round(raw));
    if (rings.length === 0 || rounded > rings[rings.length - 1]) rings.push(rounded);
  }
  if (rings[rings.length - 1] !== Math.round(mapRangeM)) rings[rings.length - 1] = Math.round(mapRangeM);
  return rings;
}

function findContactItem(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("li[data-contact-id]");
}

function findContactItemById(root: ParentNode, id: string | null): HTMLElement | null {
  if (id === null) return null;
  for (const item of root.querySelectorAll<HTMLElement>("li[data-contact-id]")) {
    if (item.dataset.contactId === id) return item;
  }
  return null;
}

interface EventPoint {
  clientX: number;
  clientY: number;
  pointerType: "mouse" | "touch" | "pen" | "unknown";
}

function getEventPoint(event: Event): EventPoint | null {
  if (typeof PointerEvent !== "undefined" && event instanceof PointerEvent) {
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType === "mouse" || event.pointerType === "touch" || event.pointerType === "pen"
        ? event.pointerType
        : "unknown",
    };
  }

  if (typeof MouseEvent !== "undefined" && event instanceof MouseEvent) {
    return { clientX: event.clientX, clientY: event.clientY, pointerType: "mouse" };
  }

  const touchLike = event as TouchEvent;
  const touch = touchLike.changedTouches?.[0] ?? touchLike.touches?.[0];
  if (touch) return { clientX: touch.clientX, clientY: touch.clientY, pointerType: "touch" };

  return null;
}

// ─── Capability audit ────────────────────────────────────────────────────────

function resolveCapabilities(nav: NavigatorLike): Capability[] {
  const bt = nav.bluetooth;
  const hasBt = Boolean(bt);
  const hasLeScan = Boolean(bt && typeof bt.requestLEScan === "function");
  const hasPicker = Boolean(bt && typeof bt.requestDevice === "function");
  const hasNetworkInfo = Boolean(nav.connection);
  const hasRtc = typeof RTCPeerConnection === "function";
  const secure = typeof isSecureContext !== "undefined" ? isSecureContext : false;
  const hasOrientation = "DeviceOrientationEvent" in window;
  const hasGeo = Boolean(nav.geolocation);
  const hasEnumerateDevices = typeof nav.mediaDevices?.enumerateDevices === "function";
  let hasAls = false;
  try { hasAls = "AmbientLightSensor" in window; } catch { /* */ }
  let hasNfc = false;
  try { hasNfc = "NDEFReader" in window; } catch { /* */ }
  const hasUsb = "usb" in nav;
  const hasSerial = "serial" in nav;

  const hasNavTiming = typeof performance !== "undefined" &&
    typeof performance.getEntriesByType === "function";
  let hasNavTimingEntries = false;
  try {
    if (hasNavTiming) hasNavTimingEntries = performance.getEntriesByType("navigation").length > 0;
  } catch { /* */ }

  const hasResourceTiming = typeof PerformanceObserver !== "undefined" &&
    typeof (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      .supportedEntryTypes?.includes === "function" &&
    (PerformanceObserver as unknown as { supportedEntryTypes: string[] })
      .supportedEntryTypes.includes("resource");

  return [
    {
      key: "secure-context",
      available: secure,
      quality: secure ? "full" : "none",
      note: secure ? "required APIs unlocked" : "https or localhost required",
    },
    {
      key: "bluetooth-le-scan",
      available: hasLeScan,
      quality: hasLeScan ? "full" : "none",
      note: hasLeScan
        ? "real-time advertisement RSSI stream"
        : hasBt
          ? "bluetooth present but passive scan not exposed (device picker may still work)"
          : "Web Bluetooth not available in this browser",
    },
    {
      key: "bluetooth-device-picker",
      available: hasPicker,
      quality: hasPicker ? "partial" : "none",
      note: hasPicker
        ? "manual device selection via browser dialog"
        : hasBt
          ? "bluetooth present but requestDevice not exposed"
          : "Web Bluetooth not available in this browser",
    },
    {
      key: "network-information",
      available: hasNetworkInfo,
      quality: hasNetworkInfo ? "partial" : "none",
      note: hasNetworkInfo ? "effective type, downlink, rtt" : "API not available",
    },
    {
      key: "navigation-timing",
      available: hasNavTiming && hasNavTimingEntries,
      quality: hasNavTimingEntries ? "full" : hasNavTiming ? "partial" : "none",
      note: hasNavTimingEntries
        ? "page-load connection timing for RTT inference"
        : hasNavTiming
          ? "API present but no navigation entries available"
          : "Performance API unavailable",
    },
    {
      key: "resource-timing",
      available: hasResourceTiming,
      quality: hasResourceTiming ? "full" : "none",
      note: hasResourceTiming
        ? "live resource fetch timing via PerformanceObserver"
        : "PerformanceObserver resource entries unavailable",
    },
    {
      key: "enumerate-devices",
      available: hasEnumerateDevices,
      quality: hasEnumerateDevices ? "partial" : "none",
      note: hasEnumerateDevices ? "local audio/video hardware inventory" : "mediaDevices API unavailable",
    },
    {
      key: "webrtc-ice",
      available: hasRtc,
      quality: hasRtc ? "partial" : "none",
      note: hasRtc ? "local/public route discovery via ICE candidates" : "RTCPeerConnection unavailable",
    },
    {
      key: "device-orientation",
      available: hasOrientation,
      quality: hasOrientation ? "partial" : "none",
      note: hasOrientation ? "compass heading for map orientation" : "not available",
    },
    {
      key: "geolocation",
      available: hasGeo,
      quality: hasGeo ? "partial" : "none",
      note: hasGeo ? "self-position with accuracy and heading fallback" : "not available",
    },
    {
      key: "ambient-light-sensor",
      available: hasAls,
      quality: hasAls ? "partial" : "none",
      note: hasAls ? "environment lux reading" : "sensor not exposed",
    },
    {
      key: "web-nfc",
      available: hasNfc,
      quality: hasNfc ? "partial" : "none",
      note: hasNfc ? "NFC tag reading via NDEFReader" : "NDEFReader not available",
    },
    {
      key: "web-usb",
      available: hasUsb,
      quality: hasUsb ? "partial" : "none",
      note: hasUsb ? "USB device access available" : "navigator.usb not available",
    },
    {
      key: "web-serial",
      available: hasSerial,
      quality: hasSerial ? "partial" : "none",
      note: hasSerial ? "serial port access available" : "navigator.serial not available",
    },
    {
      key: "wifi-passive-scan",
      available: false,
      quality: "none",
      note: "browser security model does not expose this",
    },
    {
      key: "raw-radio-spectrum",
      available: false,
      quality: "none",
      note: "browser security model does not expose this",
    },
  ];
}

// ─── Resolve UI options ──────────────────────────────────────────────────────

export function resolveRadarUIOptions(root: ParentNode = document): RadarUIOptions | null {
  const canvas = queryCanvasById(root, RADAR_UI_IDS.canvas);
  const modeEl = queryById(root, RADAR_UI_IDS.modeEl);
  const bluetoothEl = queryById(root, RADAR_UI_IDS.bluetoothEl);
  const modelEl = queryById(root, RADAR_UI_IDS.modelEl);
  const totalEl = queryById(root, RADAR_UI_IDS.totalEl);
  const bluetoothCountEl = queryById(root, RADAR_UI_IDS.bluetoothCountEl);
  const wifiCountEl = queryById(root, RADAR_UI_IDS.wifiCountEl);
  const radioCountEl = queryById(root, RADAR_UI_IDS.radioCountEl);
  const activeEl = queryById(root, RADAR_UI_IDS.activeEl);
  const measuredEl = queryById(root, RADAR_UI_IDS.measuredEl);
  const inferredEl = queryById(root, RADAR_UI_IDS.inferredEl);
  const nearestEl = queryById(root, RADAR_UI_IDS.nearestEl);
  const triageProtocolEl = querySelectById(root, RADAR_UI_IDS.triageProtocolEl);
  const triageEvidenceEl = querySelectById(root, RADAR_UI_IDS.triageEvidenceEl);
  const triageStateEl = querySelectById(root, RADAR_UI_IDS.triageStateEl);
  const triageSortEl = querySelectById(root, RADAR_UI_IDS.triageSortEl);
  const triageMinConfidenceEl = queryInputById(root, RADAR_UI_IDS.triageMinConfidenceEl);
  const triageMinConfidenceValueEl = queryById(root, RADAR_UI_IDS.triageMinConfidenceValueEl);
  const triageActiveOnlyEl = queryInputById(root, RADAR_UI_IDS.triageActiveOnlyEl);
  const contactsEl = queryById(root, RADAR_UI_IDS.contactsEl);
  const lockEl = queryById(root, RADAR_UI_IDS.lockEl);
  const eventsEl = queryById(root, RADAR_UI_IDS.eventsEl);
  const capabilitiesEl = queryById(root, RADAR_UI_IDS.capabilitiesEl);
  const startBtn = queryButtonById(root, RADAR_UI_IDS.startBtn);
  const stopBtn = queryButtonById(root, RADAR_UI_IDS.stopBtn);
  const bluetoothScanBtn = queryButtonById(root, RADAR_UI_IDS.bluetoothScanBtn);
  const bluetoothPickBtn = queryButtonById(root, RADAR_UI_IDS.bluetoothPickBtn);
  const clearBtn = queryButtonById(root, RADAR_UI_IDS.clearBtn);
  const selfLocEl = queryById(root, RADAR_UI_IDS.selfLocEl);
  const compassEl = queryById(root, RADAR_UI_IDS.compassEl);
  const ambientEl = queryById(root, RADAR_UI_IDS.ambientEl);

  if (
    !canvas || !modeEl || !bluetoothEl || !modelEl ||
    !totalEl || !bluetoothCountEl || !wifiCountEl || !radioCountEl ||
    !activeEl || !measuredEl || !inferredEl || !nearestEl ||
    !triageProtocolEl || !triageEvidenceEl || !triageStateEl || !triageSortEl ||
    !triageMinConfidenceEl || !triageMinConfidenceValueEl || !triageActiveOnlyEl ||
    !contactsEl || !lockEl || !eventsEl || !capabilitiesEl || !startBtn || !stopBtn ||
    !bluetoothScanBtn || !bluetoothPickBtn || !clearBtn ||
    !selfLocEl || !compassEl || !ambientEl
  ) {
    return null;
  }

  return {
    canvas, modeEl, bluetoothEl, modelEl,
    totalEl, bluetoothCountEl, wifiCountEl, radioCountEl,
    activeEl, measuredEl, inferredEl, nearestEl,
    triageProtocolEl,
    triageEvidenceEl,
    triageStateEl,
    triageSortEl,
    triageMinConfidenceEl,
    triageMinConfidenceValueEl,
    triageActiveOnlyEl,
    contactsEl, lockEl, eventsEl, capabilitiesEl,
    startBtn, stopBtn, bluetoothScanBtn, bluetoothPickBtn, clearBtn,
    selfLocEl, compassEl, ambientEl,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function initRadar(opts: RadarUIOptions): () => void {
  const navigatorLike = navigator as NavigatorLike;
  const bluetooth = navigatorLike.bluetooth;

  const targets = new Map<string, RadarTarget>();
  const events: RadarEvent[] = [];
  const capabilities = resolveCapabilities(navigatorLike);
  const cleanups: Array<() => void> = [];
  const sensorCleanups: Array<() => void> = [];

  let destroyed = false;
  let running = false;
  let loaded = false;
  let animationFrameId = 0;
  let bluetoothScan: BluetoothScanHandleLike | null = null;
  let bluetoothListener: ((event: Event) => void) | null = null;
  let networkPollTimer: number | null = null;
  let stalePurgeTimer: number | null = null;
  let iceProbeInFlight = false;
  let iceProbePending = false;
  let mediaProbeInFlight = false;
  let mediaProbePending = false;
  let scanStartedAt: number | null = null;
  let lastModeSecond = -1;

  let compassHeading: number | null = null;
  let compassFromOrientation = false;
  let ambientLux: number | null = null;
  let selfLat: number | null = null;
  let selfLon: number | null = null;
  let selfAcc: number | null = null;
  let selfSpeed: number | null = null;
  let geoHeadingAvailable = false;
  let timingProbeInFlight = false;
  let timingProbePending = false;
  let fetchProbeInFlight = false;
  let fetchProbePending = false;
  let dnsProbeInFlight = false;
  let dnsProbePending = false;
  let resourceObserver: PerformanceObserver | null = null;
  let smoothedRttMs: number | null = null;
  let smoothedFetchRttMs: number | null = null;
  let smoothedDnsMs: number | null = null;
  let selfUplink: string | null = null;
  const selfHardware = new Map<string, string>();
  const selfRoutes = new Set<string>();
  let selectedContactId: string | null = null;
  let hoveredContactId: string | null = null;
  const canvasTargetHits = new Map<string, { x: number; y: number; r: number }>();
  const triage: RadarTriageModel = {
    protocol: sanitizeProtocolFilter(opts.triageProtocolEl.value),
    evidence: sanitizeEvidenceFilter(opts.triageEvidenceEl.value),
    state: sanitizeStateFilter(opts.triageStateEl.value),
    sort: sanitizeSortMode(opts.triageSortEl.value),
    minConfidence: clamp(Number(opts.triageMinConfidenceEl.value) || 0, 0, 95),
    activeOnly: Boolean(opts.triageActiveOnlyEl.checked),
  };

  function isScanActive(): boolean {
    return running && !destroyed;
  }

  const maybeContext = opts.canvas.getContext("2d");
  if (!(maybeContext instanceof CanvasRenderingContext2D)) return () => { };
  const context = maybeContext;

  // ── Helpers ────────────────────────────────────────────────────────────

  function escapeText(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function on(
    target: EventTarget,
    event: string,
    handler: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
  }

  function registerCleanup(bucket: Array<() => void>, cleanup: () => void): () => void {
    let active = true;
    const wrapped = () => {
      if (!active) return;
      active = false;
      try { cleanup(); } catch { /* */ }
    };
    bucket.push(wrapped);
    cleanups.push(wrapped);
    return wrapped;
  }

  function runAndClearCleanups(bucket: Array<() => void>): void {
    const pending = bucket.splice(0, bucket.length);
    for (const cleanup of pending) {
      try { cleanup(); } catch { /* */ }
    }
  }

  function pushEvent(message: string): void {
    const now = Date.now();
    const latest = events[0];
    if (
      latest &&
      latest.message === message &&
      now - latest.time <= EVENT_COALESCE_WINDOW_MS
    ) {
      latest.time = now;
      latest.repeatCount = (latest.repeatCount ?? 1) + 1;
      renderEvents();
      return;
    }

    const item: RadarEvent = {
      id: `${now}-${Math.random().toString(16).slice(2, 9)}`,
      message,
      time: now,
      repeatCount: 1,
    };
    events.unshift(item);
    if (events.length > 60) events.length = 60;
    renderEvents();
  }

  function syncTriageReadout(): void {
    const rounded = Math.round(clamp(triage.minConfidence, 0, 95));
    opts.triageMinConfidenceValueEl.textContent = `${rounded}%`;
  }

  function syncTriageControls(): void {
    opts.triageProtocolEl.value = triage.protocol;
    opts.triageEvidenceEl.value = triage.evidence;
    opts.triageStateEl.value = triage.state;
    opts.triageSortEl.value = triage.sort;
    opts.triageMinConfidenceEl.value = String(Math.round(triage.minConfidence));
    opts.triageActiveOnlyEl.checked = triage.activeOnly;
    syncTriageReadout();
  }

  function applyTriageFromControls(): void {
    triage.protocol = sanitizeProtocolFilter(opts.triageProtocolEl.value);
    triage.evidence = sanitizeEvidenceFilter(opts.triageEvidenceEl.value);
    triage.state = sanitizeStateFilter(opts.triageStateEl.value);
    triage.sort = sanitizeSortMode(opts.triageSortEl.value);
    triage.minConfidence = clamp(Number(opts.triageMinConfidenceEl.value) || 0, 0, 95);
    triage.activeOnly = Boolean(opts.triageActiveOnlyEl.checked);
    syncTriageReadout();
    renderContacts();
    drawCanvas();
  }

  function syncTargetStates(now: number): void {
    for (const target of targets.values()) {
      if (target.protocol === "self") continue;
      syncTargetState(target, now);
    }
  }

  function resolveContactRows(now: number): { allRows: ContactRow[]; filteredRows: ContactRow[] } {
    syncTargetStates(now);
    return resolveFilteredRows(targets.values(), now, triage);
  }

  function createProbeScheduler(state: {
    getInFlight: () => boolean;
    setInFlight: (value: boolean) => void;
    getPending: () => boolean;
    setPending: (value: boolean) => void;
    run: () => Promise<void>;
  }): () => void {
    const schedule = () => {
      if (!isScanActive()) return;
      if (state.getInFlight()) {
        state.setPending(true);
        return;
      }

      state.setInFlight(true);
      void state.run().finally(() => {
        state.setInFlight(false);
        if (!state.getPending()) return;
        state.setPending(false);
        schedule();
      });
    };
    return schedule;
  }

  const scheduleIceProbe = createProbeScheduler({
    getInFlight: () => iceProbeInFlight,
    setInFlight: (value) => { iceProbeInFlight = value; },
    getPending: () => iceProbePending,
    setPending: (value) => { iceProbePending = value; },
    run: runIceProbe,
  });

  const scheduleEnumerateDevicesProbe = createProbeScheduler({
    getInFlight: () => mediaProbeInFlight,
    setInFlight: (value) => { mediaProbeInFlight = value; },
    getPending: () => mediaProbePending,
    setPending: (value) => { mediaProbePending = value; },
    run: runEnumerateDevicesProbe,
  });

  const scheduleTimingProbe = createProbeScheduler({
    getInFlight: () => timingProbeInFlight,
    setInFlight: (value) => { timingProbeInFlight = value; },
    getPending: () => timingProbePending,
    setPending: (value) => { timingProbePending = value; },
    run: runNavigationTimingProbe,
  });

  const scheduleFetchProbe = createProbeScheduler({
    getInFlight: () => fetchProbeInFlight,
    setInFlight: (value) => { fetchProbeInFlight = value; },
    getPending: () => fetchProbePending,
    setPending: (value) => { fetchProbePending = value; },
    run: runActiveFetchProbe,
  });

  const scheduleDnsProbe = createProbeScheduler({
    getInFlight: () => dnsProbeInFlight,
    setInFlight: (value) => { dnsProbeInFlight = value; },
    getPending: () => dnsProbePending,
    setPending: (value) => { dnsProbePending = value; },
    run: runDnsTimingProbe,
  });

  function runNetworkProbeCycle(): void {
    runNetworkProbe();
    scheduleIceProbe();
    scheduleEnumerateDevicesProbe();
    scheduleTimingProbe();
    scheduleFetchProbe();
    scheduleDnsProbe();
  }

  function startNetworkProbeLoop(options?: { immediate?: boolean }): void {
    if (networkPollTimer !== null) return;
    if (options?.immediate ?? true) runNetworkProbeCycle();
    networkPollTimer = window.setInterval(() => {
      runNetworkProbeCycle();
    }, NETWORK_POLL_MS);
  }

  function stopNetworkProbeLoop(): void {
    if (networkPollTimer === null) return;
    window.clearInterval(networkPollTimer);
    networkPollTimer = null;
  }

  function setHoveredContact(id: string | null): void {
    if (hoveredContactId === id) return;
    hoveredContactId = id;
    renderContacts();
  }

  function pickCanvasContactId(clientX: number, clientY: number): string | null {
    const rect = opts.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    let hitId: string | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;

    for (const [id, hit] of canvasTargetHits.entries()) {
      const dx = x - hit.x;
      const dy = y - hit.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= hit.r * hit.r && distSq < bestDistSq) {
        bestDistSq = distSq;
        hitId = id;
      }
    }

    return hitId;
  }

  function setBtStatus(status: string): void {
    opts.bluetoothEl.textContent = status;
    opts.bluetoothEl.dataset.bt = status.replace(/\s+/g, "-");
  }

  // ── Target CRUD ────────────────────────────────────────────────────────

  function upsertTarget(input: {
    id: string;
    label: string;
    protocol: RadarProtocol;
    evidence: EvidenceKind;
    rssi: number;
    txPower: number;
    meta: string;
  }): void {
    const now = Date.now();
    const rssi = normalizeRssi(input.rssi);

    const existing = targets.get(input.id);
    if (!existing) {
      const stats = initStats(rssi);
      const filter = initFilter(rssi);
      const filtered = updateFilter(filter, rssi);
      const sigmaRssi = clamp(stddev(stats), 1.2, 24);
      const distance =
        input.evidence === "measured"
          ? rssiToDistanceMeters(filtered, input.txPower, PATH_LOSS_N)
          : null;
      const sigma = distance === null ? null : sigmaDistanceMeters(distance, sigmaRssi, PATH_LOSS_N);

      targets.set(input.id, {
        id: input.id,
        label: input.label,
        protocol: input.protocol,
        evidence: input.evidence,
        txPower: input.txPower,
        rssiRaw: rssi,
        rssiFiltered: filtered,
        rssiSigma: sigmaRssi,
        distanceM: distance,
        sigmaM: sigma,
        confidence: confidenceScore(1, sigmaRssi, input.evidence),
        firstSeen: now,
        lastSeen: now,
        meta: input.meta,
        angleRad: hashAngle(input.id),
        stats,
        filter,
        history: [{ time: now, distanceM: distance, rssi }],
        updateHz: 0,
        distanceRateMps: null,
        trend: "unknown",
        state: "new",
        stateSince: now,
      });
      const created = targets.get(input.id);
      if (created) syncTargetState(created, now);

      pushEvent(`+ ${input.label} [${input.protocol}]`);
    } else {
      const prevSeen = existing.lastSeen;
      const prevDistanceM = existing.distanceM;
      existing.rssiRaw = rssi;
      existing.txPower = input.txPower;
      existing.label = input.label;
      existing.protocol = input.protocol;
      existing.evidence = input.evidence;
      existing.meta = input.meta;
      existing.lastSeen = now;

      updateStats(existing.stats, rssi);
      existing.rssiFiltered = updateFilter(existing.filter, rssi);
      existing.rssiSigma = clamp(stddev(existing.stats), 1.2, 24);

      existing.distanceM =
        existing.evidence === "measured"
          ? rssiToDistanceMeters(existing.rssiFiltered, existing.txPower, PATH_LOSS_N)
          : null;

      existing.sigmaM =
        existing.distanceM === null
          ? null
          : sigmaDistanceMeters(existing.distanceM, existing.rssiSigma, PATH_LOSS_N);

      existing.confidence = confidenceScore(existing.stats.count, existing.rssiSigma, existing.evidence);

      const dtMs = Math.max(1, now - prevSeen);
      const instantaneousHz = 1000 / dtMs;
      existing.updateHz = existing.updateHz <= 0
        ? instantaneousHz
        : existing.updateHz * 0.72 + instantaneousHz * 0.28;

      if (prevDistanceM !== null && existing.distanceM !== null) {
        const instantRate = (existing.distanceM - prevDistanceM) / (dtMs / 1000);
        existing.distanceRateMps = existing.distanceRateMps === null
          ? instantRate
          : existing.distanceRateMps * 0.65 + instantRate * 0.35;
      } else {
        existing.distanceRateMps = null;
      }
      existing.trend = trendFromRate(existing.distanceRateMps);

      existing.history.push({ time: now, distanceM: existing.distanceM, rssi });
      if (existing.history.length > TARGET_HISTORY_LIMIT) {
        existing.history.splice(0, existing.history.length - TARGET_HISTORY_LIMIT);
      }
      syncTargetState(existing, now);
    }

    renderStats();
    renderContacts();
  }

  function removeStaleTargets(): void {
    const now = Date.now();
    syncTargetStates(now);
    const cutoff = now - (STALE_TARGET_MS + LOST_CONTACT_RETENTION_MS);
    let staleCount = 0;
    for (const [id, target] of targets.entries()) {
      if (target.protocol === "self") continue;
      if (target.lastSeen < cutoff) {
        staleCount += 1;
        targets.delete(id);
      }
    }
    if (selectedContactId !== null && !targets.has(selectedContactId)) selectedContactId = null;
    if (hoveredContactId !== null && !targets.has(hoveredContactId)) hoveredContactId = null;
    if (staleCount > 0) {
      pushEvent(`- ${staleCount} stale contact${staleCount === 1 ? "" : "s"}`);
    }
  }

  // ── Canvas: clean spatial map ──────────────────────────────────────────

  function drawCanvas(): void {
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const cssWidth = opts.canvas.clientWidth;
    const cssHeight = opts.canvas.clientHeight;
    const width = Math.max(1, Math.floor(cssWidth * dpr));
    const height = Math.max(1, Math.floor(cssHeight * dpr));

    if (opts.canvas.width !== width || opts.canvas.height !== height) {
      opts.canvas.width = width;
      opts.canvas.height = height;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = cssWidth * 0.5;
    const cy = cssHeight * 0.5;
    const scopeRadius = Math.max(0, Math.min(cssWidth, cssHeight) * 0.46);
    const now = Date.now();
    const { allRows, filteredRows } = resolveContactRows(now);
    const mapRows = filteredRows.length > 0
      ? filteredRows.slice(0, 90)
      : sortContactRows(allRows, triage.sort).slice(0, 90);
    const mapTargets = mapRows.map((row) => row.target);
    const mapRangeSource = mapTargets.length > 0
      ? mapTargets
      : allRows.map((row) => row.target);
    const mapRangeM = resolveMapRangeMeters(mapRangeSource);

    const styles = getComputedStyle(opts.canvas);
    const textRgb = styles.getPropertyValue("--color-text-rgb").trim() || "245 245 245";
    const cyanRgb = styles.getPropertyValue("--chromatic-cyan").trim() || "0 255 255";
    const redRgb = styles.getPropertyValue("--chromatic-red").trim() || "255 0 0";

    context.clearRect(0, 0, cssWidth, cssHeight);
    canvasTargetHits.clear();

    const ringDistances = buildRangeRings(mapRangeM);
    const fontSize = Math.max(8, cssWidth * 0.024);

    context.lineWidth = 0.7;
    context.font = `${fontSize}px "Inter", system-ui, sans-serif`;
    context.textAlign = "left";
    context.textBaseline = "bottom";

    for (let i = 0; i < ringDistances.length; i += 1) {
      const ringRadius = rangeToCanvasRadius(ringDistances[i], scopeRadius, mapRangeM);
      context.strokeStyle = `rgb(${textRgb} / 0.1)`;
      context.beginPath();
      context.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      context.stroke();

      context.fillStyle = `rgb(${textRgb} / 0.2)`;
      context.fillText(formatDistance(ringDistances[i]), cx + 4, cy - ringRadius + fontSize + 1);
    }

    context.strokeStyle = `rgb(${textRgb} / 0.07)`;
    context.lineWidth = 0.7;
    context.beginPath();
    context.moveTo(cx - scopeRadius, cy);
    context.lineTo(cx + scopeRadius, cy);
    context.moveTo(cx, cy - scopeRadius);
    context.lineTo(cx, cy + scopeRadius);
    context.stroke();

    if (compassHeading !== null) {
      const headingRad = (compassHeading * Math.PI) / 180;
      const cardinals = [
        ["N", 0],
        ["E", Math.PI / 2],
        ["S", Math.PI],
        ["W", (3 * Math.PI) / 2],
      ] as const;
      const labelOffset = scopeRadius + Math.max(10, cssWidth * 0.028);
      context.fillStyle = `rgb(${textRgb} / 0.3)`;
      context.font = `bold ${Math.max(9, cssWidth * 0.026)}px "Inter", system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";

      for (const [label, angle] of cardinals) {
        const adjusted = angle - headingRad;
        const lx = cx + Math.sin(adjusted) * labelOffset;
        const ly = cy - Math.cos(adjusted) * labelOffset;
        context.fillText(label, lx, ly);
      }
    }

    if (selfAcc !== null && selfAcc > 0) {
      const accRadius = rangeToCanvasRadius(selfAcc, scopeRadius, mapRangeM);
      if (accRadius > 6 && accRadius < scopeRadius) {
        context.strokeStyle = `rgb(${cyanRgb} / 0.08)`;
        context.lineWidth = 0.7;
        context.setLineDash([2, 4]);
        context.beginPath();
        context.arc(cx, cy, accRadius, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
      }
    }

    const visibleIds = new Set(mapRows.map((row) => row.target.id));
    if (selectedContactId !== null && !visibleIds.has(selectedContactId)) selectedContactId = null;
    if (hoveredContactId !== null && !visibleIds.has(hoveredContactId)) hoveredContactId = null;

    canvasTargetHits.clear();

    let hasInferred = false;
    for (const row of mapRows) {
      if (row.target.evidence !== "measured") {
        hasInferred = true;
        break;
      }
    }

    const inferredRadius = scopeRadius * 0.83;
    if (hasInferred) {
      context.strokeStyle = `rgb(${textRgb} / 0.08)`;
      context.setLineDash([3, 5]);
      context.lineWidth = 0.7;
      context.beginPath();
      context.arc(cx, cy, inferredRadius, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }

    for (const row of mapRows) {
      const target = row.target;
      if (target.id === "self:device") continue;
      const staleFactor = clamp(1 - row.ageMs / (STALE_TARGET_MS + LOST_CONTACT_RETENTION_MS), 0.12, 1);
      const isSelected = selectedContactId === target.id;
      const isHovered = hoveredContactId === target.id;
      const stateAlpha = stateWeight(row.state);

      let colorRgb = textRgb;
      if (target.protocol === "bluetooth") colorRgb = cyanRgb;
      if (target.protocol === "radio") colorRgb = redRgb;

      const alpha = staleFactor * stateAlpha * (target.evidence === "measured" ? 0.86 : 0.58);

      let tx: number;
      let ty: number;
      let markerSize: number;

      if (target.evidence === "measured" && target.distanceM !== null) {
        const radius = rangeToCanvasRadius(target.distanceM, scopeRadius, mapRangeM);
        const sigma = target.sigmaM ?? 0.5;
        const innerRadius = rangeToCanvasRadius(
          Math.max(MIN_DISTANCE_M, target.distanceM - sigma),
          scopeRadius,
          mapRangeM,
        );
        const outerRadius = rangeToCanvasRadius(target.distanceM + sigma, scopeRadius, mapRangeM);
        const bandWidth = outerRadius - innerRadius;

        context.strokeStyle = `rgb(${colorRgb} / ${(0.08 * staleFactor).toFixed(3)})`;
        context.lineWidth = clamp(bandWidth, 1, 10);
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.stroke();

        if (target.history.length > 2) {
          context.strokeStyle = `rgb(${colorRgb} / ${(0.2 * staleFactor).toFixed(3)})`;
          context.lineWidth = 1;
          context.beginPath();
          let drewTrail = false;
          for (const sample of target.history) {
            if (sample.distanceM === null) continue;
            const historyRadius = rangeToCanvasRadius(sample.distanceM, scopeRadius, mapRangeM);
            const hx = cx + Math.cos(target.angleRad) * historyRadius;
            const hy = cy + Math.sin(target.angleRad) * historyRadius;
            if (!drewTrail) {
              context.moveTo(hx, hy);
              drewTrail = true;
            } else {
              context.lineTo(hx, hy);
            }
          }
          if (drewTrail) context.stroke();
        }

        tx = cx + Math.cos(target.angleRad) * radius;
        ty = cy + Math.sin(target.angleRad) * radius;
        markerSize = clamp(2.2 + target.confidence * 3.6 + stateAlpha * 0.5, 2.2, 6.4);
      } else if (isLocalBrowserTarget(target)) {
        const inner = scopeRadius * 0.08;
        const outer = scopeRadius * 0.22;
        const localRadius = inner + (outer - inner) * hashUnit(target.id);
        tx = cx + Math.cos(target.angleRad) * localRadius;
        ty = cy + Math.sin(target.angleRad) * localRadius;
        markerSize = row.state === "lost" ? 2.2 : 2.9;
      } else {
        tx = cx + Math.cos(target.angleRad) * inferredRadius;
        ty = cy + Math.sin(target.angleRad) * inferredRadius;
        markerSize = row.state === "lost" ? 2.1 : 2.5;
      }

      if (target.evidence === "measured" && row.state !== "lost") {
        context.fillStyle = `rgb(${colorRgb} / ${(0.06 * staleFactor).toFixed(3)})`;
        context.beginPath();
        context.arc(tx, ty, markerSize + 4, 0, Math.PI * 2);
        context.fill();
      }

      if (row.state === "lost") {
        context.strokeStyle = `rgb(${colorRgb} / ${(alpha * 0.95).toFixed(3)})`;
        context.lineWidth = 1.25;
        context.beginPath();
        context.moveTo(tx - markerSize - 1.8, ty - markerSize - 1.8);
        context.lineTo(tx + markerSize + 1.8, ty + markerSize + 1.8);
        context.moveTo(tx - markerSize - 1.8, ty + markerSize + 1.8);
        context.lineTo(tx + markerSize + 1.8, ty - markerSize - 1.8);
        context.stroke();
      } else {
        context.fillStyle = `rgb(${colorRgb} / ${alpha.toFixed(3)})`;
        context.beginPath();
        context.arc(tx, ty, markerSize, 0, Math.PI * 2);
        context.fill();
      }

      if (row.state === "acquiring" || row.state === "degrading") {
        context.strokeStyle = `rgb(${colorRgb} / ${(alpha * 0.72).toFixed(3)})`;
        context.lineWidth = 0.9;
        context.setLineDash(row.state === "acquiring" ? [2, 3] : [4, 3]);
        context.beginPath();
        context.arc(tx, ty, markerSize + 3.2, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
      }

      canvasTargetHits.set(target.id, {
        x: tx,
        y: ty,
        r: Math.max(markerSize + 8, 11),
      });

      if (isSelected || isHovered) {
        const ringAlpha = isSelected ? 0.5 * staleFactor : 0.3 * staleFactor;
        context.strokeStyle = `rgb(${colorRgb} / ${ringAlpha.toFixed(3)})`;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(tx, ty, markerSize + (isSelected ? 4 : 3), 0, Math.PI * 2);
        context.stroke();

        const dotLabelFontSize = Math.max(9, cssWidth * 0.024);
        context.font = `${dotLabelFontSize}px "Inter", system-ui, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "bottom";
        const distLabel = target.distanceM !== null ? ` ${formatDistance(target.distanceM)}` : "";
        const bearing = Math.round(angleRadToBearingDeg(target.angleRad));
        const stateLabel = formatContactState(row.state);
        const dotLabelText = `${target.label}${distLabel} ${bearing}deg ${stateLabel}`;
        const dotLabelY = ty - markerSize - 6;
        const dotLabelMetrics = context.measureText(dotLabelText);
        const dotPadX = 5;
        const dotPadY = 3;
        const dotLabelW = dotLabelMetrics.width + dotPadX * 2;
        const dotLabelH = dotLabelFontSize + dotPadY * 2;
        const dotLabelBgX = tx - dotLabelW / 2;
        const dotLabelBgY = dotLabelY - dotLabelH + dotPadY;
        context.fillStyle = `rgb(10 10 10 / 0.62)`;
        context.beginPath();
        context.roundRect(dotLabelBgX, dotLabelBgY, dotLabelW, dotLabelH, 3);
        context.fill();
        context.fillStyle = isSelected
          ? `rgb(${colorRgb} / ${(0.9 * staleFactor).toFixed(3)})`
          : `rgb(${textRgb} / ${(0.52 * staleFactor).toFixed(3)})`;
        context.fillText(dotLabelText, tx, dotLabelY);
      }
    }

    const selectedTargetRow = selectedContactId
      ? mapRows.find((row) => row.target.id === selectedContactId) ?? null
      : null;
    const selectedTarget = selectedTargetRow?.target ?? null;
    if (selectedTarget) {
      const hit = canvasTargetHits.get(selectedTarget.id);
      if (hit) {
        const bearingDeg = angleRadToBearingDeg(selectedTarget.angleRad);

        context.strokeStyle = `rgb(${cyanRgb} / 0.26)`;
        context.lineWidth = 0.9;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(cx, cy);
        context.lineTo(hit.x, hit.y);
        context.stroke();
        context.setLineDash([]);

        const statusParts = [
          `lock ${selectedTarget.label}`,
          selectedTarget.distanceM !== null ? formatDistance(selectedTarget.distanceM) : "inferred",
          `${Math.round(selectedTarget.confidence * 100)}pct`,
          `${Math.round(bearingDeg)}deg ${bearingToCardinal(bearingDeg)}`,
          selectedTargetRow ? formatContactState(selectedTargetRow.state) : "unknown",
          selectedTarget.trend,
        ];
        const hintFontSize = Math.max(9, cssWidth * 0.021);
        context.font = `${hintFontSize}px "Inter", system-ui, sans-serif`;
        context.textAlign = "left";
        context.textBaseline = "top";
        const hintText = statusParts.join(" | ");
        const hintMetrics = context.measureText(hintText);
        const hintPadX = 7;
        const hintPadY = 5;
        const hintX = 8;
        const hintY = 8;
        const hintW = hintMetrics.width + hintPadX * 2;
        const hintH = hintFontSize + hintPadY * 2;
        context.fillStyle = `rgb(10 10 10 / 0.72)`;
        context.beginPath();
        context.roundRect(hintX - hintPadX, hintY - hintPadY, hintW, hintH, 4);
        context.fill();
        context.strokeStyle = `rgb(${textRgb} / 0.1)`;
        context.lineWidth = 0.7;
        context.stroke();
        context.fillStyle = `rgb(${textRgb} / 0.72)`;
        context.fillText(hintText, hintX, hintY);
      }
    }

    context.fillStyle = `rgb(${cyanRgb} / 0.7)`;
    context.beginPath();
    context.arc(cx, cy, 3.5, 0, Math.PI * 2);
    context.fill();

    // Visual selection feedback for the center dot
    if (selectedContactId === "self:device" || hoveredContactId === "self:device") {
      const isSelected = selectedContactId === "self:device";
      context.strokeStyle = `rgb(${cyanRgb} / ${isSelected ? 0.5 : 0.3})`;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(cx, cy, 3.5 + (isSelected ? 4 : 3), 0, Math.PI * 2);
      context.stroke();
    }

    // Map center hit region for self device
    canvasTargetHits.set("self:device", {
      x: cx,
      y: cy,
      r: 12,
    });

    // Draw hover label for self device if needed
    const selfTarget = targets.get("self:device");
    if (selfTarget) {
      const isSelected = selectedContactId === "self:device";
      const isHovered = hoveredContactId === "self:device";
      if (isSelected || isHovered) {
        context.font = `${fontSize}px "Inter", system-ui, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "bottom";
        const selfLabel = "self device";
        const labelY = cy - 8;
        context.fillStyle = isSelected ? `rgb(${cyanRgb} / 0.9)` : `rgb(${textRgb} / 0.72)`;
        context.fillText(selfLabel, cx, labelY);
      }
    }
  }

  function renderStats(): void {
    const now = Date.now();
    syncTargetStates(now);
    let bt = 0;
    let wifi = 0;
    let radio = 0;
    let active = 0;
    let measured = 0;
    let inferred = 0;
    let nearest: number | null = null;
    for (const target of targets.values()) {
      if (target.protocol === "self") continue;
      if (target.protocol === "bluetooth") bt += 1;
      if (target.protocol === "wifi") wifi += 1;
      if (target.protocol === "radio") radio += 1;
      if (isTargetActive(target, now)) active += 1;
      if (target.evidence === "measured" && target.distanceM !== null) {
        measured += 1;
        nearest = nearest === null ? target.distanceM : Math.min(nearest, target.distanceM);
      } else {
        inferred += 1;
      }
    }

    opts.totalEl.textContent = String(bt + wifi + radio);
    opts.bluetoothCountEl.textContent = String(bt);
    opts.wifiCountEl.textContent = String(wifi);
    opts.radioCountEl.textContent = String(radio);
    opts.activeEl.textContent = String(active);
    opts.measuredEl.textContent = String(measured);
    opts.inferredEl.textContent = String(inferred);
    opts.nearestEl.textContent = nearest === null ? "--" : formatDistance(nearest);
  }

  function renderContactDetailHtml(row: ContactRow, now: number): string {
    const target = row.target;
    const isSelected = selectedContactId === target.id;
    if (!isSelected) return "";

    const lines: string[] = [];
    if (target.id === "self:device") {
      lines.push(`<div class="detail-header">network</div>`);
      if (smoothedRttMs !== null) lines.push(`<div class="detail-item"><strong>rtt</strong> ${Math.round(smoothedRttMs)}ms</div>`);
      if (smoothedFetchRttMs !== null) lines.push(`<div class="detail-item"><strong>fetch rtt</strong> ${Math.round(smoothedFetchRttMs)}ms</div>`);
      if (smoothedDnsMs !== null) lines.push(`<div class="detail-item"><strong>dns timing</strong> ${Math.round(smoothedDnsMs)}ms</div>`);
      if (selfUplink) lines.push(`<div class="detail-item"><strong>uplink</strong> ${selfUplink}</div>`);

      if (selfHardware.size > 0) {
        lines.push(`<div class="detail-header">hardware</div>`);
        for (const [kind, val] of selfHardware) {
          lines.push(`<div class="detail-item"><strong>${kind}</strong> ${val}</div>`);
        }
      }

      if (selfRoutes.size > 0) {
        lines.push(`<div class="detail-header">interfaces</div>`);
        for (const route of selfRoutes) {
          lines.push(`<div class="detail-item">${route}</div>`);
        }
      }
    } else {
      const stateLabel = formatContactState(row.state);
      const activityLabel = row.active ? "active" : "inactive";
      const conf = Math.round(target.confidence * 100);
      const stateAgeSec = Math.max(0, Math.floor((now - target.stateSince) / 1000));
      const bearingDeg = angleRadToBearingDeg(target.angleRad);
      const cardinal = bearingToCardinal(bearingDeg);
      const trend = target.trend === "unknown" ? "unknown" : target.trend;

      lines.push(`<div class="detail-header">lifecycle</div>`);
      lines.push(`<div class="detail-item"><strong>state</strong> ${stateLabel}</div>`);
      lines.push(`<div class="detail-item"><strong>age</strong> ${stateAgeSec}s</div>`);
      lines.push(`<div class="detail-item"><strong>activity</strong> ${activityLabel}</div>`);

      lines.push(`<div class="detail-header">signal</div>`);
      lines.push(`<div class="detail-item"><strong>rssi raw</strong> ${target.rssiRaw} dBm</div>`);
      lines.push(`<div class="detail-item"><strong>rssi filtered</strong> ${target.rssiFiltered.toFixed(1)} dBm</div>`);
      lines.push(`<div class="detail-item"><strong>update rate</strong> ${formatUpdateRate(target.updateHz)}</div>`);
      lines.push(`<div class="detail-item"><strong>confidence</strong> ${conf}%</div>`);

      lines.push(`<div class="detail-header">spatial</div>`);
      lines.push(`<div class="detail-item"><strong>bearing</strong> ${Math.round(bearingDeg)}deg ${cardinal}</div>`);
      if (target.distanceM !== null) {
        lines.push(`<div class="detail-item"><strong>distance</strong> ${formatDistance(target.distanceM)}</div>`);
      }
      lines.push(`<div class="detail-item"><strong>trend</strong> ${trend}</div>`);
    }

    return `<div class="contact-detail">${lines.join("")}</div>`;
  }

  /**
   * Renders the structured HTML for the lock panel target details.
   * Handles the specialized 'self:device' dashboard view as well as
   * standard kinematic/signal locking for radio/bluetooth contacts.
   */
  function renderLockTargetHtml(
    row: ContactRow,
    now: number,
    bearingDeg: number,
    cardinal: string,
    relative: string | null,
    rangeLabel: string,
    sigmaLabel: string,
    stateLabel: string,
    stateAge: number,
    activityLabel: string,
  ): string {
    const target = row.target;
    const conf = Math.round(target.confidence * 100);
    const priority = Math.round(row.priority * 100);
    const ageSec = Math.max(0, Math.floor((now - target.lastSeen) / 1000));
    const trend = target.trend === "unknown" ? "unknown" : target.trend;

    if (target.id === "self:device") {
      const parts = [
        `<li class="lock-primary"><strong>lock self device</strong> | ${target.protocol} | ${rangeLabel} | ${stateLabel} | ${activityLabel}</li>`,
      ];
      if (smoothedRttMs !== null || selfUplink) {
        let net = `<strong>network</strong> `;
        if (smoothedRttMs !== null) net += `rtt ${Math.round(smoothedRttMs)}ms | `;
        if (selfUplink) net += `uplink ${selfUplink}`;
        parts.push(`<li class="lock-secondary">${net.replace(/ \| $/, "")}</li>`);
      }
      if (selfHardware.size > 0) {
        const hwCount = Array.from(selfHardware.values()).join(" | ");
        parts.push(`<li class="lock-secondary"><strong>hardware</strong> ${hwCount}</li>`);
      }
      if (selfRoutes.size > 0) {
        parts.push(`<li class="lock-secondary"><strong>interfaces</strong> ${Array.from(selfRoutes).join(" | ")}</li>`);
      }
      return parts.join("");
    }

    const lines = [
      `<li class="lock-primary"><strong>lock ${escapeText(target.label)}</strong> | ${target.protocol} | ${rangeLabel}${sigmaLabel} | ${Math.round(bearingDeg)}deg ${cardinal}${relative ? ` | ${relative}` : ""} | ${stateLabel} ${stateAge}s | ${activityLabel} | ${trend}</li>`,
      `<li class="lock-secondary"><strong>signal</strong> rssi ${Math.round(target.rssiFiltered)} dBm | sigma ${target.rssiSigma.toFixed(1)} dB | conf ${conf}% | pri ${priority}</li>`,
      `<li class="lock-secondary"><strong>kinematics</strong> ${escapeText(formatRate(target.distanceRateMps))} | update ${escapeText(formatUpdateRate(target.updateHz))} | age ${ageSec}s</li>`,
    ];
    if (target.meta) {
      lines.push(`<li class="lock-secondary"><strong>meta</strong> ${escapeText(target.meta)}</li>`);
    }
    return lines.join("");
  }

  function renderContacts(): void {
    const now = Date.now();
    const { allRows, filteredRows } = resolveContactRows(now);
    const visibleRows = filteredRows.slice(0, 60);
    const allIds = new Set(allRows.map((row) => row.target.id));
    if (selectedContactId !== null && !allIds.has(selectedContactId)) selectedContactId = null;
    if (hoveredContactId !== null && !allIds.has(hoveredContactId)) hoveredContactId = null;

    if (visibleRows.length === 0) {
      if (allRows.length === 0) {
        opts.contactsEl.innerHTML = "<li>no contacts</li>";
      } else {
        opts.contactsEl.innerHTML = "<li>no contacts match triage</li>";
      }
      const selectedRow = selectedContactId
        ? allRows.find((row) => row.target.id === selectedContactId) ?? null
        : null;
      renderLock(selectedRow, visibleRows, allRows, now);
      return;
    }

    opts.contactsEl.innerHTML = visibleRows
      .map((row) => {
        const target = row.target;
        const ageSec = row.ageSec;
        const stateAgeSec = Math.max(0, Math.floor((now - target.stateSince) / 1000));
        const conf = Math.round(target.confidence * 100);
        const priority = Math.round(row.priority * 100);
        const bearingDeg = angleRadToBearingDeg(target.angleRad);
        const cardinal = bearingToCardinal(bearingDeg);
        const relativeLabel = relativeBearingLabel(bearingDeg, compassHeading);
        const isSelected = selectedContactId === target.id;
        const isHovered = hoveredContactId === target.id;
        const selectedClass = isSelected ? " contact-selected" : "";
        const hoverClass = !isSelected && isHovered ? " contact-hovered" : "";
        const meta = target.meta ? ` | ${escapeText(target.meta)}` : "";
        const trend = target.trend === "unknown" ? "unknown" : target.trend;
        const stateLabel = formatContactState(row.state);
        const activityLabel = row.active ? "active" : "inactive";
        const detail = renderContactDetailHtml(row, now);

        if (target.evidence === "measured" && target.distanceM !== null && target.sigmaM !== null) {
          const summaryParts = [
            `${target.protocol}`,
            `${formatDistance(target.distanceM)} +/-${target.sigmaM.toFixed(1)}m`,
            `${Math.round(bearingDeg)}deg ${cardinal}`,
            `${stateLabel}`,
            `${conf}% conf`,
            `${priority} pri`,
            `${trend}`,
            `${activityLabel}`,
            `${ageSec}s`,
          ];
          if (relativeLabel) summaryParts.splice(3, 0, relativeLabel);

          return `<li class="contact-item${selectedClass}${hoverClass}" data-contact-id="${escapeText(target.id)}" role="button" tabindex="0" aria-expanded="${isSelected ? "true" : "false"}"><div class="contact-summary"><strong>${escapeText(target.label)}</strong> | ${summaryParts.join(" | ")}${meta}</div>${detail}</li>`;
        }

        const inferredParts = [
          target.protocol,
          "inferred",
          `${Math.round(bearingDeg)}deg ${cardinal}`,
          `${stateLabel}`,
          `${priority} pri`,
          `${conf}% conf`,
          `${activityLabel}`,
          `${ageSec}s`,
        ];
        if (relativeLabel) inferredParts.splice(3, 0, relativeLabel);
        return `<li class="contact-item${selectedClass}${hoverClass}" data-contact-id="${escapeText(target.id)}" role="button" tabindex="0" aria-expanded="${isSelected ? "true" : "false"}"><div class="contact-summary"><strong>${escapeText(target.label)}</strong> | ${inferredParts.join(" | ")}${meta}</div>${detail}</li>`;
      })
      .join("");

    const selectedRow = selectedContactId
      ? visibleRows.find((row) => row.target.id === selectedContactId) ??
      allRows.find((row) => row.target.id === selectedContactId) ??
      null
      : null;
    renderLock(selectedRow, visibleRows, allRows, now);
  }

  function renderLock(
    selectedRow: ContactRow | null,
    visibleRows: ContactRow[],
    allRows: ContactRow[],
    now: number,
  ): void {
    if (!selectedRow) {
      if (allRows.length === 0) {
        opts.lockEl.innerHTML = "<li>no lock target</li>";
        return;
      }

      let active = 0;
      let measured = 0;
      let nearest: number | null = null;
      const summaryRows = visibleRows.length > 0 ? visibleRows : allRows;
      for (const row of summaryRows) {
        const target = row.target;
        if (row.active) active += 1;
        if (target.evidence === "measured" && target.distanceM !== null) {
          measured += 1;
          nearest = nearest === null ? target.distanceM : Math.min(nearest, target.distanceM);
        }
      }

      const ranked = visibleRows.length > 0
        ? visibleRows
        : sortContactRows(allRows, "priority").slice(0, 3);
      const top = ranked
        .slice(0, 3)
        .map((row, index) => {
          const target = row.target;
          const priority = Math.round(row.priority * 100);
          const ageSec = row.ageSec;
          const bearingDeg = angleRadToBearingDeg(target.angleRad);
          const rangeLabel = target.distanceM === null ? "inferred" : formatDistance(target.distanceM);
          return `<li class="lock-secondary"><strong>${index + 1}.</strong> ${escapeText(target.label)} | ${target.protocol} | ${rangeLabel} | ${Math.round(bearingDeg)}deg | ${formatContactState(row.state)} | ${priority} pri | ${ageSec}s</li>`;
        })
        .join("");

      const summaryParts = [`contacts ${allRows.length}`];
      if (visibleRows.length !== allRows.length) summaryParts.push(`view ${visibleRows.length}`);
      summaryParts.push(
        `active ${active}`,
        `measured ${measured}`,
        `inferred ${Math.max(0, summaryRows.length - measured)}`,
        `nearest ${nearest === null ? "--" : formatDistance(nearest)}`,
        `sort ${triage.sort}`,
      );
      const header = visibleRows.length > 0 ? "scan summary" : "scan summary (triage empty)";
      opts.lockEl.innerHTML = `<li class="lock-primary"><strong>${header}</strong> | ${summaryParts.join(" | ")}</li>${top}`;
      return;
    }

    const selectedTarget = selectedRow.target;
    const ageSec = Math.max(0, Math.floor((now - selectedTarget.lastSeen) / 1000));
    const conf = Math.round(selectedTarget.confidence * 100);
    const priority = Math.round(selectedRow.priority * 100);
    const bearingDeg = angleRadToBearingDeg(selectedTarget.angleRad);
    const cardinal = bearingToCardinal(bearingDeg);
    const relative = relativeBearingLabel(bearingDeg, compassHeading);
    const rangeLabel = selectedTarget.distanceM === null ? "inferred" : formatDistance(selectedTarget.distanceM);
    const sigmaLabel = selectedTarget.sigmaM === null ? "" : ` +/-${selectedTarget.sigmaM.toFixed(1)}m`;
    const trend = selectedTarget.trend === "unknown" ? "unknown" : selectedTarget.trend;
    const stateLabel = formatContactState(selectedRow.state);
    const stateAge = Math.max(0, Math.floor((now - selectedTarget.stateSince) / 1000));
    const activityLabel = selectedRow.active ? "active" : "inactive";

    opts.lockEl.innerHTML = renderLockTargetHtml(
      selectedRow,
      now,
      bearingDeg,
      cardinal,
      relative,
      rangeLabel,
      sigmaLabel,
      stateLabel,
      stateAge,
      activityLabel
    );
  }

  function renderEvents(): void {
    if (events.length === 0) {
      opts.eventsEl.innerHTML = "<li>idle</li>";
      return;
    }

    opts.eventsEl.innerHTML = events
      .slice(0, 40)
      .map((item) => {
        const repeat = item.repeatCount && item.repeatCount > 1 ? ` x${item.repeatCount}` : "";
        return `<li>${escapeText(formatTime(item.time))} ${escapeText(item.message)}${escapeText(repeat)}</li>`;
      })
      .join("");
  }

  function renderCapabilities(): void {
    opts.capabilitiesEl.innerHTML = capabilities
      .map((cap) => {
        const status = cap.available ? "+" : "-";
        return `<li><strong>${status} ${escapeText(cap.key)}</strong> | ${cap.quality} | ${escapeText(cap.note)}</li>`;
      })
      .join("");
  }

  function renderSelfLoc(): void {
    if (selfLat !== null && selfLon !== null) {
      const lat = formatCoord(selfLat, "N", "S");
      const lon = formatCoord(selfLon, "E", "W");
      const acc = selfAcc !== null ? ` ±${Math.round(selfAcc)}m` : "";
      const spd = selfSpeed !== null && Number.isFinite(selfSpeed) && selfSpeed > 0
        ? ` ${selfSpeed.toFixed(1)}m/s`
        : "";
      opts.selfLocEl.textContent = `${lat} ${lon}${acc}${spd}`;
    } else {
      opts.selfLocEl.textContent = "no fix";
    }
  }

  function renderCompass(): void {
    if (compassHeading !== null) {
      opts.compassEl.textContent = `${Math.round(compassHeading)}deg`;
    } else {
      opts.compassEl.textContent = "--";
    }
  }

  function renderAmbient(): void {
    if (ambientLux !== null) {
      opts.ambientEl.textContent = `${Math.round(ambientLux)} lux`;
    } else {
      opts.ambientEl.textContent = "--";
    }
  }

  function setMode(mode: string): void {
    opts.modeEl.textContent = mode;
  }

  function updateModeRuntime(): void {
    if (!running || scanStartedAt === null) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - scanStartedAt) / 1000));
    if (elapsedSec === lastModeSecond) return;
    lastModeSecond = elapsedSec;
    setMode(`scanning ${elapsedSec}s`);
  }

  // ── Animation loop (just redraws — no sweep gimmick) ───────────────────

  function tick(): void {
    if (destroyed) return;
    updateModeRuntime();
    try {
      drawCanvas();
    } catch {
      if (!destroyed) pushEvent("minimap render fault recovered");
    }
    animationFrameId = requestAnimationFrame(tick);
  }

  // ── Network probes ─────────────────────────────────────────────────────

  function runNetworkProbe(options?: { allowWhenIdle?: boolean }): void {
    if (destroyed) return;
    if (!running && !options?.allowWhenIdle) return;
    const conn = navigatorLike.connection ?? null;
    if (!conn) return;

    const effectiveType = conn.effectiveType;
    const connType = conn.type || undefined;

    // effectiveType gives us quality-based inferred RSSI
    // but even without it, downlink/rtt are useful data
    const inferredRssi = connectionToInferredRssi(effectiveType, connType);

    const metrics: string[] = [];
    if (effectiveType) metrics.push(effectiveType);
    if (connType && connType !== effectiveType) metrics.push(connType);
    if (typeof conn.downlink === "number") metrics.push(`${conn.downlink.toFixed(1)}Mbps`);
    if (typeof conn.rtt === "number") metrics.push(`${Math.round(conn.rtt)}ms rtt`);
    if (conn.saveData) metrics.push("save-data");

    if (metrics.length === 0) return;

    const typeKey = connType ?? effectiveType ?? "unknown";
    selfUplink = `${typeKey} (${metrics.join(" | ")})`;
    upsertSelfDevice();
  }

  async function runIceProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof RTCPeerConnection !== "function") return;

    const primaryServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ];
    const fallbackServers = [
      { urls: "stun:stun.nextcloud.com:443" },
      { urls: "stun:stun.stunprotocol.org:3478" },
    ];

    async function gatherWithServers(
      servers: { urls: string }[],
      timeoutMs: number,
    ): Promise<{ seen: Set<string>; ipCount: number }> {
      if (!isScanActive()) return { seen: new Set(), ipCount: 0 };

      const peer = new RTCPeerConnection({ iceServers: servers });
      const seen = new Set<string>();
      let ipCount = 0;

      const done = new Promise<void>((resolve) => {
        let settled = false;
        const timeout = window.setTimeout(() => finish(), timeoutMs);
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve();
        };

        peer.addEventListener("icecandidate", (event) => {
          if (!isScanActive()) return;
          const candidateStr = event.candidate?.candidate;
          if (!candidateStr) { finish(); return; }

          const parsed = parseIceCandidate(candidateStr);
          if (!parsed) return;

          const key = `${parsed.address}:${parsed.port}`;
          if (seen.has(key)) return;
          seen.add(key);

          const metaParts: string[] = [];
          metaParts.push(parsed.type);
          metaParts.push(parsed.protocol);
          metaParts.push(`port ${parsed.port}`);

          if (parsed.isMdns) {
            selfRoutes.add(`mdns:${parsed.address}`);
          } else {
            selfRoutes.add(parsed.address);
          }
          upsertSelfDevice();
        });

        peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") finish();
        });
      });

      try {
        peer.createDataChannel("radar");
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await done;
      } catch {
        // gather failed silently
      } finally {
        try { peer.close(); } catch { /* */ }
      }

      return { seen, ipCount };
    }

    try {
      // Primary tier: shorter window
      const primary = await gatherWithServers(primaryServers, 1500);
      if (!isScanActive()) return;

      // Fallback tier: only if primary yielded zero real IPs (mDNS-only or empty)
      if (primary.ipCount === 0 && primary.seen.size > 0) {
        // We got mDNS-only candidates — try fallback servers for real IPs
        await gatherWithServers(fallbackServers, 1000);
      } else if (primary.seen.size === 0) {
        // No candidates at all — ICE is likely restricted
        const fallback = await gatherWithServers(fallbackServers, 1000);
        if (fallback.seen.size === 0 && !destroyed) {
          pushEvent("ICE candidates restricted — route discovery unavailable");
          // Dynamically update webrtc-ice capability to reflect actual state
          const iceCap = capabilities.find((c) => c.key === "webrtc-ice");
          if (iceCap) {
            iceCap.quality = "none";
            iceCap.note = "ICE gathering restricted — no candidates produced";
            renderCapabilities();
          }
        }
      }
    } catch {
      if (!destroyed) pushEvent("webrtc ice probe failed");
    }
  }

  // ── Hardware probe (enumerate media devices) ───────────────────────────

  async function runEnumerateDevicesProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof navigator.mediaDevices?.enumerateDevices !== "function") return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!isScanActive()) return;
      // Without a prior getUserMedia grant, labels are blank — but kinds and
      // groupIds are always visible. Count each kind.
      const counts: Record<string, number> = {};
      for (const d of devices) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
      for (const [kind, count] of Object.entries(counts)) {
        const kindLabel = kind === "audioinput"
          ? "mic"
          : kind === "audiooutput"
            ? "speaker"
            : kind === "videoinput"
              ? "cam"
              : kind;

        selfHardware.set(kind, `${count}x ${kindLabel}`);
      }
      upsertSelfDevice();
    } catch { /* permission denied or unavailable */ }
  }

  // ── Bluetooth LE scan ──────────────────────────────────────────────────

  async function startBluetoothScan(): Promise<void> {
    if (!bluetooth || typeof bluetooth.requestLEScan !== "function") {
      pushEvent(
        bluetooth
          ? "LE scan not exposed by this browser (try device picker instead)"
          : "Web Bluetooth not available in this browser"
      );
      return;
    }

    if (bluetoothScan) {
      pushEvent("bluetooth scan already running");
      return;
    }

    try {
      bluetoothScan = await bluetooth.requestLEScan({
        acceptAllAdvertisements: true,
        keepRepeatedDevices: true,
      });

      bluetoothListener = (event: Event) => {
        const adv = event as unknown as BluetoothAdvertisementLike;
        if (typeof adv.rssi !== "number") return;
        const deviceId = adv.device?.id ?? adv.device?.name;
        if (!deviceId) return;

        const label = adv.device?.name || adv.device?.id || "bt device";
        const rssi = adv.rssi;
        const txPower = typeof adv.txPower === "number" ? adv.txPower : DEFAULT_TX_POWER;
        const services = Array.isArray(adv.uuids) ? adv.uuids.length : 0;

        upsertTarget({
          id: `bt:${deviceId}`,
          label,
          protocol: "bluetooth",
          evidence: "measured",
          rssi,
          txPower,
          meta: `rssi ${rssi} | tx ${txPower} | ${services} svc`,
        });
      };

      bluetooth.addEventListener?.("advertisementreceived", bluetoothListener);
      setBtStatus("scanning");
      pushEvent("bluetooth LE scan started");
    } catch {
      if (!destroyed) setBtStatus("blocked");
      if (!destroyed) pushEvent("bluetooth scan blocked by browser or user");
    }
  }

  function stopBluetoothScan(): void {
    try { bluetoothScan?.stop(); } catch { /* */ }
    bluetoothScan = null;
    if (bluetooth && bluetoothListener) {
      bluetooth.removeEventListener?.("advertisementreceived", bluetoothListener);
    }
    bluetoothListener = null;
    if (opts.bluetoothEl.textContent === "scanning") setBtStatus("idle");
  }

  // ── Bluetooth device picker ────────────────────────────────────────────

  async function pickBluetoothDevice(): Promise<void> {
    if (!bluetooth || typeof bluetooth.requestDevice !== "function") {
      pushEvent(
        bluetooth
          ? "device picker not exposed by this browser"
          : "Web Bluetooth not available in this browser"
      );
      return;
    }

    try {
      const device = await bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [],
      });
      if (destroyed) return;

      const label = device.name || device.id || "picked device";
      pushEvent(`picked: ${label}`);

      upsertTarget({
        id: `bt:pick:${device.id}`,
        label,
        protocol: "bluetooth",
        evidence: "inferred",
        rssi: -55,
        txPower: DEFAULT_TX_POWER,
        meta: "paired via picker",
      });

      // Attempt GATT service discovery
      if (device.gatt) {
        try {
          const server = await device.gatt.connect();
          if (destroyed) { try { server.disconnect(); } catch { /* */ } return; }
          const services = await server.getPrimaryServices();
          if (!destroyed) {
            const existing = targets.get(`bt:pick:${device.id}`);
            if (existing) {
              existing.meta = `paired | ${services.length} GATT service${services.length !== 1 ? "s" : ""}`;
              const uuids = services.map((s) => s.uuid).join(", ");
              if (uuids) existing.meta += ` | ${uuids}`;
            }
            renderContacts();
            pushEvent(`${label}: ${services.length} GATT services`);
          }
          server.disconnect();
        } catch {
          if (!destroyed) pushEvent(`${label}: GATT connect failed (normal for many devices)`);
        }
      }
    } catch {
      if (!destroyed) pushEvent("device picker cancelled");
    }
  }

  // ── Device orientation (compass) ───────────────────────────────────────

  let compassListenersAttached = false;

  function handleOrientation(event: Event): void {
    if (!isScanActive()) return;
    const e = event as DeviceOrientationLike;

    if (typeof e.webkitCompassHeading === "number") {
      compassHeading = e.webkitCompassHeading;
      compassFromOrientation = true;
    } else if (e.absolute && typeof e.alpha === "number") {
      compassHeading = (360 - e.alpha) % 360;
      compassFromOrientation = true;
    } else if (typeof e.alpha === "number") {
      compassHeading = (360 - e.alpha) % 360;
      compassFromOrientation = true;
    }

    renderCompass();
  }

  function attachCompassListeners(): void {
    if (compassListenersAttached) return;
    compassListenersAttached = true;
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("deviceorientationabsolute", handleOrientation, options);
    window.addEventListener("deviceorientation", handleOrientation, options);
    registerCleanup(sensorCleanups, () => {
      window.removeEventListener("deviceorientationabsolute", handleOrientation, options);
      window.removeEventListener("deviceorientation", handleOrientation, options);
      compassListenersAttached = false;
    });
  }

  function startCompass(): void {
    const orientationCtor = (
      window as unknown as { DeviceOrientationEvent?: DeviceOrientationEventLike }
    ).DeviceOrientationEvent;
    if (!orientationCtor) return;

    if (typeof orientationCtor.requestPermission === "function") {
      orientationCtor.requestPermission()
        .then((perm: string) => {
          if (!isScanActive()) return;
          if (perm === "granted") {
            attachCompassListeners();
            pushEvent("compass permission granted");
          } else {
            pushEvent("compass permission denied");
          }
        })
        .catch(() => {
          if (isScanActive()) pushEvent("compass permission request failed");
        });
    } else {
      attachCompassListeners();
    }
  }

  // ── Ambient light sensor ───────────────────────────────────────────────

  function startAmbientLight(): void {
    try {
      const SensorCtor = (
        window as unknown as { AmbientLightSensor?: new () => AmbientLightSensorLike }
      ).AmbientLightSensor;
      if (typeof SensorCtor !== "function") return;

      const sensor = new SensorCtor();
      sensor.start();

      const handler = () => {
        if (!isScanActive()) return;
        ambientLux = sensor.illuminance;
        renderAmbient();
      };
      sensor.addEventListener("reading", handler);
      registerCleanup(sensorCleanups, () => {
        sensor.removeEventListener("reading", handler);
        sensor.stop();
      });
      pushEvent("ambient light sensor started");
    } catch {
      // not available
    }
  }

  // ── NFC ───────────────────────────────────────────────────────────────

  async function startNfcScan(): Promise<void> {
    if (!("NDEFReader" in window)) return;
    try {
      type NDEFReaderLike = EventTarget & {
        scan: (opts?: { signal?: AbortSignal }) => Promise<void>;
      };
      const Ctor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
      const reader = new Ctor();
      const abort = new AbortController();
      await reader.scan({ signal: abort.signal });
      const handler = (event: Event) => {
        if (!isScanActive()) return;
        const e = event as unknown as NDEFReadingEventLike;
        const serial = e.serialNumber || "unknown";
        const records = e.message?.records?.length ?? 0;
        upsertTarget({
          id: `nfc:${serial}`,
          label: `NFC ${serial.slice(0, 8)}`,
          protocol: "radio",
          evidence: "measured",
          rssi: -20,
          txPower: -10,
          meta: `nfc | contact range | ${records} record${records !== 1 ? "s" : ""}`,
        });
      };
      reader.addEventListener("reading", handler);
      registerCleanup(sensorCleanups, () => {
        reader.removeEventListener("reading", handler);
        abort.abort();
      });
      pushEvent("NFC scan active");
    } catch {
      // permission denied or unavailable — silent
    }
  }

  // ── Geolocation ────────────────────────────────────────────────────────

  function startGeolocation(): void {
    if (!("geolocation" in navigator)) return;

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!isScanActive()) return;
        selfLat = pos.coords.latitude;
        selfLon = pos.coords.longitude;
        selfAcc = pos.coords.accuracy;

        // Capture speed when available
        if (typeof pos.coords.speed === "number" && Number.isFinite(pos.coords.speed)) {
          selfSpeed = pos.coords.speed;
        }

        // Geolocation heading fallback: coords.heading is the direction of travel
        // (non-null when the device is actually moving). Use it to fill compass
        // when deviceorientation events are unavailable or unreliable.
        if (
          typeof pos.coords.heading === "number" &&
          Number.isFinite(pos.coords.heading) &&
          pos.coords.heading >= 0
        ) {
          geoHeadingAvailable = true;
          // Only apply if device orientation hasn't provided a heading
          if (!compassFromOrientation) {
            compassHeading = pos.coords.heading;
            renderCompass();
          }
        }

        renderSelfLoc();
      },
      (err) => {
        pushEvent(`geo: ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 },
    );

    registerCleanup(sensorCleanups, () => navigator.geolocation.clearWatch(watchId));
  }

  // ── Navigation Timing / Resource Timing probe ──────────────────────────

  function rttToSyntheticRssi(rttMs: number): number {
    // Map RTT to synthetic RSSI: lower RTT → stronger signal
    // 0-20ms → -30 (excellent), 20-80ms → -45 to -60, 80-200ms → -60 to -75, 200ms+ → -80+
    if (rttMs <= 0) return -30;
    const clamped = clamp(rttMs, 1, 500);
    return clamp(Math.round(-30 - (Math.log2(clamped) * 6)), -90, -25);
  }

  async function runNavigationTimingProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return;

    try {
      // Collect RTT measurements from recent resource entries
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];

      // Filter to entries with actual connection timing (non-cached, non-zero)
      const rttSamples: number[] = [];
      const recentCutoff = performance.now() - 30_000; // last 30 seconds

      for (let i = entries.length - 1; i >= 0 && rttSamples.length < 10; i--) {
        const e = entries[i];
        if (e.startTime < recentCutoff) break;
        // Only count entries with actual TCP handshakes (transferSize > 0 means not from cache)
        const connectTime = e.connectEnd - e.connectStart;
        if (connectTime > 0 && e.transferSize > 0) {
          rttSamples.push(connectTime);
        }
      }

      // Also sample the page navigation entry for baseline
      const navEntries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      if (navEntries.length > 0) {
        const nav = navEntries[0];
        const navConnect = nav.connectEnd - nav.connectStart;
        if (navConnect > 0) rttSamples.push(navConnect);
      }

      if (rttSamples.length === 0) return;

      const avgRtt = rttSamples.reduce((sum, v) => sum + v, 0) / rttSamples.length;
      smoothedRttMs = smoothedRttMs === null
        ? avgRtt
        : smoothedRttMs * 0.6 + avgRtt * 0.4;

      upsertSelfDevice();
    } catch { /* timing API read failed */ }
  }

  // ── Self device consolidation ──────────────────────────────────────────

  /**
   * Consolidates local environmental signals (network RTT, uplink status,
   * hardware sensors, and interface routes) into the central 'self:device' contact.
   * This ensures the radar center dot is interactive and descriptive.
   */
  function upsertSelfDevice(): void {
    if (destroyed) return;

    const summaryParts: string[] = [];
    if (smoothedRttMs !== null) summaryParts.push(`${Math.round(smoothedRttMs)}ms`);
    if (selfUplink) summaryParts.push(selfUplink);

    // Signal strength from best available RTT
    const bestRtt = smoothedFetchRttMs ?? smoothedRttMs ?? 0;
    const selfRssi = bestRtt > 0 ? rttToSyntheticRssi(bestRtt) : -25;

    upsertTarget({
      id: "self:device",
      label: "self device",
      protocol: "self" as RadarProtocol,
      evidence: "inferred",
      rssi: selfRssi,
      txPower: DEFAULT_TX_POWER,
      meta: summaryParts.join(" | ") || "local metrics",
    });
  }

  // ── PerformanceObserver for live resource timing ───────────────────────

  function startResourceTimingObserver(): void {
    if (typeof PerformanceObserver === "undefined") return;

    // Check if resource entries are supported
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      .supportedEntryTypes;
    if (!supported?.includes("resource")) return;

    try {
      resourceObserver = new PerformanceObserver((list) => {
        if (!isScanActive()) return;

        const entries = list.getEntries() as PerformanceResourceTiming[];
        const rttSamples: number[] = [];

        for (const e of entries) {
          const connectTime = e.connectEnd - e.connectStart;
          if (connectTime > 0 && e.transferSize > 0) {
            rttSamples.push(connectTime);
          }
        }

        if (rttSamples.length === 0) return;

        const avgRtt = rttSamples.reduce((sum, v) => sum + v, 0) / rttSamples.length;
        smoothedRttMs = smoothedRttMs === null
          ? avgRtt
          : smoothedRttMs * 0.6 + avgRtt * 0.4;

        upsertSelfDevice();
      });

      resourceObserver.observe({ type: "resource", buffered: false });
      registerCleanup(sensorCleanups, () => {
        resourceObserver?.disconnect();
        resourceObserver = null;
      });
    } catch { /* observer creation failed */ }
  }

  // ── Active fetch RTT probe ────────────────────────────────────────────

  async function runActiveFetchProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof fetch !== "function") return;

    try {
      // Fetch a tiny same-origin resource to produce a real RTT measurement.
      // Use the page's own URL with cache-busting to ensure a fresh connection.
      const url = `/favicon.svg?_radar=${Date.now()}`;
      const t0 = performance.now();
      const resp = await fetch(url, {
        method: "HEAD",
        cache: "no-store",
        credentials: "omit",
      });
      const t1 = performance.now();

      if (!isScanActive()) return;
      if (!resp.ok) return;

      const rttMs = t1 - t0;
      smoothedFetchRttMs = smoothedFetchRttMs === null
        ? rttMs
        : smoothedFetchRttMs * 0.5 + rttMs * 0.5;

      upsertSelfDevice();
    } catch { /* fetch failed — offline or blocked */ }
  }

  // ── DNS timing probe ──────────────────────────────────────────────────

  async function runDnsTimingProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return;

    try {
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const dnsSamples: number[] = [];
      const recentCutoff = performance.now() - 30_000;

      for (let i = entries.length - 1; i >= 0 && dnsSamples.length < 10; i--) {
        const e = entries[i];
        if (e.startTime < recentCutoff) break;
        const dnsTime = e.domainLookupEnd - e.domainLookupStart;
        if (dnsTime > 0) {
          dnsSamples.push(dnsTime);
        }
      }

      // Also check the navigation entry
      const navEntries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      if (navEntries.length > 0) {
        const nav = navEntries[0];
        const navDns = nav.domainLookupEnd - nav.domainLookupStart;
        if (navDns > 0) dnsSamples.push(navDns);
      }

      if (dnsSamples.length === 0) return;

      const avgDns = dnsSamples.reduce((sum, v) => sum + v, 0) / dnsSamples.length;
      smoothedDnsMs = smoothedDnsMs === null
        ? avgDns
        : smoothedDnsMs * 0.6 + avgDns * 0.4;

      upsertSelfDevice();
    } catch { /* timing API read failed */ }
  }

  // ── Sweep lifecycle ────────────────────────────────────────────────────

  let sensorsStarted = false;

  function startSensors(): void {
    if (sensorsStarted) return;
    sensorsStarted = true;

    // These require permission and must be triggered from a user gesture (click).
    // iOS compass requestPermission() silently fails if not from a click handler.
    startCompass();
    startAmbientLight();
    startGeolocation();
    void startNfcScan();
    startResourceTimingObserver();
    upsertSelfDevice();
  }

  function stopSensors(): void {
    runAndClearCleanups(sensorCleanups);
    sensorsStarted = false;
  }

  function startStalePurgeLoop(): void {
    if (stalePurgeTimer !== null) return;
    stalePurgeTimer = window.setInterval(() => {
      removeStaleTargets();
      renderStats();
      renderContacts();
    }, STALE_PURGE_MS);
  }

  function stopStalePurgeLoop(): void {
    if (stalePurgeTimer === null) return;
    window.clearInterval(stalePurgeTimer);
    stalePurgeTimer = null;
  }

  function resetSensorReadouts(): void {
    selfLat = null;
    selfLon = null;
    selfAcc = null;
    selfSpeed = null;
    compassHeading = null;
    compassFromOrientation = false;
    geoHeadingAvailable = false;
    ambientLux = null;
    smoothedRttMs = null;
    smoothedFetchRttMs = null;
    smoothedDnsMs = null;
    renderSelfLoc();
    renderCompass();
    renderAmbient();
  }

  function syncButtonStates(): void {
    if (!loaded) {
      opts.startBtn.textContent = "Load";
      opts.startBtn.classList.remove("action-btn--run");
      opts.startBtn.disabled = false;
    } else if (!running) {
      opts.startBtn.textContent = "Run";
      opts.startBtn.classList.add("action-btn--run");
      opts.startBtn.disabled = false;
    } else {
      // keep "Run" label while active, just disable the button
      opts.startBtn.textContent = "Run";
      opts.startBtn.classList.add("action-btn--run");
      opts.startBtn.disabled = true;
    }
    opts.stopBtn.disabled = !running;
  }

  function loadEngine(): void {
    if (loaded) return;
    loaded = true;
    syncButtonStates();
    pushEvent("engine loaded");
  }

  function startSweep(): void {
    if (!loaded || running) return;
    running = true;
    scanStartedAt = Date.now();
    lastModeSecond = -1;
    syncButtonStates();
    setMode("scanning 0s");
    pushEvent("scan started");

    // Start sensors on first scan — this is inside the click handler chain,
    // so iOS permission prompts work correctly.
    startSensors();

    startNetworkProbeLoop({ immediate: true });
    startStalePurgeLoop();
  }

  function stopSweep(): void {
    if (!running) return;
    running = false;
    scanStartedAt = null;
    lastModeSecond = -1;
    syncButtonStates();
    setMode("idle");
    pushEvent("scan stopped");

    stopNetworkProbeLoop();
    stopStalePurgeLoop();
    stopSensors();

    // Return top sensor readouts to idle defaults immediately on stop.
    resetSensorReadouts();

    iceProbePending = false;
    mediaProbePending = false;
    timingProbePending = false;
    fetchProbePending = false;
    dnsProbePending = false;
  }

  function clearTargets(): void {
    targets.clear();
    selectedContactId = null;
    hoveredContactId = null;
    events.length = 0;
    renderStats();
    renderContacts();
    renderEvents();
    // Revert sensor readouts to their idle default so the display matches
    // the empty contact state rather than showing stale sensor values.
    resetSensorReadouts();
    // Re-push a single "cleared" event so the events section isn't blank.
    pushEvent("cleared");
  }

  // ── Contact click to expand ────────────────────────────────────────────

  function handleContactClick(e: Event): void {
    const li = findContactItem(e.target);
    if (!li) return;
    const id = li.dataset.contactId ?? null;
    setHoveredContact(id);
    selectedContactId = selectedContactId === id ? null : id;
    renderContacts();
  }

  function handleContactKeydown(e: Event): void {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;

    const li = findContactItem(keyEvent.target);
    if (!li) return;

    keyEvent.preventDefault();
    const id = li.dataset.contactId ?? null;
    setHoveredContact(id);
    selectedContactId = selectedContactId === id ? null : id;
    renderContacts();

    const updated = findContactItemById(opts.contactsEl, id);
    updated?.focus();
  }

  function handleCanvasPointerMove(e: Event): void {
    const point = getEventPoint(e);
    if (!point || point.pointerType === "touch") return;
    const id = pickCanvasContactId(point.clientX, point.clientY);
    opts.canvas.style.cursor = id ? "pointer" : "default";
    setHoveredContact(id);
  }

  function handleCanvasPointerLeave(): void {
    opts.canvas.style.cursor = "default";
    setHoveredContact(null);
  }

  function handleCanvasPointerDown(e: Event): void {
    const point = getEventPoint(e);
    if (!point) return;
    const id = pickCanvasContactId(point.clientX, point.clientY);
    if (!id) return;
    if (point.pointerType !== "mouse") e.preventDefault();
    setHoveredContact(id);
    selectedContactId = selectedContactId === id ? null : id;
    renderContacts();
  }

  // ── Wire up ────────────────────────────────────────────────────────────

  on(opts.startBtn, "click", () => { if (!loaded) loadEngine(); else startSweep(); });
  on(opts.stopBtn, "click", () => stopSweep());
  on(opts.bluetoothScanBtn, "click", () => { void startBluetoothScan(); });
  on(opts.bluetoothPickBtn, "click", () => { void pickBluetoothDevice(); });
  on(opts.clearBtn, "click", () => clearTargets());
  on(opts.triageProtocolEl, "change", () => applyTriageFromControls());
  on(opts.triageEvidenceEl, "change", () => applyTriageFromControls());
  on(opts.triageStateEl, "change", () => applyTriageFromControls());
  on(opts.triageSortEl, "change", () => applyTriageFromControls());
  on(opts.triageMinConfidenceEl, "input", () => applyTriageFromControls());
  on(opts.triageMinConfidenceEl, "change", () => applyTriageFromControls());
  on(opts.triageActiveOnlyEl, "change", () => applyTriageFromControls());
  on(opts.contactsEl, "click", handleContactClick);
  on(opts.contactsEl, "keydown", handleContactKeydown);
  const supportsPointerEvents = typeof PointerEvent !== "undefined";
  if (supportsPointerEvents) {
    on(opts.canvas, "pointermove", handleCanvasPointerMove, { passive: true });
    on(opts.canvas, "pointerdown", handleCanvasPointerDown);
    on(opts.canvas, "pointerleave", handleCanvasPointerLeave);
    on(opts.canvas, "pointercancel", handleCanvasPointerLeave);
  } else {
    on(opts.canvas, "mousemove", handleCanvasPointerMove, { passive: true });
    on(opts.canvas, "mousedown", handleCanvasPointerDown);
    on(opts.canvas, "mouseleave", handleCanvasPointerLeave);
    on(opts.canvas, "touchstart", handleCanvasPointerDown, { passive: false });
    on(opts.canvas, "touchend", handleCanvasPointerLeave);
    on(opts.canvas, "touchcancel", handleCanvasPointerLeave);
  }
  on(window, "resize", () => drawCanvas(), { passive: true });

  on(window, "online", () => { runNetworkProbe(); pushEvent("online"); });
  on(window, "offline", () => { pushEvent("offline"); });

  // Pause the network poll interval when the tab is hidden (saves battery and
  // prevents probe backlog on mobile radios). Resume immediately on visibility.
  on(document, "visibilitychange", () => {
    if (!running) return;
    if (document.visibilityState === "hidden") {
      stopNetworkProbeLoop();
    } else if (networkPollTimer === null) {
      startNetworkProbeLoop({ immediate: true });
    }
  }, { passive: true });

  // Live connection quality changes (mobile switching towers, wifi handoffs, etc.)
  if (navigatorLike.connection) {
    const connTarget = navigatorLike.connection as unknown as EventTarget;
    if (typeof connTarget.addEventListener === "function") {
      on(connTarget, "change", () => {
        runNetworkProbe();
        pushEvent("connection changed");
      });
    }
  }

  // ── Initial state ──────────────────────────────────────────────────────

  const hasBluetoothPicker = Boolean(bluetooth && typeof bluetooth.requestDevice === "function");
  const hasBluetoothLeScan = Boolean(bluetooth && typeof bluetooth.requestLEScan === "function");
  const btInitStatus = !bluetooth
    ? "no api"
    : (hasBluetoothPicker || hasBluetoothLeScan)
      ? "idle"
      : "unavailable";
  setBtStatus(btInitStatus);
  if (!bluetooth) {
    opts.bluetoothEl.title = "Web Bluetooth not supported in this browser — use Chrome or Edge";
    opts.bluetoothScanBtn.disabled = true;
    opts.bluetoothScanBtn.title = "Web Bluetooth not supported in this browser";
    opts.bluetoothPickBtn.disabled = true;
    opts.bluetoothPickBtn.title = "Web Bluetooth not supported in this browser";
  } else {
    opts.bluetoothEl.title = hasBluetoothLeScan || hasBluetoothPicker
      ? ""
      : "Web Bluetooth is present but scan/picker APIs are unavailable in this browser";
    opts.bluetoothScanBtn.title = hasBluetoothLeScan
      ? ""
      : "Bluetooth LE scan API not available in this browser";
    opts.bluetoothPickBtn.title = hasBluetoothPicker
      ? ""
      : "Bluetooth picker API not available in this browser";
  }
  opts.modelEl.textContent = "path-loss + kalman + online variance + rate telemetry";
  setMode("idle");

  syncTriageControls();
  syncButtonStates();
  renderCapabilities();
  renderStats();
  renderContacts();
  renderEvents();
  renderSelfLoc();
  renderCompass();
  renderAmbient();

  // Network probe runs once at init (no permission needed, passive read).
  // Sensors that need permissions (geo, compass, ambient) start on first Scan click.
  runNetworkProbe({ allowWhenIdle: true });

  animationFrameId = requestAnimationFrame(tick);

  return () => {
    destroyed = true;
    stopSweep();
    stopNetworkProbeLoop();
    stopStalePurgeLoop();
    stopSensors();
    stopBluetoothScan();
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    runAndClearCleanups(cleanups);
  };
}



