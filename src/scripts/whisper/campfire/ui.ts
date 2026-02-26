/**
 * Campfire — UI layer.
 *
 * Bridges CampfireNode to the DOM. Follows the same pattern as whisper-live-ui.ts:
 * resolveCampfireUIOptions() → initCampfire(opts) → returns teardown function.
 */

import { CampfireNode } from "./gossip";
import { hostCampfireViaFlare, joinCampfireViaFlare } from "./flare";
import { type CampfireState, type CampfireMessage, ContentType } from "./types";
import { TD } from "../live-crypto";
import { toHex } from "../wasm";
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
} from "../ui-helpers";

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
  flarePhraseInput: HTMLInputElement;
  flareJoinBtn: HTMLButtonElement;
  hostFlarePhraseInput: HTMLInputElement;
  hostFlareToggleBtn: HTMLButtonElement;
  hostFlareToggleActiveBtn: HTMLButtonElement;
  hostFlareState: HTMLElement;
  externalAssistToggle: HTMLInputElement;

  /* Waiting phase — show room code, wait for answer */
  waitingSection: HTMLElement;
  roomCode: HTMLElement;
  roomCodeCopyBtn: HTMLButtonElement;
  roomCodeShareBtn: HTMLButtonElement;
  answerInput: HTMLInputElement;
  answerApplyBtn: HTMLButtonElement;

  /* Connecting phase */
  connectingSection: HTMLElement;
  connectingStatus: HTMLElement;
  joinerAnswerPanel: HTMLElement;
  joinerCode: HTMLElement;
  joinerCopyBtn: HTMLButtonElement;
  joinerShareBtn: HTMLButtonElement;

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

  /* Ended phase */
  endedSection: HTMLElement;
  endedMessage: HTMLElement;
  newCampfireBtn: HTMLButtonElement;
}

interface CampfireBootstrapDetail {
  source?: string;
  phrase?: string;
}

export const CAMPFIRE_IDS = {
  statusLine: "wl-status-line", // shared with Live
  idleSection: "cf-idle-phase",
  createBtn: "cf-create",
  nameInput: "cf-name",
  joinInput: "cf-join-input",
  joinBtn: "cf-join",
  flarePhraseInput: "cf-flare-phrase",
  flareJoinBtn: "cf-flare-join",
  hostFlarePhraseInput: "cf-host-flare-phrase",
  hostFlareToggleBtn: "cf-host-flare-toggle",
  hostFlareToggleActiveBtn: "cf-host-flare-toggle-active",
  hostFlareState: "cf-host-flare-state",
  externalAssistToggle: "cf-external-assist",
  waitingSection: "cf-waiting-section",
  roomCode: "cf-room-code",
  roomCodeCopyBtn: "cf-room-copy",
  roomCodeShareBtn: "cf-room-share",
  answerInput: "cf-answer-input",
  answerApplyBtn: "cf-answer-apply",
  connectingSection: "cf-connecting-section",
  connectingStatus: "cf-connecting-status",
  joinerAnswerPanel: "cf-joiner-answer",
  joinerCode: "cf-joiner-code",
  joinerCopyBtn: "cf-joiner-copy",
  joinerShareBtn: "cf-joiner-share",
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
  const flarePhraseInput = asInput(q(root, IDS.flarePhraseInput));
  const flareJoinBtn = asButton(q(root, IDS.flareJoinBtn));
  const hostFlarePhraseInput = asInput(q(root, IDS.hostFlarePhraseInput));
  const hostFlareToggleBtn = asButton(q(root, IDS.hostFlareToggleBtn));
  const hostFlareToggleActiveBtn = asButton(q(root, IDS.hostFlareToggleActiveBtn));
  const hostFlareState = q(root, IDS.hostFlareState);
  const externalAssistToggle = asInput(q(root, IDS.externalAssistToggle));

  const waitingSection = q(root, IDS.waitingSection);
  const roomCode = q(root, IDS.roomCode);
  const roomCodeCopyBtn = asButton(q(root, IDS.roomCodeCopyBtn));
  const roomCodeShareBtn = asButton(q(root, IDS.roomCodeShareBtn));
  const answerInput = asInput(q(root, IDS.answerInput));
  const answerApplyBtn = asButton(q(root, IDS.answerApplyBtn));

  const connectingSection = q(root, IDS.connectingSection);
  const connectingStatus = q(root, IDS.connectingStatus);
  const joinerAnswerPanel = q(root, IDS.joinerAnswerPanel);
  const joinerCode = q(root, IDS.joinerCode);
  const joinerCopyBtn = asButton(q(root, IDS.joinerCopyBtn));
  const joinerShareBtn = asButton(q(root, IDS.joinerShareBtn));

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

  const endedSection = q(root, IDS.endedSection);
  const endedMessage = q(root, IDS.endedMessage);
  const newCampfireBtn = asButton(q(root, IDS.newCampfireBtn));

  if (
    !page || !logOutput || !logDot || !statusLine ||
    !idleSection || !createBtn || !nameInput || !joinInput || !joinBtn ||
    !flarePhraseInput || !flareJoinBtn ||
    !hostFlarePhraseInput || !hostFlareToggleBtn || !hostFlareToggleActiveBtn || !hostFlareState ||
    !externalAssistToggle ||
    !waitingSection || !roomCode || !roomCodeCopyBtn || !answerInput || !answerApplyBtn ||
    !roomCodeShareBtn ||
    !connectingSection || !connectingStatus || !joinerAnswerPanel || !joinerCode || !joinerCopyBtn ||
    !joinerShareBtn ||
    !activeSection || !chatMessages || !chatInput || !chatSendBtn || !peerList || !disconnectBtn ||
    !dmOverlay || !dmMessages || !dmInput || !dmSendBtn || !dmCloseBtn || !dmTargetName ||
    !endedSection || !endedMessage || !newCampfireBtn
  ) {
    return null;
  }

  return {
    page, logOutput, logDot, statusLine,
    idleSection, createBtn, nameInput, joinInput, joinBtn,
    flarePhraseInput, flareJoinBtn,
    hostFlarePhraseInput, hostFlareToggleBtn, hostFlareToggleActiveBtn, hostFlareState,
    externalAssistToggle,
    waitingSection, roomCode, roomCodeCopyBtn, roomCodeShareBtn, answerInput, answerApplyBtn,
    connectingSection, connectingStatus, joinerAnswerPanel, joinerCode, joinerCopyBtn, joinerShareBtn,
    activeSection, chatMessages, chatInput, chatSendBtn, peerList, disconnectBtn,
    dmOverlay, dmMessages, dmInput, dmSendBtn, dmCloseBtn, dmTargetName,
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
  let flareAbort: AbortController | null = null;
  let flareMode: "host" | "join" | null = null;
  let busy = false;
  let knownPeerNames = new Map<string, string>();
  /** displayId → DOM element, for REACT lookups. */
  const msgById = new Map<number, HTMLElement>();
  /** displayId → full 32-byte msgId (SHA-256), needed to call broadcastReact. */
  const msgIdFullById = new Map<number, Uint8Array>();

  const onBootstrap = (event: Event) => {
    const custom = event as CustomEvent<CampfireBootstrapDetail>;
    if (opts.page.dataset.mode !== "live") return;

    const liveVisible = opts.idleSection.style.display !== "none"
      || opts.waitingSection.style.display !== "none"
      || opts.connectingSection.style.display !== "none"
      || opts.activeSection.style.display !== "none";
    if (!liveVisible) return;

    if (custom.detail?.phrase) {
      opts.hostFlarePhraseInput.value = custom.detail.phrase;
      opts.flarePhraseInput.value = custom.detail.phrase;
    }

    if (!node || node.getRole() !== "root") return;
    if (node.state !== "waiting" && node.state !== "active") return;
    if (flareAbort === null) {
      const phrase = opts.hostFlarePhraseInput.value.trim();
      if (phrase) startHostFlareGate(phrase);
    }
  };

  window.addEventListener("whisper-campfire-bootstrap", onBootstrap as EventListener, { signal });

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
    const hasFlarePhrase = opts.flarePhraseInput.value.trim().length > 0;
    const hasHostFlarePhrase = opts.hostFlarePhraseInput.value.trim().length > 0;
    const flareActive = flareAbort !== null;
    const hostGateOpen = flareActive && flareMode === "host";
    const hostCanGate = hasNode && node?.getRole() === "root";

    opts.createBtn.disabled = busy || flareActive || !hasName;
    opts.joinBtn.disabled = busy || flareActive || !hasJoinCode || !hasName;
    opts.flareJoinBtn.disabled = busy || flareActive || !hasName || !hasFlarePhrase;
    opts.hostFlarePhraseInput.disabled = busy || !hostCanGate || hostGateOpen;
    opts.hostFlareToggleBtn.disabled = busy || !hostCanGate || (!hostGateOpen && !hasHostFlarePhrase);
    opts.hostFlareToggleActiveBtn.disabled = busy || !hostCanGate;
    opts.hostFlareToggleBtn.textContent = hostGateOpen ? "Close gate" : "Open gate";
    opts.hostFlareToggleActiveBtn.textContent = hostGateOpen ? "Close gate" : "Open gate";
    opts.hostFlareToggleActiveBtn.style.display = hostCanGate ? "" : "none";
    opts.hostFlareState.textContent = hostGateOpen ? "gate open" : "gate closed";
    opts.answerApplyBtn.disabled = busy || !hasNode || !hasAnswerCode;
    opts.roomCodeShareBtn.disabled = (opts.roomCode.textContent ?? "").trim().length === 0;
    opts.joinerShareBtn.disabled = (opts.joinerCode.textContent ?? "").trim().length === 0;
    opts.chatSendBtn.disabled = busy || !hasNode || !hasChatText;
    opts.disconnectBtn.disabled = busy || !hasNode;
    opts.dmSendBtn.disabled = busy || !hasNode || !dmTargetHex || opts.dmInput.value.trim().length === 0;
    opts.externalAssistToggle.disabled = flareActive;
  }

  function clearFlareState(): void {
    if (flareAbort) {
      flareAbort.abort();
      flareAbort = null;
    }
    flareMode = null;
    updateControls();
  }

  function startHostFlareGate(phrase: string): void {
    if (!node) return;
    clearFlareState();
    flareAbort = new AbortController();
    flareMode = "host";
    appendLog("campfire gate opened via flare");
    updateStatus("campfire gate open");
    updateControls();

    void hostCampfireViaFlare({
      phrase,
      getCurrentOfferCode: () => node?.getCurrentOfferCode() ?? null,
      applyAnswerCode: async (answerCode: string) => {
        if (!node) throw new Error("node-unavailable");
        await node.applyAnswer(answerCode);
      },
      onStatus: updateStatus,
      onLog: appendLog,
      signal: flareAbort.signal,
    }).catch((err) => {
      const raw = err instanceof Error ? err.message : "unknown";
      if (raw !== "Aborted") {
        appendLog(`campfire gate failed: ${raw}`);
        handleStateChange("ended", flareFriendlyError(raw));
      }
    }).finally(() => {
      if (flareMode === "host") {
        flareAbort = null;
        flareMode = null;
        if (node && node.state === "waiting") {
          updateStatus("room open, waiting for peers");
        }
        updateControls();
      }
    });
  }

  function flareFriendlyError(raw: string): string {
    if (raw.includes("peer-not-found")) {
      return "couldn't find that campfire flare. check phrase and try again";
    }
    if (raw.includes("relay-unavailable")) {
      return "relay unavailable right now. try again in a moment";
    }
    if (raw.includes("no-offer-code")) {
      return "host flare is warming up. wait a second and try again";
    }
    if (raw.includes("handshake-failed")) {
      return "flare handshake failed. retry with the same phrase";
    }
    return raw;
  }

  /* ── Chat rendering ───────────────────────────────────── */

  function addChatMessage(
    name: string, text: string, timestamp: number, direction: "self" | "peer" | "system",
    displayId?: number, msgIdFull?: Uint8Array,
  ): void {
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

    // Track by displayId for reactions (only for real messages, not system)
    if (displayId !== undefined && msgIdFull !== undefined && direction !== "system") {
      div.dataset.msgId = String(displayId);
      msgById.set(displayId, div);
      msgIdFullById.set(displayId, msgIdFull);

        // Emoji picker — button that opens a dropdown with predefined reactions and emoji picker
        const picker = document.createElement("div");
        picker.className = "wl-react-picker";
        picker.setAttribute("aria-label", "React");
        
        const pickerBtn = document.createElement("button");
        pickerBtn.type = "button";
        pickerBtn.className = "wl-react-pick-btn";
        pickerBtn.textContent = "+";
        pickerBtn.title = "React with emoji";
        pickerBtn.setAttribute("aria-label", "React with emoji");
        
        const dropdown = document.createElement("div");
        dropdown.className = "wl-react-dropdown";
        dropdown.setAttribute("role", "menu");
        dropdown.setAttribute("aria-label", "Reaction options");
        
        // Predefined reactions
        const predefined = ["👍", "👎", "❤️"];
        // Get last used emoji from localStorage
        const lastUsed = localStorage.getItem("cf-last-reaction");
        if (lastUsed && !predefined.includes(lastUsed)) {
          predefined.push(lastUsed);
        }
        
        predefined.forEach((emoji) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "wl-react-option";
          btn.textContent = emoji;
          btn.setAttribute("role", "menuitem");
          btn.setAttribute("aria-label", `React with ${emoji}`);
          btn.addEventListener("click", () => {
            toggleCfReaction(displayId!, emoji);
            localStorage.setItem("cf-last-reaction", emoji);
            dropdown.style.display = "none";
          });
          dropdown.appendChild(btn);
        });
        
        // Emoji picker button (opens OS emoji picker)
        const emojiPickerBtn = document.createElement("button");
        emojiPickerBtn.type = "button";
        emojiPickerBtn.className = "wl-react-emoji-picker";
        emojiPickerBtn.textContent = "😀";
        emojiPickerBtn.title = "Pick any emoji";
        emojiPickerBtn.setAttribute("aria-label", "Pick any emoji");
        
        const hiddenInput = document.createElement("input");
        hiddenInput.type = "text";
        hiddenInput.className = "wl-react-hidden-input";
        hiddenInput.style.position = "absolute";
        hiddenInput.style.left = "-9999px";
        hiddenInput.style.top = "-9999px";
        hiddenInput.setAttribute("aria-hidden", "true");
        hiddenInput.addEventListener("input", (e) => {
          e.stopPropagation();
          const raw = hiddenInput.value;
          hiddenInput.value = "";
          if (!raw || displayId === undefined) return;
          // Extract the first grapheme cluster
          const seg = new Intl.Segmenter().segment(raw.replace(/\s/g, ""));
          const first = seg[Symbol.iterator]().next().value;
          const emoji = first?.segment ?? raw[0];
          if (emoji) {
            toggleCfReaction(displayId!, emoji);
            localStorage.setItem("cf-last-reaction", emoji);
            dropdown.style.display = "none";
          }
        });
        
        emojiPickerBtn.addEventListener("click", () => {
          hiddenInput.focus();
          // Trigger OS emoji picker (works on most browsers/OSes)
          if ("execCommand" in document) {
            // For older browsers
            document.execCommand("insertText", false, "");
          }
        });
        
        dropdown.appendChild(emojiPickerBtn);
        picker.appendChild(pickerBtn);
        picker.appendChild(dropdown);
        picker.appendChild(hiddenInput);
        div.appendChild(picker);
        
        // Toggle dropdown on button click
        pickerBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          dropdown.style.display = dropdown.style.display === "block" ? "none" : "block";
        });
        
        // Close dropdown when clicking outside
        const closeDropdown = (e: MouseEvent) => {
          if (!picker.contains(e.target as Node)) {
            dropdown.style.display = "none";
          }
        };
        document.addEventListener("click", closeDropdown);
    }

    opts.chatMessages.appendChild(div);
    opts.chatMessages.scrollTop = opts.chatMessages.scrollHeight;
  }

  /* ── Reaction helpers ─────────────────────────────────── */

  function applyCfReaction(displayId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(displayId);
    if (!el || !emoji) return;
    let bar = el.querySelector<HTMLElement>(".wl-msg-reactions");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "wl-msg-reactions";
      el.appendChild(bar);
    }
    let pill = bar.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(emoji)}"]`);
    if (!pill) {
      const btn = document.createElement("button");
      btn.type = "button";
      pill = btn;
      pill.className = "wl-reaction";
      pill.dataset.emoji = emoji;
      pill.dataset.self = "0";
      pill.dataset.peer = "0";
      pill.textContent = emoji;
      pill.addEventListener("click", () => toggleCfReaction(displayId, emoji));
      bar.appendChild(pill);
    }
    pill.dataset[who] = "1";
    pill.classList.toggle("wl-reaction--self", pill.dataset.self === "1");
    pill.classList.toggle("wl-reaction--peer", pill.dataset.peer === "1");
  }

  function removeCfReaction(displayId: number, emoji: string, who: "self" | "peer"): void {
    const el = msgById.get(displayId);
    if (!el) return;
    const pill = el.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(emoji)}"]`);
    if (!pill) return;
    pill.dataset[who] = "0";
    pill.classList.toggle("wl-reaction--self", pill.dataset.self === "1");
    pill.classList.toggle("wl-reaction--peer", pill.dataset.peer === "1");
    if (pill.dataset.self === "0" && pill.dataset.peer === "0") pill.remove();
    const bar = el.querySelector(".wl-msg-reactions");
    if (bar && !bar.hasChildNodes()) bar.remove();
  }

  function toggleCfReaction(displayId: number, emoji: string): void {
    if (!node) return;
    const msgIdFull = msgIdFullById.get(displayId);
    if (!msgIdFull) return;
    const el = msgById.get(displayId);
    const pill = el?.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(emoji)}"]`);
    const isUnreact = pill?.dataset.self === "1";
    node.broadcastReact(msgIdFull, emoji, isUnreact);
    if (isUnreact) {
      removeCfReaction(displayId, emoji, "self");
    } else {
      applyCfReaction(displayId, emoji, "self");
    }
  }

  /* ── Peer list rendering ──────────────────────────────── */

  function renderPeerList(peers: ReadonlyArray<{ peerId: Uint8Array; name: string }>): void {
    knownPeerNames = new Map(peers.map((p) => [toHex(p.peerId), p.name]));
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
    updateControls();

    // Initiate DM session if not already connected
    node?.startDm(peerHex);
  }

  function closeDmPanel(): void {
    dmTargetHex = null;
    opts.dmOverlay.style.display = "none";
    opts.dmInput.value = "";
    updateControls();
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
        opts.hostFlareToggleActiveBtn.style.display = "";
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
        opts.hostFlareToggleActiveBtn.style.display = node?.getRole() === "root" ? "" : "none";
        opts.chatInput.focus();
        addChatMessage("", "you're in. everything here is end-to-end encrypted", Date.now(), "system");
        break;

      case "ended":
        clearFlareState();
        showPhase(opts.endedSection);
        opts.endedMessage.textContent = detail ?? "the campfire is out. nothing remains.";
        updateStatus("session closed");
        setLogActive(false);
        setBusy(false);
        opts.hostFlareToggleActiveBtn.style.display = "none";
        closeDmPanel();
        break;
    }
  }

  function createNodeInstance(): CampfireNode {
    if (node) {
      node.destroy();
      node = null;
    }

    return new CampfireNode({
      onStateChange: handleStateChange,
      onMessage: handleMessage,
      onPeerJoin: handlePeerJoin,
      onPeerLeave: handlePeerLeave,
      onPeerListUpdate: renderPeerList,
      onLog: appendLog,
      onRoomCodeUpdate: (code: string) => {
        opts.roomCode.textContent = code;
        updateControls();
      },
      onDmMessage: handleDmMessage,
      onReact: (displayId, emoji, _senderHex) => applyCfReaction(displayId, emoji, "peer"),
      onUnreact: (displayId, emoji, _senderHex) => removeCfReaction(displayId, emoji, "peer"),
    });
  }

  function handleMessage(msg: CampfireMessage): void {
    const isSelf = msg.senderIdHex === node?.getPeerIdHex();
    const direction = isSelf ? "self" : "peer";

    if (msg.contentType === ContentType.Text) {
      const text = TD.decode(msg.plaintext);
      const display = isSelf
        ? (node?.getDisplayName() ?? "you")
        : (knownPeerNames.get(msg.senderIdHex) ?? `${msg.senderIdHex.slice(0, 8)}...`);
      addChatMessage(display, text, msg.timestamp, direction, msg.displayId, msg.msgId);
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
    const name = knownPeerNames.get(hex) ?? `${hex.slice(0, 8)}`;
    addChatMessage("", `${name} left the room`, Date.now(), "system");
  }

  function handleDmMessage(fromPeerId: Uint8Array, msg: { type: "text"; text: string; timestamp: number }): void {
    const hex = toHex(fromPeerId);
    const fromName = knownPeerNames.get(hex) ?? `${hex.slice(0, 8)}...`;
    if (dmTargetHex !== hex || opts.dmOverlay.style.display === "none") {
      openDmPanel(hex, fromName);
    }
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
    clearFlareState();
    if (node) {
      node.destroy();
      node = null;
    }
    clearNode(opts.chatMessages);
    msgById.clear();
    msgIdFullById.clear();
    clearNode(opts.peerList);
    opts.roomCode.textContent = "";
    opts.joinInput.value = "";
    opts.flarePhraseInput.value = "";
    opts.hostFlarePhraseInput.value = "";
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
    opts.hostFlareToggleActiveBtn.style.display = "none";
    updateControls();
  }

  /* ── Event Listeners ─────────────────────────────────────── */

  // Create campfire (Root)
  opts.createBtn.addEventListener("click", async () => {
    const name = opts.nameInput.value.trim() || "someone";
    const useStun = opts.externalAssistToggle.checked;
    node = createNodeInstance();
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

  opts.roomCodeShareBtn.addEventListener("click", async () => {
    const code = (opts.roomCode.textContent ?? "").trim();
    if (!code) return;
    try {
      if (navigator.share) {
        await navigator.share({ text: code });
      } else {
        await copyToClipboard(code);
        flashText(opts.roomCodeShareBtn, "Copied");
      }
      appendLog("room code shared");
    } catch {
      appendLog("share cancelled or unavailable");
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

  opts.joinerShareBtn.addEventListener("click", async () => {
    const code = (opts.joinerCode.textContent ?? "").trim();
    if (!code) return;
    try {
      if (navigator.share) {
        await navigator.share({ text: code });
      } else {
        await copyToClipboard(code);
        flashText(opts.joinerShareBtn, "Copied");
      }
      appendLog("answer code shared");
    } catch {
      appendLog("share cancelled or unavailable");
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
    node = createNodeInstance();
    try {
      const answerCode = await node.joinCampfire(offerCode, name, useStun);
      // Show answer code so joiner can copy it back to root
      opts.joinerCode.textContent = answerCode;
      opts.joinerAnswerPanel.style.display = "";
      opts.connectingStatus.textContent = "send this reply code back to whoever created the room";
      appendLog("answer code ready, share it back");
    } catch (err) {
      appendLog(`join failed: ${err instanceof Error ? err.message : "unknown"}`);
      handleStateChange("ended", "could not join the room");
    }
  }, { signal });

  // Join campfire via flare backend
  opts.flareJoinBtn.addEventListener("click", async () => {
    const phrase = opts.flarePhraseInput.value.trim();
    const name = opts.nameInput.value.trim() || "someone";
    if (!phrase) {
      opts.flarePhraseInput.focus();
      return;
    }
    if (flareAbort) return;

    const useStun = opts.externalAssistToggle.checked;
    node = createNodeInstance();

    flareAbort = new AbortController();
    flareMode = "join";
    try {
      updateStatus("searching for campfire flare...");
      setBusy(true);
      updateControls();

      await joinCampfireViaFlare({
        phrase,
        acceptOfferCode: async (offerCode: string) => {
          if (!node) throw new Error("node-unavailable");
          return node.joinCampfire(offerCode, name, useStun);
        },
        onStatus: updateStatus,
        onLog: appendLog,
        signal: flareAbort.signal,
      });

      setBusy(false);
      appendLog("joined campfire via flare");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown";
      if (raw !== "Aborted") {
        appendLog(`campfire flare join failed: ${raw}`);
        handleStateChange("ended", flareFriendlyError(raw));
      }
    } finally {
      if (flareMode === "join") {
        flareAbort = null;
        flareMode = null;
        updateControls();
      }
    }
  }, { signal });

  const toggleHostGate = () => {
    if (!node || node.getRole() !== "root") return;
    const hostGateOpen = flareAbort !== null && flareMode === "host";
    if (hostGateOpen) {
      appendLog("campfire gate closed");
      clearFlareState();
      updateStatus(node.state === "waiting" ? "room open, waiting for peers" : "in the room, encrypted");
      return;
    }

    const phrase = opts.hostFlarePhraseInput.value.trim();
    if (!phrase) {
      opts.hostFlarePhraseInput.focus();
      return;
    }
    startHostFlareGate(phrase);
  };

  opts.hostFlareToggleBtn.addEventListener("click", toggleHostGate, { signal });
  opts.hostFlareToggleActiveBtn.addEventListener("click", toggleHostGate, { signal });

  // Send chat message
  const sendMessage = async () => {
    const text = opts.chatInput.value.trim();
    if (!text || !node) return;
    opts.chatInput.value = "";
    updateControls();
    try {
      await node.broadcastText(text);
      // Message display is handled by cb.onMessage → handleMessage
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
  opts.hostFlarePhraseInput.addEventListener("input", updateControls, { signal });
  opts.flarePhraseInput.addEventListener("input", updateControls, { signal });
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

  opts.dmInput.addEventListener("input", updateControls, { signal });

  // DM close
  opts.dmCloseBtn.addEventListener("click", closeDmPanel, { signal });

  // New campfire
  opts.newCampfireBtn.addEventListener("click", resetToIdle, { signal });

  /* ── Initial state ──────────────────────────────────────── */

  showPhase(opts.idleSection);
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
