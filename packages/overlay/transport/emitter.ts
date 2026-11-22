/**
 * The smallest event emitter that satisfies `Listenable`. A listener that throws is reported and
 * does not stop the others: nothing that arrives from the network may take the engine down.
 *
 * Owner: E-transport+topology.
 */
import type { Listenable, Unsubscribe } from "../runtime";

export class Emitter<Events extends Record<string, unknown[]>> implements Listenable<Events> {
  private listeners: { [K in keyof Events]?: ((...args: Events[K]) => void)[] } = {};

  constructor(private readonly onError?: (error: unknown) => void) {}

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): Unsubscribe {
    const list = (this.listeners[event] ??= []);
    list.push(listener);
    return () => {
      const current = this.listeners[event];
      if (current) this.listeners[event] = current.filter((l) => l !== listener);
    };
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const list = this.listeners[event];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](...args);
      } catch (error) {
        this.onError?.(error);
      }
    }
  }
}
