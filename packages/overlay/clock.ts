/**
 * The engine's real clock (SPEC §7.3, D16): time from `performance.now()`, timers from a dedicated
 * Worker. A page's own timers are clamped to 4 ms once nested and to one a second while the tab
 * is hidden; a Worker's are not, and the heartbeats and the failure detector must not slow down
 * when a viewer switches tabs. Where there is no Worker (Node, a locked-down page), the page's
 * own timers are used and `worker` says so.
 *
 * After media/testing/realClock.ts (E-media), which its browser runs use. Shared file: the
 * composition root's, see docs/overlay/PLAN.md "Shared files".
 */
import type { Clock } from "./runtime";

export type EngineClock = Clock & {
  /** The timers run in a Worker. */
  readonly worker: boolean;
  close(): void;
};

const WORKER_SOURCE = `
  const timers = new Map();
  onmessage = (event) => {
    const [op, id, ms] = event.data;
    if (op === "t") timers.set(id, setTimeout(() => { timers.delete(id); postMessage(id); }, ms));
    else if (op === "i") timers.set(id, setInterval(() => postMessage(id), ms));
    else { clearTimeout(timers.get(id)); clearInterval(timers.get(id)); timers.delete(id); }
  };`;

function pageClock(): EngineClock {
  return {
    worker: false,
    now: () => performance.now(),
    setTimeout(callback, ms) {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    setInterval(callback, ms) {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    },
    close() {},
  };
}

export function createEngineClock(): EngineClock {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") return pageClock();
  let url: string;
  let worker: Worker;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch {
    // A content security policy that forbids blob: workers.
    return pageClock();
  }
  const callbacks = new Map<number, { callback: () => void; once: boolean }>();
  let nextId = 1;
  worker.onmessage = (event: MessageEvent<number>) => {
    const entry = callbacks.get(event.data);
    if (!entry) return;
    if (entry.once) callbacks.delete(event.data);
    entry.callback();
  };
  const add = (callback: () => void, ms: number, once: boolean) => {
    const id = nextId++;
    callbacks.set(id, { callback, once });
    worker.postMessage([once ? "t" : "i", id, Math.max(0, ms)]);
    return () => {
      if (callbacks.delete(id)) worker.postMessage(["c", id, 0]);
    };
  };
  return {
    worker: true,
    now: () => performance.now(),
    setTimeout: (callback, ms) => add(callback, ms, true),
    setInterval: (callback, ms) => add(callback, ms, false),
    close() {
      callbacks.clear();
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}
