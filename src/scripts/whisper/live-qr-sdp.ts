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
 * of fields that actually matter (fingerprint, ICE credentials, setup role,
 * host candidates) and rebuilds a valid SDP on the far side. a real offer is
 * ~716 chars; stripped and packed it is ~350 bytes, so it fits one QR (a
 * v25-M code holds ~1850) with room to spare. proven end to end: an SDP
 * rebuilt from this payload establishes a live datachannel (scratchpad
 * sdp-roundtrip experiment).
 *
 * the host candidates come back as mDNS .local names (browsers mask host IPs
 * for privacy, non-overridable). they resolve over multicast DNS on the LAN,
 * which is exactly the "same network, no greater internet" contract. only AP
 * isolation (guest-wifi client firewalling) breaks it, and that breaks every
 * local approach equally; one device hotspotting the other sidesteps it.
 *
 * this module is pure: no DOM, no RTCPeerConnection, no network. it is string
 * in, string out, so it unit-tests without a browser. the live connection is
 * proven separately.
 */

// bump when the wire format changes so an old QR against a new build fails
// loudly instead of half-parsing.
const PAYLOAD_VERSION = "WQ1";

// field and candidate delimiters. neither character ever appears inside an
// SDP fingerprint, ICE credential, setup token, or candidate line, so they
// are safe unescaped separators.
const FIELD_SEP = "|";
const CAND_SEP = "~";

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
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// --- fingerprint hex <-> base64url (32 raw bytes: 64 hex -> 43 b64url) ---

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const rem = bytes.length - i;
    out += B64URL_ALPHABET[a >> 2];
    out += B64URL_ALPHABET[((a & 3) << 4) | (b >> 4)];
    if (rem > 1) out += B64URL_ALPHABET[((b & 15) << 2) | (c >> 6)];
    if (rem > 2) out += B64URL_ALPHABET[c & 63];
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) lookup[B64URL_ALPHABET.charCodeAt(i)] = i;
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = lookup[ch.charCodeAt(0)];
    if (v < 0) throw new Error("live-qr-sdp: invalid base64url in fingerprint");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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
  const fingerprint = one(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/, "fingerprint")
    .replace(/:/g, "").toLowerCase();
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

// --- pack / unpack ---

/** pack a full SDP into the compact QR payload string. */
export function packLocalSdp(sdp: string, isOffer: boolean): string {
  const p = extractLocalSdp(sdp, isOffer);
  const fpB64 = bytesToB64url(hexToBytes(p.fingerprint));
  return [
    PAYLOAD_VERSION,
    isOffer ? "O" : "A",
    fpB64,
    p.ufrag,
    p.pwd,
    p.setup,
    p.candidates.join(CAND_SEP),
  ].join(FIELD_SEP);
}

export interface UnpackedSdp {
  type: "offer" | "answer";
  sdp: string;
  parts: LocalSdpParts;
}

/** rebuild a valid SDP from a QR payload. the template is the minimal
 *  datachannel-only session that a real browser accepts and connects on
 *  (proven in the roundtrip experiment). */
export function unpackLocalSdp(payload: string): UnpackedSdp {
  const fields = payload.split(FIELD_SEP);
  if (fields.length !== 7) throw new Error("live-qr-sdp: malformed payload (field count)");
  const [ver, role, fpB64, ufrag, pwd, setup, candBlob] = fields;
  if (ver !== PAYLOAD_VERSION) throw new Error(`live-qr-sdp: version mismatch (got ${ver}) — one of you is on an older whisper, refresh`);
  if (role !== "O" && role !== "A") throw new Error("live-qr-sdp: bad role");
  if (setup !== "actpass" && setup !== "active" && setup !== "passive") throw new Error("live-qr-sdp: bad setup role");

  const fingerprint = bytesToHex(b64urlToBytes(fpB64));
  if (!HEX_RE.test(fingerprint)) throw new Error("live-qr-sdp: fingerprint decode failed");
  const fpColon = (fingerprint.match(/.{2}/g) as string[]).join(":").toUpperCase();

  const candidates = candBlob ? candBlob.split(CAND_SEP).filter(Boolean) : [];
  if (candidates.length === 0) throw new Error("live-qr-sdp: payload carried no candidates");

  const isOffer = role === "O";
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
