"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import type { TicketEvent, TicketEventType } from "@/lib/events/bus";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type EventHandler = (event: TicketEvent) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const FALLBACK_POLL_MS = 10_000;

export function useProjectEvents(
  projectId: string,
  handlers?: Partial<Record<TicketEventType, EventHandler>>
) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [pollTick, setPollTick] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const connect = useCallback(() => {
    // Close existing
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (typeof EventSource === "undefined") {
      setStatus("disconnected");
      return;
    }

    setStatus("connecting");
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
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [projectId]);

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
