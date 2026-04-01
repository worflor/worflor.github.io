import { describe, it } from "node:test";
import {
  encodeHarmonic,
  decodeHarmonic,
} from "../../src/scripts/whisper/live-wasm-audio.ts";
import type { SpatialObject } from "../../src/scripts/whisper/live-wasm-audio.ts";

const SR = 48000;

function snr(orig: Float32Array, dec: Float32Array, numCh: number, ch: number): number {
  let sig = 0, noise = 0;
  const len = orig.length / numCh;
  for (let i = 0; i < len; i++) {
    const o = orig[i * numCh + ch], d = dec[i * numCh + ch];
    sig += o * o;
    noise += (o - d) * (o - d);
  }
  return noise > 0 ? 10 * Math.log10(sig / noise) : 999;
}

function makeSpeech(len: number, amp = 0.5): Float32Array {
  const pcm = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 3 * i / SR);
    const ph = 2 * Math.PI * f0 * i / SR;
    pcm[i] = amp * (0.5 * Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.15 * Math.sin(3 * ph) + 0.08 * Math.sin(5 * ph));
  }
  return pcm;
}

function makeNoise(len: number, amp = 0.4, seed = 0x12345678): Float32Array {
  const pcm = new Float32Array(len);
  let state = seed;
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pcm[i] = (((state >>> 8) / 0x01000000) * 2 - 1) * amp;
  }
  return pcm;
}

function interleave(channels: Float32Array[]): Float32Array {
  const N = channels.length;
  const len = channels[0].length;
  const out = new Float32Array(len * N);
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < N; ch++) out[i * N + ch] = channels[ch][i];
  }
  return out;
}

describe("harmonic benchmark: mono Q sweep", () => {
  it("mono speech Q sweep with bitrate and SNR", async () => {
    const pcm = makeSpeech(SR); // 1 second
    console.log("\n  ── mono speech (1s, 48kHz) ──");
    console.log("    Q   bytes   kbps   SNR(dB)  enc(ms)  dec(ms)");
    console.log("    " + "─".repeat(52));
    for (const q of [10, 20, 30, 40, 50, 60, 70, 80, 90, 95]) {
      const t0 = performance.now();
      const enc = await encodeHarmonic(pcm, SR, undefined, { quality: q });
      const t1 = performance.now();
      const { pcm: dec } = await decodeHarmonic(enc);
      const t2 = performance.now();
      const kbps = enc.length * 8 / 1000;
      const s = snr(pcm, dec, 1, 0);
      console.log(`    ${q.toString().padStart(2)}  ${enc.length.toString().padStart(6)}  ${kbps.toFixed(0).padStart(5)}  ${s.toFixed(1).padStart(7)}  ${(t1-t0).toFixed(1).padStart(7)}  ${(t2-t1).toFixed(1).padStart(7)}`);
    }
  });
});

describe("harmonic benchmark: stereo coupling efficiency", () => {
  it("stereo correlated vs uncorrelated", async () => {
    const speech = makeSpeech(SR);
    const noise = makeNoise(SR, 0.4, 0xABCD);

    console.log("\n  ── stereo coupling (1s, 48kHz, Q=80) ──");
    console.log("    signal           channel(B)  object(B)  saving   SNR_L   SNR_R");
    console.log("    " + "─".repeat(65));

    // identical L=R
    const identical = interleave([speech, speech]);
    const idCh = await encodeHarmonic(identical, SR, undefined, { quality: 80, numChannels: 2, layout: "channel" });
    const idOb = await encodeHarmonic(identical, SR, undefined, { quality: 80, numChannels: 2, layout: "object" });
    const idDec = await decodeHarmonic(idCh);
    const saving1 = ((1 - idCh.length / idOb.length) * 100).toFixed(1);
    console.log(`    identical L=R    ${idCh.length.toString().padStart(9)}  ${idOb.length.toString().padStart(9)}  ${saving1.padStart(5)}%  ${snr(identical, idDec.pcm, 2, 0).toFixed(1).padStart(5)}  ${snr(identical, idDec.pcm, 2, 1).toFixed(1).padStart(5)}`);

    // similar (L ≈ R + small noise)
    const noiseSmall = makeNoise(SR, 0.05, 0x9999);
    const rSimilar = new Float32Array(SR);
    for (let i = 0; i < SR; i++) rSimilar[i] = speech[i] + noiseSmall[i];
    const similar = interleave([speech, rSimilar]);
    const simCh = await encodeHarmonic(similar, SR, undefined, { quality: 80, numChannels: 2, layout: "channel" });
    const simOb = await encodeHarmonic(similar, SR, undefined, { quality: 80, numChannels: 2, layout: "object" });
    const simDec = await decodeHarmonic(simCh);
    const saving2 = ((1 - simCh.length / simOb.length) * 100).toFixed(1);
    console.log(`    similar L≈R      ${simCh.length.toString().padStart(9)}  ${simOb.length.toString().padStart(9)}  ${saving2.padStart(5)}%  ${snr(similar, simDec.pcm, 2, 0).toFixed(1).padStart(5)}  ${snr(similar, simDec.pcm, 2, 1).toFixed(1).padStart(5)}`);

    // uncorrelated
    const uncorr = interleave([speech, noise]);
    const unCh = await encodeHarmonic(uncorr, SR, undefined, { quality: 80, numChannels: 2, layout: "channel" });
    const unOb = await encodeHarmonic(uncorr, SR, undefined, { quality: 80, numChannels: 2, layout: "object" });
    const unDec = await decodeHarmonic(unCh);
    const saving3 = ((1 - unCh.length / unOb.length) * 100).toFixed(1);
    console.log(`    uncorrelated     ${unCh.length.toString().padStart(9)}  ${unOb.length.toString().padStart(9)}  ${saving3.padStart(5)}%  ${snr(uncorr, unDec.pcm, 2, 0).toFixed(1).padStart(5)}  ${snr(uncorr, unDec.pcm, 2, 1).toFixed(1).padStart(5)}`);
  });
});

describe("harmonic benchmark: 5.1 surround", () => {
  it("5.1 film-like content Q sweep", async () => {
    const len = SR; // 1 second
    const speech = makeSpeech(len, 0.5);
    const narrator = new Float32Array(len);
    for (let i = 0; i < len; i++) narrator[i] = 0.4 * Math.sin(2 * Math.PI * 180 * i / SR);
    const lfe = new Float32Array(len);
    for (let i = 0; i < len; i++) lfe[i] = 0.6 * Math.sin(2 * Math.PI * 40 * i / SR);
    const amb = makeNoise(len, 0.15, 0x5555);
    const amb2 = makeNoise(len, 0.12, 0x6666);

    // L and R share the speech, C has narrator, Ls/Rs have ambience
    const L = new Float32Array(len), R = new Float32Array(len);
    const Ls = new Float32Array(len), Rs = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      L[i] = speech[i] * 0.8 + amb[i] * 0.2;
      R[i] = speech[i] * 0.8 + amb2[i] * 0.2;
      Ls[i] = amb[i] * 0.7 + speech[i] * 0.1;
      Rs[i] = amb2[i] * 0.7 + speech[i] * 0.1;
    }

    const pcm = interleave([L, R, narrator, lfe, Ls, Rs]);

    console.log("\n  ── 5.1 film surround (1s, 48kHz) ──");
    console.log("    Q   ch(B)   obj(B)  saving  kbps(ch)  SNR_avg");
    console.log("    " + "─".repeat(55));

    for (const q of [30, 50, 60, 70, 80, 90]) {
      const chEnc = await encodeHarmonic(pcm, SR, undefined, { quality: q, numChannels: 6, layout: "channel" });
      const obEnc = await encodeHarmonic(pcm, SR, undefined, { quality: q, numChannels: 6, layout: "object" });
      const { pcm: dec } = await decodeHarmonic(chEnc);

      let avgSnr = 0;
      for (let ch = 0; ch < 6; ch++) avgSnr += snr(pcm, dec, 6, ch);
      avgSnr /= 6;

      const saving = ((1 - chEnc.length / obEnc.length) * 100).toFixed(1);
      const kbps = chEnc.length * 8 / 1000;

      console.log(`    ${q.toString().padStart(2)}  ${chEnc.length.toString().padStart(6)}  ${obEnc.length.toString().padStart(6)}  ${saving.padStart(5)}%  ${kbps.toFixed(0).padStart(7)}  ${avgSnr.toFixed(1).padStart(7)}`);
    }
  });
});

describe("harmonic benchmark: channel count scaling", () => {
  it("identical signal across 1-12 channels at Q80", async () => {
    const len = SR;
    const mono = makeSpeech(len, 0.5);

    console.log("\n  ── channel scaling (identical signal, Q=80) ──");
    console.log("    ch   bytes    kbps   ratio_vs_mono  enc(ms)");
    console.log("    " + "─".repeat(50));

    let monoSize = 0;
    for (const nch of [1, 2, 4, 6, 8, 12]) {
      const channels: Float32Array[] = [];
      for (let ch = 0; ch < nch; ch++) channels.push(mono);
      const pcm = nch === 1 ? mono : interleave(channels);

      const t0 = performance.now();
      const enc = await encodeHarmonic(pcm, SR, undefined, { quality: 80, numChannels: nch });
      const t1 = performance.now();

      if (nch === 1) monoSize = enc.length;
      const ratio = (enc.length / monoSize).toFixed(2);
      const kbps = enc.length * 8 / 1000;

      console.log(`    ${nch.toString().padStart(2)}  ${enc.length.toString().padStart(7)}  ${kbps.toFixed(0).padStart(6)}  ${ratio.padStart(13)}×  ${(t1-t0).toFixed(1).padStart(6)}`);
    }
  });
});

describe("harmonic benchmark: sample rate comparison", () => {
  it("mono speech across sample rates at Q80", async () => {
    console.log("\n  ── sample rate scaling (mono speech, Q=80) ──");
    console.log("    rate     samples  bytes   kbps   SNR(dB)  enc(ms)");
    console.log("    " + "─".repeat(55));

    for (const sr of [8000, 22050, 44100, 48000, 96000, 192000]) {
      const len = sr; // 1 second
      const pcm = new Float32Array(len);
      const freq = Math.min(440, sr / 4);
      for (let i = 0; i < len; i++) {
        const f0 = freq + 30 * Math.sin(2 * Math.PI * 3 * i / sr);
        const ph = 2 * Math.PI * f0 * i / sr;
        pcm[i] = 0.5 * (0.5 * Math.sin(ph) + 0.25 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph));
      }

      const t0 = performance.now();
      const enc = await encodeHarmonic(pcm, sr, undefined, { quality: 80 });
      const t1 = performance.now();
      const { pcm: dec } = await decodeHarmonic(enc);

      const kbps = enc.length * 8 / 1000;
      const s = snr(pcm, dec, 1, 0);

      console.log(`    ${sr.toString().padStart(6)}  ${len.toString().padStart(7)}  ${enc.length.toString().padStart(6)}  ${kbps.toFixed(0).padStart(5)}  ${s.toFixed(1).padStart(7)}  ${(t1-t0).toFixed(1).padStart(6)}`);
    }
  });
});

describe("harmonic benchmark: bitDepth precision", () => {
  it("16-bit and 24-bit precision across Q", async () => {
    const len = SR;
    const sine16 = new Float32Array(len);
    const sine24 = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      sine16[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / SR) * 32767) / 32768;
      sine24[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / SR) * 8388607) / 8388608;
    }

    console.log("\n  ── bit depth precision (1s sine, 48kHz) ──");
    console.log("    depth  Q   bytes   kbps    SNR(dB)    maxErr");
    console.log("    " + "─".repeat(55));

    for (const [depth, pcm] of [[16, sine16], [24, sine24]] as const) {
      for (const q of [30, 50, 80]) {
        const enc = await encodeHarmonic(pcm, SR, undefined, { quality: q, bitDepth: depth });
        const { pcm: dec } = await decodeHarmonic(enc);
        const kbps = enc.length * 8 / 1000;
        const s = snr(pcm, dec, 1, 0);
        let maxErr = 0;
        for (let i = 0; i < len; i++) {
          const e = Math.abs(pcm[i] - dec[i]);
          if (e > maxErr) maxErr = e;
        }
        console.log(`    ${depth.toString().padStart(5)}  ${q.toString().padStart(2)}  ${enc.length.toString().padStart(6)}  ${kbps.toFixed(0).padStart(5)}  ${s.toFixed(1).padStart(9)}  ${maxErr.toExponential(2).padStart(10)}`);
      }
    }
  });
});
