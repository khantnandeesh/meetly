"use client";

import { useRoomContext, type TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { Track } from "livekit-client";
import { ChevronLeft, ChevronRight, MonitorUp } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  DIST,
  DUR,
  EASE,
  arrive,
  ghostOf,
  glide,
  prefersReducedMotion,
  sameRect,
  type Rect,
} from "@/lib/motion";
import { Tile } from "./Tile";
import { avatarColor, initials } from "./ui/Avatar";
import { Tip } from "./ui/Tip";

const MAX_RATIO = 16 / 9;
const STRIP_GAP = 12;
/** With more tiles than this on screen, gliding them is noise (and work): they snap instead. */
const MAX_GLIDING = 24;
/** Up to this many tiles on screen, arrivals grow in and departures fade out one by one; above it, arrivals just fade. */
const MAX_INDIVIDUAL = 8;
/** Height of the gallery page bar (h-11) and the gap above it (gap-2), in px. */
const PAGE_BAR = 44;
const PAGE_BAR_GAP = 8;
/** How long a hand-over waits for the incoming video's first frame before fading in regardless. */
const READY_WAIT_MS = 400;
/** A tile that would have to shrink by more than this factor cross-fades instead of gliding. */
const SHRINK_LIMIT = 2.2;
/** Phones, screen share on top: how many cells (people, plus "+N more") sit underneath it. */
const STACK_LIMIT = 6;

export function refKey(ref: TrackReferenceOrPlaceholder): string {
  return `${ref.participant.identity}:${ref.source}`;
}

/** Tracks an element's content box. Updates land in the same frame as the resize, before paint. */
export function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Without flushSync React would commit the new layout a frame late, and that one frame
      // would show the old tile sizes inside the new box.
      flushSync(() => setBox((old) => (old.w === width && old.h === height ? old : { w: width, h: height })));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

/* ---------------------------------------------------------------- geometry */

type Slot = {
  key: string;
  ref: TrackReferenceOrPlaceholder;
  rect: Rect;
  role: "main" | "strip" | "grid";
};

/** Centred, evenly sized cells: the column count that gives `count` tiles the largest area. */
function gridRects(count: number, w: number, h: number, gap: number, minRatio: number): Rect[] {
  let best = { width: 0, height: 0, cols: 1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (w - gap * (cols - 1)) / cols;
    const cellH = (h - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const ratio = Math.min(MAX_RATIO, Math.max(minRatio, cellW / cellH));
    const width = Math.min(cellW, cellH * ratio);
    const height = width / ratio;
    if (width * height > best.width * best.height) best = { width, height, cols };
  }
  const tw = Math.floor(best.width);
  const th = Math.floor(best.height);
  if (tw <= 0 || th <= 0) return [];
  const rows = Math.ceil(count / best.cols);
  const top = (h - (rows * th + (rows - 1) * gap)) / 2;
  const rects: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / best.cols);
    const inRow = row === rows - 1 ? count - row * best.cols : best.cols;
    const left = (w - (inRow * tw + (inRow - 1) * gap)) / 2;
    rects.push({
      x: Math.round(left + (i % best.cols) * (tw + gap)),
      y: Math.round(top + row * (th + gap)),
      w: tw,
      h: th,
    });
  }
  return rects;
}

/** Height that fits a landscape screen share exactly at this width; 0 if it is not landscape. */
function shareHeight(ref: TrackReferenceOrPlaceholder, width: number): number {
  const size = ref.publication?.dimensions;
  const ratio = size && size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9;
  return ratio > 1.2 ? Math.round(width / Math.min(ratio, 2.4)) : 0;
}

type StageProps = {
  view: "tiled" | "sidebar" | "spotlight";
  /** Tiled: the tiles on the current page only. */
  tiles: TrackReferenceOrPlaceholder[];
  /** Tiled: tiles across all pages. */
  total: number;
  /** Tiled: index of this page's first tile within the full list. */
  rangeStart: number;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  /** Speaker-led views: the large tile and everyone else. */
  main?: TrackReferenceOrPlaceholder;
  others: TrackReferenceOrPlaceholder[];
  phone: boolean;
  pinned: boolean;
  onTogglePin: (ref: TrackReferenceOrPlaceholder) => void;
  onShowEveryone: () => void;
};

type Snapshot = {
  view: string;
  page: number;
  mainKey: string | null;
  pinned: boolean;
  box: { w: number; h: number };
  boxChangedAt: number;
  /** Which whole-stage arrangement this was ("share" on a phone with a screen share, else "people"). */
  swap: string;
  rects: Map<string, Rect>;
  elements: Map<string, HTMLElement>;
  /** A speaker hand-over whose incoming picture is still awaited, and the still it shows meanwhile. */
  pending?: { key: string; copy: HTMLElement };
};

/**
 * The meeting stage: every visible tile, in whichever layout is active.
 *
 * All layouts share one layer and every tile is placed by transform, keyed by who it shows. So a
 * tile that is on screen before and after a change (someone joining, a layout switch, a pin, a
 * panel opening) is the same element with the same playing video, and simply glides to its new
 * place. Only tiles that are actually shown are rendered: the filmstrip collapses what does not
 * fit into a "+N" cell and the gallery renders one page, so off-screen video is never attached.
 */
export function Stage({
  view,
  tiles,
  total,
  rangeStart,
  page,
  pageCount,
  onPage,
  main,
  others,
  phone,
  pinned,
  onTogglePin,
  onShowEveryone,
}: StageProps) {
  const room = useRoomContext();
  // The whole stage is measured, and the page bar's height taken off in arithmetic. Measuring the
  // tile area itself would mean a second layout pass every time the bar appears or disappears.
  const [outerRef, outer] = useBox<HTMLDivElement>();
  const layerRef = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const focused = view !== "tiled" && !!main;
  const paged = !focused && pageCount > 1;
  const box = useMemo(
    () => ({ w: outer.w, h: Math.max(0, outer.h - (paged ? PAGE_BAR + PAGE_BAR_GAP : 0)) }),
    [outer.w, outer.h, paged],
  );
  const ready = box.w > 0 && box.h > 0;

  /* -------------------------------------------------------------- placement */
  const slots: Slot[] = [];
  let more: { rect: Rect; hidden: TrackReferenceOrPlaceholder[] } | null = null;
  if (ready && focused && main) {
    const showStrip = view === "sidebar" && others.length > 0;
    // Strip tiles are 224×126 in a column on large screens, 104×96 in a row on phones.
    const cell = phone ? { w: 104, h: 96 } : { w: 224, h: 126 };
    // A landscape screen share on an upright phone would be a thin band in a tall black box.
    // It gets a box of its own shape instead, and the people take the room that frees up.
    const shareH = phone && showStrip && main.source === Track.Source.ScreenShare ? shareHeight(main, box.w) : 0;
    const stacked = shareH > 0 && box.h - shareH - STRIP_GAP >= cell.h * 2;
    const mainRect: Rect = !showStrip
      ? { x: 0, y: 0, w: box.w, h: box.h }
      : stacked
        ? { x: 0, y: 0, w: box.w, h: shareH }
        : phone
          ? { x: 0, y: 0, w: box.w, h: Math.max(0, box.h - cell.h - STRIP_GAP) }
          : { x: 0, y: 0, w: Math.max(0, box.w - cell.w - STRIP_GAP), h: box.h };
    slots.push({
      key: refKey(main),
      ref: main,
      rect: roundRect(mainRect),
      role: "main",
    });
    if (showStrip && stacked) {
      const top = shareH + STRIP_GAP;
      const overflowing = others.length > STACK_LIMIT;
      const shown = overflowing ? others.slice(0, STACK_LIMIT - 1) : others;
      const rects = gridRects(shown.length + (overflowing ? 1 : 0), box.w, box.h - top, STRIP_GAP, 0.7);
      const at = (index: number): Rect => ({ ...rects[index], y: rects[index].y + top });
      shown.forEach((ref, index) => {
        if (rects[index]) slots.push({ key: refKey(ref), ref, rect: at(index), role: "strip" });
      });
      if (overflowing && rects[shown.length]) more = { rect: at(shown.length), hidden: others.slice(STACK_LIMIT - 1) };
    } else if (showStrip) {
      const extent = phone ? box.w : box.h;
      const unit = phone ? cell.w : cell.h;
      const capacity = Math.max(1, Math.floor((extent + STRIP_GAP) / (unit + STRIP_GAP)));
      const overflowing = others.length > capacity;
      const shown = overflowing ? others.slice(0, capacity - 1) : others;
      const at = (index: number): Rect =>
        phone
          ? {
              x: index * (cell.w + STRIP_GAP),
              y: box.h - cell.h,
              w: cell.w,
              h: cell.h,
            }
          : {
              x: box.w - cell.w,
              y: index * (cell.h + STRIP_GAP),
              w: cell.w,
              h: cell.h,
            };
      shown.forEach((ref, index) =>
        slots.push({
          key: refKey(ref),
          ref,
          rect: roundRect(at(index)),
          role: "strip",
        }),
      );
      if (overflowing)
        more = {
          rect: roundRect(at(shown.length)),
          hidden: others.slice(capacity - 1),
        };
    }
  } else if (ready && tiles.length > 0) {
    const gap = tiles.length > 25 ? 6 : tiles.length > 9 ? 8 : 12;
    const rects = gridRects(tiles.length, box.w, box.h, gap, box.w < 640 ? 0.7 : 1.2);
    tiles.forEach((ref, index) => {
      if (rects[index]) slots.push({ key: refKey(ref), ref, rect: rects[index], role: "grid" });
    });
  }
  const mainSlot = slots[0]?.role === "main" ? slots[0] : null;
  const sharingOwnScreen =
    !!mainSlot && mainSlot.ref.participant.isLocal && mainSlot.ref.source === Track.Source.ScreenShare;
  const layout = focused ? (view === "sidebar" ? "focus" : "spotlight") : "grid";

  /* ------------------------------------------------------------------ motion */
  const last = useRef<Snapshot | null>(null);
  const flights = useRef(new WeakMap<HTMLElement, Animation>());
  const signature = slots.map((s) => `${s.key}@${s.rect.x},${s.rect.y},${s.rect.w},${s.rect.h}`).join("|");

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const state = {
      slots,
      layout,
      page,
      pinned,
      box,
      // On a phone a screen share rearranges everything at once; that swap is a cross-fade.
      swap: phone && !!mainSlot && mainSlot.ref.source === Track.Source.ScreenShare ? "share" : "people",
      phone,
    };
    // Moving the tiles and starting their animations waits for the end of this commit (a
    // microtask: still before the browser paints). Other components measure the page while
    // React commits (menus and tooltips read computed styles, video attaches read sizes); done
    // in the middle of that, every one of those reads had to re-resolve the whole stage.
    queueMicrotask(() => {
      if (!layer.isConnected) return;
      placeTiles(layer, state.slots);
      animateStage(layer, last, flights, state);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands for the slots
  }, [signature, layout, page, pinned, box]);

  /* ------------------------------------------------------------------- swipe */
  function endSwipe(dx: number, dy: number) {
    const layer = layerRef.current;
    const drag = swipe.current;
    swipe.current = null;
    if (!drag || !paged) return;
    const turn = Math.abs(dx) >= 56 && Math.abs(dx) >= Math.abs(dy) * 1.5;
    const target = dx < 0 ? page + 1 : page - 1;
    const possible = target >= 0 && target < pageCount;
    if (layer && drag.dragging) {
      const from = layer.style.transform;
      layer.style.transform = "";
      // Settle back when the page did not change; a page change brings its own entrance.
      if (!(turn && possible) && !prefersReducedMotion()) {
        layer.animate([{ transform: from }, { transform: "translateX(0)" }], {
          duration: DUR.base,
          easing: EASE.move,
        });
      }
    }
    if (turn && possible) onPage(target);
  }

  return (
    <div ref={outerRef} className="flex size-full flex-col gap-2" data-layout={layout} data-dense={slots.length > 9}>
      <div
        className="relative min-h-0 flex-1 touch-pan-y"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          swipe.current = {
            x: touch.clientX,
            y: touch.clientY,
            dragging: false,
          };
        }}
        onTouchMove={(event) => {
          const drag = swipe.current;
          const layer = layerRef.current;
          if (!drag || !paged || !layer || prefersReducedMotion()) return;
          const dx = event.touches[0].clientX - drag.x;
          const dy = event.touches[0].clientY - drag.y;
          if (!drag.dragging && (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5)) return;
          drag.dragging = true;
          // The page follows the finger, with resistance, so the swipe feels attached.
          layer.style.transform = `translateX(${Math.max(-96, Math.min(96, dx * 0.5))}px)`;
        }}
        onTouchEnd={(event) => {
          const from = swipe.current;
          if (!from) return;
          const touch = event.changedTouches[0];
          endSwipe(touch.clientX - from.x, touch.clientY - from.y);
        }}
        onTouchCancel={() => endSwipe(0, 0)}
      >
        <div ref={layerRef} className="absolute inset-0">
          {slots.map((slot) => (
            <Tile
              key={slot.key}
              trackRef={slot.ref}
              rect={slot.rect}
              slot={slot.role}
              pinned={slot.role === "main" && pinned}
              onTogglePin={
                slot.role === "main"
                  ? pinned
                    ? onTogglePin
                    : undefined
                  : slot.role === "strip" || total > 1
                    ? onTogglePin
                    : undefined
              }
            />
          ))}
          {more && (
            <button
              key="more"
              onClick={onShowEveryone}
              data-placed
              style={{
                width: more.rect.w,
                height: more.rect.h,
                transform: `translate(${more.rect.x}px, ${more.rect.y}px)`,
              }}
              className="tile flex cursor-pointer flex-col items-center justify-center gap-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <span className="flex -space-x-2" aria-hidden="true">
                {more.hidden.slice(0, 3).map((ref) => (
                  <span
                    key={refKey(ref)}
                    className="grid size-8 place-items-center rounded-full font-display text-xs font-semibold text-[#16161d] ring-2 ring-surface"
                    style={{
                      background: avatarColor(ref.participant.identity),
                    }}
                  >
                    {initials(ref.participant.name || "Guest")}
                  </span>
                ))}
              </span>
              <span className="text-[0.8125rem] font-medium">
                {more.hidden.length} more
                <span className="sr-only"> people, show everyone</span>
              </span>
            </button>
          )}
        </div>

        {sharingOwnScreen && mainSlot && (
          <div
            className="pointer-events-none absolute top-3 left-0 z-30 flex justify-center"
            style={{ width: mainSlot.rect.w }}
          >
            <div className="anim-pop pointer-events-auto flex items-center gap-3 rounded-2xl bg-[rgb(11_11_15/0.8)] py-1.5 pr-1.5 pl-3.5 text-sm font-medium whitespace-nowrap backdrop-blur-md">
              <MonitorUp className="size-4 text-accent" aria-hidden="true" />
              You&apos;re sharing your screen
              <button
                className="h-9 cursor-pointer rounded-xl bg-danger px-3 font-semibold text-white transition-colors hover:bg-(--danger-hover)"
                onClick={() => room.localParticipant.setScreenShareEnabled(false).catch(() => {})}
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {paged && (
        <nav className="anim-fade flex h-11 shrink-0 items-center justify-center gap-1 text-sm text-muted" aria-label="Gallery pages">
          <Tip label="Previous page" shortcut="←">
            <button
              className="icon-btn disabled:pointer-events-none disabled:opacity-35 pointer-coarse:size-11"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => onPage(page - 1)}
            >
              <ChevronLeft className="size-5" />
            </button>
          </Tip>
          <p className="min-w-40 text-center tabular-nums" aria-live="polite">
            <span className="font-semibold text-text">
              Page {page + 1} of {pageCount}
            </span>
            <span className="max-sm:hidden">
              {" "}
              · {rangeStart + 1}–{rangeStart + tiles.length} of {total}
            </span>
          </p>
          <Tip label="Next page" shortcut="→">
            <button
              className="icon-btn disabled:pointer-events-none disabled:opacity-35 pointer-coarse:size-11"
              aria-label="Next page"
              disabled={page >= pageCount - 1}
              onClick={() => onPage(page + 1)}
            >
              <ChevronRight className="size-5" />
            </button>
          </Tip>
        </nav>
      )}
    </div>
  );
}

let lastWindowResize = -Infinity;
let watchingWindow = false;
/** When the browser window last changed size. */
function windowResizedAt(): number {
  if (!watchingWindow && typeof window !== "undefined") {
    watchingWindow = true;
    window.addEventListener("resize", () => (lastWindowResize = performance.now()), { passive: true });
  }
  return lastWindowResize;
}

/**
 * Writes each tile's place onto its element. Tiles are memoised and deliberately not re-rendered
 * when only their rect changes, so this is what moves them. React still writes the same values
 * whenever a tile does render, so the two never disagree.
 */
function placeTiles(layer: HTMLElement, slots: Slot[]) {
  const rects = new Map(slots.map((slot) => [slot.key, slot.rect]));
  layer.querySelectorAll<HTMLElement>(":scope > [data-key]").forEach((el) => {
    const rect = rects.get(el.dataset.key!);
    if (!rect) return;
    const transform = `translate(${rect.x}px, ${rect.y}px)`;
    if (el.style.transform !== transform) el.style.transform = transform;
    if (el.style.width !== `${rect.w}px`) el.style.width = `${rect.w}px`;
    if (el.style.height !== `${rect.h}px`) el.style.height = `${rect.h}px`;
  });
}

/**
 * Runs after every change to the stage, before the browser paints it: works out what moved,
 * arrived or left since the last commit and starts the matching animations.
 */
function animateStage(
  layer: HTMLElement,
  lastRef: { current: Snapshot | null },
  flightsRef: { current: WeakMap<HTMLElement, Animation> },
  {
    slots,
    layout,
    page,
    pinned,
    box,
    swap,
    phone,
  }: {
    slots: Slot[];
    layout: string;
    page: number;
    pinned: boolean;
    box: { w: number; h: number };
    swap: string;
    phone: boolean;
  },
) {
  const mainSlot = slots[0]?.role === "main" ? slots[0] : null;
  const now = performance.now();
  const prev = lastRef.current;
  const flights = flightsRef.current;
  const elements = new Map<string, HTMLElement>();
  layer.querySelectorAll<HTMLElement>(":scope > [data-key]").forEach((el) => elements.set(el.dataset.key!, el));
  const rects = new Map(slots.map((s) => [s.key, s.rect]));
  const boxChanged = !prev || prev.box.w !== box.w || prev.box.h !== box.h;
  const next: Snapshot = {
    view: layout,
    page,
    mainKey: mainSlot?.key ?? null,
    pinned,
    box,
    boxChangedAt: boxChanged ? now : (prev?.boxChangedAt ?? 0),
    swap,
    rects,
    elements,
  };
  lastRef.current = next;
  if (!prev || prev.rects.size === 0) {
    // First paint of the stage: everything fades in together.
    if (slots.length > 0)
      layer.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: DUR.base,
        easing: "ease-out",
      });
    return;
  }

  const reduced = prefersReducedMotion();
  const track = (el: HTMLElement, animation: Animation) => {
    flights.set(el, animation);
    // A cancel event arrives late, after the next glide may have taken over this tile: only the
    // tile's current animation may clear its state.
    animation.onfinish = animation.oncancel = () => {
      if (flights.get(el) !== animation) return;
      flights.delete(el);
      el.style.zIndex = "";
    };
  };
  const land = (el: HTMLElement) => flights.get(el)?.cancel();

  // A window being dragged fires a resize every frame: follow it directly, as native apps do.
  // (Only the window: a panel opening and the page bar appearing a moment apart both glide.)
  if (boxChanged && now - windowResizedAt() < 150 && now - prev.boxChangedAt < 150) {
    elements.forEach(land);
    return;
  }

  // Another gallery page: the whole page arrives as one layer, from the side it came from.
  if (layout === "grid" && prev.view === "grid" && prev.page !== page) {
    elements.forEach(land);
    const from = reduced ? 0 : DIST.page * (page > prev.page ? 1 : -1);
    layer.animate(
      [
        { opacity: 0, transform: `translateX(${from}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: reduced ? 120 : DUR.move, easing: EASE.enter },
    );
    return;
  }

  // A phone going into or out of the screen-share arrangement: nearly every tile would have to
  // cross the others to get to its new place. The two arrangements cross-fade instead.
  if (phone && prev.swap !== swap) {
    elements.forEach(land);
    const ms = reduced ? 120 : DUR.base;
    for (const [key, el] of prev.elements) {
      const rect = prev.rects.get(key);
      if (!rect) continue;
      const copy = ghostOf(el, rect);
      layer.prepend(copy);
      const out = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-in", fill: "forwards" });
      out.onfinish = out.oncancel = () => copy.remove();
      setTimeout(() => copy.remove(), 1000);
    }
    for (const slot of slots) {
      const el = elements.get(slot.key);
      if (el) track(el, arrive(el, slot.rect, false, ms));
    }
    return;
  }

  const sameView = prev.view === layout;
  // The stage changed hands by itself (somebody else started talking): cross-fade, don't zoom.
  const handover =
    sameView && layout !== "grid" && prev.pinned === pinned && !!next.mainKey && prev.mainKey !== next.mainKey;
  const arriving = slots.filter((s) => !prev.rects.has(s.key));
  const leaving = [...prev.rects.keys()].filter((key) => !rects.has(key));
  const moving = slots.filter((s) => {
    const before = prev.rects.get(s.key);
    return before && !sameRect(before, s.rect);
  });

  // 1. Read: where is everything right now. Only tiles already mid-flight need measuring, and
  // measuring forces the browser to lay out the new arrangement on the spot, so it is skipped
  // entirely when nothing is in flight (the usual case).
  const starts = new Map<string, Rect>();
  let origin: DOMRect | null = null;
  for (const slot of moving) {
    const el = elements.get(slot.key);
    const before = prev.rects.get(slot.key)!;
    if (el && flights.has(el)) {
      origin ??= layer.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      starts.set(slot.key, { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    } else {
      starts.set(slot.key, before);
    }
  }

  // 2. Write.
  const ghost = (key: string, maxMs = 1000): HTMLElement | undefined => {
    const el = prev.elements.get(key);
    const rect = prev.rects.get(key);
    if (!el || !rect) return undefined;
    const copy = ghostOf(el, rect);
    layer.prepend(copy);
    // Whatever happens to the animation that owns it, a ghost never outlives a second.
    setTimeout(() => {
      // A still handed on to a later hand-over is that one's to remove.
      if (lastRef.current?.pending?.copy !== copy) copy.remove();
    }, maxMs);
    return copy;
  };
  const fadeAway = (copy: HTMLElement | undefined) => {
    if (!copy) return;
    const out = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: DUR.fast,
      easing: "ease-in",
      fill: "forwards",
    });
    out.onfinish = out.oncancel = () => copy.remove();
  };

  const fadeMs = reduced ? 120 : DUR.base;
  if (handover && prev.mainKey) {
    // The outgoing speaker's last frame stays underneath until the incoming picture is ready,
    // then the new one fades in over it: one cross-fade, never a flash of avatar in between.
    // If the previous hand-over is still waiting (its speaker never became visible), the still
    // already on screen stays for this one: two hand-overs in a row must not flash a third face.
    const waiting = prev.pending && prev.pending.key === prev.mainKey && prev.pending.copy.isConnected;
    const copy = waiting ? prev.pending!.copy : ghost(prev.mainKey, READY_WAIT_MS + fadeMs + 300);
    if (copy) next.pending = { key: next.mainKey!, copy };
    const mine = next.pending;
    const drop = () => {
      // Only the hand-over that still owns the still may take it away.
      if (!copy || (lastRef.current?.pending && lastRef.current.pending !== mine && lastRef.current.pending.copy === copy)) return;
      copy.remove();
    };
    const incoming = elements.get(next.mainKey!);
    if (incoming) {
      land(incoming);
      const hold = incoming.animate([{ opacity: 0 }, { opacity: 0 }], { duration: READY_WAIT_MS + 100 });
      track(incoming, hold);
      whenPictureReady(incoming, READY_WAIT_MS, () => {
        if (flights.get(incoming) !== hold) return drop();
        hold.cancel();
        const fade = arrive(incoming, mainSlot!.rect, false, fadeMs);
        track(incoming, fade);
        fade.finished.then(drop).catch(drop);
      });
    } else {
      drop();
    }
    const outgoing = elements.get(prev.mainKey);
    if (outgoing) {
      land(outgoing);
      track(outgoing, arrive(outgoing, rects.get(prev.mainKey)!, false, fadeMs));
    }
  }

  const glideMs = sameView ? DUR.move : DUR.slow;
  const gliding = reduced || slots.length > MAX_GLIDING ? [] : moving;
  for (const slot of moving) {
    const el = elements.get(slot.key);
    if (!el) continue;
    if (handover && (slot.key === next.mainKey || slot.key === prev.mainKey)) continue;
    land(el);
    if (!gliding.includes(slot)) continue;
    const from = starts.get(slot.key)!;
    if (from.w <= 0 || from.h <= 0 || slot.rect.w <= 0 || slot.rect.h <= 0) continue;
    if (Math.max(from.w / slot.rect.w, from.h / slot.rect.h) > SHRINK_LIMIT) {
      // A tile shrinking this much (the main tile going back to the filmstrip) would start out
      // hugely scaled up, corners and all. It dissolves where it was and appears where it is going.
      fadeAway(ghost(slot.key));
      track(el, arrive(el, slot.rect, true, fadeMs));
      continue;
    }
    // Tiles that shrink travel above tiles that grow, so nothing is hidden on the way.
    if (from.w * from.h > slot.rect.w * slot.rect.h) el.style.zIndex = "2";
    track(el, glide(el, from, slot.rect, glideMs));
  }

  for (const slot of arriving) {
    // Somebody who left and is already back must not be on screen twice.
    layer.querySelectorAll<HTMLElement>(":scope > .tile-ghost").forEach((copy) => {
      if (copy.dataset.ghostOf === slot.key) copy.remove();
    });
    const el = elements.get(slot.key);
    if (!el || (handover && slot.key === next.mainKey)) continue;
    // In a small call a newcomer grows in, and waits for the neighbours to make room first:
    // they glide, and it appears over the last third of their move instead of on top of them.
    const individual = !reduced && slots.length <= MAX_INDIVIDUAL && arriving.length <= 2;
    const wait = individual && sameView && gliding.length > 0 ? Math.round((glideMs * 2) / 3) : 0;
    track(el, arrive(el, slot.rect, individual, fadeMs, wait));
  }
  if (sameView && leaving.length <= 4) {
    for (const key of leaving) if (!(handover && key === prev.mainKey)) fadeAway(ghost(key));
  }
}

/** Calls back once the tile's video has a frame (straight away if it shows an avatar), or after `maxMs`. */
function whenPictureReady(tile: HTMLElement, maxMs: number, done: () => void) {
  const pending = () => tile.querySelector('video:not([data-ready="true"])') !== null;
  if (!pending()) return done();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    clearTimeout(timer);
    done();
  };
  const observer = new MutationObserver(() => !pending() && finish());
  observer.observe(tile, { subtree: true, attributes: true, attributeFilter: ["data-ready"], childList: true });
  const timer = setTimeout(finish, maxMs);
}

function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.w),
    h: Math.round(r.h),
  };
}
