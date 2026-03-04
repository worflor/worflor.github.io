import { CTRL_OP, decodeMediaCaps, decodeMediaIntent, encodeMediaCaps, encodeMediaIntent, type CtrlMediaCaps, type CtrlMediaIntent } from "./live-ctrl";
import type { WhisperLiveSession } from "./live";
import type { MediaCapability, MediaEffective, MediaIntent } from "./live-media-types";

export interface LiveCallCallbacks {
  onState?: (state: "idle" | "audio-live" | "video-live" | "audio-video-live") => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLocalStream?: (stream: MediaStream | null) => void;
  onLog?: (line: string) => void;
}

export class LiveCallSession {
  private readonly session: WhisperLiveSession;
  private readonly cb: LiveCallCallbacks;
  private readonly localStream = new MediaStream();
  private readonly remoteStream = new MediaStream();
  private trackBound = false;
  private localIntent: MediaIntent = { audio: false, video: false };
  private remoteIntent: MediaIntent = { audio: false, video: false };
  private localCaps: MediaCapability = {
    supportsAudioCodecHarmonic: true,
    supportsVideoCodecLumen: true,
    canSendAudio: true,
    canRecvAudio: true,
    canSendVideo: true,
    canRecvVideo: true,
  };
  private remoteCaps: MediaCapability = {
    supportsAudioCodecHarmonic: false,
    supportsVideoCodecLumen: false,
    canSendAudio: false,
    canRecvAudio: false,
    canSendVideo: false,
    canRecvVideo: false,
  };

  constructor(session: WhisperLiveSession, callbacks: LiveCallCallbacks = {}) {
    this.session = session;
    this.cb = callbacks;
    this.sync();
  }

  sync(): void {
    const pc = this.session.getPeerConnection();
    if (pc) this.bindPeerConnection(pc);
    this.advertiseCaps();
  }

  bindPeerConnection(pc: RTCPeerConnection): void {
    if (this.trackBound) return;
    this.trackBound = true;
    pc.addEventListener("track", (ev) => {
      this.remoteStream.addTrack(ev.track);
      this.cb.onRemoteStream?.(this.remoteStream);
      this.emitState();
    });
  }

  getRemoteStream(): MediaStream { return this.remoteStream; }
  getLocalStream(): MediaStream { return this.localStream; }

  attachLocalPreview(el: HTMLVideoElement): void {
    el.srcObject = this.localStream;
    void el.play().catch(() => void 0);
  }

  attachRemoteView(el: HTMLVideoElement): void {
    el.srcObject = this.remoteStream;
    void el.play().catch(() => void 0);
  }

  async setAudioEnabled(enabled: boolean): Promise<void> {
    this.localIntent.audio = enabled;
    if (enabled) await this.ensureTrack("audio");
    else this.disableTrack("audio");
    this.publishIntent();
    this.emitState();
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    this.localIntent.video = enabled;
    if (enabled) await this.ensureTrack("video");
    else this.disableTrack("video");
    this.publishIntent();
    this.emitState();
  }

  async upgradeToVideo(): Promise<void> {
    await this.setAudioEnabled(true);
    await this.setVideoEnabled(true);
  }

  async downgradeToAudio(): Promise<void> {
    await this.setVideoEnabled(false);
    await this.setAudioEnabled(true);
  }

  handleCtrl(opcode: number, payload: Uint8Array): boolean {
    if (opcode === CTRL_OP.MEDIA_CAPS) {
      const caps = decodeMediaCaps(payload);
      if (!caps) return true;
      this.remoteCaps = this.fromCtrlCaps(caps);
      this.emitState();
      return true;
    }
    if (opcode === CTRL_OP.MEDIA_INTENT || opcode === CTRL_OP.MEDIA_APPLY) {
      const intent = decodeMediaIntent(payload);
      if (!intent) return true;
      this.remoteIntent = intent;
      this.emitState();
      return true;
    }
    return false;
  }

  getEffectiveState(): MediaEffective {
    return {
      sendAudio: this.localIntent.audio && this.remoteCaps.canRecvAudio,
      sendVideo: this.localIntent.video && this.remoteCaps.canRecvVideo,
      recvAudio: this.remoteIntent.audio && this.localCaps.canRecvAudio,
      recvVideo: this.remoteIntent.video && this.localCaps.canRecvVideo,
    };
  }

  async destroy(): Promise<void> {
    for (const t of this.localStream.getTracks()) {
      t.stop();
      this.localStream.removeTrack(t);
    }
    this.cb.onLocalStream?.(null);
  }

  private toCtrlCaps(c: MediaCapability): CtrlMediaCaps {
    return {
      supportsHarmonic: c.supportsAudioCodecHarmonic,
      supportsLumen: c.supportsVideoCodecLumen,
      canSendAudio: c.canSendAudio,
      canRecvAudio: c.canRecvAudio,
      canSendVideo: c.canSendVideo,
      canRecvVideo: c.canRecvVideo,
    };
  }

  private fromCtrlCaps(c: CtrlMediaCaps): MediaCapability {
    return {
      supportsAudioCodecHarmonic: c.supportsHarmonic,
      supportsVideoCodecLumen: c.supportsLumen,
      canSendAudio: c.canSendAudio,
      canRecvAudio: c.canRecvAudio,
      canSendVideo: c.canSendVideo,
      canRecvVideo: c.canRecvVideo,
    };
  }

  private advertiseCaps(): void {
    this.session.sendCtrl(CTRL_OP.MEDIA_CAPS, encodeMediaCaps(this.toCtrlCaps(this.localCaps)));
  }

  private publishIntent(): void {
    const payload = encodeMediaIntent(this.localIntent as CtrlMediaIntent);
    this.session.sendCtrl(CTRL_OP.MEDIA_INTENT, payload);
    this.session.sendCtrl(CTRL_OP.MEDIA_APPLY, payload);
  }

  private async ensureTrack(kind: "audio" | "video"): Promise<void> {
    const existing = this.localStream.getTracks().find((t) => t.kind === kind);
    if (existing) {
      existing.enabled = true;
      await this.replaceSenderTrack(kind, existing);
      return;
    }

    const media = await navigator.mediaDevices.getUserMedia(kind === "audio" ? { audio: true } : { video: true });
    const track = media.getTracks()[0];
    this.localStream.addTrack(track);
    await this.replaceSenderTrack(kind, track);
    this.cb.onLocalStream?.(this.localStream);
    this.cb.onLog?.(`${kind} enabled`);
  }

  private disableTrack(kind: "audio" | "video"): void {
    const track = this.localStream.getTracks().find((t) => t.kind === kind);
    if (!track) return;
    track.enabled = false;
    this.cb.onLog?.(`${kind} disabled`);
  }

  private async replaceSenderTrack(kind: "audio" | "video", track: MediaStreamTrack): Promise<void> {
    const tx = this.session.getMediaTransceiver(kind);
    if (tx) {
      await tx.sender.replaceTrack(track);
      tx.direction = this.localIntent.video || this.localIntent.audio ? "sendrecv" : "recvonly";
      return;
    }
    const pc = this.session.getPeerConnection();
    if (!pc) return;
    pc.addTrack(track, this.localStream);
  }

  private emitState(): void {
    const s = this.getEffectiveState();
    let state: "idle" | "audio-live" | "video-live" | "audio-video-live" = "idle";
    if (s.sendAudio || s.recvAudio) state = "audio-live";
    if (s.sendVideo || s.recvVideo) state = "video-live";
    if ((s.sendAudio || s.recvAudio) && (s.sendVideo || s.recvVideo)) state = "audio-video-live";
    this.cb.onState?.(state);
  }
}
