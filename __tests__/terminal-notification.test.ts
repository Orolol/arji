/**
 * The terminal-hook side of the failure story: a session finalized as
 * FAILED by a path whose closure dies first (scheduler safety net, boot
 * cleanup, night/auto-mode engines) must still create its notification —
 * with the full error message — at the moment the row is finalized.
 *
 * instrumentation.ts composes this into the single terminal hook slot; this
 * suite pins the wrapper's contract (status filtering + never-throw).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notifications/create", () => ({
  createNotificationFromSession: mockCreate,
}));

import { createTerminalSessionNotification } from "@/lib/agent-sessions/terminal-notification";

beforeEach(() => {
  mockCreate.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("createTerminalSessionNotification (terminal hook consumer)", () => {
  it("creates the notification for a failed terminal event", () => {
    createTerminalSessionNotification({ sessionId: "s1", status: "failed" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith("s1");
  });

  it("ignores completed events — the routes own those notifications", () => {
    createTerminalSessionNotification({ sessionId: "s2", status: "completed" });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("ignores cancelled events — a user-initiated stop is not an alarm", () => {
    createTerminalSessionNotification({ sessionId: "s3", status: "cancelled" });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("never throws into the terminal transition, even when notification creation fails", () => {
    mockCreate.mockImplementation(() => {
      throw new Error("db down");
    });

    expect(() =>
      createTerminalSessionNotification({ sessionId: "s4", status: "failed" })
    ).not.toThrow();

    expect(console.warn).toHaveBeenCalledWith(
      "[terminal-notification] Failed to notify session failure",
      "s4",
      "db down"
    );
  });
});