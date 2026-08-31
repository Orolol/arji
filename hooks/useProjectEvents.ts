"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { usePolling } from "@/hooks/usePolling";
import type { TicketEvent, TicketEventType } from "@/lib/events/bus";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type EventHandler = (event: TicketEvent) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const FALLBACK_POLL_MS = 10_000;

// Whether this environment can open an EventSource at all. Read as an external
// snapshot rather than branched on inside the effect, so the "no SSE here"
// answer is part of the first render instead of a setState one commit later.
const subscribeToNothing = () => () => {};
const hasEventSource = () => typeof EventSource !== "undefined";
const assumeEventSource = () => true;

export function useProjectEvents(
  projectId: string,
  handlers?: Partial<Record<TicketEventType, EventHandler>>
) {
  // "connecting" is the honest state before the first open event; the previous
  // "disconnected" seed was immediately overwritten by the effect anyway.
  const [connectionStatus, setStatus] = useState<ConnectionStatus>("connecting");
  const eventSourceSupported = useSyncExternalStore(
    subscribeToNothing,
    hasEventSource,
    assumeEventSource,
  );
  const status: ConnectionStatus = eventSourceSupported
    ? connectionStatus
    : "disconnected";
  const [pollTick, setPollTick] = useState(0);
  // Keeps the SSE callbacks reading the newest handlers without making them an
  // effect dependency (which would tear down the connection on every render).
  // The write happens after commit, not during render.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The backoff reconnect has to call `connect` from inside `connect`'s own
  // body. Reading the `const` directly is a forward reference — the closure
  // would capture the binding before it is initialised — so the scheduled
  // reconnect goes through a ref that is filled in after render instead.
  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    // Close existing
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (typeof EventSource === "undefined") {
      return;
    }

    const es = new EventSource(`/api/projects/${projectId}/events`);
    esRef.current = es;

    es.onopen = () => {
      setStatus("connected");
      reconnectAttempt.current = 0;
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TicketEvent;
        if (data.type === "connected" as string) return;

        const handler = handlersRef.current?.[data.type];
        handler?.(data);
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setStatus("disconnected");

      // Exponential backoff reconnect
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt.current),
        RECONNECT_MAX_MS
      );
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(() => {
        setStatus("connecting");
        connectRef.current?.();
      }, delay);
    };
  }, [projectId]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // Fallback polling when SSE is disconnected
  const bumpPollTick = useCallback(() => {
    setPollTick((t) => t + 1);
  }, []);
  usePolling(bumpPollTick, FALLBACK_POLL_MS, status === "disconnected", {
    immediate: false,
  });

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setStatus("disconnected");
    };
  }, [connect]);

  return { status, pollTick };
}
