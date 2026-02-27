# Whisper Protocol

encrypted communication with physics-based compression. the codecs model the physical systems that produce media and transmit those parameters instead of raw signal.

## architecture

```
Whisper Protocol
├── Whisper Harmonics  - audio codec (harmonic oscillator model)
├── Whisper Spatial    - video codec (surface geometry model)
├── Live + Campfire    - real-time messaging
├── Async messaging    - store-and-forward encrypted messages
└── Ratcheting layer   - per-frame cryptographic forward secrecy
```

## components

### Whisper Harmonics (`live-wasm-audio.ts`)
models sound as a damped harmonic oscillator:
```
pred = Tension × p1 − Friction × p2
```
- 228x realtime encoding
- per-chunk cryptographic ratcheting
- Mid/Side stereo decomposition
- WASM SIMD acceleration

### Whisper Spatial (`live-wasm-video.ts`)
models images as physical surfaces via second-order Taylor expansion:
```
pred = D + α·(L−D) + β·(A−D) + γ·(fyy + fxx + fxy)
```
- 8-25x compression (scales with resolution)
- per-frame cryptographic ratcheting
- SUB-delta temporal encoding
- full Hessian curvature fitting

## how it works

standard codecs compress data, transform to frequency domain, quantize, entropy code.

these codecs compress physics. fit a mathematical model of the source, ship the coefficients, regenerate at the decoder. real media has structure. sound follows vibration physics, images follow surface geometry. the residual is whatever the model can't explain.

## license

see [LICENSE.md](./LICENSE.md) for this directory's license.

- free for individuals, nonprofits, education, open source, bootstrapped startups
- commercial license required for VC-backed companies, public companies, government
- prohibited: surveillance, persecution, censorship, discrimination

the root repository uses AGPL. this directory has its own separate license above.

## status

- 360+ tests passing (audio + video)
- production-grade quality metrics
- integrated encryption with forward secrecy
- patent pending
