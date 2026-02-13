import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn(() => ({
    promise: Promise.resolve({
      success: true,
      result: "CC output",
      duration: 500,
    }),
    kill: vi.fn(),
  })),
}));

vi.mock("@/lib/providers", () => {
  const mockCodexSession = {
    handle: "codex-test",
    kill: vi.fn(),
    promise: Promise.resolve({
      success: true,
      result: "Codex output",
      duration: 300,
    }),
  };
  return {
    getProvider: vi.fn(() => ({
      type: "codex",
      spawn: vi.fn(() => mockCodexSession),
      cancel: vi.fn(() => true),
      isAvailable: vi.fn().mockResolvedValue(true),
    })),
  };
});

let processManager: typeof import("@/lib/claude/process-manager").processManager;

describe("Process Manager — Status Machine Integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("@/lib/claude/process-manager");
    processManager = mod.processManager;
  });

  it("session starts in running state", () => {
    const info = processManager.start("s1", {
      mode: "code",
      prompt: "test",
    });
    expect(info.status).toBe("running");
  });

  it("cancel transitions running session to cancelled", () => {
    processManager.start("s2", { mode: "code", prompt: "test" });
    processManager.cancel("s2");
    const info = processManager.getStatus("s2");
    expect(info?.status).toBe("cancelled");
  });

  it("cancel on already cancelled session returns false", () => {
    processManager.start("s3", { mode: "code", prompt: "test" });
    processManager.cancel("s3");
    const secondCancel = processManager.cancel("s3");
    expect(secondCancel).toBe(false);
  });

  it("completed session cannot be cancelled (terminal state)", async () => {
    processManager.start("s4", { mode: "code", prompt: "test" });
    // Wait for the promise to settle
    await new Promise((r) => setTimeout(r, 50));
    const info = processManager.getStatus("s4");
    expect(info?.status).toBe("completed");

    const cancelled = processManager.cancel("s4");
    expect(cancelled).toBe(false);
    expect(processManager.getStatus("s4")?.status).toBe("completed");
  });

  it("cannot remove a running session", () => {
    processManager.start("s5", { mode: "code", prompt: "test" });
    expect(processManager.remove("s5")).toBe(false);
  });

  it("can remove a terminal (completed) session", async () => {
    processManager.start("s6", { mode: "code", prompt: "test" });
    await new Promise((r) => setTimeout(r, 50));
    expect(processManager.getStatus("s6")?.status).toBe("completed");
    expect(processManager.remove("s6")).toBe(true);
    expect(processManager.getStatus("s6")).toBeNull();
  });

  it("can remove a cancelled session", () => {
    processManager.start("s7", { mode: "code", prompt: "test" });
    processManager.cancel("s7");
    expect(processManager.remove("s7")).toBe(true);
    expect(processManager.getStatus("s7")).toBeNull();
  });

  it("cancelled session is not overwritten by late completion", async () => {
    // Create a session with a slow-resolving promise
    vi.resetModules();
    let resolvePromise: (v: { success: boolean; result: string; duration: number }) => void;
    vi.doMock("@/lib/claude/spawn", () => ({
      spawnClaude: vi.fn(() => ({
        promise: new Promise((resolve) => {
          resolvePromise = resolve;
        }),
        kill: vi.fn(),
      })),
    }));

    const mod = await import("@/lib/claude/process-manager");
    const pm = mod.processManager;

    pm.start("s8", { mode: "code", prompt: "test" });

    // Cancel while running
    pm.cancel("s8");
    expect(pm.getStatus("s8")?.status).toBe("cancelled");

    // Simulate late completion after cancel
    resolvePromise!({ success: true, result: "late result", duration: 1000 });
    await new Promise((r) => setTimeout(r, 50));

    // Status should still be cancelled (terminal state, no backtrack)
    expect(pm.getStatus("s8")?.status).toBe("cancelled");
  });

  it("failed session cannot transition to completed", async () => {
    vi.resetModules();
    vi.doMock("@/lib/claude/spawn", () => ({
      spawnClaude: vi.fn(() => ({
        promise: Promise.reject(new Error("spawn failed")),
        kill: vi.fn(),
      })),
    }));

    const mod = await import("@/lib/claude/process-manager");
    const pm = mod.processManager;

    pm.start("s9", { mode: "code", prompt: "test" });
    await new Promise((r) => setTimeout(r, 50));

    expect(pm.getStatus("s9")?.status).toBe("failed");
    // Terminal state: cannot be cancelled
    expect(pm.cancel("s9")).toBe(false);
  });

  it("parallel sessions do not interfere with each other", async () => {
    processManager.start("p1", { mode: "code", prompt: "test1" });
    processManager.start("p2", { mode: "code", prompt: "test2" }, "codex");

    // Cancel only p1
    processManager.cancel("p1");

    expect(processManager.getStatus("p1")?.status).toBe("cancelled");
    expect(processManager.getStatus("p2")?.status).toBe("running");

    // Wait for p2 to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(processManager.getStatus("p2")?.status).toBe("completed");
  });
});
