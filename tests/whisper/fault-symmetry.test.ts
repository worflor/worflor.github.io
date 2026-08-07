/**
 * fault-symmetry.test.ts — one event, one conclusion, on both peers.
 *
 * A dropped connection is a single physical fact observed twice. WebRTC reports
 * it through several independent channels — `iceConnectionState` going
 * "disconnected" or "failed", `connectionState` going "failed", and the data
 * channel closing — and the ORDER those fire in is not specified. It varies by
 * browser, by OS, by which side of the path broke, and it varies independently
 * on the two peers.
 *
 * So any handler that decides the outcome on its own turns an implementation
 * detail into user-visible truth. That is what happened: ICE "disconnected"
 * entered recovery and showed the seam, while `connectionState` "failed" and the
 * channel close both declared "peer left, session over" and ended it. A single
 * genuine drop therefore left one peer patiently recovering and the other told
 * the session was over — the asymmetry the report described.
 *
 * The property is not "always recover". It is that the conclusion is a function
 * of the EVENT, not of which detector happened to win the race. Departure is the
 * one asymmetric case, and it is allowed to be asymmetric precisely because it
 * is announced: only the leaver knows it meant to go, so it says so with BYE,
 * and everything unannounced is treated as a fault.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WhisperLiveSession, type LiveState } from "../../src/scripts/whisper/live.js";

interface Internals {
  _state: LiveState;
  isOfferer: boolean;
  stateBeforeRecovery: "live" | "silent" | null;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  pc: unknown;
  dc: unknown;
  enterRecovery: (pc: unknown, reason: string) => void;
  handlePeerBye: () => void;
  setupPeerConnection: (pc: unknown) => void;
  setupDataChannel: (dc: unknown) => void;
  iceRestartAttempted: boolean;
  connectingGraceTimer: ReturnType<typeof setTimeout> | null;
  cleanupConnection: () => void;
  startHeartbeat: () => void;
}

function liveSession() {
  const states: Array<{ state: LiveState; detail?: string }> = [];
  const logs: string[] = [];
  const session = new WhisperLiveSession({
    onStateChange: (state, detail) => states.push({ state, detail }),
    onFingerprint: () => {},
    onMessage: () => {},
    onLog: (line) => logs.push(line),
  });
  const internals = session as unknown as Internals;
  internals.startHeartbeat = () => {};
  internals.cleanupConnection = () => {};
  internals._state = "live";
  return { session, internals, states, logs };
}

/** stop the bounded recovery timer so a finished test leaves nothing running. */
function quiesce(internals: Internals): void {
  if (internals.recoveryTimer) {
    clearTimeout(internals.recoveryTimer);
    internals.recoveryTimer = null;
  }
}

/**
 * The detectors, driven through the REAL handlers.
 *
 * Calling `enterRecovery` directly would only prove that method works; the bug
 * was never in the method, it was in three call sites that did not use it. So
 * each entry here installs the production handlers on a fake peer connection or
 * channel and fires the browser event, which is the routing decision itself.
 */
type Handlers = {
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  onicecandidate: unknown;
  onnegotiationneeded: unknown;
};

function fakePc(state: string): Handlers & { iceConnectionState: string; connectionState: string } {
  return {
    iceConnectionState: state,
    connectionState: state,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    onicecandidate: null,
    onnegotiationneeded: null,
  };
}

const DETECTORS: Record<string, (i: Internals) => void> = {
  "ice disconnected": (i) => {
    const pc = fakePc("disconnected");
    i.setupPeerConnection(pc);
    i.pc = pc;
    pc.oniceconnectionstatechange!();
  },
  "ice failed": (i) => {
    const pc = fakePc("failed");
    i.setupPeerConnection(pc);
    i.pc = pc;
    pc.oniceconnectionstatechange!();
  },
  "connectionState failed": (i) => {
    const pc = fakePc("failed");
    i.setupPeerConnection(pc);
    i.pc = pc;
    pc.onconnectionstatechange!();
  },
  "channel closed": (i) => {
    const dc: { readyState: string; onclose: (() => void) | null; onopen: unknown; onerror: unknown; onmessage: unknown } = {
      readyState: "closed", onclose: null, onopen: null, onerror: null, onmessage: null,
    };
    i.setupDataChannel(dc);
    dc.onclose!();
  },
};

describe("a fault reaches the same conclusion on both peers", () => {
  it("EVERY detector enters recovery, so none of them can decide the outcome alone", () => {
    // The heart of it. Before the fix, two of these four ended the session
    // outright while the other two showed the seam.
    for (const [name, fire] of Object.entries(DETECTORS)) {
      const { internals } = liveSession();
      fire(internals);
      assert.equal(internals._state, "recovering",
        `"${name}" must enter recovery like its siblings, or two peers can disagree about one drop`);
      quiesce(internals);
    }
  });

  it("two peers agree no matter WHICH detector fires on each", () => {
    // The asymmetry was never that a peer handled its own event wrongly: each
    // handler was self-consistent. It was that the two peers ran DIFFERENT
    // handlers for the same event. So the property is checked over the full
    // product of detector pairs.
    const names = Object.keys(DETECTORS);
    for (const mine of names) {
      for (const theirs of names) {
        const a = liveSession();
        const b = liveSession();
        DETECTORS[mine](a.internals);
        DETECTORS[theirs](b.internals);
        assert.equal(a.internals._state, b.internals._state,
          `peer A saw "${mine}" and peer B saw "${theirs}" from one drop, and they disagreed`);
        quiesce(a.internals);
        quiesce(b.internals);
      }
    }
  });

  it("remembers what to return to, so recovery restores the mode it interrupted", () => {
    for (const mode of ["live", "silent"] as const) {
      const { internals } = liveSession();
      internals._state = mode;
      DETECTORS["ice failed"](internals);
      assert.equal(internals.stateBeforeRecovery, mode,
        "silent mode must come back as silent, not as live");
      quiesce(internals);
    }
  });

  it("a second detector does not restart or double-arm the recovery", () => {
    // They all fire on a real drop, usually within milliseconds. The later ones
    // must find recovery already entered rather than resetting its deadline,
    // which would let a chatty detector postpone the timeout indefinitely.
    const { internals, states } = liveSession();
    DETECTORS["ice disconnected"](internals);
    const armed = internals.recoveryTimer;
    for (const name of Object.keys(DETECTORS)) DETECTORS[name](internals);

    assert.equal(internals.recoveryTimer, armed,
      "the deadline must belong to the incident, not to the most recent detector");
    assert.equal(states.filter((s) => s.state === "recovering").length, 1,
      "one incident is one seam, however many detectors noticed it");
    quiesce(internals);
  });

  it("recovery is BOUNDED: silence still ends the session as vanished", () => {
    // Entering recovery everywhere must not turn a dead peer into an eternal
    // spinner. The conclusion is the same as before; it is now reached by
    // waiting rather than by guessing.
    const { internals, states } = liveSession();
    DETECTORS["channel closed"](internals);
    assert.ok(internals.recoveryTimer, "a deadline must be armed");
    (internals.recoveryTimer as unknown as { _onTimeout: () => void })._onTimeout();
    assert.equal(internals._state, "disconnected");
    assert.equal(states.at(-1)?.detail, "vanished",
      "a peer that never comes back has vanished, and that is still what it is called");
    quiesce(internals);
  });

  it("BYE is the ONLY thing that skips recovery, because it is the only stated intent", () => {
    const { internals, states, logs } = liveSession();
    internals.handlePeerBye();
    assert.equal(internals._state, "disconnected");
    assert.equal(states.at(-1)?.detail, "left",
      "a peer that said goodbye did not vanish, and must not be described as if it had");
    assert.ok(logs.some((l) => l.includes("peer left")));
  });

  it("BYE during recovery resolves the seam instead of leaving it hanging", () => {
    // Ordering that really happens: the path degrades, we enter recovery, and
    // the peer then gives up and closes deliberately.
    const { internals, states } = liveSession();
    DETECTORS["ice disconnected"](internals);
    assert.equal(internals._state, "recovering");
    internals.handlePeerBye();
    assert.equal(internals._state, "disconnected");
    assert.equal(states.at(-1)?.detail, "left");
    assert.equal(internals.recoveryTimer, null,
      "the deadline must be disarmed, or it fires later and overwrites the outcome");
  });

  it("a detector firing AFTER a bye is a no-op, not a resurrection", () => {
    // The close always follows the bye by a few milliseconds. Without the state
    // guard that close would drag a finished session back into a recovering
    // seam nobody can resolve.
    const { internals, states } = liveSession();
    internals.handlePeerBye();
    for (const name of Object.keys(DETECTORS)) DETECTORS[name](internals);
    assert.equal(internals._state, "disconnected",
      "the session ended when the peer said so; a trailing close cannot reopen it");
    assert.equal(states.filter((s) => s.state === "recovering").length, 0);
  });

  it("disconnect() ANNOUNCES the departure before tearing down", () => {
    // The other half of the contract. If the leaver stays silent, the peer has
    // only silence to read and must assume a fault — correct, but it costs the
    // peer a full recovery timeout to learn something that was known instantly.
    const sent: Uint8Array[] = [];
    const { session, internals } = liveSession();
    internals.dc = {
      readyState: "open",
      send: (d: Uint8Array) => sent.push(new Uint8Array(d)),
      close: () => {},
    };
    session.disconnect();

    assert.equal(sent.length, 1, "a deliberate leave must say so");
    assert.equal(sent[0][0], 0x12, "and it must be the BYE opcode");
    assert.equal(internals._state, "disconnected");
  });

  it("disconnect() over a dead channel still tears down cleanly", () => {
    // Best effort means best effort: a closed channel must not throw on the way
    // out and strand the local session in whatever state it was in.
    const { session, internals } = liveSession();
    internals.dc = {
      readyState: "closed",
      send: () => { throw new Error("channel is gone"); },
      close: () => {},
    };
    session.disconnect();
    assert.equal(internals._state, "disconnected",
      "an unsendable goodbye must not prevent leaving");
  });

  it("a closing PAGE says goodbye too, which is the commonest departure of all", () => {
    // Closing the tab never routes through disconnect(), so without this the
    // most ordinary way to leave reaches the peer as silence — and silence is
    // now read as a fault, costing the peer a full recovery timeout to learn
    // something that was knowable instantly. pagehide, not beforeunload:
    // mobile browsers discard backgrounded pages without firing the latter.
    const sent: Uint8Array[] = [];
    const { internals } = liveSession();
    internals.dc = {
      readyState: "open",
      send: (d: Uint8Array) => sent.push(new Uint8Array(d)),
      close: () => {},
    };
    // startHeartbeat also registers a visibilitychange listener, and node has no
    // document. Stub only that, so the pagehide wiring under test stays real.
    // `window` too: the session attaches pagehide there, as browser code does.
    // Delegating to globalThis keeps the real add/remove pair under test rather
    // than swapping it for a stub that always agrees with itself.
    const g = globalThis as unknown as { document?: unknown; window?: unknown };
    const hadDocument = "document" in g;
    const hadWindow = "window" in g;
    g.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
    const listeners = new Map<string, Set<() => void>>();
    g.window = {
      addEventListener: (t: string, h: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(h);
      },
      removeEventListener: (t: string, h: () => void) => { listeners.get(t)?.delete(h); },
    };
    const firePageHide = () => { for (const h of listeners.get("pagehide") ?? []) h(); };
    try {
      const proto = WhisperLiveSession.prototype as unknown as {
        startHeartbeat: () => void; stopHeartbeat: () => void; startStatsPoll: () => void;
      };
      (internals as unknown as { startStatsPoll: () => void }).startStatsPoll = () => {};
      proto.startHeartbeat.call(internals);

      firePageHide();
      assert.equal(sent.filter((f) => f[0] === 0x12).length, 1,
        "a page going away must announce it, or the peer waits out the whole timeout");

      proto.stopHeartbeat.call(internals);
      firePageHide();
      assert.equal(sent.filter((f) => f[0] === 0x12).length, 1,
        "and the listener must be removed with the heartbeat, not outlive the session");
    } finally {
      if (!hadDocument) delete g.document;
      if (!hadWindow) delete g.window;
    }
  });

  it("faults BEFORE a session exists never enter recovery", () => {
    // Recovery restores something that was working. Nothing was, before the
    // handshake completed, so these paths must not borrow the seam — they are
    // a failed connection attempt, and each already has its own honest ending:
    // setup states keep retrying, a broken handshake surfaces as an error.
    for (const state of ["connecting", "offering", "handshaking", "verifying"] as const) {
      const { internals } = liveSession();
      internals._state = state;
      DETECTORS["ice failed"](internals);
      assert.notEqual(internals._state, "recovering",
        `${state} has no established session behind it, so a recovering seam would be a lie`);
      quiesce(internals);
    }
  });
});
