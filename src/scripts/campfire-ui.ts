/**
 * Campfire — UI layer.
 *
 * Bridges CampfireNode to the DOM. Follows the same pattern as whisper-live-ui.ts:
 * resolveCampfireUIOptions() → initCampfire(opts) → returns teardown function.
 */

import { CampfireNode } from "./campfire-gossip";
import { type CampfireState, type CampfireMessage, ContentType } from "./campfire-types";
import { TD } from "./whisper-live-crypto";
import { toHex } from "./whisper-wasm";
import {
  q,
  asInput,
  asButton,
  asPre,
  clearNode,
  copyToClipboard,
  flashText,
  appendToLog,
  setLogDotActive,
} from "./whisper-ui-helpers";

/* ═══════════════════════════════════════════════════════════════════
   Interface & IDs
   ═══════════════════════════════════════════════════════════════════ */

export interface CampfireUIOptions {
  page: HTMLElement;
  logOutput: HTMLPreElement;
  logDot: HTMLElement;
  statusLine: HTMLElement;

  /* Idle phase — create or join */
  idleSection: HTMLElement;
  createBtn: HTMLButtonElement;
  nameInput: HTMLInputElement;
  joinInput: HTMLInputElement;
  joinBtn: HTMLButtonElement;
  externalAssistToggle: HTMLInputElement;

  /* Waiting phase — show room code, wait for answer */
  waitingSection: HTMLElement;
  roomCode: HTMLElement;
  roomCodeCopyBtn: HTMLButtonElement;
  answerInput: HTMLInputElement;
  answerApplyBtn: HTMLButtonElement;

  /* Connecting phase */
  connectingSection: HTMLElement;
  connectingStatus: HTMLElement;
  joinerAnswerPanel: HTMLElement;
  joinerCode: HTMLElement;
  joinerCopyBtn: HTMLButtonElement;

  /* Active phase — group chat */
  activeSection: HTMLElement;
  chatMessages: HTMLElement;
  chatInput: HTMLInputElement;
  chatSendBtn: HTMLButtonElement;
  peerList: HTMLElement;
  disconnectBtn: HTMLButtonElement;

  /* DM overlay */
  dmOverlay: HTMLElement;
  dmMessages: HTMLElement;
  dmInput: HTMLInputElement;
  dmSendBtn: HTMLButtonElement;
  dmCloseBtn: HTMLButtonElement;
  dmTargetName: HTMLElement;

  /* Sub-campfire UI */
  subCreateBtn: HTMLButtonElement;

  /* Ended phase */
  endedSection: HTMLElement;
  endedMessage: HTMLElement;
  newCampfireBtn: HTMLButtonElement;
}

export const CAMPFIRE_IDS = {
  statusLine: "wl-status-line", // shared with Live
  idleSection: "cf-idle-phase",
  createBtn: "cf-create",
  nameInput: "cf-name",
  joinInput: "cf-join-input",
  joinBtn: "cf-join",
  externalAssistToggle: "cf-external-assist",
  waitingSection: "cf-waiting-section",
  roomCode: "cf-room-code",
  roomCodeCopyBtn: "cf-room-copy",
  answerInput: "cf-answer-input",
  answerApplyBtn: "cf-answer-apply",
  connectingSection: "cf-connecting-section",
  connectingStatus: "cf-connecting-status",
  joinerAnswerPanel: "cf-joiner-answer",
  joinerCode: "cf-joiner-code",
  joinerCopyBtn: "cf-joiner-copy",
  activeSection: "cf-active-section",
  chatMessages: "cf-chat-messages",
  chatInput: "cf-chat-input",
  chatSendBtn: "cf-chat-send",
  peerList: "cf-peer-list",
  disconnectBtn: "cf-disconnect",
  dmOverlay: "cf-dm-overlay",
  dmMessages: "cf-dm-messages",
  dmInput: "cf-dm-input",
  dmSendBtn: "cf-dm-send",
  dmCloseBtn: "cf-dm-close",
  dmTargetName: "cf-dm-target-name",
  subCreateBtn: "cf-sub-create",
  endedSection: "cf-ended-section",
  endedMessage: "cf-ended-message",
  newCampfireBtn: "cf-new-campfire",
} as const;

/* ═══════════════════════════════════════════════════════════════════
   DOM Helpers
   ═══════════════════════════════════════════════════════════════════ */

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════════
   Resolve
   ═══════════════════════════════════════════════════════════════════ */

export function resolveCampfireUIOptions(root: ParentNode = document): CampfireUIOptions | null {
  const IDS = CAMPFIRE_IDS;

  const page = q(root, "whisper-page");
  const logOutput = asPre(q(root, "whisper-log-output"));
  const logDot = q(root, "whisper-log-dot");
  const statusLine = q(root, IDS.statusLine);

  const idleSection = q(root, IDS.idleSection);
  const createBtn = asButton(q(root, IDS.createBtn));
  const nameInput = asInput(q(root, IDS.nameInput));
  const joinInput = asInput(q(root, IDS.joinInput));
  const joinBtn = asButton(q(root, IDS.joinBtn));
  const externalAssistToggle = asInput(q(root, IDS.externalAssistToggle));

  const waitingSection = q(root, IDS.waitingSection);
  const roomCode = q(root, IDS.roomCode);
  const roomCodeCopyBtn = asButton(q(root, IDS.roomCodeCopyBtn));
  const answerInput = asInput(q(root, IDS.answerInput));
  const answerApplyBtn = asButton(q(root, IDS.answerApplyBtn));

  const connectingSection = q(root, IDS.connectingSection);
  const connectingStatus = q(root, IDS.connectingStatus);
  const joinerAnswerPanel = q(root, IDS.joinerAnswerPanel);
  const joinerCode = q(root, IDS.joinerCode);
  const joinerCopyBtn = asButton(q(root, IDS.joinerCopyBtn));

  const activeSection = q(root, IDS.activeSection);
  const chatMessages = q(root, IDS.chatMessages);
  const chatInput = asInput(q(root, IDS.chatInput));
  const chatSendBtn = asButton(q(root, IDS.chatSendBtn));
  const peerList = q(root, IDS.peerList);
  const disconnectBtn = asButton(q(root, IDS.disconnectBtn));

  const dmOverlay = q(root, IDS.dmOverlay);
  const dmMessages = q(root, IDS.dmMessages);
  const dmInput = asInput(q(root, IDS.dmInput));
  const dmSendBtn = asButton(q(root, IDS.dmSendBtn));
  const dmCloseBtn = asButton(q(root, IDS.dmCloseBtn));
  const dmTargetName = q(root, IDS.dmTargetName);

  const subCreateBtn = asButton(q(root, IDS.subCreateBtn));

  const endedSection = q(root, IDS.endedSection);
  const endedMessage = q(root, IDS.endedMessage);
  const newCampfireBtn = asButton(q(root, IDS.newCampfireBtn));

  if (
    !page || !logOutput || !logDot || !statusLine ||
    !idleSection || !createBtn || !nameInput || !joinInput || !joinBtn || !externalAssistToggle ||
    !waitingSection || !roomCode || !roomCodeCopyBtn || !answerInput || !answerApplyBtn ||
    !connectingSection || !connectingStatus || !joinerAnswerPanel || !joinerCode || !joinerCopyBtn ||
    !activeSection || !chatMessages || !chatInput || !chatSendBtn || !peerList || !disconnectBtn ||
    !dmOverlay || !dmMessages || !dmInput || !dmSendBtn || !dmCloseBtn || !dmTargetName ||
    !subCreateBtn ||
    !endedSection || !endedMessage || !newCampfireBtn
  ) {
    return null;
  }

  return {
    page, logOutput, logDot, statusLine,
    idleSection, createBtn, nameInput, joinInput, joinBtn, externalAssistToggle,
    waitingSection, roomCode, roomCodeCopyBtn, answerInput, answerApplyBtn,
    connectingSection, connectingStatus, joinerAnswerPanel, joinerCode, joinerCopyBtn,
    activeSection, chatMessages, chatInput, chatSendBtn, peerList, disconnectBtn,
    dmOverlay, dmMessages, dmInput, dmSendBtn, dmCloseBtn, dmTargetName,
    subCreateBtn,
    endedSection, endedMessage, newCampfireBtn,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════════════ */

export function initCampfire(opts: CampfireUIOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  let node: CampfireNode | null = null;
  let dmTargetHex: string | null = null;
  let busy = false;

  /* ── Phase management ─────────────────────────────────── */

  const campfirePhases = [
    opts.idleSection,
    opts.waitingSection,
    opts.connectingSection,
    opts.activeSection,
    opts.endedSection,
  ];

  // Live 1:1 phases that must be hidden when campfire is active
  const livePhaseIds = [
    "wl-idle-phase", "wl-offer-section", "wl-answer-section",
    "wl-connecting-section", "wl-verify-section", "wl-chat-section",
    "wl-silent-section", "wl-disconnected-section", "wl-error-section",
  ];

  function showPhase(el: HTMLElement): void {
    // Hide all Live 1:1 phases
    for (const id of livePhaseIds) {
      const phase = document.getElementById(id);
      if (phase) phase.style.display = "none";
    }
    // Show the target campfire phase, hide the rest
    for (const phase of campfirePhases) {
      phase.style.display = phase === el ? "" : "none";
    }
  }

  /* ── Log ──────────────────────────────────────────────── */

  function appendLog(line: string): void {
    appendToLog(opts.logOutput, line);
  }

  function setLogActive(active: boolean): void {
    setLogDotActive(opts.logDot, active);
  }

  function updateStatus(text: string): void {
    opts.statusLine.textContent = text;
  }

  function setBusy(next: boolean): void {
    busy = next;
    updateControls();
  }

  function updateControls(): void {
    const hasName = opts.nameInput.value.trim().length > 0;
    const hasJoinCode = opts.joinInput.value.trim().length > 0;
    const hasAnswerCode = opts.answerInput.value.trim().length > 0;
    const hasChatText = opts.chatInput.value.trim().length > 0;
    const hasNode = node !== null;

    opts.createBtn.disabled = busy || !hasName;
    opts.joinBtn.disabled = busy || !hasJoinCode || !hasName;
    opts.answerApplyBtn.disabled = busy || !hasNode || !hasAnswerCode;
    opts.chatSendBtn.disabled = busy || !hasNode || !hasChatText;
    opts.disconnectBtn.disabled = busy || !hasNode;
  }

  /* ── Chat rendering ───────────────────────────────────── */

  function addChatMessage(name: string, text: string, timestamp: number, direction: "self" | "peer" | "system"): void {
    const div = document.createElement("div");
    div.className = `wl-msg wl-msg--${direction}`;

    if (direction !== "system") {
      const nameEl = document.createElement("span");
      nameEl.className = "cf-msg-name";
      nameEl.textContent = name;
      div.appendChild(nameEl);
    }

    const textEl = document.createElement("span");
    textEl.className = direction === "system" ? "wl-msg-system" : "wl-msg-text";
    textEl.textContent = text;
    div.appendChild(textEl);

    const timeEl = document.createElement("time");
    timeEl.className = "wl-msg-time";
    timeEl.textContent = formatTime(timestamp);
    div.appendChild(timeEl);

    opts.chatMessages.appendChild(div);
    opts.chatMessages.scrollTop = opts.chatMessages.scrollHeight;
  }

  /* ── Peer list rendering ──────────────────────────────── */

  function renderPeerList(peers: ReadonlyArray<{ peerId: Uint8Array; name: string }>): void {
    clearNode(opts.peerList);
    for (const p of peers) {
      const hex = toHex(p.peerId);
      const el = document.createElement("div");
      el.className = "cf-peer-item";
      el.dataset.peerHex = hex;

      const nameEl = document.createElement("span");
      nameEl.className = "cf-peer-name";
      nameEl.textContent = p.name;
      el.appendChild(nameEl);

      // Click to DM
      el.addEventListener("click", () => {
        if (!node) return;
        openDmPanel(hex, p.name);
      }, { signal });

      opts.peerList.appendChild(el);
    }
  }

  /* ── DM Panel ─────────────────────────────────────────── */

  function openDmPanel(peerHex: string, name: string): void {
    dmTargetHex = peerHex;
    opts.dmTargetName.textContent = name;
    clearNode(opts.dmMessages);
    opts.dmOverlay.style.display = "";
    opts.dmInput.focus();

    // Initiate DM session if not already connected
    node?.startDm(peerHex);
  }

  function closeDmPanel(): void {
    dmTargetHex = null;
    opts.dmOverlay.style.display = "none";
  }

  /* ── Callbacks ────────────────────────────────────────── */

  function handleStateChange(state: CampfireState, detail?: string): void {
    switch (state) {
      case "idle":
        showPhase(opts.idleSection);
        updateStatus("ready to connect");
        setLogActive(false);
        setBusy(false);
        break;

      case "creating":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "setting up the room...";
        updateStatus("creating room...");
        setLogActive(true);
        setBusy(true);
        break;

      case "waiting":
        showPhase(opts.waitingSection);
        updateStatus("room open, waiting for peers");
        setLogActive(false);
        setBusy(false);
        updateControls();
        break;

      case "connecting":
        showPhase(opts.connectingSection);
        opts.connectingStatus.textContent = "joining the room...";
        updateStatus("connecting peer-to-peer...");
        setLogActive(true);
        setBusy(true);
        break;

      case "active":
        showPhase(opts.activeSection);
        updateStatus("in the room, encrypted");
        setLogActive(false);
        opts.chatInput.disabled = false;
        setBusy(false);
        opts.chatInput.focus();
        addChatMessage("", "you're in. everything here is end-to-end encrypted", Date.now(), "system");
        break;

      case "ended":
        showPhase(opts.endedSection);
        opts.endedMessage.textContent = detail ?? "the campfire is out. nothing remains.";
        updateStatus("session closed");
        setLogActive(false);
        setBusy(false);
        closeDmPanel();
        break;
    }
  }

  function handleMessage(msg: CampfireMessage): void {
    const isSelf = msg.senderIdHex === node?.getPeerIdHex();
    if (isSelf) return; // already shown locally

    if (msg.contentType === ContentType.Text) {
      const text = TD.decode(msg.plaintext);
      addChatMessage(msg.senderName, text, msg.timestamp, "peer");
    } else if (msg.contentType === ContentType.System) {
      const text = TD.decode(msg.plaintext);
      addChatMessage("", text, msg.timestamp, "system");
    }
  }

  function handlePeerJoin(_peerId: Uint8Array, name: string): void {
    addChatMessage("", `${name} joined the room`, Date.now(), "system");
  }

  function handlePeerLeave(peerId: Uint8Array): void {
    const hex = toHex(peerId);
    addChatMessage("", `${hex.slice(0, 8)} left the room`, Date.now(), "system");
  }

  function handleDmMessage(fromPeerId: Uint8Array, msg: { type: "text"; text: string; timestamp: number }): void {
    const hex = toHex(fromPeerId);
    if (dmTargetHex === hex && opts.dmOverlay.style.display !== "none") {
      // Show in DM panel
      const div = document.createElement("div");
      div.className = "wl-msg wl-msg--peer";
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = msg.text;
      div.appendChild(textEl);
      const timeEl = document.createElement("time");
      timeEl.className = "wl-msg-time";
      timeEl.textContent = formatTime(msg.timestamp);
      div.appendChild(timeEl);
      opts.dmMessages.appendChild(div);
      opts.dmMessages.scrollTop = opts.dmMessages.scrollHeight;
    }
  }

  /* ── Reset to idle ──────────────────────────────────────── */

  function resetToIdle(): void {
    if (node) {
      node.destroy();
      node = null;
    }
    clearNode(opts.chatMessages);
    clearNode(opts.peerList);
    opts.roomCode.textContent = "";
    opts.joinInput.value = "";
    opts.answerInput.value = "";
    opts.chatInput.value = "";
    opts.endedMessage.textContent = "";
    opts.joinerCode.textContent = "";
    opts.joinerAnswerPanel.style.display = "none";
    closeDmPanel();
    showPhase(opts.idleSection);
    updateStatus("ready");
    setLogActive(false);
    setBusy(false);
    updateControls();
  }

  /* ── Event Listeners ─────────────────────────────────────── */

  // Create campfire (Root)
  opts.createBtn.addEventListener("click", async () => {
    const name = opts.nameInput.value.trim() || "someone";
    const useStun = opts.externalAssistToggle.checked;
    node = new CampfireNode({
      onStateChange: handleStateChange,
      onMessage: handleMessage,
      onPeerJoin: handlePeerJoin,
      onPeerLeave: handlePeerLeave,
      onPeerListUpdate: renderPeerList,
      onLog: appendLog,
      onDmMessage: handleDmMessage,
      onSubCampfireInvite: () => {},
    });
    try {
      const code = await node.createCampfire(name, useStun);
      opts.roomCode.textContent = code;
      updateControls();
    } catch (err) {
      appendLog(`create failed: ${err instanceof Error ? err.message : "unknown"}`);
      handleStateChange("ended", "could not create room");
    }
  }, { signal });

  // Copy room code
  opts.roomCodeCopyBtn.addEventListener("click", async () => {
    const code = opts.roomCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.roomCodeCopyBtn, "Copied");
      appendLog("room code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Copy joiner answer code
  opts.joinerCopyBtn.addEventListener("click", async () => {
    const code = opts.joinerCode.textContent ?? "";
    if (!code) return;
    try {
      await copyToClipboard(code);
      flashText(opts.joinerCopyBtn, "Copied");
      appendLog("answer code copied to clipboard");
    } catch {
      appendLog("copy failed");
    }
  }, { signal });

  // Apply answer (Root)
  opts.answerApplyBtn.addEventListener("click", async () => {
    const code = opts.answerInput.value.trim();
    if (!code || !node) return;
    try {
      await node.applyAnswer(code);
    } catch (err) {
      appendLog(`answer apply failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  // Join campfire (Peer)
  opts.joinBtn.addEventListener("click", async () => {
    const offerCode = opts.joinInput.value.trim();
    const name = opts.nameInput.value.trim() || "someone";
    if (!offerCode) return;
    const useStun = opts.externalAssistToggle.checked;
    node = new CampfireNode({
      onStateChange: handleStateChange,
      onMessage: handleMessage,
      onPeerJoin: handlePeerJoin,
      onPeerLeave: handlePeerLeave,
      onPeerListUpdate: renderPeerList,
      onLog: appendLog,
      onDmMessage: handleDmMessage,
      onSubCampfireInvite: () => {},
    });
    try {
      const answerCode = await node.joinCampfire(offerCode, name, useStun);
      // Show answer code so joiner can copy it back to root
      opts.joinerCode.textContent = answerCode;
      opts.joinerAnswerPanel.style.display = "";
      opts.connectingStatus.textContent = "send this reply code back to whoever created the room";
      appendLog(`answer code ready. share it back`);
    } catch (err) {
      appendLog(`join failed: ${err instanceof Error ? err.message : "unknown"}`);
      handleStateChange("ended", "could not join the room");
    }
  }, { signal });

  // Send chat message
  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text || !node) return;
    opts.chatInput.value = "";
    updateControls();
    try {
      await node.broadcastText(text);
      addChatMessage(node.getDisplayName(), text, Date.now(), "self");
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

  // Input change tracking
  opts.nameInput.addEventListener("input", updateControls, { signal });
  opts.joinInput.addEventListener("input", updateControls, { signal });
  opts.answerInput.addEventListener("input", updateControls, { signal });
  opts.chatInput.addEventListener("input", updateControls, { signal });

  // Disconnect
  opts.disconnectBtn.addEventListener("click", () => {
    node?.endCampfire("you left the room");
  }, { signal });

  // DM send
  opts.dmSendBtn.addEventListener("click", async () => {
    const text = opts.dmInput.value.trim();
    if (!text || !node || !dmTargetHex) return;
    opts.dmInput.value = "";
    try {
      await node.sendDmText(dmTargetHex, text);
      // Show locally in DM panel
      const div = document.createElement("div");
      div.className = "wl-msg wl-msg--self";
      const textEl = document.createElement("span");
      textEl.className = "wl-msg-text";
      textEl.textContent = text;
      div.appendChild(textEl);
      const timeEl = document.createElement("time");
      timeEl.className = "wl-msg-time";
      timeEl.textContent = formatTime(Date.now());
      div.appendChild(timeEl);
      opts.dmMessages.appendChild(div);
      opts.dmMessages.scrollTop = opts.dmMessages.scrollHeight;
    } catch (err) {
      appendLog(`dm send failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }, { signal });

  opts.dmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      opts.dmSendBtn.click();
    }
  }, { signal });

  // DM close
  opts.dmCloseBtn.addEventListener("click", closeDmPanel, { signal });

  // Sub-campfire create (placeholder — needs peer selection UI)
  opts.subCreateBtn.addEventListener("click", () => {
    appendLog("split: select peers from the list first");
  }, { signal });

  // New campfire
  opts.newCampfireBtn.addEventListener("click", resetToIdle, { signal });

  /* ── Initial state ──────────────────────────────────────── */

  showPhase(opts.idleSection);
  appendLog("campfire ready");
  updateControls();

  /* ── Teardown ────────────────────────────────────────────── */

  return () => {
    ac.abort();
    if (node) {
      node.destroy();
      node = null;
    }
  };
}
