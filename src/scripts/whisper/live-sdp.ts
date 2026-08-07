// Whisper Live offer/answer codec.
// Stores the browser-produced SDP exactly, optionally gzips it, base64url-encodes it,
// and can seal it with the shared phrase. Transcript canonicalization still uses a
// reduced SDP parse so session binding is stable across harmless candidate ordering.

import { concatBytes, randomBytes } from "./wasm";
import { TE, TD, aesGcmEncrypt, aesGcmDecrypt } from "./live-crypto";
import { derivePhraseScopedKey } from "./live-handshake";

const SDP_SEAL_INFO = TE.encode("whisper-sdp-seal");
const SDP_AAD_PREFIX = "whisper-sdp-seal-aad-v1|";

const FLAG_RAW = 0x00;
const FLAG_GZIP = 0x01;
const FLAG_SEALED = 0x02;

const SUPPORTED_PROTOCOLS = ["udp", "tcp"] as const;
const SUPPORTED_TYPES = ["host", "srflx", "prflx", "relay"] as const;

interface CompactCandidate {
  foundation: string;
  protocol: "udp" | "tcp";
  priority: number;
  ip: string;
  port: number;
  type: "host" | "srflx" | "prflx" | "relay";
  raddr?: string;
  rport?: number;
  tcptype?: string;
}

interface CompactSDP {
  type: "offer" | "answer";
  ufrag: string;
  pwd: string;
  fingerprint: string;
  setup: "active" | "passive" | "actpass";
  candidates: CompactCandidate[];
}

interface EncodedSdpEnvelope {
  v: 2;
  type: "offer" | "answer";
  sdp: string;
}

/**
 * Byte order, not language order.
 *
 * This is a CANONICALIZATION: two peers run it independently over the same
 * candidate set and hash the result into the handshake transcript, so it has to
 * produce identical bytes on both machines or the confirm proof cannot verify.
 * `localeCompare` breaks that by construction — with no locale argument it uses
 * the HOST's, and the two peers are different hosts.
 *
 * It is not theoretical here. Danish and Norwegian collate "aa" as the letter å,
 * which sorts after z, and IPv6 candidates are hex: an address beginning `aa07:`
 * sorts FIRST for an en peer and LAST for a da peer. Measured across realistic
 * candidate values, en and da disagree on 0.053% of comparisons, and a sort of
 * ten candidates spends roughly thirty comparisons, so the per-connection risk
 * is percent-scale rather than negligible. The failure it produces is silent and
 * total: same SDP, different canonical bytes, different transcript hash,
 * "handshake proof mismatch, reconnect to continue".
 *
 * Code-unit comparison is the only order every host already agrees on, and it is
 * what a canonical form needs anyway — these fields are protocol tokens and
 * addresses, not words in anyone's language.
 */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeCompactSDP(compact: CompactSDP): CompactSDP {
  return {
    type: compact.type,
    ufrag: compact.ufrag,
    pwd: compact.pwd,
    fingerprint: compact.fingerprint,
    setup: compact.setup,
    candidates: [...compact.candidates].sort((a, b) => {
      return [
        byteOrder(a.foundation, b.foundation),
        byteOrder(a.protocol, b.protocol),
        a.priority - b.priority,
        byteOrder(a.ip, b.ip),
        a.port - b.port,
        byteOrder(a.type, b.type),
        byteOrder(a.raddr ?? "", b.raddr ?? ""),
        (a.rport ?? 0) - (b.rport ?? 0),
        byteOrder(a.tcptype ?? "", b.tcptype ?? ""),
      ].find((n) => n !== 0) ?? 0;
    }),
  };
}

function compactToBytes(compact: CompactSDP): Uint8Array {
  return TE.encode(JSON.stringify(normalizeCompactSDP(compact)));
}

export function canonicalizeSdpForTranscript(
  sdp: string,
  type: "offer" | "answer",
): Uint8Array {
  const compact = parseSDP(sdp);
  compact.type = type;
  return compactToBytes(compact);
}

function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseSDP(sdp: string): CompactSDP {
  const lines = sdp.split("\r\n");
  let ufrag = "";
  let pwd = "";
  let fingerprint = "";
  let setup: CompactSDP["setup"] = "actpass";
  const candidates: CompactCandidate[] = [];

  for (const line of lines) {
    if (line.startsWith("a=ice-ufrag:")) ufrag = line.slice(12);
    else if (line.startsWith("a=ice-pwd:")) pwd = line.slice(10);
    else if (line.startsWith("a=fingerprint:")) {
      const parts = line.slice(14).split(" ");
      if (parts.length >= 2) fingerprint = parts[1].replace(/:/g, "").toLowerCase();
    } else if (line.startsWith("a=setup:")) {
      const value = line.slice(8);
      if (value === "active" || value === "passive" || value === "actpass") setup = value;
    } else if (line.startsWith("a=candidate:")) {
      const parts = line.slice(12).split(" ");
      if (parts.length < 8) continue;
      const protocol = parts[2].toLowerCase();
      const candidateType = parts[7];
      if (!(SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol)) continue;
      if (!(SUPPORTED_TYPES as readonly string[]).includes(candidateType)) continue;
      const priority = parseInt(parts[3], 10);
      const port = parseInt(parts[5], 10);
      if (!Number.isFinite(priority) || !Number.isFinite(port)) continue;

      const candidate: CompactCandidate = {
        foundation: parts[0],
        protocol: protocol as CompactCandidate["protocol"],
        priority,
        ip: parts[4],
        port,
        type: candidateType as CompactCandidate["type"],
      };

      const raddrIdx = parts.indexOf("raddr");
      const rportIdx = parts.indexOf("rport");
      const tcptypeIdx = parts.indexOf("tcptype");
      if (raddrIdx !== -1 && raddrIdx + 1 < parts.length) candidate.raddr = parts[raddrIdx + 1];
      if (rportIdx !== -1 && rportIdx + 1 < parts.length) {
        const rport = parseInt(parts[rportIdx + 1], 10);
        if (Number.isFinite(rport)) candidate.rport = rport;
      }
      if (protocol === "tcp" && tcptypeIdx !== -1 && tcptypeIdx + 1 < parts.length) {
        candidate.tcptype = parts[tcptypeIdx + 1];
      }
      candidates.push(candidate);
    }
  }

  return { type: "offer", ufrag, pwd, fingerprint, setup, candidates };
}

async function readStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(...chunks);
}

async function compressToBytes(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(raw);
    writer.close();
    const gz = await readStream(cs.readable);
    if (gz.length < raw.length) return concatBytes(new Uint8Array([FLAG_GZIP]), gz);
  }
  return concatBytes(new Uint8Array([FLAG_RAW]), raw);
}

function validateEncodedSdpEnvelope(obj: unknown): EncodedSdpEnvelope {
  if (!obj || typeof obj !== "object") throw new Error("Invalid SDP structure");
  const o = obj as Record<string, unknown>;
  if (o.v !== 2 || (o.type !== "offer" && o.type !== "answer") || typeof o.sdp !== "string") {
    throw new Error("Invalid SDP envelope");
  }
  return {
    v: 2,
    type: o.type,
    sdp: o.sdp,
  };
}

async function decompressFromBytes(data: Uint8Array): Promise<unknown> {
  const flag = data[0];
  const payload = data.subarray(1);

  if (flag === FLAG_GZIP && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(payload);
    writer.close();
    return JSON.parse(TD.decode(await readStream(ds.readable)));
  }

  return JSON.parse(TD.decode(payload));
}

async function sealKeyFromRoot(phraseRoot: Uint8Array): Promise<Uint8Array> {
  return derivePhraseScopedKey(phraseRoot, "sdp-seal", 32, SDP_SEAL_INFO);
}

export async function sdpToCode(
  sdp: string,
  type: "offer" | "answer",
  phraseRoot?: Uint8Array,
): Promise<string> {
  const innerBytes = await compressToBytes(TE.encode(JSON.stringify({
    v: 2,
    type,
    sdp,
  } satisfies EncodedSdpEnvelope)));

  if (phraseRoot) {
    const key = await sealKeyFromRoot(phraseRoot);
    const nonce = randomBytes(12);
    const aad = TE.encode(SDP_AAD_PREFIX + type);
    const ciphertext = await aesGcmEncrypt(key, innerBytes, nonce, aad);
    key.fill(0);
    return base64urlEncode(concatBytes(new Uint8Array([FLAG_SEALED]), nonce, ciphertext));
  }

  return base64urlEncode(innerBytes);
}

export async function codeToSdp(
  code: string,
  type: "offer" | "answer",
  phraseRoot?: Uint8Array,
): Promise<string> {
  const data = base64urlDecode(code);

  if (data.length < 2) throw new Error("Connection code is too short");

  if (data[0] === FLAG_SEALED) {
    if (!phraseRoot) throw new Error("This code is sealed with a shared phrase - enter it to connect");
    if (data.length < 30) throw new Error("Sealed code is truncated");
    const nonce = data.subarray(1, 13);
    const ciphertext = data.subarray(13);
    const key = await sealKeyFromRoot(phraseRoot);
    let innerBytes: Uint8Array;
    try {
      const aad = TE.encode(SDP_AAD_PREFIX + type);
      innerBytes = await aesGcmDecrypt(key, ciphertext, nonce, aad);
    } catch {
      key.fill(0);
      throw new Error("Wrong shared phrase - could not unseal the connection code");
    }
    key.fill(0);
    const envelope = validateEncodedSdpEnvelope(await decompressFromBytes(innerBytes));
    if (envelope.type !== type) throw new Error("Connection code role mismatch");
    return envelope.sdp;
  }

  const envelope = validateEncodedSdpEnvelope(await decompressFromBytes(data));
  if (envelope.type !== type) throw new Error("Connection code role mismatch");
  return envelope.sdp;
}
