# Whisper Protocol

encrypted communication with physics-based compression. the codecs model the physical systems that produce media and transmit those parameters instead of raw signal.

## architecture

```
Whisper Protocol
├── Whisper Logos      - 0D entropy codec (8-bit boolean lattice entropy predictor)
├── Whisper Harmonic   - 1D audio codec (symmetric damped harmonic oscillator)
├── Whisper Lumen      - 3D image and video codec (spatiotemporal light field, CDF 9/7 + Möbius prediction)
├── Whisper Spatial    - 3D volumetric codec (7-neighbour complex Möbius predictor)
├── Whisper Akasha     - 4D spatiotemporal codec (15-neighbour quaternion Möbius predictor)
├── Whisper Kū         - 5D plenoptic codec (31-neighbour hypercube Möbius predictor)
├── Whisper Loup       - 8D self codec (255-neighbour octonion Möbius predictor)
├── Whisper Kizuna     - 16D membrane codec (65535-neighbour sedenion lattice predictor + spectral witness handshake primitive)
├── Whisper Prism      - unified API facade for the codec tower
├── Ratcheting layer   - per-frame cryptographic forward secrecy
├── Async messaging    - store-and-forward encrypted messages
└── Live + Campfire    - real-time encrypted messaging
```

## components

### Whisper Harmonic (`live-wasm-audio.ts`)

models sound as a **damped harmonic oscillator** — the same second-order differential equation that governs vibrating strings, vocal tracts, and resonating columns of air:

```
pred = K · x[n-1] − G · x[n-2]

K = 2r·cos(ω₀)  — encodes frequency
G = r²           — encodes damping
stability:  K² ≤ 4G  (poles inside unit circle)
```

- **AR(2) oscillator**: per 32-sample block Cramer least-squares fit in hand-written WASM
- **Burg lattice**: adaptive-order LPC (up to order 12) per 256-sample super-block, captures formants and polyphonic structure
- **trial encode**: both paths (Burg+AR(2) vs AR(2)-only) are evaluated, cheaper one wins
- **harmonic topology**: Goertzel extraction of harmonics 2..N, 2D Möbius predictor on the spectral surface
- **CDF 5/3 wavelet**: integer-to-integer lifting on aperiodic residual, per-subband cascaded K/G resonator
- **Mid/Side stereo**: M=(L+R)/2, S=L−R, lossless, zero overhead
- per-frame ChaCha20 encryption + SipHash-lite MAC, forward secrecy via ratchet

### Whisper Lumen (`live-wasm-video.ts`)

models video as a **3D light field** — frames are not a sequence of 2D images but slices of a continuous 3D volume where time is a true geometric dimension:

```
3D hybrid wavelet:  CDF 5/3 (integer, temporal) + CDF 9/7 (float, spatial)
                    temporal axis decomposes into low (still) + high (motion)

Möbius prediction:  P = L + A + B − DXY − DXZ − DYZ + D3
                    7-neighbor inclusion-exclusion over the unit 3-cube

quantization:       dead-zone with Laplace-optimal bias (1/4),
                    Mannos-Sakrison CSF weighting per subband,
                    activity masking (Stevens power law, γ=0.15)

baseQ:              2^((100 − quality) / 20)   — 20 Q-points per octave
```

- **3D CDF 9/7 biorthogonal wavelet**: float spatial (α=-1.586, β=-0.053, γ=0.883, δ=0.444, K=1.230), integer temporal
- **GOP-pair buffering**: GOP=2 frames. temporal-low = the still, temporal-high = the motion. static content → temporal-high ≈ 0 → excellent compression (hold frames = 68 bytes, 0.4% of keyframe)
- **4 GOP types**: INTRA (I-pair), SLIDING (P-diff vs previous reconstruction), SINGLE (fallback), KEYREF (long-term reference)
- **per-subband 4-mode coder**: 00=zero, 01=adaptive Rice + 3D Möbius prediction, 10=block-based 8-mode, 11=Logos (context-adaptive arithmetic)
- **adaptive step selection**: 1-bit flag per subband signals fine step (80% of base) vs base step, Lagrangian RD decision at λ=ln(2)
- **chroma-from-luma (CfL)**: linear regression on ALL subbands (not just DC), alpha clamped ±2 (BT.601 bounds), adaptive NN vs bilinear upsampling
- **6-parameter affine registration**: Lucas-Kanade iterative refinement for inter-frame motion compensation
- **Mannos-Sakrison CSF**: luma sensitivity peaks at ~5.11 cpd, chroma uses Mullen 1985 chromatic CSF
- **end-to-end encryption**: ChaCha20 + HalfSipHash-2-4 MAC per frame, forward secrecy via ratchet
- **wire format 0x0B**: variable-length header with sparse affine params, ULEB128 channel sizes
- competitive with WebP at matched byte counts on photographic content; Y-channel PSNR +10 dB vs WebP at matched quality
- runs in browser with zero native dependencies (JS + WASM)

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

### Whisper Kū (`live-wasm-ku.ts`)

models 5D hyperspectral spatiotemporal scalar fields via the **31-neighbor Möbius predictor**:

P = (L+A+B+T+U) − (10 pairs) + (10 triples) − (5 quadruples) + D5

- 20-1127× compression (scales with resolution)
- topology layer: 4D surface crossing map (recursive: 5D→4D→3D→2D→1D hierarchy)
- **anti-causal boundary collapse**: 48.7% guaranteed zero residuals via binomial theorem
- binary hypersphere: **1127×** at 24⁵ (vs Akasha 678× at 48⁴, smaller volume)
- SLERP fields: **925.8×** at 16⁵ | spectral orbit: 189.1× at 24⁵
- binary hypersphere scales super-linearly: 267× (8⁵) → 669× (16⁵) → 1127× (24⁵)
- quadratic width model φ=(w/2)²=R²−Σdᵢ² applied at all 4 recursion levels (NQ=2,4,7,11)
- 7-mode adaptive coder (15-bit positions for 32768-voxel blocks)
- encode → decode round-trip verified exact for all volume types

### Whisper Kizuna (`live-wasm-kizuna.ts`)

the sedenion step of the dimensional tower — **65535-neighbor Möbius predictor** and cryptographic handshake primitive:

P = Σ_{∅≠S⊆{0..15}} (−1)^(|S|+1) · block[bit-mask(S)]

- BS=2: each block is 65536 bytes (8KB). block index = bit-mask of coordinates.
- **anti-causal boundary collapse**: 65535/65536 = **99.998%** guaranteed zero residuals
- only the origin voxel has a non-zero residual — the full Möbius mixture of all 65535 neighbors
- algebraic proof of boundary theorem: paired cancelation for any dimension at max coordinate
- predictor exact for all polynomials without the full x₀·x₁·...·x₁₅ cross-term
- sedenions (R¹⁶) have zero divisors — the normed division algebra sequence closes at octonions (8D)
- the Möbius error = n-form holds for any n regardless of algebraic structure

**spectral handshake primitive** (`handshake16D`):

```
ECDH shared secret → HKDF(65536 bytes) → 16D block
                            ↓
                      predAnti16D → origin residual (single 16D Möbius mixture)
                            ↓
  block8D    = the 65536-byte block (same layout as 8D Octonion block, BS=4, 4⁸=65536)
  countsBitM = BitContextModelM primed with 512 bytes of key material
                            ↓
  8D spatial predictor + 0D entropy coder initialized from shared secret
  both parties derive all three independently — zero extra wire bytes
```

- attacker without ECDH key cannot decompress early traffic (unknown predictor and entropy state)
- **0D↔16D duality**: 65535 bit-tree contexts for 16-bit symbols = 65535 Möbius neighbors
  both index the Boolean lattice Λ*(R¹⁶). chain rule over bit probabilities = spatial inclusion-exclusion.
- `BitContextModel16`: 65535-context adaptive coder for 16-bit symbols (512KB counts)
- 72/72 tests — WHT identity, direct boundary theorem (all 65535 boundary masks), binomial structure, predictor exactness, round-trip, spectral handshake, avalanche, clamping, error handling, large stress

**Whisper Loop** (`live-loop.ts`, test spec: `test-loop.ts`) — ratchet unified with codec:

```
LoopState: { chain (32B), counts (0D), block8D (8D), step }

loopStep():  expandChain → HKDF(chain, step, 'kizuna-expand-v1') → AES-CTR(65536B)
             predAnti16D → residual
             deriveMessageKey → HKDF(chain, residual, 'kizuna-msg-v1'   || step)
             advanceChain    → HKDF(chain, residual, 'kizuna-chain-v1' || step)
             overlay counts from expanded  (0D learns ratchet material)
             XOR block8D with expanded     (8D context evolves)

loopEncode/loopDecode: BitContextModelM compression, counts evolve identically on both sides
loopExpand: HKDF(key, 0x00..., 'kizuna-init-v1') → AES-CTR(65536B) — seeds loopInit per DH period
```

- the ratchet IS the codec. the codec IS the ratchet.
- fully integrated into live.ts — replaces the symmetric chain KDF for all per-message derivation
- KDF: HKDF-SHA256 + AES-CTR (WebCrypto). loop states reinit from ECDH chain keys on each DH step.
- wire format: AES-GCM ciphertext contains `[4B decodedLen LE][loopEncoded plaintext]`
- two-layer opacity: eavesdropper cannot decrypt (wrong messageKey) AND cannot decompress (wrong loop state)
- 65/65 tests — purity, chain sensitivity, empty/large messages, 100-step stress, counts compatibility with handshake16D, forward secrecy, counts monotonic, consecutive same-sender, block8D evolution

---

## how it works

standard codecs compress data, transform to frequency domain, quantize, entropy code.

these codecs compress physics. fit a mathematical model of the source, ship the coefficients, regenerate at the decoder. real media has structure. sound follows vibration physics, images follow surface geometry. the residual is whatever the model can't explain.

## license

licensed under the [Whisper Protocol License](./LICENSE.md), separate from the root repository's AGPL.

## status

- 850+ tests passing (audio + video + spatial + kizuna + prism + logos + loop)
- Whisper Lumen codec rewritten — native 3D spatiotemporal wavelet (CDF 9/7 float spatial + CDF 5/3 integer temporal), Möbius prediction, competitive with WebP
- Whisper Spatial codec complete — binary sphere 984× at 128³
- Whisper Akasha codec complete — SLERP 1533× at 48⁴, quat orbit 442×, binary 678×
- Whisper Kū codec complete — binary hypersphere 1127× at 24⁵, SLERP 925.8× at 16⁵, round-trip verified
- Whisper Kizuna complete — 16D Möbius, 99.998% free zeros, WHT identity, direct boundary theorem
- Whisper Loop complete — HKDF+AES-CTR KDFs, fully integrated into live.ts
- Whisper Prism complete — unified API facade, WHT spectrum pre-filter (WASM SIMD), auto-routing
- 850+ tests passing across the full codec suite
- production-grade quality metrics
- integrated encryption with forward secrecy — Kizuna membrane live in production
- patent pending
