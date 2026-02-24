// Whisper Seal — crypto engine.
// Browser-fingerprint-bound message encryption using native WebCrypto.
// The recipient's browser environment IS the decryption key.

import { sha256, randomBytes } from "./whisper-wasm";
import { hkdf, aesGcmEncrypt, aesGcmDecrypt, TE } from "./whisper-live-crypto";

/* ── Seal Code Word List ──────────────────────────────────── */
// 26 words evoking weight, permanence, and materiality.
// Phonetically distinct: safe to read aloud over any channel.

const SEAL_WORDS = [
  "AGATE",    "BASALT",  "COBALT",   "DUSK",    "EMBER",
  "FLINT",    "GRANITE", "HARBOR",   "IRON",    "JADE",
  "KEYSTONE", "LUMEN",   "MARBLE",   "NEXUS",   "ONYX",
  "PRISM",    "QUARTZ",  "RIDGE",    "SLATE",   "TIDAL",
  "UMBRA",    "VAULT",   "WREN",     "XENON",   "YIELD",
  "ZENITH",
] as const;

const SEAL_WORD_SET = new Set<string>(SEAL_WORDS);
const ZERO_SALT_32 = new Uint8Array(32);

/** Minimum time (ms) to hold the spinner during fingerprint computation.
 *  Prevents jarring sub-100ms flash on fast hardware. */
export const COMPUTE_MIN_DISPLAY_MS = 600;

/* ── Fingerprint Signals ──────────────────────────────────── */

async function canvasSignal(): Promise<string> {
  try {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 50;
    const ctx = c.getContext("2d");
    if (!ctx) return "no-canvas";
    ctx.textBaseline = "alphabetic";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("Whisper Seal \ud83d\udd12", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Whisper Seal \ud83d\udd12", 4, 17);
    return c.toDataURL();
  } catch { return "canvas-err"; }
}

function webglSignal(): string {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
    if (!gl || !(gl instanceof WebGLRenderingContext)) return "no-webgl";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (!dbg) return "no-dbg";
    const vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? "";
    const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "";
    return `${vendor}|${renderer}`;
  } catch { return "webgl-err"; }
}

async function audioSignal(): Promise<string> {
  try {
    const ctx = new OfflineAudioContext(1, 4410, 44100);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(10000, ctx.currentTime);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(-50, ctx.currentTime);
    comp.knee.setValueAtTime(40, ctx.currentTime);
    comp.ratio.setValueAtTime(12, ctx.currentTime);
    comp.attack.setValueAtTime(0, ctx.currentTime);
    comp.release.setValueAtTime(0.25, ctx.currentTime);
    osc.connect(comp);
    comp.connect(ctx.destination);
    osc.start(0);
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    let sum = 0;
    for (let i = 4000; i < 4400; i++) sum += Math.abs(data[i]);
    return sum.toString();
  } catch { return "audio-err"; }
}

function fontSignal(): string {
  const probes = [
    "monospace", "sans-serif", "serif", "cursive",
    "Courier New", "Georgia", "Helvetica Neue", "Times New Roman",
  ];
  const bits: string[] = [];
  for (const f of probes) {
    try { bits.push(document.fonts.check(`16px "${f}"`) ? "1" : "0"); }
    catch { bits.push("x"); }
  }
  return bits.join("");
}

/* ── Fingerprint ──────────────────────────────────────────── */

export async function computeFingerprint(): Promise<Uint8Array> {
  const [canvas, audio] = await Promise.all([canvasSignal(), audioSignal()]);
  const signals = [
    canvas,
    webglSignal(),
    audio,
    String(navigator.hardwareConcurrency ?? "?"),
    String((navigator as any).deviceMemory ?? "?"),
    String(screen.colorDepth),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.languages.join(","),
    fontSignal(),
  ];
  return sha256(TE.encode(signals.join("|||")));
}

/* ── Seal Code Encoding ───────────────────────────────────── */

export function fingerprintToSealCode(hash: Uint8Array): string {
  const wordIdx = ((hash[0] << 8) | hash[1]) % SEAL_WORDS.length;
  const word = SEAL_WORDS[wordIdx];
  const hex = hash[2].toString(16).toUpperCase().padStart(2, "0");
  const check = (hash[3] & 0x0F).toString(16).toUpperCase();
  return `${word}-${hex}${check}`;
}

export function isSealCodeValid(code: string): boolean {
  const m = code.match(/^([A-Z]+)-([0-9A-F]{3})$/i);
  if (!m) return false;
  return SEAL_WORD_SET.has(m[1].toUpperCase());
}

/* ── Base64URL ────────────────────────────────────────────── */

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (std.length % 4)) % 4;
  const bin = atob(std + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── Byte Helpers ─────────────────────────────────────────── */

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error(`xor length mismatch: ${a.length} vs ${b.length}`);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

async function deriveSealKey(sealCode: string): Promise<Uint8Array> {
  const codeHash = await sha256(TE.encode(sealCode));
  return hkdf(codeHash, ZERO_SALT_32, TE.encode("whisper-seal-bind"), 32);
}

/* ── Encryption ───────────────────────────────────────────── */

export interface SealPayload {
  v: number;   // version
  n: string;   // base64url nonce (12 bytes)
  k: string;   // base64url key_share (32 bytes, XOR-protected)
  c: string;   // base64url ciphertext (AES-256-GCM)
  s: string;   // recipient seal code (for quick-fail check)
  t: number;   // expiry unix-ms (0 = never)
  p: number;   // 1 if extra password was used
}

export async function sealMessage(
  sealCode: string,
  message: string,
  expiryMs: number,
  extraPassword?: string,
): Promise<SealPayload> {
  sealCode = sealCode.trim().toUpperCase();

  const randomKey = randomBytes(32);
  const sealDerived = await deriveSealKey(sealCode);
  const keyShare = xorBytes(randomKey, sealDerived);

  const salt = await sha256(TE.encode(`whisper-seal-v1|${sealCode}`));
  let aesKey = await hkdf(randomKey, salt, TE.encode("whisper-seal-encrypt"), 32);

  if (extraPassword) {
    const pwHash = await sha256(TE.encode(extraPassword));
    const pwDerived = await hkdf(pwHash, salt, TE.encode("whisper-seal-pw"), 32);
    aesKey = xorBytes(aesKey, pwDerived);
  }

  const nonce = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(aesKey, TE.encode(message), nonce);

  return {
    v: 1,
    n: b64url(nonce),
    k: b64url(keyShare),
    c: b64url(ciphertext),
    s: sealCode,
    t: expiryMs > 0 ? Date.now() + expiryMs : 0,
    p: extraPassword ? 1 : 0,
  };
}

/* ── Decryption ───────────────────────────────────────────── */

export type UnsealResult =
  | { ok: true; message: string }
  | { ok: false; reason: "wrong-seal" | "expired" | "password-needed" | "decrypt-failed" };

export async function unsealMessage(
  payload: SealPayload,
  localSealCode: string,
  extraPassword?: string,
): Promise<UnsealResult> {
  localSealCode = localSealCode.trim().toUpperCase();

  if (payload.t > 0 && Date.now() >= payload.t) {
    return { ok: false, reason: "expired" };
  }

  if (payload.s !== localSealCode) {
    return { ok: false, reason: "wrong-seal" };
  }

  if (payload.p === 1 && !extraPassword) {
    return { ok: false, reason: "password-needed" };
  }

  try {
    const sealDerived = await deriveSealKey(localSealCode);
    const keyShare = b64urlDecode(payload.k);
    if (keyShare.length !== 32) throw new Error("invalid key share length");
    const randomKey = xorBytes(keyShare, sealDerived);

    const salt = await sha256(TE.encode(`whisper-seal-v1|${localSealCode}`));
    let aesKey = await hkdf(randomKey, salt, TE.encode("whisper-seal-encrypt"), 32);

    if (extraPassword) {
      const pwHash = await sha256(TE.encode(extraPassword));
      const pwDerived = await hkdf(pwHash, salt, TE.encode("whisper-seal-pw"), 32);
      aesKey = xorBytes(aesKey, pwDerived);
    }

    const nonce = b64urlDecode(payload.n);
    if (nonce.length !== 12) throw new Error("invalid nonce length");
    const ciphertext = b64urlDecode(payload.c);
    const plaintext = await aesGcmDecrypt(aesKey, ciphertext, nonce);

    return { ok: true, message: new TextDecoder().decode(plaintext) };
  } catch {
    return { ok: false, reason: "decrypt-failed" };
  }
}

/* ── URL Encoding ─────────────────────────────────────────── */

export function encodeSealPayload(payload: SealPayload): string {
  return b64url(TE.encode(JSON.stringify(payload)));
}

export function decodeSealPayload(encoded: string): SealPayload | null {
  try {
    const json = new TextDecoder().decode(b64urlDecode(encoded));
    const obj = JSON.parse(json);
    if (obj?.v === 1 &&
        typeof obj.n === "string" && typeof obj.k === "string" &&
        typeof obj.c === "string" && typeof obj.s === "string" &&
        typeof obj.t === "number" && typeof obj.p === "number") {
      return obj as SealPayload;
    }
    return null;
  } catch { return null; }
}

export function buildSealUrl(payload: SealPayload): string {
  return `${window.location.origin}/whisper#ws1:${encodeSealPayload(payload)}`;
}

export function parseSealFragment(): SealPayload | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#ws1:")) return null;
  return decodeSealPayload(hash.slice(5));
}

/* ── Expiry Helpers ───────────────────────────────────────── */

const EXPIRY_LABELS: Record<string, string> = {
  "3600000": "1 hour",
  "86400000": "24 hours",
  "604800000": "7 days",
  "0": "never",
};

export function expiryLabel(ms: number | string): string {
  const key = String(ms);
  if (EXPIRY_LABELS[key]) return EXPIRY_LABELS[key];
  const n = typeof ms === "number" ? ms : parseInt(ms, 10);
  if (Number.isNaN(n) || n <= 0) return "never";
  const mins = Math.round(n / 60_000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(n / 3_600_000);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(n / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"}`;
}
