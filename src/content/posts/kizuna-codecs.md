---
title: "Whispering in 16 Dimensions"
pubDate: 2026-03-03
description: maybe the real friend was the math we made along the way
author: "woflo"
images:
  - url: "/images/kizuna-codecs-cover.webp"
    alt: "Whispering in 16 Dimensions"
---

## sorry, i don't "trust you bro"

i wanted encrypted live messaging. *real* encryption, not "we pinky promise the server doesn't look at it" encryption. peer-to-peer, end-to-end, with nothing in between. and proper encryption built INTO the thing itself. fun fact, most audio, video, or images are only encrypted as a package, not the data itself. i just wanted to solve THAT. nothing else...

building that meant building a codec :(

you can't just encrypt raw PCM (audio) and ship it over WebRTC. you need compression first, and compression means prediction: guess the next sample, subtract your guess, and encode the tiny residual that's left. that's where the 1D harmonic encoder came from. it looks at the previous audio sample, makes a prediction, and encodes the difference. simple and *clean*. the first step up a ladder i didn't realize i was climbing...

> content warning: hypercomplex algebra. but worry not i thought in advance, here's an analogy:

the whole thing works the same way two close friends develop shorthand over time. they build inside jokes. they stop needing to finish sentences because the other person already knows the ending, and can sometimes pivot a 'beat ahead' as a result. a good codec does exactly that with data: learns what shows up often, builds a shorter way to say it, and gets better the longer the conversation goes.

once you have a 1D predictor, a question starts nagging. what happens in 2D? in 3D? and how far does this go?

turns out the answer is **8**. and then **16**. and the thing waiting at 16 is what this post is really about.

## the tower, briefly

the [Möbius predictor formula](https://doi.org/10.2307/2319793) works in any dimension. to predict a value, you look at every corner of the surrounding neighborhood ($2^n - 1$ of them) and combine them with alternating signs: nearest corners add, pairs subtract, triples add back, all the way out, until every contribution has landed *exactly once* and the weights total to 1. the prediction is exact for any signal without a coupling woven through all $n$ dimensions simultaneously. most smooth data qualifies. no particular algebraic structure required. just a *pattern*... working quietly in whatever dimension you hand it...

the dimensions follow the Hurwitz sequence of normed division algebras:

| dimension | algebra | neighbors | name in Whisper |
|-----|---------|-----------|-----------------|
| 0 | (none) | 0 | **Logos** |
| 1 | R (reals) | 1 | **Harmonic** |
| 2 | C (complex) | 3 | **Lumen** |
| 4 | H (quaternions) | 15 | **Akasha** |
| 8 | O (octonions) | 255 | **Loup** |
| 16 | S (sedenions) | 65,535 | **Kizuna** |

[Hurwitz proved in 1898](https://doi.org/10.1007/978-3-0348-4160-3_39) that the algebraic sequence $\mathbb{R} \to \mathbb{C} \to \mathbb{H} \to \mathbb{O}$ closes at 8. octonions are the last normed division algebra. sedenions have zero divisors, so the algebraic structure breaks there; however, the Möbius formula doesn't care. *it* only needs the inclusion-exclusion identity, and *that* works in any dimension. the predictor survives past the algebraic boundary. the math *outlives* the structure it was born from.

this post covers three layers: Logos at 0D (entropy), Loup at 8D (spatial prediction), and Kizuna at 16D (the bond). the first two set the stage. Kizuna is the star.

## Logos: the entropy floor

at zero dimensions there are no neighbors. no geometry. just a stream of bytes and the question: what comes next?

Logos is a single unified adaptive entropy coder built around a six-axis predictor. one model, no competing strategies. it learns the vocabulary, the temporal patterns, and the relationship between consecutive bytes, all blended into one probability estimate per bit.

the axes, from local to global:

- **F0 (order-0 frequency)**: no context. doesn't care what byte came before. just counts how often each bit pattern has appeared, ever. 255 nodes, warms instantly. the ground-state prediction — the one still standing when every context-dependent model is staring at the wrong map.
- **U (across bytes, per bit position)**: looks at the same bit position in the previous two bytes and asks whether the pattern there continues. alternating values, long runs of the same bit, positions that barely ever change. 4 states per bit position, 32 cells total. patterns that a context-free tree is blind to, because it never looks across byte boundaries.
- **O2 (full previous byte)**: all 8 bits of the previous byte as context for the bit tree. 256 × 255 cells. absolute position in $\mathbb{Z}_2^8$ — sees the exact byte identity, not just its magnitude. never forgets. other axes adapt and decay; O2 just keeps accumulating.
- **E (Engram AR(2) oscillator)**: five running dot products maintain an oscillator model $b_n \approx K \cdot p_1 - G \cdot p_2$. each byte, Cramer's rule fits $K$ and $G$ from the accumulated statistics, then predicts the next byte value (0–255). that prediction becomes a context for its own 256 × 255 bit tree. the codec learns not just where the stream *is* (O2), but where it's *going* under its own inertia. no decay needed — Cramer's rule uses ratios, so scaling the sums uniformly changes nothing.
- **P2N (prev-prev nibble class)**: the top nibble of the byte before last. 16 coarse classes, 4,080 cells. nobody else looks two bytes back — O2 sees p1, E fits trajectory, P2N remembers p2's rough shape. warms 16× faster than a full p2 table would.
- **M (exact match PPM)**: walks a hash chain through recent history, finds all positions where the last two bytes match, weights each candidate by context depth. exclusion: if deeper context agrees with a candidate, it amplifies; if it contradicts, it suppresses.

the correlated witnesses (F0, U, O2, E, P2N) share the same bit-tree context variable, so combining them in log-odds would double-count their shared information. instead, each axis contributes a quantum amplitude — think of five tuning forks vibrating at slightly different frequencies. when they agree, the amplitudes add constructively and the combined signal sharpens. when they disagree, destructive interference pulls the prediction back toward uncertainty. the final probability comes from squaring the superposed amplitude: **Born rule mixing**. M carries independent signal (hash-chain context), so it enters via log-odds on top. the resulting probability passes through a 3-state SSE that calibrates the final bit probability before it hits the range coder.

the estimates are blended by **mass-weighted opinion**: each axis votes proportional to how far it's deviated from 50/50, scaled by how much history backs that confidence. a context that's fired 10,000 times anchors the blend far more than one that fired twice, even at equally extreme predictions. a bullet versus a glacier. evidence caps keep any single axis from drowning the others — F0 saturates at ln(2), U at ln(3), the big tables at ln(4).

every 64 bytes, the U-axis counts decay at a rate that tracks the local entropy. high structure → slow decay → the model crystallizes. high entropy → fast decay → the model stays fluid and resets when the data phase-shifts. O2, E, and P2N never decay. they accumulate indefinitely because they *need* long-term statistics. the codec matches the temperature of the data.

if arithmetic coding the output beats raw, a single mode byte says so. if not, raw wins with no overhead. output is guaranteed $\leq \text{input} + 1$ byte.

the important detail for later: the bit-tree context has **255 nodes** ($2^8 - 1$). that number comes back :P

## Loup: the 8D predictor

the 8D Möbius predictor sums over all $255$ non-empty subsets of 8 dimensions, weighted by inclusion-exclusion:

$$
P = \sum (-1)^{|S|+1} \cdot f(\text{neighbor}_S)
$$

255 terms, grouped by binomial coefficient: +8, -28, +56, -70, +56, -28, +8, -1. add the 8 direct neighbors, subtract the 28 pairs, add the 56 triples, on and on through all 255 groups. they sum to exactly 1. the predictor is unbiased, and it's exact for any signal without a coupling running through all eight dimensions at once. *most data, most of the time.* if your friend's train of thought takes up to seven sharp turns, Loup still knows exactly how the sentence ends. *no guess needed.*

Loup uses an anti-causal variant that looks forward instead of backward, and this unlocks the **boundary theorem**. when any coordinate of a voxel sits at the block edge, the sum telescopes to the value itself. prediction is exact. residual is zero. *always*. regardless of the data. like a jigsaw piece at the edge of the puzzle: the flat sides constrain it so completely that its identity is mathematical inevitability.

at block size 4, the free-zero fraction is $1 - (3/4)^8 = \mathbf{89.99\%}$. almost 90% of every block is edge pieces. only 6,561 interior voxels out of 65,536 need actual computation.

### the duality

here's where it clicks. Logos has 255 context tree nodes. Loup has 255 spatial neighbors. both sit on the same mathematical object: the [Boolean lattice](https://en.wikipedia.org/wiki/Boolean_algebra) $2^{\{0,\ldots,7\}}$, also written as the exterior algebra $\Lambda^*(\mathbb{R}^8)$.

think about how Logos breaks a byte into 8 binary decisions, each one depending on the ones before it. that chain of conditions has exactly 255 nodes, one for every non-empty combination of the 8 bits. and Loup has exactly 255 spatial corners, one for every non-empty combination of the 8 dimensions. *what is the next bit, given everything before it?* is the same question as *what does this voxel look like, given every corner around it?* written in a different language.

this duality extends *upward*. a 16-bit symbol decomposes into 65,535 binary contexts. the 16D predictor has 65,535 neighbors. same lattice, same structure, one dimension higher. *i fell in love with this.*

which brings us to my beloved Kizuna.

## Kizuna: the bond

65,535 neighbors. 99.998% free zeros. **one** interior voxel.

at block size 2 in 16 dimensions, each coordinate is 0 or 1. the block has $2^{16} = 65{,}536$ voxels. the boundary theorem holds here too, and since every voxel except the origin has at least one coordinate equal to 1, only the origin needs a predictor. every other voxel's residual is exactly zero by construction.

the free-zero fraction:

$$
1 - (1/2)^{16} = 65{,}535 / 65{,}536 = 99.998\%
$$

that single origin residual is a weighted mix of all 65,535 surrounding voxels, with alternating signs from each. change any byte anywhere in the block, any bit of any byte, and the residual shifts by exactly $\pm 1$. *nothing* is hidden from it. the whole thing is a [mathematical identity](https://doi.org/10.1016/bs.aiep.2017.05.002), *exact by construction*.

holy yap. instead, try thinking of it like a wax seal on a letter. a single impression, but it captures the shape of every groove in the ring. change any groove, no matter how small, and the seal comes out different. this residual is that kind of seal for 65,536 bytes.

### the handshake

two people connect over WebRTC and run a standard ECDH key exchange. out of that comes a shared secret that only the two of them have. they expand it to exactly 65,536 bytes, feed it into the 16D predictor, and suddenly both sides are holding the same wax seal, the same spatial context, and the same entropy state. ***a shared vocabulary before a single word has been spoken.***

three things come out of that block. both parties compute them independently. no extra messages.

1. **the residual (spectral witness)**

   the single Möbius mixing of all 65,535 boundary voxels, acting as a wax seal. if both sides get the same value, they're bonded to the same secret. it's the verification step, sensitive to every byte in the block. no separate key confirmation protocol needed.

2. **the 8D context block**

   the 65,536-byte block happens to be exactly the right size for a $4^8$ voxel Octonion block. Loup uses it directly as pre-seeded spatial context, so the first compressed frames start warm. better compression from sample one.

3. **the Logos seed**

   the first 512 bytes of the shared block get played through the Möbius bit-context model, priming 512 binary contexts with biases derived from the key material. this sets the entropy coder's initial state to something only you and the other person know.

and this is where things get **really** interesting.

### trajectory encryption

the entropy coder is stateful. every frame it encodes reshapes its internal probability tables. frame 1 alters the model, which changes how frame 2 gets encoded, which reshapes the model again for frame 3. the codec traces a trajectory through probability space, and that trajectory depends on two things: where it started (the handshake) and every frame that came before.

this is exactly how two people develop their own language over months of talking. every conversation builds on the last one. the shorthand gets denser. the references get more obscure. someone overhearing sentence 47 can't make perfect sense of the topic because they missed sentences 1 through 46. there's no catching up without *starting over*.

for an attacker this means you can't just intercept frame 47 and decode it. you would need:

1. the shared secret from the ECDH handshake (to derive the initial Logos seed and 8D context)
2. every single frame from 0 through 46 (to ratchet the model forward through the same trajectory)

miss ***one frame*** and the model state diverges. the probability tables are wrong. the arithmetic decoder produces *garbage*. the trajectory has forked and there's no recovering without going all the way back to the start.

this is frame ratcheting. the "key" is the evolving state of the codec itself, shaped by the handshake and every moment of the conversation. each frame is encrypted by the trajectory of everything before it. the conversation **encrypts itself**, and the bond deepens with every frame.

that's where the name comes from. 絆 (*kizuna*) means 'bond' in Japanese; the kind that strengthens over time.

### the full picture

```
ECDH shared secret
     │
     ▼
  expand to 65,536 bytes
     │
     ├──→ 16D Möbius ──→ residual (spectral witness)
     │
     ├──→ reinterpret as 4^8 block ──→ 8D Loup context (warm start)
     │
     └──→ first 512 bytes ──→ Logos seed (secret-dependent entropy state)
                                   │
                               frame 0 ──→ updates model
                               frame 1 ──→ updates model
                               frame 2 ──→ updates model
                                  ...
                               frame N ──→ only decodable with
                                           handshake + frames 0..N-1
```

three layers. one block. no extra round trips.

the 0D entropy coder provides adaptive compression. the 8D predictor exploits spatial correlations. the 16D bond ties the cryptographic state into both, creating a trajectory that ratchets forward with every frame.

the duality connects it all. 255 contexts mirror 255 neighbors. 65,535 contexts mirror 65,535 neighbors. the Boolean lattice says the same thing twice in two different languages, and the codec speaks both.

## closing thoughts

i started with a problem (encrypt stuff *properly*, peer-to-peer, no servers) and ended up building a codec stack where the encryption grows out of the same math that powers the compression. that wasn't the plan. the plan was just good audio over WebRTC. but once the 1D predictor worked, and the tower was there... the only honest thing to do was climb it.

the scary algebra turned out to be the kindest part. 65,535 terms sounds absurd until you realize 99.998% of them collapse to zero and the single survivor is a wax seal of everything in the block. the Möbius formula does the heavy lifting. you just have to trust the math and let it work.

all of this runs in the browser. no servers, no intermediaries, no trust required. your messages are encoded in a language that only exists between the two of you. one that started from a secret handshake and gets deeper with every single frame.

anyway. that's what's behind the [scenes](/whisper)

---

### works referenced

- **Möbius Inversion Formula**: Bender, E. A., & Goldman, J. R. (1975). *On the Applications of Möbius Inversion in Combinatorial Analysis*. [doi:10.2307/2319793](https://doi.org/10.2307/2319793)
- **Normed Division Algebras**: Hurwitz, A. (1898). *Über die Komposition der quadratischen Formen von beliebig vielen Variablen*. [doi:10.1007/978-3-0348-4160-3_39](https://doi.org/10.1007/978-3-0348-4160-3_39)
- **Laplace Smoothing**: *Weight Smoothing for Generalized Linear Models Using a Laplace Prior*. (2016). [doi:10.1515/JOS-2016-0026](https://doi.org/10.1515/JOS-2016-0026)
- **Walsh-Hadamard Transform**: *Walsh–Hadamard Transforms: A Review*. (2017). [doi:10.1016/bs.aiep.2017.05.002](https://doi.org/10.1016/bs.aiep.2017.05.002)

---

- woflo

<!-- markdownlint-disable-next-line MD033 -->
<p class="text-[length:var(--text-sm)] opacity-25 mt-8 text-center">Patent Pending</p>
