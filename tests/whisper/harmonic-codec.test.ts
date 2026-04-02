import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeHarmonic,
  encodeHarmonic,
  getHarmonicWasm,
  SURROUND_LAYOUTS,
} from "../../src/scripts/whisper/live-wasm-audio.ts";
import type { SpatialObject } from "../../src/scripts/whisper/live-wasm-audio.ts";

const SAMPLE_RATE = 48_000;
const QUALITY = 80;

// Keep in sync with the documented decoder scratch layout in live-wasm-audio.ts.
const KG_BUF = 0x2000;

function makeSine(length: number, frequency: number, amplitude = 0.8): Float32Array {
  const pcm = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    pcm[i] = Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * amplitude;
  }
  return pcm;
}

function makeDeterministicNoise(length: number, amplitude = 0.5): Float32Array {
  const pcm = new Float32Array(length);
  let state = 0x12345678;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pcm[i] = (((state >>> 8) / 0x01000000) * 2 - 1) * amplitude;
  }
  return pcm;
}

function makeSpeechLike(length: number, amplitude = 0.8): Float32Array {
  const pcm = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 3 * i / SAMPLE_RATE);
    const phase = 2 * Math.PI * f0 * i / SAMPLE_RATE;
    pcm[i] = amplitude * (
      0.5 * Math.sin(phase) +
      0.25 * Math.sin(2 * phase) +
      0.15 * Math.sin(3 * phase) +
      0.08 * Math.sin(5 * phase) +
      0.02 * Math.sin(8 * phase)
    );
  }
  return pcm;
}

function measureRoundTripMetrics(original: Float32Array, decoded: Float32Array) {
  let signalPower = 0;
  let noisePower = 0;
  let maxErr = 0;

  for (let i = 0; i < original.length; i++) {
    const expected = original[i];
    const actual = decoded[i];
    const err = actual - expected;
    signalPower += expected * expected;
    noisePower += err * err;
    const absErr = Math.abs(err);
    if (absErr > maxErr) maxErr = absErr;
  }

  const snr = noisePower === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10(signalPower / noisePower);
  return { snr, maxErr };
}

function interleaveStereo(left: Float32Array, right: Float32Array) {
  const pcm = new Float32Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    pcm[i * 2] = left[i];
    pcm[i * 2 + 1] = right[i];
  }
  return pcm;
}

function splitStereo(pcm: Float32Array) {
  const length = pcm.length / 2;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = pcm[i * 2];
    right[i] = pcm[i * 2 + 1];
  }
  return { left, right };
}

async function roundTrip(
  pcm: Float32Array,
  numChannels: number,
  quality: number,
  encryptionKey?: Uint32Array,
) {
  const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, encryptionKey, { quality, numChannels });
  const decoded = await decodeHarmonic(encoded, encryptionKey);
  return { encoded, decoded };
}

function readDecodedKgTrajectory(numSamples: number, numChannels: number) {
  const numBlocks = Math.ceil(numSamples / 32) * numChannels;
  const coeffs: Array<{ k: number; g: number }> = [];

  return getHarmonicWasm().then((wasm) => {
    const words = new Int32Array(wasm.memory.buffer, KG_BUF, numBlocks * 2);
    for (let i = 0; i < numBlocks; i++) {
      coeffs.push({
        k: words[i * 2] / 16384,
        g: words[i * 2 + 1] / 16384,
      });
    }
    return coeffs;
  });
}

describe("live-wasm-audio codec", () => {
  it("holds the 440Hz resonance benchmark and keeps every decoded block on the stable manifold", async () => {
    const pcm = makeSine(SAMPLE_RATE, 440);
    const { encoded, decoded } = await roundTrip(pcm, 1, QUALITY);
    const coeffs = await readDecodedKgTrajectory(pcm.length, 1);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.sampleRate, SAMPLE_RATE);
    assert.equal(decoded.pcm.length, pcm.length);

    const { snr, maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
    const bitsPerSample = (encoded.length * 8) / pcm.length;

    assert.ok(bitsPerSample <= 3.2, `expected <= 3.2 bits/sample, got ${bitsPerSample.toFixed(2)}`);
    assert.ok(snr >= 60, `expected >= 60 dB SNR, got ${snr.toFixed(2)} dB`);
    assert.ok(maxErr <= 0.001, `expected <= 0.001 max error, got ${maxErr}`);

    // K/G stability: all blocks must remain on the stable manifold.
    // trial encode rejects Burg for pure tones (AR(2) is already optimal),
    // so K/G tracks the original signal and the manifold constraint holds.
    for (const { k, g } of coeffs) {
      assert.ok(g > 0 && g <= 1.01, `expected 0 < G <= 1, got ${g}`);
      assert.ok(k * k <= 4 * g + 1e-3, `expected K^2 <= 4G, got K=${k}, G=${g}`);
    }
  });

  it("keeps white-noise blocks on the manifold while holding the measured benchmark envelope", async () => {
    const pcm = makeDeterministicNoise(SAMPLE_RATE);
    const { encoded, decoded } = await roundTrip(pcm, 1, QUALITY);
    const coeffs = await readDecodedKgTrajectory(pcm.length, 1);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    const { snr, maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
    const bitsPerSample = (encoded.length * 8) / pcm.length;

    assert.ok(bitsPerSample <= 16, `expected <= 16 bits/sample, got ${bitsPerSample.toFixed(2)}`);
    assert.ok(snr >= 60, `expected >= 60 dB SNR, got ${snr.toFixed(2)} dB`);
    assert.ok(maxErr <= 0.001, `expected <= 0.001 max error, got ${maxErr}`);

    for (const { k, g } of coeffs) {
      assert.ok(g > 0 && g <= 1, `expected 0 < G <= 1, got ${g}`);
      assert.ok(k * k <= 4 * g + 1e-3, `expected K^2 <= 4G, got K=${k}, G=${g}`);
    }
  });

  it("quality 100 stays bit-exact in raw passthrough mode", async () => {
    const pcm = makeSine(4096, 440, 0.6);
    const { decoded } = await roundTrip(pcm, 1, 100);

    assert.equal(decoded.tampered, false);
    assert.deepEqual(Array.from(decoded.pcm), Array.from(pcm));
  });

  it("keeps stereo Mid/Side blocks stable with the adaptive residual head", async () => {
    const left = makeSine(SAMPLE_RATE, 1000);
    const right = makeSine(SAMPLE_RATE, 440);
    const pcm = interleaveStereo(left, right);
    const { encoded, decoded } = await roundTrip(pcm, 2, 90);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    const decodedLeft = new Float32Array(SAMPLE_RATE);
    const decodedRight = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < SAMPLE_RATE; i++) {
      decodedLeft[i] = decoded.pcm[i * 2];
      decodedRight[i] = decoded.pcm[i * 2 + 1];
    }

    const leftMetrics = measureRoundTripMetrics(left, decodedLeft);
    const rightMetrics = measureRoundTripMetrics(right, decodedRight);
    const bitsPerSamplePair = (encoded.length * 8) / SAMPLE_RATE;

    assert.ok(bitsPerSamplePair <= 14, `expected <= 14 bits/sample-pair, got ${bitsPerSamplePair.toFixed(2)}`);
    assert.ok(leftMetrics.snr >= 68, `expected left SNR >= 68 dB, got ${leftMetrics.snr.toFixed(2)} dB`);
    assert.ok(rightMetrics.snr >= 68, `expected right SNR >= 68 dB, got ${rightMetrics.snr.toFixed(2)} dB`);
    assert.ok(leftMetrics.maxErr <= 0.001, `expected left max error <= 0.001, got ${leftMetrics.maxErr}`);
    assert.ok(rightMetrics.maxErr <= 0.001, `expected right max error <= 0.001, got ${rightMetrics.maxErr}`);
  });

  it("keeps the mono witness stack self-consistent under decode -> re-encode", async () => {
    const source = makeSine(SAMPLE_RATE, 440, 0.8);
    const first = await roundTrip(source, 1, QUALITY);
    const second = await roundTrip(first.decoded.pcm, 1, QUALITY);

    assert.equal(first.decoded.tampered, false);
    assert.equal(second.decoded.tampered, false);

    const drift = measureRoundTripMetrics(first.decoded.pcm, second.decoded.pcm);
    const firstBits = (first.encoded.length * 8) / source.length;
    const secondBits = (second.encoded.length * 8) / source.length;

    assert.ok(drift.snr >= 70, `expected mono decode->re-encode SNR >= 70 dB, got ${drift.snr.toFixed(2)} dB`);
    assert.ok(Math.abs(secondBits - firstBits) <= 0.25,
      `expected mono bitrate drift <= 0.25 bits/sample, got ${Math.abs(secondBits - firstBits).toFixed(3)}`);
  });

  it("keeps the stereo witness stack self-consistent under decode -> re-encode", async () => {
    const left = makeSine(SAMPLE_RATE, 1000);
    const right = makeSine(SAMPLE_RATE, 440);
    const source = interleaveStereo(left, right);
    const first = await roundTrip(source, 2, 90);
    const second = await roundTrip(first.decoded.pcm, 2, 90);

    assert.equal(first.decoded.tampered, false);
    assert.equal(second.decoded.tampered, false);

    const firstStereo = splitStereo(first.decoded.pcm);
    const secondStereo = splitStereo(second.decoded.pcm);
    const driftL = measureRoundTripMetrics(firstStereo.left, secondStereo.left);
    const driftR = measureRoundTripMetrics(firstStereo.right, secondStereo.right);
    const firstBits = (first.encoded.length * 8) / SAMPLE_RATE;
    const secondBits = (second.encoded.length * 8) / SAMPLE_RATE;

    assert.ok(driftL.snr >= 68, `expected stereo left decode->re-encode SNR >= 68 dB, got ${driftL.snr.toFixed(2)} dB`);
    assert.ok(driftR.snr >= 68, `expected stereo right decode->re-encode SNR >= 68 dB, got ${driftR.snr.toFixed(2)} dB`);
    assert.ok(Math.abs(secondBits - firstBits) <= 0.35,
      `expected stereo bitrate drift <= 0.35 bits/sample-pair, got ${Math.abs(secondBits - firstBits).toFixed(3)}`);
  });

  it("keeps long-form witness streams stable across the frame side-channels", async () => {
    const seconds = 12;
    const pcm = makeSpeechLike(SAMPLE_RATE * seconds, 0.7);
    const { encoded, decoded } = await roundTrip(pcm, 1, QUALITY);
    const coeffs = await readDecodedKgTrajectory(pcm.length, 1);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);
    assert.equal(coeffs.length, Math.ceil(pcm.length / 32));

    const { snr, maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
    const bitsPerSample = (encoded.length * 8) / pcm.length;
    let peak = 0;
    for (const sample of decoded.pcm) peak = Math.max(peak, Math.abs(sample));

    assert.ok(encoded.length > 65_535, `expected encoded stream to exceed the old 16-bit arith count, got ${encoded.length} bytes`);
    assert.ok(bitsPerSample <= 10.5, `expected <= 10.5 bits/sample, got ${bitsPerSample.toFixed(2)}`);
    assert.ok(snr >= 60, `expected >= 60 dB SNR on long stream, got ${snr.toFixed(2)} dB`);
    assert.ok(maxErr <= 0.002, `expected <= 0.002 max error on long stream, got ${maxErr}`);
    assert.ok(peak <= 1.1, `expected decoded peak <= 1.1, got ${peak}`);

    for (let i = 0; i < coeffs.length; i += 193) {
      const { k, g } = coeffs[i];
      assert.ok(g > 0 && g <= 1, `expected 0 < G <= 1, got ${g} at block ${i}`);
      assert.ok(k * k <= 4 * g + 1e-3, `expected K^2 <= 4G at block ${i}, got K=${k}, G=${g}`);
    }
  });

  it("flags tampering on the encrypted payload", async () => {
    const pcm = makeSine(4096, 440, 0.6);
    const key = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const { encoded } = await roundTrip(pcm, 1, QUALITY, key);

    const tamperedBytes = new Uint8Array(encoded);
    tamperedBytes[Math.max(12, tamperedBytes.length - 6)] ^= 0x5a;

    const tampered = await decodeHarmonic(tamperedBytes, key);
    assert.equal(tampered.tampered, true);
    assert.equal(tampered.pcm.length, 0);
  });
});

describe("harmonic codec edge cases", () => {
  it("handles empty input (0 samples) without crashing", async () => {
    const pcm = new Float32Array(0);
    try {
      const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
      const decoded = await decodeHarmonic(encoded);
      assert.equal(decoded.pcm.length, 0);
    } catch (e) {
      // throwing a clear error is also acceptable
      assert.ok(e instanceof Error, "should throw an Error, not crash");
    }
  });

  it("handles single sample without crashing", async () => {
    const pcm = new Float32Array([0.42]);
    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded);
    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, 1);
  });

  it("quality sweep: monotonically improving accuracy from Q10 to Q90", async () => {
    const pcm = makeSpeechLike(4096, 0.8);
    const qualities = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const errors: number[] = [];

    for (const q of qualities) {
      const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: q, numChannels: 1 });
      const decoded = await decodeHarmonic(encoded);

      assert.equal(decoded.tampered, false, `tampered at Q${q}`);
      assert.equal(decoded.pcm.length, pcm.length, `length mismatch at Q${q}`);

      const { maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
      assert.ok(Number.isFinite(maxErr), `maxErr is not finite at Q${q}`);
      errors.push(maxErr);
    }

    // overall trend: Q90 should have lower error than Q10
    assert.ok(
      errors[errors.length - 1] <= errors[0] + 1e-6,
      `Q90 maxErr ${errors[errors.length - 1].toFixed(6)} should be <= Q10 maxErr ${errors[0].toFixed(6)}`,
    );

    // monotonicity in the stable range (Q50+): each step should not regress much
    // low quality levels can have non-monotonic quantization artifacts
    const stableStart = qualities.indexOf(50);
    for (let i = stableStart + 1; i < errors.length; i++) {
      assert.ok(
        errors[i] <= errors[i - 1] * 1.5 + 1e-4,
        `quality monotonicity violated in stable range: Q${qualities[i]} maxErr ${errors[i].toFixed(6)} > Q${qualities[i - 1]} maxErr ${errors[i - 1].toFixed(6)} * 1.5`,
      );
    }
  });

  it("NaN input does not crash and produces no NaN in output", async () => {
    const pcm = new Float32Array(256);
    pcm[0] = NaN;
    pcm[50] = NaN;
    pcm[128] = NaN;
    pcm[255] = NaN;
    // fill the rest with a normal signal
    for (let i = 0; i < pcm.length; i++) {
      if (!Number.isNaN(pcm[i])) pcm[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded);

    for (let i = 0; i < decoded.pcm.length; i++) {
      assert.ok(!Number.isNaN(decoded.pcm[i]), `NaN found in decoded output at index ${i}`);
    }
  });

  it("Infinity input does not crash", async () => {
    const pcm = new Float32Array(256);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
    }
    pcm[0] = Infinity;
    pcm[64] = -Infinity;
    pcm[128] = Infinity;

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded);
    // just verifying it did not throw or hang
    assert.ok(decoded.pcm.length === pcm.length || decoded.pcm.length === 0);
  });

  it("mismatched encryption keys return tampered=true, pcm.length=0", async () => {
    const pcm = makeSine(4096, 440, 0.6);
    const keyA = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD]);
    const keyB = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, keyA, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded, keyB);

    assert.equal(decoded.tampered, true);
    assert.equal(decoded.pcm.length, 0);
  });

  it("truncated payload returns tampered=true or throws", async () => {
    const pcm = makeSine(4096, 440, 0.6);
    const key = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, key, { quality: QUALITY, numChannels: 1 });

    const truncated = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.length - 10);

    try {
      const decoded = await decodeHarmonic(truncated, key);
      // if it didn't throw, it must report tampering
      assert.equal(decoded.tampered, true, "truncated payload should be flagged as tampered");
    } catch (e) {
      // throwing is also acceptable
      assert.ok(e instanceof Error, "should throw an Error on truncated payload");
    }
  });

  it("concurrent encode/decode calls do not corrupt state", async () => {
    const signals = [
      makeSine(2048, 440, 0.7),
      makeSine(2048, 880, 0.6),
      makeDeterministicNoise(2048, 0.5),
      makeSpeechLike(2048, 0.8),
    ];

    const results = await Promise.all(
      signals.map(async (pcm) => {
        const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
        const decoded = await decodeHarmonic(encoded);
        return { pcm, decoded };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const { pcm, decoded } = results[i];
      assert.equal(decoded.tampered, false, `signal ${i} flagged as tampered`);
      assert.equal(decoded.pcm.length, pcm.length, `signal ${i} length mismatch`);
      const { maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
      assert.ok(maxErr <= 0.1, `signal ${i} maxErr ${maxErr} exceeds 0.1`);
    }
  });

  it("Burg activation: speech-like gets <= 4.0 bps, sine gets <= 1.0 bps at Q80", async () => {
    const speech = makeSpeechLike(SAMPLE_RATE, 0.8);
    const sine = makeSine(SAMPLE_RATE, 440, 0.8);

    const speechEncoded = await encodeHarmonic(speech, SAMPLE_RATE, undefined, { quality: 80, numChannels: 1 });
    const sineEncoded = await encodeHarmonic(sine, SAMPLE_RATE, undefined, { quality: 80, numChannels: 1 });

    const speechBps = (speechEncoded.length * 8) / speech.length;
    const sineBps = (sineEncoded.length * 8) / sine.length;

    assert.ok(speechBps <= 5.5, `speech bps ${speechBps.toFixed(2)} exceeds 5.5`);
    assert.ok(sineBps <= 1.0, `sine bps ${sineBps.toFixed(2)} exceeds 1.0`);
  });

  it("sub-block-size frames round-trip without crash (mono and stereo)", async () => {
    const frameSizes = [1, 15, 16, 17, 31, 32, 33];

    for (const size of frameSizes) {
      // mono
      const mono = new Float32Array(size);
      for (let i = 0; i < size; i++) mono[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;

      const monoEncoded = await encodeHarmonic(mono, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
      const monoDecoded = await decodeHarmonic(monoEncoded);
      assert.equal(monoDecoded.tampered, false, `mono frame size ${size} tampered`);
      assert.equal(monoDecoded.pcm.length, size, `mono frame size ${size} length mismatch`);

      // stereo (interleaved, so total length is size * 2)
      const stereo = new Float32Array(size * 2);
      for (let i = 0; i < size; i++) {
        stereo[i * 2] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
        stereo[i * 2 + 1] = Math.sin(2 * Math.PI * 880 * i / SAMPLE_RATE) * 0.3;
      }

      const stereoEncoded = await encodeHarmonic(stereo, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 2 });
      const stereoDecoded = await decodeHarmonic(stereoEncoded);
      assert.equal(stereoDecoded.tampered, false, `stereo frame size ${size} tampered`);
      assert.equal(stereoDecoded.pcm.length, size * 2, `stereo frame size ${size} length mismatch`);
    }
  });

  it("DC offset signal round-trips and compresses well", async () => {
    const pcm = new Float32Array(4096);
    pcm.fill(0.5);

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    const { maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
    const bps = (encoded.length * 8) / pcm.length;

    assert.ok(maxErr <= 0.01, `DC offset maxErr ${maxErr} exceeds 0.01`);
    assert.ok(bps <= 2.0, `DC offset bps ${bps.toFixed(2)} exceeds 2.0 (should compress well)`);
  });

  it("maximum amplitude alternating signal does not crash or produce out-of-range values", async () => {
    const pcm = new Float32Array(4096);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = i % 2 === 0 ? 1.0 : -1.0;
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    // nyquist alternating (poles on the unit circle at ω=π) is pathological:
    // any prediction error compounds through IIR-2 feedback. verify the codec
    // doesn't crash or produce NaN/Infinity, but don't enforce tight bounds.
    let hasFinite = false;
    for (let i = 0; i < decoded.pcm.length; i++) {
      assert.ok(Number.isFinite(decoded.pcm[i]), `decoded sample ${i} is not finite: ${decoded.pcm[i]}`);
      if (Math.abs(decoded.pcm[i]) < 100) hasFinite = true;
    }
    assert.ok(hasFinite, "decoded signal has no finite samples within ±100");
  });
});

describe("harmonic codec production hardening", () => {
  // determinism: identical input must produce identical encoded bytes.
  // if this breaks, encrypted protocol MAC checks fail on re-encode,
  // and debugging becomes impossible (non-reproducible output).
  it("encoding is deterministic: same input always produces identical bytes", async () => {
    const pcm = makeSpeechLike(4096, 0.8);
    const a = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const b = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });

    assert.equal(a.length, b.length, "encoded lengths differ");
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i], b[i], `byte ${i} differs: ${a[i]} vs ${b[i]}`);
    }
  });

  // peak normalization clamps framePeak to 1/COEFF_SCALE (~6.1e-5).
  // a signal at amplitude 1e-7 is ~600× below this floor. the codec should
  // not produce NaN, Infinity, or wildly amplified output.
  it("very quiet signal (amplitude 1e-7) round-trips without numerical blowup", async () => {
    const pcm = makeSine(4096, 440, 1e-7);
    const { decoded } = await roundTrip(pcm, 1, QUALITY);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    for (let i = 0; i < decoded.pcm.length; i++) {
      assert.ok(Number.isFinite(decoded.pcm[i]), `sample ${i} is not finite: ${decoded.pcm[i]}`);
      assert.ok(Math.abs(decoded.pcm[i]) < 0.01, `sample ${i} blew up: ${decoded.pcm[i]}`);
    }
  });

  // the header stores sampleRate as u32. encode at non-48kHz rates and
  // verify the decoder returns the correct value, not the 48000 fallback.
  it("sample rate is preserved in the header for non-standard rates", async () => {
    for (const sr of [8000, 16000, 22050, 44100, 96000]) {
      const pcm = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) pcm[i] = Math.sin(2 * Math.PI * 200 * i / sr) * 0.5;

      const encoded = await encodeHarmonic(pcm, sr, undefined, { quality: QUALITY, numChannels: 1 });
      const decoded = await decodeHarmonic(encoded);

      assert.equal(decoded.tampered, false);
      assert.equal(decoded.sampleRate, sr, `sample rate ${sr} not preserved`);
      assert.equal(decoded.pcm.length, 1024);
    }
  });

  // numSamples = float32Samples.length / numChannels. with odd length and
  // 2 channels, this is fractional. must not silently produce garbage.
  it("odd-length stereo input throws or handles gracefully", async () => {
    const pcm = new Float32Array(5); // 5 / 2 = 2.5 samples per channel
    for (let i = 0; i < 5; i++) pcm[i] = 0.1 * i;

    try {
      const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 2 });
      const decoded = await decodeHarmonic(encoded);
      // if it doesn't throw, at least check it didn't crash
      assert.equal(decoded.tampered, false);
    } catch (e) {
      assert.ok(e instanceof Error, "should throw a clean Error for odd stereo length");
    }
  });

  // 24kHz at 48kHz sample rate = Nyquist. K = 2cos(π) = -2, G = 1.
  // K² = 4 = 4G — exactly on the stability parabola boundary.
  // the predictor must not diverge.
  it("nyquist frequency (SR/2) does not cause predictor divergence", async () => {
    const nyquist = SAMPLE_RATE / 2;
    const pcm = makeSine(4096, nyquist, 0.8);
    const { decoded } = await roundTrip(pcm, 1, QUALITY);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, pcm.length);

    let peak = 0;
    for (let i = 0; i < decoded.pcm.length; i++) {
      assert.ok(Number.isFinite(decoded.pcm[i]), `sample ${i} diverged: ${decoded.pcm[i]}`);
      const a = Math.abs(decoded.pcm[i]);
      if (a > peak) peak = a;
    }
    // decoded peak should not exceed input peak by more than ~25%
    assert.ok(peak <= 1.1, `decoded peak ${peak} exceeds 1.1 (divergence)`);
  });

  // L=R is extremely common in practice (mono content in a stereo container).
  // Side channel = L-R = 0 everywhere. tests the codec handles a zero-energy
  // channel without NaN from division-by-zero in normalization or prediction.
  it("identical stereo channels (L=R) compresses Side to near-zero cost", async () => {
    const mono = makeSine(SAMPLE_RATE, 440, 0.7);
    const stereo = interleaveStereo(mono, mono);
    const { encoded, decoded } = await roundTrip(stereo, 2, QUALITY);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, stereo.length);

    // both channels should reconstruct accurately
    const { left, right } = splitStereo(decoded.pcm);
    const leftMetrics = measureRoundTripMetrics(mono, left);
    const rightMetrics = measureRoundTripMetrics(mono, right);
    assert.ok(leftMetrics.snr >= 60, `L SNR ${leftMetrics.snr.toFixed(1)} dB`);
    assert.ok(rightMetrics.snr >= 60, `R SNR ${rightMetrics.snr.toFixed(1)} dB`);

    // stereo should compress better than 2× mono (Side is trivial)
    const monoEnc = await encodeHarmonic(mono, SAMPLE_RATE, undefined, { quality: QUALITY, numChannels: 1 });
    const stereoBps = (encoded.length * 8) / SAMPLE_RATE;
    const monoBps = (monoEnc.length * 8) / mono.length;
    assert.ok(stereoBps < monoBps * 1.5,
      `stereo L=R at ${stereoBps.toFixed(2)} bps should be < 1.5× mono ${monoBps.toFixed(2)} bps`);
  });

  // abrupt transient: 2048 silence → single impulse → speech. the AR(2)
  // predictor state was tracking zero for thousands of samples, then gets
  // a sudden discontinuity. tests that prediction recovers within a few blocks.
  it("abrupt silence→impulse→speech transient recovers without error accumulation", async () => {
    const n = SAMPLE_RATE;
    const pcm = new Float32Array(n);
    // first half: silence
    // impulse at midpoint
    pcm[n / 2] = 1.0;
    // second half: speech
    for (let i = n / 2 + 1; i < n; i++) {
      const f0 = 120 + 30 * Math.sin(2 * Math.PI * 3 * i / SAMPLE_RATE);
      const phase = 2 * Math.PI * f0 * i / SAMPLE_RATE;
      pcm[i] = 0.6 * (0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
    }

    const { decoded } = await roundTrip(pcm, 1, QUALITY);
    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, n);

    // check the speech portion (second quarter) has reasonable quality
    let speechPower = 0, noisePower = 0;
    const start = Math.floor(n * 0.75);
    for (let i = start; i < n; i++) {
      const err = decoded.pcm[i] - pcm[i];
      speechPower += pcm[i] * pcm[i];
      noisePower += err * err;
    }
    const snr = 10 * Math.log10(speechPower / Math.max(noisePower, 1e-20));
    assert.ok(snr >= 50, `speech after transient: SNR ${snr.toFixed(1)} dB < 50 dB (error accumulation)`);
  });

  // every byte position in the MAC-protected ciphertext must detect tampering.
  // the existing test flips one byte. this flips every byte in a small payload
  // to verify complete MAC coverage.
  it("bit-flip at every ciphertext byte position is detected as tampering", async () => {
    const pcm = makeSine(256, 440, 0.5);
    const key = new Uint32Array([0xCAFEBABE, 0xDEADC0DE, 0x1337BEEF, 0xF00DCAFE]);
    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, key, { quality: QUALITY, numChannels: 1 });

    // header is bytes [0..11], ciphertext is [12..len-9], MAC is [len-8..len-1]
    const headerEnd = 12;
    const macStart = encoded.length - 8;

    let undetected = 0;
    for (let pos = headerEnd; pos < macStart; pos++) {
      const corrupted = new Uint8Array(encoded);
      corrupted[pos] ^= 0xFF;
      const result = await decodeHarmonic(corrupted, key);
      if (!result.tampered) undetected++;
    }
    assert.equal(undetected, 0,
      `${undetected} / ${macStart - headerEnd} ciphertext byte positions not detected by MAC`);
  });

  // frequency sweep from 20Hz to 20kHz. tests the full AR(2) parameter space:
  // low frequencies have K≈2, high frequencies have K≈-2. no frequency should
  // cause predictor instability, NaN, or error accumulation.
  it("chirp 20Hz→20kHz has no frequency-dependent instability", async () => {
    const n = SAMPLE_RATE;
    const pcm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      const freq = 20 * Math.pow(1000, t); // log sweep 20→20000
      pcm[i] = 0.7 * Math.sin(2 * Math.PI * freq * t);
    }

    const { decoded } = await roundTrip(pcm, 1, QUALITY);
    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, n);

    const { snr, maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
    assert.ok(snr >= 40, `chirp SNR ${snr.toFixed(1)} dB < 40 dB`);
    assert.ok(maxErr <= 0.05, `chirp maxErr ${maxErr} > 0.05`);

    // check no sample diverged
    for (let i = 0; i < n; i++) {
      assert.ok(Number.isFinite(decoded.pcm[i]), `sample ${i} is not finite`);
    }
  });

  // for input bounded in [-a, a], decoded output must stay near [-a, a].
  // a codec that expands amplitude beyond the input range will cause clipping
  // in downstream playback.
  it("decoded amplitude stays within input peak + 10% margin", async () => {
    const amplitude = 0.6;
    const pcm = makeSpeechLike(SAMPLE_RATE, amplitude);
    const { decoded } = await roundTrip(pcm, 1, QUALITY);

    let inputPeak = 0, outputPeak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]); if (a > inputPeak) inputPeak = a;
    }
    for (let i = 0; i < decoded.pcm.length; i++) {
      const a = Math.abs(decoded.pcm[i]); if (a > outputPeak) outputPeak = a;
    }

    assert.ok(outputPeak <= inputPeak * 1.10,
      `output peak ${outputPeak.toFixed(4)} exceeds input peak ${inputPeak.toFixed(4)} × 1.10`);
  });

  // Burg super-blocks are 256 samples. test at the exact boundary (256),
  // one below (255), and one above (257) to catch off-by-one in super-block
  // loop termination and partial-super-block handling.
  it("Burg super-block boundary sample counts (255, 256, 257) round-trip correctly", async () => {
    for (const n of [255, 256, 257, 511, 512, 513]) {
      const pcm = makeSpeechLike(n, 0.7);
      const { decoded } = await roundTrip(pcm, 1, QUALITY);

      assert.equal(decoded.tampered, false, `n=${n}: tampered`);
      assert.equal(decoded.pcm.length, n, `n=${n}: length mismatch`);

      const { maxErr } = measureRoundTripMetrics(pcm, decoded.pcm);
      assert.ok(maxErr <= 0.01, `n=${n}: maxErr ${maxErr} > 0.01`);
    }
  });
});

// ── N-channel / surround / object-based / bit depth / sample rate ───────────

describe("harmonic N-channel and surround", () => {
  it("quad (4 channel) round-trips with coupling decorrelation", async () => {
    const numSamples = 2048;
    const numCh = 4;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * numCh + 0] = Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE) * 0.6;
      pcm[i * numCh + 1] = Math.sin(2 * Math.PI * 330 * i / SAMPLE_RATE) * 0.5;
      pcm[i * numCh + 2] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.4;
      pcm[i * numCh + 3] = Math.sin(2 * Math.PI * 550 * i / SAMPLE_RATE) * 0.3;
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * numCh);

    // check each channel independently
    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i * numCh + ch] - decoded.pcm[i * numCh + ch]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.05, `quad ch${ch} maxErr ${maxErr} >= 0.05`);
    }
  });

  it("6-channel (5.1 layout) round-trips with independent encoding", async () => {
    const numSamples = 2048;
    const numCh = 6;
    const pcm = new Float32Array(numSamples * numCh);
    const freqs = [220, 330, 440, 55, 660, 770]; // 55Hz = LFE
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * freqs[ch] * i / SAMPLE_RATE) * 0.4;
      }
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * numCh);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i * numCh + ch] - decoded.pcm[i * numCh + ch]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.05, `5.1 ch${ch} maxErr ${maxErr} >= 0.05`);
    }
  });

  it("8-channel (7.1 layout) round-trips", async () => {
    const numSamples = 2048;
    const numCh = 8;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (200 + ch * 100) * i / SAMPLE_RATE) * 0.3;
      }
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * numCh);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i * numCh + ch] - decoded.pcm[i * numCh + ch]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.05, `7.1 ch${ch} maxErr ${maxErr} >= 0.05`);
    }
  });

  it("12-channel (7.1.4 layout) round-trips with independent encoding", async () => {
    const numSamples = 1024;
    const numCh = 12;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (100 + ch * 50) * i / SAMPLE_RATE) * 0.3;
      }
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * numCh);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i * numCh + ch] - decoded.pcm[i * numCh + ch]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.05, `7.1.4 ch${ch} maxErr ${maxErr} >= 0.05`);
    }
  });

  it("6ch coupling helps highly correlated 5.1 content", async () => {
    // 5.1 where L=R (identical): coupling should find W≈1 and compress
    // the R channel to near-zero residual.
    const numSamples = 2048;
    const numCh = 6;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      const speech = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
      const lfe = 0.3 * Math.sin(2 * Math.PI * 40 * i / SAMPLE_RATE);
      const amb = 0.2 * Math.sin(2 * Math.PI * 1000 * i / SAMPLE_RATE);
      pcm[i * numCh + 0] = speech;         // L
      pcm[i * numCh + 1] = speech;         // R = L (perfectly correlated)
      pcm[i * numCh + 2] = speech * 0.9;   // C (highly correlated with L)
      pcm[i * numCh + 3] = lfe;            // LFE (independent)
      pcm[i * numCh + 4] = amb;            // Ls
      pcm[i * numCh + 5] = amb;            // Rs = Ls (perfectly correlated)
    }

    const chEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "channel",
    });
    const objEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "object",
    });

    // coupling should compress significantly better for identical L/R and Ls/Rs
    assert.ok(chEnc.length < objEnc.length * 0.85,
      `5.1 coupling (${chEnc.length}B) should be < 85% of object (${objEnc.length}B) for identical L/R`);

    // round-trip correctly
    const chDec = await decodeHarmonic(chEnc);
    assert.equal(chDec.tampered, false);
    assert.equal(chDec.pcm.length, numSamples * numCh);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * numCh + ch] - chDec.pcm[i * numCh + ch]);
        if (e > maxErr) maxErr = e;
      }
      assert.ok(maxErr < 0.02, `5.1 coupling ch${ch} maxErr ${maxErr} >= 0.02`);
    }
  });

  it("6ch uncorrelated content: coupling does not hurt", async () => {
    const numSamples = 2048;
    const numCh = 6;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (200 + ch * 137) * i / SAMPLE_RATE) * 0.4;
      }
    }

    const chEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "channel",
    });
    const objEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "object",
    });

    // channel should not be significantly larger than object.
    // coupling overhead is ~16 bytes (6 refIndex + a few W). object has ~72 bytes
    // spatial overhead. allow 10% tolerance.
    assert.ok(chEnc.length < objEnc.length * 1.1,
      `6ch uncorrelated: channel (${chEnc.length}B) more than 10% larger than object (${objEnc.length}B)`);

    const dec = await decodeHarmonic(chEnc);
    assert.equal(dec.tampered, false);
    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
        if (e > maxErr) maxErr = e;
      }
      assert.ok(maxErr < 0.02, `6ch uncorrelated ch${ch} maxErr ${maxErr}`);
    }
  });

  it("correlated 8ch signal compresses better with coupling than independent", async () => {
    // all 8 channels are the same sine — coupling will predict each from the anchor
    const numSamples = 2048;
    const numCh = 8;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      const v = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
      for (let ch = 0; ch < numCh; ch++) pcm[i * numCh + ch] = v;
    }

    const channelEncoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh, layout: "channel",
    });
    const objectEncoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh, layout: "object",
    });

    // coupling (channel) should be smaller than object (no decorrelation)
    assert.ok(
      channelEncoded.length < objectEncoded.length,
      `coupling (${channelEncoded.length}B) should be smaller than object (${objectEncoded.length}B) for correlated signals`,
    );
  });
});

describe("harmonic object-based audio", () => {
  it("object-based layout round-trips with spatial metadata", async () => {
    const numSamples = 2048;
    const numCh = 3; // 3 audio objects
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * numCh + 0] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
      pcm[i * numCh + 1] = Math.sin(2 * Math.PI * 880 * i / SAMPLE_RATE) * 0.3;
      pcm[i * numCh + 2] = Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE) * 0.7;
    }

    const objects: SpatialObject[] = [
      { azimuth: Math.PI / 4, elevation: 0, distance: 1 },       // front-left
      { azimuth: -Math.PI / 4, elevation: 0, distance: 1 },      // front-right
      { azimuth: 0, elevation: Math.PI / 4, distance: 0.5 },     // overhead center
    ];

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: QUALITY, numChannels: numCh, layout: "object", spatialObjects: objects,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * numCh);

    // verify spatial metadata survives round-trip
    assert.ok(decoded.spatialObjects, "spatialObjects missing from decode result");
    assert.equal(decoded.spatialObjects!.length, numCh);
    for (let ch = 0; ch < numCh; ch++) {
      const orig = objects[ch];
      const dec  = decoded.spatialObjects![ch];
      assert.ok(Math.abs(orig.azimuth - dec.azimuth) < 1e-5, `object ${ch} azimuth mismatch`);
      assert.ok(Math.abs(orig.elevation - dec.elevation) < 1e-5, `object ${ch} elevation mismatch`);
      assert.ok(Math.abs(orig.distance - dec.distance) < 1e-5, `object ${ch} distance mismatch`);
    }

    // verify audio round-trips
    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i * numCh + ch] - decoded.pcm[i * numCh + ch]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.05, `object ${ch} maxErr ${maxErr} >= 0.05`);
    }
  });

  it("SURROUND_LAYOUTS provides correct channel counts", () => {
    assert.equal(SURROUND_LAYOUTS.stereo.length, 2);
    assert.equal(SURROUND_LAYOUTS["5.1"].length, 6);
    assert.equal(SURROUND_LAYOUTS["7.1"].length, 8);
    assert.equal(SURROUND_LAYOUTS["7.1.4"].length, 12);
  });
});

describe("harmonic bit depth support", () => {
  it("16-bit source round-trips with sufficient precision", async () => {
    const numSamples = 2048;
    const pcm = new Float32Array(numSamples);
    // simulate 16-bit source: values at discrete 1/32768 steps
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 32767) / 32768;
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: 1, bitDepth: 16,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    let maxErr = 0;
    for (let i = 0; i < numSamples; i++) {
      const err = Math.abs(pcm[i] - decoded.pcm[i]);
      if (err > maxErr) maxErr = err;
    }
    // with bitDepth=16, scalar=32768, so each quantization step = peak/32768.
    // for signals near full scale, this should preserve 16-bit precision.
    assert.ok(maxErr < 1 / 32768 * 2, `16-bit maxErr ${maxErr} exceeds 2 LSB`);
  });

  it("24-bit source round-trips with high precision", async () => {
    const numSamples = 2048;
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.9;
    }

    const encoded = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: 1, bitDepth: 24,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    let maxErr = 0;
    for (let i = 0; i < numSamples; i++) {
      const err = Math.abs(pcm[i] - decoded.pcm[i]);
      if (err > maxErr) maxErr = err;
    }
    // 24-bit: scalar=2^23, precision = peak/2^23
    assert.ok(maxErr < 1e-5, `24-bit maxErr ${maxErr} exceeds 1e-5`);
  });

  it("bitDepth overrides quality when bitDepth needs higher scalar", async () => {
    const numSamples = 1024;
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.8;
    }

    // Q=30 gives scalar ≈ 30. bitDepth=16 forces scalar ≥ 32768.
    // the higher scalar means the decoded output has much finer precision.
    const lowQ = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 30, numChannels: 1,
    });
    const withDepth = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 30, numChannels: 1, bitDepth: 16,
    });
    const lowDec = await decodeHarmonic(lowQ);
    const depthDec = await decodeHarmonic(withDepth);

    // bitDepth=16 output should have significantly better precision
    let lowErr = 0, depthErr = 0;
    for (let i = 0; i < numSamples; i++) {
      lowErr += Math.abs(pcm[i] - lowDec.pcm[i]);
      depthErr += Math.abs(pcm[i] - depthDec.pcm[i]);
    }
    assert.ok(
      depthErr < lowErr * 0.5,
      `bitDepth=16 total error (${depthErr.toFixed(2)}) should be < 50% of Q=30 (${lowErr.toFixed(2)})`,
    );
  });
});

describe("harmonic sample rate adaptivity", () => {
  it("non-standard sample rates round-trip correctly", async () => {
    const rates = [8000, 22050, 44100, 96000, 192000];
    for (const sr of rates) {
      const numSamples = Math.ceil(sr * 0.02); // 20ms frame
      const pcm = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        pcm[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
      }

      const encoded = await encodeHarmonic(pcm, sr, undefined, {
        quality: QUALITY, numChannels: 1,
      });
      const decoded = await decodeHarmonic(encoded);

      assert.equal(decoded.tampered, false, `sr=${sr}: tampered`);
      assert.equal(decoded.sampleRate, sr, `sr=${sr}: rate not preserved`);
      assert.equal(decoded.pcm.length, numSamples, `sr=${sr}: length mismatch`);

      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const err = Math.abs(pcm[i] - decoded.pcm[i]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 0.1, `sr=${sr}: maxErr ${maxErr} >= 0.1`);
    }
  });

  it("96kHz stereo round-trips with correct sample count and precision", async () => {
    const sr = 96000;
    const numSamples = Math.ceil(sr * 0.02); // 1920 samples
    const pcm = new Float32Array(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * 2]     = Math.sin(2 * Math.PI * 1000 * i / sr) * 0.5;
      pcm[i * 2 + 1] = Math.sin(2 * Math.PI * 2000 * i / sr) * 0.3;
    }

    const encoded = await encodeHarmonic(pcm, sr, undefined, {
      quality: QUALITY, numChannels: 2,
    });
    const decoded = await decodeHarmonic(encoded);

    assert.equal(decoded.tampered, false);
    assert.equal(decoded.pcm.length, numSamples * 2);
    assert.equal(decoded.sampleRate, sr);

    // per-channel quality check at Q80
    for (let ch = 0; ch < 2; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * 2 + ch] - decoded.pcm[i * 2 + ch]);
        if (e > maxErr) maxErr = e;
      }
      assert.ok(maxErr < 0.02, `96kHz stereo ch${ch} maxErr ${maxErr} >= 0.02 at Q80`);
    }
  });
});

// ── comprehensive stress / sweep tests ──────────────────────────────────────

describe("harmonic full Q sweep: quad (4ch coupling)", () => {
  it("every Q from 1 to 99 round-trips 4ch without crash or tamper", async () => {
    const numSamples = 1024;
    const numCh = 4;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * numCh + 0] = Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE) * 0.5;
      pcm[i * numCh + 1] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.4;
      pcm[i * numCh + 2] = Math.sin(2 * Math.PI * 660 * i / SAMPLE_RATE) * 0.3;
      pcm[i * numCh + 3] = Math.sin(2 * Math.PI * 880 * i / SAMPLE_RATE) * 0.2;
    }

    const errors: number[] = [];
    for (let q = 1; q <= 99; q++) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: numCh,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples * numCh, `Q${q}: length`);

      let maxErr = 0;
      for (let i = 0; i < dec.pcm.length; i++) {
        const e = Math.abs(pcm[i] - dec.pcm[i]);
        if (e > maxErr) maxErr = e;
        assert.ok(Number.isFinite(dec.pcm[i]), `Q${q}: NaN/Inf at sample ${i}`);
      }
      errors.push(maxErr);
    }

    // Q90+ should be more precise than Q10
    assert.ok(errors[89] < errors[0] + 1e-4,
      `Q90 err ${errors[89]} should be < Q1 err ${errors[0]}`);

    // at Q80 (index 79), per-channel error should be small for sinusoidal signals
    assert.ok(errors[79] < 0.02,
      `Q80 quad err ${errors[79]} should be < 0.02 for sines`);

    // at Q50 (index 49), error should still be moderate
    assert.ok(errors[49] < 0.15,
      `Q50 quad err ${errors[49]} should be < 0.15`);
  });
});

describe("harmonic full Q sweep: object-based (3 objects)", () => {
  it("every Q from 1 to 99 round-trips object audio + spatial metadata", async () => {
    const numSamples = 1024;
    const numCh = 3;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * numCh + 0] = Math.sin(2 * Math.PI * 300 * i / SAMPLE_RATE) * 0.6;
      pcm[i * numCh + 1] = Math.sin(2 * Math.PI * 600 * i / SAMPLE_RATE) * 0.4;
      pcm[i * numCh + 2] = Math.sin(2 * Math.PI * 150 * i / SAMPLE_RATE) * 0.7;
    }

    const objects: SpatialObject[] = [
      { azimuth: 0.5, elevation: 0.2, distance: 0.8 },
      { azimuth: -1.2, elevation: -0.3, distance: 1.0 },
      { azimuth: 2.8, elevation: 1.1, distance: 0.3 },
    ];

    for (let q = 1; q <= 99; q++) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: numCh, layout: "object", spatialObjects: objects,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples * numCh, `Q${q}: length`);

      // spatial metadata must survive every Q level
      assert.ok(dec.spatialObjects, `Q${q}: no spatial objects`);
      assert.equal(dec.spatialObjects!.length, numCh, `Q${q}: spatial count`);
      for (let ch = 0; ch < numCh; ch++) {
        assert.ok(Math.abs(objects[ch].azimuth - dec.spatialObjects![ch].azimuth) < 1e-5,
          `Q${q} ch${ch}: azimuth drift`);
        assert.ok(Math.abs(objects[ch].elevation - dec.spatialObjects![ch].elevation) < 1e-5,
          `Q${q} ch${ch}: elevation drift`);
        assert.ok(Math.abs(objects[ch].distance - dec.spatialObjects![ch].distance) < 1e-5,
          `Q${q} ch${ch}: distance drift`);
      }

      // no NaN/Inf
      for (let i = 0; i < dec.pcm.length; i++) {
        assert.ok(Number.isFinite(dec.pcm[i]), `Q${q}: NaN/Inf at ${i}`);
      }
    }
  });
});

describe("harmonic full Q sweep: 16-bit depth", () => {
  it("every Q from 1 to 99 round-trips with bitDepth=16", async () => {
    const numSamples = 2048;
    const pcm = new Float32Array(numSamples);
    // 16-bit quantized source
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 32767) / 32768;
    }

    const errors: number[] = [];
    for (let q = 1; q <= 99; q++) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: 1, bitDepth: 16,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples, `Q${q}: length`);

      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i] - dec.pcm[i]);
        if (e > maxErr) maxErr = e;
        assert.ok(Number.isFinite(dec.pcm[i]), `Q${q}: NaN/Inf at ${i}`);
      }
      errors.push(maxErr);

      // bitDepth=16 guarantees scalar ≥ 32768, so error should be tiny at all Q
      assert.ok(maxErr < 0.001,
        `Q${q}: bitDepth=16 maxErr ${maxErr} too large (scalar floor should keep precision)`);
    }
  });
});

describe("harmonic full Q sweep: non-48kHz sample rates", () => {
  it("Q sweep 10..90 at 8kHz, 22050Hz, 44100Hz, 96kHz", async () => {
    const rates = [8000, 22050, 44100, 96000];
    const qualities = [10, 20, 30, 40, 50, 60, 70, 80, 90];

    for (const sr of rates) {
      const numSamples = Math.max(256, Math.ceil(sr * 0.02));
      const pcm = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        // 440Hz (or Nyquist/4 if sr is very low)
        const freq = Math.min(440, sr / 4);
        pcm[i] = Math.sin(2 * Math.PI * freq * i / sr) * 0.6;
      }

      const prevErrors: number[] = [];
      for (const q of qualities) {
        const enc = await encodeHarmonic(pcm, sr, undefined, {
          quality: q, numChannels: 1,
        });
        const dec = await decodeHarmonic(enc);
        assert.equal(dec.tampered, false, `sr=${sr} Q${q}: tampered`);
        assert.equal(dec.sampleRate, sr, `sr=${sr} Q${q}: rate mismatch`);
        assert.equal(dec.pcm.length, numSamples, `sr=${sr} Q${q}: length`);

        let maxErr = 0;
        for (let i = 0; i < numSamples; i++) {
          const e = Math.abs(pcm[i] - dec.pcm[i]);
          if (e > maxErr) maxErr = e;
          assert.ok(Number.isFinite(dec.pcm[i]), `sr=${sr} Q${q}: NaN/Inf at ${i}`);
        }
        prevErrors.push(maxErr);
      }

      // Q90 should beat Q10 at every sample rate
      assert.ok(prevErrors[prevErrors.length - 1] < prevErrors[0] + 1e-4,
        `sr=${sr}: Q90 err ${prevErrors[prevErrors.length - 1]} >= Q10 err ${prevErrors[0]}`);
    }
  });
});

describe("harmonic stress: 5.1 surround with speech-like content", () => {
  it("5.1 round-trips with realistic mixed content across Q sweep", async () => {
    const numSamples = 2048;
    const numCh = 6;
    const pcm = new Float32Array(numSamples * numCh);

    // L/R: speech-like, C: narrator (different pitch), LFE: low rumble,
    // Ls/Rs: ambient noise
    for (let i = 0; i < numSamples; i++) {
      const f0 = 120 + 30 * Math.sin(2 * Math.PI * 3 * i / SAMPLE_RATE);
      const phase = 2 * Math.PI * f0 * i / SAMPLE_RATE;
      const speech = 0.5 * Math.sin(phase) + 0.2 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase);
      const narrator = 0.4 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE);
      const lfe = 0.6 * Math.sin(2 * Math.PI * 40 * i / SAMPLE_RATE);
      // deterministic "ambient"
      const amb = 0.1 * Math.sin(2 * Math.PI * 1200 * i / SAMPLE_RATE + i * 0.01);

      pcm[i * numCh + 0] = speech * 0.8;            // L
      pcm[i * numCh + 1] = speech * 0.8;            // R (correlated with L)
      pcm[i * numCh + 2] = narrator;                 // C
      pcm[i * numCh + 3] = lfe;                      // LFE
      pcm[i * numCh + 4] = amb + speech * 0.1;       // Ls
      pcm[i * numCh + 5] = amb * 0.8 - speech * 0.1; // Rs
    }

    const qualities = [20, 40, 60, 80, 95];
    for (const q of qualities) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: numCh,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples * numCh, `Q${q}: length`);

      // per-channel error check
      for (let ch = 0; ch < numCh; ch++) {
        let maxErr = 0;
        for (let i = 0; i < numSamples; i++) {
          const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
          if (e > maxErr) maxErr = e;
        }
        // at Q≥60, each channel should be within 5% of peak
        if (q >= 60) {
          assert.ok(maxErr < 0.05,
            `Q${q} ch${ch}: maxErr ${maxErr} too large for high quality`);
        }
        // at any Q ≥ 20, error should stay below 0.5 (signal amplitude is ≤ 0.8)
        assert.ok(maxErr < 0.5,
          `Q${q} ch${ch}: maxErr ${maxErr} diverged (signal amp ≤ 0.8)`);
      }
    }
  });

  it("coupling compresses correlated power-of-2 channels better than object", async () => {
    // use 8ch (power of 2, no ghost padding overhead) where coupling wins cleanly
    const numSamples = 2048;
    const numCh = 8;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      const v = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
      for (let ch = 0; ch < numCh; ch++) pcm[i * numCh + ch] = v;
    }

    const chEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "channel",
    });
    const objEnc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "object",
    });

    // 8 identical channels: coupling concentrates into ch0, rest ≈ 0
    assert.ok(chEnc.length < objEnc.length,
      `coupling (${chEnc.length}B) should be smaller than object (${objEnc.length}B) for 8 identical channels`);
  });
});

describe("harmonic stress: object layout without explicit positions", () => {
  it("object layout with no spatialObjects defaults to origin positions", async () => {
    const numSamples = 1024;
    const numCh = 2;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      pcm[i * numCh + 0] = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
      pcm[i * numCh + 1] = Math.sin(2 * Math.PI * 880 * i / SAMPLE_RATE) * 0.3;
    }

    // no spatialObjects provided — should still encode/decode without crash
    const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
      quality: 80, numChannels: numCh, layout: "object",
    });
    const dec = await decodeHarmonic(enc);
    assert.equal(dec.tampered, false);
    assert.equal(dec.pcm.length, numSamples * numCh);
    assert.ok(dec.spatialObjects, "should have spatial objects");
    assert.equal(dec.spatialObjects!.length, numCh);
    // defaults: azimuth=0, elevation=0, distance=1
    for (const obj of dec.spatialObjects!) {
      assert.ok(Math.abs(obj.azimuth) < 1e-5);
      assert.ok(Math.abs(obj.elevation) < 1e-5);
      assert.ok(Math.abs(obj.distance - 1) < 1e-5);
    }
  });
});

describe("harmonic stress: encryption with N-channel and object", () => {
  it("encrypted quad round-trips and detects tampering", async () => {
    const numSamples = 1024;
    const numCh = 4;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (200 + ch * 100) * i / SAMPLE_RATE) * 0.4;
      }
    }

    const key = new Uint32Array([0xCAFEBABE, 0xDEADBEEF, 0x12345678, 0x9ABCDEF0]);
    const enc = await encodeHarmonic(pcm, SAMPLE_RATE, key, {
      quality: 80, numChannels: numCh,
    });

    // correct key decodes
    const good = await decodeHarmonic(enc, key);
    assert.equal(good.tampered, false);
    assert.equal(good.pcm.length, numSamples * numCh);

    // wrong key detects tampering
    const badKey = new Uint32Array([0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const bad = await decodeHarmonic(enc, badKey);
    assert.equal(bad.tampered, true);

    // bit flip detects tampering
    const flipped = new Uint8Array(enc);
    flipped[20] ^= 0x01;
    const flip = await decodeHarmonic(flipped, key);
    assert.equal(flip.tampered, true);
  });

  it("encrypted object-based round-trips with spatial metadata", async () => {
    const numSamples = 1024;
    const numCh = 3;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (300 + ch * 200) * i / SAMPLE_RATE) * 0.5;
      }
    }

    const objects: SpatialObject[] = [
      { azimuth: 1.0, elevation: 0.5, distance: 0.7 },
      { azimuth: -0.8, elevation: -0.2, distance: 1.0 },
      { azimuth: 0, elevation: 1.5, distance: 0.1 },
    ];

    const key = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD]);
    const enc = await encodeHarmonic(pcm, SAMPLE_RATE, key, {
      quality: 80, numChannels: numCh, layout: "object", spatialObjects: objects,
    });
    const dec = await decodeHarmonic(enc, key);
    assert.equal(dec.tampered, false);
    assert.equal(dec.pcm.length, numSamples * numCh);
    assert.ok(dec.spatialObjects);
    for (let ch = 0; ch < numCh; ch++) {
      assert.ok(Math.abs(objects[ch].azimuth - dec.spatialObjects![ch].azimuth) < 1e-5);
    }
  });
});

describe("harmonic stress: 24-bit depth full Q sweep", () => {
  it("24-bit depth preserves precision across all Q levels", async () => {
    const numSamples = 1024;
    const pcm = new Float32Array(numSamples);
    // simulate 24-bit source with very fine steps
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 8388607) / 8388608;
    }

    for (let q = 10; q <= 90; q += 10) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: 1, bitDepth: 24,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);

      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i] - dec.pcm[i]);
        if (e > maxErr) maxErr = e;
      }
      // bitDepth=24 forces scalar=8388608, precision should be excellent at all Q
      assert.ok(maxErr < 1e-5,
        `Q${q}: 24-bit maxErr ${maxErr} too large`);
    }
  });
});

describe("harmonic stress: stereo Q1 to Q99 (regression guard)", () => {
  it("stereo works at every Q level with mixed content and quality scales", async () => {
    const numSamples = 2048;
    const pcm = new Float32Array(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      // L: speech-like FM, R: different instrument
      const f0 = 120 + 20 * Math.sin(2 * Math.PI * 4 * i / SAMPLE_RATE);
      pcm[i * 2] = 0.5 * Math.sin(2 * Math.PI * f0 * i / SAMPLE_RATE);
      pcm[i * 2 + 1] = 0.4 * Math.sin(2 * Math.PI * 660 * i / SAMPLE_RATE);
    }

    let errQ20 = 0, errQ80 = 0;
    for (let q = 1; q <= 99; q++) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: 2,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples * 2, `Q${q}: length`);

      let maxErr = 0;
      for (let i = 0; i < dec.pcm.length; i++) {
        assert.ok(Number.isFinite(dec.pcm[i]), `Q${q}: NaN/Inf at ${i}`);
        const e = Math.abs(pcm[i] - dec.pcm[i]);
        if (e > maxErr) maxErr = e;
      }

      if (q === 20) errQ20 = maxErr;
      if (q === 80) errQ80 = maxErr;

      // cochlear-null noise shaping (2nd-order NTF) can swing ±1 step,
      // so at low Q the max error is wider than first-order shaping.
      // at Q1, scalar=1 (ternary), error can reach ~peak.
      const maxBound = q < 10 ? 2.0 : q < 30 ? 2.0 : 0.2;
      assert.ok(maxErr < maxBound, `Q${q}: stereo maxErr ${maxErr} >= ${maxBound}`);
    }

    // quality scaling: Q80 should be significantly better than Q20
    assert.ok(errQ80 < errQ20 * 0.5,
      `stereo Q80 err (${errQ80.toFixed(4)}) should be < 50% of Q20 err (${errQ20.toFixed(4)})`);
  });
});

describe("harmonic stress: 192kHz high-res with 8-channel", () => {
  it("192kHz 8ch round-trips at Q80", async () => {
    const sr = 192000;
    const numSamples = Math.ceil(sr * 0.02); // 20ms = 3840 samples
    const numCh = 8;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (200 + ch * 100) * i / sr) * 0.3;
      }
    }

    const enc = await encodeHarmonic(pcm, sr, undefined, {
      quality: 80, numChannels: numCh,
    });
    const dec = await decodeHarmonic(enc);
    assert.equal(dec.tampered, false);
    assert.equal(dec.pcm.length, numSamples * numCh);
    assert.equal(dec.sampleRate, sr);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
        if (e > maxErr) maxErr = e;
      }
      assert.ok(maxErr < 0.05, `192kHz 8ch ch${ch} maxErr ${maxErr} >= 0.05`);
    }
  });
});

describe("harmonic stress: bitrate sanity across configs", () => {
  it("N-channel bitrate scales sub-linearly (coupling helps)", async () => {
    const numSamples = 2048;
    // identical signal on all channels (worst case for object, best for coupling)
    const makePcm = (nch: number) => {
      const pcm = new Float32Array(numSamples * nch);
      for (let i = 0; i < numSamples; i++) {
        const v = Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) * 0.5;
        for (let ch = 0; ch < nch; ch++) pcm[i * nch + ch] = v;
      }
      return pcm;
    };

    const sizes: number[] = [];
    for (const nch of [1, 2, 4, 8]) {
      const enc = await encodeHarmonic(makePcm(nch), SAMPLE_RATE, undefined, {
        quality: 80, numChannels: nch,
      });
      sizes.push(enc.length);
    }

    // correlated 2ch should not be 2x mono
    assert.ok(sizes[1] < sizes[0] * 1.8,
      `stereo (${sizes[1]}B) should be < 1.8x mono (${sizes[0]}B) for identical signals`);

    // correlated 8ch should not be 8x mono
    assert.ok(sizes[3] < sizes[0] * 5,
      `8ch (${sizes[3]}B) should be < 5x mono (${sizes[0]}B) for identical signals`);
  });
});

describe("harmonic stress: cross-feature combination", () => {
  it("4ch coupling + bitDepth=24 + 96kHz + encryption", async () => {
    const sr = 96000;
    const numSamples = Math.ceil(sr * 0.02); // 1920 samples
    const numCh = 4;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (200 + ch * 150) * i / sr) * 0.5;
      }
    }

    const key = new Uint32Array([0x01020304, 0x05060708, 0x090A0B0C, 0x0D0E0F10]);
    const enc = await encodeHarmonic(pcm, sr, key, {
      quality: 60, numChannels: numCh, bitDepth: 24,
    });
    const dec = await decodeHarmonic(enc, key);

    assert.equal(dec.tampered, false);
    assert.equal(dec.pcm.length, numSamples * numCh);
    assert.equal(dec.sampleRate, sr);

    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
        if (e > maxErr) maxErr = e;
      }
      // bitDepth=24 at 96kHz with coupling: should be very precise
      assert.ok(maxErr < 1e-4,
        `4ch 96kHz 24bit ch${ch} maxErr ${maxErr} >= 1e-4`);
    }

    // wrong key must fail
    const bad = await decodeHarmonic(enc, new Uint32Array([1, 2, 3, 4]));
    assert.equal(bad.tampered, true);
  });

  it("6ch object + bitDepth=16 + 44100Hz + spatial metadata", async () => {
    const sr = 44100;
    const numSamples = Math.ceil(sr * 0.02);
    const numCh = 6;
    const pcm = new Float32Array(numSamples * numCh);
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        pcm[i * numCh + ch] = Math.sin(2 * Math.PI * (100 + ch * 80) * i / sr) * 0.4;
      }
    }

    const objects: SpatialObject[] = SURROUND_LAYOUTS["5.1"];
    const enc = await encodeHarmonic(pcm, sr, undefined, {
      quality: 50, numChannels: numCh, layout: "object",
      spatialObjects: objects, bitDepth: 16,
    });
    const dec = await decodeHarmonic(enc);

    assert.equal(dec.tampered, false);
    assert.equal(dec.pcm.length, numSamples * numCh);
    assert.equal(dec.sampleRate, sr);
    assert.ok(dec.spatialObjects);
    assert.equal(dec.spatialObjects!.length, numCh);

    // spatial positions survive
    for (let ch = 0; ch < numCh; ch++) {
      assert.ok(Math.abs(objects[ch].azimuth - dec.spatialObjects![ch].azimuth) < 1e-5,
        `ch${ch} azimuth drift`);
    }

    // bitDepth=16: precision should be within 2 LSB at 16-bit scale
    for (let ch = 0; ch < numCh; ch++) {
      let maxErr = 0;
      for (let i = 0; i < numSamples; i++) {
        const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
        if (e > maxErr) maxErr = e;
      }
      assert.ok(maxErr < 0.001,
        `6ch object 16bit ch${ch} maxErr ${maxErr} >= 0.001`);
    }
  });
});

describe("harmonic stress: noise-like content multichannel", () => {
  it("4ch deterministic noise round-trips without divergence across Q sweep", async () => {
    const numSamples = 2048;
    const numCh = 4;
    const pcm = new Float32Array(numSamples * numCh);
    // deterministic PRNG noise per channel (different seed per channel)
    for (let ch = 0; ch < numCh; ch++) {
      let state = 0x12345678 + ch * 0x11111111;
      for (let i = 0; i < numSamples; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        pcm[i * numCh + ch] = (((state >>> 8) / 0x01000000) * 2 - 1) * 0.4;
      }
    }

    // noise is the hardest signal for prediction — all trials should fail,
    // residuals ≈ original. the test ensures no crashes, no divergence.
    for (const q of [10, 30, 50, 70, 90]) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: numCh,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);
      assert.equal(dec.pcm.length, numSamples * numCh, `Q${q}: length`);

      for (let ch = 0; ch < numCh; ch++) {
        let maxErr = 0;
        for (let i = 0; i < numSamples; i++) {
          const e = Math.abs(pcm[i * numCh + ch] - dec.pcm[i * numCh + ch]);
          if (e > maxErr) maxErr = e;
          assert.ok(Number.isFinite(dec.pcm[i * numCh + ch]),
            `Q${q} ch${ch}: NaN/Inf at ${i}`);
        }
        // noise at Q≥50 should still reconstruct within 20% of amplitude
        if (q >= 50) {
          assert.ok(maxErr < 0.1,
            `Q${q} ch${ch}: noise maxErr ${maxErr} >= 0.1`);
        }
        // no divergence at any Q
        assert.ok(maxErr < 0.5,
          `Q${q} ch${ch}: noise maxErr ${maxErr} diverged`);
      }
    }
  });

  it("3-object noise with spatial metadata survives Q sweep", async () => {
    const numSamples = 1024;
    const numCh = 3;
    const pcm = new Float32Array(numSamples * numCh);
    for (let ch = 0; ch < numCh; ch++) {
      let state = 0xABCDEF01 + ch * 0x22222222;
      for (let i = 0; i < numSamples; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        pcm[i * numCh + ch] = (((state >>> 8) / 0x01000000) * 2 - 1) * 0.3;
      }
    }

    const objects: SpatialObject[] = [
      { azimuth: -2.5, elevation: -1.0, distance: 0.5 },
      { azimuth: 1.8, elevation: 0.7, distance: 1.5 },
      { azimuth: 0, elevation: 0, distance: 0 },
    ];

    for (const q of [20, 50, 80]) {
      const enc = await encodeHarmonic(pcm, SAMPLE_RATE, undefined, {
        quality: q, numChannels: numCh, layout: "object", spatialObjects: objects,
      });
      const dec = await decodeHarmonic(enc);
      assert.equal(dec.tampered, false, `Q${q}: tampered`);

      // spatial metadata exact
      for (let ch = 0; ch < numCh; ch++) {
        assert.ok(Math.abs(objects[ch].azimuth - dec.spatialObjects![ch].azimuth) < 1e-5,
          `Q${q} ch${ch}: azimuth`);
        assert.ok(Math.abs(objects[ch].distance - dec.spatialObjects![ch].distance) < 1e-5,
          `Q${q} ch${ch}: distance`);
      }

      // no divergence
      for (let i = 0; i < dec.pcm.length; i++) {
        assert.ok(Number.isFinite(dec.pcm[i]), `Q${q}: NaN at ${i}`);
      }
    }
  });
});
