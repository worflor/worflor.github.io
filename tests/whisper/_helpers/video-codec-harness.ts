import { VideoCodec, HEADER_SIZE, MAC_SIZE } from "../../../src/scripts/whisper/live-wasm-video";
import { WhisperVideoRecorder } from "../../../src/scripts/whisper/live-wasm-video-recorder";

export interface VideoCodecStressSummary {
  pass: number;
  fail: number;
}

const CI_PERF_LIMIT_MS = 20;
const CI_COMPRESSED_PERF_LIMIT_MS = 3000;
const LOCAL_PERF_LIMIT_MS = 10;
const LOCAL_COMPRESSED_PERF_LIMIT_MS = 1500;
const IS_CI = !!process.env.CI;

function perfLimitMs(compressed: boolean): number {
  if (compressed) return IS_CI ? CI_COMPRESSED_PERF_LIMIT_MS : LOCAL_COMPRESSED_PERF_LIMIT_MS;
  return IS_CI ? CI_PERF_LIMIT_MS : LOCAL_PERF_LIMIT_MS;
}

function makeDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function randomPixels(n: number, seed = 0): Uint8Array {
  const rnd = makeDeterministicRng((0x9e3779b9 ^ n ^ Math.imul(seed + 1, 0x85ebca6b)) >>> 0);
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < px.length; i++) px[i] = Math.floor(rnd() * 256);
  return px;
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function contentSweepFrame(width: number, height: number, variant: number): Uint8Array {
  const mode = variant % 5;
  if (mode === 0) {
    return syntheticPixels(width, height, (x, y) => [
      clamp8(32 + x * 0.9 + y * 0.4),
      clamp8(64 + x * 0.25 + y * 0.8),
      clamp8(96 + x * 0.65 - y * 0.15),
    ]);
  }
  if (mode === 1) {
    const rnd = makeDeterministicRng((0x1234abcd ^ variant) >>> 0);
    return syntheticPixels(width, height, (x, y) => {
      const ripple = 40 * Math.sin((x + variant * 3) * 0.11) + 35 * Math.cos((y - variant * 5) * 0.07);
      const noise = (rnd() - 0.5) * 28;
      return [
        clamp8(110 + ripple + noise),
        clamp8(124 + ripple * 0.7 - noise * 0.4),
        clamp8(138 + ripple * 0.4 + noise * 0.8),
      ];
    });
  }
  if (mode === 2) {
    return syntheticPixels(width, height, (x, y) => {
      const edge = ((x >> 3) ^ (y >> 4) ^ variant) & 1 ? 216 : 40;
      return [
        edge,
        clamp8(((x * 17 + variant * 29) ^ (y * 11)) & 0xFF),
        clamp8(((y * 19 + variant * 13) ^ (x * 7)) & 0xFF),
      ];
    });
  }
  if (mode === 3) {
    const cx = width * 0.5;
    const cy = height * 0.5;
    const phase = variant * 0.13;
    return syntheticPixels(width, height, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      const wave = 48 * Math.sin(r * 0.14 + phase);
      return [
        clamp8(120 + wave + dx * 0.1),
        clamp8(118 + wave * 0.7 + dy * 0.12),
        clamp8(122 + wave * 0.45 - dx * 0.08 + dy * 0.05),
      ];
    });
  }
  return randomPixels(width * height, variant);
}

function syntheticPixels(width: number, height: number, gen: (x: number, y: number) => [number, number, number]): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = gen(x, y);
      const i = (y * width + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

function rgbPsnr(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  let mse = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c] - b[i + c];
      mse += d * d;
    }
  }
  mse /= (width * height * 3);
  return mse === 0 ? 999 : 10 * Math.log10(255 * 255 / mse);
}

async function warmVideoCodec(enc: VideoCodec, dec: VideoCodec, width: number, height: number, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    const px = contentSweepFrame(width, height, i);
    const pkt = enc.encode(px, width, height);
    dec.decode(pkt);
  }
}

export async function runVideoCodecStressTest(): Promise<VideoCodecStressSummary> {
  let pass = 0;
  let fail = 0;

  const key = new Uint32Array([0x12345678, 0x9ABCDEF0, 0x0FEDCBA9, 0x87654321, 0xCAFEBABE, 0xDEADC0DE, 0x8BADF00D, 0x0D15EA5E]);

  function ok(label: string, cond: boolean, detail?: string) {
    if (cond) {
      pass++;
    } else {
      fail++;
      console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    }
  }

  // [1] Basic 160x120 bit-perfect round-trip (quality 100 = raw/uncompressed)
  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const w = 160;
    const h = 120;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    ok("Packet size correct", pkt.length === HEADER_SIZE + w * h * 4 + MAC_SIZE);
    const res = dec.decode(pkt);
    ok("Not tampered", !res.tampered);
    ok("Dimensions match", res.width === w && res.height === h);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok("Every byte bit-identical", mismatch === 0, `${mismatch} mismatched`);
  }

  // [2] Remainder path (quality 100 = raw)
  for (const [w, h] of [[17, 1], [18, 1], [31, 1], [33, 1], [7, 5], [13, 13]]) {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const res = dec.decode(pkt);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok(`${w}x${h} (${w * h}px, remainder=${(w * h) % 16}) bit-perfect`, mismatch === 0 && !res.tampered, `${mismatch} mismatched, tampered=${res.tampered}`);
  }

  {
    const enc = new VideoCodec();
    await enc.init(key, { quality: 100 });
    const px = new Uint8Array(18 * 4);
    px.set([0xAA, 0xBB, 0xCC, 0xDD], 16 * 4);
    px.set([0x11, 0x22, 0x33, 0x44], 17 * 4);
    const pkt = enc.encode(px, 18, 1);
    const dv = new DataView(pkt.buffer, pkt.byteOffset);
    const c16 = dv.getUint32(HEADER_SIZE + 16 * 4, true);
    const c17 = dv.getUint32(HEADER_SIZE + 17 * 4, true);
    const p16 = 0xDDCCBBAA;
    const p17 = 0x44332211;
    const cipherXor = (c16 ^ c17) >>> 0;
    const plainXor = (p16 ^ p17) >>> 0;
    ok("Remainder pixels use distinct keystream", cipherXor !== plainXor, `cipher XOR=${cipherXor.toString(16)}, plain XOR=${plainXor.toString(16)} — KEYSTREAM REUSE!`);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(160 * 120);
    const pkt1 = enc.encode(px, 160, 120);
    const pkt2 = enc.encode(px, 160, 120);
    let cipherDiff = false;
    for (let i = HEADER_SIZE; i < pkt1.length - MAC_SIZE; i++) {
      if (pkt1[i] !== pkt2[i]) {
        cipherDiff = true;
        break;
      }
    }
    ok("Ciphertext changed between frames", cipherDiff);
    const r1 = dec.decode(pkt1);
    const r2 = dec.decode(pkt2);
    ok("Frame 1 decodes correctly", !r1.tampered);
    ok("Frame 2 decodes correctly", !r2.tampered);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== r2.pixels[i]) mismatch++;
    ok("Frame 2 bit-perfect", mismatch === 0);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(80 * 60, 1);
    const pkt = enc.encode(px, 80, 60);

    const t1 = new Uint8Array(pkt);
    t1[HEADER_SIZE + 100] ^= 0xFF;
    ok("Flipped ciphertext byte detected", dec.decode(t1).tampered);

    const dec2 = new VideoCodec();
    await dec2.init(key);
    const t2 = new Uint8Array(pkt);
    t2[pkt.length - 3] ^= 0x01;
    ok("Flipped MAC byte detected", dec2.decode(t2).tampered);
  }

  {
    const key2 = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD, 0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const enc1 = new VideoCodec();
    const enc2 = new VideoCodec();
    await enc1.init(key, { quality: 100 });
    await enc2.init(key2, { quality: 100 });
    const px = randomPixels(16, 2);
    const pkt1 = enc1.encode(px, 16, 1);
    const pkt2 = enc2.encode(px, 16, 1);
    const mac1 = new DataView(pkt1.buffer, pkt1.byteOffset).getUint32(pkt1.length - 8, true);
    const mac2 = new DataView(pkt2.buffer, pkt2.byteOffset).getUint32(pkt2.length - 8, true);
    ok("Different keys produce different MACs", mac1 !== mac2);
  }

  for (const [w, h] of [[1, 1], [2, 1], [4, 4], [16, 1], [32, 1], [15, 1]]) {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const res = dec.decode(pkt);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok(`${w}x${h} bit-perfect`, mismatch === 0 && !res.tampered);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    let allGood = true;
    for (let f = 0; f < 30; f++) {
      const px = contentSweepFrame(80, 60, f);
      const pkt = enc.encode(px, 80, 60);
      const res = dec.decode(pkt);
      if (res.tampered) {
        allGood = false;
        break;
      }
      for (let i = 0; i < px.length; i++) {
        if (px[i] !== res.pixels[i]) {
          allGood = false;
          break;
        }
      }
      if (!allGood) break;
    }
    ok("30 sequential frames bit-perfect", allGood);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(160 * 120);
    await warmVideoCodec(enc, dec, 160, 120, 8);

    const t0 = performance.now();
    for (let i = 0; i < 50; i++) enc.encode(px, 160, 120);
    const encTime = performance.now() - t0;

    const enc2 = new VideoCodec();
    const dec2 = new VideoCodec();
    await enc2.init(key, { quality: 100 });
    await dec2.init(key, { quality: 100 });
    const pkts: Uint8Array[] = [];
    for (let i = 0; i < 50; i++) pkts.push(enc2.encode(px, 160, 120));

    const t1 = performance.now();
    for (const pkt of pkts) dec2.decode(pkt);
    const decTime = performance.now() - t1;

    const avgEnc = encTime / 50;
    const avgDec = decTime / 50;
    const perfLimit = perfLimitMs(false);
    ok(`Encode+Decode < ${perfLimit}ms/frame`, avgEnc + avgDec < perfLimit, `measured ${(avgEnc + avgDec).toFixed(2)}ms/frame${IS_CI ? " on CI" : ""}`);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(16, 3);
    const pkt0 = enc.encode(px, 16, 1);
    const pkt1 = enc.encode(px, 16, 1);
    const pkt2 = enc.encode(px, 16, 1);
    const fc0 = new DataView(pkt0.buffer, pkt0.byteOffset).getUint32(4, true);
    const fc1 = new DataView(pkt1.buffer, pkt1.byteOffset).getUint32(4, true);
    const fc2 = new DataView(pkt2.buffer, pkt2.byteOffset).getUint32(4, true);
    ok("Frame counter starts at 0", fc0 === 0);
    ok("Frame counter increments", fc1 === 1 && fc2 === 2);
    const r0 = dec.decode(pkt0);
    const r1 = dec.decode(pkt1);
    const r2 = dec.decode(pkt2);
    ok("All 3 frames decode", !r0.tampered && !r1.tampered && !r2.tampered);
  }

  {
    const enc = new VideoCodec();
    await enc.init(key, { quality: 100 });
    const px = randomPixels(16, 4);
    const pkt0 = enc.encode(px, 16, 1);
    const pkt1 = enc.encode(px, 16, 1);
    let differ = false;
    for (let i = HEADER_SIZE; i < pkt0.length - MAC_SIZE; i++) {
      if (pkt0[i] !== pkt1[i]) {
        differ = true;
        break;
      }
    }
    ok("Same plaintext different frames = different ciphertext", differ);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(80 * 60, 5);
    const pkt = enc.encode(px, 80, 60);
    const t1 = new Uint8Array(pkt);
    t1[HEADER_SIZE + 50] ^= 0xFF;
    ok("Pre-ratchet tamper detected", dec.decode(t1).tampered);

    const enc2 = new VideoCodec();
    const dec2 = new VideoCodec();
    await enc2.init(key, { quality: 100 });
    await dec2.init(key, { quality: 100 });
    const pkt2 = enc2.encode(px, 80, 60);
    const t2 = new Uint8Array(pkt2);
    // flip a byte near the end of the payload (before MAC)
    const flipIdx = Math.min(HEADER_SIZE + 16800, pkt2.length - MAC_SIZE - 1);
    t2[flipIdx] ^= 0xFF;
    ok("Post-ratchet tamper detected", dec2.decode(t2).tampered);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const px = randomPixels(640 * 480, 6);
    const t0 = performance.now();
    const pkt = enc.encode(px, 640, 480);
    const encMs = performance.now() - t0;
    const t1 = performance.now();
    const res = dec.decode(pkt);
    const decMs = performance.now() - t1;
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok(`640x480 bit-perfect (enc=${encMs.toFixed(1)}ms, dec=${decMs.toFixed(1)}ms)`, mismatch === 0 && !res.tampered);
  }

  {
    ok("1x1 packet size", VideoCodec.packetSize(1, 1) === HEADER_SIZE + 4 + MAC_SIZE);
    ok("16x1 packet size", VideoCodec.packetSize(16, 1) === HEADER_SIZE + 64 + MAC_SIZE);
    ok("640x480 packet size", VideoCodec.packetSize(640, 480) === HEADER_SIZE + 640 * 480 * 4 + MAC_SIZE);
    const enc = new VideoCodec();
    await enc.init(key, { quality: 100 });
    const pkt = enc.encode(randomPixels(80 * 60, 7), 80, 60);
    ok("packetSize matches encode output", pkt.length === VideoCodec.packetSize(80, 60));
  }

  {
    const enc = new VideoCodec();
    await enc.init(key, { quality: 100 });
    const px = randomPixels(320 * 240, 8);
    enc.encode(px, 320, 240);
    const pkt1 = enc.encode(px, 320, 240);
    const hdr = VideoCodec.peekHeader(pkt1);
    ok("peekHeader width", hdr.width === 320);
    ok("peekHeader height", hdr.height === 240);
    ok("peekHeader frameIdx", hdr.frameIdx === 1);
    ok("peekHeader flags", hdr.flags === 0);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const buf = new Uint8Array(VideoCodec.packetSize(w, h));
    const written = enc.encodeInto(px, w, h, buf);
    ok("encodeInto returns correct size", written === VideoCodec.packetSize(w, h));
    const pkt = buf.subarray(0, written);
    const res = dec.decode(pkt);
    ok("encodeInto output decodes", !res.tampered);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok("encodeInto bit-perfect", mismatch === 0);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const pixelBuf = new Uint8Array(w * h * 4);
    const res = dec.decodeInto(pkt, pixelBuf);
    ok("decodeInto dimensions", res.width === w && res.height === h);
    ok("decodeInto not tampered", !res.tampered);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== pixelBuf[i]) mismatch++;
    ok("decodeInto bit-perfect", mismatch === 0);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const w = 80;
    const h = 60;
    const pktBuf = new Uint8Array(VideoCodec.packetSize(w, h));
    const pixBuf = new Uint8Array(w * h * 4);
    let allGood = true;
    for (let f = 0; f < 30; f++) {
      const px = contentSweepFrame(w, h, f + 100);
      const written = enc.encodeInto(px, w, h, pktBuf);
      const res = dec.decodeInto(pktBuf.subarray(0, written), pixBuf);
      if (res.tampered) {
        allGood = false;
        break;
      }
      for (let i = 0; i < px.length; i++) {
        if (px[i] !== pixBuf[i]) {
          allGood = false;
          break;
        }
      }
      if (!allGood) break;
    }
    ok("30 frames zero-alloc bit-perfect", allGood);
  }

  if (typeof globalThis.ImageData !== "undefined") {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key);
    await dec.init(key);
    const w = 32;
    const h = 16;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const img = dec.decodeToImageData(pkt);
    ok("Returns ImageData", img !== null && img instanceof ImageData);
    ok("ImageData dimensions match", img!.width === w && img!.height === h);
    let mismatch = 0;
    const imgBytes = new Uint8Array(img!.data.buffer);
    for (let i = 0; i < px.length; i++) if (px[i] !== imgBytes[i]) mismatch++;
    ok("ImageData pixels bit-perfect", mismatch === 0);

    const enc2 = new VideoCodec();
    const dec2 = new VideoCodec();
    await enc2.init(key);
    await dec2.init(key);
    const pkt2 = enc2.encode(px, w, h);
    pkt2[HEADER_SIZE + 10] ^= 0xff;
    ok("Tampered packet returns null", dec2.decodeToImageData(pkt2) === null);
  } else {
  }

  if (typeof globalThis.VideoEncoder !== "undefined") {
    const w = 64;
    const h = 48;
    const frameCount = 60;

    for (const codec of ["vp8", "vp9"] as const) {
      const enc = new VideoCodec();
      const dec = new VideoCodec();
      await enc.init(key);
      await dec.init(key);
      const recorder = new WhisperVideoRecorder(dec, { codec });
      for (let f = 0; f < frameCount; f++) {
        const px = contentSweepFrame(w, h, f + (codec === "vp8" ? 200 : 300));
        const pkt = enc.encode(px, w, h);
        recorder.feedPacket(pkt, f * 33_333);
      }
      const blob = await recorder.stop();
      ok(`${codec.toUpperCase()} blob is video/webm`, blob.type === "video/webm");
      ok(`${codec.toUpperCase()} blob has data`, blob.size > 100);
    }

    {
      const enc = new VideoCodec();
      const dec = new VideoCodec();
      await enc.init(key);
      await dec.init(key);
      const recorder = new WhisperVideoRecorder(dec, {
        codec: "vp8",
        bitrate: 500_000,
        framerate: 15,
        keyFrameInterval: 10,
      });
      for (let f = 0; f < 30; f++) {
        const px = contentSweepFrame(w, h, f + 400);
        const pkt = enc.encode(px, w, h);
        recorder.feedPacket(pkt, f * 66_667);
      }
      const blob = await recorder.stop();
      ok("Custom config blob is video/webm", blob.type === "video/webm");
      ok("Custom config blob has data", blob.size > 100);
    }
  } else {
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    const w = 160;
    const h = 120;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    ok("Compressed packet smaller than raw", pkt.length < VideoCodec.packetSize(w, h));
    const hdr = VideoCodec.peekHeader(pkt);
    ok("Flags indicate compressed", (hdr.flags & 1) === 1);
    ok("First frame is keyframe", (hdr.flags & 2) === 2);
    const res = dec.decode(pkt);
    ok("Not tampered", !res.tampered);
    ok("Dimensions match", res.width === w && res.height === h);
    ok("Output pixel count correct", res.pixels.length === w * h * 4);
  }

  for (const q of [50, 30]) {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: q });
    await dec.init(key, { quality: q });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    ok(`q${q} compressed smaller`, pkt.length < VideoCodec.packetSize(w, h));
    const res = dec.decode(pkt);
    ok(`q${q} not tampered`, !res.tampered);
    ok(`q${q} correct pixel count`, res.pixels.length === w * h * 4);
  }

  for (const [w, h] of [[100, 100], [127, 97], [33, 17]]) {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 60 });
    await dec.init(key, { quality: 60 });
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const hdr = VideoCodec.peekHeader(pkt);
    const res = dec.decode(pkt);
    ok(`${w}x${h} compressed flag set`, (hdr.flags & 1) === 1);
    ok(`${w}x${h} decodes`, !res.tampered);
    ok(`${w}x${h} dimensions match`, res.width === w && res.height === h);
    ok(`${w}x${h} output pixel count correct`, res.pixels.length === w * h * 4);
  }

  {
    const w = 64;
    const h = 64;
    const rgba = syntheticPixels(w, h, (x, y) => [(x * 4) & 0xFF, (y * 4) & 0xFF, ((x + y) * 2) & 0xFF]);
    const pts: { q: number; psnr: number; bpp: number }[] = [];
    for (const q of [20, 50, 75, 90, 95]) {
      const enc = new VideoCodec();
      const dec = new VideoCodec();
      await enc.init(key, { quality: q });
      await dec.init(key, { quality: q });
      const pkt = enc.encode(rgba, w, h);
      const res = dec.decode(pkt);
      ok(`q${q} chroma-stress decodes`, !res.tampered);
      pts.push({ q, psnr: rgbPsnr(rgba, res.pixels, w, h), bpp: (pkt.length * 8) / (w * h) });
    }
    let psnrMono = true;
    let bppMono = true;
    for (let i = 1; i < pts.length; i++) {
      // allow 0.5 dB tolerance for the discrete step selection near Q-point boundaries
      if (pts[i].psnr + 0.5 < pts[i - 1].psnr) psnrMono = false;
      if (pts[i].bpp + 0.01 < pts[i - 1].bpp) bppMono = false;
    }
    ok("Chroma-stress PSNR monotonic with quality", psnrMono, pts.map((p) => `Q${p.q}=${p.psnr.toFixed(2)}`).join(" "));
    ok("Chroma-stress bpp monotonic with quality", bppMono, pts.map((p) => `Q${p.q}=${p.bpp.toFixed(3)}`).join(" "));
  }

  {
    const w = 96;
    const h = 72;
    let allGood = true;
    let allSmaller = true;
    const psnrReadings: string[] = [];
    for (let variant = 0; variant < 8; variant++) {
      const enc = new VideoCodec();
      const dec = new VideoCodec();
      await enc.init(key, { quality: 80 });
      await dec.init(key, { quality: 80 });
      const rgba = contentSweepFrame(w, h, variant);
      const pkt = enc.encode(rgba, w, h);
      const res = dec.decode(pkt);
      const psnr = rgbPsnr(rgba, res.pixels, w, h);
      psnrReadings.push(`v${variant}=${psnr.toFixed(2)}`);
      if (res.tampered || res.pixels.length !== w * h * 4) allGood = false;
      if (pkt.length >= VideoCodec.packetSize(w, h)) allSmaller = false;
    }
    ok("Variable content sweep decodes", allGood, psnrReadings.join(" "));
    ok("Variable content sweep stays compressed", allSmaller);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80, keyFrameInterval: 30 });
    await dec.init(key, { quality: 80, keyFrameInterval: 30 });
    const w = 80;
    const h = 60;
    // Use solid color: DCT of constant block compresses to 1 coefficient (tiny I-frame),
    // and the same-frame P-frame delta is near-zero (much smaller than I-frame).
    const px0 = new Uint8Array(w * h * 4);
    for (let i = 0; i < px0.length; i += 4) { px0[i] = 100; px0[i+1] = 140; px0[i+2] = 180; px0[i+3] = 255; }
    const pkt0 = enc.encode(px0, w, h);
    const hdr0 = VideoCodec.peekHeader(pkt0);
    ok("Frame 0 is I-frame", (hdr0.flags & 2) === 2);

    const pkt1 = enc.encode(px0, w, h);
    const hdr1 = VideoCodec.peekHeader(pkt1);
    ok("Frame 1 is P-frame", (hdr1.flags & 2) === 0);
    ok("P-frame smaller than I-frame", pkt1.length < pkt0.length);

    // Frame 2: same solid content again → delta is accumulated reconstruction error only,
    // which for solid color is exactly zero → guaranteed P-frame.
    const pkt2 = enc.encode(px0, w, h);
    const hdr2 = VideoCodec.peekHeader(pkt2);
    ok("Frame 2 is P-frame", (hdr2.flags & 2) === 0);

    const r0 = dec.decode(pkt0);
    const r1 = dec.decode(pkt1);
    const r2 = dec.decode(pkt2);
    ok("All 3 frames decode without tamper", !r0.tampered && !r1.tampered && !r2.tampered);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    const keyFrameInterval = 5;
    await enc.init(key, { quality: 80, keyFrameInterval });
    await dec.init(key, { quality: 80, keyFrameInterval });
    const w = 32;
    const h = 16;
    const px = randomPixels(w * h);
    let lastKeyIdx = 0;
    for (let f = 0; f < keyFrameInterval + 2; f++) {
      const pkt = enc.encode(px, w, h);
      const hdr = VideoCodec.peekHeader(pkt);
      if ((hdr.flags & 2) === 2) lastKeyIdx = f;
      const res = dec.decode(pkt);
      ok(`Frame ${f} decodes`, !res.tampered);
    }
    ok(`Keyframe forced at or before frame ${keyFrameInterval}`, lastKeyIdx >= keyFrameInterval);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    const w = 160;
    const h = 120;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i += 4) {
      px[i] = 100;
      px[i + 1] = 150;
      px[i + 2] = 200;
      px[i + 3] = 255;
    }

    const iFrame = enc.encode(px, w, h);
    const rawSize = VideoCodec.packetSize(w, h);
    const iRatio = rawSize / iFrame.length;
    ok("I-frame compressed > 2x", iRatio > 2);

    const pFrame = enc.encode(px, w, h);
    const pRatio = rawSize / pFrame.length;
    ok("Static P-frame compressed > 3x", pRatio > 3);

    const r1 = dec.decode(iFrame);
    const r2 = dec.decode(pFrame);
    ok("Static frames decode", !r1.tampered && !r2.tampered);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    const tampered = new Uint8Array(pkt);
    tampered[HEADER_SIZE + 10] ^= 0xFF;
    ok("Tamper detected in compressed packet", dec.decode(tampered).tampered);
  }

  {
    const wrongKey = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD, 0x11111111, 0x22222222, 0x33333333, 0x44444444]);
    const enc = new VideoCodec();
    const goodDec = new VideoCodec();
    const badDec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await goodDec.init(key, { quality: 80 });
    await badDec.init(wrongKey, { quality: 80 });
    const w = 96;
    const h = 64;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    ok("Correct key still decodes", !goodDec.decode(pkt).tampered);
    ok("Wrong key is rejected", badDec.decode(pkt).tampered);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 100 });
    await dec.init(key, { quality: 100 });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const pkt = enc.encode(px, w, h);
    ok("Raw packet size matches packetSize()", pkt.length === VideoCodec.packetSize(w, h));
    const hdr = VideoCodec.peekHeader(pkt);
    ok("Flags = 0 (uncompressed)", hdr.flags === 0);
    const res = dec.decode(pkt);
    ok("Not tampered", !res.tampered);
    let mismatch = 0;
    for (let i = 0; i < px.length; i++) if (px[i] !== res.pixels[i]) mismatch++;
    ok("Bit-perfect at quality 100", mismatch === 0);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    let allGood = true;
    const w = 80;
    const h = 60;
    for (let f = 0; f < 20; f++) {
      const px = randomPixels(w * h);
      const pkt = enc.encode(px, w, h);
      const res = dec.decode(pkt);
      if (res.tampered || res.pixels.length !== w * h * 4) {
        allGood = false;
        break;
      }
    }
    ok("20 compressed frames all decode", allGood);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    const w = 80;
    const h = 60;
    const px = randomPixels(w * h);
    const buf = new Uint8Array(VideoCodec.packetSize(w, h));
    const written = enc.encodeInto(px, w, h, buf);
    ok("Compressed encodeInto returns < raw size", written < VideoCodec.packetSize(w, h));
    const pixBuf = new Uint8Array(w * h * 4);
    const res = dec.decodeInto(buf.subarray(0, written), pixBuf);
    ok("Compressed decodeInto not tampered", !res.tampered);
    ok("Compressed decodeInto dimensions", res.width === w && res.height === h);
  }

  {
    const enc = new VideoCodec();
    const dec = new VideoCodec();
    await enc.init(key, { quality: 80 });
    await dec.init(key, { quality: 80 });
    const w = 160;
    const h = 120;
    await warmVideoCodec(enc, dec, w, h, 6);
    const jitterRnd = makeDeterministicRng(0x51f15e5d);
    const frames: Uint8Array[] = [];
    for (let f = 0; f < 30; f++) {
      const px = new Uint8Array(contentSweepFrame(w, h, 900 + f));
      for (let i = 0; i < 200; i++) {
        const idx = Math.floor(jitterRnd() * px.length);
        px[idx] = (px[idx] + Math.floor(jitterRnd() * 10) - 5 + 256) & 0xFF;
      }
      frames.push(px);
    }

    const t0 = performance.now();
    const pkts: Uint8Array[] = [];
    for (const px of frames) pkts.push(enc.encode(px, w, h));
    const encTime = performance.now() - t0;

    const t1 = performance.now();
    for (const pkt of pkts) dec.decode(pkt);
    const decTime = performance.now() - t1;

    const avgEnc = encTime / 30;
    const avgDec = decTime / 30;
    const avgPktSize = pkts.reduce((sum, pkt) => sum + pkt.length, 0) / pkts.length;
    const rawSize = VideoCodec.packetSize(w, h);
    const perfLimit = perfLimitMs(true);
    ok(`Compressed pipeline under ${perfLimit}ms/frame`, avgEnc + avgDec < perfLimit, `measured ${(avgEnc + avgDec).toFixed(2)}ms/frame${IS_CI ? " on CI" : ""}`);
  }

  if (fail > 0) throw new Error(`Video codec stress test failed: ${fail} checks failed`);

  return { pass, fail };
}
