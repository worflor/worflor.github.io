// mirror-collectors.ts  Exhaustive client-side data collection for the Digital Mirror.
// ~230+ data points across 15 categories. Every API wrapped in try/catch.
// No permissions requested. No data stored. External IP lookup with safe fallbacks.

// 
// TYPES
// 

export type CollectionStatus = "pending" | "resolved" | "unavailable";
export type DetailConfidence = "high" | "medium" | "low";
export type DetailStability = "stable" | "session" | "live";
export type SignalTier = "core" | "context" | "deep";

export interface DataPoint {
  id: string;
  label: string;
  value: string | number | boolean | null;
  status: CollectionStatus;
  explanation: string;
  sensitive: boolean;
  live: boolean;
  privacyWeight: number; // 1-5, used for composite fingerprint hash
  action?: () => Promise<string | number | boolean | null>;
  detailSource?: string;
  detailConfidence?: DetailConfidence;
  detailStability?: DetailStability;
  signalTier?: SignalTier;
}

export interface DataCategory {
  id: string;
  title: string;
  points: DataPoint[];
  expanded: boolean;
}

export interface MirrorData {
  categories: DataCategory[];
  collectedAt: number;
  totalPoints: number;
  resolvedPoints: number;
  fingerprintHash: string;
}

export type OnDataUpdate = (categoryId: string, points: DataPoint[]) => void;

// 
// UTILITIES
// 

/** FNV-1a hash -> 8-char hex. Fast, good distribution, no crypto needed. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pt(
  id: string,
  label: string,
  value: string | number | boolean | null,
  explanation: string,
  sensitive = false,
  live = false,
  weight = 1,
  action?: () => Promise<string | number | boolean | null>,
  statusOverride?: CollectionStatus,
): DataPoint {
  return {
    id,
    label,
    value,
    status: statusOverride ?? (value === null ? "unavailable" : "resolved"),
    explanation,
    sensitive,
    live,
    privacyWeight: weight,
    action,
  };
}

function pendingPt(
  id: string,
  label: string,
  value: string | number | boolean | null,
  explanation: string,
  sensitive = false,
  live = false,
  weight = 1,
  action?: () => Promise<string | number | boolean | null>,
): DataPoint {
  return pt(id, label, value, explanation, sensitive, live, weight, action, "pending");
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === "undefined" || s === "" ? null : s;
}

function num(v: unknown): number | null {
  return typeof v === "number" && !Number.isNaN(v) ? v : null;
}

function has(obj: object, prop: string): boolean {
  return prop in obj;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface TimedRequestContext {
  requestSignal?: AbortSignal;
  cleanup: () => void;
}

function createTimedRequestContext(timeoutMs: number, signal?: AbortSignal): TimedRequestContext {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    requestSignal: controller?.signal ?? signal,
    cleanup: () => {
      if (signal && controller) {
        signal.removeEventListener("abort", onAbort);
      }
      if (timeoutId !== null) clearTimeout(timeoutId);
    },
  };
}

async function fetchJsonWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  throwIfAborted(signal);
  const timedRequest = createTimedRequestContext(timeoutMs, signal);

  try {
    const response = await fetch(url, {
      signal: timedRequest.requestSignal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json === "object" && json !== null ? (json as Record<string, unknown>) : null;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  } finally {
    timedRequest.cleanup();
  }
}

// 
// 1. NETWORK (async  IP + geolocation + ASN with provider fallbacks)
// 

interface NetworkSnapshot {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  postal: string | null;
  org: string | null;
  asn: string | null;
  timezone: string | null;
  currency: string | null;
  callingCode: string | null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function numLike(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeCountryCode(v: unknown): string | null {
  const s = str(v)?.trim().toUpperCase();
  return s && /^[A-Z]{2}$/.test(s) ? s : null;
}

function normalizeCurrencyCode(v: unknown): string | null {
  const s = str(v)?.trim().toUpperCase();
  return s && /^[A-Z]{3}$/.test(s) ? s : null;
}

function normalizeCallingCode(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

function normalizeAsn(v: unknown): string | null {
  const s = str(v)?.trim();
  if (!s) return null;
  const upper = s.toUpperCase().replace(/\s+/g, "");
  if (/^AS\d+$/.test(upper)) return upper;
  if (/^\d+$/.test(upper)) return `AS${upper}`;
  return upper;
}

function normalizePostalValue(value: string | null, countryCode: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  const cc = countryCode?.toUpperCase() || null;
  if (cc === "CA") {
    const compact = raw.toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
      return `${compact.slice(0, 3)} ${compact.slice(3)}`;
    }
    if (/^[A-Z]\d[A-Z]$/.test(compact)) {
      return compact;
    }
    return raw.toUpperCase();
  }

  if (cc === "US") {
    const digits = raw.replace(/[^\d]/g, "");
    if (/^\d{9}$/.test(digits)) {
      return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    }
    if (/^\d{5}$/.test(digits)) {
      return digits;
    }
    return raw;
  }

  if (cc === "GB") {
    const compact = raw.toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z0-9]{5,7}$/.test(compact)) {
      return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
    }
    return raw.toUpperCase();
  }

  return raw;
}

function postalQuality(value: string | null, countryCode: string | null): number {
  const postal = normalizePostalValue(value, countryCode);
  if (!postal) return 0;

  const cc = countryCode?.toUpperCase() || null;
  if (cc === "CA") {
    if (/^[A-Z]\d[A-Z]\s\d[A-Z]\d$/.test(postal)) return 100;
    if (/^[A-Z]\d[A-Z]$/.test(postal)) return 45;
  } else if (cc === "US") {
    if (/^\d{5}-\d{4}$/.test(postal)) return 100;
    if (/^\d{5}$/.test(postal)) return 85;
  } else if (cc === "GB") {
    if (/^[A-Z0-9]{2,4}\s[A-Z0-9]{3}$/.test(postal)) return 95;
  }

  const compactLen = postal.replace(/[^A-Za-z0-9]/g, "").length;
  return Math.min(80, compactLen * 10);
}

function pickBetterPostal(
  current: string | null,
  incoming: string | null,
  countryCode: string | null,
): string | null {
  const currentNorm = normalizePostalValue(current, countryCode);
  const incomingNorm = normalizePostalValue(incoming, countryCode);

  if (!currentNorm) return incomingNorm;
  if (!incomingNorm) return currentNorm;

  const currentScore = postalQuality(currentNorm, countryCode);
  const incomingScore = postalQuality(incomingNorm, countryCode);
  return incomingScore > currentScore ? incomingNorm : currentNorm;
}

function countryNameFromCode(countryCode: string): string | null {
  try {
    const DisplayNamesCtor = (Intl as any).DisplayNames;
    if (typeof DisplayNamesCtor !== "function") return null;
    const displayNames = new DisplayNamesCtor([navigator.language || "en"], { type: "region" });
    const resolved = displayNames.of(countryCode);
    if (typeof resolved !== "string" || resolved.trim() === "") return null;
    return resolved.toUpperCase() === countryCode ? null : resolved;
  } catch {
    return null;
  }
}

const CURRENCY_BY_COUNTRY_CODE: Record<string, string> = {
  AD: "EUR",
  AE: "AED",
  AF: "AFN",
  AG: "XCD",
  AL: "ALL",
  AM: "AMD",
  AO: "AOA",
  AR: "ARS",
  AT: "EUR",
  AU: "AUD",
  AZ: "AZN",
  BA: "BAM",
  BB: "BBD",
  BD: "BDT",
  BE: "EUR",
  BF: "XOF",
  BG: "BGN",
  BH: "BHD",
  BI: "BIF",
  BJ: "XOF",
  BM: "BMD",
  BN: "BND",
  BO: "BOB",
  BR: "BRL",
  BS: "BSD",
  BT: "BTN",
  BW: "BWP",
  BY: "BYN",
  BZ: "BZD",
  CA: "CAD",
  CD: "CDF",
  CF: "XAF",
  CG: "XAF",
  CH: "CHF",
  CI: "XOF",
  CL: "CLP",
  CM: "XAF",
  CN: "CNY",
  CO: "COP",
  CR: "CRC",
  CU: "CUP",
  CV: "CVE",
  CY: "EUR",
  CZ: "CZK",
  DE: "EUR",
  DJ: "DJF",
  DK: "DKK",
  DM: "XCD",
  DO: "DOP",
  DZ: "DZD",
  EC: "USD",
  EE: "EUR",
  EG: "EGP",
  ER: "ERN",
  ES: "EUR",
  ET: "ETB",
  FI: "EUR",
  FJ: "FJD",
  FM: "USD",
  FR: "EUR",
  GA: "XAF",
  GB: "GBP",
  GD: "XCD",
  GE: "GEL",
  GH: "GHS",
  GI: "GIP",
  GL: "DKK",
  GM: "GMD",
  GN: "GNF",
  GQ: "XAF",
  GR: "EUR",
  GT: "GTQ",
  GU: "USD",
  GY: "GYD",
  HK: "HKD",
  HN: "HNL",
  HR: "EUR",
  HT: "HTG",
  HU: "HUF",
  ID: "IDR",
  IE: "EUR",
  IL: "ILS",
  IN: "INR",
  IQ: "IQD",
  IR: "IRR",
  IS: "ISK",
  IT: "EUR",
  JM: "JMD",
  JO: "JOD",
  JP: "JPY",
  KE: "KES",
  KG: "KGS",
  KH: "KHR",
  KI: "AUD",
  KN: "XCD",
  KR: "KRW",
  KW: "KWD",
  KY: "KYD",
  KZ: "KZT",
  LA: "LAK",
  LB: "LBP",
  LC: "XCD",
  LK: "LKR",
  LR: "LRD",
  LS: "LSL",
  LT: "EUR",
  LU: "EUR",
  LV: "EUR",
  LY: "LYD",
  MA: "MAD",
  MC: "EUR",
  MD: "MDL",
  ME: "EUR",
  MG: "MGA",
  MH: "USD",
  MK: "MKD",
  ML: "XOF",
  MM: "MMK",
  MN: "MNT",
  MO: "MOP",
  MR: "MRU",
  MT: "EUR",
  MU: "MUR",
  MV: "MVR",
  MW: "MWK",
  MX: "MXN",
  MY: "MYR",
  MZ: "MZN",
  NA: "NAD",
  NE: "XOF",
  NG: "NGN",
  NI: "NIO",
  NL: "EUR",
  NO: "NOK",
  NP: "NPR",
  NR: "AUD",
  NZ: "NZD",
  OM: "OMR",
  PA: "PAB",
  PE: "PEN",
  PG: "PGK",
  PH: "PHP",
  PK: "PKR",
  PL: "PLN",
  PR: "USD",
  PT: "EUR",
  PW: "USD",
  PY: "PYG",
  QA: "QAR",
  RO: "RON",
  RS: "RSD",
  RU: "RUB",
  RW: "RWF",
  SA: "SAR",
  SB: "SBD",
  SC: "SCR",
  SD: "SDG",
  SE: "SEK",
  SG: "SGD",
  SI: "EUR",
  SK: "EUR",
  SL: "SLL",
  SM: "EUR",
  SN: "XOF",
  SO: "SOS",
  SR: "SRD",
  SS: "SSP",
  ST: "STN",
  SV: "USD",
  SY: "SYP",
  SZ: "SZL",
  TD: "XAF",
  TG: "XOF",
  TH: "THB",
  TJ: "TJS",
  TL: "USD",
  TM: "TMT",
  TN: "TND",
  TO: "TOP",
  TR: "TRY",
  TT: "TTD",
  TV: "AUD",
  TW: "TWD",
  TZ: "TZS",
  UA: "UAH",
  UG: "UGX",
  US: "USD",
  UY: "UYU",
  UZ: "UZS",
  VA: "EUR",
  VC: "XCD",
  VE: "VES",
  VG: "USD",
  VI: "USD",
  VN: "VND",
  VU: "VUV",
  WS: "WST",
  XK: "EUR",
  YE: "YER",
  ZA: "ZAR",
  ZM: "ZMW",
  ZW: "USD",
};

function currencyFromCountryCode(countryCode: string | null): string | null {
  if (!countryCode) return null;
  return CURRENCY_BY_COUNTRY_CODE[countryCode] || null;
}

function countryCodeDisplayValue(countryCode: string | null, country: string | null): string | null {
  if (!countryCode) return null;
  if (!country) return countryCode;
  return country.toUpperCase() === countryCode ? countryCode : `${countryCode} (${country})`;
}

function emptyNetworkSnapshot(): NetworkSnapshot {
  return {
    ip: null,
    city: null,
    region: null,
    country: null,
    countryCode: null,
    latitude: null,
    longitude: null,
    postal: null,
    org: null,
    asn: null,
    timezone: null,
    currency: null,
    callingCode: null,
  };
}

function mergeNetworkSnapshot(
  base: NetworkSnapshot,
  extra: Partial<NetworkSnapshot>,
): NetworkSnapshot {
  const mergedCountryCode = base.countryCode ?? extra.countryCode ?? null;
  return {
    ip: base.ip ?? extra.ip ?? null,
    city: base.city ?? extra.city ?? null,
    region: base.region ?? extra.region ?? null,
    country: base.country ?? extra.country ?? null,
    countryCode: mergedCountryCode,
    latitude: base.latitude ?? extra.latitude ?? null,
    longitude: base.longitude ?? extra.longitude ?? null,
    postal: pickBetterPostal(base.postal, extra.postal ?? null, mergedCountryCode),
    org: base.org ?? extra.org ?? null,
    asn: base.asn ?? extra.asn ?? null,
    timezone: base.timezone ?? extra.timezone ?? null,
    currency: base.currency ?? extra.currency ?? null,
    callingCode: base.callingCode ?? extra.callingCode ?? null,
  };
}

function extractFromIpapiIs(raw: Record<string, unknown>): Partial<NetworkSnapshot> {
  const location = rec(raw.location);
  const company = rec(raw.company);
  const asnInfo = rec(raw.asn);
  return {
    ip: str(raw.ip),
    city: str(location?.city),
    region: str(location?.state),
    country: str(location?.country),
    countryCode: normalizeCountryCode(location?.country_code),
    latitude: numLike(location?.latitude),
    longitude: numLike(location?.longitude),
    postal: str(location?.zip),
    org: str(company?.name) || str(asnInfo?.org),
    asn: normalizeAsn(asnInfo?.asn),
    timezone: str(location?.timezone),
    currency: normalizeCurrencyCode(location?.currency_code),
    callingCode: normalizeCallingCode(location?.calling_code),
  };
}

function extractFromSeeIp(raw: Record<string, unknown>): Partial<NetworkSnapshot> {
  return {
    ip: str(raw.ip),
    city: str(raw.city),
    region: str(raw.region),
    country: str(raw.country),
    countryCode: normalizeCountryCode(raw.country_code),
    latitude: numLike(raw.latitude),
    longitude: numLike(raw.longitude),
    postal: str(raw.postal_code),
    org: str(raw.organization),
    asn: normalizeAsn(raw.asn),
    timezone: str(raw.timezone),
  };
}

function extractFromIpInfo(raw: Record<string, unknown>): Partial<NetworkSnapshot> {
  const countryCode = normalizeCountryCode(raw.country);
  const loc = str(raw.loc);
  let latitude: number | null = null;
  let longitude: number | null = null;

  if (loc) {
    const [latRaw, lngRaw] = loc.split(",", 2);
    latitude = numLike(latRaw);
    longitude = numLike(lngRaw);
  }

  return {
    ip: str(raw.ip),
    city: str(raw.city),
    region: str(raw.region),
    country: countryCode ? countryNameFromCode(countryCode) : null,
    countryCode,
    latitude,
    longitude,
    postal: str(raw.postal),
    org: str(raw.org),
    timezone: str(raw.timezone),
  };
}

function extractFromIpapiCo(raw: Record<string, unknown>): Partial<NetworkSnapshot> {
  return {
    ip: str(raw.ip),
    city: str(raw.city),
    region: str(raw.region),
    country: str(raw.country_name),
    countryCode: normalizeCountryCode(raw.country_code),
    latitude: numLike(raw.latitude),
    longitude: numLike(raw.longitude),
    postal: str(raw.postal),
    org: str(raw.org),
    asn: normalizeAsn(raw.asn),
    timezone: str(raw.timezone),
    currency: normalizeCurrencyCode(raw.currency),
    callingCode: normalizeCallingCode(raw.country_calling_code),
  };
}

const NETWORK_PROVIDER_PIPELINE: Array<{
  url: string;
  timeoutMs: number;
  extract: (raw: Record<string, unknown>) => Partial<NetworkSnapshot>;
}> = [
  { url: "https://api.ipapi.is/", timeoutMs: 4500, extract: extractFromIpapiIs },
  { url: "https://api.seeip.org/geoip", timeoutMs: 4500, extract: extractFromSeeIp },
  { url: "https://ipinfo.io/json", timeoutMs: 4500, extract: extractFromIpInfo },
  { url: "https://ipapi.co/json/", timeoutMs: 4500, extract: extractFromIpapiCo },
];

async function collectNetwork(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  let snapshot = emptyNetworkSnapshot();

  throwIfAborted(signal);

  const providerResults = await Promise.allSettled(
    NETWORK_PROVIDER_PIPELINE.map(async provider => {
      const raw = await fetchJsonWithTimeout(provider.url, provider.timeoutMs, signal);
      if (!raw) return null;
      return provider.extract(raw);
    }),
  );

  throwIfAborted(signal);

  // Merge in configured provider order so precedence stays deterministic.
  for (const result of providerResults) {
    if (result.status !== "fulfilled" || !result.value) continue;
    snapshot = mergeNetworkSnapshot(snapshot, result.value);
  }

  // Last-resort fallback: public IP only.
  if (!snapshot.ip) {
    const ipify = await fetchJsonWithTimeout("https://api.ipify.org?format=json", 4000, signal);
    snapshot = mergeNetworkSnapshot(snapshot, { ip: str(ipify?.ip) });
  }

  if (!snapshot.country && snapshot.countryCode) {
    snapshot.country = countryNameFromCode(snapshot.countryCode) || snapshot.countryCode;
  }
  if (!snapshot.currency) {
    snapshot.currency = currencyFromCountryCode(snapshot.countryCode);
  }
  snapshot.postal = normalizePostalValue(snapshot.postal, snapshot.countryCode);
  const countryCodeValue = countryCodeDisplayValue(snapshot.countryCode, snapshot.country);

  p.push(pt("net.ip", "IP Address", snapshot.ip, "Your public IP address - every website you visit sees this.", true, false, 5));
  p.push(pt("net.city", "City", snapshot.city, "Approximate city derived from your IP address.", true, false, 4));
  p.push(pt("net.region", "Region / State", snapshot.region, "Region derived from IP geolocation.", false, false, 2));
  p.push(pt("net.country", "Country", snapshot.country, "Country derived from IP geolocation.", false, false, 3));
  p.push(pt("net.countryCode", "Country Code", countryCodeValue, "Two-letter country code (ISO 3166-1 alpha-2), e.g. US, CA, DE.", false, false, 2));
  p.push(pt("net.coords", "Coordinates",
    snapshot.latitude != null && snapshot.longitude != null ? `${snapshot.latitude}, ${snapshot.longitude}` : null,
    "Approximate lat/lng from IP - not GPS-accurate, typically city-level.", true, false, 4));
  p.push(pt("net.postal", "Postal Area / ZIP", snapshot.postal, "Postal code area derived from IP.", true, false, 3));
  p.push(pt("net.isp", "ISP / Organization", snapshot.org, "Your internet service provider or the organization that owns this IP range.", true, false, 3));
  p.push(pt("net.asn", "ASN", snapshot.asn, "Autonomous System Number - identifies your ISP's network block.", false, false, 2));
  p.push(pt("net.ipTimezone", "Timezone (from IP)", snapshot.timezone, "Timezone inferred from IP - can differ from your system timezone.", false, false, 2));
  p.push(pt("net.currency", "Currency", snapshot.currency, "Local currency inferred from your country.", false, false, 1));
  p.push(pt("net.callingCode", "Calling Code", snapshot.callingCode, "International dialing code for your country.", false, false, 1));

  return p;
}

// 
// 2. CONNECTION
// 

interface ConnectionProbeSnapshot {
  type: string | null;
  downlinkMbps: number | null;
  downlinkMaxMbps: number | null;
  rttMs: number | null;
}

interface NativeConnectionSnapshot {
  type: string | null;
  downlinkMbps: number | null;
  downlinkMaxMbps: number | null;
  rttMs: number | null;
  saveData: boolean | null;
}

interface ConnectionProbeOptions {
  signal?: AbortSignal;
  includeDownlink?: boolean;
}

interface ConnectionPointBuildOptions {
  includePending: boolean;
  includeUnavailableSaveData: boolean;
}

const CONNECTION_RTT_PROBE_URL = "/favicon.svg";
const CONNECTION_DOWNLINK_PROBE_URL = "/images/placeholder-2.webp";
const CONNECTION_RTT_SAMPLE_COUNT = 3;
const CONNECTION_DOWNLINK_SAMPLE_COUNT = 2;
const CONNECTION_RTT_TIMEOUT_MS = 3500;
const CONNECTION_DOWNLINK_TIMEOUT_MS = 7000;
const CONNECTION_LIVE_RTT_INTERVAL_MS = 10000;
const CONNECTION_LIVE_DOWNLINK_EVERY_NTH_SAMPLE = 4;
const CONNECTION_RTT_HISTORY_SIZE = 7;
const CONNECTION_DOWNLINK_HISTORY_SIZE = 5;

const connectionProbeState = {
  rttHistory: [] as number[],
  downlinkHistory: [] as number[],
  observedDownlinkMaxMbps: null as number | null,
};

function getNavigatorConnection(): any {
  const nav = navigator as any;
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

function readNativeConnectionSnapshot(conn = getNavigatorConnection()): NativeConnectionSnapshot {
  return {
    type: str(conn?.type),
    downlinkMbps: num(conn?.downlink),
    downlinkMaxMbps: num(conn?.downlinkMax),
    rttMs: num(conn?.rtt),
    saveData: typeof conn?.saveData === "boolean" ? conn.saveData : null,
  };
}

function hasNativeConnectionSignal(snapshot: NativeConnectionSnapshot): boolean {
  return snapshot.type !== null ||
    snapshot.downlinkMbps !== null ||
    snapshot.rttMs !== null;
}

function getReducedDataMediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia("(prefers-reduced-data: reduce)");
  } catch {
    return null;
  }
}

function readReducedDataPreference(): boolean | null {
  const mql = getReducedDataMediaQueryList();
  if (!mql) return null;
  return mql.matches;
}

function resolveSaveDataPreference(nativeSaveData: boolean | null): boolean | null {
  if (nativeSaveData !== null) return nativeSaveData;
  return readReducedDataPreference();
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function trimNumericHistory(values: number[], maxSize: number): void {
  while (values.length > maxSize) values.shift();
}

function resetConnectionProbeState(): void {
  connectionProbeState.rttHistory.length = 0;
  connectionProbeState.downlinkHistory.length = 0;
  connectionProbeState.observedDownlinkMaxMbps = null;
}

function rememberRttSample(rttMs: number): void {
  if (!Number.isFinite(rttMs) || rttMs <= 0) return;
  connectionProbeState.rttHistory.push(Math.max(1, roundTo(rttMs, 2)));
  trimNumericHistory(connectionProbeState.rttHistory, CONNECTION_RTT_HISTORY_SIZE);
}

function rememberDownlinkSample(downlinkMbps: number): void {
  if (!Number.isFinite(downlinkMbps) || downlinkMbps <= 0) return;
  const value = roundTo(downlinkMbps, 2);
  connectionProbeState.downlinkHistory.push(value);
  trimNumericHistory(connectionProbeState.downlinkHistory, CONNECTION_DOWNLINK_HISTORY_SIZE);
  connectionProbeState.observedDownlinkMaxMbps = connectionProbeState.observedDownlinkMaxMbps == null
    ? value
    : Math.max(connectionProbeState.observedDownlinkMaxMbps, value);
}

function smoothedRttMs(): number | null {
  const m = median(connectionProbeState.rttHistory);
  return m != null ? Math.max(1, Math.round(m)) : null;
}

function smoothedDownlinkMbps(): number | null {
  const m = median(connectionProbeState.downlinkHistory);
  return m != null ? roundTo(m, 2) : null;
}

function observedDownlinkMaxMbps(): number | null {
  if (connectionProbeState.observedDownlinkMaxMbps != null) {
    return roundTo(connectionProbeState.observedDownlinkMaxMbps, 2);
  }
  const fromHistory = connectionProbeState.downlinkHistory.length > 0
    ? Math.max(...connectionProbeState.downlinkHistory)
    : null;
  return fromHistory != null ? roundTo(fromHistory, 2) : null;
}

function classifyEffectiveType(
  rttMs: number | null,
  downlinkMbps: number | null,
): string | null {
  if (rttMs === null && downlinkMbps === null) return null;
  const rtt = rttMs ?? 0;
  const down = downlinkMbps ?? Number.POSITIVE_INFINITY;

  // Matches Chromium's coarse ECT buckets (slow-2g/2g/3g/4g) as closely as
  // possible from measured latency + throughput.
  if (down < 0.15 || rtt > 2000) return "slow-2g";
  if (down < 0.4 || rtt > 1400) return "2g";
  if (down < 0.75 || rtt > 270) return "3g";
  return "4g";
}

function inferConnectionType(
  downlinkMbps: number | null,
  rttMs: number | null,
  effectiveType: string | null,
): string | null {
  if (downlinkMbps === null && rttMs === null && effectiveType === null) return null;
  if (effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g") {
    return "cellular";
  }
  if (downlinkMbps !== null && downlinkMbps >= 30 && (rttMs === null || rttMs <= 80)) {
    return "ethernet";
  }
  if (downlinkMbps !== null && downlinkMbps >= 5 && (rttMs === null || rttMs <= 160)) {
    return "wifi";
  }
  return "unknown";
}

function buildProbeSnapshotFromState(): ConnectionProbeSnapshot | null {
  const rttMs = smoothedRttMs();
  const downlinkMbps = smoothedDownlinkMbps();
  const downlinkMaxMbps = observedDownlinkMaxMbps();
  const effectiveType = classifyEffectiveType(rttMs, downlinkMbps);
  const type = inferConnectionType(downlinkMbps, rttMs, effectiveType);

  if (
    type === null &&
    downlinkMbps === null &&
    downlinkMaxMbps === null &&
    rttMs === null
  ) {
    return null;
  }

  return {
    type,
    downlinkMbps,
    downlinkMaxMbps,
    rttMs,
  };
}

function annotateProbeDerivedPoint(
  point: DataPoint,
  stability: DetailStability = point.live ? "live" : "session",
): DataPoint {
  return {
    ...point,
    detailSource: "active probe",
    detailConfidence: "medium",
    detailStability: stability,
  };
}

function annotateMediaQueryDerivedPoint(point: DataPoint): DataPoint {
  return {
    ...point,
    detailSource: "media query",
    detailConfidence: "medium",
    detailStability: "stable",
  };
}

function selectConnectionPoint<T extends string | number>(
  value: T | null,
  options: {
    nativeHasValue: boolean;
    includePending: boolean;
    pendingPoint: () => DataPoint;
    nativePoint: (resolvedValue: T) => DataPoint;
    probePoint: (resolvedValue: T) => DataPoint;
  },
): DataPoint | null {
  if (value === null) {
    return options.includePending ? options.pendingPoint() : null;
  }
  return options.nativeHasValue ? options.nativePoint(value) : options.probePoint(value);
}

function buildConnectionPoints(
  native: NativeConnectionSnapshot,
  probe: ConnectionProbeSnapshot | null,
  options: ConnectionPointBuildOptions,
): DataPoint[] {
  const points: DataPoint[] = [];

  const typeValue = native.type ?? probe?.type ?? null;
  const downlinkValue = native.downlinkMbps ?? probe?.downlinkMbps ?? null;
  const downlinkMaxValue = native.downlinkMaxMbps ?? probe?.downlinkMaxMbps ?? downlinkValue;
  const rttValue = native.rttMs ?? probe?.rttMs ?? null;
  const saveDataValue = resolveSaveDataPreference(native.saveData);

  const typePoint = selectConnectionPoint(typeValue, {
    nativeHasValue: native.type !== null,
    includePending: options.includePending,
    pendingPoint: () => pendingPt("conn.type", "Connection Type", "measuring...", "Inferring connection medium from active fetch timing probes."),
    nativePoint: (resolvedValue) => pt("conn.type", "Connection Type", resolvedValue, "Physical medium - wifi, cellular, ethernet, bluetooth, etc."),
    probePoint: (resolvedValue) => annotateProbeDerivedPoint(
      pt("conn.type", "Connection Type", resolvedValue, "Inferred connection medium from active timing probes."),
      "session",
    ),
  });
  if (typePoint) points.push(typePoint);

  const downlinkPoint = selectConnectionPoint(
    downlinkValue != null ? roundTo(downlinkValue, 2) : null,
    {
      nativeHasValue: native.downlinkMbps !== null,
      includePending: options.includePending,
      pendingPoint: () => pendingPt("conn.downlink", "Downlink (Mbps)", "measuring...", "Measured from active same-origin transfer timings.", false, true),
      nativePoint: (resolvedValue) => pt("conn.downlink", "Downlink (Mbps)", resolvedValue, "Estimated downstream bandwidth.", false, true),
      probePoint: (resolvedValue) => annotateProbeDerivedPoint(
        pt("conn.downlink", "Downlink (Mbps)", resolvedValue, "Measured downstream throughput from active same-origin transfers.", false, true),
      ),
    },
  );
  if (downlinkPoint) points.push(downlinkPoint);

  const downlinkMaxPoint = selectConnectionPoint(
    downlinkMaxValue != null ? roundTo(downlinkMaxValue, 2) : null,
    {
      nativeHasValue: native.downlinkMaxMbps !== null,
      includePending: options.includePending,
      pendingPoint: () => pendingPt("conn.downlinkMax", "Max Downlink (Mbps)", "measuring...", "Highest observed downlink speed from active probe samples."),
      nativePoint: (resolvedValue) => pt("conn.downlinkMax", "Max Downlink (Mbps)", resolvedValue, "Maximum downlink speed of the current connection technology."),
      probePoint: (resolvedValue) => annotateProbeDerivedPoint(
        pt("conn.downlinkMax", "Max Downlink (Mbps)", resolvedValue, "Highest observed downlink throughput during this session."),
        "session",
      ),
    },
  );
  if (downlinkMaxPoint) points.push(downlinkMaxPoint);

  const rttPoint = selectConnectionPoint(
    rttValue != null ? Math.max(1, Math.round(rttValue)) : null,
    {
      nativeHasValue: native.rttMs !== null,
      includePending: options.includePending,
      pendingPoint: () => pendingPt("conn.rtt", "RTT (ms)", "measuring...", "Measured round-trip timing from active same-origin requests.", false, true),
      nativePoint: (resolvedValue) => pt("conn.rtt", "RTT (ms)", resolvedValue, "Estimated network round-trip time (general quality metric, not specific to this server).", false, true),
      probePoint: (resolvedValue) => annotateProbeDerivedPoint(
        pt("conn.rtt", "RTT (ms)", resolvedValue, "Measured network round-trip time from active same-origin probe requests.", false, true),
      ),
    },
  );
  if (rttPoint) points.push(rttPoint);

  if (saveDataValue !== null) {
    points.push(
      native.saveData !== null
        ? pt("conn.saveData", "Data Saver", saveDataValue, "Whether the user has requested reduced data usage.")
        : annotateMediaQueryDerivedPoint(
            pt("conn.saveData", "Data Saver", saveDataValue, "Reduced-data preference inferred from the prefers-reduced-data media query."),
          ),
    );
  } else if (options.includeUnavailableSaveData) {
    points.push(pt("conn.saveData", "Data Saver", null, "Whether the user has requested reduced data usage."));
  }

  return points;
}

async function fetchProbeSample(
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ durationMs: number; bytes: number } | null> {
  throwIfAborted(signal);
  const timedRequest = createTimedRequestContext(timeoutMs, signal);

  const sep = path.includes("?") ? "&" : "?";
  const probeUrl = `${path}${sep}mirror_probe=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const started = performance.now();

  try {
    const response = await fetch(probeUrl, {
      signal: timedRequest.requestSignal,
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return null;
    const body = await response.arrayBuffer();
    const durationMs = Math.max(1, performance.now() - started);
    return { durationMs, bytes: body.byteLength };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  } finally {
    timedRequest.cleanup();
  }
}

async function probeConnectionSnapshot(
  options: ConnectionProbeOptions = {},
): Promise<ConnectionProbeSnapshot | null> {
  const { signal, includeDownlink = true } = options;
  throwIfAborted(signal);
  if (!navigator.onLine) return null;

  const rttSamples: number[] = [];
  for (let i = 0; i < CONNECTION_RTT_SAMPLE_COUNT; i++) {
    throwIfAborted(signal);
    const sample = await fetchProbeSample(CONNECTION_RTT_PROBE_URL, CONNECTION_RTT_TIMEOUT_MS, signal);
    if (sample) rttSamples.push(sample.durationMs);
  }

  throwIfAborted(signal);

  const rttMedian = median(rttSamples);
  if (rttMedian != null) rememberRttSample(rttMedian);

  const downlinkSamples: number[] = [];
  if (includeDownlink) {
    for (let i = 0; i < CONNECTION_DOWNLINK_SAMPLE_COUNT; i++) {
      throwIfAborted(signal);
      const downlinkSample = await fetchProbeSample(
        CONNECTION_DOWNLINK_PROBE_URL,
        CONNECTION_DOWNLINK_TIMEOUT_MS,
        signal,
      );
      if (!downlinkSample) continue;
      const mbps = (downlinkSample.bytes * 8) / (downlinkSample.durationMs / 1000) / 1_000_000;
      if (Number.isFinite(mbps) && mbps > 0) {
        downlinkSamples.push(mbps);
      }
    }
    const downlinkMedian = median(downlinkSamples);
    if (downlinkMedian != null) rememberDownlinkSample(downlinkMedian);
  }

  return buildProbeSnapshotFromState();
}

function collectConnection(): DataPoint[] {
  const native = readNativeConnectionSnapshot();
  const probe = buildProbeSnapshotFromState();

  return [
    pt("conn.online", "Online", navigator.onLine, "Whether the browser currently has network access.", false, true),
    ...buildConnectionPoints(native, probe, {
      includePending: true,
      includeUnavailableSaveData: true,
    }),
  ];
}

async function collectConnectionAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const native = readNativeConnectionSnapshot();
  throwIfAborted(signal);

  let probe = buildProbeSnapshotFromState();
  try {
    probe = await probeConnectionSnapshot({ signal, includeDownlink: true }) ?? probe;
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  throwIfAborted(signal);

  return buildConnectionPoints(native, probe, {
    includePending: false,
    includeUnavailableSaveData: false,
  });
}

// 
// 3. BROWSER IDENTITY
// 

function collectBrowser(): DataPoint[] {
  const p: DataPoint[] = [];
  const ua = navigator.userAgent;
  const uad = (navigator as any).userAgentData;

  // Full user-agent
  p.push(pt("br.ua", "User-Agent", ua, "The full user-agent string sent with every HTTP request.", true, false, 4));

  // UA Client Hints brands
  if (uad?.brands) {
    const brands = uad.brands
      .filter((b: any) => !b.brand.includes("Not"))
      .map((b: any) => `${b.brand} ${b.version}`)
      .join(", ");
    p.push(pt("br.brands", "Brands (UA-CH)", brands || null, "Client Hints provide a cleaner browser identifier.", false, false, 3));
  } else {
    p.push(pt("br.brands", "Brands (UA-CH)", null, "User-Agent Client Hints not available in this browser."));
  }

  p.push(pt("br.mobile", "Mobile", uad?.mobile ?? null, "Whether the browser identifies as a mobile device.", false, false, 2));
  p.push(pt("br.platform", "Platform (UA-CH)", str(uad?.platform), "OS platform from Client Hints.", false, false, 2));

  // Privacy signals
  p.push(pt("br.cookieEnabled", "Cookies Enabled", navigator.cookieEnabled, "Whether the browser allows cookies."));
  p.push(pt("br.dnt", "Do Not Track", str((navigator as any).doNotTrack), "The DNT header value. This standard has been abandoned - Firefox and Safari have removed it.", false, false, 2));
  p.push(pt("br.gpc", "Global Privacy Control", (navigator as any).globalPrivacyControl ?? null, "Newer spec requesting sites not sell/share your data.", false, false, 2));

  // Language
  p.push(pt("br.language", "Primary Language", navigator.language, "Your browser's preferred language.", false, false, 3));
  p.push(pt("br.languages", "All Languages", navigator.languages?.join(", ") || null, "Full ordered preference list - highly fingerprintable.", true, false, 4));

  // Misc
  p.push(pt("br.pdfViewer", "PDF Viewer", (navigator as any).pdfViewerEnabled ?? null, "Whether the browser has a built-in PDF viewer."));
  p.push(pt("br.webdriver", "WebDriver", (navigator as any).webdriver ?? null, "True if the browser is controlled by automation (Selenium, Puppeteer).", false, false, 2));
  p.push(pt("br.maxTouchPoints", "Max Touch Points", num(navigator.maxTouchPoints), "Simultaneous touch contacts supported.", false, false, 2));

  return p;
}

async function collectBrowserAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);
  const uad = (navigator as any).userAgentData;
  if (!uad?.getHighEntropyValues) return p;

  try {
    const he = await uad.getHighEntropyValues([
      "architecture", "bitness", "model", "platformVersion", "fullVersionList", "wow64",
    ]);
    throwIfAborted(signal);
    p.push(pt("br.arch", "Architecture", str(he.architecture), "CPU architecture - x86, arm, etc.", false, false, 3));
    p.push(pt("br.bitness", "Bitness", str(he.bitness), "32-bit or 64-bit OS/CPU.", false, false, 2));
    p.push(pt("br.model", "Device Model", str(he.model), "Device model string - usually only populated on mobile.", true, false, 3));
    p.push(pt("br.platformVer", "Platform Version", str(he.platformVersion), "Detailed OS version from Client Hints.", false, false, 3));
    p.push(pt("br.wow64", "WoW64", he.wow64 ?? null, "Whether running a 32-bit browser on 64-bit Windows."));
    if (he.fullVersionList) {
      const list = he.fullVersionList
        .filter((b: any) => !b.brand.includes("Not"))
        .map((b: any) => `${b.brand} ${b.version}`)
        .join(", ");
      p.push(pt("br.fullVersions", "Full Version List", list || null, "Detailed browser version info from high-entropy Client Hints.", false, false, 3));
    }
  } catch {
    p.push(pt("br.arch", "Architecture", null, "High-entropy Client Hints denied by the browser."));
  }

  return p;
}

// 
// 4. DEVICE & HARDWARE
// 

function collectDevice(): DataPoint[] {
  const p: DataPoint[] = [];

  // Screen
  p.push(pt("hw.screenRes", "Screen Resolution", `${screen.width} x ${screen.height}`, "Screen resolution in CSS pixels.", false, false, 3));
  p.push(pt("hw.dpr", "Device Pixel Ratio", window.devicePixelRatio, "Physical pixels per CSS pixel (retina = 2+).", false, false, 3));
  p.push(pt("hw.colorDepth", "Color Depth", screen.colorDepth, "Bits per pixel for the screen."));
  p.push(pt("hw.pixelDepth", "Pixel Depth", screen.pixelDepth, "Bits per pixel of the screen buffer."));

  const orient = screen.orientation;
  p.push(pt("hw.orientation", "Screen Orientation", orient ? `${orient.type} (${orient.angle} deg)` : null, "Current orientation type and rotation angle."));
  p.push(pt("hw.isExtended", "Multi-Monitor", (screen as any).isExtended ?? null, "Whether the display extends across multiple monitors.", false, false, 2));
  p.push(pt("hw.availScreen", "Available Screen", `${screen.availWidth} x ${screen.availHeight}`, "Screen area minus OS chrome (taskbar, dock, etc.)."));

  // CPU & memory
  p.push(pt("hw.cores", "CPU Cores", num(navigator.hardwareConcurrency), "Logical CPU cores - used for fingerprinting.", true, false, 4));
  p.push(pt("hw.memory", "Device Memory",
    (navigator as any).deviceMemory != null ? `${(navigator as any).deviceMemory} GB` : null,
    "Approximate RAM, rounded to nearest power of 2 for privacy.", true, false, 3));

  // Touch
  p.push(pt("hw.touchSupport", "Touch Support", "ontouchstart" in window || navigator.maxTouchPoints > 0, "Whether the device reports touchscreen support. Desktop Chrome may report true even without a physical touchscreen.", false, false, 2));

  // Gamepads
  if (!navigator.getGamepads) {
    p.push(pt("hw.gamepads", "Gamepads", null, "Gamepad API not available."));
  } else {
    try {
      const gp = navigator.getGamepads();
      const names = gp ? Array.from(gp).filter(Boolean).map(g => g!.id) : [];
      p.push(pt("hw.gamepads", "Gamepads", names.length > 0 ? names.join(", ") : "none", "Connected game controllers and their IDs."));
    } catch {
      p.push(pt("hw.gamepads", "Gamepads", null, "Gamepad API query failed."));
    }
  }

  // Window & viewport
  p.push(pt("hw.viewportSize", "Viewport Size", `${window.innerWidth} x ${window.innerHeight}`, "Browser viewport dimensions.", false, true));
  p.push(pt("hw.windowSize", "Window Size",
    window.outerWidth > 0 || window.outerHeight > 0 ? `${window.outerWidth} x ${window.outerHeight}` : null,
    "Full browser window including toolbars."));
  p.push(pt("hw.windowPos", "Window Position", `(${window.screenX}, ${window.screenY})`, "Window position on screen - reveals monitor layout.", true, false, 2));

  const vv = window.visualViewport;
  if (vv) {
    p.push(pt("hw.vvSize", "Visual Viewport", `${Math.round(vv.width)} x ${Math.round(vv.height)}`, "The visible portion of the page after pinch-zoom."));
    p.push(pt("hw.vvScale", "Viewport Scale", vv.scale, "Current pinch-zoom scale factor.", false, true));
    p.push(pt("hw.vvOffset", "Viewport Offset", `(${Math.round(vv.offsetLeft)}, ${Math.round(vv.offsetTop)})`, "Offset of visual viewport from layout viewport."));
  }

  return p;
}

async function collectDeviceAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);

  // Battery
  try {
    if ("getBattery" in navigator) {
      const bat = await (navigator as any).getBattery();
      throwIfAborted(signal);
      p.push(pt("hw.batteryLevel", "Battery Level", `${Math.round(bat.level * 100)}%`, "Current battery charge level.", true, true, 3));
      p.push(pt("hw.batteryCharging", "Charging", bat.charging, "Whether the device is currently plugged in.", false, true));
      if (bat.chargingTime !== Infinity && bat.chargingTime > 0) {
        p.push(pt("hw.chargingTime", "Time to Full", `${Math.round(bat.chargingTime / 60)} min`, "Estimated time until fully charged.", false, true));
      }
      if (bat.dischargingTime !== Infinity && bat.dischargingTime > 0) {
        p.push(pt("hw.dischargingTime", "Time to Empty", `${Math.round(bat.dischargingTime / 60)} min`, "Estimated battery life remaining.", false, true));
      }
    } else {
      p.push(pt("hw.batteryLevel", "Battery Level", null, "Battery Status API not available (Firefox/Safari block this)."));
      p.push(pt("hw.batteryCharging", "Charging", null, "Battery Status API not available."));
    }
  } catch {
    p.push(pt("hw.batteryLevel", "Battery Level", null, "Battery Status API blocked."));
    p.push(pt("hw.batteryCharging", "Charging", null, "Battery Status API blocked."));
  }

  // Keyboard layout
  try {
    const kb = (navigator as any).keyboard;
    if (kb && typeof kb.getLayoutMap === "function") {
      const layoutMap = await kb.getLayoutMap();
      throwIfAborted(signal);
      const entries = Array.from(layoutMap.entries() as Iterable<[string, string]>);
      const sample = entries.slice(0, 12).map(([code, key]) => `${code}:${key}`).join(", ");
      p.push(pt("hw.keyboardLayout", "Keyboard Layout", `${entries.length} keys (${sample}...)`,
        "Physical key-to-character mapping reveals your keyboard layout and locale.", true, false, 3));
    } else {
      p.push(pt("hw.keyboardLayout", "Keyboard Layout", null, "Keyboard API not available."));
    }
  } catch {
    p.push(pt("hw.keyboardLayout", "Keyboard Layout", null, "Keyboard layout detection blocked."));
  }

  return p;
}

// 
// 5. GPU & GRAPHICS (deep WebGL fingerprint)
// 

function collectGPU(): DataPoint[] {
  const p: DataPoint[] = [];

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let version = 0;
  const canvas = document.createElement("canvas");

  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (gl) version = 2;
    else {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
      if (gl) version = 1;
    }
  } catch { /* no WebGL */ }

  p.push(pt("gpu.webglVersion", "WebGL Version", version > 0 ? `${version}.0` : null, "GPU-accelerated rendering API version."));
  p.push(pt("gpu.webgpu", "WebGPU", "gpu" in navigator, "Whether the WebGPU API is exposed. Does not guarantee a usable GPU adapter (requires secure context + supported hardware)."));
  p.push(pt("gpu.offscreen", "OffscreenCanvas", typeof OffscreenCanvas !== "undefined", "Canvas rendering in Web Workers."));

  if (!gl) return p;

  try {
    // Unmasked vendor/renderer
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      p.push(pt("gpu.vendor", "GPU Vendor", gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), "Graphics card manufacturer.", true, false, 4));
      p.push(pt("gpu.renderer", "GPU Renderer", gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL), "Exact graphics card model - extremely fingerprintable.", true, false, 5));
    } else {
      p.push(pt("gpu.vendor", "GPU Vendor", null, "WEBGL_debug_renderer_info blocked by browser."));
      p.push(pt("gpu.renderer", "GPU Renderer", null, "WEBGL_debug_renderer_info blocked by browser."));
    }

    // Masked vendor/renderer (always available)
    p.push(pt("gpu.glVendor", "GL Vendor", gl.getParameter(gl.VENDOR), "Masked WebGL vendor string."));
    p.push(pt("gpu.glRenderer", "GL Renderer", gl.getParameter(gl.RENDERER), "Masked WebGL renderer string."));
    p.push(pt("gpu.glVersion", "GL Version", gl.getParameter(gl.VERSION), "WebGL version string."));
    p.push(pt("gpu.glslVersion", "GLSL Version", gl.getParameter(gl.SHADING_LANGUAGE_VERSION), "Shader language version."));

    // Limits
    p.push(pt("gpu.maxTextureSize", "Max Texture Size", gl.getParameter(gl.MAX_TEXTURE_SIZE), "Maximum texture dimension in pixels.", false, false, 2));
    p.push(pt("gpu.maxCubeMapSize", "Max Cube Map Size", gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE), "Maximum cube map texture dimension."));
    p.push(pt("gpu.maxRenderBufSize", "Max Renderbuffer Size", gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), "Maximum renderbuffer dimension."));
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    p.push(pt("gpu.maxViewport", "Max Viewport", vp ? `${vp[0]} x ${vp[1]}` : null, "Maximum viewport dimensions."));
    p.push(pt("gpu.maxVertexAttribs", "Max Vertex Attribs", gl.getParameter(gl.MAX_VERTEX_ATTRIBS), "Maximum number of vertex attributes."));
    p.push(pt("gpu.maxVertexUniforms", "Max Vertex Uniforms", gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS), "Maximum vertex shader uniform vectors."));
    p.push(pt("gpu.maxFragUniforms", "Max Fragment Uniforms", gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS), "Maximum fragment shader uniform vectors."));
    p.push(pt("gpu.maxVaryings", "Max Varyings", gl.getParameter(gl.MAX_VARYING_VECTORS), "Maximum varying vectors between shaders."));
    p.push(pt("gpu.maxVertexTexUnits", "Max Vertex Tex Units", gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), "Texture units available in vertex shader."));
    p.push(pt("gpu.maxTexUnits", "Max Tex Units", gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), "Texture units available in fragment shader."));
    p.push(pt("gpu.maxCombinedTexUnits", "Max Combined Tex Units", gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS), "Total texture units across all shaders."));

    // Buffer bit depths
    p.push(pt("gpu.redBits", "Red Bits", gl.getParameter(gl.RED_BITS), "Red channel bit depth of the drawing buffer."));
    p.push(pt("gpu.greenBits", "Green Bits", gl.getParameter(gl.GREEN_BITS), "Green channel bit depth."));
    p.push(pt("gpu.blueBits", "Blue Bits", gl.getParameter(gl.BLUE_BITS), "Blue channel bit depth."));
    p.push(pt("gpu.alphaBits", "Alpha Bits", gl.getParameter(gl.ALPHA_BITS), "Alpha channel bit depth."));
    p.push(pt("gpu.depthBits", "Depth Bits", gl.getParameter(gl.DEPTH_BITS), "Depth buffer bit depth."));
    p.push(pt("gpu.stencilBits", "Stencil Bits", gl.getParameter(gl.STENCIL_BITS), "Stencil buffer bit depth."));

    // Aliased ranges
    const lw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    p.push(pt("gpu.lineWidthRange", "Line Width Range", lw ? `${lw[0]}-${lw[1]}` : null, "Supported GL line width range."));
    const ps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    p.push(pt("gpu.pointSizeRange", "Point Size Range", ps ? `${ps[0]}-${ps[1]}` : null, "Supported GL point size range."));

    // WebGL2-specific
    if (version === 2) {
      const gl2 = gl as WebGL2RenderingContext;
      p.push(pt("gpu.max3dTexSize", "Max 3D Texture Size", gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE), "Maximum 3D texture dimension."));
      p.push(pt("gpu.maxArrayTexLayers", "Max Array Tex Layers", gl2.getParameter(gl2.MAX_ARRAY_TEXTURE_LAYERS), "Maximum texture array layers."));
      p.push(pt("gpu.maxDrawBuffers", "Max Draw Buffers", gl2.getParameter(gl2.MAX_DRAW_BUFFERS), "Maximum simultaneous render targets."));
      p.push(pt("gpu.maxColorAttach", "Max Color Attachments", gl2.getParameter(gl2.MAX_COLOR_ATTACHMENTS), "Maximum framebuffer color attachments."));
      p.push(pt("gpu.maxSamples", "Max Samples", gl2.getParameter(gl2.MAX_SAMPLES), "Maximum MSAA samples."));
      p.push(pt("gpu.maxUBOBindings", "Max UBO Bindings", gl2.getParameter(gl2.MAX_UNIFORM_BUFFER_BINDINGS), "Maximum uniform buffer object bindings."));
      p.push(pt("gpu.maxTFAttribs", "Max TF Attribs", gl2.getParameter(gl2.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS), "Maximum transform feedback attributes."));
      p.push(pt("gpu.maxElementIndex", "Max Element Index", gl2.getParameter(gl2.MAX_ELEMENT_INDEX), "Maximum element index value."));
    }

    // Shader precision
    try {
      const precisions: string[] = [];
      for (const [sType, sName] of [[gl.VERTEX_SHADER, "V"], [gl.FRAGMENT_SHADER, "F"]] as const) {
        for (const [pType, pName] of [[gl.HIGH_FLOAT, "highF"], [gl.MEDIUM_FLOAT, "medF"], [gl.LOW_FLOAT, "lowF"], [gl.HIGH_INT, "highI"], [gl.MEDIUM_INT, "medI"], [gl.LOW_INT, "lowI"]] as const) {
          const fmt = gl.getShaderPrecisionFormat(sType, pType);
          if (fmt) precisions.push(`${sName}.${pName}:${fmt.precision}/${fmt.rangeMin}-${fmt.rangeMax}`);
        }
      }
      p.push(pt("gpu.shaderPrecision", "Shader Precision", precisions.join(", "), "Precision format for each shader stage - differs across GPUs.", false, false, 3));
    } catch { /* skip */ }

    // Extensions
    const exts = gl.getSupportedExtensions();
    p.push(pt("gpu.extensions", "Extensions", exts ? `${exts.length} supported` : null, "Number of WebGL extensions available.", false, false, 3));
    p.push(pt("gpu.extensionsList", "Extension List", exts?.join(", ") || null, "Full list of supported WebGL extensions - highly fingerprintable.", true, false, 4));
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return p;
}

// 
// 6. OS & PREFERENCES
// 

function collectOS(): DataPoint[] {
  const p: DataPoint[] = [];
  const mq = (q: string): boolean | null => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return null;
    }
  };

  const mqEnum = (variants: Array<{ query: string; value: string }>): string | null => {
    for (const variant of variants) {
      if (mq(variant.query) === true) return variant.value;
    }
    return null;
  };

  const mqBoolean = (trueQuery: string, falseQuery: string): boolean | null => {
    if (mq(trueQuery) === true) return true;
    if (mq(falseQuery) === true) return false;
    return null;
  };

  p.push(pt("os.colorScheme", "Color Scheme",
    mqEnum([
      { query: "(prefers-color-scheme: dark)", value: "dark" },
      { query: "(prefers-color-scheme: light)", value: "light" },
      { query: "(prefers-color-scheme: no-preference)", value: "no preference" },
    ]),
    "Your system light/dark color-scheme preference.", false, false, 3));

  p.push(pt("os.reducedMotion", "Reduced Motion",
    mqBoolean("(prefers-reduced-motion: reduce)", "(prefers-reduced-motion: no-preference)"),
    "Whether you've enabled reduced animations."));

  p.push(pt("os.reducedTransparency", "Reduced Transparency",
    mqBoolean("(prefers-reduced-transparency: reduce)", "(prefers-reduced-transparency: no-preference)"),
    "Whether transparency effects are reduced."));

  p.push(pt("os.reducedData", "Reduced Data",
    mqBoolean("(prefers-reduced-data: reduce)", "(prefers-reduced-data: no-preference)"),
    "Whether the user prefers less data usage."));

  p.push(pt("os.forcedColors", "Forced Colors",
    mqBoolean("(forced-colors: active)", "(forced-colors: none)"),
    "Whether the OS is overriding colors (high-contrast mode)."));

  p.push(pt("os.prefersContrast", "Prefers Contrast",
    mqEnum([
      { query: "(prefers-contrast: more)", value: "more" },
      { query: "(prefers-contrast: less)", value: "less" },
      { query: "(prefers-contrast: custom)", value: "custom" },
      { query: "(prefers-contrast: no-preference)", value: "no preference" },
    ]),
    "Contrast preference setting."));

  p.push(pt("os.colorGamut", "Color Gamut",
    mqEnum([
      { query: "(color-gamut: rec2020)", value: "rec2020" },
      { query: "(color-gamut: p3)", value: "p3" },
      { query: "(color-gamut: srgb)", value: "srgb" },
    ]),
    "Widest display color gamut reported by media queries.", false, false, 2));

  p.push(pt("os.hdr", "HDR Display",
    mqBoolean("(dynamic-range: high)", "(dynamic-range: standard)"),
    "Whether your display reports High Dynamic Range support."));

  p.push(pt("os.pointerPrimary", "Primary Pointer",
    mqEnum([
      { query: "(pointer: fine)", value: "fine (mouse)" },
      { query: "(pointer: coarse)", value: "coarse (touch)" },
      { query: "(pointer: none)", value: "none" },
    ]),
    "Primary pointing device precision.", false, false, 2));

  const anyParts: string[] = [];
  if (mq("(any-pointer: fine)") === true) anyParts.push("fine");
  if (mq("(any-pointer: coarse)") === true) anyParts.push("coarse");
  const anyPointer = anyParts.length > 0
    ? anyParts.join(" + ")
    : mq("(any-pointer: none)") === true
      ? "none"
      : null;
  p.push(pt("os.pointerAny", "Any Pointer", anyPointer, "All pointer types among connected inputs."));

  p.push(pt("os.hoverPrimary", "Primary Hover",
    mqBoolean("(hover: hover)", "(hover: none)"),
    "Whether the primary input can hover."));

  p.push(pt("os.hoverAny", "Any Hover",
    mqBoolean("(any-hover: hover)", "(any-hover: none)"),
    "Whether any connected input can hover."));

  p.push(pt("os.invertedColors", "Inverted Colors",
    mqBoolean("(inverted-colors: inverted)", "(inverted-colors: none)"),
    "Whether display colors are inverted."));

  p.push(pt("os.displayMode", "Display Mode",
    mqEnum([
      { query: "(display-mode: standalone)", value: "standalone" },
      { query: "(display-mode: fullscreen)", value: "fullscreen" },
      { query: "(display-mode: minimal-ui)", value: "minimal-ui" },
      { query: "(display-mode: browser)", value: "browser" },
    ]),
    "Whether the page is running as an installed PWA or in a normal browser tab.", false, false, 2));

  p.push(pt("os.mqOrientation", "Media Orientation",
    mqEnum([
      { query: "(orientation: portrait)", value: "portrait" },
      { query: "(orientation: landscape)", value: "landscape" },
    ]),
    "Current media query orientation."));

  return p;
}

// 
// 7. FINGERPRINTS (Canvas, Audio, Math, WebGL hash, Fonts, Timer precision)
// 

function collectFingerprints(): DataPoint[] {
  const p: DataPoint[] = [];

  //  Canvas fingerprint 
  try {
    const c = document.createElement("canvas");
    c.width = 280;
    c.height = 60;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.textBaseline = "top";
      // Rect
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      // Text with different fonts and blending
      ctx.font = "14px Arial";
      ctx.fillStyle = "#069";
      ctx.fillText("woflo.dev \u{1f30d}", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("woflo.dev \u{1f30d}", 4, 17);
      // Arc
      ctx.beginPath();
      ctx.arc(50, 50, 10, 0, Math.PI * 2);
      ctx.fillStyle = "#f0f";
      ctx.fill();
      // Gradient
      const grad = ctx.createLinearGradient(0, 0, 280, 0);
      grad.addColorStop(0, "#00f");
      grad.addColorStop(1, "#0ff");
      ctx.fillStyle = grad;
      ctx.fillRect(200, 30, 80, 20);

      const dataUrl = c.toDataURL();
      p.push(pt("fp.canvasHash", "Canvas Fingerprint", fnv1a(dataUrl),
        "A hash of how your browser renders shapes, text, and gradients. Varies across devices/browsers - a primary tracking vector.", true, false, 5));
      // Store the preview as a separate point (UI renders it as an image)
      p.push(pt("fp.canvasPreview", "Canvas Preview", dataUrl,
        "The actual canvas rendering used for the fingerprint. What the tracker sees.", true, false, 1));
    }
  } catch {
    p.push(pt("fp.canvasHash", "Canvas Fingerprint", null, "Canvas fingerprinting blocked."));
  }

  //  Audio fingerprint 
  try {
    const actx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      p.push(pt("fp.audioSampleRate", "Audio Sample Rate", `${actx.sampleRate} Hz`, "Default sample rate - differs across devices.", false, false, 2));
      p.push(pt("fp.audioBaseLatency", "Audio Base Latency",
        (actx as any).baseLatency != null ? `${((actx as any).baseLatency * 1000).toFixed(2)} ms` : null,
        "Minimum audio processing latency."));
      p.push(pt("fp.audioOutputLatency", "Audio Output Latency",
        (actx as any).outputLatency != null ? `${((actx as any).outputLatency * 1000).toFixed(2)} ms` : null,
        "Output audio latency estimate."));
      p.push(pt("fp.audioChannels", "Audio Max Channels", num(actx.destination.maxChannelCount), "Maximum audio output channels (stereo=2, surround=6+).", false, false, 2));
    } finally {
      actx.close();
    }
  } catch {
    p.push(pt("fp.audioSampleRate", "Audio Sample Rate", null, "AudioContext not available."));
  }

  //  Math engine fingerprint 
  // These edge-case calculations give different results across JS engines (V8 vs SpiderMonkey vs JSC)
  try {
    const mathVals = [
      Math.tan(-1e300),    // Very engine-dependent!
      Math.cos(21),        // Slight variation
      Math.sin(1),
      Math.atan2(1, 2),
      Math.expm1(1),
      Math.cbrt(2),
      Math.log1p(0.5),
      Math.sinh(1),
      Math.tanh(1),
    ].map(v => v.toString()).join(",");
    p.push(pt("fp.mathHash", "Math Engine Hash", fnv1a(mathVals),
      "Hash of edge-case math operations. Different JS engines (V8, SpiderMonkey, JSC) produce subtly different floating-point results.", true, false, 3));
    p.push(pt("fp.tanTest", "Math.tan(-1e300)", Math.tan(-1e300).toString(),
      "This single calculation famously gives different results in Chrome vs Firefox vs Safari."));
  } catch {
    p.push(pt("fp.mathHash", "Math Engine Hash", null, "Math operations failed."));
  }

  //  Timer precision 
  // Browsers add noise to performance.now() to mitigate Spectre. Measuring the precision reveals which browser.
  try {
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 10000 && deltas.length < 100; i++) {
      const now = performance.now();
      if (now !== last) {
        deltas.push(now - last);
        last = now;
      }
    }
    const precision = deltas.length > 0 ? Math.min(...deltas) : 0;
    p.push(pt("fp.timerPrecision", "Timer Precision", `${precision.toFixed(3)} ms`,
      "Minimum resolution of performance.now(). Browsers add noise to prevent timing attacks. Firefox rounds to ~1ms, Chrome gives ~5us.", false, false, 3));
  } catch {
    p.push(pt("fp.timerPrecision", "Timer Precision", null, "Could not measure."));
  }

  //  Font detection 
  // Classic technique: measure text width with a fallback font, then test if width changes with a named font.
  try {
    const testFonts = [
      // Windows
      "Segoe UI", "Calibri", "Cambria", "Consolas", "Candara", "Constantia", "Corbel",
      "Palatino Linotype", "Franklin Gothic Medium", "Lucida Sans Unicode",
      "MS Gothic", "Meiryo", "Yu Gothic", "Malgun Gothic", "Microsoft YaHei",
      "Gabriola", "Ink Free", "Cascadia Code", "Cascadia Mono",
      // macOS
      "Helvetica Neue", "Avenir", "Avenir Next", "Futura", "Optima",
      "Baskerville", "Didot", "Gill Sans", "Hoefler Text", "Menlo", "Monaco",
      "American Typewriter", "Apple Color Emoji", "SF Pro", "SF Mono", "Phosphate",
      // Linux
      "Ubuntu", "DejaVu Sans", "Liberation Sans", "Noto Sans", "Cantarell",
      "Droid Sans", "FreeSans",
      // Cross-platform
      "Arial", "Verdana", "Helvetica", "Times New Roman", "Georgia",
      "Courier New", "Comic Sans MS", "Impact", "Tahoma", "Trebuchet MS",
      "Palatino", "Garamond", "Century Gothic", "Lucida Console", "Arial Black",
      "Copperplate", "Rockwell", "Brush Script MT", "Papyrus", "Bookman Old Style",
      "Bodoni MT",
    ];

    const testString = "mmmmmmmmmmlli1|WwQq@#";
    const baseFonts = ["monospace", "sans-serif", "serif"];

    // Get baseline measurements
    const span = document.createElement("span");
    span.style.cssText = "position:absolute;top:-9999px;left:-9999px;font-size:72px;visibility:hidden";
    span.textContent = testString;
    document.body.appendChild(span);

    let detected: string[];
    try {
      const baselines = new Map<string, number>();
      for (const base of baseFonts) {
        span.style.fontFamily = base;
        baselines.set(base, span.offsetWidth);
      }

      detected = [];
      for (const font of testFonts) {
        let found = false;
        for (const base of baseFonts) {
          span.style.fontFamily = `"${font}", ${base}`;
          if (span.offsetWidth !== baselines.get(base)) {
            found = true;
            break;
          }
        }
        if (found) detected.push(font);
      }
    } finally {
      span.remove();
    }

    p.push(pt("fp.installedFonts", "Installed Fonts", `${detected.length} / ${testFonts.length} detected`,
      "Fonts detected by measuring text rendering - reveals your OS and installed software.", true, false, 5));
    p.push(pt("fp.fontList", "Font List", detected.join(", ") || "none detected",
      "The specific fonts found on your system. This list is highly unique across devices.", true, false, 5));
  } catch {
    p.push(pt("fp.installedFonts", "Installed Fonts", null, "Font detection failed."));
  }

  //  Error stack format (reveals engine)
  try {
    const err = new Error("test");
    const stackSample = err.stack?.split("\n").slice(0, 2).join(" | ") || null;
    p.push(pt("fp.errorFormat", "Error Stack Format", stackSample, "How the browser formats error stacks - differs between Chrome, Firefox, and Safari."));
  } catch {
    p.push(pt("fp.errorFormat", "Error Stack Format", null, "Could not capture."));
  }

  //  CSS @supports fingerprint
  // Probe a set of CSS features; the support profile differs per browser/version.
  try {
    const cssFeatures = [
      "display: grid", "display: subgrid", "display: flex",
      "container-type: inline-size", "contain: paint",
      "color: oklch(0.5 0.2 240)", "color: color-mix(in srgb, red, blue)",
      "color: light-dark(black, white)",
      "accent-color: auto", "field-sizing: content",
      "anchor-name: --a", "position-anchor: --a",
      "text-wrap: balance", "text-wrap: pretty",
      "font-size: 1cap", "font-size: 1rex",
      "view-transition-name: x",
      "animation-timeline: scroll()", "scroll-timeline-name: --s",
      "offset-path: circle(50%)",
      "backdrop-filter: blur(1px)", "filter: blur(1px)",
      "overscroll-behavior: contain",
      "touch-action: manipulation",
      "content-visibility: auto",
      "overflow: clip",
      "text-decoration-thickness: from-font",
      "hanging-punctuation: first",
      "math-style: normal",
      "mask-image: none",
      "writing-mode: vertical-rl",
      "user-select: none",
    ];
    const supported = cssFeatures.filter(f => {
      try { return CSS.supports(f); } catch { return false; }
    });
    p.push(pt("fp.cssSupport", "CSS Support Hash", fnv1a(supported.join(",")),
      `Hash of ${supported.length}/${cssFeatures.length} supported CSS features. Differs across browsers and versions.`, false, false, 4));
  } catch {
    p.push(pt("fp.cssSupport", "CSS Support Hash", null, "CSS.supports() not available."));
  }

  //  Window property count (global API surface)
  // The set of enumerable window properties is browser/version-specific.
  try {
    const keys = Object.getOwnPropertyNames(window);
    p.push(pt("fp.windowProps", "Window Properties", keys.length,
      "Number of global properties on the window object. Varies by browser, version, and extensions.", false, false, 3));
  } catch {
    p.push(pt("fp.windowProps", "Window Properties", null, "Could not enumerate."));
  }

  //  System font fingerprint
  // Measure the default system font metrics — differs across OS, locale, and font config.
  try {
    const span = document.createElement("span");
    span.style.cssText = "position:absolute;top:-9999px;left:-9999px;visibility:hidden;font-size:72px";
    span.textContent = "mmmmmmmmmmlli1|WwQq@#";
    const systemFonts = ["system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy"];
    const widths: string[] = [];
    document.body.appendChild(span);
    try {
      for (const f of systemFonts) {
        span.style.fontFamily = f;
        widths.push(`${f}:${span.offsetWidth}x${span.offsetHeight}`);
      }
    } finally {
      span.remove();
    }
    p.push(pt("fp.systemFonts", "System Font Metrics", fnv1a(widths.join(",")),
      "Hash of default system font rendering widths. Different OSes and font configs produce different metrics.", false, false, 3));
  } catch {
    p.push(pt("fp.systemFonts", "System Font Metrics", null, "Could not measure."));
  }

  return p;
}

// 
// 8. MEDIA & CODECS
// 

function collectMedia(): DataPoint[] {
  const p: DataPoint[] = [];
  const canProbeMediaSource =
    typeof MediaSource !== "undefined" &&
    typeof MediaSource.isTypeSupported === "function";
  const isTypeSupported = (mime: string) => canProbeMediaSource && MediaSource.isTypeSupported(mime);
  const supportedCodecNames = (codecs: Array<[string, string]>): string[] =>
    codecs
      .filter(([, mime]) => {
        try {
          return isTypeSupported(mime);
        } catch {
          return false;
        }
      })
      .map(([name]) => name);
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;

  // Video codecs
  const videoCodecs: [string, string][] = [
    ["H.264 (AVC)", 'video/mp4; codecs="avc1.42E01E"'],
    ["H.264 High", 'video/mp4; codecs="avc1.640028"'],
    ["H.265 (HEVC)", 'video/mp4; codecs="hev1.1.6.L93.B0"'],
    ["VP8", 'video/webm; codecs="vp8"'],
    ["VP9", 'video/webm; codecs="vp9"'],
    ["VP9 Profile 2", 'video/webm; codecs="vp09.02.10.10.01.09.16.09.01"'],
    ["AV1", 'video/mp4; codecs="av01.0.01M.08"'],
    ["Theora", 'video/ogg; codecs="theora"'],
  ];
  const videoSupported = supportedCodecNames(videoCodecs);
  p.push(pt("media.videoCodecs", "Video Codecs (MSE)", videoSupported.join(", ") || "none via MSE", "Video codecs supported through MediaSource Extensions. Browsers may still play these natively without MSE.", false, false, 3));

  // Audio codecs
  const audioCodecs: [string, string][] = [
    ["AAC", 'audio/mp4; codecs="mp4a.40.2"'],
    ["AAC-HE", 'audio/mp4; codecs="mp4a.40.5"'],
    ["Opus", 'audio/webm; codecs="opus"'],
    ["Vorbis", 'audio/webm; codecs="vorbis"'],
    ["FLAC", 'audio/mp4; codecs="flac"'],
    ["MP3", 'audio/mpeg'],
    ["AC-3", 'audio/mp4; codecs="ac-3"'],
    ["E-AC-3", 'audio/mp4; codecs="ec-3"'],
  ];
  const audioSupported = supportedCodecNames(audioCodecs);
  p.push(pt("media.audioCodecs", "Audio Codecs (MSE)", audioSupported.join(", ") || "none via MSE", "Audio codecs supported through MediaSource Extensions. Browsers may still play these natively without MSE.", false, false, 3));

  // Image format support (via canvas toDataURL)
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    p.push(pt("media.webp", "WebP Encode", c.toDataURL("image/webp").startsWith("data:image/webp"), "Whether the canvas can encode to WebP format."));
    p.push(pt("media.avif", "AVIF Encode", c.toDataURL("image/avif").startsWith("data:image/avif"), "Whether the canvas can encode to AVIF format."));
    p.push(pt("media.jpeg", "JPEG Encode", c.toDataURL("image/jpeg").startsWith("data:image/jpeg"), "Whether the canvas can encode to JPEG."));
    p.push(pt("media.png", "PNG Encode", c.toDataURL("image/png").startsWith("data:image/png"), "Whether the canvas can encode to PNG."));
  } catch { /* canvas not available */ }

  // MediaSource
  p.push(pt("media.mediaSource", "MediaSource", typeof MediaSource !== "undefined", "Media Source Extensions for adaptive streaming."));
  p.push(pt("media.mediaRecorder", "MediaRecorder", typeof MediaRecorder !== "undefined", "Screen/audio/video recording API."));
  p.push(pt("media.mediaSession", "MediaSession", "mediaSession" in navigator, "Control media playback notifications and hardware media keys."));

  // Speech synthesis (voices reveal locale and OS)
  if (!synth || typeof synth.getVoices !== "function") {
    p.push(pt("media.voiceCount", "Speech Voices", null, "Speech Synthesis API not available."));
  } else {
    try {
      const voices = synth.getVoices();
      if (voices.length > 0) {
        p.push(pt("media.voiceCount", "Speech Voices", voices.length, "Text-to-speech voices - reveals installed languages and OS.", false, false, 3));
        const langs = [...new Set(voices.map(v => v.lang))].sort();
        p.push(pt("media.voiceLangs", "Voice Languages", langs.join(", "), "Languages available for text-to-speech."));
      } else {
        p.push(pendingPt("media.voiceCount", "Speech Voices", null, "Voice list is still loading; some browsers populate it asynchronously.", false, false, 3));
      }
    } catch {
      p.push(pt("media.voiceCount", "Speech Voices", null, "Speech Synthesis API blocked."));
    }
  }

  return p;
}

async function collectMediaAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  const pushMediaDeviceUnavailable = (reason: string): void => {
    p.push(pt("media.cameras", "Cameras", null, reason));
    p.push(pt("media.microphones", "Microphones", null, reason));
    p.push(pt("media.speakers", "Audio Outputs", null, reason));
  };
  const pushMediaDeviceCount = (
    id: string,
    label: string,
    value: number,
    redacted: boolean,
    unavailableMessage: string,
    availableMessage: string,
    weight = 1,
  ): void => {
    p.push(pt(
      id,
      label,
      redacted ? null : value,
      redacted ? unavailableMessage : availableMessage,
      false,
      false,
      weight,
    ));
  };

  const permissionState = async (
    name: "camera" | "microphone",
  ): Promise<PermissionState | null> => {
    try {
      if (!navigator.permissions?.query) return null;
      const result = await navigator.permissions.query({ name: name as PermissionName });
      return result.state;
    } catch {
      return null;
    }
  };

  // Media devices (count per kind, but some browsers redact until permission)
  try {
    if (!navigator.mediaDevices?.enumerateDevices) {
      pushMediaDeviceUnavailable("MediaDevices enumeration API not available in this browser.");
    } else {
      const [cameraPerm, micPerm] = await Promise.all([
        permissionState("camera"),
        permissionState("microphone"),
      ]);
      throwIfAborted(signal);

      const devices = await navigator.mediaDevices.enumerateDevices();
      throwIfAborted(signal);
      const cameras = devices.filter(d => d.kind === "videoinput").length;
      const mics = devices.filter(d => d.kind === "audioinput").length;
      const speakers = devices.filter(d => d.kind === "audiooutput").length;
      const allZero = cameras === 0 && mics === 0 && speakers === 0;

      const camerasUnknown = allZero && cameraPerm !== "granted";
      const micsUnknown = allZero && micPerm !== "granted";
      const speakersUnknown = allZero && cameraPerm !== "granted" && micPerm !== "granted";

      pushMediaDeviceCount(
        "media.cameras",
        "Cameras",
        cameras,
        camerasUnknown,
        "Camera count is unavailable until media permissions reveal the device list in this browser.",
        "Video input devices currently visible to the browser.",
        2,
      );

      pushMediaDeviceCount(
        "media.microphones",
        "Microphones",
        mics,
        micsUnknown,
        "Microphone count is unavailable until media permissions reveal the device list in this browser.",
        "Audio input devices currently visible to the browser.",
        2,
      );

      pushMediaDeviceCount(
        "media.speakers",
        "Audio Outputs",
        speakers,
        speakersUnknown,
        "Audio output count is unavailable because the browser is redacting the media device list.",
        "Audio output devices currently visible to the browser.",
      );
    }
  } catch {
    pushMediaDeviceUnavailable("MediaDevices API blocked.");
  }

  // DRM / Encrypted Media Extensions
  try {
    const reqMKSA = (navigator as any).requestMediaKeySystemAccess;
    if (typeof reqMKSA === "function") {
      const keySystems: [string, string][] = [
        ["Widevine", "com.widevine.alpha"],
        ["PlayReady", "com.microsoft.playready"],
        ["FairPlay", "com.apple.fps"],
        ["ClearKey", "org.w3.clearkey"],
      ];
      const detected: string[] = [];
      for (const [name, ks] of keySystems) {
        try {
          await reqMKSA.call(navigator, ks, [{
            initDataTypes: ["cenc"],
            videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
          }]);
          detected.push(name);
        } catch { /* key system not supported */ }
      }
      throwIfAborted(signal);
      p.push(pt("media.drm", "DRM Key Systems", detected.length > 0 ? detected.join(", ") : "none detected",
        "Encrypted Media Extensions - reveals which DRM systems are available. Differs by OS and browser.", false, false, 3));
    } else {
      p.push(pt("media.drm", "DRM Key Systems", null, "Encrypted Media Extensions not available."));
    }
  } catch {
    p.push(pt("media.drm", "DRM Key Systems", null, "EME detection failed."));
  }

  // Media Capabilities (codec power efficiency)
  try {
    const mc = (navigator as any).mediaCapabilities;
    if (mc && typeof mc.decodingInfo === "function") {
      const result = await mc.decodingInfo({
        type: "file",
        video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 },
      });
      throwIfAborted(signal);
      const parts: string[] = [];
      if (result.supported) parts.push("supported");
      if (result.smooth) parts.push("smooth");
      if (result.powerEfficient) parts.push("power efficient");
      p.push(pt("media.capabilities", "H.264 Decode Info", parts.join(", ") || "not supported",
        "Media Capabilities API reveals codec performance characteristics - smooth playback and power efficiency.", false, false, 2));
    } else {
      p.push(pt("media.capabilities", "H.264 Decode Info", null, "Media Capabilities API not available."));
    }
  } catch {
    p.push(pt("media.capabilities", "H.264 Decode Info", null, "Media Capabilities query failed."));
  }

  // Voices (async re-try  some browsers load voices lazily)
  try {
    if (synth && synth.getVoices().length === 0) {
      const voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
        let settled = false;
        const finish = (voicesList: SpeechSynthesisVoice[]) => {
          if (settled) return;
          settled = true;
          if (typeof synth.removeEventListener === "function") {
            synth.removeEventListener("voiceschanged", check);
          }
          clearTimeout(timeoutId);
          resolve(voicesList);
        };
        const check = () => {
          const v = synth.getVoices();
          if (v.length > 0) finish(v);
        };
        const timeoutId = setTimeout(() => finish(synth.getVoices()), 2000);
        if (typeof synth.addEventListener === "function") {
          synth.addEventListener("voiceschanged", check);
        }
      });
      throwIfAborted(signal);
      if (voices.length > 0) {
        p.push(pt("media.voiceCount", "Speech Voices", voices.length, "Text-to-speech voices (loaded async).", false, false, 3));
        const langs = [...new Set(voices.map(v => v.lang))].sort();
        p.push(pt("media.voiceLangs", "Voice Languages", langs.join(", "), "Languages available for text-to-speech."));
      } else {
        p.push(pt("media.voiceCount", "Speech Voices", 0, "Speech Synthesis is available but no voices were reported after async probe.", false, false, 3));
      }
    }
  } catch { /* speechSynthesis issues */ }

  return p;
}

// 
// 9. STORAGE
// 

function collectStorage(): DataPoint[] {
  const p: DataPoint[] = [];

  // localStorage
  let lsOk = false;
  try { const k = "__m"; localStorage.setItem(k, "1"); localStorage.removeItem(k); lsOk = true; } catch {}
  p.push(pt("st.localStorage", "localStorage", lsOk, "Client-side key-value storage for this origin."));
  if (lsOk) {
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) bytes += (k.length + (localStorage.getItem(k)?.length ?? 0)) * 2;
    }
    p.push(pt("st.localStorageItems", "localStorage Items", localStorage.length, "Number of key-value pairs stored on this origin."));
    p.push(pt("st.localStorageUsed", "localStorage Used", `${(bytes / 1024).toFixed(1)} KB`, "Approximate data stored by this site."));
  }

  // sessionStorage
  let ssOk = false;
  try { const k = "__m"; sessionStorage.setItem(k, "1"); sessionStorage.removeItem(k); ssOk = true; } catch {}
  p.push(pt("st.sessionStorage", "sessionStorage", ssOk, "Per-tab storage that clears when the tab closes."));

  // Cookies
  p.push(pt("st.cookiesEnabled", "Cookies Enabled", navigator.cookieEnabled, "Whether the browser accepts cookies."));
  p.push(pt("st.cookieCount", "JS-Readable Cookies",
    document.cookie ? document.cookie.split(";").filter(Boolean).length : 0,
    "Cookies visible to JavaScript for this page path. Excludes HttpOnly and some scoped cookies."));

  p.push(pt("st.indexedDB", "IndexedDB", "indexedDB" in window, "Client-side database for structured data."));
  p.push(pt("st.serviceWorker", "Service Workers", "serviceWorker" in navigator, "Background scripts for offline support."));
  p.push(pt("st.cacheAPI", "Cache API", "caches" in window, "Programmatic cache for network responses."));
  p.push(pt("st.opfs", "Origin Private FS", typeof navigator?.storage?.getDirectory === "function", "Origin-private file system for high-performance storage."));
  p.push(pt("st.fileSystem", "File System Access", "showOpenFilePicker" in window, "API to read/write local files (Chromium-based browsers only)."));
  p.push(pt("st.cookieStore", "Cookie Store API", "cookieStore" in window, "Async cookie management API - alternative to document.cookie."));

  return p;
}

async function collectStorageAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);

  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      throwIfAborted(signal);
      const usageMB = est.usage != null ? (est.usage / 1024 / 1024).toFixed(2) : "?";
      const quotaMB = est.quota != null ? (est.quota / 1024 / 1024).toFixed(0) : "?";
      p.push(pt("st.storageQuota", "Storage Quota", `${usageMB} MB / ${quotaMB} MB`, "How much storage this origin has used vs. available."));
    } catch {
      p.push(pt("st.storageQuota", "Storage Quota", null, "Storage Manager API not available."));
    }
  } else {
    p.push(pt("st.storageQuota", "Storage Quota", null, "Storage Manager API not available."));
  }

  if (navigator.storage?.persisted) {
    try {
      const persisted = await navigator.storage.persisted();
      throwIfAborted(signal);
      p.push(pt("st.persisted", "Storage Persisted", persisted, "Whether stored data is protected from automatic cleanup."));
    } catch {
      p.push(pt("st.persisted", "Storage Persisted", null, "Not available."));
    }
  } else {
    p.push(pt("st.persisted", "Storage Persisted", null, "Not available."));
  }

  return p;
}

// 
// 10. PERMISSIONS (probe without requesting)
// 

async function collectPermissions(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);
  if (!navigator.permissions?.query) {
    p.push(pt("perm.api", "Permissions API", false, "Permissions API not available in this browser."));
    return p;
  }

  p.push(pt("perm.api", "Permissions API", true, "Allows querying permission states without triggering prompts."));

  const perms = [
    ["camera", "Camera", "Access to video input devices."],
    ["microphone", "Microphone", "Access to audio input devices."],
    ["geolocation", "Geolocation", "GPS/network location access."],
    ["notifications", "Notifications", "Push notification permission."],
    ["push", "Push API", "Background push message delivery."],
    ["midi", "MIDI Devices", "Access to MIDI instruments."],
    ["persistent-storage", "Persistent Storage", "Protection from storage eviction."],
    ["accelerometer", "Accelerometer", "Device motion sensor."],
    ["gyroscope", "Gyroscope", "Device rotation sensor."],
    ["magnetometer", "Magnetometer", "Compass/magnetic sensor."],
    ["clipboard-read", "Clipboard Read", "Read from system clipboard."],
    ["clipboard-write", "Clipboard Write", "Write to system clipboard."],
    ["display-capture", "Display Capture", "Screen recording/sharing."],
    ["background-sync", "Background Sync", "Defer actions until connectivity."],
    ["screen-wake-lock", "Screen Wake Lock", "Prevent screen dimming."],
    ["idle-detection", "Idle Detection", "Detect when user is idle."],
    ["window-management", "Window Management", "Multi-monitor window placement."],
    ["local-fonts", "Local Fonts", "Access to locally installed fonts."],
    ["storage-access", "Storage Access", "Access third-party cookies."],
  ] as const;

  const results = await Promise.allSettled(
    perms.map(async ([name, label, desc]) => {
      try {
        const result = await navigator.permissions.query({ name: name as PermissionName });
        return pt(`perm.${name}`, label, result.state, desc, false, false, 2);
      } catch {
        return pt(`perm.${name}`, label, null, `Cannot query "${name}" permission in this browser.`);
      }
    }),
  );
  throwIfAborted(signal);

  for (const r of results) {
    if (r.status === "fulfilled") p.push(r.value);
  }

  // Notification permission (always available independently)
  if ("Notification" in window) {
    p.push(pt("perm.notifCurrent", "Notification (current)", Notification.permission, "Current notification permission - granted, denied, or default.",
      false, false, 1,
      () => new Promise<string>((resolve) => {
        // Already decided — skip the prompt entirely
        if (Notification.permission === "granted") {
          new Notification("Digital Mirror", { body: "notifications are working." });
          resolve("granted");
          return;
        }
        if (Notification.permission === "denied") {
          resolve("denied");
          return;
        }
        // Handle both promise-based and callback-based APIs
        const result = Notification.requestPermission((perm) => resolve(perm));
        if (result && typeof result.then === "function") {
          result.then((perm) => {
            if (perm === "granted") {
              new Notification("Digital Mirror", { body: "notifications are working." });
            }
            resolve(perm);
          });
        }
      })));
  }

  return p;
}

// 
// 11. APIs & FEATURES
// 

function collectAPIs(): DataPoint[] {
  const p: DataPoint[] = [];

  // Communication
  p.push(pt("api.webSocket", "WebSocket", "WebSocket" in window, "Real-time two-way communication."));
  p.push(pt("api.webRTC", "WebRTC", "RTCPeerConnection" in window, "Peer-to-peer audio/video/data - can leak local IPs.", false, false, 3));
  p.push(pt("api.webTransport", "WebTransport", "WebTransport" in window, "Modern alternative to WebSocket using HTTP/3 and QUIC."));
  p.push(pt("api.eventSource", "EventSource (SSE)", "EventSource" in window, "Server-Sent Events for real-time server-to-client streaming."));
  p.push(pt("api.broadcastChannel", "BroadcastChannel", "BroadcastChannel" in window, "Cross-tab messaging within same origin."));

  // Workers
  p.push(pt("api.worker", "Web Workers", "Worker" in window, "Background threads for CPU-intensive tasks."));
  p.push(pt("api.sharedWorker", "Shared Workers", "SharedWorker" in window, "Workers shared between tabs."));
  p.push(pt("api.sab", "SharedArrayBuffer", typeof SharedArrayBuffer !== "undefined", "Shared memory (requires COOP/COEP headers)."));

  // Compute
  p.push(pt("api.wasm", "WebAssembly", typeof WebAssembly !== "undefined", "Run compiled code at near-native speed."));
  p.push(pt("api.wasmStreaming", "WASM Streaming",
    typeof WebAssembly !== "undefined" && typeof WebAssembly.compileStreaming === "function",
    "Compile WebAssembly while downloading."));
  p.push(pt("api.computePressure", "Compute Pressure", "PressureObserver" in window, "Observe CPU pressure states for adaptive performance."));

  // Input/Device
  p.push(pt("api.clipboard", "Clipboard API", has(navigator, "clipboard"), "Programmatic clipboard access."));
  p.push(pt("api.geolocation", "Geolocation", has(navigator, "geolocation"), "GPS/network location (requires permission).",
    false, false, 1,
    has(navigator, "geolocation") ? () => new Promise<string>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
        (err) => resolve(err.code === 1 ? "denied" : err.code === 3 ? "timed out" : "unavailable"),
        { timeout: 10000 },
      );
    }) : undefined));
  p.push(pt("api.bluetooth", "Web Bluetooth", has(navigator, "bluetooth"), "Access nearby Bluetooth devices."));
  p.push(pt("api.usb", "WebUSB", has(navigator, "usb"), "Access USB devices from the browser."));
  p.push(pt("api.serial", "Web Serial", has(navigator, "serial"), "Access serial ports."));
  p.push(pt("api.midi", "Web MIDI", has(navigator, "requestMIDIAccess"), "Access MIDI controllers."));
  p.push(pt("api.nfc", "Web NFC", "NDEFReader" in window, "Near-field communication."));
  p.push(pt("api.hid", "WebHID", has(navigator, "hid"), "Access Human Interface Devices."));
  p.push(pt("api.gamepad", "Gamepad API", "getGamepads" in navigator, "Access game controllers."));
  p.push(pt("api.ink", "Ink API", has(navigator, "ink"), "Low-latency stylus input."));
  p.push(pt("api.eyeDropper", "EyeDropper", "EyeDropper" in window, "Pick a color from screen.",
    false, false, 1,
    "EyeDropper" in window ? async () => {
      try {
        const dropper = new (window as any).EyeDropper();
        const result = await dropper.open();
        return result.sRGBHex as string;
      } catch {
        return null; // user cancelled (Escape)
      }
    } : undefined));
  p.push(pt("api.barcodeDetector", "Barcode Detector", "BarcodeDetector" in window, "Detect/decode barcodes."));

  // Output/Display
  p.push(pt("api.share", "Web Share", has(navigator, "share"), "Native OS share dialog."));
  p.push(pt("api.presentation", "Presentation API", has(navigator, "presentation"), "Cast to external displays."));
  p.push(pt("api.wakeLock", "Screen Wake Lock", has(navigator, "wakeLock"), "Prevent screen dimming."));
  p.push(pt("api.fullscreen", "Fullscreen", "fullscreenEnabled" in document, "Enter/exit fullscreen mode.",
    false, false, 1,
    document.fullscreenEnabled ? async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { /* browser denied fullscreen */ }
      return true;
    } : undefined));
  p.push(pt("api.pictureInPicture", "Picture-in-Picture", "pictureInPictureEnabled" in document, "Floating video window."));
  p.push(pt("api.notification", "Notifications", "Notification" in window, "Push notification support.",
    false, false, 1,
    "Notification" in window ? async () => {
      const perm = await Notification.requestPermission();
      return perm;
    } : undefined));

  // Auth/Payment
  p.push(pt("api.paymentRequest", "Payment Request", "PaymentRequest" in window, "Streamlined payment flow."));
  p.push(pt("api.credentials", "Credential Mgmt", has(navigator, "credentials"), "Password/federated login management."));
  p.push(pt("api.webauthn", "WebAuthn", "PublicKeyCredential" in window, "Passwordless authentication with passkeys and security keys."));

  // Observation
  p.push(pt("api.resizeObserver", "ResizeObserver", "ResizeObserver" in window, "Observe element size changes."));
  p.push(pt("api.intersectionObserver", "IntersectionObserver", "IntersectionObserver" in window, "Observe element visibility."));
  p.push(pt("api.mutationObserver", "MutationObserver", "MutationObserver" in window, "Observe DOM changes."));
  p.push(pt("api.performanceObserver", "PerformanceObserver", "PerformanceObserver" in window, "Observe performance metrics."));
  p.push(pt("api.reportingObserver", "ReportingObserver", "ReportingObserver" in window, "Observe browser reports (deprecations, interventions)."));

  // Data/Encoding
  p.push(pt("api.streams", "Streams", "ReadableStream" in window, "Streaming data processing."));
  p.push(pt("api.compression", "CompressionStream", "CompressionStream" in window, "Native gzip/deflate compression."));
  p.push(pt("api.textEncoder", "TextEncoder", "TextEncoder" in window, "UTF-8 text encoding."));
  p.push(pt("api.structuredClone", "structuredClone", "structuredClone" in window, "Deep clone JS objects."));
  p.push(pt("api.temporal", "Temporal", "Temporal" in (globalThis as any), "Modern date/time API - presence reveals browser engine and version.", false, false, 2));

  // Crypto
  p.push(pt("api.cryptoSubtle", "Web Crypto", !!(window.crypto?.subtle), "Cryptographic operations (AES, RSA, ECDSA, etc.)."));
  p.push(pt("api.cryptoUUID", "Random UUID", typeof window.crypto?.randomUUID === "function", "Generate cryptographic UUIDs.",
    false, false, 1,
    typeof window.crypto?.randomUUID === "function" ? async () => crypto.randomUUID() : undefined));

  // Scheduling
  p.push(pt("api.requestIdleCallback", "requestIdleCallback", "requestIdleCallback" in window, "Run code during browser idle time."));
  p.push(pt("api.scheduler", "Scheduler API", "scheduler" in window, "Priority-based task scheduling via scheduler.postTask()."));

  // CSS / Rendering
  p.push(pt("api.cssTypedOM", "CSS Typed OM", "CSSStyleValue" in window, "Typed access to CSS values (Houdini)."));
  p.push(pt("api.paintWorklet", "CSS Paint API", "paintWorklet" in (window.CSS || {}), "Custom CSS image rendering."));
  p.push(pt("api.viewTransitions", "View Transitions", "startViewTransition" in document, "Animated page transitions."));
  p.push(pt("api.popover", "Popover API", "popover" in HTMLElement.prototype, "Native popover/tooltip support."));
  p.push(pt("api.dialog", "Dialog Element", "HTMLDialogElement" in window, "Native modal/dialog element."));

  // Navigation
  p.push(pt("api.navigation", "Navigation API", "navigation" in window, "Modern navigation interception and history."));
  p.push(pt("api.urlPattern", "URLPattern", "URLPattern" in window, "URL matching patterns."));

  // Web Locks
  p.push(pt("api.webLocks", "Web Locks", has(navigator, "locks"), "Cross-tab coordination via named locks."));

  // Speech
  p.push(pt("api.speechRecognition", "Speech Recognition", "SpeechRecognition" in window || "webkitSpeechRecognition" in window, "Speech-to-text."));
  p.push(pt("api.speechSynthesis", "Speech Synthesis", "speechSynthesis" in window, "Text-to-speech.",
    false, false, 1,
    "speechSynthesis" in window ? async () => {
      speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance("hello there!");
      utter.rate = 0.9;
      speechSynthesis.speak(utter);
      return true;
    } : undefined));

  return p;
}

async function collectAPIAsync(signal?: AbortSignal): Promise<DataPoint[]> {
  const p: DataPoint[] = [];
  throwIfAborted(signal);
  if (!("RTCPeerConnection" in window)) {
    p.push(pt("api.localIP", "Local IP (WebRTC)", null, "WebRTC peer connection API not available in this browser."));
    return p;
  }

  // WebRTC local IP leak
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });

      const extractHostCandidate = (candidate: string): string | null => {
        const m = candidate.match(/candidate:\S+\s+\d+\s+\S+\s+\d+\s+([^\s]+)\s+\d+\s+typ\s+host/i);
        return m?.[1] || null;
      };

      const isLikelyLocalHost = (host: string): boolean => {
        const h = host.toLowerCase();

        if (h.endsWith(".local")) return true; // mDNS host candidates

        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
          const parts = h.split(".").map(Number);
          if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
          const [a, b] = parts;
          return (
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            a === 127 ||
            (a === 169 && b === 254)
          );
        }

        if (h.includes(":")) {
          return (
            h === "::1" ||
            h.startsWith("fe80:") ||
            h.startsWith("fc") ||
            h.startsWith("fd")
          );
        }

        return false;
      };

    let ip: string | null;
    try {
      pc.createDataChannel("");
      const offer = await pc.createOffer();
      throwIfAborted(signal);
      await pc.setLocalDescription(offer);
      throwIfAborted(signal);

      ip = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(value);
        };
        const timeout = setTimeout(() => finish(null), 4000);
        const onAbort = () => finish(null);
        if (signal) {
          if (signal.aborted) {
            finish(null);
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }

        pc.onicecandidate = (e) => {
          if (!e.candidate) return;
          const host = extractHostCandidate(e.candidate.candidate);
          if (host && isLikelyLocalHost(host)) {
            finish(host);
          }
        };
      });
      throwIfAborted(signal);
    } finally {
      pc.close();
    }
    p.push(pt("api.localIP", "Local IP (WebRTC)", ip,
      "Private local network address (or mDNS local hostname) exposed via WebRTC ICE host candidates.", true, false, 5));
  } catch {
    p.push(pt("api.localIP", "Local IP (WebRTC)", null, "WebRTC blocked or unavailable."));
  }

  return p;
}

// 
// 12. PERFORMANCE & TIMING
// 

function collectPerformance(): DataPoint[] {
  const p: DataPoint[] = [];

  // Navigation timing
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      p.push(pt("perf.dns", "DNS Lookup", `${Math.round(nav.domainLookupEnd - nav.domainLookupStart)} ms`, "Time spent resolving the domain name."));
      p.push(pt("perf.tcp", "TCP Connect", `${Math.round(nav.connectEnd - nav.connectStart)} ms`, "TCP connection establishment time."));
      const tlsTime = nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : 0;
      p.push(pt("perf.tls", "TLS Handshake", `${tlsTime} ms`, "Time to establish the encrypted connection."));
      p.push(pt("perf.ttfb", "Time to First Byte", `${Math.round(nav.responseStart - nav.requestStart)} ms`, "Server response time."));
      p.push(pt("perf.download", "Response Download", `${Math.round(nav.responseEnd - nav.responseStart)} ms`, "Time to download the HTML response."));
      p.push(pt("perf.domParsing", "DOM Parsing", `${Math.round(nav.domInteractive - nav.responseEnd)} ms`, "Time to parse the HTML document."));
      p.push(pt("perf.domContentLoaded", "DOMContentLoaded", `${Math.round(nav.domContentLoadedEventEnd - nav.startTime)} ms`, "Time until HTML was fully parsed and deferred scripts executed."));
      const pageLoadMs = nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd - nav.startTime) : null;
      p.push(
        pageLoadMs != null
          ? pt("perf.pageLoad", "Page Load", `${pageLoadMs} ms`, "Total time to fully load.")
          : pendingPt("perf.pageLoad", "Page Load", null, "Waiting for the window load event to complete."),
      );
      p.push(pt("perf.transferSize", "Document Transfer", `${(nav.transferSize / 1024).toFixed(1)} KB`, "Bytes transferred for this HTML document."));
      p.push(pt("perf.decodedSize", "Decoded Size", `${(nav.decodedBodySize / 1024).toFixed(1)} KB`, "Decompressed document size."));
      p.push(pt("perf.protocol", "HTTP Protocol", nav.nextHopProtocol, "Network protocol used (h2, h3, http/1.1)."));
    }
  } catch { /* timing not available */ }

  // Paint timing
  try {
    const paints = performance.getEntriesByType("paint");
    for (const entry of paints) {
      if (entry.name === "first-paint") {
        p.push(pt("perf.fp", "First Paint", `${Math.round(entry.startTime)} ms`, "When the browser first rendered anything on screen."));
      }
      if (entry.name === "first-contentful-paint") {
        p.push(pt("perf.fcp", "First Contentful Paint", `${Math.round(entry.startTime)} ms`, "When the first text or image was rendered."));
      }
    }
  } catch { /* paint timing not available */ }

  // Resources
  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    p.push(pt("perf.resourceCount", "Resources Loaded", resources.length, "Total sub-resources loaded (scripts, styles, images, fonts, etc.)."));
    const totalKB = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024;
    p.push(pt("perf.totalTransfer", "Total Transfer", `${totalKB.toFixed(0)} KB`, "Combined transfer size of all resources."));
  } catch { /* resource timing not available */ }

  // Memory (Chrome)
  const mem = (performance as any).memory;
  if (mem) {
    p.push(pt("perf.jsHeapUsed", "JS Heap Used", `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`, "Current JavaScript memory usage.", false, true));
    p.push(pt("perf.jsHeapTotal", "JS Heap Total", `${(mem.totalJSHeapSize / 1024 / 1024).toFixed(1)} MB`, "Total heap allocated."));
    p.push(pt("perf.jsHeapLimit", "JS Heap Limit", `${(mem.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MB`, "Maximum heap the browser will allocate."));
  } else {
    p.push(pt("perf.jsHeapUsed", "JS Heap", null, "performance.memory is Chrome-only."));
  }

  // FPS  initial placeholder, updated live
  p.push(pt("perf.fps", "Current FPS", "measuring...", "Frames per second.", false, true));

  return p;
}

// 
// 13. DATE / TIME / LOCALE
// 

function collectDateTime(): DataPoint[] {
  const p: DataPoint[] = [];
  const now = new Date();
  const resolved = Intl.DateTimeFormat().resolvedOptions();

  p.push(pt("dt.timezone", "Timezone", resolved.timeZone, "Your system timezone - reveals approximate region.", false, false, 4));
  const offsetMin = now.getTimezoneOffset();
  const sign = offsetMin <= 0 ? "+" : "-";
  const hrs = String(Math.abs(Math.floor(offsetMin / 60))).padStart(2, "0");
  const mins = String(Math.abs(offsetMin % 60)).padStart(2, "0");
  p.push(pt("dt.utcOffset", "UTC Offset", `UTC${sign}${hrs}:${mins}`, "Hours offset from Coordinated Universal Time."));

  // DST
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  p.push(pt("dt.dst", "DST Active", now.getTimezoneOffset() < Math.max(jan, jul), "Whether Daylight Saving Time is in effect."));
  p.push(pt("dt.dstObserved", "DST Observed", jan !== jul, "Whether your timezone observes DST at all."));

  // Live clock
  p.push(pt("dt.localTime", "Local Time", now.toLocaleTimeString(), "Current local time.", false, true));
  p.push(pt("dt.localDate", "Local Date", now.toLocaleDateString(), "Current local date - format reveals your locale.", false, false, 2));
  p.push(pt("dt.isoTime", "ISO Time", now.toISOString(), "Current time in ISO 8601 format."));

  // Locale formatting
  p.push(pt("dt.numberFormat", "Number Format", new Intl.NumberFormat().format(1234567.89),
    "How your locale formats numbers (commas vs dots vs spaces).", false, false, 2));
  p.push(pt("dt.currencyFormat", "Currency Format",
    new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(1234.56),
    "How your locale formats currency."));
  p.push(pt("dt.percentFormat", "Percent Format",
    new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(0.8765),
    "How your locale formats percentages."));

  p.push(pt("dt.calendar", "Calendar System", resolved.calendar, "Calendar in use (gregorian, islamic, etc.).", false, false, 2));
  p.push(pt("dt.numberingSystem", "Numbering System", resolved.numberingSystem, "Numeral system (latn, arab, etc.).", false, false, 2));

  // Hour cycle
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions();
    p.push(pt("dt.hourCycle", "Hour Cycle", (hc as any).hourCycle || null, "12-hour (h12) or 24-hour (h23) clock preference."));
  } catch { /* skip */ }

  // First day of week
  try {
    const locale = new (Intl as any).Locale(navigator.language);
    const wi = locale.weekInfo || locale.getWeekInfo?.();
    if (wi?.firstDay != null) {
      const days = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
      p.push(pt("dt.firstDay", "First Day of Week", days[wi.firstDay] || String(wi.firstDay), "What your locale considers the start of the week."));
    }
  } catch { /* Intl.Locale weekInfo not available */ }

  // Intl feature support (shows how many calendars/timezones the engine knows about)
  try {
    const sup = (Intl as any).supportedValuesOf;
    if (typeof sup === "function") {
      p.push(pt("dt.knownCalendars", "Known Calendars", sup("calendar").length, "Number of calendar systems the browser can handle."));
      p.push(pt("dt.knownTimezones", "Known Timezones", sup("timeZone").length, "Number of timezone identifiers the browser recognizes."));
      p.push(pt("dt.knownCurrencies", "Known Currencies", sup("currency").length, "Number of currency codes the browser recognizes."));
      p.push(pt("dt.knownNumberingSystems", "Known Numbering Systems", sup("numberingSystem").length, "Number of numeral systems supported."));
    }
  } catch { /* Intl.supportedValuesOf not available */ }

  return p;
}

// 
// 14. NAVIGATION & DOCUMENT
// 

function collectNavigation(): DataPoint[] {
  const p: DataPoint[] = [];

  p.push(pt("doc.referrer", "Referrer", document.referrer || "(direct / none)", "The page that linked you here.", false, false, 2));

  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    p.push(pt("doc.navType", "Navigation Type", nav?.type ?? null, "How you arrived: navigate, reload, back_forward, or prerender."));
  } catch {
    p.push(pt("doc.navType", "Navigation Type", null, "Navigation Timing not available."));
  }

  p.push(pt("doc.historyLength", "History Length", history.length, "Pages in this tab's navigation stack."));
  p.push(pt("doc.protocol", "Protocol", location.protocol, "Connection protocol."));
  p.push(pt("doc.host", "Host", location.hostname, "Current domain."));
  p.push(pt("doc.port", "Port", location.port || "(default)", "Connection port."));
  p.push(pt("doc.path", "Path", location.pathname, "Current URL path."));
  p.push(pt("doc.query", "Query String", location.search || "(none)", "URL parameters - often used for tracking."));
  p.push(pt("doc.hash", "URL Hash", location.hash || "(none)", "Fragment identifier."));
  p.push(pt("doc.origin", "Origin", location.origin, "The origin (protocol + host + port)."));

  p.push(pt("doc.characterSet", "Character Set", document.characterSet, "Document encoding."));
  p.push(pt("doc.contentType", "Content Type", document.contentType, "Document MIME type."));
  p.push(pt("doc.compatMode", "Compat Mode", document.compatMode, "Rendering mode - BackCompat (quirks) or CSS1Compat (standards)."));
  p.push(pt("doc.lastModified", "Last Modified", document.lastModified, "Server-reported last modification date."));
  p.push(pt("doc.visibility", "Visibility", document.visibilityState, "Whether this tab is currently active or hidden.", false, true));
  p.push(pt("doc.hasFocus", "Has Focus", document.hasFocus(), "Whether this document currently has input focus.", false, true));

  p.push(pt("doc.secureContext", "Secure Context", window.isSecureContext, "Whether the page is served in a secure context (HTTPS)."));
  p.push(pt("doc.crossOriginIsolated", "Cross-Origin Isolated", window.crossOriginIsolated,
    "Whether COOP/COEP headers enable full isolation (needed for SharedArrayBuffer)."));

  return p;
}

// 
// 15. SYSTEM THEME COLORS
// 

function collectSystemColors(): DataPoint[] {
  const p: DataPoint[] = [];
  const colors = [
    ["Canvas", "Page background color."],
    ["CanvasText", "Page text color."],
    ["LinkText", "Unvisited link color."],
    ["VisitedText", "Visited link color."],
    ["ActiveText", "Active link color."],
    ["ButtonFace", "Button background color."],
    ["ButtonText", "Button text color."],
    ["ButtonBorder", "Button border color."],
    ["Field", "Input field background."],
    ["FieldText", "Input field text color."],
    ["Highlight", "Selection background color."],
    ["HighlightText", "Selection text color."],
    ["GrayText", "Disabled text color."],
    ["Mark", "Marked text background (find-in-page)."],
    ["MarkText", "Marked text color."],
    ["AccentColor", "System accent color."],
    ["AccentColorText", "Text on accent color."],
  ];

  try {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:1px;height:1px";
    document.body.appendChild(el);

    try {
      const supportsColorValue = (value: string): boolean => {
        try {
          if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
            return CSS.supports("color", value);
          }
        } catch {
          // fall through to inline-style probing
        }

        el.style.color = "rgb(1, 2, 3)";
        const sentinel = el.style.color;
        el.style.color = value;
        return el.style.color !== "" && el.style.color !== sentinel;
      };

      for (const [name, desc] of colors) {
        if (!supportsColorValue(name)) {
          p.push(pt(`theme.${name}`, name, null, desc, false, false, 2));
          continue;
        }

        el.style.color = name;
        const computed = getComputedStyle(el).color;
        p.push(pt(`theme.${name}`, name, computed || null, desc, false, false, 2));
      }
    } finally {
      el.remove();
    }
  } catch {
    p.push(pt("theme.error", "System Colors", null, "Could not probe system colors."));
  }

  return p;
}

const DETAIL_SOURCE_BY_PREFIX: Record<string, string> = {
  net: "network",
  conn: "network api",
  br: "navigator",
  hw: "screen/window",
  gpu: "webgl",
  os: "media query",
  fp: "runtime",
  media: "media api",
  st: "storage",
  perm: "permissions",
  api: "feature check",
  perf: "performance api",
  dt: "intl/date",
  doc: "document",
  theme: "css",
};

function detailSource(id: string): string {
  const prefix = id.split(".")[0];
  return DETAIL_SOURCE_BY_PREFIX[prefix] || "browser";
}

const DETAIL_CONFIDENCE_LOW_IDS = new Set<string>([
  "br.ua",
  "gpu.vendor",
  "gpu.renderer",
  "api.localIP",
  "hw.batteryLevel",
  "hw.batteryCharging",
  "hw.chargingTime",
  "hw.dischargingTime",
  "hw.touchSupport",
]);

const DETAIL_CONFIDENCE_MEDIUM_IDS = new Set<string>([
  "fp.audioBaseLatency",
  "fp.audioOutputLatency",
  "fp.timerPrecision",
  "st.storageQuota",
  "hw.cores",
  "hw.memory",
]);

const DETAIL_STABILITY_SESSION_IDS = new Set<string>([
  "hw.orientation",
  "os.mqOrientation",
]);

const DETAIL_CONFIDENCE_MEDIUM_PREFIXES = ["net.", "perf."] as const;
const DETAIL_STABILITY_SESSION_PREFIXES = ["dt.", "perf.", "net.", "hw.viewport", "hw.window"] as const;

function startsWithAny(id: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => id.startsWith(prefix));
}

function detailConfidence(point: DataPoint): DetailConfidence {
  if (point.status === "unavailable") return "low";
  if (point.status === "pending") return "low";

  if (DETAIL_CONFIDENCE_LOW_IDS.has(point.id)) return "low";

  // Permission-gated media device lists are often redacted until user grants access.
  if (/^media\.(cameras|microphones|speakers)$/.test(point.id)) return "low";

  if (startsWithAny(point.id, DETAIL_CONFIDENCE_MEDIUM_PREFIXES)) return "medium";

  // Connection metrics other than explicit online/saveData are estimates.
  if (point.id.startsWith("conn.") && point.id !== "conn.online" && point.id !== "conn.saveData") return "medium";

  // Voice enumeration and media capabilities tend to be async, rounded, or coarse.
  if (/^media\.(voiceCount|voiceLangs|capabilities)$/.test(point.id)) return "medium";

  if (DETAIL_CONFIDENCE_MEDIUM_IDS.has(point.id)) return "medium";

  return "high";
}

function detailStability(point: DataPoint): DetailStability {
  if (point.live) return "live";

  if (DETAIL_STABILITY_SESSION_IDS.has(point.id)) return "session";
  if (startsWithAny(point.id, DETAIL_STABILITY_SESSION_PREFIXES)) {
    return "session";
  }

  return "stable";
}

const SIGNAL_TIER_BY_ID: Record<string, SignalTier> = {
  // Core, high-signal identity fields
  "net.ip": "core",
  "net.coords": "core",
  "net.postal": "core",
  "net.isp": "core",
  "net.asn": "core",
  "net.country": "core",
  "net.countryCode": "core",
  "br.ua": "core",
  "br.brands": "core",
  "br.fullVersions": "core",
  "br.language": "core",
  "br.languages": "core",
  "br.arch": "core",
  "br.platformVer": "core",
  "br.model": "core",
  "hw.screenRes": "core",
  "hw.dpr": "core",
  "hw.cores": "core",
  "hw.memory": "core",
  "dt.timezone": "core",
  "dt.utcOffset": "core",
  "conn.online": "core",
  "conn.type": "core",

  // Useful context signals with meaningful session variance
  "conn.downlink": "context",
  "conn.downlinkMax": "context",
  "conn.rtt": "context",
  "conn.saveData": "context",

  // Deep-dive / legacy / heavily derived
  "fp.canvasPreview": "deep",
  "br.dnt": "deep",
  "dt.numberFormat": "deep",
  "dt.currencyFormat": "deep",
  "dt.percentFormat": "deep",
  "dt.knownCalendars": "deep",
  "dt.knownTimezones": "deep",
  "dt.knownCurrencies": "deep",
  "dt.knownNumberingSystems": "deep",
  "net.currency": "deep",
  "net.callingCode": "deep",
};

function signalTier(point: DataPoint, confidence: DetailConfidence): SignalTier {
  const explicit = SIGNAL_TIER_BY_ID[point.id];
  if (explicit) return explicit;

  if (point.id.startsWith("theme.")) return "deep";
  if (point.id.startsWith("fp.")) return "core";
  if (point.privacyWeight >= 4) return "core";
  if (confidence === "low" && point.privacyWeight <= 2) return "deep";
  return "context";
}

function withDetail(point: DataPoint): DataPoint {
  const resolvedSource = point.detailSource ?? detailSource(point.id);
  const resolvedConfidence = point.detailConfidence ?? detailConfidence(point);
  const resolvedStability = point.detailStability ?? detailStability(point);
  return {
    ...point,
    detailSource: resolvedSource,
    detailConfidence: resolvedConfidence,
    detailStability: resolvedStability,
    signalTier: point.signalTier ?? signalTier(point, resolvedConfidence),
  };
}

function withDetailForAll(points: DataPoint[]): DataPoint[] {
  return points.map(withDetail);
}

function dedupePointsById(points: DataPoint[]): DataPoint[] {
  const deduped: DataPoint[] = [];
  const indexById = new Map<string, number>();

  for (const point of points) {
    const existingIndex = indexById.get(point.id);
    if (existingIndex === undefined) {
      indexById.set(point.id, deduped.length);
      deduped.push(point);
    } else {
      // Last writer wins for duplicate IDs from the same collector batch.
      deduped[existingIndex] = point;
    }
  }

  return deduped;
}

function mergePointsById(existing: DataPoint[], incoming: DataPoint[]): DataPoint[] {
  const merged = existing.slice();
  const indexById = new Map<string, number>();

  for (let i = 0; i < merged.length; i++) {
    indexById.set(merged[i].id, i);
  }

  for (const point of incoming) {
    const existingIndex = indexById.get(point.id);
    if (existingIndex === undefined) {
      indexById.set(point.id, merged.length);
      merged.push(point);
    } else {
      merged[existingIndex] = point;
    }
  }

  return merged;
}

// 
// COORDINATOR
// 

const CATEGORY_ORDER: Array<{ id: string; title: string; syncFn?: () => DataPoint[]; asyncFn?: (signal?: AbortSignal) => Promise<DataPoint[]> }> = [
  { id: "network",     title: "NETWORK",              asyncFn: collectNetwork },
  { id: "browser",     title: "BROWSER",               syncFn: collectBrowser, asyncFn: collectBrowserAsync },
  { id: "hardware",    title: "DEVICE & HARDWARE",     syncFn: collectDevice, asyncFn: collectDeviceAsync },
  { id: "gpu",         title: "GPU & GRAPHICS",        syncFn: collectGPU },
  { id: "os",          title: "OS & PREFERENCES",      syncFn: collectOS },
  { id: "fingerprint", title: "FINGERPRINTS",          syncFn: collectFingerprints },
  { id: "performance", title: "PERFORMANCE",           syncFn: collectPerformance },
  { id: "connection",  title: "CONNECTION",            syncFn: collectConnection, asyncFn: collectConnectionAsync },
  { id: "datetime",    title: "DATE / TIME / LOCALE",  syncFn: collectDateTime },
  { id: "media",       title: "MEDIA & CODECS",        syncFn: collectMedia, asyncFn: collectMediaAsync },
  { id: "storage",     title: "STORAGE",               syncFn: collectStorage, asyncFn: collectStorageAsync },
  { id: "permissions", title: "PERMISSIONS",            asyncFn: collectPermissions },
  { id: "apis",        title: "APIs & FEATURES",       syncFn: collectAPIs, asyncFn: collectAPIAsync },
  { id: "document",    title: "NAVIGATION & DOCUMENT", syncFn: collectNavigation },
  { id: "theme",       title: "SYSTEM THEME",          syncFn: collectSystemColors },
];

export { CATEGORY_ORDER };

export async function collectAllData(
  onUpdate: OnDataUpdate,
  options: { signal?: AbortSignal } = {},
): Promise<MirrorData> {
  const { signal } = options;
  throwIfAborted(signal);
  const categories: DataCategory[] = [];
  const categoriesById = new Map<string, DataCategory>();

  // Build all categories and run sync collectors immediately
  for (const def of CATEGORY_ORDER) {
    throwIfAborted(signal);
    const cat: DataCategory = { id: def.id, title: def.title, points: [], expanded: true };
    categories.push(cat);
    categoriesById.set(cat.id, cat);
    if (def.syncFn) {
      try {
        throwIfAborted(signal);
        cat.points = dedupePointsById(withDetailForAll(def.syncFn()));
        throwIfAborted(signal);
        onUpdate(cat.id, cat.points);
      } catch (error) {
        if (isAbortError(error)) throw error;
        /* swallowed  individual collectors handle their own errors */
      }
    }
  }

  // Fire all async collectors in parallel
  const asyncTasks = CATEGORY_ORDER
    .filter(d => d.asyncFn)
    .map(d => ({
      id: d.id,
      promise: d.asyncFn!(signal),
    }));

  await Promise.allSettled(asyncTasks.map(async ({ id, promise }) => {
    try {
      throwIfAborted(signal);
      const pts = dedupePointsById(withDetailForAll(await promise));
      throwIfAborted(signal);
      const cat = categoriesById.get(id);
      if (cat && pts.length > 0) {
        cat.points = mergePointsById(cat.points, pts);
        throwIfAborted(signal);
        onUpdate(cat.id, cat.points);
      }
    } catch (error) {
      if (isAbortError(error)) return;
      /* swallowed */
    }
  }));
  throwIfAborted(signal);

  // Totals
  const allPoints = categories.flatMap(c => c.points);
  const totalPoints = allPoints.length;
  const resolvedPoints = allPoints.filter(p => p.status === "resolved").length;

  // Composite fingerprint from high-weight values
  const fpSource = allPoints
    .filter(p => p.privacyWeight >= 3 && p.value != null)
    .map(p => String(p.value))
    .join("|");

  return {
    categories,
    collectedAt: Date.now(),
    totalPoints,
    resolvedPoints,
    fingerprintHash: fnv1a(fpSource),
  };
}

// 
// LIVE UPDATERS
// 

export function createLiveUpdaters(onUpdate: (id: string, value: string | number | boolean) => void): () => void {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let fpsActive = true;

  // FPS -- pause when hidden
  let frames = 0;
  let lastFpsTime = performance.now();
  let rafId = 0;
  const fpsTick = (now: number) => {
    if (disposed || !fpsActive) return;
    frames++;
    if (now - lastFpsTime >= 1000) {
      onUpdate("perf.fps", frames);
      frames = 0;
      lastFpsTime = now;
    }
    rafId = requestAnimationFrame(fpsTick);
  };

  const stopFps = () => {
    if (!fpsActive) return;
    fpsActive = false;
    cancelAnimationFrame(rafId);
  };

  const startFps = () => {
    if (disposed || fpsActive) return;
    fpsActive = true;
    frames = 0;
    lastFpsTime = performance.now();
    rafId = requestAnimationFrame(fpsTick);
  };

  rafId = requestAnimationFrame(fpsTick);
  cleanups.push(stopFps);

  // Clock
  const clockId = setInterval(() => {
    if (!disposed) onUpdate("dt.localTime", new Date().toLocaleTimeString());
  }, 1000);
  cleanups.push(() => clearInterval(clockId));

  // Online/offline
  const onOnline = () => { if (!disposed) onUpdate("conn.online", true); };
  const onOffline = () => { if (!disposed) onUpdate("conn.online", false); };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  cleanups.push(() => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  });

  // Visibility + focus
  const onVis = () => {
    if (disposed) return;
    const hidden = document.visibilityState === "hidden";
    onUpdate("doc.visibility", document.visibilityState);
    onUpdate("doc.hasFocus", document.hasFocus());
    if (hidden) {
      stopFps();
    } else {
      startFps();
    }
  };
  document.addEventListener("visibilitychange", onVis);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVis));

  // Viewport resize
  const onResize = () => {
    if (disposed) return;
    onUpdate("hw.viewportSize", `${window.innerWidth} x ${window.innerHeight}`);
  };
  window.addEventListener("resize", onResize, { passive: true });
  cleanups.push(() => window.removeEventListener("resize", onResize));

  // Visual viewport scale
  const vv = window.visualViewport;
  if (vv) {
    const onVvResize = () => {
      if (disposed) return;
      onUpdate("hw.vvScale", vv.scale);
    };
    if (typeof vv.addEventListener === "function") {
      vv.addEventListener("resize", onVvResize, { passive: true });
      cleanups.push(() => vv.removeEventListener("resize", onVvResize));
    } else {
      const vvAny = vv as VisualViewport & { onresize: ((this: VisualViewport, ev: UIEvent) => any) | null };
      const prev = vvAny.onresize;
      vvAny.onresize = onVvResize;
      cleanups.push(() => {
        if (vvAny.onresize === onVvResize) {
          vvAny.onresize = prev ?? null;
        }
      });
    }
  }

  // Device pixel ratio (changes on zoom or moving between monitors)
  let dprQuery: MediaQueryList | null = null;
  let detachDprListener: (() => void) | null = null;
  const bindMqlChange = (
    query: MediaQueryList,
    listener: () => void,
  ): (() => void) => {
    const mql = query as MediaQueryList & {
      onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => any) | null;
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", listener);
      return () => mql.removeEventListener("change", listener);
    }

    if ("onchange" in mql) {
      const prev = mql.onchange;
      const onChange = () => listener();
      mql.onchange = onChange;
      return () => {
        if (mql.onchange === onChange) {
          mql.onchange = prev ?? null;
        }
      };
    }

    return () => {};
  };
  const trackDpr = () => {
    if (disposed) return;
    onUpdate("hw.dpr", window.devicePixelRatio);
    // matchMedia query is one-shot per value, so re-create on each change
    if (detachDprListener) {
      detachDprListener();
      detachDprListener = null;
    }
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    detachDprListener = bindMqlChange(dprQuery, trackDpr);
  };
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  detachDprListener = bindMqlChange(dprQuery, trackDpr);
  cleanups.push(() => {
    if (detachDprListener) {
      detachDprListener();
      detachDprListener = null;
    }
    dprQuery = null;
  });

  // Orientation
  const orient = screen.orientation;
  if (orient) {
    const onOrient = () => {
      if (disposed) return;
      onUpdate("hw.orientation", `${orient.type} (${orient.angle} deg)`);
    };
    if (typeof orient.addEventListener === "function") {
      orient.addEventListener("change", onOrient);
      cleanups.push(() => orient.removeEventListener("change", onOrient));
    } else {
      const orientationAny = orient as ScreenOrientation & { onchange: ((this: ScreenOrientation, ev: Event) => any) | null };
      const prev = orientationAny.onchange;
      orientationAny.onchange = onOrient;
      cleanups.push(() => {
        if (orientationAny.onchange === onOrient) {
          orientationAny.onchange = prev ?? null;
        }
      });
    }
  }

  // Gamepad connect/disconnect
  const onGamepad = () => {
    if (disposed) return;
    const gp = navigator.getGamepads?.();
    const names = gp ? Array.from(gp).filter(Boolean).map(g => g!.id) : [];
    onUpdate("hw.gamepads", names.length > 0 ? names.join(", ") : "none");
  };
  window.addEventListener("gamepadconnected", onGamepad);
  window.addEventListener("gamepaddisconnected", onGamepad);
  cleanups.push(() => {
    window.removeEventListener("gamepadconnected", onGamepad);
    window.removeEventListener("gamepaddisconnected", onGamepad);
  });

  // JS heap memory (Chrome only, sampled periodically)
  const mem = (performance as any).memory;
  if (mem) {
    const memId = setInterval(() => {
      if (disposed) return;
      onUpdate("perf.jsHeapUsed", `${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB`);
    }, 2000);
    cleanups.push(() => clearInterval(memId));
  }

  // Connection changes
  const conn = getNavigatorConnection();
  const pushConnectionSnapshot = (snapshot: NativeConnectionSnapshot): void => {
    if (snapshot.type !== null) onUpdate("conn.type", snapshot.type);
    if (snapshot.downlinkMbps !== null) onUpdate("conn.downlink", roundTo(snapshot.downlinkMbps, 2));
    if (snapshot.downlinkMaxMbps !== null) onUpdate("conn.downlinkMax", roundTo(snapshot.downlinkMaxMbps, 2));
    if (snapshot.rttMs !== null) onUpdate("conn.rtt", Math.max(1, Math.round(snapshot.rttMs)));

    const saveDataValue = resolveSaveDataPreference(snapshot.saveData);
    if (saveDataValue !== null) onUpdate("conn.saveData", saveDataValue);
  };

  const initialConnectionSnapshot = readNativeConnectionSnapshot(conn);
  pushConnectionSnapshot(initialConnectionSnapshot);

  if (conn) {
    // Debounce rapid-fire change events (common on mobile during network handoffs)
    // so we emit at most one snapshot update per burst rather than one per event.
    let connChangeTimer: ReturnType<typeof setTimeout> | null = null;

    const flushConnectionChange = () => {
      connChangeTimer = null;
      if (!disposed) pushConnectionSnapshot(readNativeConnectionSnapshot(conn));
    };

    const onChange = () => {
      if (disposed) return;
      if (connChangeTimer !== null) clearTimeout(connChangeTimer);
      connChangeTimer = setTimeout(flushConnectionChange, 80);
    };

    const cancelConnChangeTimer = () => {
      if (connChangeTimer !== null) { clearTimeout(connChangeTimer); connChangeTimer = null; }
    };

    if (typeof conn.addEventListener === "function") {
      conn.addEventListener("change", onChange);
      cleanups.push(() => {
        conn.removeEventListener("change", onChange);
        cancelConnChangeTimer();
      });
    } else {
      const prev = conn.onchange;
      conn.onchange = onChange;
      cleanups.push(() => {
        if (conn.onchange === onChange) {
          conn.onchange = prev ?? null;
        }
        cancelConnChangeTimer();
      });
    }
  }

  const reducedDataMql = getReducedDataMediaQueryList();
  if (reducedDataMql && initialConnectionSnapshot.saveData === null) {
    const onReducedDataChange = () => {
      if (disposed) return;
      const saveDataValue = readReducedDataPreference();
      if (saveDataValue !== null) onUpdate("conn.saveData", saveDataValue);
    };
    onReducedDataChange();

    if (typeof reducedDataMql.addEventListener === "function") {
      reducedDataMql.addEventListener("change", onReducedDataChange);
      cleanups.push(() => reducedDataMql.removeEventListener("change", onReducedDataChange));
    } else {
      const mqlAny = reducedDataMql as MediaQueryList & {
        onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => any) | null;
      };
      const prev = mqlAny.onchange;
      const handler = () => onReducedDataChange();
      mqlAny.onchange = handler;
      cleanups.push(() => {
        if (mqlAny.onchange === handler) {
          mqlAny.onchange = prev ?? null;
        }
      });
    }
  }

  const shouldProbeAssist =
    !hasNativeConnectionSignal(initialConnectionSnapshot) ||
    initialConnectionSnapshot.type === null ||
    initialConnectionSnapshot.downlinkMbps === null ||
    initialConnectionSnapshot.rttMs === null;

  if (shouldProbeAssist) {
    let probing = false;
    let probeTick = 0;
    let activeProbeController: AbortController | null = null;

    const runConnectionProbe = async (forceDownlink = false) => {
      if (disposed || probing || !navigator.onLine || document.visibilityState === "hidden") return;
      probing = true;

      const nativeNow = readNativeConnectionSnapshot(conn);
      probeTick += 1;
      const includeDownlink = forceDownlink ||
        nativeNow.downlinkMbps === null ||
        probeTick % CONNECTION_LIVE_DOWNLINK_EVERY_NTH_SAMPLE === 1;

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      activeProbeController = controller;

      try {
        const snapshot = await probeConnectionSnapshot({
          includeDownlink,
          signal: controller?.signal,
        });
        if (disposed || !snapshot) return;

        const liveNative = readNativeConnectionSnapshot(conn);
        if (liveNative.type === null && snapshot.type !== null) onUpdate("conn.type", snapshot.type);
        if (liveNative.rttMs === null && snapshot.rttMs !== null) onUpdate("conn.rtt", snapshot.rttMs);
        if (liveNative.downlinkMbps === null && snapshot.downlinkMbps !== null) onUpdate("conn.downlink", snapshot.downlinkMbps);
        if (liveNative.downlinkMaxMbps === null && snapshot.downlinkMaxMbps !== null) onUpdate("conn.downlinkMax", snapshot.downlinkMaxMbps);
      } catch (error) {
        if (isAbortError(error)) return;
      } finally {
        if (activeProbeController === controller) activeProbeController = null;
        probing = false;
      }
    };

    void runConnectionProbe(true);

    const probeId = setInterval(() => {
      void runConnectionProbe();
    }, CONNECTION_LIVE_RTT_INTERVAL_MS);
    cleanups.push(() => {
      clearInterval(probeId);
      if (activeProbeController) {
        activeProbeController.abort();
        activeProbeController = null;
      }
    });

    const onProbeVisibility = () => {
      if (document.visibilityState === "visible" && !disposed) {
        void runConnectionProbe();
      }
    };
    document.addEventListener("visibilitychange", onProbeVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onProbeVisibility));

    const onProbeOnline = () => {
      if (disposed) return;
      resetConnectionProbeState();
      void runConnectionProbe(true);
    };
    window.addEventListener("online", onProbeOnline);
    cleanups.push(() => window.removeEventListener("online", onProbeOnline));

    const onProbeOffline = () => {
      if (activeProbeController) {
        activeProbeController.abort();
        activeProbeController = null;
      }
    };
    window.addEventListener("offline", onProbeOffline);
    cleanups.push(() => window.removeEventListener("offline", onProbeOffline));
  }

  // Battery
  if ("getBattery" in navigator) {
    (navigator as any).getBattery().then((bat: any) => {
      if (disposed) return;

      const onLevel = () => {
        if (!disposed) onUpdate("hw.batteryLevel", `${Math.round(bat.level * 100)}%`);
      };
      const onCharging = () => {
        if (!disposed) onUpdate("hw.batteryCharging", bat.charging);
      };
      onLevel();
      onCharging();

      if (typeof bat.addEventListener === "function") {
        bat.addEventListener("levelchange", onLevel);
        bat.addEventListener("chargingchange", onCharging);
        cleanups.push(() => {
          bat.removeEventListener("levelchange", onLevel);
          bat.removeEventListener("chargingchange", onCharging);
        });
      } else {
        const prevLevel = bat.onlevelchange;
        const prevCharging = bat.onchargingchange;
        bat.onlevelchange = onLevel;
        bat.onchargingchange = onCharging;
        cleanups.push(() => {
          if (bat.onlevelchange === onLevel) {
            bat.onlevelchange = prevLevel ?? null;
          }
          if (bat.onchargingchange === onCharging) {
            bat.onchargingchange = prevCharging ?? null;
          }
        });
      }
    }).catch(() => {});
  }

  return () => {
    if (disposed) return;
    disposed = true;
    stopFps();
    cleanups.forEach(fn => fn());
    cleanups.length = 0;
  };
}
