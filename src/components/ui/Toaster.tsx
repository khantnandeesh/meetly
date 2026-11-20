"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";
import {
  DESKTOP_MODE,
  UPDATE_MS,
  isNews,
  order,
  overflow,
  place,
  queueUntil,
  type NoticeMode,
  type NoticePriority,
} from "@/lib/notices";

export type ToastInput = {
  title: string;
  body?: string;
  icon?: React.ReactNode;
  tone?: "default" | "danger";
  /**
   * What it asks of you (see src/lib/notices.ts). Defaults to "you" for a problem (`tone:
   * "danger"`) and "info" otherwise.
   */
  priority?: NoticePriority;
  action?: { label: string; onClick: () => void };
  /** A second, quieter choice shown before `action` ("Deny" beside "Admit"). */
  secondary?: { label: string; onClick: () => void };
  /**
   * The one answer offered when notifications are one line (a phone sheet is open, or the screen
   * is short), where two do not fit. Defaults to `action`; `secondary` is never shown then.
   */
  compactAction?: { label: string; onClick: () => void };
  /** Called when the person closes it with its ×, and only then (not when it times out or is answered). */
  onDismiss?: () => void;
  /** A toast with a tag updates the one already showing (or waiting) with that tag, in place. */
  tag?: string;
  /**
   * Milliseconds before auto-dismiss. Defaults to 4500. `Infinity` stays until it is answered or
   * dismissed. A tag in STATE_TAGS (src/lib/notices.ts) also makes it wait for room for as long as it takes.
   */
  duration?: number;
};

type Toast = ToastInput & { id: number; priority: NoticePriority; leaving: boolean };
type Waiting = { toast: Toast; until: number };

/** How the screen around the notifications is set out right now, for the rules in notices.ts. */
export type ToastSurface = NoticeMode & {
  /** Only the title line fits (a phone with a sheet open, a short screen): bodies are left out. */
  compact?: boolean;
  /** The one line sits over a phone's top bar, above an open sheet (see globals.css). */
  strip?: boolean;
};

type ToastApi = {
  push: (toast: ToastInput) => void;
  dismissTag: (tag: string) => void;
  clear: () => void;
  /** Called by the call screen as panels, sheets and dialogs open and close. */
  setSurface: (surface: ToastSurface) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <Toaster>");
  return api;
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [compact, setCompact] = useState(false);
  const [strip, setStrip] = useState(false);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);
  const mode = useRef<NoticeMode>(DESKTOP_MODE);
  // Auto-dismiss clocks, kept outside state so hovering can pause them without re-rendering.
  const clocks = useRef(new Map<number, { timer?: ReturnType<typeof setTimeout>; left: number; since: number }>());
  const paused = useRef(false);
  // In-place updates are held back so a count never ticks faster than it can be read.
  const shownAt = useRef(new Map<number, number>());
  const held = useRef(new Map<number, { input: ToastInput; timer: ReturnType<typeof setTimeout> }>());
  /** Notifications that matter but found no room; each waits a short while for a slot. */
  const queue = useRef<Waiting[]>([]);

  // The list is mirrored in a ref so pushes and dismissals can be worked out synchronously.
  const listRef = useRef<Toast[]>([]);
  const commit = useCallback((next: Toast[]) => {
    listRef.current = order(next);
    setToasts(listRef.current);
  }, []);

  const showing = useCallback(() => listRef.current.filter((t) => !t.leaving), []);

  // Declared up front so the functions below can refer to each other.
  const fns = useRef<{ promote: () => void; leave: (id: number) => void }>({ promote: () => {}, leave: () => {} });

  const forget = useCallback((id: number) => {
    clearTimeout(clocks.current.get(id)?.timer);
    clocks.current.delete(id);
    const pending = held.current.get(id);
    if (pending) clearTimeout(pending.timer);
    held.current.delete(id);
    shownAt.current.delete(id);
  }, []);

  const arm = useCallback((id: number, ms: number) => {
    clearTimeout(clocks.current.get(id)?.timer);
    clocks.current.delete(id);
    // Something that waits for an answer has no clock at all.
    if (!Number.isFinite(ms)) return;
    const clock = { left: ms, since: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
    if (!paused.current) clock.timer = setTimeout(() => fns.current.leave(id), ms);
    clocks.current.set(id, clock);
  }, []);

  const leave = useCallback(
    (id: number) => {
      forget(id);
      if (!listRef.current.some((t) => t.id === id && !t.leaving)) return;
      commit(listRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      fns.current.promote();
    },
    [commit, forget],
  );
  const remove = useCallback(
    (id: number) => {
      forget(id);
      commit(listRef.current.filter((t) => t.id !== id));
      fns.current.promote();
    },
    [commit, forget],
  );

  /** Puts a notification on screen now. */
  const show = useCallback(
    (toast: Toast) => {
      commit([...listRef.current, toast]);
      shownAt.current.set(toast.id, Date.now());
      arm(toast.id, toast.duration ?? 4500);
    },
    [arm, commit],
  );

  /** A slot came free: the most important notification still worth saying takes it. */
  const promote = useCallback(() => {
    const now = Date.now();
    queue.current = queue.current.filter((w) => w.until > now);
    while (queue.current.length > 0) {
      const visible = showing();
      const best = order(queue.current.map((w) => w.toast))[0];
      const placed = place(visible, best, mode.current);
      if (placed.kind === "show") {
        queue.current = queue.current.filter((w) => w.toast !== best);
        show(best);
        continue;
      }
      break;
    }
  }, [show, showing]);
  useLayoutEffect(() => {
    fns.current = { promote, leave };
  }, [promote, leave]);

  const update = useCallback(
    (existing: Toast, input: ToastInput) => {
      const ms = input.duration ?? 4500;
      const apply = (next: ToastInput) => {
        held.current.delete(existing.id);
        const current = listRef.current.find((t) => t.id === existing.id && !t.leaving);
        if (!current) return;
        // The new version replaces the old one whole: a button the old one had and the new one
        // does not ("Deny" for one person, gone once there are several) must not linger.
        commit(listRef.current.map((t) => (t === current ? { ...next, priority: current.priority, id: current.id, leaving: false } : t)));
        shownAt.current.set(existing.id, Date.now());
        arm(existing.id, next.duration ?? 4500);
      };
      const since = Date.now() - (shownAt.current.get(existing.id) ?? 0);
      const pending = held.current.get(existing.id);
      if (since >= UPDATE_MS && !pending) return apply(input);
      // Too soon after the last change: the latest version is shown when the time comes.
      if (pending) clearTimeout(pending.timer);
      const timer = setTimeout(() => apply(held.current.get(existing.id)?.input ?? input), Math.max(0, UPDATE_MS - since));
      held.current.set(existing.id, { input, timer });
      // Meanwhile the clock is kept from running out under a notification that is still news.
      arm(existing.id, ms + UPDATE_MS);
    },
    [arm, commit],
  );

  // The call screen says how much room there is; an open dialog has your attention, so news waits.
  const surfaceRef = useRef<NoticeMode>(DESKTOP_MODE);
  const dialogOpen = useRef(false);
  const refit = useCallback(() => {
    const surface = surfaceRef.current;
    const next = { max: surface.max, info: surface.info && !dialogOpen.current };
    const before = mode.current;
    mode.current = next;
    if (before.max === next.max && before.info === next.info) return;
    // What no longer fits makes way: news goes, anything that matters waits for room.
    const out = overflow(showing(), next);
    if (out.length > 0) {
      const ids = new Set(out.map((t) => t.id));
      out.forEach((t) => forget(t.id));
      commit(listRef.current.map((t) => (ids.has(t.id) ? { ...t, leaving: true } : t)));
      for (const t of out) {
        if (isNews(t.priority)) continue;
        queue.current = [...queue.current, { toast: { ...t, id: nextId.current++ }, until: queueUntil(t, Date.now()) }];
      }
    }
    promote();
  }, [commit, forget, promote, showing]);
  useEffect(() => {
    // Dialogs are portalled straight into <body>, so watching its children is enough to know.
    const check = () => {
      const open = document.body.querySelector('[role="dialog"]') !== null;
      if (open === dialogOpen.current) return;
      dialogOpen.current = open;
      refit();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [refit]);

  const api = useMemo<ToastApi>(
    () => ({
      push(input) {
        const priority: NoticePriority = input.priority ?? (input.tone === "danger" ? "you" : "info");
        if (input.tag) {
          const existing = showing().find((t) => t.tag === input.tag);
          if (existing) return update(existing, input);
          const waiting = queue.current.find((w) => w.toast.tag === input.tag);
          if (waiting) {
            waiting.toast = { ...input, priority, id: waiting.toast.id, leaving: false };
            return;
          }
        }
        const toast: Toast = { ...input, priority, id: nextId.current++, leaving: false };
        const placed = place(showing(), toast, mode.current);
        if (placed.kind === "drop") return;
        if (placed.kind === "queue") {
          queue.current = [...queue.current, { toast, until: queueUntil(toast, Date.now()) }];
          return;
        }
        if (placed.kind === "replace") {
          // What makes way bows out rather than vanishes; if it still matters it waits for room.
          const evicted = listRef.current.find((t) => t.id === placed.evict);
          forget(placed.evict);
          commit(listRef.current.map((t) => (t.id === placed.evict ? { ...t, leaving: true } : t)));
          if (evicted && !isNews(evicted.priority)) {
            queue.current = [...queue.current, { toast: { ...evicted, id: nextId.current++ }, until: queueUntil(evicted, Date.now()) }];
          }
        }
        show(toast);
      },
      dismissTag(tag) {
        queue.current = queue.current.filter((w) => w.toast.tag !== tag);
        const going = listRef.current.filter((t) => t.tag === tag && !t.leaving);
        if (going.length === 0) return;
        going.forEach((t) => forget(t.id));
        commit(listRef.current.map((t) => (t.tag === tag ? { ...t, leaving: true } : t)));
        promote();
      },
      clear() {
        listRef.current.forEach((t) => forget(t.id));
        queue.current = [];
        commit([]);
      },
      setSurface(surface) {
        const { compact: tight = false, strip: overBar = false, ...next } = surface;
        setCompact(tight);
        setStrip(overBar);
        surfaceRef.current = next;
        refit();
      },
    }),
    [commit, forget, promote, refit, show, showing, update],
  );

  // Opt-in handle for tests and debugging, like window.__meetly: localStorage["meetly:debug"] = "1".
  useEffect(() => {
    try {
      if (localStorage.getItem("meetly:debug") !== "1") return;
    } catch {
      return;
    }
    const target = window as unknown as { __meetlyToast?: ToastApi };
    target.__meetlyToast = api;
    return () => {
      if (target.__meetlyToast === api) delete target.__meetlyToast;
    };
  }, [api]);

  // Reading a toast should not be a race: the clocks stop while the pointer or focus is on them.
  const pause = useCallback(() => {
    if (paused.current) return;
    paused.current = true;
    clocks.current.forEach((clock) => {
      clearTimeout(clock.timer);
      clock.left = Math.max(1200, clock.left - (Date.now() - clock.since));
    });
  }, []);
  const resume = useCallback(() => {
    if (!paused.current) return;
    paused.current = false;
    clocks.current.forEach((clock, id) => {
      clock.since = Date.now();
      clock.timer = setTimeout(() => leave(id), clock.left);
    });
  }, [leave]);

  // When a toast comes or goes, the others slide to their new place instead of jumping. Places
  // are measured from the edge the stack grows from (the bottom, beside the controls on large
  // screens): a stack anchored at the bottom grows upwards, so a toast that stays where it is on
  // screen has a different offset from the top, and one that moves may not.
  const places = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const box = region.getBoundingClientRect();
    const fromBottom = getComputedStyle(region).flexDirection === "column-reverse";
    const before = places.current;
    const after = new Map<number, number>();
    const nodes = Array.from(region.querySelectorAll<HTMLElement>("[data-toast]"));
    // Layout boxes, without any transform a running animation adds.
    for (const node of nodes) {
      const top = node.offsetTop;
      after.set(Number(node.dataset.toast), fromBottom ? top + node.offsetHeight - box.height : top);
    }
    places.current = after;
    if (prefersReducedMotion()) return;
    for (const node of nodes) {
      const id = Number(node.dataset.toast);
      const was = before.get(id);
      const now = after.get(id)!;
      if (was === undefined || Math.abs(was - now) < 1) continue;
      node.animate([{ transform: `translateY(${was - now}px)` }, { transform: "translateY(0)" }], {
        duration: DUR.base,
        easing: EASE.move,
      });
    }
  }, [toasts]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        ref={regionRef}
        role="region"
        aria-label="Notifications"
        data-compact={compact || undefined}
        data-strip={strip || undefined}
        onPointerEnter={pause}
        onPointerLeave={resume}
        onFocus={pause}
        onBlur={resume}
        className="toast-region pointer-events-none fixed z-45 flex flex-col gap-2 px-3"
      >
        <div role="status" aria-live="polite" className="contents">
          {toasts.map((toast) => {
            // On one line there is room for one answer (see `compactAction`).
            const action = compact ? (toast.compactAction ?? toast.action) : toast.action;
            const secondary = compact ? undefined : toast.secondary;
            return (
            <div
              key={toast.id}
              data-toast={toast.id}
              data-priority={toast.priority}
              data-leaving={toast.leaving}
              onAnimationEnd={(event) => {
                if (toast.leaving && event.target === event.currentTarget) remove(toast.id);
              }}
              className="toast pointer-events-auto flex w-[min(24rem,100%)] flex-wrap items-center gap-x-3 rounded-2xl bg-surface-2 py-2 pr-2 pl-3.5 text-sm shadow-[inset_0_0_0_1px_var(--border-strong),0_16px_40px_-12px_rgb(0_0_0/0.7)]"
            >
              {toast.icon && (
                <span className={`shrink-0 ${toast.tone === "danger" ? "text-danger-text" : "text-accent"}`} aria-hidden="true">
                  {toast.icon}
                </span>
              )}
              <p className="min-w-0 flex-1 py-1.5">
                <span className="toast-title block font-medium break-words hyphens-auto">{toast.title}</span>
                {toast.body && <span className="toast-body mt-0.5 line-clamp-2 block break-words text-muted">{toast.body}</span>}
              </p>
              {/* Two answers ("Deny", "Admit") go on a line of their own under the text, so a long
                  name wraps between words instead of being squeezed into a sliver beside them. */}
              <div className={secondary ? "toast-actions order-last -mt-1.5 flex basis-full justify-end gap-1" : "contents"}>
                {secondary && (
                  <button
                    className="h-9 shrink-0 cursor-pointer rounded-lg px-3 font-semibold text-muted transition-colors hover:bg-surface-3 hover:text-text"
                    onClick={() => {
                      secondary.onClick();
                      remove(toast.id);
                    }}
                  >
                    {secondary.label}
                  </button>
                )}
                {action && (
                  <button
                    className="h-9 shrink-0 cursor-pointer rounded-lg px-3 font-semibold text-accent transition-colors hover:bg-surface-3"
                    onClick={() => {
                      action.onClick();
                      remove(toast.id);
                    }}
                  >
                    {action.label}
                  </button>
                )}
              </div>
              <button
                className="icon-btn size-9 hover:bg-surface-3"
                aria-label="Dismiss notification"
                onClick={() => {
                  toast.onDismiss?.();
                  leave(toast.id);
                }}
              >
                <X className="size-4" />
              </button>
            </div>
            );
          })}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
