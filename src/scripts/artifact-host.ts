/**
 * The host that runs <Artifact> elements.
 *
 * One observer, one capability table, one teardown path, shared by every
 * interactive thing embedded in a page. The rules it enforces:
 *
 *   nothing is fetched until the artifact is near the viewport
 *   nothing is fetched at all if the browser cannot run it
 *   nothing heavy starts by itself on a metered or data-saving connection
 *   everything is torn down before a view transition swaps the document
 *
 * A mounted module owns the stage element and nothing else. It receives an
 * AbortSignal, so listeners registered with it are dropped automatically.
 */

export interface ArtifactContext {
  /** Aborted on teardown. Pass to addEventListener and fetch. */
  signal: AbortSignal;
  /** The <figure> wrapper, for data attributes and sizing. */
  artifact: HTMLElement;
  /** Announce progress to assistive tech. */
  setStatus: (text: string) => void;
  /** The visitor asked for less movement. */
  reduceMotion: boolean;
  /**
   * Whatever the page declared in `params`. This is how one viewer module
   * serves many assets: the module reads ctx.params.asset rather than being
   * rebuilt per model.
   */
  params: Record<string, unknown>;
}

type Teardown = void | (() => void) | Promise<void | (() => void)>;
type MountFn = (stage: HTMLElement, ctx: ArtifactContext) => Teardown;

const BOOTED = new WeakSet<HTMLElement>();
const LIVE = new Map<HTMLElement, { controller: AbortController; teardown?: () => void }>();

let observer: IntersectionObserver | null = null;
let swapHookInstalled = false;

/** Capabilities an artifact can declare. Each is cheap and side-effect free. */
const CAPABILITIES: Record<string, () => boolean> = {
  webgl: () => hasContext("webgl"),
  webgl2: () => hasContext("webgl2"),
  // presence is not usability: a browser can expose navigator.gpu and have it
  // be undefined, and `"gpu" in navigator` happily calls that supported. every
  // check here asks for the thing itself, not for its name.
  webgpu: () => typeof navigator !== "undefined" && !!(navigator as { gpu?: unknown }).gpu,
  wasm: () => typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function",
  worker: () => typeof Worker === "function",
  offscreen: () => typeof OffscreenCanvas === "function",
  pointer: () => typeof window !== "undefined" && !!window.PointerEvent,
};

const LABELS: Record<string, string> = {
  webgl: "WebGL",
  webgl2: "WebGL 2",
  webgpu: "WebGPU",
  wasm: "WebAssembly",
  worker: "Web Workers",
  offscreen: "OffscreenCanvas",
  pointer: "Pointer Events",
};

function hasContext(kind: "webgl" | "webgl2"): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext(kind));
  } catch {
    return false;
  }
}

/** Data saver, or a connection the visitor is paying by the megabyte for. */
function wantsLightPage(): boolean {
  if (window.matchMedia?.("(prefers-reduced-data: reduce)").matches) return true;
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

function setState(artifact: HTMLElement, state: string) {
  artifact.dataset.state = state;
}

function setMessage(artifact: HTMLElement, text: string) {
  const node = artifact.querySelector<HTMLElement>("[data-artifact-message]");
  if (node) node.textContent = text;
}

function setStatus(artifact: HTMLElement, text: string) {
  const node = artifact.querySelector<HTMLElement>("[data-artifact-status]");
  if (node) node.textContent = text;
}

function showLaunch(artifact: HTMLElement, label: string) {
  const button = artifact.querySelector<HTMLButtonElement>("[data-artifact-launch]");
  if (!button) return;
  button.textContent = label;
  button.hidden = false;
}

function missingCapabilities(artifact: HTMLElement): string[] {
  const required = (artifact.dataset.requires || "").split(/\s+/).filter(Boolean);
  return required.filter((name) => {
    const check = CAPABILITIES[name];
    if (typeof check !== "function") {
      // a name nobody implements used to count as satisfied, so a typo in
      // `requires` silently disabled the whole gate. refuse instead.
      console.warn(`[artifact] unknown capability "${name}" — treating as unavailable`);
      return true;
    }
    return !check();
  });
}

async function mount(artifact: HTMLElement) {
  if (BOOTED.has(artifact)) return;
  BOOTED.add(artifact);

  const stage = artifact.querySelector<HTMLElement>("[data-artifact-stage]");
  const src = artifact.dataset.src;
  if (!stage || !src) {
    setState(artifact, "ready");
    return;
  }

  setState(artifact, "loading");
  setStatus(artifact, "Loading");

  const controller = new AbortController();
  LIVE.set(artifact, { controller });

  try {
    // vite rewrites this at build time for modules under src/
    const module = (await import(/* @vite-ignore */ src)) as { default?: MountFn };
    const mountFn = module.default;

    if (typeof mountFn !== "function") {
      throw new Error("artifact module has no default export");
    }
    if (controller.signal.aborted) return;

    let params: Record<string, unknown> = {};
    if (artifact.dataset.params) {
      try {
        params = JSON.parse(artifact.dataset.params) as Record<string, unknown>;
      } catch {
        console.warn("[artifact] params were not valid json", artifact.id);
      }
    }

    const teardown = await mountFn(stage, {
      signal: controller.signal,
      artifact,
      setStatus: (text: string) => setStatus(artifact, text),
      reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      params,
    });

    if (controller.signal.aborted) {
      if (typeof teardown === "function") teardown();
      return;
    }

    const entry = LIVE.get(artifact);
    if (entry && typeof teardown === "function") entry.teardown = teardown;

    setState(artifact, "ready");
    setStatus(artifact, "Ready");
  } catch (error) {
    LIVE.delete(artifact);
    BOOTED.delete(artifact);
    setState(artifact, "error");
    setMessage(artifact, "This did not load.");
    showLaunch(artifact, "Try again");
    setStatus(artifact, "Failed to load");
    console.warn("[artifact] mount failed", { src, error });
  }
}

function release(artifact: HTMLElement) {
  const entry = LIVE.get(artifact);
  if (!entry) return;
  entry.controller.abort();
  try {
    entry.teardown?.();
  } catch (error) {
    console.warn("[artifact] teardown threw", error);
  }
  LIVE.delete(artifact);
  BOOTED.delete(artifact);
  setState(artifact, "idle");
}

export function releaseAllArtifacts() {
  for (const artifact of [...LIVE.keys()]) release(artifact);
  observer?.disconnect();
  observer = null;
}

export function bootArtifacts() {
  const artifacts = document.querySelectorAll<HTMLElement>("[data-artifact]");
  if (!artifacts.length) return;

  if (!swapHookInstalled) {
    swapHookInstalled = true;
    // the document is about to be replaced. stop the render loops now, or they
    // keep running against detached nodes for the rest of the session.
    document.addEventListener("astro:before-swap", releaseAllArtifacts);
    window.addEventListener("pagehide", releaseAllArtifacts);
  }

  for (const artifact of artifacts) {
    if (BOOTED.has(artifact) || artifact.dataset.state === "ready") continue;

    const missing = missingCapabilities(artifact);
    if (missing.length) {
      // refuse before fetching a single byte, and say what is actually missing
      setState(artifact, "unsupported");
      setMessage(
        artifact,
        `This needs ${missing.map((m) => LABELS[m] ?? m).join(" and ")}, which this browser does not offer.`
      );
      continue;
    }

    const launch = artifact.querySelector<HTMLButtonElement>("[data-artifact-launch]");
    launch?.addEventListener("click", () => {
      launch.hidden = true;
      setMessage(artifact, "");
      void mount(artifact);
    });

    if (artifact.dataset.manual !== undefined || wantsLightPage()) {
      setState(artifact, "idle");
      setMessage(artifact, artifact.dataset.manual !== undefined ? "" : "Held back to save data.");
      showLaunch(artifact, "Load");
      continue;
    }

    if (!("IntersectionObserver" in window)) {
      void mount(artifact);
      continue;
    }

    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          void mount(entry.target as HTMLElement);
        }
      },
      { rootMargin: artifact.dataset.rootMargin || "200px" }
    );
    observer.observe(artifact);
  }
}
