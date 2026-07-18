import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLocalSdp,
  packLocalSdp,
  unpackLocalSdp,
} from "../../src/scripts/whisper/live-qr-sdp.js";

// a realistic host-only datachannel offer, shaped exactly like a real browser
// emits (mDNS .local candidates, no STUN). the bin-roundtrip experiment proved
// a browser connects on an SDP rebuilt from this shape, including regenerated
// candidate fields.
const OFFER_SDP = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:NqSY",
  "a=ice-pwd:XV9c/8I1kXi7AWErRjHQrHn6",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 FA:E8:2C:1C:31:82:90:FA:E3:11:4F:96:62:6F:82:03:EF:C5:DB:FE:0E:62:03:DE:73:42:FB:A0:7A:F4:16:C7",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "a=candidate:1975898434 1 udp 2113937151 4f68329d-c667-4438-9328-c77fd7334304.local 52223 typ host generation 0 network-cost 999",
  "a=candidate:4048671092 1 udp 2113939711 8a41676a-cfd7-4097-8c05-6029076564b6.local 52225 typ host generation 0 network-cost 999",
].join("\r\n") + "\r\n";

const ANSWER_SDP = OFFER_SDP.replace("a=setup:actpass", "a=setup:active");
const EXPECTED_FP = "fae82c1c318290fae3114f96626f8203efc5dbfe0e6203de7342fba07af416c7";

describe("live-qr-sdp", () => {
  describe("extractLocalSdp", () => {
    it("pulls fingerprint, credentials, setup, and host candidates", () => {
      const p = extractLocalSdp(OFFER_SDP, true);
      assert.equal(p.fingerprint, EXPECTED_FP);
      assert.equal(p.fingerprint.length, 64);
      assert.equal(p.ufrag, "NqSY");
      assert.equal(p.pwd, "XV9c/8I1kXi7AWErRjHQrHn6");
      assert.equal(p.setup, "actpass");
      assert.equal(p.candidates.length, 2);
    });

    it("keeps only host candidates (drops srflx/relay)", () => {
      const withSrflx = OFFER_SDP.replace(
        /a=candidate:4048671092[^\r\n]+/,
        "a=candidate:842163049 1 udp 1677729535 203.0.113.7 52226 typ srflx raddr 0.0.0.0 rport 0",
      );
      const p = extractLocalSdp(withSrflx, true);
      assert.equal(p.candidates.length, 1);
      assert.ok(p.candidates[0].includes("typ host"));
    });

    it("throws on an SDP with no fingerprint", () => {
      assert.throws(() => extractLocalSdp(OFFER_SDP.replace(/a=fingerprint:[^\r\n]+\r\n/, ""), true), /fingerprint/);
    });

    it("throws on an SDP with no host candidates", () => {
      assert.throws(() => extractLocalSdp(OFFER_SDP.replace(/a=candidate:[^\r\n]+\r\n/g, ""), true), /host candidate/);
    });
  });

  describe("pack / unpack roundtrip", () => {
    it("offer survives pack -> unpack with every field intact", () => {
      const out = unpackLocalSdp(packLocalSdp(OFFER_SDP, true));
      assert.equal(out.type, "offer");
      assert.equal(out.parts.fingerprint, EXPECTED_FP);
      assert.equal(out.parts.ufrag, "NqSY");
      assert.equal(out.parts.pwd, "XV9c/8I1kXi7AWErRjHQrHn6");
      assert.equal(out.parts.setup, "actpass");
      assert.equal(out.parts.candidates.length, 2);
      // rebuilt SDP is well-formed and carries the fingerprint back
      assert.ok(out.sdp.includes(`a=fingerprint:sha-256 ${EXPECTED_FP.match(/.{2}/g)!.join(":").toUpperCase()}`));
      assert.ok(out.sdp.includes("a=ice-ufrag:NqSY"));
      assert.ok(out.sdp.includes("a=setup:actpass"));
      assert.ok(out.sdp.includes("webrtc-datachannel"));
    });

    it("the mDNS uuid + port survive the pack, foundation/priority regenerated", () => {
      const out = unpackLocalSdp(packLocalSdp(OFFER_SDP, true));
      // the load-bearing address + port must be exact
      assert.ok(out.parts.candidates[0].includes("4f68329d-c667-4438-9328-c77fd7334304.local 52223 typ host"));
      assert.ok(out.parts.candidates[1].includes("8a41676a-cfd7-4097-8c05-6029076564b6.local 52225 typ host"));
      // the regenerated cruft is gone (smaller wire), connection-irrelevant
      assert.ok(!out.parts.candidates[0].includes("network-cost"));
    });

    it("answer roundtrips with the active setup role", () => {
      const out = unpackLocalSdp(packLocalSdp(ANSWER_SDP, false));
      assert.equal(out.type, "answer");
      assert.equal(out.parts.setup, "active");
      assert.ok(out.sdp.includes("a=setup:active"));
    });

    it("an IPv4 host candidate packs to 4 bytes and rebuilds exactly", () => {
      const ipv4Sdp = OFFER_SDP
        .replace(/a=candidate:1975898434[^\r\n]+/, "a=candidate:1975898434 1 udp 2113937151 192.168.1.42 51000 typ host generation 0")
        .replace(/a=candidate:4048671092[^\r\n]+\r\n/, "");
      const out = unpackLocalSdp(packLocalSdp(ipv4Sdp, true));
      assert.ok(out.parts.candidates[0].includes("192.168.1.42 51000 typ host"));
    });

    it("an unusual candidate (tcp) rides through as a raw string, not lost", () => {
      const tcpSdp = OFFER_SDP.replace(
        /a=candidate:1975898434[^\r\n]+/,
        "a=candidate:9 1 tcp 1518280447 192.168.1.42 9 typ host tcptype active",
      );
      const out = unpackLocalSdp(packLocalSdp(tcpSdp, true));
      // raw fallback preserves it verbatim
      assert.ok(out.parts.candidates.some((c) => c.includes("tcp 1518280447 192.168.1.42 9 typ host tcptype active")));
    });

    it("the payload is small enough for one QR and much smaller than a naive strip", () => {
      const payload = packLocalSdp(OFFER_SDP, true);
      assert.ok(payload.length < 200, `packed payload ${payload.length} chars should be ~100-160`);
    });

    it("fingerprint bytes survive the pack exactly, every byte value", () => {
      const allBytes = Array.from({ length: 32 }, (_, i) => (i * 8 + 3) & 0xff);
      const hex = allBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      const colon = (hex.match(/.{2}/g) as string[]).join(":").toUpperCase();
      const sdp = OFFER_SDP.replace(/a=fingerprint:sha-256 [0-9A-F:]+/, `a=fingerprint:sha-256 ${colon}`);
      const out = unpackLocalSdp(packLocalSdp(sdp, true));
      assert.equal(out.parts.fingerprint, hex);
    });
  });

  describe("payload validation", () => {
    it("rejects a version mismatch loudly", () => {
      const bytes = Buffer.from(packLocalSdp(OFFER_SDP, true).replace(/-/g, "+").replace(/_/g, "/"), "base64");
      bytes[0] = 0x02; // corrupt the version byte
      const bad = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      assert.throws(() => unpackLocalSdp(bad), /version mismatch|older whisper/);
    });

    it("rejects a truncated payload", () => {
      const payload = packLocalSdp(OFFER_SDP, true);
      assert.throws(() => unpackLocalSdp(payload.slice(0, 8)), /truncated|candidates|fingerprint/);
    });

    it("rejects invalid base64url", () => {
      assert.throws(() => unpackLocalSdp("not valid!!! base64url"), /invalid base64url/);
    });
  });
});
