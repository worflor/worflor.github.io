# Whisper Protocol

**The Digital Twin of Communication**

Whisper Protocol is an encrypted communication system built on parametric physics compression — transmitting the physics that *generates* media rather than the media itself.

## Architecture

```
Whisper Protocol
├── Whisper Harmonics  — Audio codec (physics of sound)
├── Whisper Spatial    — Video codec (physics of light)
├── Live + Campfire    — Real-time messaging
├── Async messaging    — Store-and-forward encrypted messages
└── Ratcheting layer   — Per-frame cryptographic forward secrecy
```

## Components

### Whisper Harmonics (`live-wasm-audio.ts`)
Audio codec modeling sound as a damped harmonic oscillator:
```
pred = Tension × p1 − Friction × p2
```
- 228× realtime encoding
- Per-chunk cryptographic ratcheting
- Mid/Side stereo decomposition
- WASM SIMD acceleration

### Whisper Spatial (`live-wasm-video.ts`)
Video codec modeling images as physical surfaces:
```
pred = D + α·(L−D) + β·(A−D) + γ·(fyy + fxx + fxy)
```
- 8-25× compression (scales with resolution)
- Per-frame cryptographic ratcheting
- SUB-delta temporal encoding
- Full Hessian curvature modeling

## License

**This directory uses a custom license** — see [LICENSE.md](./LICENSE.md).

Key points:
- ✅ Free for individuals, nonprofits, education, open source, bootstrapped startups
- 💰 Commercial license required for VC-backed companies, public companies, government
- 🚫 Prohibited: surveillance, persecution, censorship, discrimination

The root repository does not have an MIT license. This directory has its own license above.

## How It Works

Traditional codecs compress *data* — transform to frequency domain, quantize, entropy code.

Whisper compresses *physics* — fit mathematical models, transmit parameters, regenerate at decoder.

Why it works: Real media has structure. Sound follows vibration physics. Images follow surface geometry. Whisper exploits this.

## Status

- ✅ 370 tests passing (122 audio + 248 video)
- ✅ Production-grade quality metrics
- ✅ Integrated encryption with forward secrecy
- 📄 Patent pending

---

*"We don't transmit the waveform. We transmit the physics that produced it."*
