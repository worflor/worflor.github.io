import { encodeAdpcm, decodeAdpcm } from "../../../src/scripts/whisper/live-wasm-audio.ts";

export interface HarmonicStressSummary {
  totalTests: number;
  passCount: number;
  failCount: number;
}

async function runTest(name: string, pcm: Float32Array, numChannels: number, quality: number) {
  const sampleRate = 48000;
  try {
    const adpcm = await encodeAdpcm(pcm, sampleRate, undefined, { quality, numChannels });
    const { pcm: decoded, tampered } = await decodeAdpcm(adpcm);

    if (tampered) throw new Error("MAC failure: Tampering detected in clean stream!");
    if (decoded.length !== pcm.length) throw new Error(`Length mismatch: ${pcm.length} vs ${decoded.length}`);

    let maxDelta = 0;
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) {
      const delta = Math.abs(pcm[i] - decoded[i]);
      if (delta > maxDelta) maxDelta = delta;
      sumSq += delta * delta;
    }
    const rmsErr = Math.sqrt(sumSq / pcm.length);

    console.log(`  [${name}] MaxDelta: ${maxDelta.toExponential(4)}, RMSE: ${rmsErr.toExponential(4)}`);

    if (maxDelta > 0.05) {
      console.log("    DEBUG: Sample Diffs (first 10):");
      for (let i = 0; i < Math.min(pcm.length, 20); i++) {
        if (Math.abs(pcm[i] - decoded[i]) > 1e-4) {
          console.log(`      idx ${i}: orig=${pcm[i].toFixed(6)}, dec=${decoded[i].toFixed(6)}, diff=${(pcm[i] - decoded[i]).toFixed(6)}`);
        }
      }
      throw new Error(`Quality check failed: MaxDelta too high (${maxDelta})`);
    }
    return true;
  } catch (error) {
    console.error(`  [${name}] FAILED!`, error);
    return false;
  }
}

export async function runHarmonicStressTest(): Promise<HarmonicStressSummary> {
  console.log("=== Whisper Harmonic: Ultimate Stress Test (Key C Mesh) ===");
  const sampleRate = 48000;
  let passCount = 0;
  let totalTests = 0;

  const testCases = [
    { name: "Silence (Zero Field)", fn: (len: number) => new Float32Array(len) },
    {
      name: "Impuse (Delta)", fn: (len: number) => {
        const samples = new Float32Array(len);
        samples[Math.floor(len / 2)] = 1.0;
        return samples;
      }
    },
    {
      name: "White Noise", fn: (len: number) => {
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) samples[i] = (Math.random() * 2 - 1) * 0.8;
        return samples;
      }
    },
    {
      name: "Full Scale Sine (1kHz)", fn: (len: number) => {
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) samples[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate);
        return samples;
      }
    },
    {
      name: "Max Clipping Square", fn: (len: number) => {
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) samples[i] = i % 100 < 50 ? 1.0 : -1.0;
        return samples;
      }
    },
    {
      name: "Low Frequency (20Hz)", fn: (len: number) => {
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) samples[i] = Math.sin(2 * Math.PI * 20 * i / sampleRate);
        return samples;
      }
    },
    {
      name: "High Frequency (22kHz)", fn: (len: number) => {
        const samples = new Float32Array(len);
        for (let i = 0; i < len; i++) samples[i] = Math.sin(2 * Math.PI * 22000 * i / sampleRate);
        return samples;
      }
    },
    {
      name: "DC Offset", fn: (len: number) => {
        const samples = new Float32Array(len);
        samples.fill(0.5);
        return samples;
      }
    }
  ];

  const channelConfigs = [1, 2];
  const frameSizes = [1, 7, 31, 32, 33, 64, 127, 480, 1024, 4096];

  for (const channelCount of channelConfigs) {
    for (const size of frameSizes) {
      for (const testCase of testCases) {
        totalTests++;
        const actualLength = size * channelCount;
        const pcm = testCase.fn(actualLength);

        if (channelCount === 2) {
          for (let i = 0; i < size; i++) {
            pcm[i * 2 + 1] = pcm[i * 2] * 0.5 + Math.sin(i * 0.1);
          }
        }

        const success = await runTest(`${testCase.name} (Ch:${channelCount}, Len:${size})`, pcm, channelCount, 80);
        if (success) passCount++;
      }
    }
  }

  console.log("\n=== STRESS TEST SUMMARY ===");
  console.log(`Tests Run: ${totalTests}`);
  console.log(`Passed:    ${passCount}`);
  console.log(`Failed:    ${totalTests - passCount}`);

  if (passCount === totalTests) {
    console.log("\nCONCLUSION: Harmonic Codec is ROCK SOLID.");
  } else {
    console.error("\nCONCLUSION: Regression found in Stress Test!");
    throw new Error(`Harmonic stress test failed: ${totalTests - passCount} / ${totalTests} cases failed`);
  }

  return {
    totalTests,
    passCount,
    failCount: totalTests - passCount,
  };
}