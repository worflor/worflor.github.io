import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractLocalSdp,
  packLocalSdp,
  unpackLocalSdp,
} from "../../src/scripts/whisper/live-qr-sdp.js";

// a realistic host-only datachannel offer, shaped exactly like a real browser
// emits (mDNS .local candidates, no STUN). the roundtrip experiment proved a
// browser connects on an SDP rebuilt from this shape.
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

describe("live-qr-sdp", () => {
  describe("extractLocalSdp", () => {
    it("pulls fingerprint, credentials, setup, and host candidates", () => {
      const p = extractLocalSdp(OFFER_SDP, true);
      assert.equal(p.isOffer, true);
      assert.equal(p.fingerprint, "fae82c1c318290fae3114f96626f8203efc5dbfe0e6203de7342fba07af416c7");
      assert.equal(p.fingerprint.length, 64);
      assert.equal(p.ufrag, "NqSY");
      assert.equal(p.pwd, "XV9c/8I1kXi7AWErRjHQrHn6");
      assert.equal(p.setup, "actpass");
      assert.equal(p.candidates.length, 2);
      assert.ok(p.candidates[0].includes("typ host"));
    });

    it("keeps only host candidates (drops srflx/relay)", () => {
      const withSrflx = OFFER_SDP.replace(
        "a=candidate:4048671092 1 udp 2113939711 8a41676a-cfd7-4097-8c05-6029076564b6.local 52225 typ host generation 0 network-cost 999",
        "a=candidate:842163049 1 udp 1677729535 203.0.113.7 52226 typ srflx raddr 0.0.0.0 rport 0",
      );
      const p = extractLocalSdp(withSrflx, true);
      assert.equal(p.candidates.length, 1, "srflx candidate is dropped, only host remains");
      assert.ok(p.candidates[0].includes("typ host"));
    });

    it("throws on an SDP with no fingerprint", () => {
      assert.throws(() => extractLocalSdp(OFFER_SDP.replace(/a=fingerprint:[^\r\n]+\r\n/, ""), true), /fingerprint/);
    });

    it("throws on an SDP with no host candidates (not gathered yet)", () => {
      const noCands = OFFER_SDP.replace(/a=candidate:[^\r\n]+\r\n/g, "");
      assert.throws(() => extractLocalSdp(noCands, true), /host candidate/);
    });
  });

  describe("pack / unpack roundtrip", () => {
    it("offer survives pack -> unpack with every field intact", () => {
      const payload = packLocalSdp(OFFER_SDP, true);
      const out = unpackLocalSdp(payload);
      assert.equal(out.type, "offer");
      assert.equal(out.parts.fingerprint, "fae82c1c318290fae3114f96626f8203efc5dbfe0e6203de7342fba07af416c7");
      assert.equal(out.parts.ufrag, "NqSY");
      assert.equal(out.parts.pwd, "XV9c/8I1kXi7AWErRjHQrHn6");
      assert.equal(out.parts.setup, "actpass");
      assert.equal(out.parts.candidates.length, 2);
      // the rebuilt SDP carries the fingerprint back in colon-hex form
      assert.ok(out.sdp.includes("a=fingerprint:sha-256 FA:E8:2C:1C:31:82:90:FA:E3:11:4F:96:62:6F:82:03:EF:C5:DB:FE:0E:62:03:DE:73:42:FB:A0:7A:F4:16:C7"));
      assert.ok(out.sdp.includes("a=ice-ufrag:NqSY"));
      assert.ok(out.sdp.includes("a=setup:actpass"));
      assert.ok(out.sdp.includes("webrtc-datachannel"));
      assert.ok(out.sdp.includes(".local 52223 typ host"));
    });

    it("answer roundtrips with the active setup role", () => {
      const out = unpackLocalSdp(packLocalSdp(ANSWER_SDP, false));
      assert.equal(out.type, "answer");
      assert.equal(out.parts.setup, "active");
      assert.ok(out.sdp.includes("a=setup:active"));
    });

    it("the payload is small enough for one QR (< 1800 bytes)", () => {
      const payload = packLocalSdp(OFFER_SDP, true);
      assert.ok(payload.length < 1800, `payload ${payload.length} bytes must fit a v25-M QR`);
      // and in practice well under 500
      assert.ok(payload.length < 500, `payload ${payload.length} bytes is comfortably compact`);
    });

    it("fingerprint packs to base64url (shorter than colon-hex)", () => {
      const payload = packLocalSdp(OFFER_SDP, true);
      // 32 bytes -> 43 base64url chars, vs 95 chars as colon-hex
      assert.ok(payload.includes("|"), "field-delimited");
      assert.ok(!payload.includes(":"), "no colon-hex fingerprint in the payload");
    });
  });

  describe("payload validation", () => {
    it("rejects a version mismatch loudly", () => {
      const payload = packLocalSdp(OFFER_SDP, true).replace(/^WQ1/, "WQ0");
      assert.throws(() => unpackLocalSdp(payload), /version mismatch|older whisper/);
    });

    it("rejects a wrong field count", () => {
      assert.throws(() => unpackLocalSdp("WQ1|O|abc"), /malformed/);
    });

    it("rejects a bad setup role", () => {
      const payload = packLocalSdp(OFFER_SDP, true).replace("|actpass|", "|sideways|");
      assert.throws(() => unpackLocalSdp(payload), /setup role/);
    });

    it("rejects a payload with no candidates", () => {
      const fields = packLocalSdp(OFFER_SDP, true).split("|");
      fields[6] = "";
      assert.throws(() => unpackLocalSdp(fields.join("|")), /no candidates/);
    });

    it("fingerprint bytes survive the base64url round trip exactly", () => {
      // every byte value, so no alphabet/padding edge is missed
      const allBytes = Array.from({ length: 32 }, (_, i) => (i * 8 + 3) & 0xff);
      const hex = allBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      const colon = (hex.match(/.{2}/g) as string[]).join(":").toUpperCase();
      const sdp = OFFER_SDP.replace(/a=fingerprint:sha-256 [0-9A-F:]+/, `a=fingerprint:sha-256 ${colon}`);
      const out = unpackLocalSdp(packLocalSdp(sdp, true));
      assert.equal(out.parts.fingerprint, hex);
    });
  });
});
