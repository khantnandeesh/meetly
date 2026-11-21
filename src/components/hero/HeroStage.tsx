"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Count } from "./kit/Count";
import type { Act } from "./kit/act";
import { Stage } from "./kit/stage";
import { COMPACT_BELOW, MeetingScene, POSTER, SIZE, type HeroState } from "./scene";

/*
 * The animated illustration, loaded only once the page is idle and the illustration is in view,
 * and never under reduced motion (HeroArt.tsx). The stage plays only while it is on screen and
 * the tab is visible, and stops its CSS animations when it is not.
 *
 * The loop, about 11 seconds, opens and ends on the poster (Pat asking to join a one-to-one call):
 *   1. The pointer goes to Admit and presses it.
 *   2. The notification and the "1 waiting" badge go; the two tiles make room, Pat's grows in
 *      under them, and People counts three.
 *   3. Pat says hello: the speaking ring moves from Maya to Pat, then back.
 *   4. Pat leaves (their tile fades and the others close up), and a moment later knocks again,
 *      which is the opening frame.
 * On a phone the same story is told with a finger instead of a pointer.
 */

// The marks name each beat for the rehearsal's film (`--at`, `--states`); they change nothing on screen.
async function script(a: Act<HeroState>) {
  await a.wait(1100);
  a.mark("admit");
  await a.move({ at: "admit", x: 0.62, y: 0.62 });
  await a.wait(200);
  await a.click();
  // Answered: the notification goes and Pat is let in. Their tile waits for the others to move.
  a.mark("let-in");
  await a.set({ asking: false });
  await a.wait(120);
  void a.move("rest");
  await a.set({ admitted: true });
  await a.wait(1200);
  a.mark("pat-speaks");
  await a.set({ speaker: "pat" });
  await a.wait(2600);
  a.mark("maya-speaks");
  await a.set({ speaker: "maya" });
  await a.wait(1800);
  a.mark("pat-leaves");
  await a.set({ admitted: false });
  await a.wait(1500);
  // Pat knocks again: the frame the loop opens on.
  a.mark("knock");
  await a.set({ asking: true });
  await a.wait(1500);
}

export default function HeroStage({ quiet, onReady }: { quiet: boolean; onReady?: () => void }) {
  // The pointer is a mouse's on a computer and a fingertip on a phone: the stage decides the
  // design from its width, and so does this.
  const box = useRef<HTMLDivElement>(null);
  const [phone, setPhone] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setPhone(el.clientWidth < COMPACT_BELOW);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Tell the host once the first frame (the same picture as its poster) is on screen.
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => onReady?.());
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [onReady]);

  return (
    <div ref={box}>
      <Stage<HeroState>
        width={SIZE.wide.width}
        height={SIZE.wide.height}
        compact={{ below: COMPACT_BELOW, ...SIZE.compact }}
        theme="dark"
        fidelity="realistic"
        initial={POSTER}
        poster={POSTER}
        script={script}
        cursor={{ at: "rest", style: phone ? "touch" : "real" }}
        className="hero-stage"
      >
        {(s, _rect, layout) => (
          <MeetingScene s={s} layout={layout} quiet={quiet} count={(n) => <Count value={n} duration={420} />} />
        )}
      </Stage>
    </div>
  );
}
