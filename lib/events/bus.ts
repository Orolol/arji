/**
 * Server-side event bus for broadcasting real-time updates.
 *
 * Uses SSE (Server-Sent Events) for push from server → client.
 * Events are scoped by projectId (room-based isolation).
 */

export type TicketEventType =
  | "ticket:moved"
  | "ticket:created"
  | "ticket:updated"
  | "ticket:deleted"
  | "session:started"
  | "session:completed"
  | "session:failed"
  | "session:progress"
  | "artifact:created"
  | "release:created"
/**
 * `memory:changed` — emitted after the project memory document is written by
 * ANY path (manual save, restore, Dreaming, distillation). The Spec & Memory
 * panel re-fetches on it so every open view shows the fresh memory without
 * polling. Payload: `{ source: "manual" | "dreaming" | "distill" }`.
 */
  | "memory:changed";

export interface TicketEvent {
  type: TicketEventType;
  projectId: string;
  epicId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type Listener = (event: TicketEvent) => void;

class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribe to events for a specific project */
  subscribe(projectId: string, listener: Listener): () => void {
    if (!this.listeners.has(projectId)) {
      this.listeners.set(projectId, new Set());
    }
    this.listeners.get(projectId)!.add(listener);

    return () => {
      const set = this.listeners.get(projectId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(projectId);
        }
      }
    };
  }

  /** Emit an event to all listeners for a project */
  emit(event: TicketEvent): void {
    const listeners = this.listeners.get(event.projectId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Don't let one bad listener break others
      }
    }
  }

  /** Get count of active listeners for a project (for diagnostics) */
  listenerCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }
}

/** Singleton event bus — shared across all API routes in the same process */
export const eventBus = new EventBus();
