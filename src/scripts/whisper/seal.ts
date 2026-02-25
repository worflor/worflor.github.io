// Whisper Seal — crypto engine.
// WS2-only recipient public-key sealing (ECDH P-256 + AES-GCM).
// Local private identity key is fingerprint-protected at rest in IndexedDB.

import { sha256, randomBytes, toArrayBuffer } from "./wasm";
import { hkdf, aesGcmEncrypt, aesGcmDecrypt, TE, TD } from "./live-crypto";

const WS2_PREFIX = "WS2:";
const WS2_DB_NAME = "whisper-seal";
const WS2_DB_VERSION = 2;
const WS2_DB_STORE = "identity";
const WS2_DB_KEY = "default";
const P256_PUBLIC_KEY_LEN = 65;
const P256_UNCOMPRESSED_PREFIX = 0x04;

const HKDF_INFO_IDENTITY_WRAP = TE.encode("whisper-seal-v2-identity-wrap");
const HKDF_INFO_WRAP = TE.encode("whisper-seal-v2-wrap");
const HKDF_INFO_PASSWORD = TE.encode("whisper-seal-v2-pw");
const HKDF_INFO_MESSAGE = TE.encode("whisper-seal-v2-message");

/** Minimum time (ms) to hold spinner for "My Seal" generation UX. */
export const COMPUTE_MIN_DISPLAY_MS = 600;

interface SealIdentityRecord {
  publicKeyRaw: Uint8Array;
  privateKey: CryptoKey;
}

interface SealIdentityStored {
  publicKeyRaw: Uint8Array;
  privateKeyCipher: Uint8Array;
  wrapSalt: Uint8Array;
  wrapNonce: Uint8Array;
}

export interface SealIdentity {
  code: string;
  fingerprint: string;
}

let identityCache: SealIdentityRecord | null = null;

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
    ctx.fillText("Whisper Seal 🔒", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("Whisper Seal 🔒", 4, 17);
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

/** Browser fingerprint digest used to protect local identity private key at rest. */
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

/* ── Seal Code Helpers ───────────────────────────────────── */

export function normalizeSealCodeInput(code: string): string {
  return code.replace(/\s+/g, "").trim();
}

function normalizeSealCode(code: string): string {
  return normalizeSealCodeInput(code);
}

export function sealPublicKeyToCode(publicKeyRaw: Uint8Array): string {
  return `${WS2_PREFIX}${b64url(publicKeyRaw)}`;
}

export function parseSealPublicCode(code: string): Uint8Array | null {
  const normalized = normalizeSealCode(code);
  const prefix = normalized.slice(0, 4).toUpperCase();
  if (prefix !== WS2_PREFIX) return null;
  const encoded = normalized.slice(4);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;

  try {
    const raw = b64urlDecode(encoded);
    if (raw.length !== P256_PUBLIC_KEY_LEN || raw[0] !== P256_UNCOMPRESSED_PREFIX) return null;
    return raw;
  } catch {
    return null;
  }
}

export function isSealCodeValid(code: string): boolean {
  return parseSealPublicCode(code) !== null;
}

/* ── Base64URL ───────────────────────────────────────────── */

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

/* ── Identity Fingerprints ───────────────────────────────── */

async function fingerprintFromPublicKey(publicKeyRaw: Uint8Array): Promise<Uint8Array> {
  return sha256(TE.encode(`whisper-seal-v2-pub:${b64url(publicKeyRaw)}`));
}

async function recipientFingerprintId(publicKeyRaw: Uint8Array): Promise<string> {
  const hash = await fingerprintFromPublicKey(publicKeyRaw);
  return b64url(hash.subarray(0, 10));
}

/* ── IndexedDB Storage ───────────────────────────────────── */

async function openSealDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WS2_DB_NAME, WS2_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WS2_DB_STORE)) {
        db.createObjectStore(WS2_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function getIdentityWrapAad(publicKeyRaw: Uint8Array): Uint8Array {
  return TE.encode(`ws2|identity|${b64url(publicKeyRaw)}`);
}

async function deriveIdentityWrapKey(fingerprintHash: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return hkdf(fingerprintHash, salt, HKDF_INFO_IDENTITY_WRAP, 32);
}

async function loadIdentityStoredFromDb(): Promise<SealIdentityStored | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openSealDb();
  try {
    return await new Promise<SealIdentityStored | null>((resolve, reject) => {
      const tx = db.transaction(WS2_DB_STORE, "readonly");
      const store = tx.objectStore(WS2_DB_STORE);
      const req = store.get(WS2_DB_KEY);

      req.onsuccess = () => {
        const value = req.result as {
          publicKeyRaw?: Uint8Array;
          privateKeyCipher?: Uint8Array;
          wrapSalt?: Uint8Array;
          wrapNonce?: Uint8Array;
        } | undefined;

        if (!value?.publicKeyRaw || !value?.privateKeyCipher || !value?.wrapSalt || !value?.wrapNonce) {
          resolve(null);
          return;
        }

        resolve({
          publicKeyRaw: new Uint8Array(value.publicKeyRaw),
          privateKeyCipher: new Uint8Array(value.privateKeyCipher),
          wrapSalt: new Uint8Array(value.wrapSalt),
          wrapNonce: new Uint8Array(value.wrapNonce),
        });
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
    });
  } finally {
    db.close();
  }
}

async function saveIdentityStoredToDb(record: SealIdentityStored): Promise<void> {
  if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");

  const db = await openSealDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WS2_DB_STORE, "readwrite");
      const store = tx.objectStore(WS2_DB_STORE);
      store.put({
        publicKeyRaw: record.publicKeyRaw,
        privateKeyCipher: record.privateKeyCipher,
        wrapSalt: record.wrapSalt,
        wrapNonce: record.wrapNonce,
      }, WS2_DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  } finally {
    db.close();
  }
}

async function unwrapIdentityPrivateKey(stored: SealIdentityStored): Promise<CryptoKey | null> {
  let fp: Uint8Array | null = null;
  let wrapKey: Uint8Array | null = null;
  let privatePkcs8: Uint8Array | null = null;
  try {
    fp = await computeFingerprint();
    wrapKey = await deriveIdentityWrapKey(fp, stored.wrapSalt);
    const aad = getIdentityWrapAad(stored.publicKeyRaw);
    privatePkcs8 = await aesGcmDecrypt(wrapKey, stored.privateKeyCipher, stored.wrapNonce, aad);

    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(privatePkcs8),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );

    return privateKey;
  } catch {
    return null;
  } finally {
    if (fp) fp.fill(0);
    if (wrapKey) wrapKey.fill(0);
    if (privatePkcs8) privatePkcs8.fill(0);
  }
}

async function loadIdentityRecordFromDb(): Promise<SealIdentityRecord | null> {
  const stored = await loadIdentityStoredFromDb();
  if (!stored) return null;

  const privateKey = await unwrapIdentityPrivateKey(stored);
  if (!privateKey) return null;

  return {
    publicKeyRaw: stored.publicKeyRaw,
    privateKey,
  };
}

async function generateIdentityRecord(): Promise<SealIdentityRecord> {
  const fp = await computeFingerprint();

  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );

  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(privatePkcs8),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );

  const wrapSalt = randomBytes(16);
  const wrapNonce = randomBytes(12);
  const wrapKey = await deriveIdentityWrapKey(fp, wrapSalt);
  const aad = getIdentityWrapAad(publicKeyRaw);
  const privateKeyCipher = await aesGcmEncrypt(wrapKey, privatePkcs8, wrapNonce, aad);

  fp.fill(0);
  wrapKey.fill(0);
  privatePkcs8.fill(0);

  await saveIdentityStoredToDb({ publicKeyRaw, privateKeyCipher, wrapSalt, wrapNonce });

  return { publicKeyRaw, privateKey };
}

async function getOrCreateIdentityRecord(): Promise<SealIdentityRecord> {
  if (identityCache) return identityCache;

  const existing = await loadIdentityRecordFromDb();
  if (existing) {
    identityCache = existing;
    return existing;
  }

  const created = await generateIdentityRecord();
  identityCache = created;
  return created;
}

async function getExistingIdentityRecord(): Promise<SealIdentityRecord | null> {
  if (identityCache) return identityCache;
  const existing = await loadIdentityRecordFromDb();
  if (existing) identityCache = existing;
  return existing;
}

async function identityToView(record: SealIdentityRecord): Promise<SealIdentity> {
  return {
    code: sealPublicKeyToCode(record.publicKeyRaw),
    fingerprint: await recipientFingerprintId(record.publicKeyRaw),
  };
}

export async function getOrCreateSealIdentity(): Promise<SealIdentity> {
  const record = await getOrCreateIdentityRecord();
  return identityToView(record);
}

export async function getExistingSealIdentity(): Promise<SealIdentity | null> {
  const record = await getExistingIdentityRecord();
  if (!record) return null;
  return identityToView(record);
}

/* ── ECDH Helpers ────────────────────────────────────────── */

async function importP256PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

async function deriveEcdh(privateKey: CryptoKey, peerPublicRaw: Uint8Array): Promise<Uint8Array> {
  const peerKey = await importP256PublicKey(peerPublicRaw);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

/* ── Payload (WS2 only) ──────────────────────────────────── */

export interface SealPayload {
  v: 2;
  epk: string;
  ks: string;
  kn: string;
  k: string;
  n: string;
  c: string;
  rf: string;
  t: number;
  p: number;
  ps?: string;
}

function buildAADv2(mode: "wrap" | "msg", rf: string, t: number, p: number): Uint8Array {
  return TE.encode(`ws2|${mode}|${rf}|${t}|${p}`);
}

export async function sealMessage(
  recipientSealCode: string,
  message: string,
  expiryMs: number,
  extraPassword?: string,
): Promise<SealPayload> {
  const recipientPublicRaw = parseSealPublicCode(recipientSealCode);
  if (!recipientPublicRaw) throw new Error("invalid recipient seal code");

  let shared: Uint8Array | null = null;
  let wrapKey: Uint8Array | null = null;
  let contentKey: Uint8Array | null = null;
  let messageKey: Uint8Array | null = null;

  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const ephPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  try {
    shared = await deriveEcdh(eph.privateKey, recipientPublicRaw);

    const ks = randomBytes(16);
    const kn = randomBytes(12);
    wrapKey = await hkdf(shared, ks, HKDF_INFO_WRAP, 32);

    contentKey = randomBytes(32);
    messageKey = contentKey;

    const t = expiryMs > 0 ? Date.now() + expiryMs : 0;
    const p = extraPassword ? 1 : 0;
    const rf = await recipientFingerprintId(recipientPublicRaw);

    let pwSalt: Uint8Array | null = null;
    if (extraPassword) {
      pwSalt = randomBytes(16);
      const pwHash = await sha256(TE.encode(extraPassword));
      const pwKey = await hkdf(pwHash, pwSalt, HKDF_INFO_PASSWORD, 32);
      messageKey = await hkdf(contentKey, pwKey, HKDF_INFO_MESSAGE, 32);
      pwHash.fill(0);
      pwKey.fill(0);
    }

    const aadWrap = buildAADv2("wrap", rf, t, p);
    const wrappedKey = await aesGcmEncrypt(wrapKey, contentKey, kn, aadWrap);

    const n = randomBytes(12);
    const aadMsg = buildAADv2("msg", rf, t, p);
    const ciphertext = await aesGcmEncrypt(messageKey, TE.encode(message), n, aadMsg);

    return {
      v: 2,
      epk: b64url(ephPublicRaw),
      ks: b64url(ks),
      kn: b64url(kn),
      k: b64url(wrappedKey),
      n: b64url(n),
      c: b64url(ciphertext),
      rf,
      t,
      p,
      ...(pwSalt ? { ps: b64url(pwSalt) } : {}),
    };
  } finally {
    if (shared) shared.fill(0);
    if (wrapKey) wrapKey.fill(0);
    if (contentKey) contentKey.fill(0);
    if (messageKey && messageKey !== contentKey) messageKey.fill(0);
  }
}

/* ── Decryption ──────────────────────────────────────────── */

export type UnsealResult =
  | { ok: true; message: string }
  | { ok: false; reason: "wrong-seal" | "expired" | "password-needed" | "decrypt-failed" | "identity-missing" };

export async function unsealMessage(payload: SealPayload, extraPassword?: string): Promise<UnsealResult> {
  if (payload.v !== 2) {
    return { ok: false, reason: "decrypt-failed" };
  }
  if (payload.p !== 0 && payload.p !== 1) {
    return { ok: false, reason: "decrypt-failed" };
  }
  if (payload.t > 0 && Date.now() >= payload.t) {
    return { ok: false, reason: "expired" };
  }

  if (payload.p === 1 && !extraPassword) {
    return { ok: false, reason: "password-needed" };
  }

  const identity = await getExistingIdentityRecord();
  if (!identity) {
    return { ok: false, reason: "identity-missing" };
  }

  const localRf = await recipientFingerprintId(identity.publicKeyRaw);
  if (localRf !== payload.rf) {
    return { ok: false, reason: "wrong-seal" };
  }

  let shared: Uint8Array | null = null;
  let wrapKey: Uint8Array | null = null;
  let contentKey: Uint8Array | null = null;
  let messageKey: Uint8Array | null = null;

  try {
    const peerEpk = b64urlDecode(payload.epk);
    if (peerEpk.length !== P256_PUBLIC_KEY_LEN || peerEpk[0] !== P256_UNCOMPRESSED_PREFIX) {
      throw new Error("invalid ephemeral key");
    }

    shared = await deriveEcdh(identity.privateKey, peerEpk);

    const ks = b64urlDecode(payload.ks);
    if (ks.length < 8) throw new Error("invalid wrap salt");
    const kn = b64urlDecode(payload.kn);
    if (kn.length !== 12) throw new Error("invalid wrap nonce");

    wrapKey = await hkdf(shared, ks, HKDF_INFO_WRAP, 32);
    const wrapped = b64urlDecode(payload.k);
    const aadWrap = buildAADv2("wrap", payload.rf, payload.t, payload.p);
    contentKey = await aesGcmDecrypt(wrapKey, wrapped, kn, aadWrap);

    messageKey = contentKey;
    if (payload.p === 1) {
      if (!payload.ps) throw new Error("missing password salt");
      const ps = b64urlDecode(payload.ps);
      const pwHash = await sha256(TE.encode(extraPassword ?? ""));
      const pwKey = await hkdf(pwHash, ps, HKDF_INFO_PASSWORD, 32);
      messageKey = await hkdf(contentKey, pwKey, HKDF_INFO_MESSAGE, 32);
      pwHash.fill(0);
      pwKey.fill(0);
    }

    const n = b64urlDecode(payload.n);
    if (n.length !== 12) throw new Error("invalid nonce");
    const c = b64urlDecode(payload.c);
    const aadMsg = buildAADv2("msg", payload.rf, payload.t, payload.p);
    const plaintext = await aesGcmDecrypt(messageKey, c, n, aadMsg);

    return { ok: true, message: TD.decode(plaintext) };
  } catch {
    return { ok: false, reason: "decrypt-failed" };
  } finally {
    if (shared) shared.fill(0);
    if (wrapKey) wrapKey.fill(0);
    if (contentKey) contentKey.fill(0);
    if (messageKey && messageKey !== contentKey) messageKey.fill(0);
  }
}

/* ── URL Encoding ────────────────────────────────────────── */

export function encodeSealPayload(payload: SealPayload): string {
  return b64url(TE.encode(JSON.stringify(payload)));
}

export function decodeSealPayload(encoded: string): SealPayload | null {
  try {
    const json = TD.decode(b64urlDecode(encoded));
    const obj = JSON.parse(json);

    if (obj?.v !== 2) return null;
    if (typeof obj.p !== "number" || (obj.p !== 0 && obj.p !== 1)) return null;
    if (typeof obj.t !== "number" || !Number.isFinite(obj.t) || obj.t < 0) return null;

    if (obj?.v === 2 &&
      typeof obj.epk === "string" && typeof obj.ks === "string" &&
      typeof obj.kn === "string" && typeof obj.k === "string" &&
      typeof obj.n === "string" && typeof obj.c === "string" &&
      typeof obj.rf === "string" && obj.rf.length > 0 &&
      (obj.p === 0 ? typeof obj.ps === "undefined" || typeof obj.ps === "string" : typeof obj.ps === "string")) {
      return obj as SealPayload;
    }
    return null;
  } catch { return null; }
}

export function buildSealUrl(payload: SealPayload): string {
  return `${window.location.origin}/whisper#ws2:${encodeSealPayload(payload)}`;
}

export function parseSealFragment(): SealPayload | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#ws2:")) return null;
  return decodeSealPayload(hash.slice(5));
}

/* ── Expiry Helpers ──────────────────────────────────────── */

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
