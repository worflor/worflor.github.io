# Whisper Protocol

encrypted communication with physics-based compression. the codecs model the physical systems that produce media and transmit those parameters instead of raw signal.

## architecture

```
Whisper Protocol
├── Whisper Logos      - 0D entropy codec (8-bit boolean lattice entropy predictor)
├── Whisper Harmonic   - 1D audio codec (symmetric damped harmonic oscillator)
├── Whisper Lumen      - 2D video codec (surface geometry model using 3-neighbour Möbius predictor)
├── Whisper Spatial    - 3D volumetric codec (7-neighbour complex Möbius predictor)
├── Whisper Akasha     - 4D spatiotemporal codec (15-neighbour quaternion Möbius predictor)
├── Whisper Kū         - 5D plenoptic codec (31-neighbour hypercube Möbius predictor)
├── Whisper Loup       - 8D self codec (255-neighbour octonion Möbius predictor)
├── Whisper Kizuna     - 16D membrane codec (65535-neighbour sedenion lattice predictor + spatial witniss handshake primitive)
├── Ratcheting layer   - per-frame cryptographic forward secrecy
├── Async messaging    - store-and-forward encrypted messages
└── Live + Campfire    - real-time encrypted messaging
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

**handshake primitive** (`handshake16D`):
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
- 72/72 tests — WHT identity, direct boundary theorem (all 65535 boundary masks), binomial structure, predictor exactness, round-trip, handshake, avalanche, clamping, error handling, large stress

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

- 360+ tests passing (audio + video)
- Whisper Spatial codec complete — binary sphere 984× at 128³
- Whisper Akasha codec complete — SLERP 1533× at 48⁴, quat orbit 442×, binary 678×
- Whisper Kū codec complete — binary hypersphere 1127× at 24⁵, SLERP 925.8× at 16⁵, round-trip verified
- Whisper Kizuna complete — 16D Möbius, 99.998% free zeros, 72/72 tests (WHT identity, direct boundary theorem)
- Whisper Loop complete — HKDF+AES-CTR KDFs, fully integrated into live.ts, 65/65 tests
- production-grade quality metrics
- integrated encryption with forward secrecy — Kizuna membrane live in production
- patent pending
