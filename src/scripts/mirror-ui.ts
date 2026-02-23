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
  actionCopyBtn: HTMLButtonElement;
  actionExpandBtn: HTMLButtonElement;
  actionCollapseBtn: HTMLButtonElement;
  actionRefreshBtn: HTMLButtonElement;
}

type MirrorUIIdMap = { [K in keyof MirrorUIOptions]: string };

export const MIRROR_UI_IDS: MirrorUIIdMap = {
  container: "mirror-categories",
  scoreExposedCount: "score-exposed-count",
  scoreBlockedCount: "score-blocked-count",
  scoreBlockedGroup: "score-blocked-group",
  scoreBarExposed: "score-bar-exposed",
  scoreBarBlocked: "score-bar-blocked",
  scoreVerdict: "score-verdict",
  fingerprintEl: "fingerprint",
  timestampEl: "mirror-timestamp",
  titleEl: "mirror-title",
  actionCopyBtn: "action-copy",
  actionExpandBtn: "action-expand",
  actionCollapseBtn: "action-collapse",
  actionRefreshBtn: "action-refresh",
};

function queryById(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

function queryButtonById(root: ParentNode, id: string): HTMLButtonElement | null {
  const node = queryById(root, id);
  return node instanceof HTMLButtonElement ? node : null;
}

export function resolveMirrorUIOptions(root: ParentNode = document): MirrorUIOptions | null {
  const container = queryById(root, MIRROR_UI_IDS.container);
  const scoreExposedCount = queryById(root, MIRROR_UI_IDS.scoreExposedCount);
  const scoreBlockedCount = queryById(root, MIRROR_UI_IDS.scoreBlockedCount);
  const scoreBlockedGroup = queryById(root, MIRROR_UI_IDS.scoreBlockedGroup);
  const scoreBarExposed = queryById(root, MIRROR_UI_IDS.scoreBarExposed);
  const scoreBarBlocked = queryById(root, MIRROR_UI_IDS.scoreBarBlocked);
  const scoreVerdict = queryById(root, MIRROR_UI_IDS.scoreVerdict);
  const fingerprintEl = queryById(root, MIRROR_UI_IDS.fingerprintEl);
  const timestampEl = queryById(root, MIRROR_UI_IDS.timestampEl);
  const titleEl = queryById(root, MIRROR_UI_IDS.titleEl);
  const actionCopyBtn = queryButtonById(root, MIRROR_UI_IDS.actionCopyBtn);
  const actionExpandBtn = queryButtonById(root, MIRROR_UI_IDS.actionExpandBtn);
  const actionCollapseBtn = queryButtonById(root, MIRROR_UI_IDS.actionCollapseBtn);
  const actionRefreshBtn = queryButtonById(root, MIRROR_UI_IDS.actionRefreshBtn);

  if (
    !container ||
    !scoreExposedCount ||
    !scoreBlockedCount ||
    !scoreBlockedGroup ||
    !scoreBarExposed ||
    !scoreBarBlocked ||
    !scoreVerdict ||
    !fingerprintEl ||
    !timestampEl ||
    !titleEl ||
    !actionCopyBtn ||
    !actionExpandBtn ||
    !actionCollapseBtn ||
    !actionRefreshBtn
  ) {
    return null;
  }

  return {
    container,
    scoreExposedCount,
    scoreBlockedCount,
    scoreBlockedGroup,
    scoreBarExposed,
    scoreBarBlocked,
    scoreVerdict,
    fingerprintEl,
    timestampEl,
    titleEl,
    actionCopyBtn,
    actionExpandBtn,
    actionCollapseBtn,
    actionRefreshBtn,
  };
}

const EXPANSION_STATE_KEY = "digitalMirror.categoryExpansion.v1";

interface MirrorUIConstants {
  timing: {
    actionTimeoutMs: number;
    counterAnimationMs: number;
    categoryRevealStaggerMs: number;
    categoryRevealDurationMs: number;
    pointHighlightMs: number;
    toastVisibleMs: number;
    toastExitMs: number;
    breadcrumbScrollLockMs: number;
    breadcrumbTypeIntervalMs: number;
    breadcrumbClearIntervalMs: number;
  };
  layout: {
    categoryRevealOffsetPx: number;
    toastOffsetPx: number;
    headerFallbackPx: number;
    breadcrumbScrollOffsetPx: number;
    breadcrumbDetectionOffsetPx: number;
    breadcrumbObserverBottomMarginPct: number;
  };
  motion: {
    categoryRevealEasing: string;
  };
}

const MIRROR_UI_DEFAULTS = {
  timing: {
    actionTimeoutMs: 12000,
    counterAnimationMs: 600,
    categoryRevealStaggerMs: 80,
    categoryRevealDurationMs: 300,
    pointHighlightMs: 1500,
    toastVisibleMs: 2200,
    toastExitMs: 300,
    breadcrumbScrollLockMs: 800,
    breadcrumbTypeIntervalMs: 35,
    breadcrumbClearIntervalMs: 20,
  },
  layout: {
    categoryRevealOffsetPx: 8,
    toastOffsetPx: 8,
    headerFallbackPx: 60,
    breadcrumbScrollOffsetPx: 8,
    breadcrumbDetectionOffsetPx: 24,
    breadcrumbObserverBottomMarginPct: 60,
  },
  motion: {
    categoryRevealEasing: "ease",
  },
} as const satisfies MirrorUIConstants;

function toCssSeconds(ms: number): string {
  return `${ms / 1000}s`;
}

interface MirrorUiRuntimeConfig extends MirrorUIConstants {
  categoryRevealTransition: string;
}

// Runtime behavior derives from the same mirror CSS variables used for styling.
// This keeps motion/layout values centralized on the page token layer.
const MIRROR_UI_CSS_TOKENS = {
  timing: {
    counterAnimationMs: "--mirror-duration-counter",
    categoryRevealStaggerMs: "--mirror-duration-category-stagger",
    categoryRevealDurationMs: "--mirror-duration-category-reveal",
    pointHighlightMs: "--mirror-duration-point-highlight",
    toastVisibleMs: "--mirror-duration-toast-visible",
    toastExitMs: "--mirror-duration-toast-exit",
    breadcrumbScrollLockMs: "--mirror-duration-breadcrumb-lock",
    breadcrumbTypeIntervalMs: "--mirror-duration-breadcrumb-type",
    breadcrumbClearIntervalMs: "--mirror-duration-breadcrumb-clear",
  },
  layout: {
    legacyOffsetPx: "--mirror-layout-offset",
    categoryRevealOffsetPx: "--mirror-category-reveal-offset",
    toastOffsetPx: "--mirror-toast-offset",
    breadcrumbScrollOffsetPx: "--mirror-breadcrumb-scroll-offset",
    breadcrumbDetectionOffsetPx: "--mirror-breadcrumb-detection-offset",
    breadcrumbObserverBottomMarginPct: "--mirror-breadcrumb-observer-bottom-margin-pct",
  },
} as const;

function parseCssTimeToMs(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.endsWith("ms")) {
    const ms = Number.parseFloat(raw.slice(0, -2));
    return Number.isFinite(ms) ? ms : null;
  }
  if (raw.endsWith("s")) {
    const sec = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(sec) ? sec * 1000 : null;
  }
  const numeric = Number.parseFloat(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function evaluateCssLengthPx(scope: HTMLElement, cssValue: string): number | null {
  const raw = cssValue.trim();
  if (!raw) return null;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("width", raw)) {
    return null;
  }

  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = "0px";
  probe.style.width = raw;
  probe.style.height = "0";
  probe.style.padding = "0";
  probe.style.border = "0";
  scope.appendChild(probe);

  const resolved = Number.parseFloat(getComputedStyle(probe).width);
  probe.remove();
  return Number.isFinite(resolved) ? resolved : null;
}

function evaluateCssDurationMs(scope: HTMLElement, cssValue: string): number | null {
  const raw = cssValue.trim();
  if (!raw) return null;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("animation-duration", raw)) {
    return null;
  }

  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.animationDuration = "0ms";
  probe.style.animationDuration = raw;
  scope.appendChild(probe);

  const computed = getComputedStyle(probe).animationDuration.split(",")[0]?.trim() || "";
  probe.remove();
  const ms = parseCssTimeToMs(computed);
  return ms !== null ? ms : null;
}

function readCssLengthTokenPx(
  scope: HTMLElement,
  style: CSSStyleDeclaration,
  tokenName: string,
): number | null {
  const raw = style.getPropertyValue(tokenName).trim();
  return raw ? evaluateCssLengthPx(scope, raw) : null;
}

function readCssDurationTokenMs(
  scope: HTMLElement,
  style: CSSStyleDeclaration,
  tokenName: string,
): number | null {
  const raw = style.getPropertyValue(tokenName).trim();
  return raw ? evaluateCssDurationMs(scope, raw) : null;
}

function readCssNumberToken(style: CSSStyleDeclaration, tokenName: string): number | null {
  const raw = style.getPropertyValue(tokenName).trim();
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function getMirrorTokenScope(container: HTMLElement): HTMLElement {
  return container.closest<HTMLElement>(".mirror-page") ?? document.documentElement;
}

function resolveMirrorUiConfig(container: HTMLElement): MirrorUiRuntimeConfig {
  const tokenScope = getMirrorTokenScope(container);
  const style = getComputedStyle(tokenScope);
  const resolved: MirrorUIConstants = {
    timing: { ...MIRROR_UI_DEFAULTS.timing },
    layout: { ...MIRROR_UI_DEFAULTS.layout },
    motion: { ...MIRROR_UI_DEFAULTS.motion },
  };

  const counterAnimationMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.counterAnimationMs);
  if (counterAnimationMs !== null) resolved.timing.counterAnimationMs = counterAnimationMs;

  const categoryRevealStaggerMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.categoryRevealStaggerMs);
  if (categoryRevealStaggerMs !== null) resolved.timing.categoryRevealStaggerMs = categoryRevealStaggerMs;

  const categoryRevealDurationMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.categoryRevealDurationMs);
  if (categoryRevealDurationMs !== null) resolved.timing.categoryRevealDurationMs = categoryRevealDurationMs;

  const pointHighlightMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.pointHighlightMs);
  if (pointHighlightMs !== null) resolved.timing.pointHighlightMs = pointHighlightMs;

  const toastVisibleMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.toastVisibleMs);
  if (toastVisibleMs !== null) resolved.timing.toastVisibleMs = toastVisibleMs;

  const toastExitMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.toastExitMs);
  if (toastExitMs !== null) resolved.timing.toastExitMs = toastExitMs;

  const breadcrumbScrollLockMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.breadcrumbScrollLockMs);
  if (breadcrumbScrollLockMs !== null) resolved.timing.breadcrumbScrollLockMs = breadcrumbScrollLockMs;

  const breadcrumbTypeIntervalMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.breadcrumbTypeIntervalMs);
  if (breadcrumbTypeIntervalMs !== null) resolved.timing.breadcrumbTypeIntervalMs = breadcrumbTypeIntervalMs;

  const breadcrumbClearIntervalMs = readCssDurationTokenMs(tokenScope, style, MIRROR_UI_CSS_TOKENS.timing.breadcrumbClearIntervalMs);
  if (breadcrumbClearIntervalMs !== null) resolved.timing.breadcrumbClearIntervalMs = breadcrumbClearIntervalMs;

  const legacyOffsetPx = readCssLengthTokenPx(tokenScope, style, MIRROR_UI_CSS_TOKENS.layout.legacyOffsetPx);

  const categoryRevealOffsetPx = readCssLengthTokenPx(
    tokenScope,
    style,
    MIRROR_UI_CSS_TOKENS.layout.categoryRevealOffsetPx,
  ) ?? legacyOffsetPx;
  if (categoryRevealOffsetPx !== null) {
    resolved.layout.categoryRevealOffsetPx = categoryRevealOffsetPx;
  }

  const toastOffsetPx = readCssLengthTokenPx(
    tokenScope,
    style,
    MIRROR_UI_CSS_TOKENS.layout.toastOffsetPx,
  ) ?? legacyOffsetPx;
  if (toastOffsetPx !== null) {
    resolved.layout.toastOffsetPx = toastOffsetPx;
  }

  const breadcrumbScrollOffsetPx = readCssLengthTokenPx(
    tokenScope,
    style,
    MIRROR_UI_CSS_TOKENS.layout.breadcrumbScrollOffsetPx,
  ) ?? legacyOffsetPx;
  if (breadcrumbScrollOffsetPx !== null) {
    resolved.layout.breadcrumbScrollOffsetPx = breadcrumbScrollOffsetPx;
  }

  const breadcrumbDetectionOffsetPx = readCssLengthTokenPx(
    tokenScope,
    style,
    MIRROR_UI_CSS_TOKENS.layout.breadcrumbDetectionOffsetPx,
  );
  if (breadcrumbDetectionOffsetPx !== null) {
    resolved.layout.breadcrumbDetectionOffsetPx = breadcrumbDetectionOffsetPx;
  }

  const breadcrumbObserverBottomMarginPct = readCssNumberToken(
    style,
    MIRROR_UI_CSS_TOKENS.layout.breadcrumbObserverBottomMarginPct,
  );
  if (breadcrumbObserverBottomMarginPct !== null) {
    resolved.layout.breadcrumbObserverBottomMarginPct = breadcrumbObserverBottomMarginPct;
  }

  const categoryRevealDuration = toCssSeconds(resolved.timing.categoryRevealDurationMs);
  const categoryRevealTransition = [
    `opacity ${categoryRevealDuration} ${resolved.motion.categoryRevealEasing}`,
    `transform ${categoryRevealDuration} ${resolved.motion.categoryRevealEasing}`,
  ].join(", ");

  return {
    ...resolved,
    categoryRevealTransition,
  };
}

const CLICK_TO_REVEAL_POINT_IDS = new Set([
  "net.ip",
  "net.coords",
  "net.postal",
  "net.isp",
  "api.localIP",
]);

/**
 * Plainly fictional stand-ins shown in the tooltip for still-masked fields.
 * Chosen to be instantly recognisable as fake — no real IP is 000.000.000.000.
 */
const TOOLTIP_MOCK_VALUES: Record<string, string> = {
  "net.ip":      "000.000.000.000",
  "net.coords":  "00.0000, 00.0000",
  "net.postal":  "00000",
  "net.isp":     "Acme ISP LLC",
  "api.localIP": "000.000.000.000",
};

function shouldUseClickToReveal(pointId: string, value: unknown): value is string {
  return typeof value === "string" && CLICK_TO_REVEAL_POINT_IDS.has(pointId);
}

function renderClickToRevealValue(valueEl: HTMLElement, raw: string): void {
  const revealBtn = el("button", "dp-reveal", "click to reveal");
  revealBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    revealBtn.replaceWith(document.createTextNode(normalizeTextForDisplay(raw)));
  }, { once: true });
  valueEl.appendChild(revealBtn);
}

function cssEscapeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Best-effort fallback for older engines without CSS.escape.
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function isPointMaskedInUi(pointId: string): boolean {
  if (!CLICK_TO_REVEAL_POINT_IDS.has(pointId)) return false;
  return !!document.querySelector(`.dp-row[data-id="${cssEscapeValue(pointId)}"] .dp-reveal`);
}

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

  // Selected doxx-prone fields are masked by default.
  // Resets naturally on rescan because rebuildCategoryShell recreates all DOM.
  if (shouldUseClickToReveal(point.id, v)) {
    renderClickToRevealValue(valueEl, v);
    return;
  }

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

// ─── Greeting ─────────────────────────────────────────────────────────────────

/**
 * Detect the user's browser as specifically as possible.
 * Order matters — check niche browsers before generic engines,
 * since many browsers include "Chrome" or "Safari" in their UA.
 */
function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (/Zen\//.test(ua)) return "Zen";
  if ((navigator as unknown as Record<string, unknown>).brave) return "Brave";
  if (/Vivaldi\//.test(ua)) return "Vivaldi";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Edg\//.test(ua)) return "Edge";
  if (/SamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/CriOS\//.test(ua)) return "Chrome";
  if (/FxiOS\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "browser";
}

/**
 * Build a context-aware greeting from local signals — time of day, browser,
 * and whether this is a returning visit. Each branch has its own phrasing
 * so the result feels written, not slot-filled.
 */
function buildGreeting(): string {
  const hour = new Date().getHours();
  const browser = detectBrowser();

  let returning = false;
  try { returning = !!localStorage.getItem(EXPANSION_STATE_KEY); } catch { /* blocked storage */ }

  // Deep night (midnight–5 AM)
  if (hour < 5) return returning
    ? `still up? welcome back, ${browser} user...`
    : `it's late, ${browser} user...`;

  // Early morning (5–7 AM)
  if (hour < 7) return returning
    ? `early again, ${browser} user...`
    : `you're up early, ${browser} user...`;

  // Late evening (9 PM–midnight)
  if (hour >= 21) return returning
    ? `back for a late night visit, ${browser} user...`
    : `late night, ${browser} user...`;

  // Standard hours (7 AM – 9 PM)
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return returning
    ? `welcome back, ${browser} user...`
    : `good ${period}, ${browser} user...`;
}

// ─── Animations ───────────────────────────────────────────────────────────────

function reducedMotion(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Tracks active counter animations so rapid calls don't stack or restart from 0. */
const activeCounters = new WeakMap<HTMLElement, number>();

function animateCounter(
  element: HTMLElement,
  target: number,
  duration: number,
): void {
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
  uiConfig: MirrorUiRuntimeConfig,
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
          new Promise<null>((_, reject) => setTimeout(
            () => reject(new Error("timeout")),
            uiConfig.timing.actionTimeoutMs,
          )),
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
  uiConfig: MirrorUiRuntimeConfig,
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
  for (const pt of cat.points) body.appendChild(renderDataPoint(pt, pointEls, pointState, uiConfig));

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
    section.style.transform = `translateY(${uiConfig.layout.categoryRevealOffsetPx}px)`;
    setTimeout(() => {
      section.style.transition = uiConfig.categoryRevealTransition;
      section.style.opacity = "1";
      section.style.transform = "translateY(0)";
    }, uiConfig.timing.categoryRevealStaggerMs * index);
  }

  return section;
}

function updateCategoryBody(
  sectionEl: HTMLElement,
  points: DataPoint[],
  pointEls: Map<string, HTMLElement>,
  pointState: Map<string, DataPoint>,
  uiConfig: MirrorUiRuntimeConfig,
): void {
  const body = sectionEl.querySelector<HTMLElement>(".cat-body");
  const toggle = sectionEl.querySelector<HTMLElement>(".cat-toggle");
  const arrow = sectionEl.querySelector<HTMLElement>(".cat-arrow");
  const countEl = sectionEl.querySelector<HTMLElement>(".cat-count");
  if (!body) return;

  // Preserve user-expanded/collapsed state across async collector updates.
  const expanded = toggle ? toggle.getAttribute("aria-expanded") !== "false" : body.style.display !== "none";

  for (const row of body.querySelectorAll<HTMLElement>(".dp-row")) {
    const id = row.dataset.id;
    if (id) {
      pointEls.delete(id);
      pointState.delete(id);
    }
  }

  const fragment = document.createDocumentFragment();
  for (const pt of points) fragment.appendChild(renderDataPoint(pt, pointEls, pointState, uiConfig));
  body.replaceChildren(fragment);

  body.style.display = expanded ? "" : "none";
  if (toggle) toggle.setAttribute("aria-expanded", String(expanded));
  if (arrow) arrow.textContent = expanded ? "\u25bc" : "\u25b6";

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

  // For live points that are already rendered, do a surgical text swap
  // instead of a full teardown/rebuild — this preserves the LIVE badge
  // and its CSS animation.
  if (point.live && point.status === "resolved") {
    // Boolean live points: update the yes/no span text + class
    if (typeof value === "boolean") {
      const span = valueEl.querySelector(".dp-bool-true, .dp-bool-false");
      if (span) {
        span.className = value ? "dp-bool-true" : "dp-bool-false";
        span.textContent = value ? "yes" : "no";
        return;
      }
    }
    // Text/number live points: find the first text node and update it
    for (const node of valueEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        node.textContent = normalizeTextForDisplay(String(value));
        return;
      }
    }
  }

  renderValue(valueEl, nextPoint);
}

// ─── Score ─────────────────────────────────────────────────────────────────────

// ─── Bar Tooltip ─────────────────────────────────────────────────────────────

/** Cleanup functions for tooltip interaction listeners, keyed by bar wrap element. */
const tipCleanups = new WeakMap<HTMLElement, () => void>();

/** Weight → human label for the tooltip. */
const WEIGHT_LABELS: Record<number, string> = {
  5: "very high",
  4: "high",
  3: "moderate",
};

/** Truncate a display value so it fits the tooltip row. */
function truncateValue(v: string | number | boolean | null, max = 28): string {
  if (v === null) return "-";
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

/** Escape HTML entities in user-controlled values. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Positions the tooltip above or below the bar depending on available space,
 * and wires up tap-to-toggle + outside-dismiss for touch devices (following
 * the same pointerdown pattern as the site's mobile menu).
 */
function attachTooltipInteraction(barWrap: HTMLElement): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  /** Re-evaluate flip direction based on current scroll position. */
  function positionTip() {
    const tip = barWrap.querySelector<HTMLElement>(".bar-tooltip");
    if (!tip) return;

    const header = document.querySelector<HTMLElement>(".site-header");
    const ceiling = header ? header.getBoundingClientRect().bottom : 0;

    tip.classList.remove("bar-tooltip--below");
    const tipTop = tip.getBoundingClientRect().top;
    tip.classList.toggle("bar-tooltip--below", tipTop < ceiling);
  }

  // Desktop: reposition on hover.
  barWrap.addEventListener("mouseenter", positionTip, { signal });

  // Touch / pointer: tap bar to toggle, tap outside to dismiss.
  barWrap.addEventListener("pointerdown", (e) => {
    const tip = barWrap.querySelector<HTMLElement>(".bar-tooltip");
    if (!tip) return;

    // If the tap landed on a tooltip row link, let it through.
    if ((e.target as HTMLElement).closest(".bar-tooltip-row")) return;

    const isOpen = tip.classList.contains("bar-tooltip--open");
    if (isOpen) {
      tip.classList.remove("bar-tooltip--open");
    } else {
      positionTip();
      tip.classList.add("bar-tooltip--open");
    }
  }, { signal });

  // Dismiss on outside tap (same pattern as site mobile menu).
  document.addEventListener("pointerdown", (e) => {
    const tip = barWrap.querySelector<HTMLElement>(".bar-tooltip");
    if (!tip || !tip.classList.contains("bar-tooltip--open")) return;
    if (!(e.target instanceof Node)) return;
    if (barWrap.contains(e.target)) return;
    tip.classList.remove("bar-tooltip--open");
  }, { signal });

  return () => controller.abort();
}

/**
 * Build or update the single tooltip on .score-bar-wrap showing the
 * top exposed data points. Only created once — innerHTML is swapped
 * on each tally update so the content stays live during the scan.
 */
function syncBarTooltip(
  barWrap: HTMLElement,
  points: DataPoint[],
  uiConfig: MirrorUiRuntimeConfig,
): void {
  let tip = barWrap.querySelector<HTMLElement>(".bar-tooltip");

  if (points.length === 0) {
    if (tip) tip.remove();
    return;
  }

  const isNew = !tip;
  if (!tip) {
    tip = el("div", "bar-tooltip");
    tip.setAttribute("role", "tooltip");
    barWrap.appendChild(tip);
  }

  let html = `<div class="bar-tooltip-heading">biggest exposures</div>`;
  for (const p of points) {
    const label = esc(normalizeTextForDisplay(p.label));
    // Masked fields get an obviously fake placeholder — never the real value.
    const isMasked = isPointMaskedInUi(p.id);
    const val = isMasked ? esc(TOOLTIP_MOCK_VALUES[p.id] ?? "000.000.000.000") : esc(truncateValue(p.value));
    const wLabel = WEIGHT_LABELS[p.privacyWeight] ?? "";
    html += `<div class="bar-tooltip-row" data-point-id="${esc(p.id)}">`;
    html += `<span class="bar-tooltip-label">${label}</span>`;
    html += `<span class="bar-tooltip-val">${val}</span>`;
    if (wLabel) html += `<span class="bar-tooltip-weight">${wLabel}</span>`;
    html += `</div>`;
  }

  tip.innerHTML = html;

  if (isNew) {
    const detach = attachTooltipInteraction(barWrap);
    tipCleanups.set(barWrap, detach);

    // Click a tooltip row → scroll to the corresponding data point.
    tip.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".bar-tooltip-row");
      if (!row) return;
      const id = row.dataset.pointId;
      if (!id) return;

      const dpRow = document.querySelector<HTMLElement>(`.dp-row[data-id="${cssEscapeValue(id)}"]`);
      if (!dpRow) return;

      // Ensure the parent category is expanded.
      const section = dpRow.closest<HTMLElement>(".cat-section");
      if (section) {
        const toggle = section.querySelector<HTMLButtonElement>(".cat-toggle");
        const body = section.querySelector<HTMLElement>(".cat-body");
        if (toggle && body && toggle.getAttribute("aria-expanded") === "false") {
          toggle.click();
        }
      }

      // Scroll into view after a frame so the expand can settle.
      requestAnimationFrame(() => {
        dpRow.scrollIntoView({ behavior: "smooth", block: "center" });
        dpRow.classList.add("dp-row--highlight");
        setTimeout(() => dpRow.classList.remove("dp-row--highlight"), uiConfig.timing.pointHighlightMs);
      });
    });
  }
}

function updateScore(
  opts: MirrorUIOptions,
  tally: PointTally,
  scanComplete: boolean,
  uiConfig: MirrorUiRuntimeConfig,
): void {
  animateCounter(opts.scoreExposedCount, tally.resolved, uiConfig.timing.counterAnimationMs);
  animateCounter(opts.scoreBlockedCount, tally.unavailable, uiConfig.timing.counterAnimationMs);

  opts.scoreBlockedGroup.classList.toggle("visible", tally.unavailable > 0);

  // Bar and verdict use weighted percentages so high-entropy signals
  // (canvas, fonts, GPU) carry more visual weight than low-entropy booleans.
  const wTotal = tally.weightedTotal;
  const exposedPct = wTotal > 0 ? (tally.weightedResolved / wTotal) * 100 : 0;
  const blockedPct = wTotal > 0 ? (tally.weightedUnavailable / wTotal) * 100 : 0;

  opts.scoreBarExposed.style.width = `${exposedPct}%`;
  opts.scoreBarBlocked.style.width = `${blockedPct}%`;

  // Tooltip lives on the bar wrap — hover target is the full bar width.
  const barWrap = opts.scoreBarExposed.parentElement;
  if (barWrap) syncBarTooltip(barWrap, tally.topExposed, uiConfig);

  if (scanComplete) {
    opts.scoreVerdict.textContent = getVerdict(exposedPct);
    opts.scoreVerdict.classList.add("visible");
  }
}

function getVerdict(weightedPct: number): string {
  const rounded = Math.round(weightedPct);
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
    if (weightedPct >= min) return fn();
  }
  return verdicts[verdicts.length - 1][1]();
}

interface PointTally {
  total: number;
  resolved: number;
  unavailable: number;
  weightedTotal: number;
  weightedResolved: number;
  weightedUnavailable: number;
  topExposed: DataPoint[];
}

/** How many offenders to show in the bar tooltip. */
const BAR_TOOLTIP_MAX = 5;

function tallyPoints(categoryPoints: Iterable<DataPoint[]>): PointTally {
  let total = 0;
  let resolved = 0;
  let unavailable = 0;
  let weightedTotal = 0;
  let weightedResolved = 0;
  let weightedUnavailable = 0;
  const exposed: DataPoint[] = [];

  for (const points of categoryPoints) {
    for (const point of points) {
      if (point.status === "pending") continue;
      const w = point.privacyWeight;
      total++;
      weightedTotal += w;
      if (point.status === "resolved") {
        resolved++;
        weightedResolved += w;
        if (w >= 3) exposed.push(point);
      } else if (point.status === "unavailable") {
        unavailable++;
        weightedUnavailable += w;
      }
    }
  }

  exposed.sort((a, b) => b.privacyWeight - a.privacyWeight);

  return {
    total, resolved, unavailable,
    weightedTotal, weightedResolved, weightedUnavailable,
    topExposed: exposed.slice(0, BAR_TOOLTIP_MAX),
  };
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg: string, uiConfig: MirrorUiRuntimeConfig): void {
  document.querySelector(".mirror-toast")?.remove();
  const toast = el("div", "mirror-toast", msg);
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; toast.style.transform = "translateX(-50%) translateY(0)"; });
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.style.opacity = "0";
    toast.style.transform = `translateX(-50%) translateY(${uiConfig.layout.toastOffsetPx}px)`;
    setTimeout(() => toast.remove(), uiConfig.timing.toastExitMs);
  }, uiConfig.timing.toastVisibleMs);
}

// ─── Copy All ─────────────────────────────────────────────────────────────────

/** IDs whose raw values are too large or not useful in a text export. */
const COPY_EXCLUDE_IDS = new Set(["fp.canvasPreview"]);
const COPY_REDACTED_VALUE = "[click to reveal in UI]";

function copyAllData(
  data: MirrorData,
  liveState: Map<string, DataPoint>,
  toast: (message: string) => void,
): void {
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
      if (CLICK_TO_REVEAL_POINT_IDS.has(current.id)) {
        d[label] = COPY_REDACTED_VALUE;
        continue;
      }
      const value = typeof current.value === "string" ? normalizeTextForDisplay(current.value) : current.value;
      d[label] = value;
    }
    out[normalizeTextForDisplay(cat.title)] = d;
  }
  const json = JSON.stringify(out, null, 2);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(json).then(
      () => toast("Copied to clipboard"),
      () => fallbackCopy(json, toast),
    );
  } else {
    fallbackCopy(json, toast);
  }
}

function fallbackCopy(text: string, toast: (message: string) => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast("Copied to clipboard"); }
  catch { toast("Copy failed"); }
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
  const uiConfig = resolveMirrorUiConfig(opts.container);
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
      const sectionEl = renderCategory(
        placeholder,
        i,
        pointEls,
        pointState,
        uiConfig,
        setCategoryExpandedState,
      );
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
  const headerHeight = headerEl ? headerEl.offsetHeight : uiConfig.layout.headerFallbackPx;

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
      scrollLockTimer = setTimeout(() => { scrollLockCatId = null; scrollLockTimer = null; }, uiConfig.timing.breadcrumbScrollLockMs);
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

        const y = targetEl.getBoundingClientRect().top
          + window.scrollY
          - headerHeight
          - uiConfig.layout.breadcrumbScrollOffsetPx;
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
    }, uiConfig.timing.breadcrumbTypeIntervalMs);
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
    }, uiConfig.timing.breadcrumbClearIntervalMs);
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
    const line = headerHeight + uiConfig.layout.breadcrumbDetectionOffsetPx;
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
      { rootMargin: `-${headerHeight}px 0px -${uiConfig.layout.breadcrumbObserverBottomMarginPct}% 0px` },
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
      if (sectionEl) updateCategoryBody(sectionEl, points, pointEls, pointState, uiConfig);

      categoryPoints.set(catId, points);
      const tally = tallyPoints(categoryPoints.values());
      updateScore(opts, tally, false, uiConfig);
    };

    collectAllData(onUpdate, { signal: scanController.signal })
      .then(data => {
        if (destroyed || runId !== scanRunId) return;
        mirrorData = data;
        opts.fingerprintEl.textContent = data.fingerprintHash;

        // Final score -- use the same categoryPoints totals for consistency,
        // then mark scan complete (label swap, verdict, fingerprint reveal)
        const tally = tallyPoints(categoryPoints.values());
        updateScore(opts, tally, true, uiConfig);
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
  const toast = (message: string) => showToast(message, uiConfig);
  const onCopy = () => mirrorData && copyAllData(mirrorData, pointState, toast);
  const onExpand = () => setAllExpandedAndPersist(true);
  const onCollapse = () => setAllExpandedAndPersist(false);
  const onRefresh = () => startScan();
  opts.actionCopyBtn.addEventListener("click", onCopy);
  opts.actionExpandBtn.addEventListener("click", onExpand);
  opts.actionCollapseBtn.addEventListener("click", onCollapse);
  opts.actionRefreshBtn.addEventListener("click", onRefresh);

  cleanups.push(() => {
    opts.actionCopyBtn.removeEventListener("click", onCopy);
    opts.actionExpandBtn.removeEventListener("click", onExpand);
    opts.actionCollapseBtn.removeEventListener("click", onCollapse);
    opts.actionRefreshBtn.removeEventListener("click", onRefresh);
  });

  // Live updaters
  const stopLive = createLiveUpdaters((id, value) => {
    if (!destroyed) updatePointValue(id, value, pointEls, pointState);
  });
  cleanups.push(stopLive);

  // Greeting — context-aware, set once per scan
  opts.timestampEl.textContent = buildGreeting();

  const cleanup = () => {
    destroyed = true;
    scanRunId += 1;
    if (activeScanController) {
      activeScanController.abort();
      activeScanController = null;
    }
    // Detach tooltip interaction listeners (document pointerdown etc.)
    const barWrap = opts.scoreBarExposed.parentElement;
    if (barWrap) tipCleanups.get(barWrap)?.();
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
