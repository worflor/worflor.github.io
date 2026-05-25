/**
 * action-bar-plasma.ts — WebGPU spectral plasma effect for the floating action bar.
 *
 * renders a living void surface: chromatic filaments (cyan/red) that drift, separate,
 * and recombine via domain-warped fbm noise with per-channel UV displacement.
 * scroll parallaxes the noise field. pointer proximity brightens and converges the
 * plasma. the bar breathes.
 *
 * if webgpu is unavailable, the canvas is hidden and the bar falls back to css-only
 * styling (backdrop-filter blur). zero degradation, just less magic.
 */

// ── WGSL shader source ───────────────────────────────────────────────────────

const SHADER = /* wgsl */ `
struct Uniforms {
  time: f32,
  scroll: f32,
  pointerX: f32,
  pointerY: f32,
  width: f32,
  height: f32,
  dpr: f32,
  reducedMotion: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

// hash + value noise
fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var pos = p;
  for (var i = 0; i < octaves; i++) {
    sum += amp * noise(pos);
    pos = pos * 2.03 + vec2f(1.7, 2.3);
    amp *= 0.5;
  }
  return sum;
}

fn border_dist(uv: vec2f) -> f32 {
  return min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
}

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  // full-screen triangle
  let x = f32(i32(vid) / 2) * 4.0 - 1.0;
  let y = f32(i32(vid) % 2) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

// the computational substrate. the mathematical space where the codecs live.
// not plasma, not glass. the spectral plane.

// smooth geodesic field: sine-based curves that compress toward edges
// like the Poincaré metric — evenly spaced at center, crowding at boundary.
fn geodesic(p: vec2f, t: f32, phase: f32) -> f32 {
  let center_d = length(p - vec2f(0.5));
  // metric compression: coordinates stretch near boundary
  let metric = 1.0 + center_d * center_d * 3.0;
  let flow = sin(p.x * 5.0 * metric + t * 0.02 + phase)
           * cos(p.y * 3.0 * metric + t * 0.015 + phase * 0.7);
  // the line itself: sharp band around the zero-crossing
  return smoothstep(0.03, 0.0, abs(flow) - 0.46);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = vec2f(u.width * u.dpr, u.height * u.dpr);
  let raw_uv = pos.xy / res;
  let t = select(u.time, 0.0, u.reducedMotion > 0.5);
  let aspect = u.width / max(u.height, 1.0);
  let uv = vec2f(raw_uv.x * aspect, raw_uv.y);
  let center = vec2f(0.5 * aspect, 0.5);

  // ── the depth ──────────────────────────────────────────────
  // center of the bar is the deepest void — the infinite interior
  // of the mathematical space. edges are the boundary where the
  // geometry meets reality.
  let center_d = length(raw_uv - vec2f(0.5)) * 2.0;
  let depth = 1.0 - smoothstep(0.0, 1.0, center_d);
  // near-black. the center is darkest. edges slightly less dark.
  var color = vec3f(0.006, 0.008, 0.014) + (1.0 - depth) * vec3f(0.01, 0.012, 0.02);
  var alpha = 0.8;

  // ── fog substrate ──────────────────────────────────────────
  // barely perceptible. just enough to know the space is alive.
  let fog = fbm(raw_uv * 2.0 + u.scroll * 0.3 + t * 0.002, 4);
  color += fog * vec3f(0.01, 0.013, 0.022) * depth;

  // ── geodesic flow ──────────────────────────────────────────
  // smooth geometric curves that compress at edges.
  // two families at different angles, slowly drifting.
  let geo1 = geodesic(raw_uv, t, 0.0);
  let geo2 = geodesic(raw_uv, t, 2.1);

  // geodesics are barely visible at center, more visible where they compress at edges.
  let geo_vis = 0.015 + (1.0 - depth) * 0.04;
  // primary geodesics: faint blue-white
  color += geo1 * vec3f(0.04, 0.06, 0.09) * geo_vis;
  // secondary geodesics: faint warm, crossing the primary at an angle
  color += geo2 * vec3f(0.06, 0.04, 0.03) * geo_vis * 0.6;

  // ── chromatic boundary ─────────────────────────────────────
  // where the mathematical space meets the real UI, light fractures.
  // this is the primary visual element. cyan and red separate at the edge
  // and slowly rotate around the perimeter.
  let bd = border_dist(raw_uv);
  let edge = smoothstep(0.0, 0.18, bd);
  let edge_s = 1.0 - edge;

  // the chromatic split rotates slowly around the bar's perimeter
  let angle = atan2(raw_uv.y - 0.5, (raw_uv.x - 0.5) * aspect);
  let phase = angle + t * 0.04;
  let cyan_w = 0.5 + 0.5 * sin(phase);
  let red_w = 0.5 + 0.5 * sin(phase + 3.14159);

  color += edge_s * vec3f(red_w * 0.1, 0.01, cyan_w * 0.12);

  // boundary line: the thinnest possible bright edge. the event horizon.
  let horizon = smoothstep(0.0, 0.003, bd) * (1.0 - smoothstep(0.003, 0.012, bd));
  color += horizon * vec3f(0.06 + red_w * 0.04, 0.08, 0.1 + cyan_w * 0.05);

  // ── cursor: geodesic convergence ───────────────────────────
  // hovering doesn't glow. it bends the geodesics. the space acknowledges intent
  // by subtly brightening and the edge fringe intensifying near the pointer.
  if (u.pointerX >= 0.0) {
    let pd = distance(raw_uv, vec2f(u.pointerX, u.pointerY));
    let gravity = exp(-pd * pd * 10.0);
    // the void subtly brightens: it knows you're there
    color += gravity * vec3f(0.0, 0.025, 0.03);
    // edge fringe intensifies near cursor
    color += gravity * edge_s * vec3f(0.02, 0.01, 0.04);
    // geodesics brighten near cursor: the geometry focuses
    color += gravity * (geo1 + geo2) * vec3f(0.03, 0.04, 0.06) * 0.3;
  }

  // ── breathing ──────────────────────────────────────────────
  // the space has a pulse. very slow. the metric tensor oscillates.
  let breath = 0.95 + 0.05 * sin(t * 0.25);
  alpha *= edge * breath;

  return vec4f(color * alpha, alpha);
}
`;

// ── initialization ─────────────────────────────────────────────────────────

interface PlasmaInstance {
  canvas: HTMLCanvasElement;
  ctx: GPUCanvasContext;
  uniformBuf: GPUBuffer;
  uniformData: Float32Array;
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  bar: HTMLElement;
}

let device: GPUDevice | null = null;
let instances: PlasmaInstance[] = [];
let rafId = 0;
let startTime = 0;
let hoveredBar: HTMLElement | null = null;
let pointerBarX = -1;
let pointerBarY = -1;
let alive = false;
// teardown list: every listener/observer gets pushed here so we can clean up fully
let teardowns: (() => void)[] = [];

async function getDevice(): Promise<GPUDevice | null> {
  if (device) return device;
  if (!navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) return null;
    device = await adapter.requestDevice();
    device.lost.then(() => { device = null; });
    return device;
  } catch {
    return null;
  }
}

function sizeCanvas(inst: PlasmaInstance) {
  const rect = inst.bar.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  inst.canvas.width = w * dpr;
  inst.canvas.height = h * dpr;
  inst.canvas.style.width = w + "px";
  inst.canvas.style.height = h + "px";
  inst.uniformData[4] = w;
  inst.uniformData[5] = h;
  inst.uniformData[6] = dpr;
}

async function createInstance(canvas: HTMLCanvasElement, dev: GPUDevice): Promise<PlasmaInstance | null> {
  const bar = canvas.closest(".action-bar") as HTMLElement;
  if (!bar) return null;

  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;

  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({
    device: dev,
    format,
    alphaMode: "premultiplied",
  });

  const shaderModule = dev.createShaderModule({ code: SHADER });

  const uniformBuf = dev.createBuffer({
    size: 32, // 8 x f32
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = dev.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: "uniform" },
    }],
  });

  const pipeline = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: "vs" },
    fragment: {
      module: shaderModule,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });

  const bindGroup = dev.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  const uniformData = new Float32Array(8);
  uniformData[2] = -1; // pointerX (not hovering)
  uniformData[3] = -1; // pointerY
  uniformData[7] = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0;

  const inst: PlasmaInstance = { canvas, ctx, uniformBuf, uniformData, pipeline, bindGroup, bar };
  sizeCanvas(inst);
  return inst;
}

function renderFrame(now: number) {
  if (!alive || !device) return;
  rafId = requestAnimationFrame(renderFrame);

  const t = (now - startTime) / 1000;
  const scroll = window.scrollY / (document.documentElement.scrollHeight || 1);

  for (const inst of instances) {
    // skip hidden bars (offsetWidth is 0 for display:none elements)
    if (inst.bar.offsetWidth === 0) continue;

    inst.uniformData[0] = t;
    inst.uniformData[1] = scroll;

    if (hoveredBar === inst.bar) {
      inst.uniformData[2] = pointerBarX;
      inst.uniformData[3] = pointerBarY;
    } else {
      inst.uniformData[2] = -1;
      inst.uniformData[3] = -1;
    }

    device.queue.writeBuffer(inst.uniformBuf, 0, inst.uniformData);

    const view = inst.ctx.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(inst.pipeline);
    pass.setBindGroup(0, inst.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}

function startLoop() {
  if (alive) return;
  alive = true;
  startTime = performance.now();
  rafId = requestAnimationFrame(renderFrame);
}

function stopLoop() {
  alive = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

// ── public API ─────────────────────────────────────────────────────────────

function teardownAll() {
  stopLoop();
  for (const fn of teardowns) fn();
  teardowns = [];
  instances = [];
  hoveredBar = null;
}

export async function initPlasma() {
  // clean up any previous session fully: stop loop, remove listeners, disconnect observers
  teardownAll();

  const canvases = document.querySelectorAll<HTMLCanvasElement>(".action-bar-plasma");
  if (canvases.length === 0) return;

  const dev = await getDevice();
  if (!dev) {
    console.warn("[spectral-plasma] webgpu unavailable, falling back to css");
    canvases.forEach((c) => { c.style.display = "none"; });
    return;
  }
  console.log("[spectral-plasma] webgpu device acquired, initializing", canvases.length, "bars");

  for (const canvas of canvases) {
    const inst = await createInstance(canvas, dev);
    if (inst) {
      instances.push(inst);
      inst.bar.setAttribute("data-plasma", "");
    }
  }

  if (instances.length === 0) return;

  // ── event wiring (all tracked for teardown) ────────────────

  function addListener(
    el: EventTarget, event: string, handler: EventListener, opts?: AddEventListenerOptions,
  ) {
    el.addEventListener(event, handler, opts);
    teardowns.push(() => el.removeEventListener(event, handler, opts));
  }

  // pointer tracking on bars
  for (const inst of instances) {
    addListener(inst.bar, "pointermove", ((e: PointerEvent) => {
      hoveredBar = inst.bar;
      const rect = inst.bar.getBoundingClientRect();
      pointerBarX = (e.clientX - rect.left) / rect.width;
      pointerBarY = (e.clientY - rect.top) / rect.height;
    }) as EventListener);

    addListener(inst.bar, "pointerleave", (() => {
      if (hoveredBar === inst.bar) {
        hoveredBar = null;
        pointerBarX = -1;
        pointerBarY = -1;
      }
    }) as EventListener);

    // resize + visibility detection via IntersectionObserver (reliable for display toggles)
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && inst.bar.offsetWidth > 0) {
          sizeCanvas(inst);
        }
      }
    });
    io.observe(inst.bar);
    teardowns.push(() => io.disconnect());

    const ro = new ResizeObserver(() => {
      if (inst.bar.offsetWidth > 0 && inst.bar.offsetHeight > 0) {
        sizeCanvas(inst);
      }
    });
    ro.observe(inst.bar);
    teardowns.push(() => ro.disconnect());

    // style attribute changes (inline display toggle)
    const mo = new MutationObserver(() => {
      if (inst.bar.offsetWidth > 0 && inst.bar.offsetHeight > 0) {
        sizeCanvas(inst);
      }
    });
    mo.observe(inst.bar, { attributes: true, attributeFilter: ["style", "class"] });
    teardowns.push(() => mo.disconnect());
  }

  // scroll parallax shadow
  const updateShadowShift = () => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const t = maxScroll > 0 ? window.scrollY / maxScroll : 0;
    const shift = (t - 0.5) * 6;
    for (const inst of instances) {
      inst.bar.style.setProperty("--bar-shadow-shift", shift + "px");
    }
  };
  addListener(window, "scroll", updateShadowShift, { passive: true });
  updateShadowShift();

  // visibility
  const onVis = () => { if (document.hidden) stopLoop(); else startLoop(); };
  addListener(document, "visibilitychange", onVis);

  // reduced motion
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMotionPref = () => {
    const v = mq.matches ? 1 : 0;
    for (const inst of instances) inst.uniformData[7] = v;
  };
  mq.addEventListener("change", onMotionPref);
  teardowns.push(() => mq.removeEventListener("change", onMotionPref));

  // cleanup on astro page transitions (NOT once — must fire on every transition)
  const onSwap = () => teardownAll();
  document.addEventListener("astro:before-swap", onSwap);
  teardowns.push(() => document.removeEventListener("astro:before-swap", onSwap));

  startLoop();
}
