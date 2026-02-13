import { describe, expect, it } from "vitest";
import {
  buildSessionTransitionPatch,
  normalizeSessionLifecycleStatus,
  SessionLifecycleConflictError,
  SESSION_LIFECYCLE_CONFLICT_CODE,
} from "@/lib/agent-sessions/lifecycle";

describe("session lifecycle transitions", () => {
  it("normalizes legacy pending status to queued", () => {
    expect(normalizeSessionLifecycleStatus("pending")).toBe("queued");
    expect(normalizeSessionLifecycleStatus("queued")).toBe("queued");
  });

  it("allows queued -> running and sets startedAt once", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s1",
        status: "queued",
        startedAt: null,
        endedAt: null,
        completedAt: null,
      },
      "running",
      "2026-02-12T00:00:00.000Z"
    );

    expect(patch.status).toBe("running");
    expect(patch.startedAt).toBe("2026-02-12T00:00:00.000Z");
    expect(patch.endedAt).toBeUndefined();
  });

  it("does not overwrite startedAt when already present", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s2",
        status: "queued",
        startedAt: "2026-02-11T00:00:00.000Z",
        endedAt: null,
        completedAt: null,
      },
      "running",
      "2026-02-12T00:00:00.000Z"
    );

    expect(patch.status).toBe("running");
    expect(patch.startedAt).toBeUndefined();
  });

  it("allows running -> completed and sets endedAt/completedAt once", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s3",
        status: "running",
        startedAt: "2026-02-12T00:00:00.000Z",
        endedAt: null,
        completedAt: null,
      },
      "completed",
      "2026-02-12T00:05:00.000Z"
    );

    expect(patch.status).toBe("completed");
    expect(patch.endedAt).toBe("2026-02-12T00:05:00.000Z");
    expect(patch.completedAt).toBe("2026-02-12T00:05:00.000Z");
    expect(patch.error).toBeNull();
  });

  it("does not overwrite endedAt/completedAt when already set", () => {
    const patch = buildSessionTransitionPatch(
      {
        id: "s4",
        status: "running",
        startedAt: "2026-02-12T00:00:00.000Z",
        endedAt: "2026-02-12T00:04:00.000Z",
        completedAt: "2026-02-12T00:04:00.000Z",
      },
      "failed",
      "2026-02-12T00:05:00.000Z",
      "Agent failed"
    );

    expect(patch.status).toBe("failed");
    expect(patch.endedAt).toBeUndefined();
    expect(patch.completedAt).toBeUndefined();
    expect(patch.error).toBe("Agent failed");
  });

  it("rejects invalid transitions with machine-readable conflict code", () => {
    try {
      buildSessionTransitionPatch(
        {
          id: "s5",
          status: "completed",
          startedAt: "2026-02-12T00:00:00.000Z",
          endedAt: "2026-02-12T00:01:00.000Z",
          completedAt: "2026-02-12T00:01:00.000Z",
        },
        "running",
        "2026-02-12T00:02:00.000Z"
      );
      throw new Error("Expected lifecycle conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionLifecycleConflictError);
      const conflict = error as SessionLifecycleConflictError;
      expect(conflict.code).toBe(SESSION_LIFECYCLE_CONFLICT_CODE);
      expect(conflict.details).toMatchObject({
        sessionId: "s5",
        fromStatus: "completed",
        toStatus: "running",
      });
    }
  });
});
