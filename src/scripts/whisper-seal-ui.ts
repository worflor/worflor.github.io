/**
 * Whisper Seal — UI layer.
 *
 * Seal is integrated into Embed mode as a carrier-type "URL (Seal)".
 * Compose fields live inline in the operation panel; computing, my-seal,
 * result, and unseal phases show as an overlay that hides the solo panel.
 */

import {
  getOrCreateSealIdentity,
  getExistingSealIdentity,
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
  mySealInline: HTMLElement;

  /* Inline compose fields */
  recipientSealInput: HTMLInputElement;
  sealValidation: HTMLElement;
  messageInput: HTMLTextAreaElement;
  charCount: HTMLElement;
  extraPasswordInput: HTMLInputElement;
  extraPwGenBtn: HTMLButtonElement;
  extraPwCopyBtn: HTMLButtonElement;
  expiryGroup: HTMLElement;
  expiryCustomWrap: HTMLElement;
  expiryCustomVal: HTMLInputElement;
  expiryCustomUnit: HTMLSelectElement;
  sealItBtn: HTMLButtonElement;

  /* Inline seal result */
  sealedResultWrap: HTMLElement;
  sealedUrlInline: HTMLPreElement;
  sealedResultInfo: HTMLElement;
  sealedResultWarning: HTMLElement;

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
  mySealInline: "ws-my-seal-inline",
  recipientSealInput: "ws-recipient-seal",
  sealValidation: "ws-seal-validation",
  messageInput: "ws-message",
  charCount: "ws-char-count",
  extraPasswordInput: "ws-extra-password",
  extraPwGenBtn: "ws-extra-pw-gen",
  extraPwCopyBtn: "ws-extra-pw-copy",
  expiryGroup: "ws-expiry",
  expiryCustomWrap: "ws-expiry-custom",
  expiryCustomVal: "ws-expiry-custom-val",
  expiryCustomUnit: "ws-expiry-custom-unit",
  sealItBtn: "ws-seal-it",
  sealedResultWrap: "ws-sealed-result",
  sealedUrlInline: "ws-sealed-url-inline",
  sealedResultInfo: "ws-sealed-result-info",
  sealedResultWarning: "ws-sealed-result-warning",
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
  const mySealInline = q(root, IDS.mySealInline);

  const recipientSealInput = asInput(q(root, IDS.recipientSealInput));
  const sealValidation = q(root, IDS.sealValidation);
  const messageInput = root.querySelector<HTMLTextAreaElement>(`#${IDS.messageInput}`);
  const charCount = q(root, IDS.charCount);
  const extraPasswordInput = asInput(q(root, IDS.extraPasswordInput));
  const extraPwGenBtn = asButton(q(root, IDS.extraPwGenBtn));
  const extraPwCopyBtn = asButton(q(root, IDS.extraPwCopyBtn));
  const expiryGroup = q(root, IDS.expiryGroup);
  const expiryCustomWrap = q(root, IDS.expiryCustomWrap);
  const expiryCustomVal = asInput(q(root, IDS.expiryCustomVal));
  const expiryCustomUnit = root.querySelector<HTMLSelectElement>(`#${IDS.expiryCustomUnit}`);
  const sealItBtn = asButton(q(root, IDS.sealItBtn));
  const sealedResultWrap = q(root, IDS.sealedResultWrap);
  const sealedUrlInline = asPre(q(root, IDS.sealedUrlInline));
  const sealedResultInfo = q(root, IDS.sealedResultInfo);
  const sealedResultWarning = q(root, IDS.sealedResultWarning);

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
    !overlay || !soloPanel || !mySealBtn || !mySealInline ||
    !recipientSealInput || !sealValidation ||
    !messageInput || !charCount || !extraPasswordInput ||
    !extraPwGenBtn || !extraPwCopyBtn || !expiryGroup ||
    !expiryCustomWrap || !expiryCustomVal || !expiryCustomUnit ||
    !sealItBtn ||
    !sealedResultWrap || !sealedUrlInline || !sealedResultInfo || !sealedResultWarning ||
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
    overlay, soloPanel, mySealBtn, mySealInline,
    recipientSealInput, sealValidation,
    messageInput, charCount, extraPasswordInput,
    extraPwGenBtn, extraPwCopyBtn, expiryGroup,
    expiryCustomWrap, expiryCustomVal, expiryCustomUnit,
    sealItBtn,
    sealedResultWrap, sealedUrlInline, sealedResultInfo, sealedResultWarning,
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
  let mySealPublicCode = "";

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

  /* ── Expiry helpers ───────────────────────────────────── */

  function selectedExpiryRadio(): string {
    const checked = opts.expiryGroup.querySelector<HTMLInputElement>('input[name="ws-expiry"]:checked');
    return checked?.value ?? "86400000";
  }

  function isCustomExpiry(): boolean {
    return selectedExpiryRadio() === "custom";
  }

  function getExpiryMs(): number {
    const val = selectedExpiryRadio();
    if (val !== "custom") return parseInt(val, 10);
    const n = Math.max(1, parseInt(opts.expiryCustomVal.value, 10) || 1);
    const unit = parseInt(opts.expiryCustomUnit.value, 10);
    return n * unit;
  }

  function syncExpiryCustom(): void {
    const active = isCustomExpiry();
    opts.expiryCustomWrap.classList.toggle("ws-expiry-custom--active", active);
    opts.expiryCustomVal.tabIndex = active ? 0 : -1;
    opts.expiryCustomUnit.tabIndex = active ? 0 : -1;
  }

  /* ── Compose helpers ──────────────────────────────────── */

  function syncCompose(): void {
    const code = opts.recipientSealInput.value.trim();
    const valid = isSealCodeValid(code);
    const hasMsg = opts.messageInput.value.trim().length > 0;

    if (code.length > 0) {
      opts.sealValidation.textContent = valid ? "\u2713 valid public seal" : "\u2717 invalid public seal code";
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
    opts.sealedResultWrap.style.display = "none";
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
    opts.mySealBtn.classList.add("ws-computing");
    log("loading your seal identity...");

    try {
      await delay(COMPUTE_MIN_DISPLAY_MS);
      if (aborted()) return;
      const identity = await getOrCreateSealIdentity();
      if (aborted()) return;
      mySealPublicCode = identity.code;

      opts.sealCode.textContent = identity.code;
      opts.mySealInline.textContent = identity.alias;
      opts.mySealInline.style.display = "";
      opts.mySealInline.title = `Click to copy full seal code (${identity.alias})`;
      log(`seal identity ready: ${identity.alias}`);
      // Stop shimmer, fire copy pulse
      opts.mySealBtn.classList.remove("ws-computing");
      copyToClipboard(identity.code).then(() => {
        if (aborted()) return;
        copyPulse(opts.mySealBtn);
        copyPulse(opts.mySealInline);
      }).catch(() => {});
    } catch (e) {
      if (aborted()) return;
      log(`error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      busy = false;
      opts.mySealBtn.disabled = false;
      opts.mySealBtn.classList.remove("ws-computing");
    }
  }

  /* ── Seal (encrypt) ───────────────────────────────────── */

  async function doSeal(): Promise<void> {
    if (busy) return;
    busy = true;
    opts.sealItBtn.disabled = true;
    opts.sealItBtn.classList.add("ws-computing");

    const recipient = opts.recipientSealInput.value.trim();
    const message = opts.messageInput.value;
    const expiryMs = getExpiryMs();
    const pw = opts.extraPasswordInput.value || undefined;

    log(`sealing message for recipient key (${message.length.toLocaleString()} chars)`);

    try {
      const payload = await sealMessage(recipient, message, expiryMs, pw);
      if (aborted()) return;
      const url = buildSealUrl(payload);

      // Populate inline result
      opts.sealedUrlInline.textContent = url;

      const expiryText = expiryMs > 0 ? expiryLabel(expiryMs) : "no expiry";
      opts.sealedResultInfo.textContent = `for recipient key \u00B7 ${expiryText} \u00B7 ${url.length.toLocaleString()} chars`;

      if (url.length > URL_WARN_LENGTH) {
        opts.sealedResultWarning.textContent =
          `long url — some apps truncate over ${URL_WARN_LENGTH.toLocaleString()} chars`;
        opts.sealedResultWarning.style.display = "";
      } else {
        opts.sealedResultWarning.style.display = "none";
      }

      opts.sealedResultWrap.style.display = "";
      log(`url generated (${url.length.toLocaleString()} chars)`);

      // Auto-copy
      safeCopy(url, opts.sealItBtn, "Copied!");
    } catch (e) {
      if (aborted()) return;
      log(`seal error: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      busy = false;
      opts.sealItBtn.disabled = false;
      opts.sealItBtn.classList.remove("ws-computing");
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
    log("checking sealed message (ws2)...");

    try {
      const identity = await getExistingSealIdentity();
      if (aborted()) return;
      if (identity) {
        mySealPublicCode = identity.code;
        opts.mySealInline.textContent = identity.alias;
        opts.mySealInline.style.display = "";
        opts.mySealInline.title = `Click to copy full seal code (${identity.alias})`;
        log(`local identity: ${identity.alias}`);
      } else {
        log("no local seal identity found");
      }

      const result = await unsealMessage(payload, password);
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
          log("identity mismatch: no matching private key for this message");
          pendingPayload = null;
          break;
        case "identity-missing":
          showUnsealSub(opts.unsealFail);
          log("cannot decrypt: local seal identity is missing in this browser profile");
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

  /** Visual pulse on an element to confirm copy — no text change. */
  function copyPulse(el: HTMLElement): void {
    el.classList.remove("ws-copy-pulse");
    // Force reflow so re-adding the class restarts the animation
    void el.offsetWidth;
    el.classList.add("ws-copy-pulse");
  }

  /* ── Event Listeners ──────────────────────────────────── */

  // My Seal button
  opts.mySealBtn.addEventListener("click", () => generateSeal(), { signal });

  // Inline seal code — click to copy with pulse
  function copySealInline(): void {
    const code = mySealPublicCode;
    if (!code) return;
    copyToClipboard(code).then(() => {
      if (aborted()) return;
      copyPulse(opts.mySealInline);
    }).catch(() => {});
  }
  opts.mySealInline.addEventListener("click", copySealInline, { signal });
  opts.mySealInline.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copySealInline(); }
  }, { signal });

  // My Seal overlay — copy & back (kept for unseal flow)
  opts.sealCopyBtn.addEventListener("click", () => safeCopy(mySealPublicCode, opts.sealCopyBtn), { signal });
  opts.sealBackBtn.addEventListener("click", hideOverlay, { signal });

  // Compose — live validation
  opts.recipientSealInput.addEventListener("input", () => {
    syncCompose();
  }, { signal });

  opts.messageInput.addEventListener("input", () => { syncCompose(); syncCharCount(); }, { signal });
  opts.sealItBtn.addEventListener("click", () => doSeal(), { signal });

  // Inline sealed URL — click to copy with pulse
  function copySealedUrl(): void {
    const url = opts.sealedUrlInline.textContent ?? "";
    if (!url) return;
    copyToClipboard(url).then(() => {
      if (aborted()) return;
      copyPulse(opts.sealedUrlInline);
    }).catch(() => {});
  }
  opts.sealedUrlInline.addEventListener("click", copySealedUrl, { signal });
  opts.sealedUrlInline.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copySealedUrl(); }
  }, { signal });

  // Extra password — generate & copy
  opts.extraPwGenBtn.addEventListener("click", () => {
    const pw = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    opts.extraPasswordInput.value = pw;
    opts.extraPasswordInput.focus();
    try { opts.extraPasswordInput.setSelectionRange(0, pw.length); } catch { /* ignore */ }
    flashText(opts.extraPwGenBtn, "Done");
  }, { signal });

  opts.extraPwCopyBtn.addEventListener("click", async () => {
    const pw = opts.extraPasswordInput.value;
    if (pw) await safeCopy(pw, opts.extraPwCopyBtn, "Copied!");
  }, { signal });

  // Expiry — toggle custom fields on radio change
  opts.expiryGroup.addEventListener("change", syncExpiryCustom, { signal });

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

  // If URL contains a #ws2: fragment, jump straight to unseal
  const autoPayload = parseSealFragment();
  if (autoPayload) {
    ensureEmbedUrlMode();
    log("sealed url detected (ws2)");
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
