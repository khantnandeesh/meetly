/**
 * The real clock, for media's browser runs. The engine itself never reaches for a global clock
 * (SPEC §3.4); a test page has to get one from somewhere, and this is where.
 */
import type { Clock, SessionClock } from "../../runtime";

export function createRealClock(): Clock {
  return {
    now: () => performance.now(),
    setTimeout: (callback, ms) => {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
    setInterval: (callback, ms) => {
      const id = setInterval(callback, ms);
      return () => clearInterval(id);
    },
  };
}

/**
 * A clock whose ticks come from a dedicated Worker, as SPEC §7.3 [D16] asks of the real one: a
 * page's own timers are clamped to 4 ms after a few nested calls and to a second when hidden.
 */
export function createWorkerClock(): Clock & { close(): void } {
  const source = `
    const timers = new Map();
    onmessage = (event) => {
      const [op, id, ms] = event.data;
      if (op === "t") timers.set(id, setTimeout(() => { timers.delete(id); postMessage(id); }, ms));
      else if (op === "i") timers.set(id, setInterval(() => postMessage(id), ms));
      else { clearTimeout(timers.get(id)); clearInterval(timers.get(id)); timers.delete(id); }
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
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
    worker.postMessage([once ? "t" : "i", id, ms]);
    return () => {
      if (callbacks.delete(id)) worker.postMessage(["c", id, 0]);
    };
  };
  return {
    now: () => performance.now(),
    setTimeout: (callback, ms) => add(callback, ms, true),
    setInterval: (callback, ms) => add(callback, ms, false),
    close: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

/** A session clock that is the local clock plus a fixed offset: one machine, so no uncertainty. */
export function createLocalSessionClock(clock: Clock, offsetMs = 0): SessionClock {
  return { now: () => clock.now() + offsetMs, fromLocal: (localMs) => localMs + offsetMs, uncertaintyMs: 0 };
}
