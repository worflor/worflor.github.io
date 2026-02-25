// Whisper Live offer/answer codec.
// Parses SDP, strips it to essentials, optionally gzip-compresses, base64url-encodes.
// When a shared phrase is provided, the code is AES-GCM encrypted — the phrase acts
// as a room key that hides ICE candidates, DTLS fingerprints, and all connection metadata.

import { concatBytes, toArrayBuffer, sha256, randomBytes } from "./wasm";
import { TE, TD, hkdf, aesGcmEncrypt, aesGcmDecrypt } from "./live-crypto";

/* ── SDP Sealing Constants ───────────────────────────────── */

const SDP_SEAL_INFO = TE.encode("whisper-sdp-seal");
const SDP_PHRASE_PREFIX = "whisper-phrase|";
const ZERO_SALT_32 = new Uint8Array(32);

/** Flag bytes for wire format */
const FLAG_RAW  = 0x00;
const FLAG_GZIP = 0x01;
const FLAG_SEALED = 0x02;

type CompactSdpSetup = CompactSDP["setup"];
type CompactCandidateProtocol = CompactCandidate["protocol"];
type CompactCandidateType = CompactCandidate["type"];

const SUPPORTED_CANDIDATE_PROTOCOLS: readonly CompactCandidateProtocol[] = ["udp", "tcp"];
const SUPPORTED_CANDIDATE_TYPES: readonly CompactCandidateType[] = ["host", "srflx", "prflx", "relay"];

function isSupportedCandidateProtocol(value: string): value is CompactCandidateProtocol {
  return (SUPPORTED_CANDIDATE_PROTOCOLS as readonly string[]).includes(value);
}

function isSupportedCandidateType(value: string): value is CompactCandidateType {
  return (SUPPORTED_CANDIDATE_TYPES as readonly string[]).includes(value);
}

/* ── Types ───────────────────────────────────────────────── */

interface CompactSDP {
  type: "offer" | "answer";
  ufrag: string;
  pwd: string;
  fingerprint: string; // hex SHA-256
  setup: "active" | "passive" | "actpass";
  candidates: CompactCandidate[];
}

interface CompactCandidate {
  foundation: string;
  protocol: "udp" | "tcp";
  priority: number;
  ip: string;
  port: number;
  type: "host" | "srflx" | "prflx" | "relay";
  raddr?: string;
  rport?: number;
}

/* ── Base64url ───────────────────────────────────────────── */

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

/* ── SDP Parse / Reconstruct ─────────────────────────────── */

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
    }
    else if (line.startsWith("a=setup:")) {
      const value = line.slice(8);
      if (value === "active" || value === "passive" || value === "actpass") {
        setup = value as CompactSdpSetup;
      }
    }
    else if (line.startsWith("a=candidate:")) {
      const parts = line.slice(12).split(" ");
      if (parts.length >= 8) {
        const protocol = parts[2].toLowerCase();
        const candidateType = parts[7];
        if (isSupportedCandidateProtocol(protocol) && isSupportedCandidateType(candidateType)) {
          const c: CompactCandidate = {
            foundation: parts[0],
            protocol,
            priority: parseInt(parts[3], 10),
            ip: parts[4],
            port: parseInt(parts[5], 10),
            type: candidateType,
          };
          // Capture raddr/rport for srflx/prflx/relay candidates
          const raddrIdx = parts.indexOf("raddr");
          const rportIdx = parts.indexOf("rport");
          if (raddrIdx !== -1 && raddrIdx + 1 < parts.length) c.raddr = parts[raddrIdx + 1];
          if (rportIdx !== -1 && rportIdx + 1 < parts.length) c.rport = parseInt(parts[rportIdx + 1], 10);
          candidates.push(c);
        }
      }
    }
  }

  // type is always set by callers (sdpToCode / codeToSdp)
  return { type: "offer", ufrag, pwd, fingerprint, setup, candidates };
}

function reconstructSDP(compact: CompactSDP): string {
  const fp = compact.fingerprint.replace(/(.{2})(?!$)/g, "$1:").toUpperCase();

  const lines: string[] = [
    "v=0",
    "o=- 0 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${compact.ufrag}`,
    `a=ice-pwd:${compact.pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${compact.setup}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];

  for (const c of compact.candidates) {
    let line = `a=candidate:${c.foundation} 1 ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`;
    if (c.raddr != null && c.rport != null) line += ` raddr ${c.raddr} rport ${c.rport}`;
    lines.push(line);
  }

  // Signal that all candidates are included (no trickle)
  lines.push("a=end-of-candidates");

  lines.push("");
  return lines.join("\r\n");
}

/* ── Compress / Decompress (bytes layer) ─────────────────── */

async function compressToBytes(compact: CompactSDP): Promise<Uint8Array> {
  const raw = TE.encode(JSON.stringify(compact));

  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];

    writer.write(raw);
    writer.close();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const gz = concatBytes(...chunks);
    if (gz.length < raw.length) {
      return concatBytes(new Uint8Array([FLAG_GZIP]), gz);
    }
  }

  return concatBytes(new Uint8Array([FLAG_RAW]), raw);
}

async function decompressFromBytes(data: Uint8Array): Promise<CompactSDP> {
  const flag = data[0];
  const payload = data.subarray(1);

  let json: string;
  if (flag === FLAG_GZIP && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];

    writer.write(toArrayBuffer(payload));
    writer.close();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    json = TD.decode(concatBytes(...chunks));
  } else {
    json = TD.decode(payload);
  }

  return JSON.parse(json) as CompactSDP;
}

/* ── SDP Sealing (phrase-based encryption) ───────────────── */

async function deriveSdpKey(phrase: string): Promise<Uint8Array> {
  const phraseHash = await sha256(TE.encode(SDP_PHRASE_PREFIX + phrase));
  const key = await hkdf(phraseHash, ZERO_SALT_32, SDP_SEAL_INFO, 32);
  phraseHash.fill(0);
  return key;
}

/* ── Public API ──────────────────────────────────────────── */

/**
 * Encode SDP to a compact, portable code string.
 * When `phrase` is provided, the code is AES-GCM encrypted — without the phrase
 * the code is opaque (IPs, fingerprints, all metadata hidden).
 */
export async function sdpToCode(
  sdp: string, type: "offer" | "answer", phrase?: string,
): Promise<string> {
  const compact = parseSDP(sdp);
  compact.type = type;
  const innerBytes = await compressToBytes(compact);

  if (phrase) {
    const key = await deriveSdpKey(phrase);
    const nonce = randomBytes(12);
    const ciphertext = await aesGcmEncrypt(key, innerBytes, nonce);
    key.fill(0);
    return base64urlEncode(concatBytes(new Uint8Array([FLAG_SEALED]), nonce, ciphertext));
  }

  return base64urlEncode(innerBytes);
}

/**
 * Decode a compact code string back to SDP.
 * If the code is sealed (encrypted), `phrase` is required — wrong phrase throws a
 * descriptive error so the UI can surface "wrong room code" immediately.
 */
export async function codeToSdp(
  code: string, type: "offer" | "answer", phrase?: string,
): Promise<string> {
  const data = base64urlDecode(code);

  let innerBytes: Uint8Array;

  if (data[0] === FLAG_SEALED) {
    if (!phrase) {
      throw new Error("This code is sealed with a shared phrase — enter it to connect");
    }
    const nonce = data.subarray(1, 13);
    const ciphertext = data.subarray(13);
    const key = await deriveSdpKey(phrase);
    try {
      innerBytes = await aesGcmDecrypt(key, ciphertext, nonce);
    } catch {
      key.fill(0);
      throw new Error("Wrong shared phrase — could not unseal the connection code");
    }
    key.fill(0);
  } else {
    innerBytes = data;
  }

  const compact = await decompressFromBytes(innerBytes);
  compact.type = type;
  return reconstructSDP(compact);
}
