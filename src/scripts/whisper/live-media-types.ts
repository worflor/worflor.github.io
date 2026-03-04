export type NetworkClass = "poor" | "constrained" | "moderate" | "good" | "excellent";
export type DeviceClass = "low" | "medium" | "high";
export type MediaTier = "P0" | "P1" | "P2" | "P3" | "P4";

export interface MediaIntent {
  audio: boolean;
  video: boolean;
}

export interface MediaCapability {
  supportsAudioCodecHarmonic: boolean;
  supportsVideoCodecLumen: boolean;
  canSendAudio: boolean;
  canRecvAudio: boolean;
  canSendVideo: boolean;
  canRecvVideo: boolean;
}

export interface MediaEffective {
  sendAudio: boolean;
  recvAudio: boolean;
  sendVideo: boolean;
  recvVideo: boolean;
}

export interface MediaAdaptationSnapshot {
  networkClass: NetworkClass;
  deviceClass: DeviceClass;
  tier: MediaTier;
  reason: "startup-probe" | "loss-spike" | "rtt-spike" | "cpu-pressure" | "recover-stable";
}
