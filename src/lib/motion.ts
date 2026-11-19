"use client";

/**
 * Motion tokens for animations driven from script. These mirror the `--dur-*` and `--ease-*`
 * custom properties in globals.css; change both together.
 */
export const DUR = { instant: 80, fast: 140, base: 200, move: 260, slow: 360 } as const;
export const EASE = {
  enter: "cubic-bezier(0.05, 0.7, 0.1, 1)",
  exit: "cubic-bezier(0.3, 0, 0.8, 0.15)",
  move: "cubic-bezier(0.2, 0, 0, 1)",
} as const;
export const DIST = { xs: 4, sm: 8, md: 16, page: 32 } as const;
export const SCALE_ENTER = 0.96;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Experiment switches for measuring the motion code; set on window before load. Empty in normal use. */
export function motionFlags(): Record<string, boolean> {
  return (typeof window !== "undefined" && (window as unknown as { __meetlyMotionFlags?: Record<string, boolean> }).__meetlyMotionFlags) || {};
}

export type Rect = { x: number; y: number; w: number; h: number };

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

const place = (r: Rect) => `translate(${r.x}px, ${r.y}px)`;

/** y for x on a CSS cubic-bezier(x1, y1, x2, y2) timing curve. */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (at(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return at(y1, y2, (lo + hi) / 2);
}
const easeMove = (x: number) => bezier(0.2, 0, 0, 1, x);
const STEPS = 10;

/**
 * Glides a tile that is already laid out at `to` from where it used to be (`from`).
 * Transform only, so the browser never re-runs layout while it plays.
 *
 * The tile's box is scaled exactly onto its old box, so the first frame matches what was on
 * screen. A box that changes shape would stretch what is inside it, so the picture layer is
 * counter-scaled to keep covering the box at its true proportions, and the name label
 * is counter-scaled to stay its natural size, as a real resize would look. (Rounded corners are
 * not corrected: animating a radius repaints every frame, and measured slower than it was worth.)
 * Returns the tile's own animation; the inner ones follow it.
 */
export function glide(el: HTMLElement, from: Rect, to: Rect, duration: number): Animation {
  const flags = motionFlags();
  const sx = flags.translateOnly ? 1 : from.w / to.w;
  const sy = flags.translateOnly ? 1 : from.h / to.h;
  // A tile that keeps its size only slides. Leaving scale out matters: an animated scale, even
  // of 1, makes the browser re-rasterise the tile's layer before the first frame.
  const sameSize = Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005;
  const main = el.animate(
    sameSize
      ? [{ transform: place(from) }, { transform: place(to) }]
      : [{ transform: `${place(from)} scale(${sx}, ${sy})` }, { transform: `${place(to)} scale(1, 1)` }],
    { duration, easing: EASE.move },
  );
  if (flags.noInner || (Math.abs(sx - 1) < 0.02 && Math.abs(sy - 1) < 0.02)) return main;

  const media: Keyframe[] = [];
  const natural: Keyframe[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const eased = easeMove(i / STEPS);
    const cx = sx + (1 - sx) * eased;
    const cy = sy + (1 - sy) * eased;
    const cover = Math.max(cx, cy);
    media.push({ transform: `scale(${cover / cx}, ${cover / cy})` });
    natural.push({ transform: `scale(${1 / cx}, ${1 / cy})` });
  }
  const inner: Animation[] = [];
  // Each correction is one more animated layer per tile, so each is used only where the eye
  // would catch its absence: the picture when the shape changes, the label when the size does.
  if (Math.abs(sx / sy - 1) >= 0.05) {
    const layer = el.querySelector<HTMLElement>(":scope > .tile-media");
    if (layer) inner.push(layer.animate(media, { duration }));
  }
  const resized = Math.max(sx, sy, 1 / sx, 1 / sy) > 1.5;
  if (resized) {
    const label = el.querySelector<HTMLElement>(":scope > .tile-meta");
    if (label) inner.push(label.animate(natural, { duration }));
  }
  // Cancelling the tile's glide (it was interrupted) takes the inner corrections with it.
  main.addEventListener("cancel", () => inner.forEach((animation) => animation.cancel()));
  return main;
}

/** Fades an element in at `rect`, optionally growing slightly from its centre. */
export function arrive(el: HTMLElement, rect: Rect, grow: boolean, duration: number = DUR.base): Animation {
  if (!grow) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: "ease-out" });
  const inset = (1 - SCALE_ENTER) / 2;
  return el.animate(
    [
      {
        opacity: 0,
        transform: `translate(${rect.x + rect.w * inset}px, ${rect.y + rect.h * inset}px) scale(${SCALE_ENTER})`,
      },
      { opacity: 1, transform: `${place(rect)} scale(1)` },
    ],
    { duration, easing: EASE.enter },
  );
}

/**
 * A still copy of a tile, used to keep its picture on screen for the length of a cross-fade or
 * exit after React has moved or removed the real one. Video is copied as a single frame onto a
 * canvas, so a ghost never holds a media stream open.
 */
export function ghostOf(el: HTMLElement, rect: Rect): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  const live = el.querySelectorAll("video");
  ghost.querySelectorAll("video").forEach((copy, index) => {
    const video = live[index];
    if (!video || video.videoWidth === 0 || video.dataset.ready !== "true") {
      copy.remove();
      return;
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      copy.replaceWith(canvas);
    } catch {
      copy.remove();
    }
  });
  ghost.querySelectorAll(".tile-actions").forEach((node) => node.remove());
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  for (const name of ["data-tile", "data-key", "role", "aria-label", "data-speaking", "id"]) ghost.removeAttribute(name);
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("data-placed", "");
  ghost.inert = true;
  ghost.classList.add("tile-ghost");
  ghost.style.cssText = `width:${rect.w}px;height:${rect.h}px;transform:${place(rect)};`;
  return ghost;
}
