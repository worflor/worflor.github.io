/**
 * live-wasm-video-renderer.ts
 *
 * Streaming playback for the Whisper Raw Video Codec.
 * Decodes encrypted packets and renders to canvas in real-time.
 */

import { VideoCodec } from "./live-wasm-video";

export interface VideoRendererStats {
    frames: number;
    fps: number;
    avgDecodeMs: number;
    avgRenderMs: number;
}

export class WhisperVideoRenderer {
    readonly canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private codec: VideoCodec;
    private frames = 0;
    private decodeTimeSum = 0;
    private renderTimeSum = 0;
    private fpsFrames = 0;
    private fpsTime = 0;
    private fps = 0;
    private destroyed = false;

    constructor(codec: VideoCodec, canvas?: HTMLCanvasElement) {
        this.codec = codec;
        this.canvas = canvas ?? document.createElement("canvas");
        const ctx = this.canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");
        this.ctx = ctx;
        this.fpsTime = performance.now();
    }

    feed(packet: Uint8Array): boolean {
        if (this.destroyed) return false;

        const t0 = performance.now();
        const img = this.codec.decodeToImageData(packet);
        const t1 = performance.now();
        if (!img) return false;

        if (this.canvas.width !== img.width || this.canvas.height !== img.height) {
            this.canvas.width = img.width;
            this.canvas.height = img.height;
        }

        this.ctx.putImageData(img, 0, 0);
        const t2 = performance.now();

        this.frames++;
        this.decodeTimeSum += t1 - t0;
        this.renderTimeSum += t2 - t1;
        this.fpsFrames++;

        const now = performance.now();
        const elapsed = now - this.fpsTime;
        if (elapsed >= 1000) {
            this.fps = (this.fpsFrames * 1000) / elapsed;
            this.fpsFrames = 0;
            this.fpsTime = now;
        }

        return true;
    }

    getStats(): VideoRendererStats {
        const n = this.frames || 1;
        return {
            frames: this.frames,
            fps: this.fps,
            avgDecodeMs: this.decodeTimeSum / n,
            avgRenderMs: this.renderTimeSum / n,
        };
    }

    destroy() {
        this.destroyed = true;
    }
}
