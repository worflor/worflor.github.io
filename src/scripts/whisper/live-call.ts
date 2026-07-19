// whisper live call engine. real-time voice as a stream of short harmonic frames.
// capture: mic -> gain -> worklet -> 80ms frames -> harmonic encode -> sendFrame hook.
// playback: harmonic decode -> scheduled audiobuffer chain with a small adaptive lead.
// the engine owns audio only; signaling (stream state, mute flags) lives with the caller.

import { encodeHarmonic, decodeHarmonic } from "./live-wasm-audio";

/* ── constants (shared vocabulary, see spec) ─────────────── */

/** request this AudioContext rate. harmonic carries the actual rate in its own
 *  header, so the peer decodes correctly even when the browser gives a different one. */
export const CALL_SAMPLE_RATE_TARGET = 16000;
/** each captured frame spans this many milliseconds. */
export const CALL_FRAME_MS = 80;
/** harmonic quality for call frames. */
export const CALL_QUALITY = 45;
/** initial playback scheduling lead, ~1.5 frames. */
export const CALL_START_LEAD_S = 0.12;
/** minimum lead when re-anchoring after an underrun. */
export const CALL_MIN_LEAD_S = 0.06;
/** scheduled-ahead cap; beyond this a frame is dropped to bound latency. */
export const CALL_MAX_BACKLOG_S = 0.40;
/** at most this many harmonic encodes may be in flight at once. */
const MAX_PENDING_ENCODES = 2;

export interface CallEngineHooks {
  /** one encoded harmonic frame, ready for the wire. */
  sendFrame(blob: Uint8Array): void;
  /** local mic level 0..1, emitted once per captured frame (even while muted). */
  onLocalLevel(level: number): void;
  /** peer voice level 0..1, emitted once per played frame. */
  onPeerLevel(level: number): void;
  /** fatal engine failure (mic denied, context failure). engine is stopped. */
  onError(err: unknown): void;
}

/**
 * decide when a decoded frame should start playing. returns startAt (ctx time)
 * or null when the frame must be dropped to bound latency.
 *
 * the "first frame ever" case is signalled by the nextTime === 0 sentinel: a
 * running AudioContext's currentTime is always > 0, so a genuinely scheduled frame
 * never leaves nextTime at exactly 0. a fresh start uses the larger startLead; a
 * later underrun (nextTime > 0 but already in the past) re-anchors at the tighter minLead.
 */
export function planFramePlayback(
  now: number,
  nextTime: number,
  frameDur: number,
  opts?: { startLead?: number; minLead?: number; maxBacklog?: number },
): { startAt: number | null; nextTime: number } {
  const startLead = opts?.startLead ?? CALL_START_LEAD_S;
  const minLead = opts?.minLead ?? CALL_MIN_LEAD_S;
  const maxBacklog = opts?.maxBacklog ?? CALL_MAX_BACKLOG_S;
  if (nextTime <= now) {
    const firstEver = nextTime === 0;
    const startAt = now + (firstEver ? startLead : minLead);
    return { startAt, nextTime: startAt + frameDur };
  }
  if (nextTime - now > maxBacklog) {
    // too far ahead: drop the frame and leave the schedule untouched.
    return { startAt: null, nextTime };
  }
  return { startAt: nextTime, nextTime: nextTime + frameDur };
}

function clampGain(v: number): number {
  return Math.min(2, Math.max(0, v));
}

/** inline AudioWorkletProcessor as a blob url so no extra file is needed. mirrors the
 *  ptt capture worklet in live-ui.ts, under a distinct processor name. */
function callCaptureWorkletUrl(): string {
  const code = `
    class WhisperCallCapture extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) this.port.postMessage(new Float32Array(ch));
        return true;
      }
    }
    registerProcessor("whisper-call-capture", WhisperCallCapture);
  `;
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

export class CallEngine {
  readonly stats = {
    framesSent: 0,
    framesDroppedEncode: 0,
    framesRecv: 0,
    framesDroppedLate: 0,
  };

  private hooks: CallEngineHooks;

  private _running = false;
  private _starting = false;
  /** bumped by stop(). start() snapshots it and aborts if it moved across an await,
   *  so a stop issued mid-start can never leave the mic hot afterwards. */
  private stopEpoch = 0;
  private _muted = false;
  private _micGainValue = 1;
  private _peerVolumeValue = 1;
  /** harmonic quality for outgoing frames. the alpha slider owns this knob: calls
   *  and voice notes are the same codec, so they share the same dial. */
  private _quality = CALL_QUALITY;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private zeroGain: GainNode | null = null;
  private peerGain: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;

  private frameSamples = 0;
  private pendingChunks: Float32Array[] = [];
  private pendingLen = 0;
  private pendingEncodes = 0;
  /** strict send-order queue: encodes may finish out of order, but frames always
   *  reach hooks.sendFrame in capture order. */
  private sendChain: Promise<void> = Promise.resolve();

  /** strict decode-order queue for inbound frames. */
  private decodeChain: Promise<void> = Promise.resolve();
  /** next playback start time (ctx clock). 0 = first frame ever, see planFramePlayback. */
  private nextPlayTime = 0;

  constructor(hooks: CallEngineHooks) {
    this.hooks = hooks;
  }

  get running(): boolean { return this._running; }
  get muted(): boolean { return this._muted; }

  /** idempotent. must be called from a user gesture (getUserMedia + AudioContext). */
  async start(): Promise<void> {
    if (this._running || this._starting) return;
    this._starting = true;
    const epoch = this.stopEpoch;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // calls are conversational and full-duplex, so browser dsp is wanted here,
        // unlike voice notes.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (this.stopEpoch !== epoch) {
        // stopped while the permission prompt was up: release the mic and bail.
        for (const t of stream.getTracks()) { try { t.stop(); } catch { /* */ } }
        return;
      }
      this.stream = stream;
      this.micTrack = stream.getAudioTracks()[0] ?? null;
      if (this._muted && this.micTrack) this.micTrack.enabled = false;

      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: CALL_SAMPLE_RATE_TARGET });
      } catch {
        ctx = new AudioContext();
      }
      this.ctx = ctx;
      await ctx.resume();
      if (this.stopEpoch !== epoch) return; // stop() already tore down what we set

      this.frameSamples = Math.round(ctx.sampleRate * (CALL_FRAME_MS / 1000));

      const blobUrl = callCaptureWorkletUrl();
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      if (this.stopEpoch !== epoch) return;

      // graph: source -> micGain -> worklet -> zeroGain(0) -> destination.
      // the zero-gain sink keeps the worklet pulled without feeding mic to speakers.
      const source = ctx.createMediaStreamSource(stream);
      this.micSource = source;
      const micGain = ctx.createGain();
      micGain.gain.value = this._micGainValue;
      this.micGain = micGain;
      const worklet = new AudioWorkletNode(ctx, "whisper-call-capture");
      this.workletNode = worklet;
      const zeroGain = ctx.createGain();
      zeroGain.gain.value = 0;
      this.zeroGain = zeroGain;

      source.connect(micGain);
      micGain.connect(worklet);
      worklet.connect(zeroGain);
      zeroGain.connect(ctx.destination);

      // playback bus: decoded frames -> peerGain -> destination.
      const peerGain = ctx.createGain();
      peerGain.gain.value = this._peerVolumeValue;
      this.peerGain = peerGain;
      peerGain.connect(ctx.destination);

      worklet.port.onmessage = (ev) => {
        const chunk = ev.data;
        if (!(chunk instanceof Float32Array) || !this._running) return;
        this.pendingChunks.push(chunk);
        this.pendingLen += chunk.length;
        let frame: Float32Array | null;
        while ((frame = this.drainFrame()) !== null) this.processCaptureFrame(frame);
      };

      this._running = true;
    } catch (err) {
      // an intentional stop() mid-start makes pending context work reject; that is
      // teardown, not failure, so it must not surface as an error.
      if (this.stopEpoch !== epoch) return;
      this.stop();
      this.hooks.onError(err);
      throw err;
    } finally {
      this._starting = false;
    }
  }

  /** idempotent. full teardown: tracks stopped, nodes disconnected, ctx closed. */
  stop(): void {
    this.stopEpoch++;
    this._running = false;
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); } catch { /* already gone */ }
      this.workletNode = null;
    }
    if (this.micSource) { try { this.micSource.disconnect(); } catch { /* */ } this.micSource = null; }
    if (this.micGain) { try { this.micGain.disconnect(); } catch { /* */ } this.micGain = null; }
    if (this.zeroGain) { try { this.zeroGain.disconnect(); } catch { /* */ } this.zeroGain = null; }
    if (this.peerGain) { try { this.peerGain.disconnect(); } catch { /* */ } this.peerGain = null; }
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch { /* */ } }
      this.stream = null;
    }
    this.micTrack = null;
    if (this.ctx) {
      const c = this.ctx;
      this.ctx = null;
      c.close().catch(() => { /* guard InvalidStateError on an already-closed context */ });
    }
    this.pendingChunks = [];
    this.pendingLen = 0;
    this.pendingEncodes = 0;
    this.frameSamples = 0;
    this.nextPlayTime = 0;
    this.sendChain = Promise.resolve();
    this.decodeChain = Promise.resolve();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    // flip the track rather than tearing down capture: keeps aec adaptation warm.
    if (this.micTrack) this.micTrack.enabled = !m;
  }

  setPeerVolume(v: number): void {
    this._peerVolumeValue = clampGain(v);
    if (this.peerGain) this.peerGain.gain.value = this._peerVolumeValue;
  }

  setMicGain(v: number): void {
    this._micGainValue = clampGain(v);
    if (this.micGain) this.micGain.gain.value = this._micGainValue;
  }

  /** takes effect on the next captured frame; safe to call mid-call. a
   *  non-finite value is ignored so garbage can never poison the encoder. */
  setQuality(q: number): void {
    if (!Number.isFinite(q)) return;
    this._quality = Math.max(1, Math.min(100, Math.round(q)));
  }

  pushPeerFrame(blob: Uint8Array): void {
    if (!this._running) return;
    this.decodeChain = this.decodeChain.then(async () => {
      if (!this._running) return;
      let decoded: { pcm: Float32Array; sampleRate: number };
      try {
        decoded = await decodeHarmonic(blob);
      } catch {
        return; // corrupt frame, drop it
      }
      if (!this._running) return; // engine stopped mid-decode
      this.stats.framesRecv++;
      this.scheduleFrame(decoded.pcm, decoded.sampleRate);
    }).catch(() => { /* keep the decode queue alive */ });
  }

  /* ── internals ─────────────────────────────────────────── */

  /** pull exactly frameSamples off the front of the pending chunk list, keeping the
   *  remainder. returns null until a full frame is available. */
  private drainFrame(): Float32Array | null {
    if (this.frameSamples <= 0 || this.pendingLen < this.frameSamples) return null;
    const frame = new Float32Array(this.frameSamples);
    let filled = 0;
    while (filled < this.frameSamples) {
      const head = this.pendingChunks[0];
      const need = this.frameSamples - filled;
      if (head.length <= need) {
        frame.set(head, filled);
        filled += head.length;
        this.pendingChunks.shift();
      } else {
        frame.set(head.subarray(0, need), filled);
        this.pendingChunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.pendingLen -= this.frameSamples;
    return frame;
  }

  private processCaptureFrame(frame: Float32Array): void {
    const ctx = this.ctx;
    if (!ctx || !this._running) return;

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.hooks.onLocalLevel(Math.min(1, rms * 4));

    if (this._muted) return; // zero bandwidth while muted
    if (this.pendingEncodes >= MAX_PENDING_ENCODES) { this.stats.framesDroppedEncode++; return; }

    this.pendingEncodes++;
    // no harmonic encryption key: the sealed wire layer already encrypts and
    // authenticates every frame; a second key layer buys nothing and costs cpu.
    const encodePromise = encodeHarmonic(frame, ctx.sampleRate, undefined, {
      quality: this._quality,
      numChannels: 1,
    }).then(
      (blob) => ({ ok: true as const, blob }),
      () => ({ ok: false as const }),
    );
    this.sendChain = this.sendChain
      .then(async () => {
        const res = await encodePromise;
        if (res.ok && this._running) {
          this.hooks.sendFrame(res.blob);
          this.stats.framesSent++;
        }
      })
      .catch(() => { /* keep the send queue alive */ })
      .finally(() => { this.pendingEncodes--; });
  }

  private scheduleFrame(pcm: Float32Array, sampleRate: number): void {
    const ctx = this.ctx;
    const peerGain = this.peerGain;
    if (!ctx || !peerGain || !this._running || pcm.length === 0) return;

    const frameDur = pcm.length / sampleRate;
    const plan = planFramePlayback(ctx.currentTime, this.nextPlayTime, frameDur);
    if (plan.startAt === null) {
      this.stats.framesDroppedLate++;
      return; // nextPlayTime left unchanged
    }
    this.nextPlayTime = plan.nextTime;

    // webaudio resamples the decoded rate to the ctx rate automatically.
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(peerGain);
    src.start(plan.startAt);

    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / pcm.length);
    this.hooks.onPeerLevel(Math.min(1, rms * 4));
  }
}
