// the descent — interactive engine
// scroll-driven visuals for /whisper/codecs

// ── constants ────────────────────────────────────────────────────

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const IS_COARSE = matchMedia("(pointer: coarse)").matches;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const PARTICLE_N = IS_COARSE ? 90 : 180;

let ptrX = 0; // normalized pointer, -0.5 to 0.5
let ptrY = 0;

// ── utilities ────────────────────────────────────────────────────

function fitCanvas(
  canvas: HTMLCanvasElement,
  sizeRef: HTMLElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const r = sizeRef.getBoundingClientRect();
  canvas.width = r.width * DPR;
  canvas.height = r.height * DPR;
  canvas.style.width = r.width + "px";
  canvas.style.height = r.height + "px";
  const ctx = canvas.getContext("2d")!;
  ctx.scale(DPR, DPR);
  return { ctx, w: r.width, h: r.height };
}

// per-act progress cache — written by scroll engine, read by draw loops.
// avoids parseFloat + getPropertyValue DOM reads every frame per act.
const actProgress = new WeakMap<HTMLElement, number>();

function readProgress(el: HTMLElement): number {
  return actProgress.get(el) || 0;
}

function observeVisibility(el: HTMLElement): { isVisible: () => boolean } {
  let visible = false;
  const obs = new IntersectionObserver(
    ([e]) => { visible = e.isIntersecting; },
    { threshold: 0.01 },
  );
  obs.observe(el);
  return { isVisible: () => visible };
}

// debounced resize — all resize handlers register here, fire once per rAF
let resizeCallbacks: (() => void)[] = [];
let resizePending = false;

function onResize(cb: () => void) {
  resizeCallbacks.push(cb);
}

window.addEventListener("resize", () => {
  if (resizePending) return;
  resizePending = true;
  requestAnimationFrame(() => {
    resizePending = false;
    for (const cb of resizeCallbacks) cb();
  });
}, { passive: true });

// ── scroll progress engine ───────────────────────────────────────
// sets --p (0-1) on each .act based on how far it's scrolled,
// and --scroll-progress on the main container for the progress bar.
// caches act heights to avoid getBoundingClientRect layout thrash —
// only the top offset changes during scroll, heights are stable.

function initScrollEngine(main: HTMLElement) {
  const acts = Array.from(main.querySelectorAll<HTMLElement>(".act"));
  // cache act heights — only recompute on resize
  let actHeights: number[] = acts.map(a => a.offsetHeight);

  onResize(() => {
    actHeights = acts.map(a => a.offsetHeight);
  });

  function tick() {
    const vh = window.innerHeight;
    let totalScrollable = 0;
    let totalScrolled = 0;

    for (let i = 0; i < acts.length; i++) {
      const act = acts[i];
      // offsetTop is cheap (no layout forced if heights haven't changed).
      // getBoundingClientRect().top accounts for scroll, which is what we need.
      // but we only need the top, and the browser can fast-path single-property reads.
      const top = act.getBoundingClientRect().top;
      const scrollable = actHeights[i] - vh;

      totalScrollable += Math.max(0, scrollable);
      totalScrolled += Math.max(0, Math.min(scrollable, -top));

      let p: number;
      if (scrollable <= 0) {
        p = top <= 0 ? 1 : 0;
      } else {
        p = Math.max(0, Math.min(1, -top / scrollable));
      }

      // write to cache for JS draw loops (zero DOM overhead)
      actProgress.set(act, p);
      // write to CSS for CSS-driven animations
      act.style.setProperty("--p", p.toFixed(5));
    }

    const gp = totalScrollable > 0 ? totalScrolled / totalScrollable : 0;
    main.style.setProperty("--scroll-progress", gp.toFixed(5));
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ── pointer tracking ─────────────────────────────────────────────
// sets --ptr-x and --ptr-y on the main container for CSS parallax.

function initPointer(main: HTMLElement) {
  window.addEventListener(
    "pointermove",
    (e) => {
      ptrX = e.clientX / window.innerWidth - 0.5;
      ptrY = e.clientY / window.innerHeight - 0.5;
      main.style.setProperty("--ptr-x", ptrX.toFixed(4));
      main.style.setProperty("--ptr-y", ptrY.toFixed(4));
    },
    { passive: true },
  );
}

// ── act 1: logos — 255-node binary tree ──────────────────────────
// radial projection of the 8-level bit-context tree.
// each level reveals as scroll progresses, connections curve
// toward center for an organic tendril feel.

interface TreeNode {
  x: number;
  y: number;
  px: number; // parent x
  py: number; // parent y
  level: number;
  revealAt: number; // scroll progress when this node appears
}

function buildTree(w: number, h: number): TreeNode[] {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.4;
  const nodes: TreeNode[] = [];

  nodes.push({ x: cx, y: cy, px: cx, py: cy, level: 0, revealAt: 0 });

  let idx = 1;
  for (let lv = 1; lv <= 7; lv++) {
    const count = 1 << lv;
    const r = maxR * Math.pow(lv / 7, 0.7);
    const parentBase = (1 << (lv - 1)) - 1;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 - Math.PI / 2 + Math.sin(idx * 5.7) * 0.06;
      const pi = parentBase + (i >> 1);
      nodes.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        px: nodes[pi].x,
        py: nodes[pi].y,
        level: lv,
        revealAt: lv / 8,
      });
      idx++;
    }
  }
  return nodes;
}

function initTree(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".tree-canvas");
  if (!canvas) return;
  const pin = act.querySelector<HTMLElement>(".pin")!;

  let { ctx, w, h } = fitCanvas(canvas, pin);
  let nodes = buildTree(w, h);
  const { isVisible } = observeVisibility(act);
  const counterEl = act.querySelector<HTMLElement>(".counter-value");

  function draw() {
    ctx.clearRect(0, 0, w, h);
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();

    // connections — batch into a single path per alpha band
    const rootX = nodes[0].x;
    const rootY = nodes[0].y;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let connAlpha = -1;
    for (let i = 1; i < nodes.length; i++) {
      const nd = nodes[i];
      const reveal = Math.max(0, Math.min(1, (p - nd.revealAt) * 9));
      if (reveal <= 0) continue;

      const a = reveal * 0.14;
      if (connAlpha >= 0 && Math.abs(a - connAlpha) > 0.01) {
        ctx.strokeStyle = `rgba(0,255,255,${connAlpha})`;
        ctx.stroke();
        ctx.beginPath();
      }
      connAlpha = a;

      const ex = nd.px + (nd.x - nd.px) * reveal;
      const ey = nd.py + (nd.y - nd.py) * reveal;
      const mx = (nd.px + ex) * 0.5;
      const my = (nd.py + ey) * 0.5;

      ctx.moveTo(nd.px, nd.py);
      ctx.quadraticCurveTo(
        mx + (rootX - mx) * 0.12,
        my + (rootY - my) * 0.12,
        ex, ey,
      );
    }
    if (connAlpha > 0) {
      ctx.strokeStyle = `rgba(0,255,255,${connAlpha})`;
      ctx.stroke();
    }

    // nodes — batch non-root nodes at same alpha into one path
    const rootBreathe = Math.sin(time / 800) * 0.3 + 0.8;
    ctx.beginPath();
    let nodeAlpha = -1;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const reveal = Math.max(0, Math.min(1, (p - nd.revealAt) * 9));
      if (reveal <= 0) continue;

      const a = reveal * (i === 0 ? 0.9 : 0.55);
      if (nodeAlpha >= 0 && Math.abs(a - nodeAlpha) > 0.02) {
        ctx.fillStyle = `rgba(0,255,255,${nodeAlpha})`;
        ctx.fill();
        ctx.beginPath();
      }
      nodeAlpha = a;

      const breathe = i === 0 ? rootBreathe : 1;
      const size = (i === 0 ? 4 : Math.max(1.2, 2.8 - nd.level * 0.2)) * reveal * breathe;
      ctx.moveTo(nd.x + size, nd.y);
      ctx.arc(nd.x, nd.y, size, 0, Math.PI * 2);
    }
    if (nodeAlpha > 0) {
      ctx.fillStyle = `rgba(0,255,255,${nodeAlpha})`;
      ctx.fill();
    }

    // root glow
    const glowR = 16 + Math.sin(time / 600) * 4;
    const grad = ctx.createRadialGradient(nodes[0].x, nodes[0].y, 0, nodes[0].x, nodes[0].y, glowR);
    grad.addColorStop(0, "rgba(0,255,255,0.12)");
    grad.addColorStop(1, "rgba(0,255,255,0)");
    ctx.beginPath();
    ctx.arc(nodes[0].x, nodes[0].y, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // entropy counter: 8.00 bits/byte → ~4.50 as tree learns
    if (counterEl) counterEl.textContent = (8 - p * 3.5).toFixed(2);

    requestAnimationFrame(draw);
  }

  onResize(() => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    nodes = buildTree(w, h);
  });

  requestAnimationFrame(draw);
}

// ── act 3: loup — 255-node lattice bloom ─────────────────────────
// the 255 non-empty subsets of 8 dimensions, arranged in concentric
// rings by cardinality. rings bloom outward with alternating +/−
// inclusion-exclusion sign, then collapse to show the boundary theorem.

interface LatticeNode {
  x: number;
  y: number;
  ring: number;     // cardinality 1–8
  subset: number;   // bitmask
  positive: boolean; // odd cardinality = positive sign
}

// binomial coefficients C(8, k)
const BINOM8 = [0, 8, 28, 56, 70, 56, 28, 8, 1];

// sign labels for the counter display
const SIGN_LABELS = [
  "", "+8", "\u221228", "+56", "\u221270", "+56", "\u221228", "+8", "\u22121",
];

function buildLattice(w: number, h: number): { nodes: LatticeNode[]; edges: [number, number][] } {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.38;
  const nodes: LatticeNode[] = [];

  // generate all 255 non-empty subsets grouped by cardinality
  const ringStart: number[] = [0]; // ringStart[k] = first node index of ring k
  for (let k = 1; k <= 8; k++) {
    ringStart.push(nodes.length);
    const r = maxR * Math.pow(k / 8, 0.72);
    const offset = k * 0.39; // angular offset per ring to break radial lines
    let count = 0;
    for (let s = 1; s < 256; s++) {
      if (popcount(s) !== k) continue;
      const angle = (count / BINOM8[k]) * Math.PI * 2 - Math.PI / 2 + offset;
      nodes.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        ring: k,
        subset: s,
        positive: k % 2 === 1,
      });
      count++;
    }
  }
  ringStart.push(nodes.length);

  // edges: connect subset S of cardinality k to superset S|bit of cardinality k+1
  // limit edges to keep it readable (~2 per node on average)
  const edges: [number, number][] = [];
  const edgeCount = new Map<number, number>();

  for (let k = 1; k <= 7; k++) {
    const lo = ringStart[k];
    const hi = ringStart[k + 1];
    const loEnd = ringStart[k + 1];
    const hiEnd = ringStart[k + 2];

    for (let i = lo; i < loEnd; i++) {
      const s = nodes[i].subset;
      for (let j = hi; j < hiEnd; j++) {
        const t = nodes[j].subset;
        // t is a superset of s with exactly one extra bit
        if ((s & t) === s && popcount(t ^ s) === 1) {
          const ci = edgeCount.get(i) || 0;
          const cj = edgeCount.get(j) || 0;
          if (ci < 2 && cj < 3) {
            edges.push([i, j]);
            edgeCount.set(i, ci + 1);
            edgeCount.set(j, cj + 1);
          }
        }
      }
    }
  }

  return { nodes, edges };
}

function popcount(n: number): number {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  return (((n + (n >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

function initLattice(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".lattice-canvas");
  if (!canvas) return;
  const pin = act.querySelector<HTMLElement>(".pin")!;

  let { ctx, w, h } = fitCanvas(canvas, pin);
  let { nodes, edges } = buildLattice(w, h);
  const { isVisible } = observeVisibility(act);
  const counterEl = act.querySelector<HTMLElement>(".counter-value");
  const unitEl = act.querySelector<HTMLElement>(".counter-unit");

  function draw() {
    ctx.clearRect(0, 0, w, h);
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();

    const cx = w / 2;
    const cy = h / 2;

    // pointer parallax: shift center slightly
    const ox = ptrX * 18;
    const oy = ptrY * 18;

    // phase 3: boundary fade (p 0.55–0.75)
    const boundaryFade = Math.max(0, Math.min(1, (p - 0.55) / 0.2));

    // draw edges — batch edges by similar alpha into fewer strokes.
    // edges whose rings aren't revealed yet are skipped entirely.
    const bfInv = 1 - boundaryFade * 0.92;
    if (bfInv > 0.01) {
      ctx.lineWidth = 0.75;
      // group visible edges into one path per approximate alpha bucket
      ctx.beginPath();
      let currentAlpha = -1;
      for (let ei = 0; ei < edges.length; ei++) {
        const a = nodes[edges[ei][0]];
        const b = nodes[edges[ei][1]];
        const maxRing = a.ring > b.ring ? a.ring : b.ring;
        const ringReveal = ringProgress(p, maxRing);
        if (ringReveal <= 0) continue;

        const edgeAlpha = 0.08 * ringReveal * bfInv;
        // flush path when alpha changes significantly (avoids per-edge stroke)
        if (currentAlpha >= 0 && Math.abs(edgeAlpha - currentAlpha) > 0.01) {
          ctx.strokeStyle = `rgba(0,255,255,${currentAlpha})`;
          ctx.stroke();
          ctx.beginPath();
        }
        currentAlpha = edgeAlpha;

        const ax = a.x + ox;
        const ay = a.y + oy;
        const bx = b.x + ox;
        const by = b.y + oy;
        const mx = (ax + bx) * 0.5;
        const my = (ay + by) * 0.5;

        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo(
          mx + (cx + ox - mx) * 0.15,
          my + (cy + oy - my) * 0.15,
          bx, by,
        );
      }
      if (currentAlpha > 0) {
        ctx.strokeStyle = `rgba(0,255,255,${currentAlpha})`;
        ctx.stroke();
      }
    }

    // draw nodes — precompute per-node values that are constant across frames,
    // only alpha/size vary with scroll progress
    const breatheBase = REDUCED ? 0 : time / 900;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const reveal = ringProgress(p, nd.ring);
      if (reveal <= 0) continue;

      // boundary theorem: pc ≤ 2 = interior sub-lattice (precomputed in node)
      const isInterior = nd.ring <= 2;
      const dimming = boundaryFade * (isInterior ? 0 : 0.95);

      const alpha = reveal * (1 - dimming);
      if (alpha < 0.01) continue;

      const breathe = REDUCED ? 0 : Math.sin(breatheBase + i * 0.7) * 0.15;
      const nx = nd.x + ox;
      const ny = nd.y + oy;
      const baseSize = nd.ring === 1 ? 2.8 : nd.ring === 8 ? 3.2 : 2;
      const size = baseSize * (0.85 + reveal * 0.15 + breathe);

      if (nd.positive) {
        ctx.fillStyle = `rgba(0,255,255,${alpha * 0.7})`;
      } else {
        ctx.fillStyle = `rgba(120,180,255,${alpha * 0.55})`;
      }

      ctx.beginPath();
      ctx.arc(nx, ny, size, 0, Math.PI * 2);
      ctx.fill();

      // glow halo on ring 1 and ring 8 nodes only
      if ((nd.ring === 1 || nd.ring === 8) && alpha > 0.2) {
        const glowR = size * 4;
        const grad = ctx.createRadialGradient(nx, ny, 0, nx, ny, glowR);
        const gc = nd.positive ? "0,255,255" : "120,180,255";
        grad.addColorStop(0, `rgba(${gc},${alpha * 0.08})`);
        grad.addColorStop(1, `rgba(${gc},0)`);
        ctx.beginPath();
        ctx.arc(nx, ny, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    // center glow: faint radial when lattice is partially revealed
    const centerAlpha = Math.min(p * 3, 1) * (1 - boundaryFade * 0.6);
    if (centerAlpha > 0.01) {
      const gr = 12 + (REDUCED ? 0 : Math.sin(time / 700) * 3);
      const cg = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, gr);
      cg.addColorStop(0, `rgba(0,255,255,${centerAlpha * 0.1})`);
      cg.addColorStop(1, "rgba(0,255,255,0)");
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, gr, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
    }

    // counter updates
    if (counterEl && unitEl) {
      if (p < 0.08) {
        counterEl.textContent = "";
        unitEl.textContent = "";
      } else if (p < 0.58) {
        // show current ring's sign label
        const ringIdx = Math.min(8, Math.floor(((p - 0.08) / 0.5) * 8) + 1);
        counterEl.textContent = SIGN_LABELS[ringIdx] || "";
        unitEl.textContent = "subsets";
      } else if (p < 0.68) {
        counterEl.textContent = "255";
        unitEl.textContent = "neighbors";
      } else {
        counterEl.textContent = "90%";
        unitEl.textContent = "free";
      }
    }

    requestAnimationFrame(draw);
  }

  // per-ring reveal timing: each ring gets a slice of p 0.05–0.55
  function ringProgress(p: number, ring: number): number {
    const start = 0.05 + (ring - 1) * 0.055;
    const duration = 0.08;
    return Math.max(0, Math.min(1, (p - start) / duration));
  }

  onResize(() => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    ({ nodes, edges } = buildLattice(w, h));
  });

  requestAnimationFrame(draw);
}

// ── act 2: harmonic — live audio waveform ────────────────────────
// canvas-rendered compound harmonic. two voices at 0.3% pitch offset
// create beating that never visually repeats. the dim prediction
// ghost shows what AR(2) anticipates — smooth, missing transients.

function initWaveform(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".wave-canvas");
  if (!canvas) return;

  let { ctx, w, h } = fitCanvas(canvas, canvas);
  onResize(() => { ({ ctx, w, h } = fitCanvas(canvas, canvas)); });

  const baseW = 7 * 2 * Math.PI; // 7 fundamental cycles across window

  // 1/n harmonic series: sawtooth character (bowed string)
  function voice(t: number, freq: number, phase: number): number {
    return Math.sin(freq * t + phase)
      + 0.45 * Math.sin(2 * freq * t + 2 * phase)
      + 0.28 * Math.sin(3 * freq * t + 3 * phase)
      + 0.15 * Math.sin(4 * freq * t + 4 * phase)
      + 0.08 * Math.sin(5 * freq * t + 5 * phase);
  }

  // full signal: two detuned voices mixed with amplitude envelope
  function sig(t: number, time: number): number {
    const env = Math.min(1, Math.sin(t * Math.PI) * 1.4);
    const breath = 0.88 + 0.12 * Math.sin(time * 0.35);
    return env * breath * (
      0.55 * voice(t, baseW, time * 0.5) +
      0.45 * voice(t, baseW * 1.003, time * 0.515)
    ) / 1.96;
  }

  // AR(2) prediction: fundamental voice only, lower harmonics, slightly ahead
  function pred(t: number, time: number): number {
    const env = Math.min(1, Math.sin(t * Math.PI) * 1.4);
    const p = time * 0.5;
    return env * (Math.sin(baseW * t + p) + 0.4 * Math.sin(2 * baseW * t + 2 * p)) / 1.4;
  }

  const { isVisible } = observeVisibility(act);

  function draw() {
    const p = readProgress(act);
    ctx.clearRect(0, 0, w, h);

    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const time = REDUCED ? 0 : performance.now() / 1000;
    const revealX = w * Math.min(1, p * 2.2);

    if (revealX < 1) { requestAnimationFrame(draw); return; }

    const cy = h / 2;
    const amp = h * 0.38;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, revealX, h);
    ctx.clip();

    // prediction ghost
    ctx.beginPath();
    for (let px = 0; px <= w; px += 2) {
      const t = px / w;
      const y = cy - amp * pred(t + 0.008, time);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.strokeStyle = "rgba(0,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // filled body under the wave
    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const t = px / w;
      const y = cy - amp * sig(t, time);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.lineTo(w, cy);
    ctx.lineTo(0, cy);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,255,255,0.045)";
    ctx.fill();

    // main stroke with bloom
    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const t = px / w;
      const y = cy - amp * sig(t, time);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    // bloom: wide dim stroke behind sharp stroke (avoids shadowBlur perf hit on Safari)
    ctx.strokeStyle = "rgba(0,255,255,0.08)";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,255,255,0.75)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
}

// ── act 4: kizuna — two lattice blooms collide ──────────────────
// two 8D lattice blooms (reusing buildLattice from act 3) approach
// from opposite sides, collide at p≈0.4, shockwave radiates,
// then they merge into a single rotating 16D structure with a
// Möbius ring of witness dots. neighbor counter races to 65,535.

function initKizuna(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".kizuna-canvas");
  if (!canvas) return;
  const pin = act.querySelector<HTMLElement>(".pin")!;

  let { ctx, w, h } = fitCanvas(canvas, pin);
  const { isVisible } = observeVisibility(act);
  const counterEl = act.querySelector<HTMLElement>(".counter-value");

  // build a compact lattice for each half (smaller radius for kizuna)
  function buildMiniLattice(cx: number, cy: number, scale: number) {
    const maxR = Math.min(w, h) * 0.18 * scale;
    const nodes: { x: number; y: number; ring: number; positive: boolean; ox: number; oy: number }[] = [];

    for (let k = 1; k <= 8; k++) {
      const r = maxR * Math.pow(k / 8, 0.72);
      const offset = k * 0.39;
      let count = 0;
      for (let s = 1; s < 256; s++) {
        if (popcount(s) !== k) continue;
        const angle = (count / BINOM8[k]) * Math.PI * 2 - Math.PI / 2 + offset;
        // ox/oy are offsets from center, so we can reposition the lattice
        const ox = Math.cos(angle) * r;
        const oy = Math.sin(angle) * r;
        nodes.push({
          x: cx + ox, y: cy + oy,
          ring: k,
          positive: k % 2 === 1,
          ox, oy,
        });
        count++;
      }
    }
    return nodes;
  }

  // edges between adjacent-cardinality subsets (shared logic with act 3)
  function buildMiniEdges(nodes: { ring: number; ox: number; oy: number }[]) {
    const edges: [number, number][] = [];
    const ringStart: number[] = [];
    let prevRing = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].ring !== prevRing) {
        ringStart.push(i);
        prevRing = nodes[i].ring;
      }
    }
    ringStart.push(nodes.length);

    for (let ri = 0; ri < ringStart.length - 2; ri++) {
      const lo = ringStart[ri];
      const loEnd = ringStart[ri + 1];
      const hi = ringStart[ri + 1];
      const hiEnd = ringStart[ri + 2];
      const edgeCount = new Map<number, number>();

      for (let i = lo; i < loEnd; i++) {
        for (let j = hi; j < hiEnd; j++) {
          const ci = edgeCount.get(i) || 0;
          const cj = edgeCount.get(j) || 0;
          if (ci < 1 && cj < 2) {
            edges.push([i, j]);
            edgeCount.set(i, ci + 1);
            edgeCount.set(j, cj + 1);
          }
        }
      }
    }
    return edges;
  }

  const cx = () => w / 2;
  const cy = () => h * 0.44;

  let leftNodes = buildMiniLattice(cx(), cy(), 1);
  let rightNodes = buildMiniLattice(cx(), cy(), 1);
  let leftEdges = buildMiniEdges(leftNodes);
  let rightEdges = buildMiniEdges(rightNodes);

  // Möbius ring: 24 dots orbiting in a tilted ellipse
  const RING_N = 24;
  const RING_R = () => Math.min(w, h) * 0.22;

  let displayedCount = 0;

  function draw() {
    ctx.clearRect(0, 0, w, h);
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();

    const cxv = cx();
    const cyv = cy();

    // approach: lattices slide in from sides (p 0–0.4)
    const approach = Math.min(1, p * 2.5);
    // collision at p ≈ 0.4
    const collisionT = Math.max(0, Math.min(1, (p - 0.35) / 0.1));
    // post-collision merge (p 0.45–0.65)
    const mergeT = Math.max(0, Math.min(1, (p - 0.45) / 0.2));
    // post-merge rotation (p 0.5+)
    const postT = Math.max(0, (p - 0.5) * 2);

    // separation distance
    const sepX = (1 - approach) * Math.min(w * 0.22, 160);
    // post-collision: rotation angle for the merged structure
    const rotAngle = postT * 0.8 + (REDUCED ? 0 : time * 0.0002);
    // pointer parallax
    const px = ptrX * 15;
    const py = ptrY * 15;

    // scale up slightly after merge (two halves → one bigger structure)
    const mergeScale = 1 + mergeT * 0.3;

    // ── draw lattice function ────────────────────────────
    // hoists trig + color computation out of per-element loops
    function drawLattice(
      nodes: typeof leftNodes,
      edges: [number, number][],
      offsetX: number,
      globalAlpha: number,
      rotation: number,
      scale: number,
    ) {
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);
      const sinR03 = sinR * 0.3;
      const baseX = cxv + offsetX + px;
      const baseY = cyv + py;

      // batch all edges into one path (same style)
      if (edges.length > 0) {
        const edgeAlpha = globalAlpha * 0.08;
        ctx.beginPath();
        for (let ei = 0; ei < edges.length; ei++) {
          const a = nodes[edges[ei][0]];
          const b = nodes[edges[ei][1]];
          ctx.moveTo(
            baseX + (a.ox * cosR - a.oy * sinR03) * scale,
            baseY + (a.ox * sinR + a.oy * cosR) * scale,
          );
          ctx.lineTo(
            baseX + (b.ox * cosR - b.oy * sinR03) * scale,
            baseY + (b.ox * sinR + b.oy * cosR) * scale,
          );
        }
        ctx.strokeStyle = `rgba(0,255,255,${edgeAlpha})`;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }

      // batch nodes by color (positive vs negative) — two paths instead of 255
      const posAlpha = globalAlpha * 0.55;
      const negAlpha = globalAlpha * 0.4;

      ctx.fillStyle = `rgba(0,255,255,${posAlpha})`;
      ctx.beginPath();
      for (let ni = 0; ni < nodes.length; ni++) {
        const nd = nodes[ni];
        if (!nd.positive) continue;
        const nx = baseX + (nd.ox * cosR - nd.oy * sinR03) * scale;
        const ny = baseY + (nd.ox * sinR + nd.oy * cosR) * scale;
        const size = (nd.ring === 1 ? 2.2 : nd.ring === 8 ? 2.5 : 1.5) * scale;
        ctx.moveTo(nx + size, ny);
        ctx.arc(nx, ny, size, 0, Math.PI * 2);
      }
      ctx.fill();

      ctx.fillStyle = `rgba(120,180,255,${negAlpha})`;
      ctx.beginPath();
      for (let ni = 0; ni < nodes.length; ni++) {
        const nd = nodes[ni];
        if (nd.positive) continue;
        const nx = baseX + (nd.ox * cosR - nd.oy * sinR03) * scale;
        const ny = baseY + (nd.ox * sinR + nd.oy * cosR) * scale;
        const size = (nd.ring === 1 ? 2.2 : nd.ring === 8 ? 2.5 : 1.5) * scale;
        ctx.moveTo(nx + size, ny);
        ctx.arc(nx, ny, size, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // ── pre-collision: two separate lattices approaching ──
    if (mergeT < 1) {
      const preAlpha = 1 - mergeT;

      // left lattice
      drawLattice(
        leftNodes, leftEdges,
        -sepX,
        preAlpha,
        (1 - approach) * -0.3 + rotAngle * (mergeT > 0 ? 1 : 0),
        1,
      );

      // right lattice (slightly rotated offset)
      drawLattice(
        rightNodes, rightEdges,
        sepX,
        preAlpha,
        (1 - approach) * 0.3 + rotAngle * (mergeT > 0 ? 1 : 0) + 0.4,
        1,
      );
    }

    // ── post-collision: merged lattice ───────────────────
    if (mergeT > 0) {
      // draw both lattice sets at center, merged, scaled up
      const mAlpha = mergeT;

      drawLattice(
        leftNodes, leftEdges,
        0, mAlpha, rotAngle, mergeScale,
      );
      drawLattice(
        rightNodes, rightEdges,
        0, mAlpha, rotAngle + 0.4, mergeScale,
      );

      // ── Möbius ring — orbiting witness dots ────────────
      if (mergeT > 0.3) {
        const ringAlpha = Math.min(1, (mergeT - 0.3) / 0.3);
        const ringR = RING_R() * mergeScale;
        const orbitAngle = REDUCED ? 0 : time * 0.0006;
        const tiltX = 0.35; // ellipse tilt

        for (let i = 0; i < RING_N; i++) {
          const a = (i / RING_N) * Math.PI * 2 + orbitAngle;
          const rx = cxv + Math.cos(a) * ringR + px;
          // tilted ellipse: y component compressed + phase-shifted
          const ry = cyv + Math.sin(a) * ringR * tiltX * Math.cos(orbitAngle * 0.3)
            + Math.cos(a) * ringR * 0.15 * Math.sin(orbitAngle * 0.5) + py;

          // depth-based alpha: dots "behind" are dimmer
          const depth = Math.sin(a);
          const dotAlpha = ringAlpha * (0.25 + 0.35 * (depth * 0.5 + 0.5));

          ctx.beginPath();
          ctx.arc(rx, ry, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,255,255,${dotAlpha})`;
          ctx.fill();
        }
      }
    }

    // ── shockwave ────────────────────────────────────────
    // two expanding rings at collision point
    if (collisionT > 0 && collisionT < 1) {
      const shockAlpha = (1 - collisionT) * 0.5;

      for (let ring = 0; ring < 2; ring++) {
        const delay = ring * 0.2;
        const rt = Math.max(0, (collisionT - delay) / (1 - delay));
        if (rt <= 0) continue;

        const radius = rt * Math.min(w, h) * (ring === 0 ? 0.35 : 0.45);
        const a = (1 - rt) * (ring === 0 ? shockAlpha : shockAlpha * 0.4);

        ctx.beginPath();
        ctx.arc(cxv + px, cyv + py, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,255,255,${a})`;
        ctx.lineWidth = ring === 0 ? 1.5 : 0.5;
        ctx.stroke();
      }
    }

    // ── center glow (post-collision) ─────────────────────
    if (collisionT > 0) {
      const glowA = Math.min(0.12, collisionT * 0.15) * (1 - Math.max(0, p - 0.8) * 5);
      if (glowA > 0.005) {
        const gr = Math.min(w, h) * 0.08 * mergeScale;
        const gg = ctx.createRadialGradient(cxv + px, cyv + py, 0, cxv + px, cyv + py, gr);
        gg.addColorStop(0, `rgba(0,255,255,${glowA})`);
        gg.addColorStop(1, "rgba(0,255,255,0)");
        ctx.beginPath();
        ctx.arc(cxv + px, cyv + py, gr, 0, Math.PI * 2);
        ctx.fillStyle = gg;
        ctx.fill();
      }
    }

    // ── neighbor counter ─────────────────────────────────
    if (counterEl) {
      const t = Math.max(0, Math.min(1, (p - 0.08) / 0.35));
      const target = Math.round(t * t * 65535);
      displayedCount += (target - displayedCount) * 0.15;
      counterEl.textContent = Math.round(displayedCount).toLocaleString();
    }

    requestAnimationFrame(draw);
  }

  onResize(() => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    leftNodes = buildMiniLattice(cx(), cy(), 1);
    rightNodes = buildMiniLattice(cx(), cy(), 1);
    leftEdges = buildMiniEdges(leftNodes);
    rightEdges = buildMiniEdges(rightNodes);
  });

  requestAnimationFrame(draw);
}

// ── act 5: engram — crystallization particle system ──────────────
// particles transition from brownian gas (hot) to hexagonal lattice
// (cold). sigmoid phase transition at p≈0.45. cubic blend ensures
// zero jitter at full crystallization.

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number; // crystal lattice target x
  ty: number; // crystal lattice target y
  hue: number;
  phase: number;
}

function createParticles(w: number, h: number, n: number): Particle[] {
  const particles: Particle[] = [];
  const cols = Math.ceil(Math.sqrt((n * w) / h));
  const rows = Math.ceil(n / cols);
  const sx = w / (cols + 1);
  const sy = h / (rows + 1);

  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const hexOff = row % 2 === 1 ? sx * 0.5 : 0;

    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 3,
      vy: (Math.random() - 0.5) * 3,
      tx: sx * (col + 1) + hexOff,
      ty: sy * (row + 1),
      hue: (i / n) * 50 + 5,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return particles;
}

function initParticles(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".particle-canvas");
  if (!canvas) return;
  const pin = act.querySelector<HTMLElement>(".pin")!;

  let { ctx, w, h } = fitCanvas(canvas, pin);
  let particles = createParticles(w, h, PARTICLE_N);
  const { isVisible } = observeVisibility(act);
  const tempFill = act.querySelector<HTMLElement>(".temp-fill");

  function draw() {
    ctx.clearRect(0, 0, w, h);
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();

    // sigmoid phase transition around p=0.45
    const crystal = 1 / (1 + Math.exp(-12 * (p - 0.45)));

    if (tempFill) tempFill.style.height = `${(1 - crystal) * 100}%`;

    // lattice bonds — batch into single path
    if (crystal > 0.3) {
      const bondThresh = 80 * (1 - crystal * 0.5);
      const bondThresh2 = bondThresh * bondThresh;
      ctx.strokeStyle = `rgba(0,255,255,${(crystal - 0.3) * 0.12})`;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        const jEnd = Math.min(i + 8, particles.length);
        for (let j = i + 1; j < jEnd; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy < bondThresh2) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
        }
      }
      ctx.stroke();
    }

    const gas = 1 - crystal;
    const pull = crystal * crystal * crystal;
    const gasRand2 = gas * 2;

    // precompute pointer position once (not per particle)
    const doRepulse = !IS_COARSE && gas > 0.01;
    const mx = doRepulse ? (ptrX + 0.5) * w : 0;
    const my = doRepulse ? (ptrY + 0.5) * h : 0;
    const gas40 = gas * 40;

    // update physics for all particles
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      pt.vx = (pt.vx + (Math.random() - 0.5) * gasRand2) * 0.92;
      pt.vy = (pt.vy + (Math.random() - 0.5) * gasRand2) * 0.92;

      if (doRepulse) {
        const dx = pt.x - mx;
        const dy = pt.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < 10000 && d2 > 1) {
          const inv = gas40 / d2;
          pt.vx += dx * inv;
          pt.vy += dy * inv;
        }
      }

      pt.x += pt.vx;
      pt.y += pt.vy;

      if (pt.x < 0) { pt.x = 0; pt.vx = Math.abs(pt.vx) * 0.6; }
      if (pt.x > w) { pt.x = w; pt.vx = -Math.abs(pt.vx) * 0.6; }
      if (pt.y < 0) { pt.y = 0; pt.vy = Math.abs(pt.vy) * 0.6; }
      if (pt.y > h) { pt.y = h; pt.vy = -Math.abs(pt.vy) * 0.6; }

      pt.x += (pt.tx - pt.x) * pull;
      pt.y += (pt.ty - pt.y) * pull;
    }

    // render particles — shared alpha, vary hue per particle.
    // unfortunately hsla changes per particle so we can't fully batch,
    // but we avoid beginPath/fill overhead with moveTo trick.
    const particleAlpha = 0.5 + crystal * 0.4;
    const timeDiv700 = time / 700;
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      const hue = pt.hue * gas + 180 * crystal;
      const osc = REDUCED ? 0 : Math.sin(timeDiv700 + pt.phase) * gas;
      const size = 2.2 + osc * 0.8;

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue | 0},100%,60%,${particleAlpha})`;
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  onResize(() => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    particles = createParticles(w, h, PARTICLE_N);
  });

  requestAnimationFrame(draw);
}

// ── act 6: the loop — ratchet tower ─────────────────────────────
// messages fall through a vertical tower of codec layers.
// each layer transforms the particle: logos compresses, loup
// predicts (8-dot constellation burst), kizuna seals (ring).
// completed messages advance a ratchet dial and send a return
// arc sweeping back to the top — the loop closing.

interface RatchetDrop {
  y: number;
  wobblePhase: number;
  speed: number;
  radius: number;
  birth: number;
  passedLogos: boolean;
  passedLoup: boolean;
  passedKizuna: boolean;
  loupBurstT: number;
  sealT: number;
  sealAngle: number;
}

interface LoupBurst {
  cx: number;
  cy: number;
  angle: number;
  birth: number;
}

interface BottomRipple {
  x: number;
  y: number;
  birth: number;
}

interface ReturnArc {
  birth: number;
  side: number; // -1 left, +1 right
}

function initRatchet(act: HTMLElement) {
  const canvas = act.querySelector<HTMLCanvasElement>(".ratchet-canvas");
  if (!canvas) return;
  const pin = act.querySelector<HTMLElement>(".pin")!;

  let { ctx, w, h } = fitCanvas(canvas, pin);
  const { isVisible } = observeVisibility(act);

  // tower geometry
  function computeTower() {
    const cx = w / 2;
    const towerH = h * 0.54;
    const top = h * 0.16;
    const bot = top + towerH;
    const memW = Math.min(w * 0.3, 180);
    const rY = top - h * 0.08;
    const rR = Math.min(22, w * 0.04);
    return {
      cx, top, bot, towerH, memW,
      membranes: [
        { y: top + towerH * 0.25, label: "logos" },
        { y: top + towerH * 0.50, label: "loup" },
        { y: top + towerH * 0.75, label: "kizuna" },
      ],
      ratchetY: rY,
      ratchetR: rR,
    };
  }

  let T = computeTower();

  // state
  const drops: RatchetDrop[] = [];
  const bursts: LoupBurst[] = [];
  const ripples: BottomRipple[] = [];
  const arcs: ReturnArc[] = [];
  let ratchetAngle = 0;
  let ratchetTarget = 0;
  let ratchetCount = 0;
  let lastSpawn = 0;
  const memFlash = [0, 0, 0];
  let arcSide = 1;

  function spawnDrop(time: number) {
    drops.push({
      y: T.top - 8,
      wobblePhase: Math.random() * Math.PI * 2,
      speed: h * 0.00028 + Math.random() * h * 0.00008,
      radius: 3.5,
      birth: time,
      passedLogos: false,
      passedLoup: false,
      passedKizuna: false,
      loupBurstT: -1,
      sealT: -1,
      sealAngle: Math.random() * Math.PI * 2,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();

    if (p < 0.02) { requestAnimationFrame(draw); return; }

    const fadeIn = Math.min(1, (p - 0.02) * 6);

    // ── tower beam ──────────────────────────────────────────
    // wide ambient glow
    const glowW = 50;
    const ambGrad = ctx.createLinearGradient(T.cx, T.top - 20, T.cx, T.bot + 20);
    ambGrad.addColorStop(0, "rgba(0,255,255,0)");
    ambGrad.addColorStop(0.08, `rgba(0,255,255,${fadeIn * 0.02})`);
    ambGrad.addColorStop(0.92, `rgba(0,255,255,${fadeIn * 0.02})`);
    ambGrad.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = ambGrad;
    ctx.fillRect(T.cx - glowW, T.top - 20, glowW * 2, T.towerH + 40);

    // narrow core beam
    const coreGrad = ctx.createLinearGradient(T.cx, T.top, T.cx, T.bot);
    coreGrad.addColorStop(0, "rgba(0,255,255,0)");
    coreGrad.addColorStop(0.06, `rgba(0,255,255,${fadeIn * 0.07})`);
    coreGrad.addColorStop(0.94, `rgba(0,255,255,${fadeIn * 0.07})`);
    coreGrad.addColorStop(1, "rgba(0,255,255,0)");
    ctx.fillStyle = coreGrad;
    ctx.fillRect(T.cx - 1, T.top, 2, T.towerH);

    // ── membranes ───────────────────────────────────────────
    for (let mi = 0; mi < 3; mi++) {
      const m = T.membranes[mi];
      const flashAge = time - memFlash[mi];
      const flash = flashAge < 500 ? Math.pow(1 - flashAge / 500, 2) * 0.55 : 0;
      const alpha = (0.1 + flash) * fadeIn;

      // main line
      ctx.beginPath();
      ctx.moveTo(T.cx - T.memW / 2, m.y);
      ctx.lineTo(T.cx + T.memW / 2, m.y);
      ctx.strokeStyle = `rgba(0,255,255,${alpha})`;
      ctx.lineWidth = 0.8 + flash * 2;
      ctx.stroke();

      // glow halo along line during flash
      if (flash > 0.05) {
        ctx.beginPath();
        ctx.moveTo(T.cx - T.memW / 2, m.y);
        ctx.lineTo(T.cx + T.memW / 2, m.y);
        ctx.strokeStyle = `rgba(0,255,255,${flash * 0.15})`;
        ctx.lineWidth = 8;
        ctx.stroke();
      }

      // label (right side)
      if (fadeIn > 0.4) {
        const fontSize = Math.max(9, Math.min(11, w * 0.013));
        ctx.font = `${fontSize}px "Cascadia Code","Fira Code",monospace`;
        ctx.textAlign = "left";
        ctx.fillStyle = `rgba(0,255,255,${alpha * 0.45})`;
        ctx.fillText(m.label, T.cx + T.memW / 2 + 10, m.y + 3.5);
      }
    }

    // ── spawn drops ─────────────────────────────────────────
    if (p > 0.08 && fadeIn > 0.5) {
      const interval = 3000 - p * 2400; // 3s → 0.6s
      if (time - lastSpawn > Math.max(interval, 500) && drops.length < 10) {
        spawnDrop(time);
        lastSpawn = time;
      }
    }

    // ── update & draw drops ─────────────────────────────────
    for (let di = drops.length - 1; di >= 0; di--) {
      const d = drops[di];
      d.y += d.speed * 16;

      const wobbleX = Math.sin((time - d.birth) * 0.0018 + d.wobblePhase) * 4;
      const dx = T.cx + wobbleX;
      const age = time - d.birth;
      const dAlpha = Math.min(1, age / 400);

      // logos crossing — compression
      if (!d.passedLogos && d.y >= T.membranes[0].y) {
        d.passedLogos = true;
        d.radius = 2.0;
        memFlash[0] = time;
      }

      // loup crossing — constellation burst
      if (!d.passedLoup && d.y >= T.membranes[1].y) {
        d.passedLoup = true;
        d.loupBurstT = time;
        memFlash[1] = time;
        for (let bi = 0; bi < 8; bi++) {
          bursts.push({
            cx: dx, cy: d.y,
            angle: (bi / 8) * Math.PI * 2 - Math.PI / 2,
            birth: time,
          });
        }
      }

      // kizuna crossing — seal
      if (!d.passedKizuna && d.y >= T.membranes[2].y) {
        d.passedKizuna = true;
        d.sealT = time;
        memFlash[2] = time;
      }

      // completed — ripple, ratchet, return arc
      if (d.y > T.bot + 15) {
        ripples.push({ x: dx, y: T.bot + 15, birth: time });
        ratchetTarget += Math.PI / 6;
        ratchetCount++;
        arcSide *= -1;
        arcs.push({ birth: time, side: arcSide });
        drops.splice(di, 1);
        continue;
      }

      // ── draw the drop ──

      // trail — faint upward streak
      const trailLen = d.speed * 140;
      const trailGrad = ctx.createLinearGradient(dx, d.y, dx, d.y - trailLen);
      trailGrad.addColorStop(0, `rgba(0,255,255,${dAlpha * 0.18})`);
      trailGrad.addColorStop(1, "rgba(0,255,255,0)");
      ctx.beginPath();
      ctx.moveTo(dx - 0.6, d.y);
      ctx.lineTo(dx + 0.6, d.y);
      ctx.lineTo(dx + 0.3, d.y - trailLen);
      ctx.lineTo(dx - 0.3, d.y - trailLen);
      ctx.closePath();
      ctx.fillStyle = trailGrad;
      ctx.fill();

      // outer glow
      const glowR = d.radius * 5;
      const dg = ctx.createRadialGradient(dx, d.y, 0, dx, d.y, glowR);
      dg.addColorStop(0, `rgba(0,255,255,${dAlpha * 0.12})`);
      dg.addColorStop(0.4, `rgba(0,255,255,${dAlpha * 0.04})`);
      dg.addColorStop(1, "rgba(0,255,255,0)");
      ctx.beginPath();
      ctx.arc(dx, d.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = dg;
      ctx.fill();

      // core
      ctx.beginPath();
      ctx.arc(dx, d.y, d.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,255,255,${dAlpha * 0.9})`;
      ctx.fill();

      // bloom ring on core
      ctx.beginPath();
      ctx.arc(dx, d.y, d.radius + 1, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,255,255,${dAlpha * 0.2})`;
      ctx.lineWidth = 0.75;
      ctx.stroke();

      // kizuna seal ring — contracts then orbits
      if (d.passedKizuna && d.sealT > 0) {
        const sAge = time - d.sealT;
        const contractT = Math.min(1, sAge / 350);
        const sealR = 14 * (1 - contractT) + 5 * contractT;
        d.sealAngle += 0.035;

        // full ring while contracting, 3/4 arc after
        const arcLen = contractT < 1 ? Math.PI * 2 : Math.PI * 1.6;
        ctx.beginPath();
        ctx.arc(dx, d.y, sealR, d.sealAngle, d.sealAngle + arcLen);
        ctx.strokeStyle = `rgba(0,255,255,${dAlpha * 0.45})`;
        ctx.lineWidth = contractT < 1 ? 1 + (1 - contractT) * 1.5 : 1;
        ctx.stroke();

        // second ghost ring, slightly larger, rotating opposite
        if (contractT >= 1) {
          ctx.beginPath();
          ctx.arc(dx, d.y, sealR + 3, -d.sealAngle * 0.7, -d.sealAngle * 0.7 + Math.PI * 0.8);
          ctx.strokeStyle = `rgba(0,255,255,${dAlpha * 0.12})`;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }

      // loup burst afterglow — brief ring expansion at crossing point
      if (d.loupBurstT > 0) {
        const bAge = time - d.loupBurstT;
        if (bAge < 400) {
          const bT = bAge / 400;
          const bR = 6 + bT * 18;
          ctx.beginPath();
          ctx.arc(dx, T.membranes[1].y, bR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(0,255,255,${(1 - bT) * 0.15})`;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }
    }

    // ── loup burst particles ────────────────────────────────
    // 8 dots expanding outward — callback to the lattice singletons
    for (let bi = bursts.length - 1; bi >= 0; bi--) {
      const b = bursts[bi];
      const bAge = time - b.birth;
      if (bAge > 700) { bursts.splice(bi, 1); continue; }

      const t = bAge / 700;
      const easeT = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const r = 5 + easeT * 28;
      const alpha = (1 - t * t) * 0.7;
      const bx = b.cx + Math.cos(b.angle) * r;
      const by = b.cy + Math.sin(b.angle) * r;

      // alternating colors: odd/even index matches lattice +/− signs
      const idx = Math.round((b.angle + Math.PI / 2) / (Math.PI / 4));
      const isPositive = idx % 2 === 0;

      // dot
      ctx.beginPath();
      ctx.arc(bx, by, 1.3, 0, Math.PI * 2);
      ctx.fillStyle = isPositive
        ? `rgba(0,255,255,${alpha})`
        : `rgba(120,180,255,${alpha})`;
      ctx.fill();

      // tiny connecting line back to center
      if (alpha > 0.15) {
        ctx.beginPath();
        ctx.moveTo(b.cx, b.cy);
        ctx.lineTo(bx, by);
        ctx.strokeStyle = isPositive
          ? `rgba(0,255,255,${alpha * 0.08})`
          : `rgba(120,180,255,${alpha * 0.06})`;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    }

    // ── return arcs ─────────────────────────────────────────
    // after a message completes, a faint arc sweeps from bottom
    // back to top on one side — the loop closing, key resetting
    for (let ai = arcs.length - 1; ai >= 0; ai--) {
      const a = arcs[ai];
      const aAge = time - a.birth;
      if (aAge > 1200) { arcs.splice(ai, 1); continue; }

      const t = aAge / 1200;
      const easeT = 1 - Math.pow(1 - t, 2);

      // arc runs from bottom to top on one side of the tower
      const arcOffset = T.memW * 0.35 * a.side;
      const arcTop = T.top;
      const arcBot = T.bot + 10;
      const arcH = arcBot - arcTop;

      // the sweep: a short bright segment climbing the arc
      const headY = arcBot - easeT * arcH;
      const tailY = Math.min(arcBot, headY + arcH * 0.25);

      // curved path (quadratic bezier approximated as segments)
      const steps = 20;
      const startStep = Math.max(0, Math.floor((1 - tailY / arcBot) * steps));
      const endStep = Math.min(steps, Math.ceil((1 - headY / arcBot + 0.02) * steps));

      if (endStep > startStep) {
        ctx.beginPath();
        for (let si = startStep; si <= endStep; si++) {
          const st = si / steps;
          const sy = arcBot - st * arcH;
          // horizontal curve: peaks at midpoint, zero at endpoints
          const curve = Math.sin(st * Math.PI) * arcOffset;
          const sx = T.cx + curve;
          if (si === startStep) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }

        const arcAlpha = (1 - t) * 0.25;
        ctx.strokeStyle = `rgba(0,255,255,${arcAlpha})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // bright head dot
        const headCurve = Math.sin((1 - headY / arcBot) * Math.PI) * arcOffset;
        if (t < 0.85) {
          ctx.beginPath();
          ctx.arc(T.cx + headCurve, headY, 1.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,255,255,${(1 - t) * 0.5})`;
          ctx.fill();
        }
      }
    }

    // ── ripples at ratchet ──────────────────────────────────
    for (let ri = ripples.length - 1; ri >= 0; ri--) {
      const rp = ripples[ri];
      const rAge = time - rp.birth;
      if (rAge > 1500) { ripples.splice(ri, 1); continue; }

      const t = rAge / 1500;
      const easeT = 1 - Math.pow(1 - t, 2);

      // two expanding rings
      for (let ring = 0; ring < 2; ring++) {
        const delay = ring * 0.15;
        const rt = Math.max(0, t - delay) / (1 - delay);
        if (rt <= 0) continue;
        const radius = 4 + rt * 40;
        const alpha = (1 - rt) * (ring === 0 ? 0.2 : 0.08);
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,255,255,${alpha})`;
        ctx.lineWidth = ring === 0 ? 0.75 : 0.75;
        ctx.stroke();
      }
    }

    // ── ratchet dial (gold, top of tower) ──────────────────
    if (fadeIn > 0.3) {
      const rAlpha = fadeIn * 0.75;

      // smooth rotation toward target
      ratchetAngle += (ratchetTarget - ratchetAngle) * 0.06;

      const rR = T.ratchetR;
      const rX = T.cx;
      const rY = T.ratchetY;

      // glow halo behind the dial
      const rGlow = rR * 2.5;
      const rg = ctx.createRadialGradient(rX, rY, rR * 0.5, rX, rY, rGlow);
      rg.addColorStop(0, `rgba(212,175,55,${rAlpha * 0.06})`);
      rg.addColorStop(1, "rgba(212,175,55,0)");
      ctx.beginPath();
      ctx.arc(rX, rY, rGlow, 0, Math.PI * 2);
      ctx.fillStyle = rg;
      ctx.fill();

      // outer ring
      ctx.beginPath();
      ctx.arc(rX, rY, rR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(212,175,55,${rAlpha * 0.7})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 12 tick marks (rotate with ratchet)
      for (let ti = 0; ti < 12; ti++) {
        const ta = (ti / 12) * Math.PI * 2 + ratchetAngle;
        const inner = rR - 4;
        const outer = rR - 0.5;

        ctx.beginPath();
        ctx.moveTo(rX + Math.cos(ta) * inner, rY + Math.sin(ta) * inner);
        ctx.lineTo(rX + Math.cos(ta) * outer, rY + Math.sin(ta) * outer);
        ctx.strokeStyle = `rgba(255,210,80,${rAlpha * 0.9})`;
        ctx.lineWidth = ti % 3 === 0 ? 1.5 : 0.75;
        ctx.stroke();
      }

      // center dot
      ctx.beginPath();
      ctx.arc(rX, rY, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,210,80,${rAlpha * 0.85})`;
      ctx.fill();

      // fixed indicator notch below (pointing down toward tower)
      ctx.beginPath();
      ctx.moveTo(rX, rY + rR + 3);
      ctx.lineTo(rX - 2.5, rY + rR + 8);
      ctx.lineTo(rX + 2.5, rY + rR + 8);
      ctx.closePath();
      ctx.fillStyle = `rgba(255,210,80,${rAlpha * 0.95})`;
      ctx.fill();

      // ratchet count (above the dial)
      if (ratchetCount > 0) {
        const fontSize = Math.max(9, Math.min(11, w * 0.014));
        ctx.font = `${fontSize}px "Cascadia Code","Fira Code",monospace`;
        ctx.textAlign = "center";
        ctx.fillStyle = `rgba(255,210,80,${rAlpha * 0.7})`;
        ctx.fillText(`${ratchetCount}`, rX, rY - rR - 8);
      }
    }

    requestAnimationFrame(draw);
  }

  onResize(() => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    T = computeTower();
  });

  requestAnimationFrame(draw);
}

// ── coda: the apple ──────────────────────────────────────────────
// click to crack open the red dot — reveals the ECDH handshake.
// auto-seals after 6 seconds.

function initCoda(act: HTMLElement) {
  const apple = act.querySelector<HTMLElement>(".apple");
  if (!apple) return;

  let open = false;
  let timer: ReturnType<typeof setTimeout>;

  apple.addEventListener("click", () => {
    open = !open;
    apple.classList.toggle("cracked", open);
    clearTimeout(timer);
    if (open) {
      timer = setTimeout(() => {
        open = false;
        apple.classList.remove("cracked");
      }, 6000);
    }
  });
}

// ── bootstrap ────────────────────────────────────────────────────

function init() {
  const main = document.getElementById("descent");
  if (!main) return;

  const acts = Array.from(main.querySelectorAll<HTMLElement>(".act"));

  // suppress right-click on canvases and visual elements
  main.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "CANVAS" || t.closest(".scene") || t.closest(".apple")) {
      e.preventDefault();
    }
  });

  // prevent drag on all images/canvases (no ghost drag artifacts)
  main.addEventListener("dragstart", (e) => e.preventDefault());

  initScrollEngine(main);
  if (!REDUCED) initPointer(main);

  if (acts[1]) initTree(acts[1]);      // logos
  if (acts[2]) initWaveform(acts[2]);   // harmonic → lumen
  if (acts[3]) initLattice(acts[3]);    // loup (8D)
  if (acts[4]) initKizuna(acts[4]);          // kizuna
  if (acts[5]) initParticles(acts[5]);  // engram crystallization
  if (acts[6]) initRatchet(acts[6]);    // the loop
  if (acts[7]) initCoda(acts[7]);       // the apple
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

document.addEventListener("astro:page-load", init);
