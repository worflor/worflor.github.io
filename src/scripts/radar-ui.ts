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
  contactsEl: HTMLElement;
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
  contactsEl: "radar-contacts",
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

interface NavigatorLike extends Navigator {
  bluetooth?: BluetoothLike;
  connection?: NetworkConnectionLike;
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

// ─── Utility ─────────────────────────────────────────────────────────────────

function queryById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

function queryButtonById(root: ParentNode, id: string): HTMLButtonElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLButtonElement ? node : null;
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

function rangeToCanvasRadius(distanceM: number, scopeRadiusPx: number): number {
  const normalized = Math.log1p(distanceM) / Math.log1p(MAX_DISTANCE_M);
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
      note: hasLeScan ? "real-time advertisement RSSI stream" : "Chrome only · chrome://flags/#enable-experimental-web-platform-features",
    },
    {
      key: "bluetooth-device-picker",
      available: hasPicker,
      quality: hasPicker ? "partial" : "none",
      note: hasPicker ? "manual device selection via browser dialog" : "Chrome/Edge only · not supported in Firefox or Safari",
    },
    {
      key: "network-information",
      available: hasNetworkInfo,
      quality: hasNetworkInfo ? "partial" : "none",
      note: hasNetworkInfo ? "effective type, downlink, rtt" : "API not available",
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
      note: hasGeo ? "self-position with accuracy" : "not available",
    },
    {
      key: "ambient-light-sensor",
      available: hasAls,
      quality: hasAls ? "partial" : "none",
      note: hasAls ? "environment lux reading" : "sensor not exposed",
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
  const contactsEl = queryById(root, RADAR_UI_IDS.contactsEl);
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
    !contactsEl || !eventsEl || !capabilitiesEl || !startBtn || !stopBtn ||
    !bluetoothScanBtn || !bluetoothPickBtn || !clearBtn ||
    !selfLocEl || !compassEl || !ambientEl
  ) {
    return null;
  }

  return {
    canvas, modeEl, bluetoothEl, modelEl,
    totalEl, bluetoothCountEl, wifiCountEl, radioCountEl,
    contactsEl, eventsEl, capabilitiesEl,
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

  let destroyed = false;
  let running = false;
  let animationFrameId = 0;
  let bluetoothScan: BluetoothScanHandleLike | null = null;
  let bluetoothListener: ((event: Event) => void) | null = null;
  let networkPollTimer: number | null = null;
  let stalePurgeTimer: number | null = null;
  let iceProbeInFlight = false;
  let iceProbePending = false;
  let mediaProbeInFlight = false;
  let mediaProbePending = false;

  let compassHeading: number | null = null;
  let ambientLux: number | null = null;
  let selfLat: number | null = null;
  let selfLon: number | null = null;
  let selfAcc: number | null = null;
  let selectedContactId: string | null = null;
  let hoveredContactId: string | null = null;
  const canvasTargetHits = new Map<string, { x: number; y: number; r: number }>();

  function isScanActive(): boolean {
    return running && !destroyed;
  }

  const maybeContext = opts.canvas.getContext("2d");
  if (!(maybeContext instanceof CanvasRenderingContext2D)) return () => {};
  const context = maybeContext;

  // ── Helpers ────────────────────────────────────────────────────────────

  function on(
    target: EventTarget,
    event: string,
    handler: (e: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(event, handler as EventListener, options);
    cleanups.push(() => target.removeEventListener(event, handler as EventListener, options));
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

  function scheduleIceProbe(): void {
    if (!isScanActive()) return;
    if (iceProbeInFlight) {
      iceProbePending = true;
      return;
    }

    iceProbeInFlight = true;
    void runIceProbe().finally(() => {
      iceProbeInFlight = false;
      if (!iceProbePending) return;
      iceProbePending = false;
      scheduleIceProbe();
    });
  }

  function scheduleEnumerateDevicesProbe(): void {
    if (!isScanActive()) return;
    if (mediaProbeInFlight) {
      mediaProbePending = true;
      return;
    }

    mediaProbeInFlight = true;
    void runEnumerateDevicesProbe().finally(() => {
      mediaProbeInFlight = false;
      if (!mediaProbePending) return;
      mediaProbePending = false;
      scheduleEnumerateDevicesProbe();
    });
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
      });

      pushEvent(`+ ${input.label} [${input.protocol}]`);
    } else {
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
    }

    renderStats();
    renderContacts();
  }

  function removeStaleTargets(): void {
    const cutoff = Date.now() - STALE_TARGET_MS;
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

    const styles = getComputedStyle(opts.canvas);
    const textRgb = styles.getPropertyValue("--color-text-rgb").trim() || "245 245 245";
    const cyanRgb = styles.getPropertyValue("--chromatic-cyan").trim() || "0 255 255";
    const redRgb = styles.getPropertyValue("--chromatic-red").trim() || "255 0 0";

    context.clearRect(0, 0, cssWidth, cssHeight);

    // Distance rings with labels
    const ringDistances = [1, 5, 15, 35, 80];
    const fontSize = Math.max(8, cssWidth * 0.024);

    context.lineWidth = 0.7;
    context.font = `${fontSize}px sans-serif`;
    context.textAlign = "left";
    context.textBaseline = "bottom";

    for (let i = 0; i < ringDistances.length; i++) {
      const ringRadius = rangeToCanvasRadius(ringDistances[i], scopeRadius);
      context.strokeStyle = `rgb(${textRgb} / 0.1)`;
      context.beginPath();
      context.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      context.stroke();

      context.fillStyle = `rgb(${textRgb} / 0.2)`;
      context.fillText(`${ringDistances[i]}m`, cx + 4, cy - ringRadius + fontSize + 1);
    }

    // Crosshairs
    context.strokeStyle = `rgb(${textRgb} / 0.07)`;
    context.lineWidth = 0.7;
    context.beginPath();
    context.moveTo(cx - scopeRadius, cy);
    context.lineTo(cx + scopeRadius, cy);
    context.moveTo(cx, cy - scopeRadius);
    context.lineTo(cx, cy + scopeRadius);
    context.stroke();

    // Compass cardinal directions
    if (compassHeading !== null) {
      const headingRad = (compassHeading * Math.PI) / 180;
      const cardinals: Array<[string, number]> = [
        ["N", 0], ["E", Math.PI / 2], ["S", Math.PI], ["W", (3 * Math.PI) / 2],
      ];
      const labelOffset = scopeRadius + Math.max(10, cssWidth * 0.028);
      context.fillStyle = `rgb(${textRgb} / 0.3)`;
      context.font = `bold ${Math.max(9, cssWidth * 0.026)}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";

      for (const [label, angle] of cardinals) {
        const adjusted = angle - headingRad;
        const lx = cx + Math.sin(adjusted) * labelOffset;
        const ly = cy - Math.cos(adjusted) * labelOffset;
        context.fillText(label, lx, ly);
      }
    }

    // Self accuracy radius (from GPS)
    if (selfAcc !== null && selfAcc > 0) {
      const accRadius = rangeToCanvasRadius(selfAcc, scopeRadius);
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

    // ── Render targets ──────────────────────────────────────────────────

    const now = Date.now();
    canvasTargetHits.clear();

    // Draw inferred ring once (shared by all inferred targets)
    let hasInferred = false;
    for (const target of targets.values()) {
      if (target.protocol !== "self" && target.evidence !== "measured") {
        hasInferred = true;
        break;
      }
    }
    const inferredRadius = scopeRadius * 0.78;
    if (hasInferred) {
      context.strokeStyle = `rgb(${textRgb} / 0.08)`;
      context.setLineDash([3, 5]);
      context.lineWidth = 0.7;
      context.beginPath();
      context.arc(cx, cy, inferredRadius, 0, Math.PI * 2);
      context.stroke();
      context.setLineDash([]);
    }

    for (const target of targets.values()) {
      if (target.protocol === "self") continue;

      const age = now - target.lastSeen;
      const staleFactor = clamp(1 - age / STALE_TARGET_MS, 0.2, 1);
      const isSelected = selectedContactId === target.id;
      const isHovered = hoveredContactId === target.id;

      let colorRgb = textRgb;
      if (target.protocol === "bluetooth") colorRgb = cyanRgb;
      if (target.protocol === "radio") colorRgb = redRgb;

      const alpha = staleFactor * (target.evidence === "measured" ? 0.85 : 0.55);

      let tx: number;
      let ty: number;
      let markerSize: number;

      if (target.evidence === "measured" && target.distanceM !== null) {
        const radius = rangeToCanvasRadius(target.distanceM, scopeRadius);

        // Uncertainty band
        const sigma = target.sigmaM ?? 0.5;
        const innerRadius = rangeToCanvasRadius(Math.max(MIN_DISTANCE_M, target.distanceM - sigma), scopeRadius);
        const outerRadius = rangeToCanvasRadius(target.distanceM + sigma, scopeRadius);
        const bandWidth = outerRadius - innerRadius;

        context.strokeStyle = `rgb(${colorRgb} / ${(0.08 * staleFactor).toFixed(3)})`;
        context.lineWidth = clamp(bandWidth, 1, 10);
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.stroke();

        tx = cx + Math.cos(target.angleRad) * radius;
        ty = cy + Math.sin(target.angleRad) * radius;
        markerSize = clamp(2 + target.confidence * 3, 2.2, 5.5);
      } else {
        if (isLocalBrowserTarget(target)) {
          const inner = scopeRadius * 0.08;
          const outer = scopeRadius * 0.22;
          const localRadius = inner + (outer - inner) * hashUnit(target.id);
          tx = cx + Math.cos(target.angleRad) * localRadius;
          ty = cy + Math.sin(target.angleRad) * localRadius;
          markerSize = 2.9;
        } else {
          tx = cx + Math.cos(target.angleRad) * inferredRadius;
          ty = cy + Math.sin(target.angleRad) * inferredRadius;
          markerSize = 2.5;
        }
      }

      // Marker dot
      context.fillStyle = `rgb(${colorRgb} / ${alpha.toFixed(3)})`;
      context.beginPath();
      context.arc(tx, ty, markerSize, 0, Math.PI * 2);
      context.fill();

      canvasTargetHits.set(target.id, {
        x: tx,
        y: ty,
        r: Math.max(markerSize + 8, 11),
      });

      // Selection indicator + label
      if (isSelected || isHovered) {
        const ringAlpha = isSelected ? 0.5 * staleFactor : 0.3 * staleFactor;
        context.strokeStyle = `rgb(${colorRgb} / ${ringAlpha.toFixed(3)})`;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(tx, ty, markerSize + (isSelected ? 4 : 3), 0, Math.PI * 2);
        context.stroke();

        context.fillStyle = `rgb(${textRgb} / ${(isSelected ? 0.6 : 0.48).toFixed(3)})`;
        context.font = `${Math.max(9, cssWidth * 0.024)}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "bottom";
        const distLabel = target.distanceM !== null ? ` ${formatDistance(target.distanceM)}` : "";
        context.fillText(`${target.label}${distLabel}`, tx, ty - markerSize - 5);
      }
    }

    // Center self dot
    context.fillStyle = `rgb(${cyanRgb} / 0.7)`;
    context.beginPath();
    context.arc(cx, cy, 3.5, 0, Math.PI * 2);
    context.fill();
  }

  // ── Render: stats, contacts, events, capabilities ──────────────────────

  function renderStats(): void {
    let bt = 0;
    let wifi = 0;
    let radio = 0;
    for (const target of targets.values()) {
      if (target.protocol === "bluetooth") bt += 1;
      if (target.protocol === "wifi") wifi += 1;
      if (target.protocol === "radio") radio += 1;
    }

    opts.totalEl.textContent = String(targets.size);
    opts.bluetoothCountEl.textContent = String(bt);
    opts.wifiCountEl.textContent = String(wifi);
    opts.radioCountEl.textContent = String(radio);
  }

  function renderContacts(): void {
    const sorted = Array.from(targets.values())
      .filter((t) => t.protocol !== "self")
      .sort((a, b) => {
        if (a.distanceM !== null && b.distanceM === null) return -1;
        if (a.distanceM === null && b.distanceM !== null) return 1;
        if (a.distanceM !== null && b.distanceM !== null) return a.distanceM - b.distanceM;
        return b.lastSeen - a.lastSeen;
      })
      .slice(0, 60);

    if (sorted.length === 0) {
      opts.contactsEl.innerHTML = "<li>no contacts</li>";
      return;
    }

    const now = Date.now();
    opts.contactsEl.innerHTML = sorted
      .map((target) => {
        const ageSec = Math.max(0, Math.floor((now - target.lastSeen) / 1000));
        const conf = Math.round(target.confidence * 100);
        const isSelected = selectedContactId === target.id;
        const isHovered = hoveredContactId === target.id;
        const selectedClass = isSelected ? " contact-selected" : "";
        const hoverClass = !isSelected && isHovered ? " contact-hovered" : "";
        const meta = target.meta ? ` · ${escapeText(target.meta)}` : "";

        // Expanded detail for selected contact
        let detail = "";
        if (isSelected) {
          const lines: string[] = [];
          lines.push(`rssi raw: ${target.rssiRaw} dBm`);
          lines.push(`rssi filtered: ${target.rssiFiltered.toFixed(1)} dBm`);
          lines.push(`rssi sigma: ${target.rssiSigma.toFixed(2)} dB`);
          lines.push(`tx power: ${target.txPower} dBm`);
          lines.push(`samples: ${target.stats.count}`);
          lines.push(`variance: ${variance(target.stats).toFixed(2)}`);
          lines.push(`evidence: ${target.evidence}`);
          if (target.distanceM !== null) {
            lines.push(`distance: ${formatDistance(target.distanceM)}`);
          }
          if (target.sigmaM !== null) {
            lines.push(`distance sigma: ±${target.sigmaM.toFixed(2)}m`);
          }
          lines.push(`confidence: ${conf}%`);
          lines.push(`first seen: ${formatTime(target.firstSeen)}`);
          lines.push(`last seen: ${formatTime(target.lastSeen)} (${ageSec}s ago)`);
          lines.push(`angle: ${Math.round((target.angleRad * 180) / Math.PI)}°`);
          if (target.meta) lines.push(`meta: ${target.meta}`);

          detail = `<div class="contact-detail">${lines.map((l) => `<div>${escapeText(l)}</div>`).join("")}</div>`;
        }

        if (target.evidence === "measured" && target.distanceM !== null && target.sigmaM !== null) {
          return `<li class="contact-item${selectedClass}${hoverClass}" data-contact-id="${escapeText(target.id)}" role="button" tabindex="0" aria-expanded="${isSelected ? "true" : "false"}"><div class="contact-summary"><strong>${escapeText(target.label)}</strong> · ${target.protocol} · ${formatDistance(target.distanceM)} ±${target.sigmaM.toFixed(1)}m · ${conf}% · ${ageSec}s${meta}</div>${detail}</li>`;
        }

        return `<li class="contact-item${selectedClass}${hoverClass}" data-contact-id="${escapeText(target.id)}" role="button" tabindex="0" aria-expanded="${isSelected ? "true" : "false"}"><div class="contact-summary"><strong>${escapeText(target.label)}</strong> · ${target.protocol} · inferred · ${conf}% · ${ageSec}s${meta}</div>${detail}</li>`;
      })
      .join("");
  }

  function renderEvents(): void {
    if (events.length === 0) {
      opts.eventsEl.innerHTML = "<li>idle</li>";
      return;
    }

    opts.eventsEl.innerHTML = events
      .slice(0, 40)
      .map((item) => {
        const repeat = item.repeatCount && item.repeatCount > 1 ? ` ×${item.repeatCount}` : "";
        return `<li>${escapeText(formatTime(item.time))} ${escapeText(item.message)}${escapeText(repeat)}</li>`;
      })
      .join("");
  }

  function renderCapabilities(): void {
    opts.capabilitiesEl.innerHTML = capabilities
      .map((cap) => {
        const status = cap.available ? "+" : "-";
        return `<li><strong>${status} ${escapeText(cap.key)}</strong> · ${cap.quality} · ${escapeText(cap.note)}</li>`;
      })
      .join("");
  }

  function renderSelfLoc(): void {
    if (selfLat !== null && selfLon !== null) {
      const lat = formatCoord(selfLat, "N", "S");
      const lon = formatCoord(selfLon, "E", "W");
      const acc = selfAcc !== null ? ` ±${Math.round(selfAcc)}m` : "";
      opts.selfLocEl.textContent = `${lat} ${lon}${acc}`;
    } else {
      opts.selfLocEl.textContent = "no fix";
    }
  }

  function renderCompass(): void {
    if (compassHeading !== null) {
      opts.compassEl.textContent = `${Math.round(compassHeading)}°`;
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

  // ── Animation loop (just redraws — no sweep gimmick) ───────────────────

  function tick(): void {
    if (destroyed) return;
    drawCanvas();
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
    upsertTarget({
      id: `net:uplink:${typeKey}`,
      label: `uplink ${typeKey}`,
      protocol: "wifi",
      evidence: "inferred",
      rssi: inferredRssi ?? -60,
      txPower: DEFAULT_TX_POWER,
      meta: metrics.join(" · "),
    });
  }

  async function runIceProbe(): Promise<void> {
    if (!isScanActive()) return;
    if (typeof RTCPeerConnection !== "function") return;

    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    });

    const seen = new Set<string>();
    const done = new Promise<void>((resolve) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(), 2500);
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

        // Build descriptive meta from what the candidate actually tells us
        const metaParts: string[] = [];
        metaParts.push(parsed.type); // host, srflx, relay, prflx
        metaParts.push(parsed.protocol); // udp, tcp
        metaParts.push(`port ${parsed.port}`);

        if (parsed.isIp) {
          const addr = parsed.address;
          const ipClass = classifyIp(addr);
          if (ipClass === "loopback") return; // not useful signal
          const isPrivate = ipClass === "private";

          metaParts.push(addr);

          upsertTarget({
            id: `route:${addr}`,
            label: isPrivate ? "local route" : "wan route",
            protocol: isPrivate ? "wifi" : "radio",
            evidence: "inferred",
            rssi: isPrivate ? -52 : -74,
            txPower: DEFAULT_TX_POWER,
            meta: metaParts.join(" · "),
          });
        } else if (parsed.isMdns) {
          // mDNS-obfuscated candidate — still a real network interface,
          // we just can't see the IP. The candidate type tells us what it is.
          const label = parsed.type === "srflx" ? "reflexive route"
            : parsed.type === "relay" ? "relay route"
            : "local interface";
          const mdnsBucket = `${parsed.type}:${parsed.protocol}:port${parsed.port}`;

          metaParts.push(parsed.address);

          upsertTarget({
            id: `route:mdns:${mdnsBucket}`,
            label,
            protocol: "wifi",
            evidence: "inferred",
            rssi: parsed.type === "host" ? -48 : -62,
            txPower: DEFAULT_TX_POWER,
            meta: metaParts.join(" · "),
          });
        }
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
      if (!destroyed) pushEvent("webrtc ice probe failed");
    } finally {
      try { peer.close(); } catch { /* */ }
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
          ? "audio input"
          : kind === "audiooutput"
            ? "audio output"
            : kind === "videoinput"
              ? "video input"
              : kind;

        upsertTarget({
          id: `hw:${kind}`,
          label: `${count}× ${kindLabel}`,
          protocol: "radio",
          evidence: "inferred",
          rssi: -30, // local hardware, treat as very close
          txPower: DEFAULT_TX_POWER,
          meta: `${count} local device${count > 1 ? "s" : ""} · ${kindLabel}`,
        });
      }
    } catch { /* permission denied or unavailable */ }
  }

  // ── Bluetooth LE scan ──────────────────────────────────────────────────

  async function startBluetoothScan(): Promise<void> {
    if (!bluetooth || typeof bluetooth.requestLEScan !== "function") {
      pushEvent("LE scan unavailable · Chrome only · enable chrome://flags/#enable-experimental-web-platform-features");
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
          meta: `rssi ${rssi} · tx ${txPower} · ${services} svc`,
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
      pushEvent("bluetooth device picker not available");
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
              existing.meta = `paired · ${services.length} GATT service${services.length !== 1 ? "s" : ""}`;
              const uuids = services.map((s) => s.uuid).join(", ");
              if (uuids) existing.meta += ` · ${uuids}`;
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
    } else if (e.absolute && typeof e.alpha === "number") {
      compassHeading = (360 - e.alpha) % 360;
    } else if (typeof e.alpha === "number") {
      compassHeading = (360 - e.alpha) % 360;
    }

    renderCompass();
  }

  function attachCompassListeners(): void {
    if (compassListenersAttached) return;
    compassListenersAttached = true;
    on(window, "deviceorientationabsolute", handleOrientation, { passive: true });
    on(window, "deviceorientation", handleOrientation, { passive: true });
  }

  function startCompass(): void {
    const orientationCtor = (
      window as unknown as { DeviceOrientationEvent?: DeviceOrientationEventLike }
    ).DeviceOrientationEvent;
    if (!orientationCtor) return;

    if (typeof orientationCtor.requestPermission === "function") {
      orientationCtor.requestPermission()
        .then((perm: string) => {
          if (perm === "granted") {
            attachCompassListeners();
            pushEvent("compass permission granted");
          } else {
            pushEvent("compass permission denied");
          }
        })
        .catch(() => pushEvent("compass permission request failed"));
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
      cleanups.push(() => {
        sensor.removeEventListener("reading", handler);
        sensor.stop();
      });
      pushEvent("ambient light sensor started");
    } catch {
      // not available
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
        renderSelfLoc();
      },
      (err) => {
        pushEvent(`geo: ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 },
    );

    cleanups.push(() => navigator.geolocation.clearWatch(watchId));
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
  }

  function resetSensorReadouts(): void {
    selfLat = null;
    selfLon = null;
    selfAcc = null;
    compassHeading = null;
    ambientLux = null;
    renderSelfLoc();
    renderCompass();
    renderAmbient();
  }

  function syncButtonStates(): void {
    opts.startBtn.disabled = running;
    opts.stopBtn.disabled = !running;
  }

  function startSweep(): void {
    if (running) return;
    running = true;
    syncButtonStates();
    setMode("scanning");
    pushEvent("scan started");

    // Start sensors on first scan — this is inside the click handler chain,
    // so iOS permission prompts work correctly.
    startSensors();

    runNetworkProbe();
    scheduleIceProbe();
    scheduleEnumerateDevicesProbe();

    networkPollTimer = window.setInterval(() => {
      runNetworkProbe();
      scheduleIceProbe();
      scheduleEnumerateDevicesProbe();
    }, NETWORK_POLL_MS);

    stalePurgeTimer = window.setInterval(() => {
      removeStaleTargets();
      renderStats();
      renderContacts();
    }, STALE_PURGE_MS);
  }

  function stopSweep(): void {
    if (!running) return;
    running = false;
    syncButtonStates();
    setMode("idle");
    pushEvent("scan stopped");

    // Return top sensor readouts to idle defaults immediately on stop.
    resetSensorReadouts();

    if (networkPollTimer !== null) {
      window.clearInterval(networkPollTimer);
      networkPollTimer = null;
    }

    if (stalePurgeTimer !== null) {
      window.clearInterval(stalePurgeTimer);
      stalePurgeTimer = null;
    }

    iceProbePending = false;
    mediaProbePending = false;
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

  on(opts.startBtn, "click", () => startSweep());
  on(opts.stopBtn, "click", () => stopSweep());
  on(opts.bluetoothScanBtn, "click", () => { void startBluetoothScan(); });
  on(opts.bluetoothPickBtn, "click", () => { void pickBluetoothDevice(); });
  on(opts.clearBtn, "click", () => clearTargets());
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
      if (networkPollTimer !== null) {
        window.clearInterval(networkPollTimer);
        networkPollTimer = null;
      }
    } else if (networkPollTimer === null) {
      // Tab restored — fire an immediate probe then restart the interval.
      runNetworkProbe();
      scheduleIceProbe();
      scheduleEnumerateDevicesProbe();
      networkPollTimer = window.setInterval(() => {
        runNetworkProbe();
        scheduleIceProbe();
        scheduleEnumerateDevicesProbe();
      }, NETWORK_POLL_MS);
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
  opts.modelEl.textContent = "log-distance path-loss + kalman + welford variance";
  setMode("idle");

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
    stopBluetoothScan();
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    for (const cleanup of cleanups) cleanup();
  };
}
