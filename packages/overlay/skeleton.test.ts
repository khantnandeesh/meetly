/**
 * Phase 0's own test: every module of the skeleton loads under Node as CI runs it (types
 * stripped, no bundler), the package is reachable through its alias, and nothing under src/
 * imports it yet. As each module is built its line in "is still a stub" goes, replaced by that
 * module's own tests; the last check stays until the integration step removes it on purpose.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NotImplementedError, PROTOCOL_VERSION, createOverlaySource, createOverlayViewer } from "@meetly/overlay";
import { ROUTES } from "@meetly/overlay/coordinator/index";
import { OverlayRoom } from "@meetly/overlay/coordinator/durableObject";
import { GATE, GATE_MIX, PROFILES } from "@meetly/overlay/harness/index";
import { DEFAULT_ENCODING } from "@meetly/overlay/media/index";
import { CHANNELS } from "@meetly/overlay/transport/index";

describe("overlay skeleton", () => {
  it("is reachable through the @meetly/overlay alias", () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(ROUTES.ws("abc-defg-hij"), "/overlay/v1/rooms/abc-defg-hij/ws");
    assert.deepEqual(CHANNELS.media, { id: 1, label: "media", ordered: false, maxRetransmits: 0 });
    assert.equal(DEFAULT_ENCODING.video.keyIntervalFrames, 60);
    assert.equal(typeof OverlayRoom, "function");
  });

  it("is built: the composition root's factories make a viewer and a source without connecting", async () => {
    for (const make of [createOverlayViewer, createOverlaySource]) {
      let peer: ReturnType<typeof make> | null = null;
      assert.doesNotThrow(() => {
        peer = make({ coordinatorUrl: "ws://127.0.0.1:1/overlay/v1/rooms/x/ws", ticket: async () => "" });
      }, (error: unknown) => error instanceof NotImplementedError);
      assert.equal(peer!.state, "idle");
      assert.equal(peer!.status(), null);
      await peer!.close();
    }
  });

  it("states the gate and a mix of networks that adds up", () => {
    assert.deepEqual(GATE, { peers: 200, repairP95Ms: 500, glassToGlassP95Ms: 500, joinP95Ms: 3000 });
    assert.equal(
      GATE_MIX.reduce((sum, part) => sum + part.share, 0),
      1,
    );
    for (const part of GATE_MIX) assert.ok(PROFILES[part.profile], part.profile);
  });

  it("is not imported by the app (until the integration step)", () => {
    const root = join(import.meta.dirname, "..", "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name) && /@meetly\/overlay|packages\/overlay/.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
