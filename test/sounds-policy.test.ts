import assert from "node:assert/strict";
import { test } from "node:test";
import type { SoundName } from "../src/lib/sounds";
import { createCallSounds, HAND_SOUND_GAP_MS } from "../src/lib/useSounds";

/** The call's sound rules (createCallSounds in src/lib/useSounds.ts) on a fake clock and engine. */
function rig(headcount: number) {
  let clock = 0;
  const played: SoundName[] = [];
  const output = {
    play: (name: SoundName) => {
      played.push(name);
      return true;
    },
    skipped: () => {},
    setOutputDevice: () => {},
  };
  const sound = createCallSounds(() => headcount, { output, now: () => clock });
  // Past the settle time after joining.
  clock = 5000;
  return {
    sound,
    hands: () => played.filter((name) => name === "hand").length,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** `count` hands spread over `ms`. */
function flood(r: ReturnType<typeof rig>, moderator: boolean, count: number, ms: number) {
  for (let i = 0; i < count; i++) {
    r.sound.onHandRaised(moderator);
    r.advance(ms / count);
  }
}

test("hand sound: 200 hands in 5 s in a 231-person meeting: the host hears 1, a guest 0", () => {
  const host = rig(231);
  flood(host, true, 200, 5000);
  assert.equal(host.hands(), 1);
  const guest = rig(231);
  flood(guest, false, 200, 5000);
  assert.equal(guest.hands(), 0);
});

test("hand sound: in a large meeting a moderator hears at most one hand every 30 s", () => {
  const host = rig(100);
  flood(host, true, 120, 60_000);
  assert.ok(host.hands() <= 2, `${host.hands()} sounds`);
  assert.ok(host.hands() >= 2);
});

test("hand sound: up to 24 people a moderator hears each hand", () => {
  const host = rig(24);
  flood(host, true, 5, 50_000);
  assert.equal(host.hands(), 5);
});

test("hand sound: a guest hears only the first hand after a 30 s lull", () => {
  const guest = rig(10);
  flood(guest, false, 10, 10_000);
  assert.equal(guest.hands(), 1);
  // A hand 20 s after the last is not after a lull.
  guest.advance(20_000);
  guest.sound.onHandRaised(false);
  assert.equal(guest.hands(), 1);
  guest.advance(HAND_SOUND_GAP_MS);
  guest.sound.onHandRaised(false);
  assert.equal(guest.hands(), 2);
});

test("hand sound: nothing while the meeting settles after you join", () => {
  let clock = 0;
  const played: string[] = [];
  const sound = createCallSounds(() => 5, {
    output: { play: (name) => (played.push(name), true), skipped: () => {}, setOutputDevice: () => {} },
    now: () => clock,
  });
  clock = 1000;
  sound.onHandRaised(true);
  assert.deepEqual(played, []);
});
