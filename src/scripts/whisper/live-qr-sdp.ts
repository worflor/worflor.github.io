/**
 * live-qr-sdp.ts
 *
 * pure-local pairing. two people in the same room, no server and no phrase:
 * the QR code is the rendezvous, and because it carries the DTLS fingerprint
 * it is also the authenticated channel. an attacker cannot substitute their
 * own fingerprint without physically replacing what is on the screen you are
 * looking at, so the visual channel is MITM-proof by proximity — strictly
 * stronger than a relayed handshake, which is why the in-person flow can skip
 * the emoji verify ceremony entirely.
 *
 * this module is the codec: it strips a full WebRTC SDP down to the handful
 * of fields that actually matter, packs them tightly, and rebuilds a valid
 * SDP on the far side.
 *
 * the packing is the real win. a full offer is ~716 chars; naively stripped
 * it is ~316; but the .local candidate is mostly a random UUID (16 bytes
 * wearing 36 hex-and-dash chars) plus regenerable cruft (foundation,
 * priority, "generation 0 network-cost 999"). packing the UUID back to its
 * raw bytes, the port to two bytes, and regenerating the cruft on rebuild
 * drops the payload to ~100 bytes. rendered as base64url text (scan-safe on
 * every reader, no binary-QR gamble) that is a QR version 8 instead of 13 —
 * the modules are half again as large, which across a table in poor light is
 * the difference between an instant scan and a fumble.
 *
 * proven end to end: a browser opens a live datachannel on an SDP rebuilt
 * from this payload, including the regenerated candidate fields (scratchpad
 * bin-roundtrip experiment).
 *
 * the host candidates arrive as mDNS .local names (browsers mask host IPs for
 * privacy, non-overridable). they resolve over multicast DNS on the LAN,
 * which is exactly the "same network, no greater internet" contract; only AP
 * isolation breaks it, and that breaks every local approach equally.
 *
 * this module is pure: no DOM, no RTCPeerConnection, no network. string in,
 * string out. the live connection is proven separately.
 */

// bump when the binary format changes so an old QR against a new build fails
// loudly instead of half-parsing.
const FORMAT_VERSION = 0x01;

const TE = new TextEncoder();
const TD = new TextDecoder();

const SETUP_CODE: Record<string, number> = { actpass: 0, active: 1, passive: 2 };
const SETUP_NAME = ["actpass", "active", "passive"];

// candidate address encodings.
const ADDR_MDNS = 0; // <uuid>.local -> 16 raw bytes
const ADDR_IPV4 = 1; // dotted quad  -> 4 raw bytes
const ADDR_RAW = 2;  // anything else -> the full candidate text, length-prefixed

export interface LocalSdpParts {
  isOffer: boolean;
  /** sha-256 DTLS fingerprint, 64 lowercase hex chars, colons removed. */
  fingerprint: string;
  ufrag: string;
  pwd: string;
  /** actpass (offer) | active | passive (answer). */
  setup: string;
  /** raw candidate strings, each the text after "a=candidate:". */
  candidates: string[];
}

const HEX_RE = /^[0-9a-f]{64}$/;
const UUID_LOCAL_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// --- base64url over raw bytes ---

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToB64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const rem = bytes.length - i;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | (b >> 4)];
    if (rem > 1) out += B64URL[((b & 15) << 2) | (c >> 6)];
    if (rem > 2) out += B64URL[c & 63];
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) lookup[B64URL.charCodeAt(i)] = i;
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = lookup[ch.charCodeAt(0)];
    if (v < 0) throw new Error("live-qr-sdp: invalid base64url in payload");
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

// --- a tiny byte writer / reader ---

class ByteWriter {
  private buf: number[] = [];
  u8(n: number): void { this.buf.push(n & 0xff); }
  u16le(n: number): void { this.buf.push(n & 0xff, (n >> 8) & 0xff); }
  bytes(b: Uint8Array): void { for (const x of b) this.buf.push(x); }
  lenStr(s: string): void { const b = TE.encode(s); if (b.length > 255) throw new Error("live-qr-sdp: field too long"); this.u8(b.length); this.bytes(b); }
  hex(hex: string): void { for (let i = 0; i < hex.length; i += 2) this.buf.push(parseInt(hex.slice(i, i + 2), 16)); }
  done(): Uint8Array { return new Uint8Array(this.buf); }
}

class ByteReader {
  private o = 0;
  constructor(private b: Uint8Array) {}
  u8(): number { if (this.o >= this.b.length) throw new Error("live-qr-sdp: payload truncated"); return this.b[this.o++]; }
  u16le(): number { const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  bytes(n: number): Uint8Array { const s = this.b.subarray(this.o, this.o + n); if (s.length !== n) throw new Error("live-qr-sdp: payload truncated"); this.o += n; return s; }
  lenStr(): string { return TD.decode(this.bytes(this.u8())); }
  hex(n: number): string { let s = ""; for (const x of this.bytes(n)) s += x.toString(16).padStart(2, "0"); return s; }
}

// --- extraction ---

/** pull the load-bearing fields out of a full SDP. throws if the SDP is
 *  missing anything a connection cannot form without. */
export function extractLocalSdp(sdp: string, isOffer: boolean): LocalSdpParts {
  const one = (re: RegExp, name: string): string => {
    const m = sdp.match(re);
    if (!m || !m[1]) throw new Error(`live-qr-sdp: SDP missing ${name}`);
    return m[1];
  };
  const fingerprint = one(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/, "fingerprint").replace(/:/g, "").toLowerCase();
  if (!HEX_RE.test(fingerprint)) throw new Error("live-qr-sdp: fingerprint is not 32 bytes");

  const candidates = [...sdp.matchAll(/a=candidate:(\S[^\r\n]*)/g)]
    .map((m) => m[1].trim())
    .filter((c) => /\btyp host\b/.test(c)); // host candidates only: this is the LAN path
  if (candidates.length === 0) throw new Error("live-qr-sdp: no host candidates (not gathered yet?)");

  return {
    isOffer,
    fingerprint,
    ufrag: one(/a=ice-ufrag:(\S+)/, "ice-ufrag"),
    pwd: one(/a=ice-pwd:(\S+)/, "ice-pwd"),
    setup: one(/a=setup:(\S+)/, "setup"),
    candidates,
  };
}

// --- candidate pack / rebuild ---

interface CandidateFields { foundation: string; component: string; transport: string; priority: string; address: string; port: number; }

function parseCandidate(cand: string): CandidateFields | null {
  const p = cand.split(/\s+/);
  // foundation component transport priority address port typ host ...
  if (p.length < 8 || p[6] !== "typ" || p[7] !== "host") return null;
  const port = Number(p[5]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { foundation: p[0], component: p[1], transport: p[2], priority: p[3], address: p[4], port };
}

function writeCandidate(w: ByteWriter, cand: string): void {
  const f = parseCandidate(cand);
  // aggressively pack only the common shape (udp host, component 1); anything
  // unusual (tcp, extra components, IPv6) rides through as a raw string so the
  // codec never loses a candidate it does not fully understand.
  if (f && f.component === "1" && f.transport.toLowerCase() === "udp") {
    const mdns = f.address.match(UUID_LOCAL_RE);
    const ipv4 = f.address.match(IPV4_RE);
    if (mdns) {
      w.u8(ADDR_MDNS);
      w.hex((mdns[1] + mdns[2] + mdns[3] + mdns[4] + mdns[5]).toLowerCase());
      w.u16le(f.port);
      return;
    }
    if (ipv4 && ipv4.slice(1).every((n) => Number(n) <= 255)) {
      w.u8(ADDR_IPV4);
      for (let i = 1; i <= 4; i++) w.u8(Number(ipv4[i]));
      w.u16le(f.port);
      return;
    }
  }
  w.u8(ADDR_RAW);
  w.lenStr(cand);
}

function readCandidate(r: ByteReader, index: number): string {
  const type = r.u8();
  if (type === ADDR_RAW) return r.lenStr();
  // regenerate the fields the pack dropped: foundation just needs to be a
  // unique-ish token, priority a valid host priority; neither affects a
  // single-path host connection (proven in bin-roundtrip).
  const foundation = String(1_000_000 + index);
  const priority = "2113937151";
  let address: string;
  if (type === ADDR_MDNS) {
    const h = r.hex(16);
    address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  } else if (type === ADDR_IPV4) {
    const b = r.bytes(4);
    address = `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  } else {
    throw new Error(`live-qr-sdp: unknown candidate type ${type}`);
  }
  const port = r.u16le();
  return `${foundation} 1 udp ${priority} ${address} ${port} typ host`;
}

// --- pack / unpack ---

/** pack a full SDP into the compact base64url QR payload. */
export function packLocalSdp(sdp: string, isOffer: boolean): string {
  const p = extractLocalSdp(sdp, isOffer);
  const w = new ByteWriter();
  w.u8(FORMAT_VERSION);
  w.u8(isOffer ? 1 : 0);
  w.hex(p.fingerprint); // 32 bytes
  w.lenStr(p.ufrag);
  w.lenStr(p.pwd);
  const setupCode = SETUP_CODE[p.setup];
  if (setupCode === undefined) throw new Error(`live-qr-sdp: unknown setup role ${p.setup}`);
  w.u8(setupCode);
  if (p.candidates.length > 255) throw new Error("live-qr-sdp: too many candidates");
  w.u8(p.candidates.length);
  for (const c of p.candidates) writeCandidate(w, c);
  return bytesToB64url(w.done());
}

export interface UnpackedSdp {
  type: "offer" | "answer";
  sdp: string;
  parts: LocalSdpParts;
}

/** rebuild a valid SDP from a QR payload. the template is the minimal
 *  datachannel-only session a real browser accepts and connects on. */
export function unpackLocalSdp(payload: string): UnpackedSdp {
  const r = new ByteReader(b64urlToBytes(payload));
  const ver = r.u8();
  if (ver !== FORMAT_VERSION) throw new Error(`live-qr-sdp: version mismatch (got ${ver}) — one of you is on an older whisper, refresh`);
  const isOffer = r.u8() === 1;
  const fingerprint = r.hex(32);
  if (!HEX_RE.test(fingerprint)) throw new Error("live-qr-sdp: fingerprint decode failed");
  const ufrag = r.lenStr();
  const pwd = r.lenStr();
  const setupCode = r.u8();
  const setup = SETUP_NAME[setupCode];
  if (!setup) throw new Error("live-qr-sdp: bad setup role");
  const candCount = r.u8();
  if (candCount === 0) throw new Error("live-qr-sdp: payload carried no candidates");
  const candidates: string[] = [];
  for (let i = 0; i < candCount; i++) candidates.push(readCandidate(r, i));

  const fpColon = (fingerprint.match(/.{2}/g) as string[]).join(":").toUpperCase();
  const lines = [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    "a=ice-options:trickle",
    `a=fingerprint:sha-256 ${fpColon}`,
    `a=setup:${setup}`,
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    ...candidates.map((c) => `a=candidate:${c}`),
  ];

  return {
    type: isOffer ? "offer" : "answer",
    sdp: lines.join("\r\n") + "\r\n",
    parts: { isOffer, fingerprint, ufrag, pwd, setup, candidates },
  };
}
