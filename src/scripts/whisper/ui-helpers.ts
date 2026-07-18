// Shared UI helpers for Whisper + Whisper Live.

/* ── Haptic vocabulary ───────────────────────────────────────
 *
 * Uses the full Vibration API pattern syntax: [on, off, on, …]
 * Each event has a distinct "feel" so users subconsciously learn
 * them over time. All calls are no-ops on unsupported platforms.
 *
 * Patterns are conservatively short — no pattern exceeds ~200ms
 * total duration. Never annoying, always intentional.
 */
export type HapticEvent =
  | "msg-received"      // peer sent a text message: soft double-tap
  | "msg-sent"          // our message delivered: micro-tick
  | "file-received"     // peer sent file/audio: heavier double-tap
  | "connected"         // session went live: ascending two-tap
  | "disconnected"      // session ended/lost: single firm thud
  | "recording-start"   // mic capture begins: soft click
  | "recording-stop"    // voice note sent: two-part end+dispatch
  | "recording-cancel"  // voice note discarded: triple skip
  | "reaction"          // emoji toggled (self): crisp tap
  | "send-failed"       // message or file failed to send: error double-pulse
  | "clear-history"     // history wiped: heavy two-step
  | "confirm"           // fingerprint confirmed: decisive commitment
  | "reject"            // fingerprint rejected: firm warning
  | "copied"            // clipboard write succeeded: light tick
  | "mode-switch"       // entering/exiting a UI mode: subtle click
  | "drop"              // file dropped into chat: soft arrival
  | "qr-detected"       // QR code recognized by camera: ascending double
  | "detent";            // slider crosses a regime boundary: physical notch

const HAPTIC_PATTERNS: Record<HapticEvent, VibratePattern> = {
  "msg-received": [6, 50, 4],
  "msg-sent": 4,
  "file-received": [8, 40, 8],
  "connected": [12, 60, 20],
  "disconnected": 30,
  "recording-start": 8,
  "recording-stop": [6, 40, 10],
  "recording-cancel": [4, 30, 4, 30, 4],
  "reaction": 10,
  "send-failed": [20, 60, 20],
  "clear-history": [15, 80, 25],
  "confirm": 14,
  "reject": [18, 50, 10],
  "copied": 3,
  "mode-switch": 5,
  "drop": [6, 30, 8],
  "qr-detected": [8, 40, 14],
  "detent": 12,
};

/**
 * Fire a named haptic pattern. Safe to call unconditionally —
 * the Vibration API check is inside so callers need zero guards.
 */
export function haptic(event: HapticEvent): void {
  if (!navigator.vibrate) return;
  navigator.vibrate(HAPTIC_PATTERNS[event]);
}

const REACTION_GLYPH_PLACEHOLDER = "✦";
const REACTION_GLYPH_OPEN_ATTR = "data-glyph-open";
const reactionGlyphSegmenter = new Intl.Segmenter();

export function normalizeReactionGlyph(raw: string): string | null {
  const compact = raw.replace(/\s/g, "");
  if (!compact) return null;
  const firstCluster = reactionGlyphSegmenter.segment(compact)[Symbol.iterator]().next().value?.segment;
  return firstCluster ?? compact[0] ?? null;
}

export interface ReactionComposer {
  element: HTMLDivElement;
  /** The always-visible toggle button ("mark" pill). Exposed so callers can
   *  relocate it out of `element` into their own layout (e.g. a fixed row)
   *  without touching the commit/reset/open logic below. */
  button: HTMLButtonElement;
  /** The expanding input field (preview glyph + text input). Exposed for the
   *  same reason as `button` — callers may want to host it separately, e.g.
   *  in an overlay panel instead of inline next to the button. */
  field: HTMLElement;
  reset: () => void;
  open: () => void;
}

export interface CreateReactionComposerOptions {
  host: HTMLElement;
  onCommit: (glyph: string) => void;
  signal?: AbortSignal;
  buttonLabel?: string;
  fieldLabel?: string;
  inputLabel?: string;
  placeholder?: string;
}

export function createReactionComposer({
  host,
  onCommit,
  signal,
  buttonLabel = "Add custom mark",
  fieldLabel = "Type one reaction mark",
  inputLabel = "Type one symbol or emoji",
  placeholder = "mark",
}: CreateReactionComposerOptions): ReactionComposer {
  const wrap = document.createElement("div");
  wrap.className = "wl-react-custom";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wl-react-btn wl-react-btn--more wl-react-btn--custom";
  button.textContent = REACTION_GLYPH_PLACEHOLDER;
  button.setAttribute("aria-label", buttonLabel);

  const field = document.createElement("label");
  field.className = "wl-react-custom-field";
  field.setAttribute("aria-label", fieldLabel);

  const preview = document.createElement("span");
  preview.className = "wl-react-custom-preview";
  preview.textContent = REACTION_GLYPH_PLACEHOLDER;
  preview.setAttribute("aria-hidden", "true");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "wl-react-custom-input";
  input.maxLength = 16;
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("inputmode", "text");
  input.setAttribute("aria-label", inputLabel);

  let isComposing = false;
  // Latches once a glyph has been committed for the current open session, so
  // the "input" auto-commit and the "compositionend"/Enter fallback commit
  // can never both fire for the same session. Cleared on every reset (which
  // open() always runs first), so each fresh session starts uncommitted.
  let committed = false;

  const listenerOptions = signal ? { signal } : undefined;

  function reset(): void {
    isComposing = false;
    committed = false;
    host.removeAttribute(REACTION_GLYPH_OPEN_ATTR);
    input.value = "";
    preview.textContent = REACTION_GLYPH_PLACEHOLDER;
  }

  function commit(): void {
    if (committed) return;
    const glyph = normalizeReactionGlyph(input.value);
    if (!glyph) return;
    committed = true;
    preview.textContent = glyph;
    onCommit(glyph);
  }

  function open(): void {
    reset();
    host.setAttribute(REACTION_GLYPH_OPEN_ATTR, "");
    requestAnimationFrame(() => input.focus());
  }

  input.addEventListener("compositionstart", () => {
    isComposing = true;
  }, listenerOptions);
  input.addEventListener("compositionend", () => {
    isComposing = false;
    const glyph = normalizeReactionGlyph(input.value);
    preview.textContent = glyph ?? REACTION_GLYPH_PLACEHOLDER;
    commit();
  }, listenerOptions);
  input.addEventListener("input", (event) => {
    event.stopPropagation();
    const glyph = normalizeReactionGlyph(input.value);
    preview.textContent = glyph ?? REACTION_GLYPH_PLACEHOLDER;
    if (isComposing || (event instanceof InputEvent && event.isComposing)) return;
    commit();
  }, listenerOptions);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      reset();
      return;
    }
    if (event.key === "Enter") commit();
  }, listenerOptions);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (host.hasAttribute(REACTION_GLYPH_OPEN_ATTR)) {
      reset();
      return;
    }
    open();
  }, listenerOptions);

  field.append(preview, input);
  wrap.append(button, field);

  return { element: wrap, button, field, reset, open };
}

export function q(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`#${id}`);
}

export function asInput(el: HTMLElement | null): HTMLInputElement | null {
  return el instanceof HTMLInputElement ? el : null;
}

export function asButton(el: HTMLElement | null): HTMLButtonElement | null {
  return el instanceof HTMLButtonElement ? el : null;
}

export function asPre(el: HTMLElement | null): HTMLPreElement | null {
  return el instanceof HTMLPreElement ? el : null;
}

export function clearNode(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export async function fileToBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export async function copyToClipboard(text: string): Promise<void> {
  if (!text) throw new Error("Nothing to copy.");

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const accepted = window.prompt("Clipboard access was blocked. Copy the text below:", text);
  if (accepted === null) throw new Error("Copy cancelled.");
}

/* ── Shared Logging ──────────────────────────────────────── */

/** Format a timestamp as `HH:MM:SS` in local time. */
function logTimestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** Append a timestamped line to a shared log `<pre>` and auto-scroll. */
export function appendToLog(logOutput: HTMLPreElement, line: string): void {
  logOutput.textContent += `[${logTimestamp()}] ${line}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

/** Toggle the activity indicator dot on/off. */
export function setLogDotActive(logDot: HTMLElement, active: boolean): void {
  logDot.classList.toggle("whisper-log-active", active);
}

/**
 * Returns a `log()` function that writes to the shared log output,
 * flashes the log dot for `dimMs`, and auto-clears it.
 * The returned cleanup function cancels any pending dim timer.
 */
export function createLogger(
  logOutput: HTMLPreElement,
  logDot: HTMLElement,
  dimMs = 2000,
): { log: (msg: string) => void; cleanup: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function log(msg: string): void {
    appendToLog(logOutput, msg);
    setLogDotActive(logDot, true);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { setLogDotActive(logDot, false); timer = null; }, dimMs);
  }
  function cleanup(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }
  return { log, cleanup };
}

export function flashText(el: HTMLElement, temp: string, ms = 900): () => void {
  const prev = el.textContent ?? "";
  el.textContent = temp;
  const t = window.setTimeout(() => { el.textContent = prev; }, ms);
  return () => {
    window.clearTimeout(t);
    el.textContent = prev;
  };
}
