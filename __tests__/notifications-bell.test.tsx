import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

// ---- Mock useNotifications ----
const mockUseNotifications = vi.hoisted(() =>
  vi.fn(() => ({
    notifications: [] as Array<Record<string, unknown>>,
    unreadCount: 0,
    loading: false,
    markAsRead: vi.fn(),
    refresh: vi.fn(),
  }))
);

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: mockUseNotifications,
}));

// ---- Mock next/navigation ----
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));

import { NotificationBell } from "@/components/layout/NotificationBell";

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders bell icon without badge when unreadCount is 0", () => {
    mockUseNotifications.mockReturnValue({
      notifications: [],
      unreadCount: 0,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    const button = screen.getByTitle("Notifications");
    expect(button).toBeDefined();
    // No badge should be visible
    expect(button.querySelector("span")).toBeNull();
  });

  it("renders badge with unread count when > 0", () => {
    mockUseNotifications.mockReturnValue({
      notifications: [],
      unreadCount: 5,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    const button = screen.getByTitle("Notifications");
    const badge = button.querySelector("span");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("5");
  });

  it("shows 99+ when unread count exceeds 99", () => {
    mockUseNotifications.mockReturnValue({
      notifications: [],
      unreadCount: 150,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    const button = screen.getByTitle("Notifications");
    const badge = button.querySelector("span");
    expect(badge?.textContent).toBe("99+");
  });

  it("shows empty state when no notifications", async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [],
      unreadCount: 0,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("No notifications yet")).toBeDefined();
    });
  });

  it("renders notification items in popover", async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "completed",
          title: "Build completed",
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
        {
          id: "n2",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s2",
          agentType: "review_code",
          status: "failed",
          title: "Review failed",
          targetUrl: "/projects/p1/sessions/s2",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 2,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("Build completed")).toBeDefined();
      expect(screen.getByText("Review failed")).toBeDefined();
    });
  });

  it("calls markAsRead when popover opens with unread", async () => {
    const markAsRead = vi.fn();
    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "completed",
          title: "Build completed",
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
      loading: false,
      markAsRead,
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(markAsRead).toHaveBeenCalled();
    });
  });

  it("navigates to targetUrl when notification is clicked", async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "completed",
          title: "Build completed",
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 0,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("Build completed")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Build completed"));
    expect(mockPush).toHaveBeenCalledWith("/projects/p1/sessions/s1");
  });

  it("renders the full failure message under a failed notification's title", async () => {
    const fullError =
      "The agent session failed without any error message and without any output — the process exited (or was lost) without writing stderr or text. The full process capture is at /app/data/sessions/s1/logs.json.";

    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "failed",
          title: "Build failed — E-proj-003: Login feature",
          message: fullError,
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(screen.getByText(fullError)).toBeDefined();
    });

    // One click on the failure row reaches the full detail (the session
    // view keeps the complete log) — the bell row itself is the entry.
    fireEvent.click(screen.getByText(fullError));
    expect(mockPush).toHaveBeenCalledWith("/projects/p1/sessions/s1");
  });

  it("does not show a message block for completed notifications", async () => {
    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "completed",
          title: "Build completed",
          message: null,
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 0,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      expect(screen.getByText("Build completed")).toBeDefined();
    });
    expect(screen.queryByText(/failed without any error/i)).toBeNull();
  });

  it("displays long notification titles without truncation", async () => {
    const longTitle =
      "This is a very long notification title that should be fully visible without being truncated by CSS overflow rules";

    mockUseNotifications.mockReturnValue({
      notifications: [
        {
          id: "n1",
          projectId: "p1",
          projectName: "My Project",
          sessionId: "s1",
          agentType: "build",
          status: "completed",
          title: longTitle,
          targetUrl: "/projects/p1/sessions/s1",
          createdAt: new Date().toISOString(),
        },
      ],
      unreadCount: 1,
      loading: false,
      markAsRead: vi.fn(),
      refresh: vi.fn(),
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByTitle("Notifications"));

    await waitFor(() => {
      const titleEl = screen.getByText(longTitle);
      expect(titleEl).toBeDefined();
      // Title element should NOT have the truncate class
      expect(titleEl.className).not.toContain("truncate");
    });
  });
});
