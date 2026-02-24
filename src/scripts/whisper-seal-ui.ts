/**
 * Whisper Seal — UI layer.
 *
 * Seal is integrated into Embed mode as a carrier-type "URL (Seal)".
 * Compose fields live inline in the operation panel; computing, my-seal,
 * result, and unseal phases show as an overlay that hides the solo panel.
 */

import {
  computeFingerprint,
  fingerprintToSealCode,
  isSealCodeValid,
  sealMessage,
  unsealMessage,
  buildSealUrl,
  parseSealFragment,
  expiryLabel,
  COMPUTE_MIN_DISPLAY_MS,
  type SealPayload,
} from "./whisper-seal";
import {
  q,
  asInput,
  asButton,
  asPre,
  copyToClipboard,
  flashText,
  createLogger,
} from "./whisper-ui-helpers";

/* ── Interface & IDs ──────────────────────────────────────── */

export interface WhisperSealUIOptions {
  page: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;

  /* Overlay */
  overlay: HTMLElement;
  soloPanel: HTMLElement;

  /* My Seal button (in carrier toggle row) */
  mySealBtn: HTMLButtonElement;

  /* Inline compose fields */
  recipientSealInput: HTMLInputElement;
  sealValidation: HTMLElement;
  messageInput: HTMLTextAreaElement;
  charCount: HTMLElement;
  extraPasswordInput: HTMLInputElement;
  expirySelect: HTMLSelectElement;
  sealItBtn: HTMLButtonElement;

  /* Overlay: computing */
  computingPhase: HTMLElement;

  /* Overlay: my seal */
  mySealPhase: HTMLElement;
  sealCode: HTMLElement;
  sealCopyBtn: HTMLButtonElement;
  sealBackBtn: HTMLButtonElement;

  /* Overlay: result */
  resultPhase: HTMLElement;
  sealedUrl: HTMLPreElement;
  urlCopyBtn: HTMLButtonElement;
  resultSealTarget: HTMLElement;
  resultExpiryText: HTMLElement;
  resultUrlWarning: HTMLElement;
  resultDoneBtn: HTMLButtonElement;

  /* Overlay: unseal */
  unsealPhase: HTMLElement;
  unsealProgress: HTMLElement;
  unsealSuccess: HTMLElement;
  decryptedMessage: HTMLPreElement;
  msgCopyBtn: HTMLButtonElement;
  unsealDoneBtn: HTMLButtonElement;
  unsealFail: HTMLElement;
  failBackBtn: HTMLButtonElement;
  unsealExpired: HTMLElement;
  expiredBackBtn: HTMLButtonElement;
  unsealPassword: HTMLElement;
  unsealPwInput: HTMLInputElement;
  unsealPwSubmitBtn: HTMLButtonElement;
}

export const WHISPER_SEAL_IDS = {
  overlay: "ws-overlay",
  mySealBtn: "ws-my-seal-btn",
  recipientSealInput: "ws-recipient-seal",
  sealValidation: "ws-seal-validation",
  messageInput: "ws-message",
  charCount: "ws-char-count",
  extraPasswordInput: "ws-extra-password",
  expirySelect: "ws-expiry",
  sealItBtn: "ws-seal-it",
  computingPhase: "ws-computing-phase",
  mySealPhase: "ws-my-seal-phase",
  sealCode: "ws-seal-code",
  sealCopyBtn: "ws-seal-copy",
  sealBackBtn: "ws-seal-back",
  resultPhase: "ws-result-phase",
  sealedUrl: "ws-sealed-url",
  urlCopyBtn: "ws-url-copy",
  resultSealTarget: "ws-result-seal-target",
  resultExpiryText: "ws-result-expiry-text",
  resultUrlWarning: "ws-result-url-warning",
  resultDoneBtn: "ws-result-done",
  unsealPhase: "ws-unseal-phase",
  unsealProgress: "ws-unseal-progress",
  unsealSuccess: "ws-unseal-success",
  decryptedMessage: "ws-decrypted-message",
  msgCopyBtn: "ws-msg-copy",
  unsealDoneBtn: "ws-unseal-done",
  unsealFail: "ws-unseal-fail",
  failBackBtn: "ws-fail-back",
  unsealExpired: "ws-unseal-expired",
  expiredBackBtn: "ws-expired-back",
  unsealPassword: "ws-unseal-password",
  unsealPwInput: "ws-unseal-pw-input",
  unsealPwSubmitBtn: "ws-unseal-pw-submit",
} as const;

/** URLs above this may be truncated by messaging apps. */
const URL_WARN_LENGTH = 2000;

/* ── Resolve ──────────────────────────────────────────────── */

export function resolveWhisperSealUIOptions(root: ParentNode = document): WhisperSealUIOptions | null {
  const IDS = WHISPER_SEAL_IDS;

  const page = q(root, "whisper-page");
  const logOutput = asPre(q(root, "whisper-log-output"));
  const logDot = q(root, "whisper-log-dot");

  const overlay = q(root, IDS.overlay);
  const soloPanel = root.querySelector<HTMLElement>(".whisper-op-solo");

  const mySealBtn = asButton(q(root, IDS.mySealBtn));

  const recipientSealInput = asInput(q(root, IDS.recipientSealInput));
  const sealValidation = q(root, IDS.sealValidation);
  const messageInput = root.querySelector<HTMLTextAreaElement>(`#${IDS.messageInput}`);
  const charCount = q(root, IDS.charCount);
  const extraPasswordInput = asInput(q(root, IDS.extraPasswordInput));
  const expirySelect = root.querySelector<HTMLSelectElement>(`#${IDS.expirySelect}`);
  const sealItBtn = asButton(q(root, IDS.sealItBtn));

  const computingPhase = q(root, IDS.computingPhase);
  const mySealPhase = q(root, IDS.mySealPhase);
  const sealCode = q(root, IDS.sealCode);
  const sealCopyBtn = asButton(q(root, IDS.sealCopyBtn));
  const sealBackBtn = asButton(q(root, IDS.sealBackBtn));

  const resultPhase = q(root, IDS.resultPhase);
  const sealedUrl = asPre(q(root, IDS.sealedUrl));
  const urlCopyBtn = asButton(q(root, IDS.urlCopyBtn));
  const resultSealTarget = q(root, IDS.resultSealTarget);
  const resultExpiryText = q(root, IDS.resultExpiryText);
  const resultUrlWarning = q(root, IDS.resultUrlWarning);
  const resultDoneBtn = asButton(q(root, IDS.resultDoneBtn));

  const unsealPhase = q(root, IDS.unsealPhase);
  const unsealProgress = q(root, IDS.unsealProgress);
  const unsealSuccess = q(root, IDS.unsealSuccess);
  const decryptedMessage = asPre(q(root, IDS.decryptedMessage));
  const msgCopyBtn = asButton(q(root, IDS.msgCopyBtn));
  const unsealDoneBtn = asButton(q(root, IDS.unsealDoneBtn));
  const unsealFail = q(root, IDS.unsealFail);
  const failBackBtn = asButton(q(root, IDS.failBackBtn));
  const unsealExpired = q(root, IDS.unsealExpired);
  const expiredBackBtn = asButton(q(root, IDS.expiredBackBtn));
  const unsealPassword = q(root, IDS.unsealPassword);
  const unsealPwInput = asInput(q(root, IDS.unsealPwInput));
  const unsealPwSubmitBtn = asButton(q(root, IDS.unsealPwSubmitBtn));

  if (
    !page || !logOutput || !logDot ||
    !overlay || !soloPanel || !mySealBtn ||
    !recipientSealInput || !sealValidation ||
    !messageInput || !charCount || !extraPasswordInput || !expirySelect ||
    !sealItBtn ||
    !computingPhase || !mySealPhase || !sealCode || !sealCopyBtn || !sealBackBtn ||
    !resultPhase || !sealedUrl || !urlCopyBtn || !resultSealTarget ||
    !resultExpiryText || !resultUrlWarning || !resultDoneBtn ||
    !unsealPhase || !unsealProgress || !unsealSuccess || !decryptedMessage ||
    !msgCopyBtn || !unsealDoneBtn || !unsealFail || !failBackBtn ||
    !unsealExpired || !expiredBackBtn ||
    !unsealPassword || !unsealPwInput || !unsealPwSubmitBtn
  ) {
    return null;
  }

  return {
    page, logOutput, logDot,
    overlay, soloPanel, mySealBtn,
    recipientSealInput, sealValidation,
    messageInput, charCount, extraPasswordInput, expirySelect,
    sealItBtn,
    computingPhase, mySealPhase, sealCode, sealCopyBtn, sealBackBtn,
    resultPhase, sealedUrl, urlCopyBtn, resultSealTarget,
    resultExpiryText, resultUrlWarning, resultDoneBtn,
    unsealPhase, unsealProgress, unsealSuccess, decryptedMessage,
    msgCopyBtn, unsealDoneBtn, unsealFail, failBackBtn,
    unsealExpired, expiredBackBtn,
    unsealPassword, unsealPwInput, unsealPwSubmitBtn,
  };
}

/* ── Helpers ──────────────────────────────────────────────── */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `computeFingerprint()` with a minimum display duration for UX. */
async function computeFingerprintWithMinDelay(): Promise<Uint8Array> {
  const [fp] = await Promise.all([computeFingerprint(), delay(COMPUTE_MIN_DISPLAY_MS)]);
  return fp;
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperSeal(opts: WhisperSealUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;

  const { log, cleanup: cleanupLogger } = createLogger(opts.logOutput, opts.logDot);

  const overlayPanels = [
    opts.computingPhase, opts.mySealPhase,
    opts.resultPhase, opts.unsealPhase,
  ];

  let busy = false;
  let pendingPayload: SealPayload | null = null;

  /** Guard: true if this instance has been torn down. */
  function aborted(): boolean { return signal.aborted; }

  /* ── Overlay management ────────────────────────────────── */

  function showOverlay(panel: HTMLElement): void {
    opts.soloPanel.style.display = "none";
    for (const p of overlayPanels) p.style.display = p === panel ? "" : "none";
    opts.overlay.style.display = "";
  }

  function hideOverlay(): void {
    opts.overlay.style.display = "none";
    for (const p of overlayPanels) p.style.display = "none";
    opts.soloPanel.style.display = "";
  }

  /* ── Switch to embed/url carrier ───────────────────────── */

  function ensureEmbedUrlMode(): void {
    opts.page.dataset.mode = "embed";
    opts.page.dataset.carrier = "url";
    // Sync mode buttons (scoped to page, not document)
    opts.page.querySelectorAll<HTMLButtonElement>("[data-whisper-mode]").forEach((btn) => {
      const active = btn.dataset.whisperMode === "embed";
      btn.classList.toggle("whisper-mode-btn--active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    // Sync carrier radio
    const urlRadio = opts.page.querySelector<HTMLInputElement>('input[name="ws-carrier-type"][value="url"]');
    if (urlRadio) urlRadio.checked = true;
  }

  /* ── Compose helpers ──────────────────────────────────── */

  function syncCompose(): void {
    const code = opts.recipientSealInput.value.trim().toUpperCase();
    const valid = isSealCodeValid(code);
    const hasMsg = opts.messageInput.value.trim().length > 0;

    if (code.length > 0) {
      opts.sealValidation.textContent = valid ? "\u2713 valid seal" : "\u2717 invalid format";
      opts.sealValidation.dataset.valid = String(valid);
    } else {
      opts.sealValidation.textContent = "";
      delete opts.sealValidation.dataset.valid;
    }
    opts.sealItBtn.disabled = !(valid && hasMsg) || busy;
  }

  function syncCharCount(): void {
    opts.charCount.textContent = `${opts.messageInput.value.length.toLocaleString()} / 48,000`;
  }

  function resetComposeFields(): void {
    opts.recipientSealInput.value = "";
    opts.messageInput.value = "";
    opts.extraPasswordInput.value = "";
    opts.sealValidation.textContent = "";
    delete opts.sealValidation.dataset.valid;
    syncCharCount();
    syncCompose();
  }

  /* ── Unseal sub-view toggle ───────────────────────────── */

  const unsealSubs = [
    opts.unsealProgress, opts.unsealSuccess, opts.unsealFail,
    opts.unsealExpired, opts.unsealPassword,
  ];

  function showUnsealSub(target: HTMLElement): void {
    for (const s of unsealSubs) s.style.display = s === target ? "" : "none";
  }

  /* ── Generate Seal ────────────────────────────────────── */

  async function generateSeal(): Promise<void> {
    if (busy) return;
    busy = true;
    opts.mySealBtn.disabled = true;
    showOverlay(opts.computingPhase);
    log("computing browser seal...");

    try {
      const fp = await computeFingerprintWithMinDelay();
      if (aborted()) return;
      const code = fingerprintToSealCode(fp);
      opts.sealCode.textContent = code;
      showOverlay(opts.mySealPhase);
      log(`seal ready: ${code}`);
      opts.sealCopyBtn.focus();
    } catch (e) {
      if (aborted()) return;
      log(`error: ${e instanceof Error ? e.message : "unknown"}`);
      hideOverlay();
    } finally {
      busy = false;
      opts.mySealBtn.disabled = false;
    }
  }

  /* ── Seal (encrypt) ───────────────────────────────────── */

  async function doSeal(): Promise<void> {
    if (busy) return;
    busy = true;
    opts.sealItBtn.disabled = true;

    const recipient = opts.recipientSealInput.value.trim().toUpperCase();
    const message = opts.messageInput.value;
    const expiryMs = parseInt(opts.expirySelect.value, 10);
    const pw = opts.extraPasswordInput.value || undefined;

    log(`sealing message for ${recipient} (${message.length.toLocaleString()} chars)`);
    showOverlay(opts.computingPhase);

    try {
      const payload = await sealMessage(recipient, message, expiryMs, pw);
      if (aborted()) return;
      const url = buildSealUrl(payload);

      opts.sealedUrl.textContent = url;
      opts.resultSealTarget.textContent = recipient;
      opts.resultExpiryText.textContent = expiryMs > 0 ? `Expires in ${expiryLabel(expiryMs)}` : "No expiry";

      if (url.length > URL_WARN_LENGTH) {
        opts.resultUrlWarning.textContent =
          `This URL is ${url.length.toLocaleString()} characters long. Some apps truncate URLs over ${URL_WARN_LENGTH.toLocaleString()} characters — share it somewhere that preserves the full length.`;
        opts.resultUrlWarning.style.display = "";
      } else {
        opts.resultUrlWarning.style.display = "none";
      }

      showOverlay(opts.resultPhase);
      log(`url generated (${url.length.toLocaleString()} chars)`);
      opts.urlCopyBtn.focus();
    } catch (e) {
      if (aborted()) return;
      log(`seal error: ${e instanceof Error ? e.message : "unknown"}`);
      hideOverlay();
    } finally {
      busy = false;
      opts.sealItBtn.disabled = false;
      syncCompose();
    }
  }

  /* ── Unseal (decrypt) ─────────────────────────────────── */

  async function runUnseal(payload: SealPayload, password?: string): Promise<void> {
    if (busy) return;
    busy = true;
    pendingPayload = payload;
    showOverlay(opts.unsealPhase);
    showUnsealSub(opts.unsealProgress);
    log("checking sealed message...");

    try {
      const fp = await computeFingerprintWithMinDelay();
      if (aborted()) return;
      const localCode = fingerprintToSealCode(fp);
      log(`local seal: ${localCode}`);

      const result = await unsealMessage(payload, localCode, password);
      if (aborted()) return;

      if (result.ok) {
        opts.decryptedMessage.textContent = result.message;
        showUnsealSub(opts.unsealSuccess);
        log("message decrypted successfully");
        pendingPayload = null;
        history.replaceState(null, "", window.location.pathname);
        opts.msgCopyBtn.focus();
        return;
      }

      switch (result.reason) {
        case "expired":
          showUnsealSub(opts.unsealExpired);
          log("sealed message has expired");
          pendingPayload = null;
          break;
        case "password-needed":
          showUnsealSub(opts.unsealPassword);
          log("additional password required");
          opts.unsealPwInput.value = "";
          opts.unsealPwInput.focus();
          break;
        case "wrong-seal":
          showUnsealSub(opts.unsealFail);
          log(`seal mismatch: message for ${payload.s}, local is ${localCode}`);
          pendingPayload = null;
          break;
        case "decrypt-failed":
          showUnsealSub(opts.unsealFail);
          log("decryption failed — wrong browser or corrupted payload");
          pendingPayload = null;
          break;
      }
    } catch (e) {
      if (aborted()) return;
      showUnsealSub(opts.unsealFail);
      log(`unseal error: ${e instanceof Error ? e.message : "unknown"}`);
      pendingPayload = null;
    } finally {
      busy = false;
    }
  }

  /* ── Clipboard helper (swallows errors into log) ───────── */

  async function safeCopy(text: string, btn: HTMLButtonElement, label = "Copied!"): Promise<void> {
    try {
      await copyToClipboard(text);
      if (aborted()) return;
      flashText(btn, label);
    } catch (e) {
      if (aborted()) return;
      log(`copy failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  /* ── Event Listeners ──────────────────────────────────── */

  // My Seal button
  opts.mySealBtn.addEventListener("click", () => generateSeal(), { signal });

  // My Seal overlay — copy & back
  opts.sealCopyBtn.addEventListener("click", () => safeCopy(opts.sealCode.textContent ?? "", opts.sealCopyBtn), { signal });
  opts.sealBackBtn.addEventListener("click", hideOverlay, { signal });

  // Compose — auto-uppercase seal input as typed
  opts.recipientSealInput.addEventListener("input", () => {
    const el = opts.recipientSealInput;
    const pos = el.selectionStart;
    const upper = el.value.toUpperCase();
    if (el.value !== upper) { el.value = upper; el.selectionStart = el.selectionEnd = pos; }
    syncCompose();
  }, { signal });

  opts.messageInput.addEventListener("input", () => { syncCompose(); syncCharCount(); }, { signal });
  opts.sealItBtn.addEventListener("click", () => doSeal(), { signal });

  // Enter on seal input → focus message
  opts.recipientSealInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); opts.messageInput.focus(); }
  }, { signal });

  // Result overlay
  opts.urlCopyBtn.addEventListener("click", () => safeCopy(opts.sealedUrl.textContent ?? "", opts.urlCopyBtn), { signal });
  opts.resultDoneBtn.addEventListener("click", () => {
    resetComposeFields();
    hideOverlay();
  }, { signal });

  // Unseal overlay
  opts.msgCopyBtn.addEventListener("click", () => safeCopy(opts.decryptedMessage.textContent ?? "", opts.msgCopyBtn), { signal });
  opts.unsealDoneBtn.addEventListener("click", hideOverlay, { signal });
  opts.failBackBtn.addEventListener("click", hideOverlay, { signal });
  opts.expiredBackBtn.addEventListener("click", hideOverlay, { signal });

  // Password submit
  opts.unsealPwSubmitBtn.addEventListener("click", () => {
    if (pendingPayload && !busy) runUnseal(pendingPayload, opts.unsealPwInput.value);
  }, { signal });
  opts.unsealPwInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && pendingPayload && !busy) {
      e.preventDefault();
      runUnseal(pendingPayload, opts.unsealPwInput.value);
    }
  }, { signal });

  /* ── Boot ─────────────────────────────────────────────── */

  // If URL contains a #ws1: fragment, jump straight to unseal
  const autoPayload = parseSealFragment();
  if (autoPayload) {
    ensureEmbedUrlMode();
    log("sealed url detected");
    runUnseal(autoPayload);
  }

  /* ── Teardown ─────────────────────────────────────────── */

  return () => {
    ac.abort();
    cleanupLogger();
    // Reset overlay state so next init starts clean
    hideOverlay();
    pendingPayload = null;
    busy = false;
  };
}
