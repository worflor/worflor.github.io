/**
 * live-audio-dsp.ts
 *
 * Signal processing and container utilities that sit outside the codec.
 * These belong to the capture/playback pipeline, not to the encryption codec.
 *
 * Design notes
 * ────────────
 * - dcBlock / inverseDcBlock are stateless per call: each call allocates fresh
 *   filter state and runs from zero.  This matches the per-message semantics
 *   of the codec (ChaCha20 state is also reset per message via reset_encoder_state /
 *   reset_decoder_state), so each encoded audio packet is fully self-contained.
 * - Both functions mutate the input array in-place and return it for chaining.
 * - α = 0.9995 gives a -3 dB point at ~3.8 Hz @ 48 kHz — removes mic DC bias
 *   with negligible impact on voice (lowest fundamental ~80 Hz).
 */

const DC_ALPHA = 0.9995;

/**
 * Encode-side DC-blocking high-pass IIR filter.
 * Apply to raw PCM **before** calling encodeAdpcm.
 *
 * Forward: y[n] = x[n] - x[n-1] + α·y[n-1]
 */
export function dcBlock(samples: Float32Array): Float32Array {
    let xPrev = 0, yPrev = 0;
    for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const y = x - xPrev + DC_ALPHA * yPrev;
        xPrev = x;
        yPrev = y;
        samples[i] = y;
    }
    return samples;
}

/**
 * Decode-side inverse of dcBlock — reconstructs the original signal.
 * Apply to decoded PCM **after** calling decodeAdpcm.
 *
 * Inverse (leaky integrator): x[n] = x[n-1] + y[n] - α·y[n-1]
 */
export function inverseDcBlock(samples: Float32Array): Float32Array {
    let xPrev = 0, yPrev = 0;
    for (let i = 0; i < samples.length; i++) {
        const y = samples[i];
        const x = xPrev + y - DC_ALPHA * yPrev;
        xPrev = x;
        yPrev = y;
        samples[i] = x;
    }
    return samples;
}

/**
 * Pack a float32 PCM array into a standard 16-bit mono PCM WAV file.
 * Clamps samples to [-1, 1] before int16 conversion.
 */
export function wavFromPcm(pcm: Float32Array, sampleRate: number): Uint8Array {
    const numSamples = pcm.length;
    const byteRate = sampleRate * 2;
    const dataBytes = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);

    dv.setUint32(0,  0x52494646, false); // "RIFF"
    dv.setUint32(4,  36 + dataBytes, true);
    dv.setUint32(8,  0x57415645, false); // "WAVE"
    dv.setUint32(12, 0x666d7420, false); // "fmt "
    dv.setUint32(16, 16, true);          // fmt chunk size
    dv.setUint16(20, 1, true);           // PCM
    dv.setUint16(22, 1, true);           // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, 2, true);           // block align
    dv.setUint16(34, 16, true);          // bits per sample
    dv.setUint32(36, 0x64617461, false); // "data"
    dv.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
        off += 2;
    }
    return new Uint8Array(buf);
}
