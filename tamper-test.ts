import { encodeAdpcm, decodeAdpcm } from "./src/scripts/whisper/live-wasm-audio.ts";

async function run() {
    const pcm = new Float32Array(100);
    for(let i=0; i<100; i++) pcm[i] = 0.5;

    const encoded = await encodeAdpcm(pcm, 48000);
    
    // Tamper with the ciphertext (flip a bit in the audio payload)
    encoded[20] ^= 0x01;

    const decoded = await decodeAdpcm(encoded);
    if (decoded.tampered) {
        console.log("✅ MAC correctly caught tampering! Resulting PCM length:", decoded.pcm.length);
    } else {
        console.error("❌ MAC FAILED TO CATCH TAMPERING!");
    }
}
run();
