"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";

export interface NotificationItem {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string | null;
  agentType: string | null;
  status: string; // completed | failed
  title: string;
  /** Full error message for failed session notifications (migration 0031). */
  message: string | null;
  targetUrl: string;
  createdAt: string | null;
}

interface NotificationsState {
  notifications: NotificationItem[];
  unreadCount: number;
  loading: boolean;
}

const POLL_INTERVAL_MS = 5000;
const BASE_TITLE = "Arij";

export function useNotifications() {
  const [state, setState] = useState<NotificationsState>({
    notifications: [],
    unreadCount: 0,
    loading: true,
  });
  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?limit=50");
      if (!res.ok) return;
      const body = await res.json();
      setState({
        notifications: body.data?.notifications || [],
        unreadCount: body.data?.unreadCount ?? 0,
        loading: false,
      });
    } catch {
      // Silently ignore — polling will retry
    }
  }, []);

  const markAsRead = useCallback(async () => {
    try {
      await fetch("/api/notifications/read", { method: "POST" });
      setState((prev) => ({ ...prev, unreadCount: 0 }));
    } catch {
      // Silently ignore
    }
  }, []);

  // Poll on interval
  usePolling(fetchNotifications, POLL_INTERVAL_MS);

  // Update document.title reactively
  useEffect(() => {
    if (state.unreadCount > 0) {
      document.title = `(${state.unreadCount}) ${BASE_TITLE}`;
    } else {
      document.title = BASE_TITLE;
    }
  }, [state.unreadCount]);

  return {
    notifications: state.notifications,
    unreadCount: state.unreadCount,
    loading: state.loading,
    markAsRead,
    refresh: fetchNotifications,
  };
}
