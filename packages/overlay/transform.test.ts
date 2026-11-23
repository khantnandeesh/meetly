import assert from "node:assert/strict";
import { test } from "node:test";
import { inOrder, markStreamConfig } from "./transform";
import type { StreamConfig } from "./protocol";

/** The engine's frame hook (transform.ts): steps run together, results come out in order. */

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("results are delivered in the order the items came, however long each step takes", async () => {
  const out: number[] = [];
  const errors: unknown[] = [];
  let running = 0;
  let most = 0;
  const push = inOrder(
    async (n: number) => {
      running++;
      most = Math.max(most, running);
      await tick(n % 3 === 0 ? 15 : n % 3 === 1 ? 1 : 8);
      running--;
      if (n === 4) throw new Error("no");
      return n === 6 ? null : n * 10;
    },
    (value) => out.push(value),
    { onError: (error) => errors.push(error) },
  );
  for (let n = 0; n < 10; n++) push(n);
  await tick(60);
  assert.deepEqual(out, [0, 10, 20, 30, 50, 70, 80, 90]);
  assert.equal(errors.length, 1);
  assert.ok(most > 1, "the steps ran one at a time");
});

test("nothing is delivered once the engine has closed, and a step that throws at once is skipped", async () => {
  const out: number[] = [];
  let alive = true;
  const push = inOrder(
    (n: number) => {
      if (n === 1) throw new Error("sync");
      return tick(5).then(() => n);
    },
    (value) => out.push(value),
    { alive: () => alive },
  );
  push(0);
  push(1);
  push(2);
  await tick(20);
  push(3);
  alive = false;
  await tick(20);
  assert.deepEqual(out, [0, 2]);
});

test("after(): runs once the items before it are delivered, and before the items after it", async () => {
  const out: string[] = [];
  const push = inOrder(
    (n: number) => tick(n === 0 ? 15 : 1).then(() => n),
    (value) => out.push(`frame ${value}`),
  );
  push(0);
  push(1);
  push.after(() => out.push("config"));
  push(2);
  // The slow first frame holds the configuration back, not the other way round.
  assert.deepEqual(out, []);
  await tick(40);
  assert.deepEqual(out, ["frame 0", "frame 1", "config", "frame 2"]);
  // Once closed, a later configuration is not announced.
  let alive = true;
  const closing = inOrder((n: number) => Promise.resolve(n), () => undefined, { alive: () => alive });
  let ran = false;
  alive = false;
  closing.after(() => (ran = true));
  await tick(5);
  assert.equal(ran, false);
});

test("a stream is announced as SFrame only when the transform encrypts", () => {
  const config = { id: 0, kind: "video", sframe: false } as unknown as StreamConfig;
  assert.equal(markStreamConfig(config, undefined), config);
  assert.equal(markStreamConfig(config, { receive: async (f) => f }), config);
  assert.equal(markStreamConfig(config, { sframe: true, send: async (f) => f }).sframe, true);
  assert.equal(config.sframe, false);
});
