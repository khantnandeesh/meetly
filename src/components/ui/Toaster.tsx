"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DUR, EASE, prefersReducedMotion } from "@/lib/motion";

export type ToastInput = {
  title: string;
  body?: string;
  icon?: React.ReactNode;
  tone?: "default" | "danger";
  action?: { label: string; onClick: () => void };
  /** Toasts sharing a tag can be dismissed together. */
  tag?: string;
  /** Milliseconds before auto-dismiss. Defaults to 4500. */
  duration?: number;
};

type Toast = ToastInput & { id: number; leaving: boolean };

type ToastApi = {
  push: (toast: ToastInput) => void;
  dismissTag: (tag: string) => void;
  clear: () => void;
};

const ToastContext = createContext<ToastApi | null>(null);
const MAX_VISIBLE = 3;

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <Toaster>");
  return api;
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);
  // Auto-dismiss clocks, kept outside state so hovering can pause them without re-rendering.
  const clocks = useRef(new Map<number, { timer?: ReturnType<typeof setTimeout>; left: number; since: number }>());
  const paused = useRef(false);

  // The list is mirrored in a ref so pushes and dismissals can be worked out synchronously.
  const listRef = useRef<Toast[]>([]);
  const commit = useCallback((next: Toast[]) => {
    listRef.current = next;
    setToasts(next);
  }, []);

  const leave = useCallback(
    (id: number) => {
      clearTimeout(clocks.current.get(id)?.timer);
      clocks.current.delete(id);
      commit(listRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    },
    [commit],
  );
  const remove = useCallback((id: number) => commit(listRef.current.filter((t) => t.id !== id)), [commit]);
  const arm = useCallback(
    (id: number, ms: number) => {
      clearTimeout(clocks.current.get(id)?.timer);
      const clock = { left: ms, since: Date.now(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
      if (!paused.current) clock.timer = setTimeout(() => leave(id), ms);
      clocks.current.set(id, clock);
    },
    [leave],
  );
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

  const api = useMemo<ToastApi>(
    () => ({
      push(input) {
        const list = listRef.current;
        const ms = input.duration ?? 4500;
        // A toast with a tag updates the one already showing for that tag, in place.
        const existing = input.tag ? list.find((t) => t.tag === input.tag && !t.leaving) : undefined;
        if (existing) {
          commit(list.map((t) => (t === existing ? { ...input, id: existing.id, leaving: false } : t)));
          arm(existing.id, ms);
          return;
        }
        const id = nextId.current++;
        const next = [...list, { ...input, id, leaving: false }];
        // Over the limit, the oldest bow out rather than vanish.
        let extra = next.filter((t) => !t.leaving).length - MAX_VISIBLE;
        commit(
          next.map((t) => {
            if (extra <= 0 || t.leaving) return t;
            extra--;
            clearTimeout(clocks.current.get(t.id)?.timer);
            clocks.current.delete(t.id);
            return { ...t, leaving: true };
          }),
        );
        arm(id, ms);
      },
      dismissTag(tag) {
        if (listRef.current.some((t) => t.tag === tag && !t.leaving)) {
          commit(listRef.current.map((t) => (t.tag === tag ? { ...t, leaving: true } : t)));
        }
      },
      clear() {
        clocks.current.forEach((clock) => clearTimeout(clock.timer));
        clocks.current.clear();
        commit([]);
      },
    }),
    [arm, commit],
  );

  // When a toast goes, the ones below it slide up into the gap instead of jumping.
  const tops = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region) return;
    const before = tops.current;
    const after = new Map<number, number>();
    const nodes = Array.from(region.querySelectorAll<HTMLElement>("[data-toast]"));
    for (const node of nodes) after.set(Number(node.dataset.toast), node.offsetTop);
    tops.current = after;
    if (prefersReducedMotion()) return;
    for (const node of nodes) {
      const id = Number(node.dataset.toast);
      const was = before.get(id);
      const now = after.get(id)!;
      if (was === undefined || was === now) continue;
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
        onPointerEnter={pause}
        onPointerLeave={resume}
        onFocus={pause}
        onBlur={resume}
        className="pointer-events-none fixed inset-x-0 top-(--toast-top,1rem) z-60 flex flex-col items-center gap-2 px-3"
      >
        <div role="status" aria-live="polite" className="contents">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              data-toast={toast.id}
              data-leaving={toast.leaving}
              onAnimationEnd={(event) => {
                if (toast.leaving && event.target === event.currentTarget) remove(toast.id);
              }}
              className="toast pointer-events-auto flex max-w-[min(26rem,100%)] items-center gap-3 rounded-2xl bg-surface-2 py-2 pr-2 pl-3.5 text-sm shadow-[inset_0_0_0_1px_var(--border-strong),0_16px_40px_-12px_rgb(0_0_0/0.7)]"
            >
              {toast.icon && (
                <span
                  className={`shrink-0 ${toast.tone === "danger" ? "text-danger-text" : "text-accent"}`}
                >
                  {toast.icon}
                </span>
              )}
              <p className="min-w-0 flex-1 py-1.5">
                <span className="font-medium">{toast.title}</span>
                {toast.body && <span className="mt-0.5 line-clamp-2 block break-words text-muted">{toast.body}</span>}
              </p>
              {toast.action && (
                <button
                  className="h-9 shrink-0 cursor-pointer rounded-lg px-3 font-semibold text-accent transition-colors hover:bg-surface-3"
                  onClick={() => {
                    toast.action?.onClick();
                    remove(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                className="icon-btn size-9 hover:bg-surface-3"
                aria-label="Dismiss notification"
                onClick={() => leave(toast.id)}
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
