/**
 * Whisper Live — UI layer.
 *
 * Bridges WhisperLiveSession to the DOM. Follows the same pattern as whisper-ui.ts:
 * resolveWhisperLiveUIOptions() → initWhisperLive(opts) → returns teardown function.
 */

import {
  WhisperLiveSession,
  WHISPER_LIVE_RTC_LOCAL_ONLY,
  WHISPER_LIVE_RTC_PUBLIC_STUN,
  type LiveState,
  type LiveMessage,
  type TransportMode,
} from "./whisper-live";
import {
  q,
  asInput,
  asButton,
  asPre,
  clearNode,
  formatSize,
  copyToClipboard,
  flashText,
} from "./whisper-ui-helpers";

/* ── Interface & IDs ──────────────────────────────────────── */

export interface WhisperLiveUIOptions {
  page: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;
  liveStatusLine: HTMLElement;

  /* Connection phase */
  liveSection: HTMLElement;
  createBtn: HTMLButtonElement;
  joinInput: HTMLInputElement;
  joinBtn: HTMLButtonElement;
  phraseInput: HTMLInputElement;
  externalAssistToggle: HTMLInputElement;

  /* Offering phase */
  offerSection: HTMLElement;
  offerCode: HTMLElement;
  offerCopyBtn: HTMLButtonElement;
  answerInput: HTMLInputElement;
  answerApplyBtn: HTMLButtonElement;

  /* Answering phase */
  answerSection: HTMLElement;
  answerCode: HTMLElement;
  answerCopyBtn: HTMLButtonElement;

  /* Connecting/handshaking phase */
  connectingSection: HTMLElement;
  connectingStatus: HTMLElement;

  /* Verify phase */
  verifySection: HTMLElement;
  fingerprintDisplay: HTMLElement;
  confirmBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;

  /* Chat phase */
  chatSection: HTMLElement;
  chatMessages: HTMLElement;
  chatInput: HTMLInputElement;
  chatSendBtn: HTMLButtonElement;
  chatFileInput: HTMLInputElement;
  chatFileBtn: HTMLButtonElement;
  transportRadios: NodeListOf<HTMLInputElement>;
  disconnectBtn: HTMLButtonElement;

  /* Silent phase */
  silentSection: HTMLElement;
  silentSecret: HTMLElement;
  silentCopyBtn: HTMLButtonElement;
  silentDisconnectBtn: HTMLButtonElement;

  /* Disconnected phase */
  disconnectedSection: HTMLElement;
  newSessionBtn: HTMLButtonElement;

  /* Error phase */
  errorSection: HTMLElement;
  errorMessage: HTMLElement;
  errorRetryBtn: HTMLButtonElement;
}

export const WHISPER_LIVE_IDS = {
  liveSection: "wl-idle-phase",
  createBtn: "wl-create",
  joinInput: "wl-join-input",
  joinBtn: "wl-join",
  phraseInput: "wl-phrase",
  externalAssistToggle: "wl-external-assist",
  offerSection: "wl-offer-section",
  offerCode: "wl-offer-code",
  offerCopyBtn: "wl-offer-copy",
  answerInput: "wl-answer-input",
  answerApplyBtn: "wl-answer-apply",
  answerSection: "wl-answer-section",
  answerCode: "wl-answer-code",
  answerCopyBtn: "wl-answer-copy",
  connectingSection: "wl-connecting-section",
  connectingStatus: "wl-connecting-status",
  verifySection: "wl-verify-section",
  fingerprintDisplay: "wl-fingerprint",
  confirmBtn: "wl-confirm",
  rejectBtn: "wl-reject",
  chatSection: "wl-chat-section",
  chatMessages: "wl-chat-messages",
  chatInput: "wl-chat-input",
  chatSendBtn: "wl-chat-send",
  chatFileInput: "wl-chat-file-input",
  chatFileBtn: "wl-chat-file-btn",
  disconnectBtn: "wl-disconnect",
  silentSection: "wl-silent-section",
  silentSecret: "wl-silent-secret",
  silentCopyBtn: "wl-silent-copy",
  silentDisconnectBtn: "wl-silent-disconnect",
  disconnectedSection: "wl-disconnected-section",
  newSessionBtn: "wl-new-session",
  errorSection: "wl-error-section",
  errorMessage: "wl-error-message",
  errorRetryBtn: "wl-error-retry",
} as const;

/* ── DOM Helpers ──────────────────────────────────────────── */

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/* ── Resolve ──────────────────────────────────────────────── */

export function resolveWhisperLiveUIOptions(root: ParentNode = document): WhisperLiveUIOptions | null {
  const IDS = WHISPER_LIVE_IDS;

  const page = q(root, "whisper-page");
  const logOutput = asPre(q(root, "whisper-log-output"));
  const logDot = q(root, "whisper-log-dot");
  const liveStatusLine = q(root, "wl-status-line");

  const liveSection = q(root, IDS.liveSection);
  const createBtn = asButton(q(root, IDS.createBtn));
  const joinInput = asInput(q(root, IDS.joinInput));
  const joinBtn = asButton(q(root, IDS.joinBtn));
  const phraseInput = asInput(q(root, IDS.phraseInput));
  const externalAssistToggle = asInput(q(root, IDS.externalAssistToggle));

  const offerSection = q(root, IDS.offerSection);
  const offerCode = q(root, IDS.offerCode);
  const offerCopyBtn = asButton(q(root, IDS.offerCopyBtn));
  const answerInput = asInput(q(root, IDS.answerInput));
  const answerApplyBtn = asButton(q(root, IDS.answerApplyBtn));

  const answerSection = q(root, IDS.answerSection);
  const answerCode = q(root, IDS.answerCode);
  const answerCopyBtn = asButton(q(root, IDS.answerCopyBtn));

  const connectingSection = q(root, IDS.connectingSection);
  const connectingStatus = q(root, IDS.connectingStatus);

  const verifySection = q(root, IDS.verifySection);
  const fingerprintDisplay = q(root, IDS.fingerprintDisplay);
  const confirmBtn = asButton(q(root, IDS.confirmBtn));
  const rejectBtn = asButton(q(root, IDS.rejectBtn));

  const chatSection = q(root, IDS.chatSection);
  const chatMessages = q(root, IDS.chatMessages);
  const chatInput = asInput(q(root, IDS.chatInput));
  const chatSendBtn = asButton(q(root, IDS.chatSendBtn));
  const chatFileInput = asInput(q(root, IDS.chatFileInput));
  const chatFileBtn = asButton(q(root, IDS.chatFileBtn));
  const transportRadios = root.querySelectorAll<HTMLInputElement>('input[name="wl-transport"]');
  const disconnectBtn = asButton(q(root, IDS.disconnectBtn));

  const silentSection = q(root, IDS.silentSection);
  const silentSecret = q(root, IDS.silentSecret);
  const silentCopyBtn = asButton(q(root, IDS.silentCopyBtn));
  const silentDisconnectBtn = asButton(q(root, IDS.silentDisconnectBtn));

  const disconnectedSection = q(root, IDS.disconnectedSection);
  const newSessionBtn = asButton(q(root, IDS.newSessionBtn));

  const errorSection = q(root, IDS.errorSection);
  const errorMessage = q(root, IDS.errorMessage);
  const errorRetryBtn = asButton(q(root, IDS.errorRetryBtn));

  if (
    !page || !logOutput || !logDot || !liveStatusLine ||
    !liveSection || !createBtn || !joinInput || !joinBtn || !phraseInput || !externalAssistToggle ||
    !offerSection || !offerCode || !offerCopyBtn || !answerInput || !answerApplyBtn ||
    !answerSection || !answerCode || !answerCopyBtn ||
    !connectingSection || !connectingStatus ||
    !verifySection || !fingerprintDisplay || !confirmBtn || !rejectBtn ||
    !chatSection || !chatMessages || !chatInput || !chatSendBtn ||
    !chatFileInput || !chatFileBtn || !disconnectBtn ||
    !silentSection || !silentSecret || !silentCopyBtn || !silentDisconnectBtn ||
    !disconnectedSection || !newSessionBtn ||
    !errorSection || !errorMessage || !errorRetryBtn ||
    transportRadios.length === 0
  ) {
    return null;
  }

  return {
    page, logOutput, logDot, liveStatusLine,
    liveSection, createBtn, joinInput, joinBtn, phraseInput, externalAssistToggle,
    offerSection, offerCode, offerCopyBtn, answerInput, answerApplyBtn,
    answerSection, answerCode, answerCopyBtn,
    connectingSection, connectingStatus,
    verifySection, fingerprintDisplay, confirmBtn, rejectBtn,
    chatSection, chatMessages, chatInput, chatSendBtn,
    chatFileInput, chatFileBtn, transportRadios, disconnectBtn,
    silentSection, silentSecret, silentCopyBtn, silentDisconnectBtn,
    disconnectedSection, newSessionBtn,
    errorSection, errorMessage, errorRetryBtn,
  };
}

/* ── Init ─────────────────────────────────────────────────── */

export function initWhisperLive(opts: WhisperLiveUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  let session: WhisperLiveSession | null = null;
  const objectUrls = new Set<string>();
  let busy = false;

  /* ── Phase management ─────────────────────────────────── */

  const allPhases = [
    opts.liveSection,
    opts.offerSection,
    opts.answerSection,
    opts.connectingSection,
    opts.verifySection,
    opts.chatSection,
    opts.silentSection,
    opts.disconnectedSection,
    opts.errorSection,
  ];

  function showPhase(el: HTMLElement): void {
    for (const phase of allPhases) {
      phase.style.display = phase === el ? "" : "none";
    }
  }

  /* ── Log ──────────────────────────────────────────────── */

  function appendLog(line: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    opts.logOutput.textContent += `[${ts}] ${line}\n`;
    opts.logOutput.scrollTop = opts.logOutput.scrollHeight;
  }

  function setLogActive(active: boolean): void {
    opts.logDot.classList.toggle("whisper-log-active", active);
  }

  function updateStatus(text: string): void {
    opts.liveStatusLine.textContent = text;
    opts.liveStatusLine.classList.remove("whisper-status--ready");
  }

  function setBusy(next: boolean): void {
    busy = next;
    updateControls();
  }

  function updateControls(): void {
    const joinHasCode = opts.joinInput.value.trim().length > 0;
    const answerHasCode = opts.answerInput.value.trim().length > 0;
    const hasChatText = opts.chatInput.value.trim().length > 0;
    const hasSession = session !== null;

    opts.createBtn.disabled = busy;
    opts.joinBtn.disabled = busy || !joinHasCode;
    opts.answerApplyBtn.disabled = busy || !hasSession || !answerHasCode;

    // Network mode is a session-level choice; disable toggling once a session exists.
    opts.externalAssistToggle.disabled = busy || hasSession;

    opts.offerCopyBtn.disabled = (opts.offerCode.textContent ?? "").trim().length === 0;
    opts.answerCopyBtn.disabled = (opts.answerCode.textContent ?? "").trim().length === 0;

    opts.chatSendBtn.disabled = busy || !hasSession || !hasChatText;
    opts.chatFileBtn.disabled = busy || !hasSession;

    opts.confirmBtn.disabled = busy || !hasSession;
    opts.rejectBtn.disabled = busy || !hasSession;
    opts.disconnectBtn.disabled = busy || !hasSession;
    opts.silentDisconnectBtn.disabled = busy || !hasSession;
  }

  /* ── Chat rendering ───────────────────────────────────── */

  function addChatMessage(msg: LiveMessage): void {
    const div = document.createElement("div");
    div.className = `wl-msg wl-msg--${msg.direction}`;

    if (msg.type === "text") {
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = msg.text ?? "";
      div.appendChild(textEl);
    } else if (msg.type === "file") {
      const fileEl = document.createElement("div");
      fileEl.className = "wl-msg-file";

      const nameEl = document.createElement("span");
      nameEl.className = "wl-msg-file-name";
      nameEl.textContent = msg.fileName ?? "file";

      const sizeEl = document.createElement("span");
      sizeEl.className = "wl-msg-file-size";
      sizeEl.textContent = msg.fileSize ? formatSize(msg.fileSize) : "";

      fileEl.append(nameEl, sizeEl);

      // Download link if we have file data (peer messages)
      if (msg.fileData) {
        const ab = new ArrayBuffer(msg.fileData.byteLength);
        new Uint8Array(ab).set(msg.fileData);
        const blob = new Blob([ab], { type: msg.fileType ?? "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        objectUrls.add(url);

        const link = document.createElement("a");
        link.className = "wl-msg-file-download";
        link.href = url;
        link.download = msg.fileName ?? "file";
        link.textContent = "download";
        fileEl.appendChild(link);
      }

      div.appendChild(fileEl);
    } else if (msg.type === "system") {
      const sysEl = document.createElement("span");
      sysEl.className = "wl-msg-system";
      sysEl.textContent = msg.text ?? "";
      div.appendChild(sysEl);
    }

    const timeEl = document.createElement("time");
    timeEl.className = "wl-msg-time";
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);

    opts.chatMessages.appendChild(div);
    opts.chatMessages.scrollTop = opts.chatMessages.scrollHeight;
  }

  /* ── Session creation ─────────────────────────────────── */

  function getExternalAssistDefaultFromUrl(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      const ice = (params.get("ice") || "").toLowerCase();
      const stunFlag = (params.get("stun") || "").toLowerCase();
      return ice === "stun" || stunFlag === "1" || stunFlag === "true";
    } catch {
      return false;
    }
  }

  function createSession(): WhisperLiveSession {
    const externalAssist = opts.externalAssistToggle.checked;
    const rtcConfig = externalAssist ? WHISPER_LIVE_RTC_PUBLIC_STUN : WHISPER_LIVE_RTC_LOCAL_ONLY;

    if (externalAssist) {
      appendLog("external assist enabled. helps connect across different networks");
      appendLog("note: may expose network metadata during setup. messages remain end-to-end encrypted");
    } else {
      appendLog("local-only mode. if connecting across networks fails, enable external assist first");
    }

    return new WhisperLiveSession({
      onStateChange: handleStateChange,
      onFingerprint: handleFingerprint,
      onMessage: handleMessage,
      onLog: appendLog,
    }, {
      rtcConfig,
    });
  }

  let previousState: LiveState = "idle";

  function handleStateChange(state: LiveState, detail?: string): void {
    const wasRecovering = previousState === "recovering";
    previousState = state;

    switch (state) {
      case "idle":
        showPhase(opts.liveSection);
        updateStatus("ready to connect");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "offering":
        setLogActive(true);
        updateStatus("creating offer...");
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "creating offer...";
        setBusy(true);
        break;

      case "waiting-for-answer":
        showPhase(opts.offerSection);
        updateStatus("share the offer code, then paste the answer");
        setLogActive(false);
        setBusy(false);
        updateControls();
        setTimeout(() => {
          try { opts.answerInput.focus(); } catch { /* noop */ }
        }, 0);
        break;

      case "answering":
        setLogActive(true);
        updateStatus("creating answer...");
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "creating answer...";
        setBusy(true);
        break;

      case "connecting":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "establishing connection...";
        updateStatus("connecting peer-to-peer...");
        setLogActive(true);
        setBusy(true);
        break;

      case "handshaking":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "exchanging keys...";
        updateStatus("performing key exchange...");
        setBusy(true);
        break;

      case "verifying":
        showPhase(opts.verifySection);
        updateStatus("verify the fingerprint with your peer");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "live":
        showPhase(opts.chatSection);
        updateStatus("session is live");
        opts.liveStatusLine.classList.add("whisper-status--ready");
        setLogActive(false);
        opts.chatInput.disabled = false;
        setBusy(false);
        updateControls();
        opts.chatInput.focus();
        if (wasRecovering) {
          addChatMessage({
            type: "system", direction: "system",
            text: "connection restored",
            timestamp: Date.now(),
          });
        } else {
          addChatMessage({
            type: "system", direction: "system",
            text: "session established, messages are end-to-end encrypted",
            timestamp: Date.now(),
          });
        }
        break;

      case "silent": {
        showPhase(opts.silentSection);
        const secret = session?.getSharedSecret();
        if (secret) {
          opts.silentSecret.textContent = secret;
        }
        updateStatus("shared secret derived. use as Whisper password");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;
      }

      case "recovering":
        showPhase(opts.chatSection);
        updateStatus("connection interrupted, recovering...");
        setLogActive(true);
        opts.chatSendBtn.disabled = true;
        opts.chatFileBtn.disabled = true;
        opts.chatInput.disabled = true;
        addChatMessage({
          type: "system", direction: "system",
          text: "connection interrupted \u2014 attempting to recover...",
          timestamp: Date.now(),
        });
        break;

      case "disconnected":
        showPhase(opts.disconnectedSection);
        updateStatus("session ended");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "error":
        showPhase(opts.errorSection);
        opts.errorMessage.textContent = detail ?? "an error occurred";
        updateStatus("error");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;
    }
  }

  function handleFingerprint(emoji: string): void {
    opts.fingerprintDisplay.textContent = emoji;
  }

  function handleMessage(msg: LiveMessage): void {
    addChatMessage(msg);
  }

  /* ── Reset to idle ─────────────────────────────────────── */

  function resetToIdle(): void {
    if (session) {
      session.disconnect();
      session = null;
    }
    clearNode(opts.chatMessages);
    opts.offerCode.textContent = "";
    opts.answerCode.textContent = "";
    opts.joinInput.value = "";
    opts.answerInput.value = "";
    opts.phraseInput.value = "";
    opts.chatInput.value = "";
    opts.fingerprintDisplay.textContent = "";
    opts.silentSecret.textContent = "";
    opts.errorMessage.textContent = "";
    showPhase(opts.liveSection);
    updateStatus("ready to connect");
    setLogActive(false);
    setBusy(false);
    updateControls();
  }

  /* ── Event Listeners ───────────────────────────────────── */

  // Create channel (offerer)
  opts.createBtn.addEventListener("click", async () => {
    session = createSession();
    const phrase = opts.phraseInput.value || undefined;
    try {
      const offerCode = await session.createOffer(phrase);
      opts.offerCode.textContent = offerCode;
      updateControls();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`offer failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Copy offer code
  opts.offerCopyBtn.addEventListener("click", async () => {
    const code = opts.offerCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.offerCopyBtn, "Copied");
      appendLog("offer code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Apply answer code (offerer)
  opts.answerApplyBtn.addEventListener("click", async () => {
    const code = opts.answerInput.value.trim();
    if (!code || !session) return;
    try {
      await session.applyAnswer(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`answer apply failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Join channel (answerer) — paste offer code
  opts.joinBtn.addEventListener("click", async () => {
    const offerCode = opts.joinInput.value.trim();
    if (!offerCode) return;
    session = createSession();
    const phrase = opts.phraseInput.value || undefined;
    try {
      const answerCodeStr = await session.acceptOffer(offerCode, phrase);
      opts.answerCode.textContent = answerCodeStr;
      showPhase(opts.answerSection);
      updateStatus("share the answer code back to your peer");
      setBusy(false);
      updateControls();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      appendLog(`join failed: ${msg}`);
      handleStateChange("error", msg);
    }
  }, { signal });

  // Copy answer code (answerer)
  opts.answerCopyBtn.addEventListener("click", async () => {
    const code = opts.answerCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.answerCopyBtn, "Copied");
      appendLog("answer code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Confirm fingerprint
  opts.confirmBtn.addEventListener("click", () => {
    session?.confirmFingerprint();
  }, { signal });

  // Reject fingerprint
  opts.rejectBtn.addEventListener("click", () => {
    session?.rejectFingerprint();
  }, { signal });

  // Send text message
  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text || !session) return;
    opts.chatInput.value = "";
    updateControls();
    try {
      await session.sendText(text);
    } catch (err) {
      appendLog(`send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };

  opts.chatSendBtn.addEventListener("click", sendMessage, { signal });
  opts.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, { signal });

  // Keep button states in sync with inputs
  opts.joinInput.addEventListener("input", updateControls, { signal });
  opts.answerInput.addEventListener("input", updateControls, { signal });
  opts.chatInput.addEventListener("input", updateControls, { signal });

  // Send file
  opts.chatFileBtn.addEventListener("click", () => {
    opts.chatFileInput.click();
  }, { signal });

  opts.chatFileInput.addEventListener("change", async () => {
    const file = opts.chatFileInput.files?.[0];
    if (!file || !session) return;
    opts.chatFileInput.value = "";
    try {
      await session.sendFile(file);
    } catch (err) {
      appendLog(`file send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  // File drag-and-drop on chat
  opts.chatMessages.addEventListener("dragover", (e) => {
    e.preventDefault();
    opts.chatMessages.classList.add("wl-chat-drop-active");
  }, { signal });

  opts.chatMessages.addEventListener("dragleave", () => {
    opts.chatMessages.classList.remove("wl-chat-drop-active");
  }, { signal });

  opts.chatMessages.addEventListener("drop", async (e) => {
    e.preventDefault();
    opts.chatMessages.classList.remove("wl-chat-drop-active");
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (!file || !session) return;
    try {
      await session.sendFile(file);
    } catch (err) {
      appendLog(`file send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  // Transport mode selector
  opts.transportRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked && session) {
        session.setTransport(radio.value as TransportMode);
      }
    }, { signal });
  });

  // Disconnect
  opts.disconnectBtn.addEventListener("click", () => {
    session?.disconnect();
  }, { signal });

  // Silent mode copy + disconnect
  opts.silentCopyBtn.addEventListener("click", async () => {
    const secret = opts.silentSecret.textContent ?? "";
    if (!secret) return;
    try {
      await copyToClipboard(secret);
      flashText(opts.silentCopyBtn, "Copied");
      appendLog("shared secret copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  opts.silentDisconnectBtn.addEventListener("click", () => {
    session?.disconnect();
  }, { signal });

  // New session
  opts.newSessionBtn.addEventListener("click", resetToIdle, { signal });

  // Error retry
  opts.errorRetryBtn.addEventListener("click", resetToIdle, { signal });

  /* -- Initial state ---------------------------------------- */

  // Optional URL param prefill for convenience; UI remains the primary control.
  if (getExternalAssistDefaultFromUrl()) {
    opts.externalAssistToggle.checked = true;
  }

  showPhase(opts.liveSection);
  appendLog("live channel ready");
  updateControls();

  /* ── Teardown ───────────────────────────────────────────── */

  return () => {
    ac.abort();
    if (session) {
      session.disconnect();
      session = null;
    }
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  };
}
