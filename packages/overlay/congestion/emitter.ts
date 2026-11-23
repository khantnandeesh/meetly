import type { Listenable, Unsubscribe } from "../runtime";

type AnyListener = (...args: unknown[]) => void;

/** The smallest thing that is a `Listenable`. A listener that throws does not stop the others. */
export class Emitter<Events extends Record<string, unknown[]>> implements Listenable<Events> {
  private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const held = listener as unknown as AnyListener;
    set.add(held);
    return () => void set.delete(held);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    let failure: unknown;
    let failed = false;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
  }
}
