/**
 * Stand-ins for the congestion module, written from its `types.ts`: an estimator that measures
 * the round trip and loss and never calls a link anything but "ok", and a gate that admits
 * everything. They are what topology's own tests and its browser bench run with; the real ones
 * are E-congestion's and are handed to the node by whoever puts the modules together.
 *
 * Owner: E-transport+topology.
 */
import { ECHO_NONE, rttFromEcho, seq16Diff } from "../protocol";
import type { LayerCap, LinkEstimate } from "../types";
import type { FeedbackBody, LayerGate, LayerGateOptions, LinkEstimator } from "../congestion/types";
import { Emitter } from "../transport/emitter";

/** Round trip from echoes, loss from the peer's feedback, rates over the last second. Always "ok". */
export function createBasicEstimator(): LinkEstimator {
  let rttMs: number | null = null;
  let lastSendMs = 0;
  let lastReceivedAt = -1;
  let highestSeq = -1;
  let intervalBase = -1;
  let received = 0;
  let lossPct = 0;
  let bufferedBytes = 0;
  let sentBytes = 0;
  let sentSince = 0;
  let sendKbps = 0;
  let deliveredKbps = 0;

  const onEcho = (now: number, echoMs: number, echoHoldMs: number) => {
    const rtt = rttFromEcho(now, echoMs, echoHoldMs);
    if (rtt !== null) rttMs = rttMs === null ? rtt : rttMs * 0.875 + rtt * 0.125;
  };

  return {
    onReceived(linkSeq, sendMs, _bytes, now) {
      if (highestSeq < 0 || seq16Diff(linkSeq, highestSeq) > 0) {
        highestSeq = linkSeq;
        lastSendMs = sendMs;
        lastReceivedAt = now;
      }
      if (intervalBase < 0) intervalBase = (linkSeq - 1) & 0xffff;
      received++;
    },
    onSent(bytes, now) {
      if (now - sentSince >= 1000) {
        sendKbps = (sentBytes * 8) / Math.max(1, now - sentSince);
        sentBytes = 0;
        sentSince = now;
      }
      sentBytes += bytes;
    },
    onFeedback(feedback, now) {
      onEcho(now, feedback.echoMs, feedback.echoHoldMs);
      if (feedback.expected > 0) {
        const lost = Math.max(0, feedback.expected - feedback.received);
        lossPct = lossPct * 0.7 + ((100 * lost) / feedback.expected) * 0.3;
      }
      deliveredKbps = sendKbps * (1 - lossPct / 100);
    },
    onHeartbeat(heartbeat, now) {
      onEcho(now, heartbeat.echoMs, heartbeat.echoHoldMs);
    },
    onBuffered(bytes) {
      bufferedBytes = bytes;
    },
    takeFeedback(now): FeedbackBody {
      const expected = highestSeq < 0 || intervalBase < 0 ? 0 : Math.max(0, seq16Diff(highestSeq, intervalBase));
      const body: FeedbackBody = {
        highestSeq: Math.max(0, highestSeq),
        received: Math.min(0xffff, received),
        expected: Math.min(0xffff, Math.max(expected, 0)),
        jitterTenthsMs: 0,
        queueDelayTenthsMs: 0,
        ...this.echo(now),
      };
      intervalBase = highestSeq;
      received = 0;
      return body;
    },
    echo(now) {
      if (lastReceivedAt < 0) return { echoMs: 0, echoHoldMs: ECHO_NONE };
      return { echoMs: lastSendMs, echoHoldMs: Math.min(0xfffe, Math.max(0, Math.round(now - lastReceivedAt))) };
    },
    estimate(): LinkEstimate {
      return { rttMs, lossPct, queueDelayMs: 0, jitterMs: 0, sendKbps, deliveredKbps, bufferedBytes, state: "ok" };
    },
  };
}

/**
 * The open gate, and what a test can read of it: whether it was told of an overload, and how many
 * listeners the node still has on it (none once the child it served is gone).
 */
export type OpenGate = LayerGate & { overload: boolean; listeners: number };

/** A gate that admits every frame, up to what the child asked for. */
export function createOpenGate(_options: LayerGateOptions): OpenGate {
  const events = new Emitter<{ change: [cap: LayerCap, reason: "congestion" | "overload" | "restore"]; starved: [] }>();
  let wanted: LayerCap = { maxSpatial: 15, maxTemporal: 15 };
  const gate: OpenGate = {
    on: ((event, listener) => {
      gate.listeners++;
      const off = events.on(event, listener);
      return () => {
        gate.listeners--;
        off();
      };
    }) as LayerGate["on"],
    listeners: 0,
    overload: false,
    get cap() {
      return wanted;
    },
    admit: (header: { spatial: number; temporal: number }) => header.temporal <= wanted.maxTemporal && header.spatial <= wanted.maxSpatial,
    setWanted(cap: LayerCap) {
      wanted = cap;
    },
    setOverload(on: boolean) {
      gate.overload = on;
    },
    replayBudget: () => Infinity,
  };
  return gate;
}
