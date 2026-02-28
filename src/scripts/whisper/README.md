# Whisper Protocol

encrypted communication with physics-based compression. the codecs model the physical systems that produce media and transmit those parameters instead of raw signal.

## architecture

```
Whisper Protocol
├── Whisper Logos     - 0D entropy codec (???, but it exists)
├── Whisper Harmonic  - 1D audio codec (symmetric damped harmonic oscillator)
├── Whisper Lumen     - 2D video codec (surface geometry model using 3-neighbor Möbius predictor)
├── Whisper Spatial   - 3D volumetric codec (7-neighbor Möbius predictor)
├── Whisper Akasha    - 4D spatiotemporal codec (15-neighbor hybercube Möbius predictor)
├── Whisper Kū        - 5D plenoptic codec (31-neighbor hypercube Möbius predictor)
├── Ratcheting layer  - per-frame cryptographic forward secrecy
├── Async messaging   - store-and-forward encrypted messages
└── Live + Campfire   - real-time messaging
```

## components

### Whisper Harmonic (`live-wasm-audio.ts`)

models sound as a **symmetric damped harmonic oscillator**:

```
pred = (Anchor_Future + Friction × Anchor_Past) / Tension
```

- **bidirectional mesh interpolation**: 15–20% gain via future-anchored residues
- **boundary-anchored stability**: solves the 1D entropy floor using Key C
- 228x realtime encoding (WASM SIMD)
- per-chunk cryptographic ratcheting
- Mid/Side stereo decomposition

### Whisper Lumen (`live-wasm-video.ts`)

models images as **physical surfaces via second-order Taylor expansion**:

```
pred = D + α·(L−D) + β·(A−D) + γ·(fyy + fxx + fxy)
```

- 8-25x compression (scales with resolution)
- per-frame cryptographic ratcheting
- SUB-delta temporal encoding
- full Hessian curvature fitting

### Whisper Spatial (`live-wasm-spatial.ts`)

models 3D scalar fields via the **7-neighbor Möbius predictor**:

P = L + A + B − DXY − DXZ − DYZ + D3

- 20-984× compression (scales with resolution)
- **anti-causal boundary collapse**: 33% guaranteed zero residuals
- topology layer: 2D surface crossing map with crossing center encoding
- binary sphere: 564× (causal) → **984×** (anti-causal) at 128³
- binarysurf mode: flip-position coding, no value field
- 7-mode adaptive coder

### Whisper Akasha (`live-wasm-akasha.ts`)

models 4D spatiotemporal scalar fields via the **15-neighbor Möbius predictor**:

P = (L+A+B+T) − (DXY+DXZ+DXT+DYZ+DYT+DZT) + (DXYZ+DXYT+DXZT+DYZT) − D4

- 25-1533× compression (scales with resolution)
- topology layer: 3D surface crossing map (recursive: uses Spatial predictor)
- **anti-causal boundary collapse**: 41.4% guaranteed zero residuals via binomial theorem
- crossing center xmid = (x1+x2)/2 decouples sphere center from surface geometry
- SLERP fields: **1533×** at 48⁴ | quat orbit: 442× | binary hypersphere: 678×
- 7-mode adaptive coder (12-bit positions for 4096-voxel blocks)

---

## how it works

standard codecs compress data, transform to frequency domain, quantize, entropy code.

these codecs compress physics. fit a mathematical model of the source, ship the coefficients, regenerate at the decoder. real media has structure. sound follows vibration physics, images follow surface geometry. the residual is whatever the model can't explain.

## license

licensed under the [Whisper Protocol License](./LICENSE.md), separate from the root repository's AGPL.

## status

- 360+ tests passing (audio + video)
- Whisper Spatial codec complete — binary sphere 984× at 128³
- Whisper Akasha codec complete — SLERP 1533× at 48⁴, quat orbit 442×, binary 678×
- production-grade quality metrics
- integrated encryption with forward secrecy
- patent pending
