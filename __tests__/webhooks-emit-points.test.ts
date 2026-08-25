import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

const mockSqliteState = vi.hoisted(() => ({ pruneCount: { cnt: 5 } }));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return {
    ...dbModuleMock(),
    sqlite: {
      prepare: vi.fn(() => ({ get: vi.fn(() => mockSqliteState.pruneCount) })),
      exec: vi.fn(),
    },
  };
});

vi.mock("@/lib/utils/nanoid", () => ({ createId: vi.fn(() => "notif-123") }));

// Only the delivery call is stubbed; durationMsBetween stays real so the
// emit point's duration wiring is actually exercised.
vi.mock("@/lib/webhooks/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webhooks/send")>(
    "@/lib/webhooks/send"
  );
  return { ...actual, sendProjectWebhook: vi.fn(() => Promise.resolve()) };
});

import { createNotificationFromSession } from "@/lib/notifications/create";
import { sendProjectWebhook } from "@/lib/webhooks/send";

const sendMock = vi.mocked(sendProjectWebhook);

describe("createNotificationFromSession() webhook emit point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockSqliteState.pruneCount = { cnt: 5 };
  });

  it("fires session.completed with epic, session, duration and deep-link path", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check: no message-bearing row yet
      {
        id: "s1",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        agentType: "build",
        startedAt: "2026-08-16T10:00:00.000Z",
        endedAt: "2026-08-16T10:02:00.000Z",
        error: null,
      },
      { name: "My Project" },
      { title: "Login feature", readableId: "E-proj-003" }
    );

    createNotificationFromSession("s1");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("p1", {
      event: "session.completed",
      ticketTitle: "Login feature",
      epicId: "e1",
      sessionId: "s1",
      durationMs: 120000,
      error: null,
      path: "/projects/p1/sessions/s1",
    });
  });

  it("fires session.failed with the session error and the QA deep link", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      {
        id: "s2",
        projectId: "p1",
        epicId: null,
        status: "failed",
        agentType: "tech_check",
        startedAt: null,
        endedAt: null,
        error: "tsc exited 1",
      },
      { name: "My Project" }
    );

    createNotificationFromSession("s2");

    expect(sendMock).toHaveBeenCalledWith("p1", {
      event: "session.failed",
      ticketTitle: null,
      epicId: null,
      sessionId: "s2",
      durationMs: null,
      error: "tsc exited 1",
      path: "/projects/p1/qa",
    });
  });

  it("does not fire when the session or project is missing", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      undefined // session lookup
    );
    createNotificationFromSession("missing");

    dbMockState.getQueue.push(
      undefined, // idempotency check
      {
        id: "s3",
        projectId: "p-gone",
        epicId: null,
        status: "completed",
        agentType: "build",
      },
      undefined
    );
    createNotificationFromSession("s3");

    expect(sendMock).not.toHaveBeenCalled();
  });
});
