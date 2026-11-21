/**
 * C2 (PLAN §5): one test, or more, per numbered rule of SPEC §11.3, and §11.5's replay budget.
 * The gate has no clock: time is what `admit` is called with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MediaFlag, PacketType, type MediaHeader } from "../protocol";
import type { LayerCap, LinkEstimate } from "../types";
import { createLayerGate, type InspectableLayerGate } from "./gate";
import { l1t3 } from "./sim/program";

const FRAME_MS = 1000 / 30;
/** B is 1,200 kbps: 200 ms of it is 30,000 bytes, 250 ms is 37,500. */
const B = 1200;

const link = (state: LinkEstimate["state"], more: Partial<LinkEstimate> = {}): LinkEstimate => ({
  rttMs: 30,
  lossPct: 0,
  queueDelayMs: 0,
  jitterMs: 1,
  sendKbps: 1300,
  deliveredKbps: 1300,
  bufferedBytes: 0,
  state,
  ...more,
});

/** The n-th frame of an `L1T3` stream with a keyframe every 60. */
const videoFrame = (frameId: number, more: Partial<MediaHeader> = {}): MediaHeader => {
  const indexInGop = frameId % 60;
  const { temporal, refDelta } = l1t3(indexInGop);
  return {
    type: PacketType.Media,
    flags: (indexInGop === 0 ? MediaFlag.Key : 0) | (temporal === 2 ? MediaFlag.Discardable : 0),
    streamId: 0,
    stripe: 0,
    spatial: 0,
    temporal,
    refDelta,
    keyDelta: indexInGop,
    frameId,
    fragIndex: 0,
    fragCount: 4,
    captureUs: frameId * 33_333,
    configId: 1,
    hopFlags: 0,
    hops: 0,
    linkSeq: 0,
    sendMs: 0,
    ...more,
  };
};

const audioFrame = (frameId: number): MediaHeader => ({ ...videoFrame(0), flags: MediaFlag.Key, streamId: 1, temporal: 0, refDelta: 0, keyDelta: 0, frameId });

/** A gate with a stream running through it: one frame every 33 ms, whatever the link is said to be. */
function harness(options: { temporalLayers?: number } = {}) {
  const gate: InspectableLayerGate = createLayerGate({ bitrateKbps: B, temporalLayers: options.temporalLayers ?? 3, frameIntervalMs: FRAME_MS, kind: "video" });
  const changes: { at: number; cap: LayerCap; reason: string }[] = [];
  const starved: number[] = [];
  let now = 0;
  let frameId = 0;
  gate.on("change", (cap, reason) => changes.push({ at: now, cap, reason }));
  gate.on("starved", () => starved.push(now));
  return {
    gate,
    changes,
    starved,
    get now() {
      return now;
    },
    get nextFrameId() {
      return frameId;
    },
    /** Offers the next frame now, then lets a frame interval pass. */
    frame(estimate: LinkEstimate): { header: MediaHeader; sent: boolean } {
      const header = videoFrame(frameId++);
      const sent = gate.admit(header, 5000, estimate, now);
      now += FRAME_MS;
      return { header, sent };
    },
    /** Runs the stream for `ms` with the link in one state. Returns the frames that were sent. */
    run(ms: number, estimate: LinkEstimate): MediaHeader[] {
      const sent: MediaHeader[] = [];
      for (const until = now + ms; now < until - 1e-6; ) {
        const result = this.frame(estimate);
        if (result.sent) sent.push(result.header);
      }
      return sent;
    },
  };
}

describe("LayerGate rule 1: control and audio are always sent", () => {
  it("never refuses audio, whatever the link, the backlog or the cap", () => {
    const gate = createLayerGate({ bitrateKbps: 32, temporalLayers: 1, frameIntervalMs: 20, kind: "audio" });
    const starved: number[] = [];
    gate.on("starved", () => starved.push(1));
    for (let i = 0; i < 500; i++)
      assert.equal(gate.admit(audioFrame(i), 80, link("congested", { bufferedBytes: 10_000_000, lossPct: 60, queueDelayMs: 900 }), i * 20), true);
    assert.deepEqual(starved, []);
    assert.deepEqual(gate.cap, { maxSpatial: 0, maxTemporal: 0 });
  });

  it("knows stage 1's audio stream without being told (SPEC §2: stream 1)", () => {
    const gate = createLayerGate({ bitrateKbps: B, temporalLayers: 3, frameIntervalMs: FRAME_MS });
    assert.equal(gate.admit(audioFrame(7), 80, link("congested", { bufferedBytes: 10_000_000 }), 0), true);
    assert.equal(gate.admit(videoFrame(0), 5000, link("ok", { bufferedBytes: 10_000_000 }), 0), false);
  });

  it("is never asked about control packets: only a media header can be put to it", () => {
    // Heartbeats, feedback, NACKs and probes have no `MediaHeader`; `admit` cannot be called for
    // them, so they cannot be refused. This test is the type of `admit`.
    const gate = createLayerGate({ bitrateKbps: B, temporalLayers: 3, frameIntervalMs: FRAME_MS });
    const admit: (header: MediaHeader, frameBytes: number, estimate: LinkEstimate, now: number) => boolean = gate.admit;
    assert.equal(typeof admit, "function");
  });
});

describe("LayerGate rule 2: a frame above the cap is not sent; the cap starts at the top", () => {
  it("starts at the top layer and sends everything", () => {
    const h = harness();
    assert.deepEqual(h.gate.cap, { maxSpatial: 0, maxTemporal: 2 });
    assert.equal(h.run(2000, link("ok")).length, 60);
    assert.deepEqual(h.changes, []);
  });

  it("sends exactly the frames at or below the cap, and each whole or not at all", () => {
    const h = harness();
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 1 });
    const sent = h.run(2000, link("ok"));
    assert.equal(sent.length, 30);
    assert.ok(sent.every((header) => header.temporal <= 1));
    // One answer per frame: the node asks at the first packet and holds to it (see sim/peer.ts).
    assert.equal(h.gate.wasSent(0), true);
    assert.equal(h.gate.wasSent(1), false);
    assert.equal(h.gate.lastVerdict, "above-cap");
  });

  it("does not send a higher spatial layer than there is", () => {
    const h = harness();
    assert.equal(h.gate.admit(videoFrame(0, { spatial: 1 }), 5000, link("ok"), 0), false);
  });
});

describe("LayerGate rule 3: down one layer when congested, at the next frame, at most once in 500 ms", () => {
  it("drops at the very next frame, then again only 500 ms later, and stops at the base layer", () => {
    const h = harness();
    h.run(1000, link("ok"));
    const at = h.now;
    h.run(1500, link("congested"));
    assert.deepEqual(
      h.changes.map((change) => [change.cap.maxTemporal, change.reason]),
      [
        [1, "congestion"],
        [0, "congestion"],
      ],
    );
    assert.equal(h.changes[0].at, at, "the first drop is at the frame that found the link congested");
    // The second is at the first frame 500 ms or more after the first: no sooner, no later.
    const between = h.changes[1].at - h.changes[0].at;
    assert.ok(between >= 500 - 1e-6 && between < 500 + FRAME_MS + 1e-6, String(between));
    assert.deepEqual(h.gate.cap, { maxSpatial: 0, maxTemporal: 0 });
  });

  it("applies to the frame that found the link congested", () => {
    const h = harness();
    h.frame(link("ok")); // frame 0, the keyframe
    assert.equal(h.frame(link("congested")).sent, false); // frame 1 is layer 2: the cap is 1 already
    assert.equal(h.frame(link("congested")).sent, true); // frame 2 is layer 1
  });

  it("does not drop on a link that is congested for less than a frame", () => {
    const h = harness();
    h.run(1000, link("ok"));
    assert.deepEqual(h.changes, []);
  });
});

describe("LayerGate rule 4: while strained the cap does not move", () => {
  it("neither drops nor rises, however long", () => {
    const h = harness();
    h.run(100, link("congested"));
    assert.equal(h.gate.cap.maxTemporal, 1);
    h.run(120_000, link("strained"));
    assert.equal(h.gate.cap.maxTemporal, 1);
    assert.equal(h.changes.length, 1);
  });

  it("does not count toward the five seconds of ok", () => {
    const h = harness();
    h.run(100, link("congested"));
    h.run(4900, link("ok"));
    h.run(100, link("strained"));
    h.run(4900, link("ok"));
    assert.equal(h.gate.cap.maxTemporal, 1);
    h.run(200, link("ok"));
    assert.equal(h.gate.cap.maxTemporal, 2);
  });
});

describe("LayerGate rule 5: up one layer after 5 s ok; a rise that fails doubles the wait", () => {
  it("rises one layer after five seconds ok, not before, and one more after five more", () => {
    const h = harness();
    h.run(1000, link("congested"));
    assert.equal(h.gate.cap.maxTemporal, 0);
    const okFrom = h.now;
    h.run(4990, link("ok"));
    assert.equal(h.gate.cap.maxTemporal, 0);
    h.run(11_000, link("ok"));
    assert.deepEqual(
      h.changes.slice(2).map((change) => ({ after: Math.round((change.at - okFrom) / 100) / 10, cap: change.cap.maxTemporal, reason: change.reason })),
      [
        { after: 5, cap: 1, reason: "restore" },
        { after: 10, cap: 2, reason: "restore" },
      ],
    );
  });

  it("drops back and doubles the wait when congested within 3 s of a rise: 10, 20, 40, 60, 60 s", () => {
    const h = harness();
    h.run(100, link("congested"));
    const waits: number[] = [];
    for (let round = 0; round < 6; round++) {
      const okFrom = h.now;
      while (h.gate.cap.maxTemporal < 2) h.frame(link("ok"));
      waits.push(Math.round((h.now - okFrom) / 1000));
      // The rise is tried, and 2 s later the link is congested again.
      h.run(2000, link("ok"));
      h.run(100, link("congested"));
      assert.equal(h.gate.cap.maxTemporal, 1, "the cap drops back");
    }
    assert.deepEqual(waits, [5, 10, 20, 40, 60, 60]);
    assert.equal(h.gate.riseAfterMs, 60_000);
  });

  it("resets the wait after a rise that holds", () => {
    const h = harness();
    h.run(100, link("congested"));
    h.run(5100, link("ok")); // up to 2
    h.run(2000, link("ok"));
    h.run(100, link("congested")); // back to 1: the wait is 10 s
    assert.equal(h.gate.riseAfterMs, 10_000);
    h.run(10_100, link("ok")); // up to 2 again
    assert.equal(h.gate.cap.maxTemporal, 2);
    h.run(3100, link("ok")); // and it holds for its 3 s
    assert.equal(h.gate.riseAfterMs, 5000);
    h.run(100, link("congested"));
    const okFrom = h.now;
    while (h.gate.cap.maxTemporal < 2) h.frame(link("ok"));
    assert.equal(Math.round((h.now - okFrom) / 1000), 5);
  });

  it("does not double the wait for congestion that comes more than 3 s after the rise", () => {
    const h = harness();
    h.run(100, link("congested"));
    h.run(5100, link("ok"));
    h.run(3100, link("ok"));
    h.run(100, link("congested"));
    assert.equal(h.gate.riseAfterMs, 5000);
  });
});

describe("LayerGate rule 6: no stale video", () => {
  it("sends no video once the channel holds more than 200 ms of B, whatever the cap or the state", () => {
    const h = harness();
    assert.equal(h.frame(link("ok", { bufferedBytes: 30_000 })).sent, true);
    assert.equal(h.frame(link("ok", { bufferedBytes: 30_001 })).sent, false);
    assert.equal(h.gate.lastVerdict, "stale");
    // Not even a keyframe.
    const key = videoFrame(60);
    assert.equal(h.gate.admit(key, 20_000, link("strained", { bufferedBytes: 30_001 }), h.now), false);
    // Audio still goes: that is the audio stream's gate, and rule 1.
    const audio = createLayerGate({ bitrateKbps: 32, temporalLayers: 1, frameIntervalMs: 20, kind: "audio" });
    assert.equal(audio.admit(audioFrame(0), 80, link("congested", { bufferedBytes: 30_001 }), h.now), true);
  });

  it("does not send the frames that need a frame it held back, until the next keyframe", () => {
    const h = harness();
    h.run(8 * FRAME_MS, link("ok")); // frames 0..7
    assert.equal(h.frame(link("ok", { bufferedBytes: 40_000 })).sent, false); // frame 8, base layer
    const rest = h.run((60 - 9) * FRAME_MS, link("ok")); // frames 9..59
    // 9 needs 8; 10 needs 8; 11 needs 10; 12 needs 8; and so on down the GOP.
    assert.deepEqual(rest, []);
    assert.equal(h.gate.lastVerdict, "undecodable");
    assert.equal(h.frame(link("ok")).sent, true); // frame 60: a keyframe
    assert.equal(h.run(59 * FRAME_MS, link("ok")).length, 59);
  });

  it("loses only the dependants of a discardable frame it held back: none", () => {
    const h = harness();
    h.run(1 * FRAME_MS, link("ok")); // frame 0
    assert.equal(h.frame(link("ok", { bufferedBytes: 40_000 })).sent, false); // frame 1, layer 2
    assert.equal(h.run(58 * FRAME_MS, link("ok")).length, 58);
  });
});

describe("LayerGate rule 7: starved", () => {
  it("announces starved after 1 s congested at the base layer, once, and resumes only at a keyframe the link can take", () => {
    const h = harness();
    h.run(600, link("congested")); // two drops: the cap is at the base layer from 500 ms
    assert.equal(h.gate.cap.maxTemporal, 0);
    const atBase = h.changes[1].at;
    h.run(900, link("congested"));
    assert.deepEqual(h.starved, []);
    h.run(3000, link("congested"));
    assert.equal(h.starved.length, 1);
    assert.ok(h.starved[0] - atBase >= 1000 && h.starved[0] - atBase < 1000 + FRAME_MS + 1e-6);
    assert.equal(h.gate.starved, true);

    // While starved nothing is sent: not base-layer frames, and not a keyframe into a congested link.
    const during = h.run(4000, link("congested"));
    assert.deepEqual(during, []);
    assert.equal(h.gate.lastVerdict, "starved");

    // The link clears mid-GOP: still nothing, until the keyframe.
    let sent: MediaHeader[] = [];
    while (sent.length === 0) sent = h.run(FRAME_MS, link("ok"));
    assert.equal(sent[0].flags & MediaFlag.Key, MediaFlag.Key);
    assert.equal(h.gate.starved, false);
    // And from there the GOP goes out whole, at the base layer.
    const gop = [sent[0], ...h.run(59 * FRAME_MS, link("ok"))];
    assert.deepEqual(
      gop.map((header) => header.frameId - gop[0].frameId),
      Array.from({ length: 15 }, (_, i) => i * 4),
    );
  });

  it("is not starved by congestion that lets up within the second", () => {
    const h = harness();
    h.run(600, link("congested"));
    for (let i = 0; i < 10; i++) {
      h.run(900, link("congested"));
      h.run(100, link("strained"));
    }
    assert.deepEqual(h.starved, []);
  });

  it("announces again if the link starves again", () => {
    const h = harness();
    h.run(2000, link("congested"));
    assert.equal(h.starved.length, 1);
    h.run(2100, link("ok")); // a keyframe passes: resumed
    assert.equal(h.gate.starved, false);
    h.run(1100, link("congested"));
    assert.equal(h.starved.length, 2);
  });

  it("with one temporal layer, the base layer is where it starts", () => {
    const h = harness({ temporalLayers: 1 });
    h.run(1100, link("congested"));
    assert.equal(h.starved.length, 1);
    assert.deepEqual(h.changes, []);
  });
});

describe("LayerGate rule 8: overload caps every child one layer down", () => {
  it("sheds the top layer while overloaded and gives it back after", () => {
    const h = harness();
    h.gate.setOverload(true);
    assert.deepEqual(h.changes, [{ at: 0, cap: { maxSpatial: 0, maxTemporal: 1 }, reason: "overload" }]);
    assert.ok(h.run(2000, link("ok")).every((header) => header.temporal <= 1));
    h.gate.setOverload(true); // said twice, told once
    assert.equal(h.changes.length, 1);
    h.gate.setOverload(false);
    assert.deepEqual(h.changes[1].cap, { maxSpatial: 0, maxTemporal: 2 });
    assert.equal(h.changes[1].reason, "restore");
  });

  it("does not lower a cap that congestion has already put lower, nor raise it when it ends", () => {
    const h = harness();
    h.run(600, link("congested"));
    assert.equal(h.gate.cap.maxTemporal, 0);
    h.gate.setOverload(true);
    h.gate.setOverload(false);
    assert.equal(h.gate.cap.maxTemporal, 0);
    assert.equal(h.changes.length, 2);
  });

  it("holds the link's own cap under the overload's while it lasts", () => {
    const h = harness();
    h.gate.setOverload(true);
    h.run(30_000, link("ok"));
    assert.equal(h.gate.cap.maxTemporal, 1);
    assert.equal(h.changes.length, 1);
  });
});

describe("LayerGate rule 9: a child may ask for less; the cap is the lower of what is asked and what fits", () => {
  it("sends no more than the child asked for", () => {
    const h = harness();
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 0 });
    assert.deepEqual(h.gate.cap, { maxSpatial: 0, maxTemporal: 0 });
    assert.ok(h.run(2000, link("ok")).every((header) => header.temporal === 0));
    // The child knows what it asked for: it is not told.
    assert.deepEqual(h.changes, []);
  });

  it("sends the lower of the two, whichever it is", () => {
    const h = harness();
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 1 });
    h.run(600, link("congested")); // what fits: 0
    assert.equal(h.gate.cap.maxTemporal, 0);
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 2 });
    assert.equal(h.gate.cap.maxTemporal, 0, "asking for more does not make it fit");
    h.run(5100, link("ok"));
    assert.equal(h.gate.cap.maxTemporal, 1);
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 0 });
    assert.equal(h.gate.cap.maxTemporal, 0);
  });

  it("gives back at once what the child asks for again, if the link never objected", () => {
    const h = harness();
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 0 });
    h.run(1000, link("ok"));
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 15 });
    assert.deepEqual(h.gate.cap, { maxSpatial: 0, maxTemporal: 2 });
    assert.deepEqual(
      h.changes.map((change) => change.reason),
      ["restore"],
    );
  });

  it("after a jump of two layers, sends no frame whose reference was left out", () => {
    const h = harness();
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 0 });
    h.run(3 * FRAME_MS, link("ok")); // 0 sent; 1 (layer 2) and 2 (layer 1) left out
    h.gate.setWanted({ maxSpatial: 0, maxTemporal: 2 });
    assert.equal(h.frame(link("ok")).sent, false); // 3 needs 2
    assert.equal(h.frame(link("ok")).sent, true); // 4 needs 0
    assert.equal(h.frame(link("ok")).sent, true); // 5 needs 4
  });
});

describe("LayerGate: every change of cap is announced, with its reason", () => {
  it("emits one change for each move, and none when nothing moved", () => {
    const h = harness();
    h.run(600, link("congested"));
    h.run(10_200, link("ok"));
    h.gate.setOverload(true);
    h.gate.setOverload(false);
    assert.deepEqual(
      h.changes.map((change) => [change.cap.maxTemporal, change.reason]),
      [
        [1, "congestion"],
        [0, "congestion"],
        [1, "restore"],
        [2, "restore"],
        [1, "overload"],
        [2, "restore"],
      ],
    );
  });
});

describe("LayerGate replay budget (SPEC §11.5)", () => {
  it("allows what keeps the channel under 250 ms of B, and nothing beyond", () => {
    const gate = createLayerGate({ bitrateKbps: B, temporalLayers: 3, frameIntervalMs: FRAME_MS });
    assert.equal(gate.replayBudget(link("ok"), 0), 37_500);
    assert.equal(gate.replayBudget(link("ok", { bufferedBytes: 30_000 }), 0), 7500);
    assert.equal(gate.replayBudget(link("congested", { bufferedBytes: 37_500 }), 0), 0);
    assert.equal(gate.replayBudget(link("congested", { bufferedBytes: 90_000 }), 0), 0);
  });

  it("does not take the replay's own backlog for congestion, nor refuse live video for it", () => {
    const h = harness();
    h.frame(link("ok")); // the keyframe
    // A catch-up fills the channel to its budget; the estimator calls that congested.
    assert.equal(h.gate.replayBudget(link("ok"), h.now), 37_500);
    for (let i = 0; i < 9; i++) assert.equal(h.frame(link("congested", { bufferedBytes: 37_500 })).sent, true);
    assert.deepEqual(h.changes, []);
    // Loss or a queue on the path is congestion whatever is being replayed.
    h.gate.replayBudget(link("ok"), h.now);
    h.frame(link("congested", { bufferedBytes: 37_500, lossPct: 12 }));
    assert.equal(h.changes.length, 1);
  });

  it("goes back to the rules once the replay has had 500 ms to drain", () => {
    const h = harness();
    h.frame(link("ok"));
    h.gate.replayBudget(link("ok"), h.now);
    h.run(450, link("congested", { bufferedBytes: 37_500 }));
    assert.deepEqual(h.changes, []);
    h.run(200, link("congested", { bufferedBytes: 37_500 }));
    assert.equal(h.gate.lastVerdict, "stale"); // rule 6 again
    assert.equal(h.changes.length, 1); // and rule 3
  });
});
