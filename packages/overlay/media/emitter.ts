/**
 * The few lines every `Listenable` in this module shares. A listener that throws does not stop
 * the others, and does not stop the state machine that announced the event.
 */
import type { Listenable, Unsubscribe } from "../runtime";

export class Emitter<Events extends Record<string, unknown[]>> implements Listenable<Events> {
  private readonly listeners = new Map<keyof Events, Set<(...args: unknown[]) => void>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const added = set;
    added.add(listener as unknown as (...args: unknown[]) => void);
    return () => {
      added.delete(listener as unknown as (...args: unknown[]) => void);
    };
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}
