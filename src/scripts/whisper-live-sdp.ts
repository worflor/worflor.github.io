// Whisper Live offer/answer codec.
// Parses SDP, strips it to essentials, optionally gzip-compresses, base64url-encodes.

import { concatBytes, toArrayBuffer } from "./whisper-wasm";
import { TE, TD } from "./whisper-live-crypto";

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
    }
    else if (line.startsWith("a=setup:")) setup = line.slice(8) as CompactSDP["setup"];
    else if (line.startsWith("a=candidate:")) {
      const parts = line.slice(12).split(" ");
      if (parts.length >= 8) {
        const protocol = parts[2].toLowerCase();
        const candidateType = parts[7];
        if ((protocol === "udp" || protocol === "tcp") &&
          (candidateType === "host" || candidateType === "srflx" || candidateType === "prflx" || candidateType === "relay")) {
          candidates.push({
            foundation: parts[0],
            protocol: protocol as "udp" | "tcp",
            priority: parseInt(parts[3], 10),
            ip: parts[4],
            port: parseInt(parts[5], 10),
            type: candidateType as CompactCandidate["type"],
          });
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
    lines.push(
      `a=candidate:${c.foundation} 1 ${c.protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`,
    );
  }

  lines.push("");
  return lines.join("\r\n");
}

async function compress(compact: CompactSDP): Promise<string> {
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
      return base64urlEncode(concatBytes(new Uint8Array([0x01]), gz));
    }
  }

  return base64urlEncode(concatBytes(new Uint8Array([0x00]), raw));
}

async function decompress(code: string): Promise<CompactSDP> {
  const data = base64urlDecode(code);
  const flag = data[0];
  const payload = data.subarray(1);

  let json: string;
  if (flag === 0x01 && typeof DecompressionStream !== "undefined") {
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

export async function sdpToCode(sdp: string, type: "offer" | "answer"): Promise<string> {
  const compact = parseSDP(sdp);
  compact.type = type;
  return compress(compact);
}

export async function codeToSdp(code: string, type: "offer" | "answer"): Promise<string> {
  const compact = await decompress(code);
  compact.type = type;
  return reconstructSDP(compact);
}
