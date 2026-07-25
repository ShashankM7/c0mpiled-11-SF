import type { RunEvent } from '../types.js';

export type EventListener = (event: RunEvent) => void;

/**
 * In-process fan-out for SSE subscribers. Events are persisted in the Store
 * before publish, so late joiners replay from ?after_seq= and live listeners
 * pick up from there.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  publish(event: RunEvent): void {
    const set = this.listeners.get(event.run_id);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must never affect the run
      }
    }
  }

  subscribe(runId: string, listener: EventListener): () => void {
    let set = this.listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }
}
