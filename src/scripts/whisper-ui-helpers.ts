// Shared UI helpers for Whisper + Whisper Live.

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

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.left = "-1000px";
  document.body.appendChild(ta);
  try {
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("Copy failed.");
  } finally {
    document.body.removeChild(ta);
  }
}

/* ── Shared Logging ──────────────────────────────────────── */

/** Format a timestamp as `HH:MM:SS` in local time. */
function logTimestamp(): string {
  return new Date().toISOString().slice(11, 19);
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
