# Whisper Live Call Mode — Full Implementation Plan (Live-Only)

## Goal
Build one native **Whisper Live Chat** mode that supports:
- encrypted low-latency high-quality audio using **Whisper Harmonic**,
- encrypted low-latency high-res video using **Whisper Lumen**,
- seamless transitions between chat-only, audio call, and video call,
- asymmetric media enablement (one peer can enable video without forcing symmetry),
- future plugin/module extensibility (e.g., Pictocanvas) without core rewrites.

> Scope constraint: this plan is intentionally **Live-only** for now. Campfire/group logic is out of active implementation scope.

---

## Guiding Principles

1. **One mode, one session, many media states**
   - Keep a single Whisper Live session lifecycle.
   - Add a media sub-state machine inside live mode instead of introducing a separate mode.

2. **Media is optional and composable**
   - Chat must remain functional with media disabled.
   - Audio and video are independent tracks/capabilities.

3. **Security parity with existing Live**
   - Preserve current end-to-end keying, ratcheting, and control semantics.
   - Never bypass existing cryptographic guardrails when adding media.

4. **Native-feeling transitions**
   - No reconnect required to move between chat/audio/video.
   - UI continuity: transcript, typing, reactions, and controls remain coherent.

5. **Extension-first architecture**
   - Define plugin boundaries now to prevent brittle point integrations later.

6. **Universal-by-default delivery**
   - Calls must stay usable on weak networks and low-power devices.
   - Dynamic quality adaptation should happen automatically behind the scenes.

7. **FaceTime-like simplicity**
   - Surface only essential controls (mute, camera, end call).
   - Keep all adaptation and negotiation complexity invisible to users.

---

## Current Codebase Fit (What Already Exists)

- `src/scripts/whisper/live.ts`
  - Core session state machine, DataChannel, handshake, ratchet integration, control routing.
- `src/scripts/whisper/live-ctrl.ts`
  - Existing compact control opcode framework suitable for media signaling extensions.
- `src/scripts/whisper/live-ui.ts`
  - Live UI orchestration and event plumbing.
- `src/scripts/whisper/live-wasm-audio.ts` + `src/scripts/whisper/live-audio-dsp.ts`
  - Harmonic audio and DSP helpers.
- `src/scripts/whisper/live-wasm-video.ts` + renderer/recorder helpers
  - Lumen video primitives already available.
- `src/components/whisper/WhisperLiveChat.astro` + `src/pages/whisper.astro`
  - Existing UX shell where call controls should live.

This plan leverages these existing systems rather than replacing them.

---

## Target Architecture

### 1) Add `LiveCallSession` orchestration layer (Live-only)
Create `src/scripts/whisper/live-call.ts`.

Responsibilities:
- Wrap and coordinate `WhisperLiveSession` + media transceivers/tracks.
- Maintain call intent state:
  - `chat`
  - `audio`
  - `video`
  - `audio-video`
- Track per-direction capability:
  - local send/recv audio/video
  - remote send/recv audio/video
  - effective negotiated result
- Expose imperative API:
  - `setAudioEnabled(enabled: boolean)`
  - `setVideoEnabled(enabled: boolean)`
  - `upgradeToVideo()`
  - `downgradeToAudio()`
  - `attachLocalPreview(el: HTMLVideoElement)`
  - `attachRemoteView(el: HTMLVideoElement)`

Design note:
- Keep cryptographic/session ownership in `WhisperLiveSession`.
- `LiveCallSession` handles media orchestration only.

---

### 2) Extend control protocol for media negotiation
Update `src/scripts/whisper/live-ctrl.ts`.

Add opcodes:
- `MEDIA_CAPS` — static support advertisement
- `MEDIA_INTENT` — current desired media state
- `MEDIA_APPLY` — resolved active media matrix
- `MEDIA_CONSTRAINTS` (optional, versioned) — preferred bounds/tiers

Payload schema (binary, versioned):
- protocol version byte
- codec support bitset (`harmonic-v1`, `lumen-v1`)
- direction flags (send/recv)
- optional constraint fields:
  - target fps tier
  - target resolution tier
  - latency/quality profile

Rules:
- Unknown media opcodes are ignored safely.
- Legacy peers continue chat-only operation.
- Asymmetric enablement is first-class (e.g., local video send on, remote video send off).

---

### 3) Introduce media pipeline interfaces
Create `src/scripts/whisper/live-media-pipeline.ts`.

Interfaces:
- `AudioEncoderStage`
- `AudioDecoderStage`
- `VideoEncoderStage`
- `VideoDecoderStage`
- `MediaEncryptStage`
- `MediaDecryptStage`

Default adapters:
- Harmonic adapter -> `live-wasm-audio.ts`
- Lumen adapter -> `live-wasm-video.ts` (+ renderer helpers)

Frame envelope concept:
- stream type (`audio` / `video`)
- sequence + timestamp
- keyframe marker (video)
- encrypted payload bytes
- optional extension metadata map

Outcome:
- Swappable internal pipeline components while preserving session contract.

---

### 3.5) Add adaptive quality controller (network + device aware)
Create `src/scripts/whisper/live-media-adaptation.ts`.

Responsibilities:
- Continuously infer network quality and device capability from available runtime signals.
- Select a media profile tier that balances continuity, latency, and quality.
- Adjust audio/video settings without forcing reconnect or interrupting chat.

Input signals (examples):
- WebRTC stats (`rtt`, `jitter`, packet loss, retransmits, available outgoing bitrate).
- Render pressure (encode/decode timing, dropped-frame ratio, CPU pressure proxies).
- Browser hints (save-data preference, effective network type where available).
- Permission/device constraints (camera capability, background/foreground transitions).

Output controls:
- Audio profile: frame size, complexity, FEC/redundancy level, packet pacing.
- Video profile: resolution tier, fps tier, keyframe cadence, quantization/quality band.
- Degradation policy: prioritize intelligible audio first, then maintain low-fps video, then recover upward.

Profile ladder (illustrative):
- `P0_audio_safe`: audio-only fail-safe, ultra-low bandwidth.
- `P1_video_tiny`: 144p–240p @ low fps for weak links.
- `P2_video_mobile`: 360p @ moderate fps.
- `P3_video_standard`: 540p–720p balanced mode.
- `P4_video_high`: 720p–1080p when link + device permit.

Controller behavior:
- Fast-down / slow-up hysteresis (degrade quickly, recover cautiously).
- Minimum dwell windows to avoid visible oscillation.
- Direction-aware adaptation: downscale send path independently from receive path.
- Thermal/CPU guardrails to protect low-end phones.

---

### 4) Add call sub-state machine in live UI
Update `src/scripts/whisper/live-ui.ts` and `src/components/whisper/WhisperLiveChat.astro`.

Define `CallUIState` (independent from `LiveState`):
- `idle`
- `audio-pending`
- `audio-live`
- `video-pending`
- `video-live`
- `transitioning`
- `degraded`

UI controls:
- mic toggle
- camera toggle
- end-call / disconnect
- local/remote state indicators
- clear fallback messaging when peer capability differs

FaceTime-like control philosophy:
- Keep primary controls minimal and persistent: **Mute**, **Camera**, **End**.
- Hide advanced tuning by default (no manual bitrate/resolution selector in core UI).
- Optional advanced diagnostics can exist behind a dev/debug panel only.

UX continuity requirements:
- text chat uninterrupted during media transitions
- no full-page phase reset for media toggles
- preserve focus, draft text, and reaction controls
- quality changes should feel natural (no jarring jumps, black frames, or UI churn)

---

### 5) Add plugin host and extension contract
Create `src/scripts/whisper/live-plugin-host.ts`.

Plugin lifecycle:
- `onInit(context)`
- `onSessionReady(session)`
- `onMediaStateChanged(state)`
- `onCtrlFrame(opcode, payload)`
- `onDispose()`

Context surface:
- read-only session and media snapshot
- event bus (typed)
- command gateway (request audio/video state changes, send custom ctrl)
- scoped capabilities (avoid accidental sensitive access)

Security and resiliency:
- plugin exceptions are isolated/logged
- deterministic plugin startup order
- capability-gated access to sensitive internals

---

## Data and State Model

### Capability Model
- `supportsAudioCodecHarmonic: boolean`
- `supportsVideoCodecLumen: boolean`
- `canSendAudio: boolean`
- `canRecvAudio: boolean`
- `canSendVideo: boolean`
- `canRecvVideo: boolean`

### Intent Model
- local desired: `{ audio: boolean, video: boolean }`
- remote desired: `{ audio: boolean, video: boolean }`

### Effective Model
- resolved active media matrix:
  - local sends audio/video?
  - local receives audio/video?
  - remote sends audio/video?
  - remote receives audio/video?

### Adaptation Model
- `NetworkClass`: `poor | constrained | moderate | good | excellent`
- `DeviceClass`: `low | medium | high`
- `MediaTier`: `P0..P4` (profile ladder)
- `AdaptationReason` (telemetry):
  - `startup-probe`
  - `loss-spike`
  - `rtt-spike`
  - `cpu-pressure`
  - `recover-stable`

Policy:
- determine tier from the worst bounded dimension (network/device/thermal)
- never degrade below intelligible audio unless media permissions are fully unavailable
- recover upward only after sustained stability windows

### Conflict Resolution
- If local wants video but remote cannot receive video -> audio persists, video remains locally disabled with explanation.
- If remote offers video while local does not send video -> local may still receive remote video.

---

## Rollout Phases

### Phase 0 — Foundations (types + protocol)
1. Add media types and interfaces.
2. Add control opcodes and payload codecs.
3. Add no-op handling paths in existing session callbacks.

Exit criteria:
- Typecheck passes.
- Legacy chat session unaffected.

### Phase 1 — `LiveCallSession` core
1. Implement orchestration class with intent/effective state tracking.
2. Integrate with existing `WhisperLiveSession` callbacks.
3. Add deterministic media negotiation flow.

Exit criteria:
- Audio-only call path stable.
- Media state transitions emit expected events.

### Phase 2 — Harmonic/Lumen pipeline wiring
1. Implement default pipeline adapters.
2. Connect audio capture/playback through Harmonic.
3. Connect video capture/render through Lumen.
4. Integrate adaptive quality controller with send/receive profiles.

Exit criteria:
- Encrypted audio/video frames transmitted in live mode.
- Recovery behavior validated for transient failures.
- Resolution/fps adapt automatically under constrained links.

### Phase 3 — UI integration
1. Add controls and status elements.
2. Add call sub-state machine.
3. Ensure no transcript interruption across transitions.
4. Keep control surface minimal and consistent across network states.

Exit criteria:
- Manual QA: chat -> audio -> video -> audio -> chat without reconnect.
- Asymmetric enablement works and is understandable in UI.
- Users are not required to manually tune quality in normal usage.

### Phase 4 — Plugin host
1. Introduce plugin runtime + API.
2. Register zero or minimal built-in plugins.
3. Add docs for future modules (Pictocanvas-ready hooks).

Exit criteria:
- Plugin can subscribe to media state changes without touching core logic.

---

## File-Level Implementation Map

### New files
- `src/scripts/whisper/live-call.ts`
- `src/scripts/whisper/live-media-pipeline.ts`
- `src/scripts/whisper/live-plugin-host.ts`
- `src/scripts/whisper/live-media-types.ts` (optional shared types split)

### Existing files to update
- `src/scripts/whisper/live.ts` (callback passthroughs + integration points)
- `src/scripts/whisper/live-ctrl.ts` (media opcodes + payload codecs)
- `src/scripts/whisper/live-ui.ts` (call state + controls wiring)
- `src/components/whisper/WhisperLiveChat.astro` (call controls)
- `src/pages/whisper.astro` (if additional mount points or IDs are required)

---

## Backward Compatibility Plan

1. Version media control payloads from day one.
2. Feature-detect peer capability before enabling call controls.
3. Keep chat as baseline fallback.
4. Preserve existing wire/control behavior for non-media sessions.

---

## Observability and Diagnostics

Add structured log tags (dev-facing):
- `[live-call]` session and state transitions
- `[media-negotiation]` capability + intent exchanges
- `[media-audio]` Harmonic path events
- `[media-video]` Lumen path events
- `[plugin-host]` plugin lifecycle and errors

Add lightweight runtime counters:
- media transition count
- negotiation retries
- frame drops (audio/video)
- fallback activations
- adaptation tier changes and dwell duration per tier
- reason-coded degradations (`loss`, `rtt`, `cpu`, `thermal`)
- audio continuity KPI (glitch-free playback window)

---

## Test Strategy

### Unit tests
- media payload encode/decode correctness
- capability/intent resolution logic
- transition matrix validity
- plugin host lifecycle and isolation behavior

### Integration tests
- live session with media opcodes across mocked peers
- asymmetric audio/video scenarios
- downgrade/upgrade transitions without reconnect
- adaptive tier transitions under synthetic weak-network profiles
- fast-down/slow-up hysteresis stability tests (no rapid oscillation)

### Regression checks
- existing whisper tests remain green
- chat-only sessions unchanged

### Manual QA matrix
- desktop/desktop (audio, video, transitions)
- one-sided camera enable
- permission denied paths (mic/cam blocked)
- network jitter and brief disconnect recovery
- constrained-bandwidth scenarios (2G/3G-like throttles)
- low-end mobile device checks (CPU pressure and thermal throttling)

---

## Risks and Mitigations

1. **State explosion between chat/live/call flows**
   - Mitigation: isolate call sub-state machine and explicit transition table.

2. **Codec pipeline complexity**
   - Mitigation: strict interfaces + small adapters around existing WASM modules.

2.5 **Adaptation instability (quality oscillation)**
   - Mitigation: hysteresis thresholds, dwell timers, and capped step size changes.

3. **UI desync from negotiated media reality**
   - Mitigation: UI renders from `effective` state only (not raw local intent).

4. **Future plugin instability**
   - Mitigation: capability-scoped APIs, sandboxed lifecycle, exception boundaries.

---

## Definition of Done (Core Architecture)

The architecture phase is complete when:
1. Live-only codepath supports chat/audio/video in one session model.
2. Harmonic and Lumen are modeled as first-class codec capabilities.
3. Asymmetric media enablement works by design.
4. Transition flow is reconnect-free and UI-consistent.
5. Plugin host contract exists and is documented for future modules.
6. Quality adaptation keeps calls usable across constrained links without manual tuning.

---

## Immediate Next Step

Start with **Phase 0 + Phase 1** in a focused PR:
- media control protocol,
- `LiveCallSession` skeleton + state model,
- no UI overhaul yet,
- no Campfire changes.

This yields a stable base for incremental Harmonic/Lumen and UI integration.
