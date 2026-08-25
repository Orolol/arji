import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/app/api/projects/[projectId]/epics/[epicId]/build/route", () => ({
  POST: routeMocks.post,
}));

import {
  ciAutofixAttemptId,
  launchCiAutofixSession,
  parseCiAutofixPayload,
} from "@/lib/routines/ci-autofix";
import { CI_AUTOFIX_MAX_LOG_TAIL_CHARS } from "@/lib/routines/ci-autofix-limits";

describe("CI autofix hand-off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a stable durable key from epic, PR, and head SHA", () => {
    expect(
      ciAutofixAttemptId({
        epicId: "epic-1",
        prNumber: 42,
        headSha: "abc123",
      })
    ).toBe("ci-autofix:epic-1:pr-42:abc123");
  });

  it("strictly validates the build-route payload", () => {
    expect(
      parseCiAutofixPayload({
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "unit", logTail: "failed" }],
      })
    ).toEqual({
      prNumber: 42,
      headSha: "abc123",
      failures: [{ name: "unit", logTail: "failed" }],
    });
    expect(parseCiAutofixPayload({ prNumber: 0, headSha: "abc", failures: [] })).toBeNull();
    expect(
      parseCiAutofixPayload({
        prNumber: 42,
        headSha: "abc",
        failures: [{ name: "unit", logTail: 123 }],
      })
    ).toBeNull();
  });

  it("rejects CI evidence that exceeds the global argv-safe budget", () => {
    expect(
      parseCiAutofixPayload({
        prNumber: 42,
        headSha: "abc123",
        failures: Array.from({ length: 8 }, (_, index) => ({
          name: `matrix-${index}`,
          logTail: "x".repeat(CI_AUTOFIX_MAX_LOG_TAIL_CHARS),
        })),
      })
    ).toBeNull();
  });

  it("dispatches through the canonical build route with pipeline disabled", async () => {
    routeMocks.post.mockResolvedValue(
      Response.json({
        data: { sessionId: "session-1", ciAutofix: { launched: true } },
      })
    );

    await expect(
      launchCiAutofixSession({
        projectId: "project-1",
        epicId: "epic-1",
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "unit", logTail: "test failed" }],
      })
    ).resolves.toEqual({ status: "launched", sessionId: "session-1" });

    const [request, context] = routeMocks.post.mock.calls[0] as [
      Request,
      { params: Promise<{ projectId: string; epicId: string }> },
    ];
    expect(await request.json()).toEqual({
      pipeline: false,
      ciAutofix: {
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "unit", logTail: "test failed" }],
      },
    });
    await expect(context.params).resolves.toEqual({
      projectId: "project-1",
      epicId: "epic-1",
    });
  });

  it("turns an active target conflict into a safe skip", async () => {
    routeMocks.post.mockResolvedValue(
      Response.json(
        {
          error: "Another agent is already running",
          code: "AGENT_ALREADY_RUNNING",
          data: { activeSessionId: "session-busy" },
        },
        { status: 409 }
      )
    );

    await expect(
      launchCiAutofixSession({
        projectId: "project-1",
        epicId: "epic-1",
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "unit", logTail: null }],
      })
    ).resolves.toEqual({
      status: "skipped",
      reason: "target_busy",
      sessionId: "session-busy",
    });
  });
});
