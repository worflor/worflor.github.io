import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "./_helpers/generators.js";
import {
  normalizeSealCodeInput,
  sealPublicKeyToCode,
  parseSealPublicCode,
  isSealCodeValid,
  encodeSealPayload,
  decodeSealPayload,
  expiryLabel,
} from "../../src/scripts/whisper/seal.js";

/** Generate a realistic fake P-256 uncompressed public key using crypto random. */
function cryptoFakeP256(): Uint8Array {
  const buf = randomBytes(65);
  buf[0] = 0x04;
  return buf;
}

describe("seal", () => {
  describe("normalizeSealCodeInput", () => {
    it("strips whitespace, tabs, newlines", () => {
      assert.equal(normalizeSealCodeInput("  WS2:abc  "), "WS2:abc");
      assert.equal(normalizeSealCodeInput("WS2:\tabc\n"), "WS2:abc");
      assert.equal(normalizeSealCodeInput("WS 2: a b c"), "WS2:abc");
    });

    it("strips various whitespace characters", () => {
      assert.equal(normalizeSealCodeInput("\r\n WS2:xyz \r\n"), "WS2:xyz");
      assert.equal(normalizeSealCodeInput("  W  S  2  :  x  y  z  "), "WS2:xyz");
    });

    it("empty string returns empty", () => {
      assert.equal(normalizeSealCodeInput(""), "");
    });

    it("whitespace-only returns empty", () => {
      assert.equal(normalizeSealCodeInput("   "), "");
      assert.equal(normalizeSealCodeInput("\t\n"), "");
    });

    it("no-op for already clean input", () => {
      assert.equal(normalizeSealCodeInput("WS2:abcdef"), "WS2:abcdef");
    });
  });

  describe("sealPublicKeyToCode / parseSealPublicCode", () => {
    it("round-trip with 20 crypto-random P-256 keys", () => {
      for (let i = 0; i < 20; i++) {
        const pubKey = cryptoFakeP256();
        const code = sealPublicKeyToCode(pubKey);
        assert.ok(code.startsWith("WS2:"), `code starts with WS2: iter ${i}`);
        assert.ok(code.length > 10, `code has sufficient length iter ${i}`);

        const parsed = parseSealPublicCode(code);
        assert.ok(parsed, `should parse successfully iter ${i}`);
        assert.equal(parsed!.length, 65, `parsed key is 65 bytes iter ${i}`);
        assert.equal(parsed![0], 0x04, `starts with 0x04 iter ${i}`);

        // Verify every byte matches
        for (let j = 0; j < 65; j++) {
          assert.equal(parsed![j], pubKey[j], `byte ${j} mismatch iter ${i}`);
        }
      }
    });

    it("different keys produce different codes", () => {
      const codes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        codes.add(sealPublicKeyToCode(cryptoFakeP256()));
      }
      assert.equal(codes.size, 10, "all codes should be unique");
    });

    it("code format: WS2: prefix + base64url chars", () => {
      const code = sealPublicKeyToCode(cryptoFakeP256());
      assert.ok(code.startsWith("WS2:"));
      const body = code.slice(4);
      assert.ok(/^[A-Za-z0-9_-]+$/.test(body),
        `code body should be base64url: ${body}`);
    });
  });

  describe("parseSealPublicCode rejects invalid input", () => {
    it("wrong prefix", () => {
      assert.equal(parseSealPublicCode("XX2:abcdef"), null);
      assert.equal(parseSealPublicCode("WS1:abcdef"), null);
      assert.equal(parseSealPublicCode("WS3:abcdef"), null);
      assert.equal(parseSealPublicCode("ws2:abcdef"), null); // case sensitive
    });

    it("bad length (too short)", () => {
      assert.equal(parseSealPublicCode("WS2:abc"), null);
      assert.equal(parseSealPublicCode("WS2:a"), null);
    });

    it("invalid base64url chars", () => {
      assert.equal(parseSealPublicCode("WS2:abc def!@#"), null);
    });

    it("empty after prefix", () => {
      assert.equal(parseSealPublicCode("WS2:"), null);
    });

    it("no prefix at all", () => {
      assert.equal(parseSealPublicCode("justText"), null);
      assert.equal(parseSealPublicCode(""), null);
    });

    it("valid prefix but truncated key data", () => {
      // A valid code needs 65 bytes encoded → ~87 base64url chars
      const shortCode = "WS2:" + "A".repeat(10);
      assert.equal(parseSealPublicCode(shortCode), null);
    });
  });

  describe("isSealCodeValid", () => {
    it("valid codes return true (10 random keys)", () => {
      for (let i = 0; i < 10; i++) {
        const code = sealPublicKeyToCode(cryptoFakeP256());
        assert.equal(isSealCodeValid(code), true, `valid code iter ${i}`);
      }
    });

    it("invalid inputs return false", () => {
      assert.equal(isSealCodeValid("not-a-code"), false);
      assert.equal(isSealCodeValid(""), false);
      assert.equal(isSealCodeValid("WS2:too-short"), false);
      assert.equal(isSealCodeValid("WS1:something"), false);
      assert.equal(isSealCodeValid("random garbage text"), false);
    });
  });

  describe("encodeSealPayload / decodeSealPayload", () => {
    it("round-trip with all fields verified", () => {
      const payload = {
        v: 2 as const,
        epk: "test-epk-value",
        ks: "test-ks-value",
        kn: "test-kn-value",
        k: "test-k-value",
        n: "test-n-value",
        c: "test-c-value",
        rf: "test-rf-value",
        t: 1700000000000,
        p: 0,
      };
      const encoded = encodeSealPayload(payload);
      assert.ok(typeof encoded === "string");
      assert.ok(encoded.length > 0);

      const decoded = decodeSealPayload(encoded);
      assert.ok(decoded, "should decode");
      assert.equal(decoded!.v, 2, "version");
      assert.equal(decoded!.epk, "test-epk-value", "epk");
      assert.equal(decoded!.ks, "test-ks-value", "ks");
      assert.equal(decoded!.kn, "test-kn-value", "kn");
      assert.equal(decoded!.k, "test-k-value", "k");
      assert.equal(decoded!.n, "test-n-value", "n");
      assert.equal(decoded!.c, "test-c-value", "c");
      assert.equal(decoded!.rf, "test-rf-value", "rf");
      assert.equal(decoded!.t, 1700000000000, "timestamp");
      assert.equal(decoded!.p, 0, "password flag");
    });

    it("round-trip with password salt", () => {
      const payload = {
        v: 2 as const,
        epk: "epk",
        ks: "ks",
        kn: "kn",
        k: "k",
        n: "n",
        c: "c",
        rf: "rf",
        t: 0,
        p: 1,
        ps: "pw-salt-value",
      };
      const encoded = encodeSealPayload(payload);
      const decoded = decodeSealPayload(encoded);
      assert.ok(decoded);
      assert.equal(decoded!.p, 1, "password flag");
      assert.equal(decoded!.ps, "pw-salt-value", "password salt");
    });

    it("round-trip 10 payloads with randomized field values", () => {
      for (let i = 0; i < 10; i++) {
        const payload = {
          v: 2 as const,
          epk: `epk-${Math.random().toString(36).slice(2)}`,
          ks: `ks-${Math.random().toString(36).slice(2)}`,
          kn: `kn-${Math.random().toString(36).slice(2)}`,
          k: `k-${Math.random().toString(36).slice(2)}`,
          n: `n-${Math.random().toString(36).slice(2)}`,
          c: `c-${Math.random().toString(36).slice(2)}`,
          rf: `rf-${Math.random().toString(36).slice(2)}`,
          t: Math.floor(Math.random() * 2000000000000),
          p: i % 2,
          ...(i % 2 === 1 ? { ps: `salt-${Math.random().toString(36).slice(2)}` } : {}),
        };
        const encoded = encodeSealPayload(payload);
        const decoded = decodeSealPayload(encoded);
        assert.ok(decoded, `decode iter ${i}`);
        assert.equal(decoded!.v, payload.v, `v iter ${i}`);
        assert.equal(decoded!.epk, payload.epk, `epk iter ${i}`);
        assert.equal(decoded!.ks, payload.ks, `ks iter ${i}`);
        assert.equal(decoded!.kn, payload.kn, `kn iter ${i}`);
        assert.equal(decoded!.k, payload.k, `k iter ${i}`);
        assert.equal(decoded!.n, payload.n, `n iter ${i}`);
        assert.equal(decoded!.c, payload.c, `c iter ${i}`);
        assert.equal(decoded!.rf, payload.rf, `rf iter ${i}`);
        assert.equal(decoded!.t, payload.t, `t iter ${i}`);
        assert.equal(decoded!.p, payload.p, `p iter ${i}`);
        if (payload.p === 1) {
          assert.equal(decoded!.ps, (payload as any).ps, `ps iter ${i}`);
        }
      }
    });

    it("round-trip with edge-case timestamp values", () => {
      for (const t of [0, 1, 1000000000000, 1999999999999, Number.MAX_SAFE_INTEGER]) {
        const payload = {
          v: 2 as const, epk: "e", ks: "k", kn: "n", k: "k", n: "n", c: "c", rf: "r",
          t, p: 0,
        };
        const encoded = encodeSealPayload(payload);
        const decoded = decodeSealPayload(encoded);
        assert.ok(decoded, `decode for t=${t}`);
        assert.equal(decoded!.t, t, `timestamp ${t}`);
      }
    });

    it("rejects invalid encoded data", () => {
      assert.equal(decodeSealPayload("not-valid-base64-json"), null);
      assert.equal(decodeSealPayload(""), null);
      assert.equal(decodeSealPayload("{}"), null);
    });

    it("encoded string is non-empty and contains data", () => {
      const payload = {
        v: 2 as const, epk: "e", ks: "k", kn: "n", k: "k", n: "n", c: "c", rf: "r",
        t: 0, p: 0,
      };
      const encoded = encodeSealPayload(payload);
      assert.ok(encoded.length > 10, "encoded should be substantial");
    });
  });

  describe("expiryLabel", () => {
    it("known duration values", () => {
      assert.equal(expiryLabel(3600000), "1 hour");
      assert.equal(expiryLabel(86400000), "24 hours");
      assert.equal(expiryLabel(604800000), "7 days");
      assert.equal(expiryLabel(0), "never");
    });

    it("string input coercion", () => {
      assert.equal(expiryLabel("3600000"), "1 hour");
      assert.equal(expiryLabel("86400000"), "24 hours");
      assert.equal(expiryLabel("604800000"), "7 days");
      assert.equal(expiryLabel("0"), "never");
    });

    it("custom durations", () => {
      assert.equal(expiryLabel(30000), "30 sec");
      assert.equal(expiryLabel(60000), "1 min");
      assert.equal(expiryLabel(120000), "2 min");
      assert.equal(expiryLabel(7200000), "2 hours");
      assert.equal(expiryLabel(172800000), "2 days");
    });

    it("returns non-empty string for various inputs", () => {
      for (const ms of [1000, 5000, 15000, 45000, 90000, 300000, 1800000, 43200000]) {
        const label = expiryLabel(ms);
        assert.ok(typeof label === "string" && label.length > 0,
          `expiryLabel(${ms}) should return non-empty string, got "${label}"`);
      }
    });
  });
});
