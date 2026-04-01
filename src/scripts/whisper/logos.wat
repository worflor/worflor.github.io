;;
;; logos.wat — Whisper Logos adaptive entropy codec
;;
;; Hand-written WebAssembly by Woflo / MB + Various LLMs
;;
;; Every opcode is deliberate. No compiler. No transpiler.
;; This is raw WASM that maps 1:1 to binary.
;;
;; The codec is a 7-axis attention predictor (6 temporal + 1 spatial):
;;
;;   TEMPORAL (always active):
;;   F0 (order-0 frequency, 255 bit tree)           — context-free byte distribution (CTW root)
;;   U  (bit-lane temporal, 32 ctx)                 — per-bit AR(2), in arithmetic blend
;;   O2 (full prev byte context, 256×255 bit tree) — absolute position in Z_2^8
;;   E  (Engram AR(2) trajectory, 256×255 bit tree) — K/G oscillator prediction
;;   P2N (prev-prev byte nibble class, 16×255 bit tree) — coarse bigram context
;;   M  (exact match, PPM exclusion)                — independent log-odds injection
;;
;;   SPATIAL (active only when stride > 0):
;;   Ab (above neighbor, 256×255 bit tree)          — inputBuf[i - stride]
;;
;; when data is serialized from a higher-dimensional grid (2D image, 3D volume),
;; the nearest spatial neighbor lands `stride` bytes back in the stream — far
;; beyond O2's 1-byte and E's 2-byte temporal horizon. Ab bridges that gap.
;; when stride = 0, Ab is completely inert: zero weight, no computation,
;; bit-identical output to a Logos without it.
;;
;; Axis relationships — complementary by temporal scale, not redundant:
;;   U  = bit-lane temporal: (p1_bit_k, p2_bit_k) → 4 contexts per bit position, 32 cells
;;        captures per-lane temporal patterns (alternation, runs, phase) at bit granularity.
;;        undamped weight: sweep confirmed 32-cell table warms fast enough that
;;        the prior 0.5× dampener was overcorrecting. |p-0.5| gates uncertainty.
;;   O2 = absolute byte position in Z_2^8 (full 256-class bigram); warms over ~256 bytes
;;   E  = byte trajectory — AR(2) Cramer fit (K,G per byte, 5 dot products); warms ~30 bytes
;;   Ab = spatial above-neighbor at offset -stride; bridges the serialization gap
;;   M  = deep context exact match (hash chain PPM, independent)
;;
;; 7 axes: F0, U, O2, E, P2N, Ab (Born amplitude pool) + M (log-odds injection)
;; Born rule mixing: p = (Σwᵢ√pᵢ)² / ((Σwᵢ√pᵢ)² + (Σwᵢ√(1-pᵢ))²)
;;   amplitude-space interference handles axis correlation natively.
;;   correlated axes naturally damped — double-counting costs quadratically.
;;   weights: w = |p-0.5| × min(log1p(n), cap) — confidence × capped evidence.
;;     split cap: F0=ln(2)≈0.693, U=ln(3)≈1.099, O2/E/P2N=ln(4)≈1.386.
;;   KT priors: F0 α=0.5, U α=0.5, O2 α=0.125, E α=0.5, P2N α=0.25
;;   SSE: adaptive α = max(0.05, 8/(1+n)) — James-Stein shrinkage.
;;   M independent log-odds → SSE → range coder.
;;
;; ═══════════════════════════════════════════════════════════════════════════════
;; MEMORY LAYOUT (94 pages = 6.0 MB)
;; ═══════════════════════════════════════════════════════════════════════════════
;;
;; Region      Offset     Size      Type          Description
;; ─────────── ────────── ───────── ───────────── ──────────────────────────
;; uC          0x000800   256       i32[64]       U-axis counts (bit-lane temporal)
;; sseC        0x010900   98,304    i32[24576]    SSE calibration grid (3ms×16o2b×32bkt×8k)
;; hist        0x029000   65,536    u8[65536]     History ring buffer
;; mPrev       0x039000   131,072   i32[32768]    M-axis prev chain
;; mLast2      0x059000   262,144   i32[65536]    M-axis 2-byte hash
;; matchBytes  0x0B9040   256       u8[256]       M candidate bytes
;; matchW      0x0B9140   2,048     f64[256]      M candidate weights
;; matchPos    0x0B9940   1,024     i32[256]      M candidate positions
;; eFreq       0x0BAA40   512       u16[256]      Entropy frequency table
;; eWindow     0x0BAC40   256       u8[256]       Entropy sliding window
;; diagHist    0x0BAD40   256       i32[64]       Run length histogram
;; LOG1P       0x0BAE40   32,768    f64[4096]     ln(1+n) lookup table
;; encBuf      0x0C3000   1,048,576 u8[1048576]   Encoder output buffer
;; inputBuf    0x1C3000   1,048,576 u8[1048576]   Input data buffer
;; decodeBuf   0x2C3000   1,048,576 u8[1048576]   Decoder output buffer
;; o2C         0x3C3000   524,288   i32[131072]   O2-axis counts (prev1 × bit tree)
;; eC          0x4C3000   524,288   i32[131072]   E-axis counts  (engPred × bit tree)
;; p2nC        0x543000   32,768    i32[8192]     P2N-axis counts (p2>>4 nibble × bit tree)
;; LOGIT_LUT   0x54B000   16,392    f64[2049]     logit(i/2048) lazy LUT + lerp
;; SIGMOID_LUT 0x550000   32,776    f64[4097]     σ(x) lazy LUT + lerp, x ∈ [-12,12]
;; f0C         0x558100   2,048     i32[512]      F0-axis counts (order-0 bit tree, CTW root)
;; abC         0x558900   524,288   i32[131072]   Ab-axis counts (above-neighbor × bit tree)
;; (end)       0x5D8900
;;
;; ═══════════════════════════════════════════════════════════════════════════════

(module
  (memory (export "mem") 94)

  ;; ─── GLOBALS (scalar state, faster than memory) ───────────────────────────

  (global $g_p1             (mut i32) (i32.const 0))
  (global $g_p2             (mut i32) (i32.const 0))
  (global $g_histPos        (mut i32) (i32.const 0))
  (global $g_matchCount     (mut i32) (i32.const 0))
  (global $g_mRunLen        (mut i32) (i32.const 0))
  (global $g_matchVolatility (mut i32) (i32.const 0))
  (global $g_decayTimer     (mut i32) (i32.const 0))
  (global $g_opinionAcc     (mut f64) (f64.const 0))
  (global $g_ePos           (mut i32) (i32.const 0))
  (global $g_eFull          (mut i32) (i32.const 0))
  (global $g_eBypass        (mut i32) (i32.const 0))
  (global $g_eDistinct      (mut i32) (i32.const 0))   ;; running count of distinct byte values in entropy window
  (global $g_sseIdx         (mut i32) (i32.const 0))

  ;; E-axis: Engram AR(2) running sums (no decay — Cramer uses ratios, uniform scaling is a no-op)
  ;; Fit b ≈ K·p1 - G·p2 via 5 running dot products per byte.
  (global $g_sP1P1          (mut f64) (f64.const 0.0))
  (global $g_sP2P2          (mut f64) (f64.const 0.0))
  (global $g_sP1P2          (mut f64) (f64.const 0.0))
  (global $g_sBP1           (mut f64) (f64.const 0.0))
  (global $g_sBP2           (mut f64) (f64.const 0.0))
  (global $g_engPred        (mut i32) (i32.const 128)) ;; AR(2) next-byte prediction

  ;; Arithmetic encoder state
  (global $g_enc_lo         (mut i32) (i32.const 0))
  (global $g_enc_range      (mut i32) (i32.const -1))  ;; 0xFFFFFFFF
  (global $g_enc_cache      (mut i32) (i32.const -1))
  (global $g_enc_nPend      (mut i32) (i32.const 0))
  (global $g_enc_pos        (mut i32) (i32.const 0))

  ;; Arithmetic decoder state
  (global $g_dec_lo         (mut i32) (i32.const 0))
  (global $g_dec_range      (mut i32) (i32.const -1))
  (global $g_dec_code       (mut i32) (i32.const 0))
  (global $g_dec_pos        (mut i32) (i32.const 0))

  ;; Per-byte precomputed base indices (set once per byte, used 8× in blend + upd)
  (global $g_o2Base         (mut i32) (i32.const 0))   ;; p1 * 256
  (global $g_eBase          (mut i32) (i32.const 0))   ;; engPred * 256
  (global $g_p2nBase        (mut i32) (i32.const 0))   ;; (p2 >> 4) * 256
  (global $g_uSlot          (mut i32) (i32.const 0))   ;; (p1_bit_k<<1)|p2_bit_k, set per bit in blend

  ;; Ab-axis: above-neighbor context for higher-dimensional serialized data.
  ;; stride = distance in bytes to the spatial above-neighbor.
  ;; when stride = 0, Ab is completely disabled (pure temporal mode).
  ;; set externally via set_stride() before encode/decode. NOT reset by init().
  (global $g_stride          (mut i32) (i32.const 0))   ;; spatial stride, 0 = disabled
  (global $g_abByte          (mut i32) (i32.const 0))   ;; the above-neighbor byte value
  (global $g_abBase          (mut i32) (i32.const 0))   ;; abByte * 256 (precomputed per byte)


  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; MATH — ln(x) and exp(x) via IEEE 754 bit manipulation + polynomial
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; ln(x) — natural logarithm, ~12 digits of precision
  ;; Decompose x = 2^e * m where m ∈ [1, 2)
  ;; u = (m-1)/(m+1) ∈ [0, 1/3)
  ;; ln(x) = e·ln2 + 2u·(1 + u²/3 + u⁴/5 + u⁶/7 + u⁸/9 + u¹⁰/11 + u¹²/13)
  (func $ln (param $x f64) (result f64)
    (local $bits i64)
    (local $e f64)
    (local $m f64)
    (local $u f64)
    (local $u2 f64)
    (local $s f64)

    (local.set $bits (i64.reinterpret_f64 (local.get $x)))

    ;; e = ((bits >> 52) & 0x7FF) - 1023
    (local.set $e (f64.convert_i32_s
      (i32.sub
        (i32.and
          (i32.wrap_i64 (i64.shr_u (local.get $bits) (i64.const 52)))
          (i32.const 0x7FF))
        (i32.const 1023))))

    ;; m = bits with exponent set to 1023 (= 1.xxx)
    (local.set $m (f64.reinterpret_i64
      (i64.or
        (i64.and (local.get $bits) (i64.const 0x000FFFFFFFFFFFFF))
        (i64.const 0x3FF0000000000000))))

    ;; u = (m - 1) / (m + 1)
    (local.set $u (f64.div
      (f64.sub (local.get $m) (f64.const 1.0))
      (f64.add (local.get $m) (f64.const 1.0))))

    (local.set $u2 (f64.mul (local.get $u) (local.get $u)))

    ;; Horner: s = 1/13 + u²(0) → accumulate backwards
    (local.set $s (f64.const 0.07692307692307693))  ;; 1/13
    (local.set $s (f64.add (f64.const 0.09090909090909091)  ;; 1/11
      (f64.mul (local.get $u2) (local.get $s))))
    (local.set $s (f64.add (f64.const 0.1111111111111111)   ;; 1/9
      (f64.mul (local.get $u2) (local.get $s))))
    (local.set $s (f64.add (f64.const 0.14285714285714285)  ;; 1/7
      (f64.mul (local.get $u2) (local.get $s))))
    (local.set $s (f64.add (f64.const 0.2)                  ;; 1/5
      (f64.mul (local.get $u2) (local.get $s))))
    (local.set $s (f64.add (f64.const 0.3333333333333333)   ;; 1/3
      (f64.mul (local.get $u2) (local.get $s))))
    (local.set $s (f64.add (f64.const 1.0)
      (f64.mul (local.get $u2) (local.get $s))))

    ;; result = e * ln(2) + 2 * u * s
    (f64.add
      (f64.mul (local.get $e) (f64.const 0.6931471805599453))
      (f64.mul (f64.const 2.0) (f64.mul (local.get $u) (local.get $s)))))

  ;; exp(x) — exponential, ~10 digits of precision
  ;; Reduce: n = round(x/ln2), r = x - n·ln2
  ;; exp(x) = 2^n · (1 + r + r²/2! + ... + r⁹/9!)
  (func $exp (param $x f64) (result f64)
    (local $n i32)
    (local $r f64)
    (local $p f64)

    ;; Clamp extremes
    (if (f64.gt (local.get $x) (f64.const 709.0))
      (then (return (f64.const inf))))
    (if (f64.lt (local.get $x) (f64.const -709.0))
      (then (return (f64.const 0.0))))

    ;; n = round(x / ln2)
    (local.set $n (i32.trunc_f64_s
      (f64.nearest (f64.mul (local.get $x) (f64.const 1.4426950408889634)))))

    ;; r = x - n * ln2
    (local.set $r (f64.sub (local.get $x)
      (f64.mul (f64.convert_i32_s (local.get $n)) (f64.const 0.6931471805599453))))

    ;; Horner: 1 + r(1 + r(1/2 + r(1/6 + ... + r/362880)))
    (local.set $p (f64.const 2.7557319223985893e-06))  ;; 1/362880
    (local.set $p (f64.add (f64.const 2.48015873015873e-05)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/40320
    (local.set $p (f64.add (f64.const 1.984126984126984e-04)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/5040
    (local.set $p (f64.add (f64.const 1.388888888888889e-03)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/720
    (local.set $p (f64.add (f64.const 8.333333333333333e-03)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/120
    (local.set $p (f64.add (f64.const 4.166666666666666e-02)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/24
    (local.set $p (f64.add (f64.const 0.16666666666666666)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/6
    (local.set $p (f64.add (f64.const 0.5)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1/2
    (local.set $p (f64.add (f64.const 1.0)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1
    (local.set $p (f64.add (f64.const 1.0)
      (f64.mul (local.get $r) (local.get $p))))         ;; 1 (constant term)

    ;; 2^n via IEEE 754: reinterpret((n + 1023) << 52)
    (f64.mul (local.get $p)
      (f64.reinterpret_i64
        (i64.shl
          (i64.extend_i32_s (i32.add (local.get $n) (i32.const 1023)))
          (i64.const 52)))))

  ;; logit_lut(p) — interpolated logit via lazy LUT at 0x54B000, f64[2049].
  ;; LUT[i] = logit(i/2048) for i=1..2047, with LUT[0] and LUT[2048] = clamp values.
  ;; linear interpolation between adjacent entries: ~10 ops vs ~35 for exact ln().
  ;; sentinel = 0.0; logit(1024/2048) = logit(0.5) = 0.0 is the only collision.
  ;; for bucket 1024, logit is exactly 0.0, so returning the sentinel is correct.
  (func $logit_lut (param $p f64) (result f64)
    (local $pf f64)    ;; p * 2048
    (local $bucket i32)
    (local $frac f64)
    (local $v0 f64) (local $v1 f64)
    (local $pc f64)

    ;; clamp extremes
    (if (f64.le (local.get $p) (f64.const 1.5259021896696422e-05))
      (then (return (f64.const -11.090354888959125))))
    (if (f64.ge (local.get $p) (f64.const 0.9999847409781033))
      (then (return (f64.const 11.090354888959125))))

    ;; pf = p * 2048, bucket = clamp(floor(pf), 1, 2046) — branchless
    (local.set $pf (f64.mul (local.get $p) (f64.const 2048.0)))
    (local.set $bucket (i32.trunc_f64_u (local.get $pf)))
    (local.set $bucket (select (i32.const 2046) (local.get $bucket)
      (i32.gt_u (local.get $bucket) (i32.const 2046))))
    (local.set $bucket (select (i32.const 1) (local.get $bucket)
      (i32.eqz (local.get $bucket))))
    (local.set $frac (f64.sub (local.get $pf) (f64.convert_i32_u (local.get $bucket))))

    ;; lazy populate LUT[bucket]
    (local.set $v0 (f64.load offset=0x54B000 (i32.shl (local.get $bucket) (i32.const 3))))
    (if (i32.and (f64.eq (local.get $v0) (f64.const 0.0))
                 (i32.ne (local.get $bucket) (i32.const 1024)))
      (then
        (local.set $pc (f64.div (f64.convert_i32_u (local.get $bucket)) (f64.const 2048.0)))
        (local.set $v0 (call $ln (f64.div (local.get $pc)
          (f64.sub (f64.const 1.0) (local.get $pc)))))
        (f64.store offset=0x54B000 (i32.shl (local.get $bucket) (i32.const 3)) (local.get $v0))))

    ;; lazy populate LUT[bucket+1]
    (local.set $v1 (f64.load offset=0x54B008 (i32.shl (local.get $bucket) (i32.const 3))))
    (if (i32.and (f64.eq (local.get $v1) (f64.const 0.0))
                 (i32.ne (i32.add (local.get $bucket) (i32.const 1)) (i32.const 1024)))
      (then
        (local.set $pc (f64.div
          (f64.convert_i32_u (i32.add (local.get $bucket) (i32.const 1)))
          (f64.const 2048.0)))
        (local.set $v1 (call $ln (f64.div (local.get $pc)
          (f64.sub (f64.const 1.0) (local.get $pc)))))
        (f64.store offset=0x54B008 (i32.shl (local.get $bucket) (i32.const 3)) (local.get $v1))))

    ;; lerp: v0 + frac * (v1 - v0)
    (f64.add (local.get $v0)
      (f64.mul (local.get $frac) (f64.sub (local.get $v1) (local.get $v0)))))

  ;; sigmoid_lut(x) — interpolated σ(x) = 1/(1+exp(-x)) via lazy LUT at 0x550000.
  ;; 4097 entries over x ∈ [-12, 12], step = 24/4096 ≈ 0.00586.
  ;; LUT[i] = σ(-12 + i × 24/4096). linear interpolation between adjacent entries.
  ;; sentinel = 0.0; σ(x) > 0 everywhere, but σ(-12 + 2048*step) = σ(0) = 0.5 ≠ 0. safe.
  ;; σ at the endpoints: σ(-12) ≈ 6e-6, σ(12) ≈ 1-6e-6. never exactly 0.
  (func $sigmoid_lut (param $x f64) (result f64)
    (local $xf f64)
    (local $bucket i32)
    (local $frac f64)
    (local $v0 f64) (local $v1 f64)
    (local $xc f64)

    ;; clamp
    (if (f64.le (local.get $x) (f64.const -12.0))
      (then (return (f64.const 1.5259021896696422e-05))))
    (if (f64.ge (local.get $x) (f64.const 12.0))
      (then (return (f64.const 0.9999847409781033))))

    ;; xf = (x + 12) * 4096/24 = (x + 12) * 170.667
    (local.set $xf (f64.mul (f64.add (local.get $x) (f64.const 12.0)) (f64.const 170.66666666666666)))
    (local.set $bucket (i32.trunc_f64_u (local.get $xf)))
    (local.set $bucket (select (i32.const 4095) (local.get $bucket)
      (i32.gt_u (local.get $bucket) (i32.const 4095))))
    (local.set $frac (f64.sub (local.get $xf) (f64.convert_i32_u (local.get $bucket))))

    ;; lazy populate LUT[bucket]
    (local.set $v0 (f64.load offset=0x550000 (i32.shl (local.get $bucket) (i32.const 3))))
    (if (f64.eq (local.get $v0) (f64.const 0.0))
      (then
        (local.set $xc (f64.add (f64.const -12.0)
          (f64.mul (f64.convert_i32_u (local.get $bucket)) (f64.const 0.005859375))))
        (local.set $v0 (f64.div (f64.const 1.0)
          (f64.add (f64.const 1.0) (call $exp (f64.neg (local.get $xc))))))
        (f64.store offset=0x550000 (i32.shl (local.get $bucket) (i32.const 3)) (local.get $v0))))

    ;; lazy populate LUT[bucket+1]
    (local.set $v1 (f64.load offset=0x550008 (i32.shl (local.get $bucket) (i32.const 3))))
    (if (f64.eq (local.get $v1) (f64.const 0.0))
      (then
        (local.set $xc (f64.add (f64.const -12.0)
          (f64.mul (f64.convert_i32_u (i32.add (local.get $bucket) (i32.const 1))) (f64.const 0.005859375))))
        (local.set $v1 (f64.div (f64.const 1.0)
          (f64.add (f64.const 1.0) (call $exp (f64.neg (local.get $xc))))))
        (f64.store offset=0x550008 (i32.shl (local.get $bucket) (i32.const 3)) (local.get $v1))))

    ;; lerp
    (f64.add (local.get $v0)
      (f64.mul (local.get $frac) (f64.sub (local.get $v1) (local.get $v0)))))

  ;; log1p(i) — lazy LOG1P LUT: returns ln(1+i), computing on first access.
  ;; LUT at 0x0BAE40, f64[4096]. entries start zeroed (sentinel).
  ;; ln(1+0) = 0.0 naturally; for i > 0, ln(1+i) > 0, so 0.0 means "not yet computed".
  ;; for a 100-byte message, only ~3 entries are ever needed vs 4096 precomputed.
  (func $log1p (param $i i32) (result f64)
    (local $val f64)
    (local.set $val (f64.load offset=0x0BAE40 (i32.shl (local.get $i) (i32.const 3))))
    (if (i32.and (f64.eq (local.get $val) (f64.const 0.0))
                 (i32.gt_u (local.get $i) (i32.const 0)))
      (then
        (local.set $val (call $ln (f64.add (f64.const 1.0) (f64.convert_i32_u (local.get $i)))))
        (f64.store offset=0x0BAE40 (i32.shl (local.get $i) (i32.const 3)) (local.get $val))))
    (local.get $val))

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; ARITHMETIC ENCODER — LZMA-style range coder, binary-specialized
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; Push byte to encoder output buffer at encBuf (0x0C3000)
  (func $enc_push (param $b i32)
    (i32.store8 (i32.add (i32.const 0x0C3000) (global.get $g_enc_pos)) (local.get $b))
    (global.set $g_enc_pos (i32.add (global.get $g_enc_pos) (i32.const 1))))

  ;; Drain: emit cache + nPend fill bytes
  (func $enc_drain (param $fill i32)
    (local $i i32)
    (if (i32.ge_s (global.get $g_enc_cache) (i32.const 0))
      (then (call $enc_push (global.get $g_enc_cache))))
    (local.set $i (i32.const 0))
    (block $brk (loop $lp
      (br_if $brk (i32.ge_u (local.get $i) (global.get $g_enc_nPend)))
      (call $enc_push (local.get $fill))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $g_enc_nPend (i32.const 0)))

  ;; Carry propagation
  (func $enc_carry
    (if (i32.ge_s (global.get $g_enc_cache) (i32.const 0))
      (then (global.set $g_enc_cache
        (i32.and (i32.add (global.get $g_enc_cache) (i32.const 1)) (i32.const 0xFF)))))
    (call $enc_drain (i32.const 0x00))
    (global.set $g_enc_cache (i32.const -1)))

  ;; Emit byte (non-0xFF)
  (func $enc_emit (param $b i32)
    (call $enc_drain (i32.const 0xFF))
    (global.set $g_enc_cache (local.get $b)))

  ;; encodeBit(bit, c0) — total is always 2¹⁶
  ;; bit=0: range [0, c0).  bit=1: range [c0, 65536).
  (func $enc_encode_bit (param $bit i32) (param $c0 i32)
    (local $sc0 i32)
    (local $newLo i32)
    (local $b i32)

    ;; sc0 = (range >>> 16) * c0
    (local.set $sc0 (i32.mul
      (i32.shr_u (global.get $g_enc_range) (i32.const 16))
      (local.get $c0)))

    (if (i32.eqz (local.get $bit))
      (then
        ;; bit = 0: range = sc0
        (global.set $g_enc_range (local.get $sc0)))
      (else
        ;; bit = 1: lo += sc0, range -= sc0
        (local.set $newLo (i32.add (global.get $g_enc_lo) (local.get $sc0)))
        (global.set $g_enc_range (i32.sub (global.get $g_enc_range) (local.get $sc0)))
        ;; carry if newLo < lo (unsigned overflow)
        (if (i32.lt_u (local.get $newLo) (global.get $g_enc_lo))
          (then (call $enc_carry)))
        (global.set $g_enc_lo (local.get $newLo))))

    ;; Normalize: while range < RC_TOP (0x1000000)
    (block $norm_brk (loop $norm_lp
      (br_if $norm_brk (i32.ge_u (global.get $g_enc_range) (i32.const 0x1000000)))
      (local.set $b (i32.and (i32.shr_u (global.get $g_enc_lo) (i32.const 24)) (i32.const 0xFF)))
      (if (i32.ne (local.get $b) (i32.const 0xFF))
        (then (call $enc_emit (local.get $b)))
        (else (global.set $g_enc_nPend (i32.add (global.get $g_enc_nPend) (i32.const 1)))))
      (global.set $g_enc_lo (i32.shl (i32.and (global.get $g_enc_lo) (i32.const 0xFFFFFF)) (i32.const 8)))
      (global.set $g_enc_range (i32.shl (global.get $g_enc_range) (i32.const 8)))
      (br $norm_lp))))

  ;; Flush encoder, returns output length
  (func $enc_flush (result i32)
    (local $i i32)
    (call $enc_drain (i32.const 0xFF))
    (global.set $g_enc_cache (i32.const -1))
    (local.set $i (i32.const 0))
    (block $brk (loop $lp
      (br_if $brk (i32.ge_u (local.get $i) (i32.const 4)))
      (call $enc_push (i32.and (i32.shr_u (global.get $g_enc_lo) (i32.const 24)) (i32.const 0xFF)))
      (global.set $g_enc_lo (i32.shl (i32.and (global.get $g_enc_lo) (i32.const 0xFFFFFF)) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.get $g_enc_pos))

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; ARITHMETIC DECODER — fused getCDF + advance, binary-specialized
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; decodeBit(c0) → bit.  Data read from inputBuf + 1 (skip mode byte).
  (func $dec_decode_bit (param $c0 i32) (result i32)
    (local $sc0 i32)
    (local $diff i32)

    (local.set $sc0 (i32.mul
      (i32.shr_u (global.get $g_dec_range) (i32.const 16))
      (local.get $c0)))

    (local.set $diff (i32.sub (global.get $g_dec_code) (global.get $g_dec_lo)))

    (if (i32.lt_u (local.get $diff) (local.get $sc0))
      (then
        ;; bit = 0
        (global.set $g_dec_range (local.get $sc0))
        ;; Normalize
        (block $n0 (loop $l0
          (br_if $n0 (i32.ge_u (global.get $g_dec_range) (i32.const 0x1000000)))
          (global.set $g_dec_lo (i32.shl (i32.and (global.get $g_dec_lo) (i32.const 0xFFFFFF)) (i32.const 8)))
          (global.set $g_dec_range (i32.shl (global.get $g_dec_range) (i32.const 8)))
          (global.set $g_dec_code (i32.or
            (i32.shl (i32.and (global.get $g_dec_code) (i32.const 0xFFFFFF)) (i32.const 8))
            (i32.load8_u (i32.add (i32.const 0x1C3000) (global.get $g_dec_pos)))))
          (global.set $g_dec_pos (i32.add (global.get $g_dec_pos) (i32.const 1)))
          (br $l0)))
        (return (i32.const 0)))
      (else
        ;; bit = 1
        (global.set $g_dec_lo (i32.add (global.get $g_dec_lo) (local.get $sc0)))
        (global.set $g_dec_range (i32.sub (global.get $g_dec_range) (local.get $sc0)))
        ;; Normalize
        (block $n1 (loop $l1
          (br_if $n1 (i32.ge_u (global.get $g_dec_range) (i32.const 0x1000000)))
          (global.set $g_dec_lo (i32.shl (i32.and (global.get $g_dec_lo) (i32.const 0xFFFFFF)) (i32.const 8)))
          (global.set $g_dec_range (i32.shl (global.get $g_dec_range) (i32.const 8)))
          (global.set $g_dec_code (i32.or
            (i32.shl (i32.and (global.get $g_dec_code) (i32.const 0xFFFFFF)) (i32.const 8))
            (i32.load8_u (i32.add (i32.const 0x1C3000) (global.get $g_dec_pos)))))
          (global.set $g_dec_pos (i32.add (global.get $g_dec_pos) (i32.const 1)))
          (br $l1)))
        (return (i32.const 1))))
    (unreachable))

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; PREDICTOR — 6-axis blend + 3-state SSE
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; blend(ctx, k) → P(bit=0) as f64
  ;; heart of the codec. six axes of temporal attention collapse to a
  ;; single probability via Born rule mixing + SSE calibration.
  (func $blend (param $ctx i32) (param $k i32) (result f64)
    ;; F0-axis (order-0, context-free)
    (local $f0Addr i32)
    (local $f0C0 f64) (local $f0C1 f64) (local $f0T f64) (local $pF0 f64)
    ;; U-axis
    (local $uSlot i32) (local $uI i32) (local $uAddr i32)
    (local $uC0 f64) (local $uC1 f64) (local $uT f64) (local $pU f64)
    ;; O2-axis
    (local $o2I i32) (local $o2Addr i32)
    (local $o2C0 f64) (local $o2C1 f64) (local $o2T f64) (local $pO2 f64)
    (local $o2b i32)
    ;; E-axis
    (local $eI i32) (local $eAddr i32)
    (local $eC0 f64) (local $eC1 f64) (local $eT f64) (local $pE f64)
    ;; P2N-axis (prev-prev byte nibble class)
    (local $p2nI i32) (local $p2nAddr i32)
    (local $p2nC0 f64) (local $p2nC1 f64) (local $p2nT f64) (local $pP2N f64)
    ;; Ab-axis (above neighbor, stride-gated)
    (local $abI i32) (local $abAddr i32)
    (local $abC0 f64) (local $abC1 f64) (local $abT f64) (local $pAb f64)
    ;; blend weight locals
    (local $wF0 f64) (local $wU f64)
    (local $wO2 f64) (local $wAb f64) (local $wE f64) (local $wP2N f64)
    (local $f0Ti i32) (local $uTi i32)
    (local $o2Ti i32) (local $abTi i32) (local $eTi i32) (local $p2nTi i32)
    (local $wLX f64)
    (local $a0 f64) (local $a1 f64)  ;; Born rule amplitude accumulators
    (local $lambda f64)
    ;; M-axis
    (local $wM f64) (local $logitM f64)
    (local $mc0 f64) (local $mc1 f64) (local $mT f64)
    (local $pM f64) (local $mW f64) (local $isingBoost f64)
    (local $i i32)
    ;; Mixer output
    (local $lxScale f64) (local $mScale f64)
    (local $pRaw f64)
    ;; SSE
    (local $matchState i32) (local $bucket i32) (local $si i32)
    (local $sc0 f64) (local $sc1 f64)

    ;; ── F0-axis: order-0 context-free byte frequency (CTW root) ──
    ;; no byte context: pure symbol frequency over the bit tree.
    ;; the mathematical root of the context tree — every compressor needs order-0.
    ;; provides the ground-state prediction during regime transitions when all
    ;; context-dependent models are briefly wrong. 255 cells, warms instantly.
    ;; f0Addr = ctx * 2 * 4 at f0C (0x558100)
    (local.set $f0Addr (i32.shl (i32.shl (local.get $ctx) (i32.const 1)) (i32.const 2)))
    (local.set $f0C0 (f64.convert_i32_u (i32.load offset=0x558100 (local.get $f0Addr))))
    (local.set $f0C1 (f64.convert_i32_u (i32.load offset=0x558104 (local.get $f0Addr))))
    (local.set $f0T (f64.add (local.get $f0C0) (local.get $f0C1)))
    ;; α=0.5 (Jeffrey's) — dense table, not sparse
    (local.set $pF0 (f64.div
      (f64.add (local.get $f0C0) (f64.const 0.5))
      (f64.add (local.get $f0T) (f64.const 1.0))))

    ;; ── U-axis: bit-lane temporal (per bit position) ──
    ;; Context: (p1_bit_k << 1) | p2_bit_k — 4 states per bit position, 32 cells total.
    ;; Captures per-lane temporal patterns (alternation, runs, phase) at bit granularity.
    ;; in Born amplitude pool with O2/E/P2N. small table partially correlates with O2
    ;; (both condition on bit values), but carries independent temporal signal.
    (local.set $uSlot (i32.or
      (i32.shl
        (i32.and (i32.shr_u (global.get $g_p1) (local.get $k)) (i32.const 1))
        (i32.const 1))
      (i32.and (i32.shr_u (global.get $g_p2) (local.get $k)) (i32.const 1))))
    (global.set $g_uSlot (local.get $uSlot))
    ;; uI = (uSlot * 8 + k) * 2, byte addr = uI * 4 at offset 0x000800
    (local.set $uI (i32.shl
      (i32.add (i32.shl (local.get $uSlot) (i32.const 3)) (local.get $k))
      (i32.const 1)))
    (local.set $uAddr (i32.shl (local.get $uI) (i32.const 2)))
    (local.set $uC0 (f64.convert_i32_u (i32.load offset=0x000800 (local.get $uAddr))))
    (local.set $uC1 (f64.convert_i32_u (i32.load offset=0x000804 (local.get $uAddr))))
    (local.set $uT (f64.add (local.get $uC0) (local.get $uC1)))
    (local.set $pU (f64.div
      (f64.add (local.get $uC0) (f64.const 0.5))
      (f64.add (local.get $uT) (f64.const 1.0))))

    ;; ── O2-axis: full prev byte (8-bit) × bit tree ──
    ;; 65,280 bigram cells — full byte-level Markov context.
    ;; no evaporation: O2 is the long-term memory layer; U adapts, O2 accumulates.
    ;; o2I = (o2Base + ctx) * 2  →  byte addr = o2I * 4 at 0x3C3000
    (local.set $o2I (i32.shl
      (i32.add (global.get $g_o2Base) (local.get $ctx))
      (i32.const 1)))
    (local.set $o2Addr (i32.shl (local.get $o2I) (i32.const 2)))
    (local.set $o2C0 (f64.convert_i32_u (i32.load offset=0x3C3000 (local.get $o2Addr))))
    (local.set $o2C1 (f64.convert_i32_u (i32.load offset=0x3C3004 (local.get $o2Addr))))
    (local.set $o2T (f64.add (local.get $o2C0) (local.get $o2C1)))
    ;; α=0.125 for sparse 65K-cell table — sharper prior, faster adaptation.
    ;; sweep: 0.125 beat 0.25 by ~150 bytes. lower alpha = less smoothing.
    (local.set $pO2 (f64.div
      (f64.add (local.get $o2C0) (f64.const 0.125))
      (f64.add (local.get $o2T) (f64.const 0.25))))

    ;; ── E-axis: Engram AR(2) trajectory predictor ──
    ;; g_engPred = AR(2) Cramer fitted prediction for current byte (0-255).
    ;; K,G fitted from 5 running dot products (no decay); updated per byte after encoding/decoding.
    ;; same table shape as O2: 256×255 cells (engPred × bit tree ctx).
    ;; eI = (eBase + ctx) * 2  →  byte addr = eI * 4 at 0x4C3000
    (local.set $eI (i32.shl
      (i32.add (global.get $g_eBase) (local.get $ctx))
      (i32.const 1)))
    (local.set $eAddr (i32.shl (local.get $eI) (i32.const 2)))
    (local.set $eC0 (f64.convert_i32_u (i32.load offset=0x4C3000 (local.get $eAddr))))
    (local.set $eC1 (f64.convert_i32_u (i32.load offset=0x4C3004 (local.get $eAddr))))
    (local.set $eT (f64.add (local.get $eC0) (local.get $eC1)))
    ;; E keeps α=0.5 — AR2 predictions are noisier, need more smoothing
    (local.set $pE (f64.div
      (f64.add (local.get $eC0) (f64.const 0.5))
      (f64.add (local.get $eT) (f64.const 1.0))))

    ;; ── P2N-axis: prev-prev byte nibble class × bit tree ──
    ;; coarse bigram context: p2 >> 4 gives 16 nibble classes.
    ;; captures two-byte patterns no other axis directly models:
    ;; O2 sees p1, E fits trajectory, P2N conditions on p2's class.
    ;; 16 × 255 = 4,080 cells: warms 16× faster than full p2.
    ;; p2nI = (p2nBase + ctx) * 2  →  byte addr = p2nI * 4 at 0x543000
    (local.set $p2nI (i32.shl
      (i32.add (global.get $g_p2nBase) (local.get $ctx))
      (i32.const 1)))
    (local.set $p2nAddr (i32.shl (local.get $p2nI) (i32.const 2)))
    (local.set $p2nC0 (f64.convert_i32_u (i32.load offset=0x543000 (local.get $p2nAddr))))
    (local.set $p2nC1 (f64.convert_i32_u (i32.load offset=0x543004 (local.get $p2nAddr))))
    (local.set $p2nT (f64.add (local.get $p2nC0) (local.get $p2nC1)))
    ;; α=0.25 for coarse bigram (16×255 cells, 16× denser than O2's 65K cells)
    (local.set $pP2N (f64.div
      (f64.add (local.get $p2nC0) (f64.const 0.25))
      (f64.add (local.get $p2nT) (f64.const 0.5))))

    ;; ── Ab-axis: above neighbor at inputBuf[i - stride] ──
    ;; only active when stride > 0 (serialized 2D+ data). the nearest spatial
    ;; neighbor in a raster scan is stride bytes back — beyond O2's 1-byte
    ;; and E's 2-byte temporal horizon. same table shape as O2: 256×255 cells.
    ;; when stride = 0, pAb = 0.5 (neutral) and wAb = 0 (zero weight).
    (if (i32.gt_u (global.get $g_stride) (i32.const 0))
      (then
        (local.set $abI (i32.shl
          (i32.add (global.get $g_abBase) (local.get $ctx))
          (i32.const 1)))
        (local.set $abAddr (i32.shl (local.get $abI) (i32.const 2)))
        (local.set $abC0 (f64.convert_i32_u (i32.load offset=0x558900 (local.get $abAddr))))
        (local.set $abC1 (f64.convert_i32_u (i32.load offset=0x558904 (local.get $abAddr))))
        (local.set $abT (f64.add (local.get $abC0) (local.get $abC1)))
        ;; α=0.125 (same as O2, sparse 65K-cell table)
        (local.set $pAb (f64.div
          (f64.add (local.get $abC0) (f64.const 0.125))
          (f64.add (local.get $abT) (f64.const 0.25)))))
      (else (local.set $pAb (f64.const 0.5))))

    ;; ── weight computation: w_i = |p_i - 0.5| × min(log1p(total_i), cap) ──
    ;; |p-0.5| gates uncertain axes (confidence). Born rule handles interference
    ;; but the confidence gate is still essential: it prevents high-evidence axes
    ;; at p≈0.5 from diluting the signal of genuinely informative axes.
    ;; split evidence cap: F0=ln(2)≈0.693 (1 bit, context-free),
    ;; U=ln(3)≈1.099 (ternary bit dynamics),
    ;; O2/E/P2N=ln(4)≈1.386 (2 bits of byte-level evidence).
    ;; sweep-derived over natural constants (ln2..φ grid).
    ;; branchless clamp via select: min(trunc_sat(total), 4095)

    ;; F0: tightest cap — context-free carries only 1 bit of evidence
    (local.set $f0Ti (i32.trunc_sat_f64_u (local.get $f0T)))
    (local.set $f0Ti (select (i32.const 4095) (local.get $f0Ti)
      (i32.gt_u (local.get $f0Ti) (i32.const 4095))))
    (local.set $wF0 (f64.mul
      (f64.abs (f64.sub (local.get $pF0) (f64.const 0.5)))
      (f64.min (call $log1p (local.get $f0Ti)) (f64.const 0.6931))))

    (local.set $uTi (i32.trunc_sat_f64_u (local.get $uT)))
    (local.set $uTi (select (i32.const 4095) (local.get $uTi)
      (i32.gt_u (local.get $uTi) (i32.const 4095))))
    (local.set $wU (f64.mul
      (f64.abs (f64.sub (local.get $pU) (f64.const 0.5)))
      (f64.min (call $log1p (local.get $uTi)) (f64.const 1.0986))))

    (local.set $o2Ti (i32.trunc_sat_f64_u (local.get $o2T)))
    (local.set $o2Ti (select (i32.const 4095) (local.get $o2Ti)
      (i32.gt_u (local.get $o2Ti) (i32.const 4095))))
    (local.set $wO2 (f64.mul
      (f64.abs (f64.sub (local.get $pO2) (f64.const 0.5)))
      (f64.min (call $log1p (local.get $o2Ti)) (f64.const 1.3863))))

    (local.set $eTi (i32.trunc_sat_f64_u (local.get $eT)))
    (local.set $eTi (select (i32.const 4095) (local.get $eTi)
      (i32.gt_u (local.get $eTi) (i32.const 4095))))
    (local.set $wE (f64.mul
      (f64.abs (f64.sub (local.get $pE) (f64.const 0.5)))
      (f64.min (call $log1p (local.get $eTi)) (f64.const 1.3863))))

    (local.set $p2nTi (i32.trunc_sat_f64_u (local.get $p2nT)))
    (local.set $p2nTi (select (i32.const 4095) (local.get $p2nTi)
      (i32.gt_u (local.get $p2nTi) (i32.const 4095))))
    (local.set $wP2N (f64.mul
      (f64.abs (f64.sub (local.get $pP2N) (f64.const 0.5)))
      (f64.min (call $log1p (local.get $p2nTi)) (f64.const 1.3863))))

    ;; Ab weight: zero when stride=0 (completely disabled)
    (if (i32.gt_u (global.get $g_stride) (i32.const 0))
      (then
        (local.set $abTi (i32.trunc_sat_f64_u (local.get $abT)))
        (local.set $abTi (select (i32.const 4095) (local.get $abTi)
          (i32.gt_u (local.get $abTi) (i32.const 4095))))
        (local.set $wAb (f64.mul
          (f64.abs (f64.sub (local.get $pAb) (f64.const 0.5)))
          (f64.min (call $log1p (local.get $abTi)) (f64.const 1.3863)))))  ;; cap = ln(4), same as O2
      (else (local.set $wAb (f64.const 0.0))))

    ;; wLX = sum of pool axis weights (for M balance and sharpness gate)
    (local.set $wLX (f64.add
      (f64.add (f64.add (local.get $wF0) (local.get $wU)) (local.get $wO2))
      (f64.add (f64.add (local.get $wE) (local.get $wP2N)) (local.get $wAb))))

    ;; ── Born rule: amplitude-space mixing (Hellinger geometry, α=0) ──
    ;; p = (Σwᵢ√pᵢ)² / ((Σwᵢ√pᵢ)² + (Σwᵢ√(1-pᵢ))²)
    ;; quantum-mechanical: amplitudes add, probabilities interfere.
    ;; correlated axes naturally damped — double-counting costs quadratically.
    ;; replaces linear/logit mixing which assume independent sources.
    ;; f64.sqrt is a native WASM op (~1 cycle), no LUT needed.
    (if (f64.gt (local.get $wLX) (f64.const 0.0))
      (then
        ;; accumulate weighted amplitudes for bit=0 and bit=1
        ;; 6 axes in Born pool: F0, U, O2, Ab, E, P2N
        ;; when stride=0, wAb=0 and pAb=0.5 so Ab contributes wAb×√0.5 = 0 to both sums
        (local.set $a0 (f64.add
          (f64.add
            (f64.add
              (f64.mul (local.get $wF0) (f64.sqrt (local.get $pF0)))
              (f64.mul (local.get $wU) (f64.sqrt (local.get $pU))))
            (f64.add
              (f64.mul (local.get $wO2) (f64.sqrt (local.get $pO2)))
              (f64.mul (local.get $wAb) (f64.sqrt (local.get $pAb)))))
          (f64.add
            (f64.mul (local.get $wE) (f64.sqrt (local.get $pE)))
            (f64.mul (local.get $wP2N) (f64.sqrt (local.get $pP2N))))))
        (local.set $a1 (f64.add
          (f64.add
            (f64.add
              (f64.mul (local.get $wF0) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pF0))))
              (f64.mul (local.get $wU) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pU)))))
            (f64.add
              (f64.mul (local.get $wO2) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pO2))))
              (f64.mul (local.get $wAb) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pAb))))))
          (f64.add
            (f64.mul (local.get $wE) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pE))))
            (f64.mul (local.get $wP2N) (f64.sqrt (f64.sub (f64.const 1.0) (local.get $pP2N)))))))
        ;; Born rule: p = a0² / (a0² + a1²)
        (local.set $a0 (f64.mul (local.get $a0) (local.get $a0)))  ;; a0²
        (local.set $a1 (f64.mul (local.get $a1) (local.get $a1)))  ;; a1²
        (local.set $pRaw (f64.div (local.get $a0)
          (f64.add (local.get $a0) (local.get $a1)))))
      (else (local.set $pRaw (f64.const 0.5))))
    ;; wLX for M balance: max(wLX, 1.0) — branchless
    (local.set $wLX (f64.max (local.get $wLX) (f64.const 1.0)))

    ;; ── M-axis: PPM candidates, per-bit trie ──
    (local.set $wM (f64.const 0.0))
    (local.set $logitM (f64.const 0.0))
    (if (i32.gt_s (global.get $g_matchCount) (i32.const 0))
      (then
        (local.set $mc0 (f64.const 0.0))
        (local.set $mc1 (f64.const 0.0))
        (local.set $i (i32.const 0))
        (block $mb (loop $ml
          (br_if $mb (i32.ge_u (local.get $i) (global.get $g_matchCount)))
          ;; if bit k of matchBytes[i] is 0 → mc0, else mc1
          (if (i32.eqz (i32.and
                (i32.shr_u
                  (i32.load8_u offset=0x0B9040 (local.get $i))  ;; matchBytes[i]
                  (local.get $k))
                (i32.const 1)))
            (then (local.set $mc0 (f64.add (local.get $mc0)
              (f64.load offset=0x0B9140 (i32.shl (local.get $i) (i32.const 3))))))
            (else (local.set $mc1 (f64.add (local.get $mc1)
              (f64.load offset=0x0B9140 (i32.shl (local.get $i) (i32.const 3)))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ml)))
        (local.set $mT (f64.add (local.get $mc0) (local.get $mc1)))
        (if (f64.gt (local.get $mT) (f64.const 0.0))
          (then
            (local.set $pM (f64.div
              (f64.add (local.get $mc0) (f64.const 0.5))
              (f64.add (local.get $mT) (f64.const 1.0))))
            ;; mW = mT > 4 ? mT/2 : sqrt(mT)
            ;; crossover at mT=4: sqrt(4)=2=4/2. continuous.
            (local.set $mW (select
              (f64.div (local.get $mT) (f64.const 2.0))
              (f64.sqrt (local.get $mT))
              (f64.gt (local.get $mT) (f64.const 4.0))))
            ;; isingBoost = mRunLen (volatility path removed: Born rule handles phase transitions)
            (local.set $isingBoost
              (if (result f64) (i32.gt_s (global.get $g_mRunLen) (i32.const 0))
                (then (f64.convert_i32_s (global.get $g_mRunLen)))
                (else (f64.const 0.0))))
            ;; wM = |pM - 0.5| * mW * (1 + mRunLen)
            (local.set $wM (f64.mul
              (f64.mul
                (f64.abs (f64.sub (local.get $pM) (f64.const 0.5)))
                (local.get $mW))
              (f64.add (f64.const 1.0) (local.get $isingBoost))))
            (local.set $logitM (call $logit_lut (local.get $pM)))))))

    ;; ── M injection: blend Born pool result with M in log-odds ──
    ;; Born rule already gave us pRaw from the pool. if M is active,
    ;; convert to logit space, blend, and convert back via σ.
    (if (f64.ge (local.get $wM) (f64.const 1e-9))
      (then
        ;; pRaw = σ((wLX/(wLX+wM))×logit(pRaw) + (wM/(wLX+wM))×logitM)
        (local.set $lambda (call $logit_lut (local.get $pRaw)))
        (local.set $lxScale (f64.div (f64.const 1.0)
          (f64.add (local.get $wLX) (local.get $wM))))
        (local.set $mScale (f64.mul (local.get $wM) (local.get $lxScale)))
        (local.set $lxScale (f64.mul (local.get $wLX) (local.get $lxScale)))
        (local.set $pRaw (call $sigmoid_lut
          (f64.add
            (f64.mul (local.get $lxScale) (local.get $lambda))
            (f64.mul (local.get $mScale) (local.get $logitM)))))))
    ;; clamp pRaw (both paths) — branchless via f64.min/max
    (local.set $pRaw (f64.min (f64.max (local.get $pRaw) (f64.const 1.5259021896696422e-05))
      (f64.const 0.9999847409781033)))

    ;; ── 3-state SSE ──
    ;; matchState: 2=crystal (mRunLen≥1 && matchCount>0), 1=volatile, 0=gas
    (local.set $matchState (i32.const 0))
    (if (i32.and
          (i32.ge_s (global.get $g_mRunLen) (i32.const 1))
          (i32.gt_s (global.get $g_matchCount) (i32.const 0)))
      (then (local.set $matchState (i32.const 2)))
      (else (if (i32.and
                  (i32.gt_s (global.get $g_matchVolatility) (i32.const 0))
                  (i32.gt_s (global.get $g_matchCount) (i32.const 0)))
              (then (local.set $matchState (i32.const 1))))))

    ;; bucket = min(31, floor(pRaw * 32)) — 32 levels (5 bits of Born rule output)
    (local.set $bucket (i32.trunc_f64_u (f64.mul (local.get $pRaw) (f64.const 32.0))))
    (local.set $bucket (select (i32.const 31) (local.get $bucket)
      (i32.gt_u (local.get $bucket) (i32.const 31))))

    ;; o2b = min(15, floor(pO2 * 16)) — branchless select
    ;; captures axis-disagreement: when O2 and blended pRaw differ, SSE arbitrates.
    (local.set $o2b (i32.trunc_f64_u (f64.mul (local.get $pO2) (f64.const 16.0))))
    (local.set $o2b (select (i32.const 15) (local.get $o2b)
      (i32.gt_u (local.get $o2b) (i32.const 15))))

    ;; sseIdx = matchState*4096 + o2b*256 + bucket*8 + k
    ;; 12,288 cells: 3 matchState × 16 o2b × 32 bucket × 8 k
    (global.set $g_sseIdx (i32.or
      (i32.shl (local.get $matchState) (i32.const 12))
      (i32.or
        (i32.or
          (i32.shl (local.get $o2b) (i32.const 8))
          (i32.shl (local.get $bucket) (i32.const 3)))
        (local.get $k))))

    ;; si = sseIdx * 2, byte addr = si * 4 at sseC (0x010900)
    (local.set $si (i32.shl (global.get $g_sseIdx) (i32.const 1)))
    (local.set $sc0 (f64.convert_i32_u
      (i32.load offset=0x010900 (i32.shl (local.get $si) (i32.const 2)))))
    (local.set $sc1 (f64.convert_i32_u
      (i32.load offset=0x010904 (i32.shl (local.get $si) (i32.const 2)))))

    ;; adaptive α = max(0.05, 8/(1+n)) — James-Stein shrinkage.
    ;; for few observations, strong prior prevents noisy SSE from hurting.
    ;; settles to 0.05 after ~159 observations per cell.
    ;; sweep: C=8 best tradeoff (real benchmark vs short-message quality).
    ;; reuse $lambda as temp (not needed after M blend).
    (local.set $lambda (f64.max (f64.const 0.05)
      (f64.div (f64.const 8.0)
        (f64.add (f64.const 1.0) (f64.add (local.get $sc0) (local.get $sc1))))))
    ;; result = clamp((sc0 + α) / (sc0 + sc1 + 2α))
    ;; branchless clamp via f64.min/max
    (f64.min (f64.max
      (f64.div
        (f64.add (local.get $sc0) (local.get $lambda))
        (f64.add (f64.add (local.get $sc0) (local.get $sc1))
                 (f64.add (local.get $lambda) (local.get $lambda))))
      (f64.const 1.5259021896696422e-05))
      (f64.const 0.9999847409781033)))

  ;; upd(ctx, k, bit) — update F0/U/O2/E/P2N counters
  ;; uses precomputed globals: g_uSlot (from blend), g_o2Base, g_eBase, g_p2nBase
  (func $upd (param $ctx i32) (param $k i32) (param $bit i32)
    (local $addr i32)

    ;; f0C[ctx * 2 + bit]++ — order-0 context-free frequency
    (local.set $addr (i32.shl
      (i32.add
        (i32.shl (local.get $ctx) (i32.const 1))
        (local.get $bit))
      (i32.const 2)))
    (i32.store offset=0x558100 (local.get $addr)
      (i32.add (i32.load offset=0x558100 (local.get $addr)) (i32.const 1)))

    ;; uC[(uSlot*8+k)*2 + bit]++ — g_uSlot set by blend for this bit position
    (local.set $addr (i32.shl
      (i32.add (i32.shl (i32.add (i32.shl (global.get $g_uSlot) (i32.const 3)) (local.get $k))
        (i32.const 1)) (local.get $bit))
      (i32.const 2)))
    (i32.store offset=0x000800 (local.get $addr)
      (i32.add (i32.load offset=0x000800 (local.get $addr)) (i32.const 1)))

    ;; o2C[(o2Base + ctx) * 2 + bit]++ — g_o2Base = p1 * 256
    (local.set $addr (i32.shl
      (i32.add
        (i32.shl (i32.add (global.get $g_o2Base) (local.get $ctx)) (i32.const 1))
        (local.get $bit))
      (i32.const 2)))
    (i32.store offset=0x3C3000 (local.get $addr)
      (i32.add (i32.load offset=0x3C3000 (local.get $addr)) (i32.const 1)))

    ;; eC[(eBase + ctx) * 2 + bit]++ — g_eBase = engPred * 256
    (local.set $addr (i32.shl
      (i32.add
        (i32.shl (i32.add (global.get $g_eBase) (local.get $ctx)) (i32.const 1))
        (local.get $bit))
      (i32.const 2)))
    (i32.store offset=0x4C3000 (local.get $addr)
      (i32.add (i32.load offset=0x4C3000 (local.get $addr)) (i32.const 1)))

    ;; p2nC[(p2nBase + ctx) * 2 + bit]++ — g_p2nBase = (p2>>4) * 256
    (local.set $addr (i32.shl
      (i32.add
        (i32.shl (i32.add (global.get $g_p2nBase) (local.get $ctx)) (i32.const 1))
        (local.get $bit))
      (i32.const 2)))
    (i32.store offset=0x543000 (local.get $addr)
      (i32.add (i32.load offset=0x543000 (local.get $addr)) (i32.const 1)))

    ;; abC[(abBase + ctx) * 2 + bit]++ — only when stride > 0
    (if (i32.gt_u (global.get $g_stride) (i32.const 0))
      (then
        (local.set $addr (i32.shl
          (i32.add
            (i32.shl (i32.add (global.get $g_abBase) (local.get $ctx)) (i32.const 1))
            (local.get $bit))
          (i32.const 2)))
        (i32.store offset=0x558900 (local.get $addr)
          (i32.add (i32.load offset=0x558900 (local.get $addr)) (i32.const 1)))))

    )

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; MATCH ENGINE — hash chain traversal + PPM exclusion
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; findMatch() — M-axis 2-byte hash chain with PPM exclusion
  (func $find_match
    (local $n i32) (local $j i32) (local $chain i32)
    (local $maxCtxGlobal i32) (local $bestOrder i32)
    (local $order i32) (local $maxCtx i32)
    (local $mc i32)

    (local.set $n (global.get $g_histPos))
    (global.set $g_matchCount (i32.const 0))
    (if (i32.lt_s (local.get $n) (i32.const 2)) (then (return)))

    ;; maxCtxGlobal = min(n - 1, CTX_M=256)
    (local.set $maxCtxGlobal (select
      (i32.sub (local.get $n) (i32.const 1)) (i32.const 256)
      (i32.lt_s (i32.sub (local.get $n) (i32.const 1)) (i32.const 256))))
    (local.set $bestOrder (i32.const 0))

    ;; j = mPrev[(n-1) & WINDOW_MASK]  at mPrev base 0x039000
    (local.set $j (i32.load offset=0x039000
      (i32.shl (i32.and (i32.sub (local.get $n) (i32.const 1)) (i32.const 0x7FFF)) (i32.const 2))))
    (local.set $chain (i32.const 0))

    (block $brk (loop $lp
      ;; while j != -1 && n-j <= WINDOW && chain < MAX_CHAIN
      (br_if $brk (i32.eq (local.get $j) (i32.const -1)))
      (br_if $brk (i32.gt_u (i32.sub (local.get $n) (local.get $j)) (i32.const 32768)))
      (br_if $brk (i32.ge_u (local.get $chain) (i32.const 256)))

      ;; Verify context depth
      (local.set $order (i32.const 2))  ;; 2 bytes verified by hash
      (local.set $maxCtx (select (local.get $j) (local.get $maxCtxGlobal)
        (i32.lt_s (local.get $j) (local.get $maxCtxGlobal))))

      (block $ob (loop $ol
        (br_if $ob (i32.ge_u (local.get $order) (local.get $maxCtx)))
        (br_if $ob (i32.ne
          (i32.load8_u offset=0x029000
            (i32.and (i32.sub (i32.sub (local.get $n) (i32.const 1)) (local.get $order)) (i32.const 0xFFFF)))
          (i32.load8_u offset=0x029000
            (i32.and (i32.sub (local.get $j) (local.get $order)) (i32.const 0xFFFF)))))
        (local.set $order (i32.add (local.get $order) (i32.const 1)))
        (br $ol)))

      ;; PPM exclusion: deeper match resets the set
      (if (i32.gt_s (local.get $order) (local.get $bestOrder))
        (then
          (local.set $bestOrder (local.get $order))
          (global.set $g_matchCount (i32.const 0))))
      (if (i32.and
            (i32.eq (local.get $order) (local.get $bestOrder))
            (i32.lt_u (global.get $g_matchCount) (i32.const 256)))
        (then
          (local.set $mc (global.get $g_matchCount))
          ;; matchBytes[mc] = hist[(j+1) & HIST_MASK]
          (i32.store8 offset=0x0B9040 (local.get $mc)
            (i32.load8_u offset=0x029000
              (i32.and (i32.add (local.get $j) (i32.const 1)) (i32.const 0xFFFF))))
          ;; matchWeights[mc] = order (as f64)
          (f64.store offset=0x0B9140 (i32.shl (local.get $mc) (i32.const 3))
            (f64.convert_i32_s (local.get $order)))
          ;; matchPos[mc] = j
          (i32.store offset=0x0B9940 (i32.shl (local.get $mc) (i32.const 2))
            (local.get $j))
          (global.set $g_matchCount (i32.add (local.get $mc) (i32.const 1)))))

      ;; j = mPrev[j & WINDOW_MASK]
      (local.set $j (i32.load offset=0x039000
        (i32.shl (i32.and (local.get $j) (i32.const 0x7FFF)) (i32.const 2))))
      (local.set $chain (i32.add (local.get $chain) (i32.const 1)))
      (br $lp))))


  ;; continueMatch() — advance M-axis positions by 1
  (func $continue_match
    (local $i i32) (local $count i32)
    (local $j i32) (local $dist i32)

    (local.set $count (i32.const 0))
    (local.set $i (i32.const 0))
    (block $brk (loop $lp
      (br_if $brk (i32.ge_u (local.get $i) (global.get $g_matchCount)))

      (local.set $j (i32.add
        (i32.load offset=0x0B9940 (i32.shl (local.get $i) (i32.const 2)))  ;; matchPos[i]
        (i32.const 1)))
      (local.set $dist (i32.sub (global.get $g_histPos) (local.get $j)))

      ;; Skip if dist <= 0 || dist > WINDOW || j+1 >= histPos
      (if (i32.and
            (i32.and
              (i32.gt_s (local.get $dist) (i32.const 0))
              (i32.le_u (local.get $dist) (i32.const 32768)))
            (i32.lt_s (i32.add (local.get $j) (i32.const 1)) (global.get $g_histPos)))
        (then
          ;; matchPos[count] = j
          (i32.store offset=0x0B9940 (i32.shl (local.get $count) (i32.const 2))
            (local.get $j))
          ;; matchBytes[count] = hist[(j+1) & HIST_MASK]
          (i32.store8 offset=0x0B9040 (local.get $count)
            (i32.load8_u offset=0x029000
              (i32.and (i32.add (local.get $j) (i32.const 1)) (i32.const 0xFFFF))))
          ;; matchWeights[count] = matchWeights[i] + 1
          (f64.store offset=0x0B9140 (i32.shl (local.get $count) (i32.const 3))
            (f64.add
              (f64.load offset=0x0B9140 (i32.shl (local.get $i) (i32.const 3)))
              (f64.const 1.0)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))))

      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))

    (global.set $g_matchCount (local.get $count))
    (if (i32.eqz (local.get $count))
      (then (call $find_match))))


  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; STATE MANAGEMENT — evaporation + entropy monitor
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; evaporate() — thermodynamic decay every 64 bytes
  ;; f = exp(-(1-c)²), c = min(1, 4·meanOp/128). only U-axis counts decay.
  (func $evaporate
    (local $meanOp f64) (local $confidence f64)
    (local $d f64) (local $f f64) (local $fi i32)
    (local $i i32) (local $addr i32)

    ;; faster warm-up: confidence saturates sooner. sweep showed all values from
    ;; div=128/mul=4 to div=32/mul=16 give identical results — curve shape barely matters.
    (local.set $meanOp (f64.div (global.get $g_opinionAcc) (f64.const 128.0)))
    (local.set $confidence (f64.min (f64.const 1.0) (f64.mul (local.get $meanOp) (f64.const 4.0))))
    (local.set $d (f64.sub (f64.const 1.0) (local.get $confidence)))
    (local.set $f (call $exp (f64.neg (f64.mul (local.get $d) (local.get $d)))))

    ;; fi = round(f * 256)
    (local.set $fi (i32.trunc_f64_s (f64.nearest (f64.mul (local.get $f) (f64.const 256.0)))))

    ;; Skip if fi = 256 (crystal phase, no-op)
    (if (i32.lt_s (local.get $fi) (i32.const 256))
      (then
        ;; uC: 64 entries at 0x000800 (bit-lane temporal)
        (local.set $i (i32.const 0))
        (block $u_brk (loop $u_lp
          (br_if $u_brk (i32.ge_u (local.get $i) (i32.const 64)))
          (local.set $addr (i32.shl (local.get $i) (i32.const 2)))
          (i32.store offset=0x000800 (local.get $addr)
            (i32.shr_u (i32.mul (i32.load offset=0x000800 (local.get $addr)) (local.get $fi))
              (i32.const 8)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $u_lp)))

        ;; abC evaporation: 131072 entries when stride > 0.
        ;; in 2D raster data, the spatial context changes row by row.
        ;; evaporation keeps the Ab table fresh as the local neighborhood evolves.
        (if (i32.gt_u (global.get $g_stride) (i32.const 0))
          (then
            (local.set $i (i32.const 0))
            (block $ab_brk (loop $ab_lp
              (br_if $ab_brk (i32.ge_u (local.get $i) (i32.const 131072)))
              (local.set $addr (i32.shl (local.get $i) (i32.const 2)))
              (i32.store offset=0x558900 (local.get $addr)
                (i32.shr_u (i32.mul (i32.load offset=0x558900 (local.get $addr)) (local.get $fi))
                  (i32.const 8)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $ab_lp)))))

        ;; SSE: no evaporation — calibration grid must accumulate to be effective.
        ;; SSE cells track prediction accuracy across regimes; decaying them
        ;; destroys the calibration surface that learns phase-transition shapes.
        ))

    (global.set $g_decayTimer (i32.const 0))
    (global.set $g_opinionAcc (f64.const 0.0)))

  ;; update_engram(byte) — AR(2) Cramer fitting for the E-axis predictor
  ;; Called BEFORE g_p1/g_p2 update; reads current p1=prev byte, p2=prev-prev byte.
  ;; Fits b ≈ K·p1 - G·p2 from 5 running dot products (no decay).
  ;; Stores next-byte prediction: engPred = clamp(round(K·byte - G·p1), 0, 255).
  (func $update_engram (param $byte i32)
    (local $b f64) (local $p1 f64) (local $p2 f64)
    (local $det f64) (local $K f64) (local $G f64)
    (local $pred f64)
    ;; cached Cramer sums (avoid repeated global.get in det/K/G computation)
    (local $sp1p1 f64) (local $sp2p2 f64) (local $sp1p2 f64)
    (local $sbp1 f64) (local $sbp2 f64)

    (local.set $b  (f64.convert_i32_u (local.get $byte)))
    (local.set $p1 (f64.convert_i32_u (global.get $g_p1)))
    (local.set $p2 (f64.convert_i32_u (global.get $g_p2)))

    ;; accumulate the five Cramer dot products (no decay — ratios cancel uniform scaling)
    ;; cache updated values in locals for reuse in Cramer's rule below
    (local.set $sp1p1 (f64.add (global.get $g_sP1P1)
      (f64.mul (local.get $p1) (local.get $p1))))
    (global.set $g_sP1P1 (local.get $sp1p1))
    (local.set $sp2p2 (f64.add (global.get $g_sP2P2)
      (f64.mul (local.get $p2) (local.get $p2))))
    (global.set $g_sP2P2 (local.get $sp2p2))
    (local.set $sp1p2 (f64.add (global.get $g_sP1P2)
      (f64.mul (local.get $p1) (local.get $p2))))
    (global.set $g_sP1P2 (local.get $sp1p2))
    (local.set $sbp1 (f64.add (global.get $g_sBP1)
      (f64.mul (local.get $b) (local.get $p1))))
    (global.set $g_sBP1 (local.get $sbp1))
    (local.set $sbp2 (f64.add (global.get $g_sBP2)
      (f64.mul (local.get $b) (local.get $p2))))
    (global.set $g_sBP2 (local.get $sbp2))

    ;; Cramer's rule: solve [sP1P1 -sP1P2; sP1P2 -sP2P2] [K; G] = [sBP1; sBP2]
    ;; det = sP1P2² - sP1P1·sP2P2 (≤ 0 by Cauchy-Schwarz; negative for non-degenerate)
    ;; uses cached locals instead of global.get (local.get is ~0 cycles vs ~2 for global.get)
    (local.set $det (f64.sub
      (f64.mul (local.get $sp1p2) (local.get $sp1p2))
      (f64.mul (local.get $sp1p1) (local.get $sp2p2))))

    ;; guard: skip if degenerate (|det| < 1) — engPred stays at previous value
    (if (f64.lt (f64.abs (local.get $det)) (f64.const 1.0))
      (then (return)))

    ;; K = (-sBP1·sP2P2 + sP1P2·sBP2) / det
    (local.set $K (f64.div
      (f64.add
        (f64.neg (f64.mul (local.get $sbp1) (local.get $sp2p2)))
        (f64.mul (local.get $sp1p2) (local.get $sbp2)))
      (local.get $det)))

    ;; G = (sP1P1·sBP2 - sP1P2·sBP1) / det
    (local.set $G (f64.div
      (f64.sub
        (f64.mul (local.get $sp1p1) (local.get $sbp2))
        (f64.mul (local.get $sp1p2) (local.get $sbp1)))
      (local.get $det)))

    ;; Predict NEXT byte: after state update, new_p1=byte, new_p2=old_p1
    ;; pred = K·byte - G·p1
    (local.set $pred (f64.sub
      (f64.mul (local.get $K) (local.get $b))
      (f64.mul (local.get $G) (local.get $p1))))

    ;; clamp to [0, 255] then round — branchless via f64.min/max
    (global.set $g_engPred
      (i32.trunc_f64_u (f64.nearest
        (f64.min (f64.max (local.get $pred) (f64.const 0.0)) (f64.const 255.0))))))

  ;; updateEntropy(byte) — sliding window with running distinct count.
  ;; maintains g_eDistinct incrementally: O(1) per byte instead of O(256) scan.
  (func $update_entropy (param $byte i32)
    (local $oldByte i32) (local $oldCount i32) (local $newCount i32)

    ;; Evict oldest byte from window (if window is full)
    (if (global.get $g_eFull)
      (then
        (local.set $oldByte (i32.load8_u offset=0x0BAC40 (global.get $g_ePos)))
        (local.set $oldCount (i32.load16_u offset=0x0BAA40
          (i32.shl (local.get $oldByte) (i32.const 1))))
        ;; decrement freq; if it was 1 (going to 0), decrement distinct count
        (i32.store16 offset=0x0BAA40 (i32.shl (local.get $oldByte) (i32.const 1))
          (i32.sub (local.get $oldCount) (i32.const 1)))
        (if (i32.eq (local.get $oldCount) (i32.const 1))
          (then (global.set $g_eDistinct
            (i32.sub (global.get $g_eDistinct) (i32.const 1)))))))

    ;; Insert new byte: check freq before incrementing
    (local.set $newCount (i32.load16_u offset=0x0BAA40
      (i32.shl (local.get $byte) (i32.const 1))))
    ;; if freq was 0 (going to 1), increment distinct count
    (if (i32.eqz (local.get $newCount))
      (then (global.set $g_eDistinct
        (i32.add (global.get $g_eDistinct) (i32.const 1)))))

    ;; eWindow[ePos] = byte
    (i32.store8 offset=0x0BAC40 (global.get $g_ePos) (local.get $byte))
    ;; eFreq[byte]++
    (i32.store16 offset=0x0BAA40 (i32.shl (local.get $byte) (i32.const 1))
      (i32.add (local.get $newCount) (i32.const 1)))

    ;; ePos = (ePos + 1) & 0xFF
    (global.set $g_ePos (i32.and (i32.add (global.get $g_ePos) (i32.const 1)) (i32.const 0xFF)))
    (if (i32.eqz (global.get $g_ePos))
      (then (global.set $g_eFull (i32.const 1))))

    ;; Update bypass flag every 64 bytes (O(1) check instead of O(256) scan)
    (if (i32.and (i32.eqz (i32.and (global.get $g_histPos) (i32.const 63))) (global.get $g_eFull))
      (then
        (global.set $g_eBypass (i32.gt_u (global.get $g_eDistinct) (i32.const 240))))))

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; BYTE PIPELINE — encode/decode one byte through the full predictor
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; encodeByte(byte)
  (func $encode_byte (param $byte i32)
    (local $ctx i32) (local $k i32) (local $bit i32)
    (local $p f64) (local $c0 i32)
    (local $w i32) (local $i i32)
    (local $pos i32) (local $h2 i32)
    (local $prevRunLen i32)

    ;; Match search (or bypass)
    (if (i32.eqz (global.get $g_eBypass))
      (then
        (if (i32.and (i32.gt_s (global.get $g_mRunLen) (i32.const 0))
                     (i32.gt_s (global.get $g_matchCount) (i32.const 0)))
          (then (call $continue_match))
          (else (call $find_match))))
      (else
        (global.set $g_matchCount (i32.const 0))
        (global.set $g_mRunLen (i32.const 0))))

    ;; precompute per-byte base indices (used 8× in blend)
    (global.set $g_o2Base (i32.shl (global.get $g_p1) (i32.const 8)))
    (global.set $g_eBase (i32.shl (global.get $g_engPred) (i32.const 8)))
    (global.set $g_p2nBase (i32.shl (i32.shr_u (global.get $g_p2) (i32.const 4)) (i32.const 8)))

    ;; 8-bit loop: MSB first
    (local.set $ctx (i32.const 1))
    (local.set $k (i32.const 7))
    (block $kbrk (loop $klp
      (br_if $kbrk (i32.lt_s (local.get $k) (i32.const 0)))

      (local.set $bit (i32.and (i32.shr_u (local.get $byte) (local.get $k)) (i32.const 1)))
      (local.set $p (call $blend (local.get $ctx) (local.get $k)))

      ;; opinionAcc += |p - 0.5|
      (global.set $g_opinionAcc (f64.add (global.get $g_opinionAcc)
        (f64.abs (f64.sub (local.get $p) (f64.const 0.5)))))

      ;; c0 = clamp(round(p * 65536), 1, 65535) — branchless select
      (local.set $c0 (i32.trunc_f64_s (f64.add (f64.mul (local.get $p) (f64.const 65536.0)) (f64.const 0.5))))
      (local.set $c0 (select (i32.const 1) (local.get $c0) (i32.lt_s (local.get $c0) (i32.const 1))))
      (local.set $c0 (select (i32.const 65535) (local.get $c0) (i32.gt_s (local.get $c0) (i32.const 65535))))

      (call $enc_encode_bit (local.get $bit) (local.get $c0))
      (call $upd (local.get $ctx) (local.get $k) (local.get $bit))


      ;; SSE update: sseC[sseIdx*2 + bit]++
      (local.set $i (i32.shl (i32.add (i32.shl (global.get $g_sseIdx) (i32.const 1)) (local.get $bit)) (i32.const 2)))
      (i32.store offset=0x010900 (local.get $i)
        (i32.add (i32.load offset=0x010900 (local.get $i)) (i32.const 1)))

      (local.set $ctx (i32.or (i32.shl (local.get $ctx) (i32.const 1)) (local.get $bit)))

      ;; ── Trie filter M-axis (skip when no matches — common case) ──
      (if (i32.gt_s (global.get $g_matchCount) (i32.const 0))
        (then
          (local.set $w (i32.const 0))
          (local.set $i (i32.const 0))
          (block $mfb (loop $mfl
            (br_if $mfb (i32.ge_u (local.get $i) (global.get $g_matchCount)))
            (if (i32.eq
                  (i32.and (i32.shr_u (i32.load8_u offset=0x0B9040 (local.get $i)) (local.get $k)) (i32.const 1))
                  (local.get $bit))
              (then
                (i32.store8 offset=0x0B9040 (local.get $w)
                  (i32.load8_u offset=0x0B9040 (local.get $i)))
                (f64.store offset=0x0B9140 (i32.shl (local.get $w) (i32.const 3))
                  (f64.load offset=0x0B9140 (i32.shl (local.get $i) (i32.const 3))))
                (i32.store offset=0x0B9940 (i32.shl (local.get $w) (i32.const 2))
                  (i32.load offset=0x0B9940 (i32.shl (local.get $i) (i32.const 2))))
                (local.set $w (i32.add (local.get $w) (i32.const 1)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $mfl)))
          (global.set $g_matchCount (local.get $w))))

      (local.set $k (i32.sub (local.get $k) (i32.const 1)))
      (br $klp)))

    ;; ── Match run tracking ──
    (local.set $prevRunLen (global.get $g_mRunLen))
    (global.set $g_mRunLen
      (if (result i32) (i32.gt_s (global.get $g_matchCount) (i32.const 0))
        (then (select (i32.add (global.get $g_mRunLen) (i32.const 1)) (i32.const 255)
          (i32.lt_s (global.get $g_mRunLen) (i32.const 255))))
        (else (i32.const 0))))
    ;; Volatility tracking
    (if (i32.and (i32.eqz (global.get $g_mRunLen)) (i32.gt_s (local.get $prevRunLen) (i32.const 0)))
      (then
        ;; diagHist[min(prevRunLen, 63)]++
        (local.set $i (select (local.get $prevRunLen) (i32.const 63)
          (i32.lt_s (local.get $prevRunLen) (i32.const 63))))
        (i32.store offset=0x0BAD40 (i32.shl (local.get $i) (i32.const 2))
          (i32.add (i32.load offset=0x0BAD40 (i32.shl (local.get $i) (i32.const 2))) (i32.const 1)))
        ;; matchVolatility = min(prevRunLen, 16)
        (global.set $g_matchVolatility (select (local.get $prevRunLen) (i32.const 16)
          (i32.lt_s (local.get $prevRunLen) (i32.const 16)))))
      (else (if (i32.gt_s (global.get $g_matchVolatility) (i32.const 0))
        (then (global.set $g_matchVolatility (i32.sub (global.get $g_matchVolatility) (i32.const 1)))))))

    ;; ── Push byte to history + update hash chains ──
    (local.set $pos (global.get $g_histPos))
    (i32.store8 offset=0x029000 (i32.and (local.get $pos) (i32.const 0xFFFF)) (local.get $byte))

    ;; M-axis 2-byte hash chain
    (if (i32.ge_s (local.get $pos) (i32.const 1))
      (then
        (local.set $h2 (i32.and
          (i32.or
            (i32.shl (i32.load8_u offset=0x029000
              (i32.and (i32.sub (local.get $pos) (i32.const 1)) (i32.const 0xFFFF))) (i32.const 8))
            (local.get $byte))
          (i32.const 0xFFFF)))
        ;; mPrev[pos & WINDOW_MASK] = mLast2[h2]
        (i32.store offset=0x039000
          (i32.shl (i32.and (local.get $pos) (i32.const 0x7FFF)) (i32.const 2))
          (i32.load offset=0x059000 (i32.shl (local.get $h2) (i32.const 2))))
        ;; mLast2[h2] = pos
        (i32.store offset=0x059000 (i32.shl (local.get $h2) (i32.const 2))
          (local.get $pos))))

    (global.set $g_histPos (i32.add (local.get $pos) (i32.const 1)))
    (call $update_engram (local.get $byte))    ;; E-axis: fit AR(2) before p1/p2 shift
    (global.set $g_p2 (global.get $g_p1))
    (global.set $g_p1 (local.get $byte))
    (call $update_entropy (local.get $byte))
    (global.set $g_decayTimer (i32.add (global.get $g_decayTimer) (i32.const 1)))
    (if (i32.ge_u (global.get $g_decayTimer) (i32.const 64))
      (then (call $evaporate))))

  ;; decodeByte() → byte
  (func $decode_byte (result i32)
    (local $ctx i32) (local $k i32) (local $bit i32) (local $byte i32)
    (local $p f64) (local $c0 i32)
    (local $w i32) (local $i i32)
    (local $pos i32) (local $h2 i32)
    (local $prevRunLen i32)

    ;; Match search (same as encoder — both see identical state)
    (if (i32.eqz (global.get $g_eBypass))
      (then
        (if (i32.and (i32.gt_s (global.get $g_mRunLen) (i32.const 0))
                     (i32.gt_s (global.get $g_matchCount) (i32.const 0)))
          (then (call $continue_match))
          (else (call $find_match))))
      (else
        (global.set $g_matchCount (i32.const 0))
        (global.set $g_mRunLen (i32.const 0))))

    ;; precompute per-byte base indices (used 8× in blend)
    (global.set $g_o2Base (i32.shl (global.get $g_p1) (i32.const 8)))
    (global.set $g_eBase (i32.shl (global.get $g_engPred) (i32.const 8)))
    (global.set $g_p2nBase (i32.shl (i32.shr_u (global.get $g_p2) (i32.const 4)) (i32.const 8)))

    (local.set $ctx (i32.const 1))
    (local.set $byte (i32.const 0))
    (local.set $k (i32.const 7))
    (block $kbrk (loop $klp
      (br_if $kbrk (i32.lt_s (local.get $k) (i32.const 0)))

      (local.set $p (call $blend (local.get $ctx) (local.get $k)))
      (global.set $g_opinionAcc (f64.add (global.get $g_opinionAcc)
        (f64.abs (f64.sub (local.get $p) (f64.const 0.5)))))

      ;; c0 = clamp(round(p * 65536), 1, 65535) — branchless select
      (local.set $c0 (i32.trunc_f64_s (f64.add (f64.mul (local.get $p) (f64.const 65536.0)) (f64.const 0.5))))
      (local.set $c0 (select (i32.const 1) (local.get $c0) (i32.lt_s (local.get $c0) (i32.const 1))))
      (local.set $c0 (select (i32.const 65535) (local.get $c0) (i32.gt_s (local.get $c0) (i32.const 65535))))

      (local.set $bit (call $dec_decode_bit (local.get $c0)))
      (call $upd (local.get $ctx) (local.get $k) (local.get $bit))


      ;; SSE update
      (local.set $i (i32.shl (i32.add (i32.shl (global.get $g_sseIdx) (i32.const 1)) (local.get $bit)) (i32.const 2)))
      (i32.store offset=0x010900 (local.get $i)
        (i32.add (i32.load offset=0x010900 (local.get $i)) (i32.const 1)))

      (local.set $byte (i32.or (i32.shl (local.get $byte) (i32.const 1)) (local.get $bit)))
      (local.set $ctx (i32.or (i32.shl (local.get $ctx) (i32.const 1)) (local.get $bit)))

      ;; Trie filter M (skip when no matches — common case)
      (if (i32.gt_s (global.get $g_matchCount) (i32.const 0))
        (then
          (local.set $w (i32.const 0))
          (local.set $i (i32.const 0))
          (block $mfb (loop $mfl
            (br_if $mfb (i32.ge_u (local.get $i) (global.get $g_matchCount)))
            (if (i32.eq
                  (i32.and (i32.shr_u (i32.load8_u offset=0x0B9040 (local.get $i)) (local.get $k)) (i32.const 1))
                  (local.get $bit))
              (then
                (i32.store8 offset=0x0B9040 (local.get $w)
                  (i32.load8_u offset=0x0B9040 (local.get $i)))
                (f64.store offset=0x0B9140 (i32.shl (local.get $w) (i32.const 3))
                  (f64.load offset=0x0B9140 (i32.shl (local.get $i) (i32.const 3))))
                (i32.store offset=0x0B9940 (i32.shl (local.get $w) (i32.const 2))
                  (i32.load offset=0x0B9940 (i32.shl (local.get $i) (i32.const 2))))
                (local.set $w (i32.add (local.get $w) (i32.const 1)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $mfl)))
          (global.set $g_matchCount (local.get $w))))

      (local.set $k (i32.sub (local.get $k) (i32.const 1)))
      (br $klp)))

    ;; Match run tracking (identical to encoder)
    (local.set $prevRunLen (global.get $g_mRunLen))
    (global.set $g_mRunLen
      (if (result i32) (i32.gt_s (global.get $g_matchCount) (i32.const 0))
        (then (select (i32.add (global.get $g_mRunLen) (i32.const 1)) (i32.const 255)
          (i32.lt_s (global.get $g_mRunLen) (i32.const 255))))
        (else (i32.const 0))))
    (if (i32.and (i32.eqz (global.get $g_mRunLen)) (i32.gt_s (local.get $prevRunLen) (i32.const 0)))
      (then
        (global.set $g_matchVolatility (select (local.get $prevRunLen) (i32.const 16)
          (i32.lt_s (local.get $prevRunLen) (i32.const 16)))))
      (else (if (i32.gt_s (global.get $g_matchVolatility) (i32.const 0))
        (then (global.set $g_matchVolatility (i32.sub (global.get $g_matchVolatility) (i32.const 1)))))))

    ;; Push to history + hash chains
    (local.set $pos (global.get $g_histPos))
    (i32.store8 offset=0x029000 (i32.and (local.get $pos) (i32.const 0xFFFF)) (local.get $byte))
    (if (i32.ge_s (local.get $pos) (i32.const 1))
      (then
        (local.set $h2 (i32.and
          (i32.or
            (i32.shl (i32.load8_u offset=0x029000
              (i32.and (i32.sub (local.get $pos) (i32.const 1)) (i32.const 0xFFFF))) (i32.const 8))
            (local.get $byte))
          (i32.const 0xFFFF)))
        (i32.store offset=0x039000
          (i32.shl (i32.and (local.get $pos) (i32.const 0x7FFF)) (i32.const 2))
          (i32.load offset=0x059000 (i32.shl (local.get $h2) (i32.const 2))))
        (i32.store offset=0x059000 (i32.shl (local.get $h2) (i32.const 2)) (local.get $pos))))

    (global.set $g_histPos (i32.add (local.get $pos) (i32.const 1)))
    (call $update_engram (local.get $byte))    ;; E-axis: fit AR(2) before p1/p2 shift
    (global.set $g_p2 (global.get $g_p1))
    (global.set $g_p1 (local.get $byte))
    (call $update_entropy (local.get $byte))
    (global.set $g_decayTimer (i32.add (global.get $g_decayTimer) (i32.const 1)))
    (if (i32.ge_u (global.get $g_decayTimer) (i32.const 64))
      (then (call $evaporate)))

    (local.get $byte))

  ;; ═══════════════════════════════════════════════════════════════════════════
  ;; TOP LEVEL — init, encode, decode
  ;; ═══════════════════════════════════════════════════════════════════════════

  ;; init() — reset all state for a fresh encode/decode
  (func $init (export "init")
    (local $i i32) (local $b i32) (local $ms i32) (local $a i32) (local $c i32) (local $k i32)
    (local $idx i32)

    ;; Zero all globals
    (global.set $g_p1 (i32.const 0))
    (global.set $g_p2 (i32.const 0))
    (global.set $g_histPos (i32.const 0))
    (global.set $g_matchCount (i32.const 0))
    (global.set $g_mRunLen (i32.const 0))
    (global.set $g_matchVolatility (i32.const 0))
    (global.set $g_decayTimer (i32.const 0))
    (global.set $g_opinionAcc (f64.const 0.0))
    (global.set $g_ePos (i32.const 0))
    (global.set $g_eFull (i32.const 0))
    (global.set $g_eBypass (i32.const 0))
    (global.set $g_eDistinct (i32.const 0))
    (global.set $g_sseIdx (i32.const 0))
    (global.set $g_uSlot (i32.const 0))
    (global.set $g_o2Base (i32.const 0))
    (global.set $g_eBase (i32.const 0))
    (global.set $g_p2nBase (i32.const 0))
    ;; Ab-axis (stride is set externally by set_stride, NOT reset here)
    (global.set $g_abByte (i32.const 0))
    (global.set $g_abBase (i32.const 0))
    ;; Engram AR(2) state
    (global.set $g_sP1P1  (f64.const 0.0))
    (global.set $g_sP2P2  (f64.const 0.0))
    (global.set $g_sP1P2  (f64.const 0.0))
    (global.set $g_sBP1   (f64.const 0.0))
    (global.set $g_sBP2   (f64.const 0.0))
    (global.set $g_engPred (i32.const 128))
    ;; Encoder
    (global.set $g_enc_lo (i32.const 0))
    (global.set $g_enc_range (i32.const -1))
    (global.set $g_enc_cache (i32.const -1))
    (global.set $g_enc_nPend (i32.const 0))
    (global.set $g_enc_pos (i32.const 0))
    ;; Decoder
    (global.set $g_dec_lo (i32.const 0))
    (global.set $g_dec_range (i32.const -1))
    (global.set $g_dec_code (i32.const 0))
    (global.set $g_dec_pos (i32.const 0))

    ;; Zero f0C (512 × i32 = 2048 bytes at 0x558100) — order-0 context-free
    (memory.fill (i32.const 0x558100) (i32.const 0) (i32.const 2048))
    ;; Zero uC (64 × i32 = 256 bytes at 0x000800)
    (memory.fill (i32.const 0x000800) (i32.const 0) (i32.const 256))
    ;; Zero hist
    (memory.fill (i32.const 0x029000) (i32.const 0) (i32.const 65536))
    ;; Zero eFreq
    (memory.fill (i32.const 0x0BAA40) (i32.const 0) (i32.const 512))
    ;; Zero eWindow
    (memory.fill (i32.const 0x0BAC40) (i32.const 0) (i32.const 256))
    ;; Zero diagHist
    (memory.fill (i32.const 0x0BAD40) (i32.const 0) (i32.const 256))
    ;; Zero o2C (131072 × i32 = 524288 bytes at 0x3C3000)
    (memory.fill (i32.const 0x3C3000) (i32.const 0) (i32.const 524288))
    ;; Zero eC  (131072 × i32 = 524288 bytes at 0x4C3000)
    (memory.fill (i32.const 0x4C3000) (i32.const 0) (i32.const 524288))
    ;; Zero p2nC (8192 × i32 = 32768 bytes at 0x543000)
    (memory.fill (i32.const 0x543000) (i32.const 0) (i32.const 32768))
    ;; Zero abC (131072 × i32 = 524288 bytes at 0x558900) — Ab-axis counts
    (memory.fill (i32.const 0x558900) (i32.const 0) (i32.const 524288))
    ;; Fill mPrev with -1 (32768 × i32 at 0x039000)
    (memory.fill (i32.const 0x039000) (i32.const 0xFF) (i32.const 131072))
    ;; Fill mLast2 with -1 (65536 × i32 at 0x059000)
    (memory.fill (i32.const 0x059000) (i32.const 0xFF) (i32.const 262144))

    ;; Initialize SSE identity prior
    ;; sseC at 0x010900, 24576 × i32
    ;; Grid: 3 matchState × 16 o2b × 32 bucket × 8 bit lanes = 12,288 cells
    ;; c0 = b, c1 = 31-b  (identity prior anchored on pRaw bucket b, 32 levels)
    (local.set $ms (i32.const 0))
    (block $msb (loop $msl
      (br_if $msb (i32.ge_u (local.get $ms) (i32.const 3)))
      (local.set $c (i32.const 0))
      (block $cb (loop $cl
        (br_if $cb (i32.ge_u (local.get $c) (i32.const 16)))
        (local.set $b (i32.const 0))
        (block $bb (loop $bl
          (br_if $bb (i32.ge_u (local.get $b) (i32.const 32)))
          (local.set $k (i32.const 0))
          (block $kb (loop $kl
            (br_if $kb (i32.ge_u (local.get $k) (i32.const 8)))
            ;; idx = (ms*4096 + c*256 + b*8 + k) * 2
            ;; byte offset = idx * 4
            (local.set $idx (i32.shl
              (i32.shl
                (i32.add
                  (i32.add (i32.mul (local.get $ms) (i32.const 4096))
                           (i32.mul (local.get $c) (i32.const 256)))
                  (i32.add
                    (i32.mul (local.get $b) (i32.const 8))
                    (local.get $k)))
                (i32.const 1))
              (i32.const 2)))
            ;; sseC[idx] = b (identity prior for 32-bucket)
            (i32.store offset=0x010900 (local.get $idx) (local.get $b))
            ;; sseC[idx+1] = 31-b
            (i32.store offset=0x010904 (local.get $idx)
              (i32.sub (i32.const 31) (local.get $b)))
            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $kl)))
          (local.set $b (i32.add (local.get $b) (i32.const 1)))
          (br $bl)))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $cl)))
      (local.set $ms (i32.add (local.get $ms) (i32.const 1)))
      (br $msl)))

    ;; LOG1P LUT at 0x0BAE40 — lazily populated by $log1p on first access.
    ;; starts zeroed (sentinel); $log1p computes ln(1+i) on demand.
    ;; for small inputs, only a handful of entries are ever needed.

)

  ;; encode(inputLen) → compressedLen
  ;; Input data must be at inputBuf (0x1C3000).
  ;; Compressed output written to encBuf (0x0C3000).
  (func $encode (export "encode") (param $inputLen i32) (result i32)
    (local $i i32)
    (call $init)
    (local.set $i (i32.const 0))
    (block $brk (loop $lp
      (br_if $brk (i32.ge_u (local.get $i) (local.get $inputLen)))
      ;; Ab-axis: look up above-neighbor from inputBuf[i - stride]
      ;; when stride = 0 or i < stride, abByte = 0 (neutral context)
      (if (i32.and
            (i32.gt_u (global.get $g_stride) (i32.const 0))
            (i32.ge_u (local.get $i) (global.get $g_stride)))
        (then
          (global.set $g_abByte (i32.load8_u
            (i32.add (i32.const 0x1C3000)
              (i32.sub (local.get $i) (global.get $g_stride))))))
        (else (global.set $g_abByte (i32.const 0))))
      (global.set $g_abBase (i32.shl (global.get $g_abByte) (i32.const 8)))
      (call $encode_byte (i32.load8_u (i32.add (i32.const 0x1C3000) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (call $enc_flush))

  ;; decode(origLen)
  ;; compressed data at inputBuf (0x1C3000), skip mode byte in caller.
  ;; output written to decodeBuf (0x2C3000).
  (func $decode (export "decode") (param $origLen i32)
    (local $i i32)
    (call $init)
    ;; Initialize decoder: read first 4 bytes from inputBuf
    (global.set $g_dec_pos (i32.const 0))
    (global.set $g_dec_code (i32.const 0))
    (local.set $i (i32.const 0))
    (block $db (loop $dl
      (br_if $db (i32.ge_u (local.get $i) (i32.const 4)))
      (global.set $g_dec_code (i32.or
        (i32.shl (global.get $g_dec_code) (i32.const 8))
        (i32.load8_u (i32.add (i32.const 0x1C3000) (global.get $g_dec_pos)))))
      (global.set $g_dec_pos (i32.add (global.get $g_dec_pos) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $dl)))

    ;; Decode bytes
    (local.set $i (i32.const 0))
    (block $brk (loop $lp
      (br_if $brk (i32.ge_u (local.get $i) (local.get $origLen)))
      ;; Ab-axis: look up above-neighbor from decodeBuf[i - stride]
      (if (i32.and
            (i32.gt_u (global.get $g_stride) (i32.const 0))
            (i32.ge_u (local.get $i) (global.get $g_stride)))
        (then
          (global.set $g_abByte (i32.load8_u
            (i32.add (i32.const 0x2C3000)
              (i32.sub (local.get $i) (global.get $g_stride))))))
        (else (global.set $g_abByte (i32.const 0))))
      (global.set $g_abBase (i32.shl (global.get $g_abByte) (i32.const 8)))
      (i32.store8 (i32.add (i32.const 0x2C3000) (local.get $i))
        (call $decode_byte))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; set_stride(s) — set spatial stride for Ab-axis context.
  ;; call before encode()/decode(). stride = 0 disables Ab (pure temporal mode).
  ;; stride = subband width for 2D raster, plane stride for 3D, etc.
  (func $set_stride (export "set_stride") (param $s i32)
    (global.set $g_stride (local.get $s)))

  ;; Export buffer offsets as globals for the TS wrapper
  (global (export "INPUT_BUF") i32 (i32.const 0x1C3000))
  (global (export "ENC_BUF") i32 (i32.const 0x0C3000))
  (global (export "DEC_BUF") i32 (i32.const 0x2C3000))
)
