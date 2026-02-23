// mirror-ui.ts — Rendering, animation, and interaction for the Digital Mirror page.
// Consumes data from mirror-collectors.ts. No module-level mutable state — all
// state is scoped inside initMirror() so refresh produces a clean lifecycle.

import {
  collectAllData,
  createLiveUpdaters,
  CATEGORY_ORDER,
  type DataCategory,
  type DataPoint,
  type MirrorData,
} from "./mirror-collectors";

// ─── Options ──────────────────────────────────────────────────────────────────

export interface MirrorUIOptions {
  container: HTMLElement;
  scoreExposedCount: HTMLElement;
  scoreBlockedCount: HTMLElement;
  scoreBlockedGroup: HTMLElement;
  scoreBarExposed: HTMLElement;
  scoreBarBlocked: HTMLElement;

  scoreVerdict: HTMLElement;
  fingerprintEl: HTMLElement;
  timestampEl: HTMLElement;
  titleEl: HTMLElement;
}

const EXPANSION_STATE_KEY = "digitalMirror.categoryExpansion.v1";

function loadExpansionState(): Map<string, boolean> {
  const state = new Map<string, boolean>();
  const validIds = new Set(CATEGORY_ORDER.map((category) => category.id));
  if (typeof window === "undefined") return state;

  try {
    const raw = window.localStorage.getItem(EXPANSION_STATE_KEY);
    if (!raw) return state;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return state;

    for (const [id, expanded] of Object.entries(parsed as Record<string, unknown>)) {
      if (validIds.has(id) && typeof expanded === "boolean") {
        state.set(id, expanded);
      }
    }
  } catch {
    // Ignore malformed/blocked storage; mirror should still function normally.
  }

  return state;
}

function saveExpansionState(state: Map<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    const serializable: Record<string, boolean> = {};
    for (const [id, expanded] of state) {
      serializable[id] = expanded;
    }
    window.localStorage.setItem(EXPANSION_STATE_KEY, JSON.stringify(serializable));
  } catch {
    // Ignore blocked storage writes (private mode / strict privacy settings).
  }
}

// ─── DOM helper ───────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * Repairs common UTF-8-as-Latin1 mojibake (e.g. "Fran\\u00C3\\u00A7ais" -> "Francais")
 * without touching already-correct strings.
 */
function normalizeTextForDisplay(input: string): string {
  if (!/[\u00C3\u00C2\u00E2]/.test(input) || typeof TextDecoder === "undefined") return input;

  try {
    const bytes = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code > 0xff) return input;
      bytes[i] = code;
    }

    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (!decoded || decoded.includes("\uFFFD")) return input;

    const noiseCount = (s: string) => (s.match(/[\u00C3\u00C2\u00E2]/g) || []).length;
    return noiseCount(decoded) < noiseCount(input) ? decoded : input;
  } catch {
    return input;
  }
}

// ─── Value formatting ─────────────────────────────────────────────────────────

/** Render a DataPoint value into the value element. Handles booleans, colors, images, etc. */
function renderValue(valueEl: HTMLElement, point: DataPoint): void {
  valueEl.textContent = "";
  valueEl.className = "dp-value";

  if (point.status === "unavailable" || point.value === null) {
    valueEl.classList.add("dp-na");
    valueEl.textContent = "-";
    return;
  }

  const v = point.value;

  // Boolean → ✓ / ✗
  if (typeof v === "boolean") {
    const span = el("span", v ? "dp-bool-true" : "dp-bool-false", v ? "yes" : "no");
    valueEl.appendChild(span);
    addLiveBadge(valueEl, point);
    return;
  }

  const s = normalizeTextForDisplay(String(v));

  // Permission states → colored
  if (point.id.startsWith("perm.") && (s === "granted" || s === "denied" || s === "prompt")) {
    const cls = s === "granted" ? "dp-perm-granted" : s === "denied" ? "dp-perm-denied" : "dp-perm-prompt";
    valueEl.appendChild(el("span", cls, s));
    return;
  }

  // Color swatch (system colors + EyeDropper results)
  if ((point.id.startsWith("theme.") || point.id === "api.eyeDropper") && (s.startsWith("rgb") || s.startsWith("#"))) {
    const swatch = el("span", "dp-swatch");
    swatch.style.backgroundColor = s;
    valueEl.appendChild(swatch);
    valueEl.appendChild(document.createTextNode(` ${s}`));
    return;
  }

  // Canvas preview image
  if (point.id === "fp.canvasPreview" && s.startsWith("data:image")) {
    const img = document.createElement("img");
    img.src = s;
    img.className = "dp-canvas-preview";
    img.alt = "Canvas fingerprint rendering";
    valueEl.appendChild(img);
    return;
  }

  // Default text
  valueEl.appendChild(document.createTextNode(s));
  addLiveBadge(valueEl, point);
}

function addLiveBadge(valueEl: HTMLElement, point: DataPoint): void {
  if (point.live && point.status === "resolved") {
    valueEl.appendChild(el("span", "dp-live", "LIVE"));
  }
}

function detailStabilityLabel(point: DataPoint): string | null {
  if (point.detailStability === "live") return "live signal";
  if (point.detailStability === "session") return "session-variant";
  if (point.detailStability === "stable") return "stable signal";
  return null;
}

type DetailChipTier = "low" | "medium" | "high";

interface DetailChip {
  text: string;
  tier: DetailChipTier;
  tint: string;
}

function toToken(input: string): string {
  return normalizeTextForDisplay(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

function renderDetail(point: DataPoint): HTMLElement | null {
  const chips: DetailChip[] = [];
  if (point.detailSource) {
    chips.push({
      text: point.detailSource,
      tier: "low",
      tint: `source_${toToken(point.detailSource)}`,
    });
  }
  if (point.detailConfidence) {
    const confidenceKey = point.detailConfidence;
    const tier: DetailChipTier =
      confidenceKey === "high"
        ? "high"
        : confidenceKey === "medium"
          ? "medium"
          : "low";
    chips.push({
      text: `${confidenceKey} confidence`,
      tier,
      tint: `confidence_${confidenceKey}`,
    });
  }
  const stability = detailStabilityLabel(point);
  if (stability) {
    const stabilityKey = point.detailStability || "stable";
    const tier: DetailChipTier = stabilityKey === "stable" ? "high" : "medium";
    chips.push({
      text: stability,
      tier,
      tint: `stability_${stabilityKey}`,
    });
  }
  if (point.action) {
    chips.push({
      text: "interactive",
      tier: "medium",
      tint: "action_interactive",
    });
  }

  if (chips.length === 0) return null;

  const detail = el("div", "dp-detail");
  const meta = el("div", "dp-detail-meta");
  for (const chip of chips) {
    const chipText = normalizeTextForDisplay(chip.text);
    const chipEl = el("span", "dp-detail-chip", chipText);
    chipEl.setAttribute("data-chip-tier", chip.tier);
    chipEl.setAttribute("data-chip-tint", chip.tint);
    meta.appendChild(chipEl);
  }
  detail.appendChild(meta);

  return detail;
}

// ─── Animations ───────────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Tracks active counter animations so rapid calls don't stack or restart from 0. */
const activeCounters = new WeakMap<HTMLElement, number>();

function animateCounter(element: HTMLElement, target: number, duration = 600): void {
  const current = parseInt(element.textContent || "0", 10) || 0;
  if (current === target) return;
  if (reducedMotion()) { element.textContent = String(target); return; }

  // Cancel any in-progress animation on this element
  const prevId = activeCounters.get(element);
  if (prevId) cancelAnimationFrame(prevId);

  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) * (1 - t);
    element.textContent = String(Math.round(current + (target - current) * eased));
    if (t < 1) {
      activeCounters.set(element, requestAnimationFrame(step));
    } else {
      activeCounters.delete(element);
    }
  };
  activeCounters.set(element, requestAnimationFrame(step));
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderDataPoint(
  point: DataPoint,
  pointEls: Map<string, HTMLElement>,
  pointState: Map<string, DataPoint>,
): HTMLElement {
  const row = el("div", "dp-row");
  row.dataset.id = point.id;

  const header = el("div", "dp-header");
  const label = el("span", "dp-label");
  if (point.sensitive) label.appendChild(el("span", "dp-sensitive", "\u25cf "));
  label.appendChild(document.createTextNode(normalizeTextForDisplay(point.label)));

  const valueEl = el("span", "dp-value");
  renderValue(valueEl, point);
  pointEls.set(point.id, valueEl);
  pointState.set(point.id, point);

  // "try" button for interactive data points
  if (point.action && point.value !== null) {
    const tryBtn = el("button", "dp-try", "try");
    let running = false;
    tryBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (running || !point.action) return;
      running = true;
      tryBtn.textContent = "...";
      try {
        const result = await Promise.race([
          point.action(),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
        ]);
        if (!valueEl.isConnected) return;
        if (result != null) {
          const nextPoint: DataPoint = { ...point, value: result, status: "resolved" };
          pointState.set(point.id, nextPoint);
          renderValue(valueEl, nextPoint);
        }
      } catch { /* action failed or timed out — keep current value */ } finally {
        running = false;
        if (!valueEl.isConnected) return;
        if (!valueEl.contains(tryBtn)) valueEl.appendChild(tryBtn);
        tryBtn.textContent = "try";
      }
    });
    valueEl.appendChild(tryBtn);
  }

  header.appendChild(label);
  header.appendChild(valueEl);
  row.appendChild(header);
  row.appendChild(el("div", "dp-explain", normalizeTextForDisplay(point.explanation)));
  const detail = renderDetail(point);
  if (detail) row.appendChild(detail);

  return row;
}

function renderCategory(
  cat: DataCategory,
  index: number,
  pointEls: Map<string, HTMLElement>,
  pointState: Map<string, DataPoint>,
  onExpandedChange?: (categoryId: string, expanded: boolean) => void,
): HTMLElement {
  const section = el("section", "cat-section");
  section.dataset.cat = cat.id;

  const toggle = el("button", "cat-toggle");
  toggle.setAttribute("aria-expanded", String(cat.expanded));
  const arrow = el("span", "cat-arrow", "\u25bc");
  const title = el("span", "cat-title", ` ${normalizeTextForDisplay(cat.title)}`);
  const count = el("span", "cat-count", ` (${cat.points.length})`);
  toggle.append(arrow, title, count);

  const body = el("div", "cat-body");
  for (const pt of cat.points) body.appendChild(renderDataPoint(pt, pointEls, pointState));

  const applyExpanded = (expanded: boolean) => {
    body.style.display = expanded ? "" : "none";
    arrow.textContent = expanded ? "\u25bc" : "\u25b6";
    toggle.setAttribute("aria-expanded", String(expanded));
  };

  applyExpanded(cat.expanded);

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    applyExpanded(expanded);
    onExpandedChange?.(cat.id, expanded);
  });

  section.append(toggle, body);

  // Stagger reveal
  if (!reducedMotion()) {
    section.style.opacity = "0";
    section.style.transform = "translateY(8px)";
    setTimeout(() => {
      section.style.transition = "opacity 0.3s ease, transform 0.3s ease";
      section.style.opacity = "1";
      section.style.transform = "translateY(0)";
    }, 80 * index);
  }

  return section;
}

function updateCategoryBody(
  sectionEl: HTMLElement,
  points: DataPoint[],
  pointEls: Map<string, HTMLElement>,
  pointState: Map<string, DataPoint>,
): void {
  const body = sectionEl.querySelector<HTMLElement>(".cat-body");
  const countEl = sectionEl.querySelector<HTMLElement>(".cat-count");
  if (!body) return;

  for (const row of body.querySelectorAll<HTMLElement>(".dp-row")) {
    const id = row.dataset.id;
    if (id) {
      pointEls.delete(id);
      pointState.delete(id);
    }
  }

  body.innerHTML = "";
  for (const pt of points) body.appendChild(renderDataPoint(pt, pointEls, pointState));
  if (countEl) countEl.textContent = ` (${points.length})`;
}

function updatePointValue(
  id: string,
  value: string | number | boolean,
  pointEls: Map<string, HTMLElement>,
  pointState: Map<string, DataPoint>,
): void {
  const valueEl = pointEls.get(id);
  const point = pointState.get(id);
  if (!valueEl || !point) return;
  if (point.status === "resolved" && Object.is(point.value, value)) return;

  const nextPoint: DataPoint = {
    ...point,
    value,
    status: "resolved",
  };
  pointState.set(id, nextPoint);
  renderValue(valueEl, nextPoint);
}

// ─── Score ─────────────────────────────────────────────────────────────────────

function updateScore(
  opts: MirrorUIOptions,
  resolved: number,
  unavailable: number,
  total: number,
  scanComplete: boolean,
): void {
  animateCounter(opts.scoreExposedCount, resolved);
  animateCounter(opts.scoreBlockedCount, unavailable);

  opts.scoreBlockedGroup.classList.toggle("visible", unavailable > 0);

  const exposedPct = total > 0 ? (resolved / total) * 100 : 0;
  const blockedPct = total > 0 ? (unavailable / total) * 100 : 0;

  opts.scoreBarExposed.style.width = `${exposedPct}%`;
  opts.scoreBarBlocked.style.width = `${blockedPct}%`;

  if (scanComplete) {
    opts.scoreVerdict.textContent = getVerdict(resolved, unavailable, total);
    opts.scoreVerdict.classList.add("visible");
  }
}

function getVerdict(_exposed: number, _blocked: number, total: number): string {
  const pct = total > 0 ? (_exposed / total) * 100 : 0;
  const rounded = Math.round(pct);
  // Verdicts ordered by exposure: clear reflection → nearly opaque.
  // Each threshold is [minPct, verdictFn]; first match wins.
  const verdicts: [number, () => string][] = [
    [90, () => `a crystal clear reflection. ${rounded}% of you, right there.`],
    [75, () => `a sharp image, not quite flawless. ${100 - rounded}% stayed in shadow.`],
    [50, () => `a recognizable figure, but ${100 - rounded}% was lost in the fog.`],
    [30, () => `hard to make out. only ${rounded}% came through the glass.`],
    [0, () => `almost opaque. just ${rounded}% slipped through.`],
  ];
  for (const [min, fn] of verdicts) {
    if (pct >= min) return fn();
  }
  return verdicts[verdicts.length - 1][1]();
}

function tallyPoints(categoryPoints: Iterable<DataPoint[]>): {
  total: number;
  resolved: number;
  unavailable: number;
} {
  let total = 0;
  let resolved = 0;
  let unavailable = 0;

  for (const points of categoryPoints) {
    for (const point of points) {
      if (point.status === "pending") continue;
      total++;
      if (point.status === "resolved") {
        resolved++;
      } else if (point.status === "unavailable") {
        unavailable++;
      }
    }
  }

  return { total, resolved, unavailable };
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg: string): void {
  document.querySelector(".mirror-toast")?.remove();
  const toast = el("div", "mirror-toast", msg);
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; toast.style.transform = "translateX(-50%) translateY(0)"; });
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(8px)";
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

// ─── Copy All ─────────────────────────────────────────────────────────────────

/** IDs whose raw values are too large or not useful in a text export. */
const COPY_EXCLUDE_IDS = new Set(["fp.canvasPreview"]);

function copyAllData(data: MirrorData, liveState: Map<string, DataPoint>): void {
  const out: Record<string, unknown> = {
    source: "woflo.dev/mirror",
    fingerprint: data.fingerprintHash,
    collectedAt: new Date(data.collectedAt).toISOString(),
    totalPoints: data.totalPoints,
    resolvedPoints: data.resolvedPoints,
  };
  for (const cat of data.categories) {
    const d: Record<string, unknown> = {};
    for (const pt of cat.points) {
      if (COPY_EXCLUDE_IDS.has(pt.id)) continue;
      // Prefer live-updated value over stale snapshot
      const current = liveState.get(pt.id) ?? pt;
      const label = normalizeTextForDisplay(current.label);
      const value = typeof current.value === "string" ? normalizeTextForDisplay(current.value) : current.value;
      d[label] = value;
    }
    out[normalizeTextForDisplay(cat.title)] = d;
  }
  const json = JSON.stringify(out, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(
      () => showToast("Copied to clipboard"),
      () => fallbackCopy(json),
    );
  } else {
    fallbackCopy(json);
  }
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); showToast("Copied to clipboard"); }
  catch { showToast("Copy failed"); }
  finally { ta.remove(); }
}

// ─── Expand / Collapse ────────────────────────────────────────────────────────

function setAllExpanded(
  root: ParentNode,
  expanded: boolean,
  onSectionChange?: (categoryId: string, expanded: boolean) => void,
): void {
  root.querySelectorAll<HTMLElement>(".cat-section").forEach(section => {
    const body = section.querySelector<HTMLElement>(".cat-body");
    const arrow = section.querySelector<HTMLElement>(".cat-arrow");
    const toggle = section.querySelector<HTMLElement>(".cat-toggle");
    if (body) body.style.display = expanded ? "" : "none";
    if (arrow) arrow.textContent = expanded ? "\u25bc" : "\u25b6";
    if (toggle) toggle.setAttribute("aria-expanded", String(expanded));
    const categoryId = section.dataset.cat;
    if (categoryId) onSectionChange?.(categoryId, expanded);
  });
}

// ─── Main Init ────────────────────────────────────────────────────────────────

export function initMirror(opts: MirrorUIOptions): () => void {
  // All mutable state scoped here — no module globals
  const pointEls = new Map<string, HTMLElement>();
  const pointState = new Map<string, DataPoint>();
  const categoryEls = new Map<string, HTMLElement>();
  const categoryPoints = new Map<string, DataPoint[]>();
  const expansionState = loadExpansionState();
  const cleanups: Array<() => void> = [];
  let mirrorData: MirrorData | null = null;
  let destroyed = false;
  let scanRunId = 0;
  let activeScanController: AbortController | null = null;

  const setCategoryExpandedState = (categoryId: string, expanded: boolean) => {
    expansionState.set(categoryId, expanded);
    saveExpansionState(expansionState);
  };

  const setAllExpandedAndPersist = (expanded: boolean) => {
    setAllExpanded(opts.container, expanded, (categoryId, nextExpanded) => {
      expansionState.set(categoryId, nextExpanded);
    });
    saveExpansionState(expansionState);
  };

  const resetScoreUi = () => {
    opts.scoreExposedCount.textContent = "0";
    opts.scoreBlockedCount.textContent = "0";
    opts.scoreBlockedGroup.classList.remove("visible");
    opts.scoreBarExposed.style.width = "0%";
    opts.scoreBarBlocked.style.width = "0%";

    opts.scoreVerdict.textContent = "";
    opts.scoreVerdict.classList.remove("visible");
    opts.fingerprintEl.textContent = "--------";
  };

  const rebuildCategoryShell = () => {
    opts.container.innerHTML = "";
    pointEls.clear();
    pointState.clear();
    categoryEls.clear();
    categoryPoints.clear();

    for (let i = 0; i < CATEGORY_ORDER.length; i++) {
      const def = CATEGORY_ORDER[i];
      const expanded = expansionState.get(def.id) ?? true;
      const placeholder: DataCategory = { id: def.id, title: def.title, points: [], expanded };
      const sectionEl = renderCategory(placeholder, i, pointEls, pointState, setCategoryExpandedState);
      opts.container.appendChild(sectionEl);
      categoryEls.set(def.id, sectionEl);
    }
  };

  // ── Breadcrumb integration ──────────────────────────────────────────────────
  // Track which category section is at the top of the viewport and show it in
  // the site header breadcrumb. Replicates the Layout's typewriter effect
  // (typeOut / clearThenType) so transitions feel consistent site-wide.

  let breadcrumbObserver: IntersectionObserver | null = null;
  let currentBreadcrumbKey = "";
  let typeTimer: ReturnType<typeof setInterval> | null = null;

  const breadcrumbEl = document.getElementById("header-breadcrumb");
  const headerEl = document.querySelector<HTMLElement>(".site-header");
  const headerHeight = headerEl ? headerEl.offsetHeight : 60;

  // Intersection state — updated by observer, read by scroll handler
  const visibleSections = new Set<HTMLElement>();

  // Scroll lock — prevents breadcrumb flicker during smooth scroll after a click.
  // When a crumb is clicked, we lock the breadcrumb to the target category for a
  // short duration so the smooth scroll animation doesn't cause rapid switching.
  let scrollLockCatId: string | null = null;
  let scrollLockTimer: ReturnType<typeof setTimeout> | null = null;

  function lockScrollTo(catId: string | null) {
    if (scrollLockTimer) clearTimeout(scrollLockTimer);
    scrollLockCatId = catId;
    if (catId) {
      scrollLockTimer = setTimeout(() => { scrollLockCatId = null; scrollLockTimer = null; }, 800);
    }
  }

  type Crumb = { text: string; target: HTMLElement | null };

  function makeCrumb(c: Crumb): HTMLElement {
    const crumb = el("span", "crumb");
    crumb.setAttribute("role", "button");
    crumb.setAttribute("tabindex", "0");
    const inner = el("span", "crumb-inner", c.text);
    crumb.appendChild(inner);
    if (c.target) {
      const targetEl = c.target;
      const scrollTo = () => {
        // Lock breadcrumb to this target during the smooth scroll
        const catId = targetEl.dataset?.cat;
        if (catId) lockScrollTo(catId);

        const y = targetEl.getBoundingClientRect().top + window.scrollY - headerHeight - 8;
        window.scrollTo({ top: Math.max(0, y) });
      };
      crumb.addEventListener("click", scrollTo);
      crumb.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollTo(); }
      });
    }
    return crumb;
  }

  function buildCrumbDOM(crumbs: Crumb[]) {
    if (!breadcrumbEl) return;
    breadcrumbEl.innerHTML = "";
    for (const c of crumbs) {
      const sep = el("span", "crumb-sep", "\u00b7");
      sep.setAttribute("aria-hidden", "true");
      breadcrumbEl.append(sep, makeCrumb(c));
    }
  }

  function typeOut(crumbs: Crumb[]) {
    if (!breadcrumbEl) return;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }

    buildCrumbDOM(crumbs);
    breadcrumbEl.style.opacity = "var(--opacity-dim)";

    if (reducedMotion()) return;

    const inners = Array.from(breadcrumbEl.querySelectorAll<HTMLElement>(".crumb-inner"));
    const texts = inners.map(e => { const t = e.textContent || ""; e.textContent = ""; return t; });
    const total = texts.reduce((a, t) => a + t.length, 0);
    let i = 0;

    typeTimer = setInterval(() => {
      if (i > total) { clearInterval(typeTimer!); typeTimer = null; return; }
      let rem = i++;
      inners.forEach((inner, idx) => {
        const len = Math.min(rem, texts[idx].length);
        inner.textContent = texts[idx].slice(0, len);
        rem -= len;
      });
    }, 35);
  }

  function clearThenType(crumbs: Crumb[]) {
    if (!breadcrumbEl) return;
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }

    if (reducedMotion()) {
      if (crumbs.length) { buildCrumbDOM(crumbs); breadcrumbEl.style.opacity = "var(--opacity-dim)"; }
      else { breadcrumbEl.innerHTML = ""; breadcrumbEl.style.opacity = "0"; }
      return;
    }

    const inners = Array.from(breadcrumbEl.querySelectorAll<HTMLElement>(".crumb-inner"));
    const total = inners.reduce((a, e) => a + (e.textContent || "").length, 0);
    let i = total;

    typeTimer = setInterval(() => {
      if (i <= 0) {
        clearInterval(typeTimer!); typeTimer = null;
        if (crumbs.length) typeOut(crumbs);
        else { breadcrumbEl!.innerHTML = ""; breadcrumbEl!.style.opacity = "0"; }
        return;
      }
      let rem = --i;
      for (let j = inners.length - 1; j >= 0; j--) {
        const text = inners[j].textContent || "";
        if (rem >= text.length) { rem -= text.length; }
        else {
          inners[j].textContent = text.slice(0, rem);
          for (let k = j + 1; k < inners.length; k++) inners[k].textContent = "";
          break;
        }
      }
    }, 20);
  }

  function setCrumbs(crumbs: Crumb[]) {
    if (!breadcrumbEl) return;
    const key = crumbs.map(c => c.text).join("|");
    if (key === currentBreadcrumbKey) return;
    currentBreadcrumbKey = key;

    const hasExisting = !!breadcrumbEl.querySelector(".crumb-inner");
    if (!hasExisting && crumbs.length) typeOut(crumbs);
    else clearThenType(crumbs);
  }

  function getTopmostCategory(): { title: string; section: HTMLElement } | null {
    // During smooth scroll after a breadcrumb click, honour the lock to prevent
    // the breadcrumb from flickering through intermediate categories.
    if (scrollLockCatId) {
      const lockedEl = categoryEls.get(scrollLockCatId);
      const def = CATEGORY_ORDER.find(c => c.id === scrollLockCatId);
      if (lockedEl && def) return { title: def.title, section: lockedEl };
    }

    // Pick the section whose top edge is closest to (but above) the detection
    // line just below the sticky header. This is the section the user is "in".
    const line = headerHeight + 24;
    let best: HTMLElement | null = null;
    let bestTop = -Infinity;
    for (const sec of visibleSections) {
      const y = sec.getBoundingClientRect().top;
      if (y <= line && y > bestTop) { bestTop = y; best = sec; }
    }
    // Fallback: nothing has scrolled past the line yet — pick the closest below
    if (!best) {
      let closest = Infinity;
      for (const sec of visibleSections) {
        const y = sec.getBoundingClientRect().top;
        if (y < closest) { closest = y; best = sec; }
      }
    }
    if (!best) return null;
    const catId = best.dataset.cat;
    const def = catId && CATEGORY_ORDER.find(c => c.id === catId);
    return def ? { title: def.title, section: best } : null;
  }

  function onBreadcrumbScroll() {
    const scrolledPastTitle = window.scrollY > headerHeight;
    if (!scrolledPastTitle) { setCrumbs([]); return; }

    const top = getTopmostCategory();
    const crumbs: Crumb[] = [{ text: "Digital Mirror", target: opts.titleEl }];
    if (top) crumbs.push({ text: top.title.toLowerCase(), target: top.section });
    setCrumbs(crumbs);
  }

  function setupBreadcrumbObserver() {
    if (breadcrumbObserver) breadcrumbObserver.disconnect();
    visibleSections.clear();

    const sections = opts.container.querySelectorAll<HTMLElement>(".cat-section");
    if (!sections.length) return;

    breadcrumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (entry.isIntersecting) visibleSections.add(target);
          else visibleSections.delete(target);
        }
        onBreadcrumbScroll();
      },
      { rootMargin: `-${headerHeight}px 0px -60% 0px` },
    );

    for (const sec of sections) breadcrumbObserver.observe(sec);
  }

  window.addEventListener("scroll", onBreadcrumbScroll, { passive: true });

  cleanups.push(() => {
    window.removeEventListener("scroll", onBreadcrumbScroll);
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    if (scrollLockTimer) { clearTimeout(scrollLockTimer); scrollLockTimer = null; }
    scrollLockCatId = null;
    if (breadcrumbObserver) { breadcrumbObserver.disconnect(); breadcrumbObserver = null; }
    currentBreadcrumbKey = "";
    if (breadcrumbEl) { breadcrumbEl.innerHTML = ""; breadcrumbEl.style.opacity = "0"; }
  });

  const startScan = () => {
    if (destroyed) return;

    // Abort previous run so stale async collectors don't keep running.
    if (activeScanController) {
      activeScanController.abort();
      activeScanController = null;
    }

    const scanController = new AbortController();
    activeScanController = scanController;
    scanRunId += 1;
    const runId = scanRunId;
    mirrorData = null;

    resetScoreUi();
    rebuildCategoryShell();
    setupBreadcrumbObserver();

    opts.titleEl.textContent = "Digital Mirror";

    // Progressive update callback — updates UI and score as data streams in
    const onUpdate = (catId: string, points: DataPoint[]) => {
      if (destroyed || runId !== scanRunId) return;
      const sectionEl = categoryEls.get(catId);
      if (sectionEl) updateCategoryBody(sectionEl, points, pointEls, pointState);

      categoryPoints.set(catId, points);
      const { total, resolved, unavailable } = tallyPoints(categoryPoints.values());
      updateScore(opts, resolved, unavailable, total, false);
    };

    collectAllData(onUpdate, { signal: scanController.signal })
      .then(data => {
        if (destroyed || runId !== scanRunId) return;
        mirrorData = data;
        opts.fingerprintEl.textContent = data.fingerprintHash;

        // Final score -- use the same categoryPoints totals for consistency,
        // then mark scan complete (label swap, verdict, fingerprint reveal)
        const { total, resolved, unavailable } = tallyPoints(categoryPoints.values());
        updateScore(opts, resolved, unavailable, total, true);
      })
      .catch(() => {
        // Individual collectors are error-isolated; this prevents an unhandled rejection.
      })
      .finally(() => {
        if (runId !== scanRunId) return;
        if (activeScanController === scanController) {
          activeScanController = null;
        }
      });
  };

  // Wire action buttons immediately (not inside .then)
  const onCopy = () => mirrorData && copyAllData(mirrorData, pointState);
  const onExpand = () => setAllExpandedAndPersist(true);
  const onCollapse = () => setAllExpandedAndPersist(false);
  const onRefresh = () => startScan();

  const copyBtn = document.getElementById("action-copy");
  const expandBtn = document.getElementById("action-expand");
  const collapseBtn = document.getElementById("action-collapse");
  const refreshBtn = document.getElementById("action-refresh");

  copyBtn?.addEventListener("click", onCopy);
  expandBtn?.addEventListener("click", onExpand);
  collapseBtn?.addEventListener("click", onCollapse);
  refreshBtn?.addEventListener("click", onRefresh);

  cleanups.push(() => {
    copyBtn?.removeEventListener("click", onCopy);
    expandBtn?.removeEventListener("click", onExpand);
    collapseBtn?.removeEventListener("click", onCollapse);
    refreshBtn?.removeEventListener("click", onRefresh);
  });

  // Live updaters
  const stopLive = createLiveUpdaters((id, value) => {
    if (!destroyed) updatePointValue(id, value, pointEls, pointState);
  });
  cleanups.push(stopLive);

  // Timestamp
  const updateTs = () => { opts.timestampEl.textContent = new Date().toLocaleTimeString(); };
  updateTs();
  const tsId = setInterval(updateTs, 1000);
  cleanups.push(() => clearInterval(tsId));

  const cleanup = () => {
    destroyed = true;
    scanRunId += 1;
    if (activeScanController) {
      activeScanController.abort();
      activeScanController = null;
    }
    pointEls.clear();
    pointState.clear();
    categoryEls.clear();
    categoryPoints.clear();
    cleanups.forEach(fn => fn());
    cleanups.length = 0;
  };

  startScan();

  return cleanup;
}
