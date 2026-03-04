export interface AudioEncoderStage {
  encode(samples: Float32Array): Promise<Uint8Array>;
}

export interface AudioDecoderStage {
  decode(packet: Uint8Array): Promise<Float32Array>;
}

export interface VideoEncoderStage {
  encodeFrame(frame: VideoFrame): Promise<Uint8Array>;
}

export interface VideoDecoderStage {
  decodeFrame(packet: Uint8Array): Promise<ImageBitmap | VideoFrame>;
}

export interface MediaEncryptStage {
  encrypt(packet: Uint8Array, kind: "audio" | "video"): Promise<Uint8Array>;
}

export interface MediaDecryptStage {
  decrypt(packet: Uint8Array, kind: "audio" | "video"): Promise<Uint8Array>;
}

export interface MediaPipeline {
  audioEncoder?: AudioEncoderStage;
  audioDecoder?: AudioDecoderStage;
  videoEncoder?: VideoEncoderStage;
  videoDecoder?: VideoDecoderStage;
  encryptor?: MediaEncryptStage;
  decryptor?: MediaDecryptStage;
}

export function createDefaultMediaPipeline(): MediaPipeline {
  return {};
}
