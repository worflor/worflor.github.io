import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sineWave } from "./_helpers/generators.js";
import {
  dcBlock,
  inverseDcBlock,
  wavFromPcm,
} from "../../src/scripts/whisper/live-audio-dsp.js";

describe("live-audio-dsp", () => {
  describe("dcBlock / inverseDcBlock", () => {
    it("round-trip preserves signal (440Hz sine, 48kHz, 0.1s)", () => {
      const original = sineWave(4800, 440, 48000);
      const copy = new Float32Array(original);

      dcBlock(copy);
      inverseDcBlock(copy);

      let maxErr = 0;
      for (let i = 0; i < original.length; i++) {
        const err = Math.abs(original[i] - copy[i]);
        if (err > maxErr) maxErr = err;
      }
      assert.ok(maxErr < 1e-4, `max round-trip error ${maxErr} should be < 1e-4`);
    });

    it("round-trip for multiple frequencies (200Hz, 1kHz, 8kHz)", () => {
      for (const freq of [200, 1000, 8000]) {
        const original = sineWave(4800, freq, 48000);
        const copy = new Float32Array(original);

        dcBlock(copy);
        inverseDcBlock(copy);

        let maxErr = 0;
        for (let i = 0; i < original.length; i++) {
          const err = Math.abs(original[i] - copy[i]);
          if (err > maxErr) maxErr = err;
        }
        assert.ok(maxErr < 1e-4, `${freq}Hz round-trip error ${maxErr} should be < 1e-4`);
      }
    });

    it("DC removal: removes constant offset", () => {
      const N = 48000; // 1 second at 48kHz — long enough for α=0.9995 to settle
      const samples = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        samples[i] = 0.5 + Math.sin(2 * Math.PI * 200 * i / 48000) * 0.1;
      }

      dcBlock(samples);

      // Mean of filtered signal should be near 0 (after settling)
      let sum = 0;
      const start = Math.floor(N * 0.8); // skip long transient
      for (let i = start; i < N; i++) sum += samples[i];
      const mean = sum / (N - start);
      assert.ok(Math.abs(mean) < 0.01, `DC-blocked mean ${mean} should be near 0`);
    });

    it("DC removal with various DC offsets", () => {
      for (const dcOffset of [0.1, 0.3, 0.7, 1.0]) {
        const N = 48000;
        const samples = new Float32Array(N);
        for (let i = 0; i < N; i++) {
          samples[i] = dcOffset + Math.sin(2 * Math.PI * 300 * i / N) * 0.05;
        }

        dcBlock(samples);

        let sum = 0;
        const start = Math.floor(N * 0.8);
        for (let i = start; i < N; i++) sum += samples[i];
        const mean = sum / (N - start);
        assert.ok(Math.abs(mean) < 0.02,
          `DC offset ${dcOffset}: blocked mean ${mean.toFixed(6)} should be near 0`);
      }
    });

    it("zero input → zero output", () => {
      const samples = new Float32Array(100);
      dcBlock(samples);
      for (let i = 0; i < 100; i++) {
        assert.equal(samples[i], 0, `sample ${i} should be 0`);
      }
    });

    it("zero input → zero output for inverseDcBlock too", () => {
      const samples = new Float32Array(100);
      inverseDcBlock(samples);
      for (let i = 0; i < 100; i++) {
        assert.equal(samples[i], 0, `sample ${i} should be 0`);
      }
    });

    it("preserves AC signal amplitude (440Hz, settled region)", () => {
      const N = 48000;
      const freq = 440;
      const amplitude = 0.5;
      const samples = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        samples[i] = amplitude * Math.sin(2 * Math.PI * freq * i / N);
      }

      dcBlock(samples);

      // In the settled region, peak amplitude should be close to original
      let maxAbs = 0;
      const start = Math.floor(N * 0.5); // after settling
      for (let i = start; i < N; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > maxAbs) maxAbs = abs;
      }
      assert.ok(Math.abs(maxAbs - amplitude) < 0.01,
        `settled amplitude ${maxAbs} should be close to ${amplitude}`);
    });
  });

  describe("wavFromPcm", () => {
    it("RIFF header structure (magic, format, chunks)", () => {
      const pcm = sineWave(100, 440, 48000);
      const wav = wavFromPcm(pcm, 48000);
      const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

      assert.equal(dv.getUint32(0, false), 0x52494646, "RIFF magic");
      assert.equal(dv.getUint32(4, true), wav.length - 8, "file size field");
      assert.equal(dv.getUint32(8, false), 0x57415645, "WAVE format");
      assert.equal(dv.getUint32(12, false), 0x666d7420, "fmt chunk");
      assert.equal(dv.getUint32(16, true), 16, "fmt chunk size");
      assert.equal(dv.getUint16(20, true), 1, "PCM format (1)");
      assert.equal(dv.getUint16(22, true), 1, "mono (1 channel)");
    });

    it("sample rate in header for various rates", () => {
      for (const sr of [8000, 16000, 44100, 48000]) {
        const pcm = sineWave(100, 440, sr);
        const wav = wavFromPcm(pcm, sr);
        const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        assert.equal(dv.getUint32(24, true), sr, `sample rate ${sr}`);
        // Byte rate = sampleRate * channels * bitsPerSample/8 = sr * 1 * 2
        assert.equal(dv.getUint32(28, true), sr * 2, `byte rate for ${sr}Hz`);
        // Block align = channels * bitsPerSample/8 = 1 * 2
        assert.equal(dv.getUint16(32, true), 2, `block align for ${sr}Hz`);
        // Bits per sample
        assert.equal(dv.getUint16(34, true), 16, `bits per sample for ${sr}Hz`);
      }
    });

    it("data chunk size and total file size", () => {
      for (const numSamples of [1, 100, 256, 1024, 4096]) {
        const pcm = sineWave(numSamples, 440, 48000);
        const wav = wavFromPcm(pcm, 48000);
        const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

        assert.equal(dv.getUint32(36, false), 0x64617461, "data chunk magic");
        assert.equal(dv.getUint32(40, true), numSamples * 2,
          `data size for ${numSamples} samples`);
        assert.equal(wav.length, 44 + numSamples * 2,
          `total file size for ${numSamples} samples`);
      }
    });

    it("clamps samples to [-1, 1] and verifies actual values", () => {
      const pcm = new Float32Array([2.0, -2.0, 0.5, -0.5, 0.0, 1.0, -1.0]);
      const wav = wavFromPcm(pcm, 48000);
      const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

      // Sample 0: clamped to 1.0 → 32767
      assert.equal(dv.getInt16(44, true), 32767, "clamp +2.0 → 32767");
      // Sample 1: clamped to -1.0 → -32768
      assert.equal(dv.getInt16(46, true), -32768, "clamp -2.0 → -32768");
      // Sample 2: 0.5 → ~16383 or 16384
      const s2 = dv.getInt16(48, true);
      assert.ok(Math.abs(s2 - 16384) <= 1, `0.5 → ${s2} (expected ~16384)`);
      // Sample 3: -0.5 → ~-16384
      const s3 = dv.getInt16(50, true);
      assert.ok(Math.abs(s3 - (-16384)) <= 1, `-0.5 → ${s3} (expected ~-16384)`);
      // Sample 4: 0.0 → 0
      assert.equal(dv.getInt16(52, true), 0, "0.0 → 0");
      // Sample 5: 1.0 → 32767
      assert.equal(dv.getInt16(54, true), 32767, "1.0 → 32767");
      // Sample 6: -1.0 → -32768
      assert.equal(dv.getInt16(56, true), -32768, "-1.0 → -32768");
    });

    it("sine wave produces non-trivial sample values", () => {
      const pcm = sineWave(1000, 440, 48000);
      const wav = wavFromPcm(pcm, 48000);
      const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

      let minSample = 32767;
      let maxSample = -32768;
      let hasPositive = false;
      let hasNegative = false;
      for (let i = 0; i < 1000; i++) {
        const s = dv.getInt16(44 + i * 2, true);
        if (s < minSample) minSample = s;
        if (s > maxSample) maxSample = s;
        if (s > 0) hasPositive = true;
        if (s < 0) hasNegative = true;
      }
      assert.ok(hasPositive, "sine should have positive samples");
      assert.ok(hasNegative, "sine should have negative samples");
      assert.ok(maxSample > 30000, `max sample ${maxSample} should be near 32767`);
      assert.ok(minSample < -30000, `min sample ${minSample} should be near -32768`);
    });

    it("empty samples produces valid WAV header with 0 data", () => {
      const pcm = new Float32Array(0);
      const wav = wavFromPcm(pcm, 48000);
      assert.equal(wav.length, 44, "header only");
      const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      assert.equal(dv.getUint32(40, true), 0, "data size = 0");
    });
  });
});
