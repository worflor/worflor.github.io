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

function readProgress(el: HTMLElement): number {
  return parseFloat(el.style.getPropertyValue("--p") || "0");
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

// ── scroll progress engine ───────────────────────────────────────
// sets --p (0-1) on each .act based on how far it's scrolled,
// and --scroll-progress on the main container for the progress bar.

function initScrollEngine(main: HTMLElement) {
  const acts = Array.from(main.querySelectorAll<HTMLElement>(".act"));

  function tick() {
    const vh = window.innerHeight;
    let totalScrollable = 0;
    let totalScrolled = 0;

    for (const act of acts) {
      const rect = act.getBoundingClientRect();
      const scrollable = rect.height - vh;

      totalScrollable += Math.max(0, scrollable);
      totalScrolled += Math.max(0, Math.min(scrollable, -rect.top));

      if (scrollable <= 0) {
        act.style.setProperty("--p", rect.top <= 0 ? "1" : "0");
      } else {
        const p = Math.max(0, Math.min(1, -rect.top / scrollable));
        act.style.setProperty("--p", p.toFixed(5));
      }
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
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now();
    ctx.clearRect(0, 0, w, h);

    // connections (behind nodes)
    for (let i = 1; i < nodes.length; i++) {
      const nd = nodes[i];
      const reveal = Math.max(0, Math.min(1, (p - nd.revealAt) * 9));
      if (reveal <= 0) continue;

      const ex = nd.px + (nd.x - nd.px) * reveal;
      const ey = nd.py + (nd.y - nd.py) * reveal;
      const mx = (nd.px + ex) / 2;
      const my = (nd.py + ey) / 2;
      const cpx = mx + (nodes[0].x - mx) * 0.12;
      const cpy = my + (nodes[0].y - my) * 0.12;

      ctx.beginPath();
      ctx.moveTo(nd.px, nd.py);
      ctx.quadraticCurveTo(cpx, cpy, ex, ey);
      ctx.strokeStyle = `rgba(0,255,255,${reveal * 0.1})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // nodes
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const reveal = Math.max(0, Math.min(1, (p - nd.revealAt) * 9));
      if (reveal <= 0) continue;

      const breathe = i === 0 ? Math.sin(time / 800) * 0.3 + 0.8 : 1;
      const size = i === 0 ? 4 : Math.max(1.2, 2.8 - nd.level * 0.2);

      ctx.beginPath();
      ctx.arc(nd.x, nd.y, size * reveal * breathe, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,255,255,${reveal * (i === 0 ? 0.9 : 0.55)})`;
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

  window.addEventListener("resize", () => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    nodes = buildTree(w, h);
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
  window.addEventListener("resize", () => { ({ ctx, w, h } = fitCanvas(canvas, canvas)); });

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
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = REDUCED ? 0 : performance.now() / 1000;
    const revealX = w * Math.min(1, p * 2.2);

    ctx.clearRect(0, 0, w, h);
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
    ctx.strokeStyle = "rgba(0,255,255,0.04)";
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
    ctx.fillStyle = "rgba(0,255,255,0.025)";
    ctx.fill();

    // main stroke with bloom
    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const t = px / w;
      const y = cy - amp * sig(t, time);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.shadowBlur = 8;
    ctx.shadowColor = "rgba(0,255,255,0.3)";
    ctx.strokeStyle = "rgba(0,255,255,0.75)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
}

// ── act 4: kizuna — neighbor counter ─────────────────────────────
// races to 65,535 (2^16-1) with quadratic easing,
// reaching the peak right as the collision shockwave fires.

function initNeighborCounter(act: HTMLElement) {
  const el = act.querySelector<HTMLElement>(".counter-value");
  if (!el) return;

  let displayed = 0;
  const { isVisible } = observeVisibility(act);

  function tick() {
    if (!isVisible()) { requestAnimationFrame(tick); return; }

    const p = readProgress(act);
    const t = Math.max(0, Math.min(1, (p - 0.08) / 0.35));
    const target = Math.round(t * t * 65535);

    displayed += (target - displayed) * 0.15;
    el.textContent = Math.round(displayed).toLocaleString();
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
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
    if (!isVisible() && !REDUCED) { requestAnimationFrame(draw); return; }

    const p = readProgress(act);
    const time = performance.now();
    ctx.clearRect(0, 0, w, h);

    // sigmoid phase transition around p=0.45
    const crystal = 1 / (1 + Math.exp(-12 * (p - 0.45)));

    if (tempFill) tempFill.style.height = `${(1 - crystal) * 100}%`;

    // lattice bonds (visible during/after crystallization)
    if (crystal > 0.3) {
      ctx.strokeStyle = `rgba(0,255,255,${(crystal - 0.3) * 0.12})`;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < Math.min(i + 8, particles.length); j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy < (80 * (1 - crystal * 0.5)) ** 2) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }

    const gas = 1 - crystal;
    const pull = crystal * crystal * crystal; // cubic: zero jitter at crystal=1

    for (const pt of particles) {
      // gas: brownian + damping
      pt.vx += (Math.random() - 0.5) * gas * 2;
      pt.vy += (Math.random() - 0.5) * gas * 2;
      pt.vx *= 0.92;
      pt.vy *= 0.92;

      // pointer repulsion (desktop, gas phase)
      if (!IS_COARSE && gas > 0.01) {
        const mx = (ptrX + 0.5) * w;
        const my = (ptrY + 0.5) * h;
        const dx = pt.x - mx;
        const dy = pt.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < 10000 && d2 > 1) {
          pt.vx += dx * gas * 40 / d2;
          pt.vy += dy * gas * 40 / d2;
        }
      }

      pt.x += pt.vx;
      pt.y += pt.vy;

      // boundary bounce — particles are trapped inside the viewport
      if (pt.x < 0) { pt.x = 0; pt.vx = Math.abs(pt.vx) * 0.6; }
      if (pt.x > w) { pt.x = w; pt.vx = -Math.abs(pt.vx) * 0.6; }
      if (pt.y < 0) { pt.y = 0; pt.vy = Math.abs(pt.vy) * 0.6; }
      if (pt.y > h) { pt.y = h; pt.vy = -Math.abs(pt.vy) * 0.6; }

      // crystallization blend: at pull=1, position snaps exactly to target
      pt.x += (pt.tx - pt.x) * pull;
      pt.y += (pt.ty - pt.y) * pull;

      // render
      const hue = pt.hue * gas + 180 * crystal;
      const osc = REDUCED ? 0 : Math.sin(time / 700 + pt.phase) * gas;
      const size = 2.2 + osc * 0.8;

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},100%,60%,${0.5 + crystal * 0.4})`;
      ctx.fill();
    }

    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", () => {
    ({ ctx, w, h } = fitCanvas(canvas, pin));
    particles = createParticles(w, h, PARTICLE_N);
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
  if (acts[4]) initNeighborCounter(acts[4]); // kizuna
  if (acts[5]) initParticles(acts[5]);  // engram crystallization
  if (acts[7]) initCoda(acts[7]);       // the apple
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

document.addEventListener("astro:page-load", init);
