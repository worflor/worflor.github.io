/**
 * live-wasm-video-recorder.ts
 *
 * VP8/VP9 WebM export for the Whisper Raw Video Codec.
 * Uses WebCodecs VideoEncoder + inline EBML/WebM muxer.
 * Zero external dependencies.
 */

import { VideoCodec } from "./live-wasm-video";

// ---------------------------------------------------------------------------
// Inline WebM/EBML muxer
// ---------------------------------------------------------------------------

function ebmlId(id: number): number[] {
    if (id <= 0xff) return [id];
    if (id <= 0xffff) return [id >> 8, id & 0xff];
    if (id <= 0xffffff) return [id >> 16, (id >> 8) & 0xff, id & 0xff];
    return [(id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff];
}

function ebmlSize(size: number): number[] {
    if (size < 0x7f) return [size | 0x80];
    if (size < 0x3fff) return [0x40 | (size >> 8), size & 0xff];
    if (size < 0x1fffff) return [0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff];
    return [0x10 | ((size >> 24) & 0x0f), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
}

function ebmlElement(id: number, data: number[]): number[] {
    return [...ebmlId(id), ...ebmlSize(data.length), ...data];
}

function ebmlUint(val: number, width: number): number[] {
    const out: number[] = [];
    for (let i = width - 1; i >= 0; i--) out.push((val >> (i * 8)) & 0xff);
    return out;
}

function ebmlFloat64(val: number): number[] {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, val);
    return Array.from(new Uint8Array(buf));
}

function ebmlString(s: string): number[] {
    return Array.from(new TextEncoder().encode(s));
}

interface MuxedFrame {
    data: Uint8Array;
    timestamp: number; // ms
    isKey: boolean;
}

function buildWebM(frames: MuxedFrame[], width: number, height: number, codecId: string): ArrayBuffer {
    const ebmlHeader = ebmlElement(0x1a45dfa3, [
        ...ebmlElement(0x4286, ebmlUint(1, 1)),
        ...ebmlElement(0x42f7, ebmlUint(1, 1)),
        ...ebmlElement(0x42f2, ebmlUint(4, 1)),
        ...ebmlElement(0x42f3, ebmlUint(8, 1)),
        ...ebmlElement(0x4282, ebmlString("webm")),
        ...ebmlElement(0x4287, ebmlUint(4, 1)),
        ...ebmlElement(0x4285, ebmlUint(2, 1)),
    ]);

    const info = ebmlElement(0x1549a966, [
        ...ebmlElement(0x2ad7b1, ebmlUint(1_000_000, 4)),
        ...ebmlElement(0x4d80, ebmlString("whisper")),
        ...ebmlElement(0x5741, ebmlString("whisper")),
        ...ebmlElement(0x4489, ebmlFloat64(frames.length > 0 ? frames[frames.length - 1].timestamp : 0)),
    ]);

    const trackEntry = ebmlElement(0xae, [
        ...ebmlElement(0xd7, ebmlUint(1, 1)),
        ...ebmlElement(0x73c5, ebmlUint(1, 4)),
        ...ebmlElement(0x83, ebmlUint(1, 1)),
        ...ebmlElement(0x86, ebmlString(codecId)),
        ...ebmlElement(0xe0, [
            ...ebmlElement(0xb0, ebmlUint(width, 2)),
            ...ebmlElement(0xba, ebmlUint(height, 2)),
        ]),
    ]);
    const tracks = ebmlElement(0x1654ae6b, trackEntry);

    const clusters: number[][] = [];
    let currentCluster: number[] | null = null;
    let clusterTimestamp = 0;

    for (const frame of frames) {
        if (frame.isKey || !currentCluster) {
            if (currentCluster) clusters.push(currentCluster);
            clusterTimestamp = frame.timestamp;
            currentCluster = [
                ...ebmlElement(0xe7, ebmlUint(Math.round(clusterTimestamp), 4)),
            ];
        }
        const relTs = Math.round(frame.timestamp - clusterTimestamp);
        const flags = frame.isKey ? 0x80 : 0x00;
        const blockData = [0x81, (relTs >> 8) & 0xff, relTs & 0xff, flags, ...frame.data];
        currentCluster.push(...ebmlId(0xa3), ...ebmlSize(blockData.length), ...blockData);
    }
    if (currentCluster) clusters.push(currentCluster);

    const clusterBytes: number[] = [];
    for (const c of clusters) {
        clusterBytes.push(...ebmlElement(0x1f43b675, c));
    }

    const segmentBody = [...info, ...tracks, ...clusterBytes];
    const segment = [...ebmlId(0x18538067), ...ebmlSize(segmentBody.length), ...segmentBody];

    const result = new Uint8Array([...ebmlHeader, ...segment]);
    return result.buffer;
}

// ---------------------------------------------------------------------------
// WhisperVideoRecorder
// ---------------------------------------------------------------------------

const CODEC_MAP = {
    vp8: { webcodecs: "vp8",           matroska: "V_VP8" },
    vp9: { webcodecs: "vp09.00.10.08", matroska: "V_VP9" },
} as const;

export type RecorderCodec = keyof typeof CODEC_MAP;

export interface RecorderConfig {
    codec?: RecorderCodec;      // default "vp8"
    bitrate?: number;           // default 2_000_000
    framerate?: number;         // default 30
    keyFrameInterval?: number;  // default 30 frames
}

export class WhisperVideoRecorder {
    private codec: VideoCodec | null;
    private config: Required<RecorderConfig>;
    private encoder: VideoEncoder | null = null;
    private muxedFrames: MuxedFrame[] = [];
    private width = 0;
    private height = 0;
    private framesSinceKey = 0;
    private stopped = false;

    constructor(codec?: VideoCodec, config?: RecorderConfig) {
        this.codec = codec ?? null;
        this.config = {
            codec: config?.codec ?? "vp8",
            bitrate: config?.bitrate ?? 2_000_000,
            framerate: config?.framerate ?? 30,
            keyFrameInterval: config?.keyFrameInterval ?? 30,
        };
    }

    private ensureEncoder(width: number, height: number) {
        if (this.encoder && this.width === width && this.height === height) return;
        if (this.encoder) this.encoder.close();

        this.width = width;
        this.height = height;

        this.encoder = new VideoEncoder({
            output: (chunk) => {
                const buf = new Uint8Array(chunk.byteLength);
                chunk.copyTo(buf);
                this.muxedFrames.push({
                    data: buf,
                    timestamp: chunk.timestamp / 1000,
                    isKey: chunk.type === "key",
                });
            },
            error: (e) => console.error("VideoEncoder error:", e),
        });

        this.encoder.configure({
            codec: CODEC_MAP[this.config.codec].webcodecs,
            width,
            height,
            bitrate: this.config.bitrate,
            framerate: this.config.framerate,
        });
    }

    feedFrame(pixels: Uint8Array, width: number, height: number, timestampUs: number) {
        if (this.stopped) throw new Error("Recorder already stopped");
        if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs not available");

        this.ensureEncoder(width, height);

        const frame = new VideoFrame(
            new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
            { timestamp: timestampUs, codedWidth: width, codedHeight: height, format: "RGBA" },
        );
        const keyFrame = this.framesSinceKey === 0 || this.framesSinceKey >= this.config.keyFrameInterval;
        if (keyFrame) this.framesSinceKey = 0;
        this.framesSinceKey++;
        this.encoder!.encode(frame, { keyFrame });
        frame.close();
    }

    feedPacket(packet: Uint8Array, timestampUs: number) {
        if (!this.codec) throw new Error("No VideoCodec provided — use feedFrame() instead");
        const img = this.codec.decodeToImageData(packet);
        if (!img) throw new Error("Packet tampered or decode failed");
        this.feedFrame(new Uint8Array(img.data.buffer), img.width, img.height, timestampUs);
    }

    async stop(): Promise<Blob> {
        if (this.stopped) throw new Error("Already stopped");
        this.stopped = true;

        if (this.encoder && this.encoder.encodeQueueSize > 0) {
            await this.encoder.flush();
        }
        if (this.encoder) {
            this.encoder.close();
            this.encoder = null;
        }

        const matroskaCodecId = CODEC_MAP[this.config.codec].matroska;
        const webm = buildWebM(this.muxedFrames, this.width, this.height, matroskaCodecId);
        return new Blob([webm], { type: "video/webm" });
    }
}
