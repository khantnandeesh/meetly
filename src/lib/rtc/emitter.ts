import type { RtcEventName, RtcEvents } from "./types";

type Listener<E extends RtcEventName> = (...args: RtcEvents[E]) => void;

/** The few lines of event plumbing both adapters share. */
export class RtcEmitter {
  private listeners = new Map<RtcEventName, Set<Listener<RtcEventName>>>();

  on<E extends RtcEventName>(event: E, listener: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener<RtcEventName>);
    return () => {
      set.delete(listener as Listener<RtcEventName>);
    };
  }

  protected emit<E extends RtcEventName>(event: E, ...args: RtcEvents[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copied: a listener may unsubscribe (or subscribe) while being called.
    for (const listener of Array.from(set)) (listener as Listener<E>)(...args);
  }
}

/** A change notifier for one participant's properties. */
export class Notifier {
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  notify = (): void => {
    for (const listener of Array.from(this.listeners)) listener();
  };
}
