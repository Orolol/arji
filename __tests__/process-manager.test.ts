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

// We need a fresh processManager for each test
let processManager: typeof import("@/lib/claude/process-manager").processManager;

describe("Process Manager", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Force reimport to get a fresh singleton
    vi.resetModules();
    const mod = await import("@/lib/claude/process-manager");
    processManager = mod.processManager;
  });

  describe("start()", () => {
    it("starts a Claude Code session by default", () => {
      const info = processManager.start("s1", {
        mode: "code",
        prompt: "test",
      });
      expect(info.sessionId).toBe("s1");
      expect(info.status).toBe("running");
      expect(info.provider).toBe("claude-code");
    });

    it("starts a Codex session when provider is codex", () => {
      const info = processManager.start(
        "s2",
        { mode: "code", prompt: "test" },
        "codex",
      );
      expect(info.sessionId).toBe("s2");
      expect(info.status).toBe("running");
      expect(info.provider).toBe("codex");
    });

    it("throws if session is already running", () => {
      processManager.start("s3", { mode: "code", prompt: "test" });
      expect(() =>
        processManager.start("s3", { mode: "code", prompt: "test" }),
      ).toThrow("already running");
    });
  });

  describe("cancel()", () => {
    it("cancels a running CC session", () => {
      processManager.start("s4", { mode: "code", prompt: "test" });
      const result = processManager.cancel("s4");
      expect(result).toBe(true);
      const info = processManager.getStatus("s4");
      expect(info?.status).toBe("cancelled");
    });

    it("cancels a running Codex session", () => {
      processManager.start("s5", { mode: "code", prompt: "test" }, "codex");
      const result = processManager.cancel("s5");
      expect(result).toBe(true);
      const info = processManager.getStatus("s5");
      expect(info?.status).toBe("cancelled");
    });

    it("returns false for unknown session", () => {
      expect(processManager.cancel("unknown")).toBe(false);
    });

    it("returns false for already completed session", () => {
      processManager.start("s6", { mode: "code", prompt: "test" });
      processManager.cancel("s6");
      // Try to cancel again
      expect(processManager.cancel("s6")).toBe(false);
    });
  });

  describe("getStatus()", () => {
    it("returns null for unknown session", () => {
      expect(processManager.getStatus("unknown")).toBeNull();
    });

    it("returns session info with provider field", () => {
      processManager.start("s7", { mode: "code", prompt: "test" });
      const info = processManager.getStatus("s7");
      expect(info).not.toBeNull();
      expect(info!.provider).toBe("claude-code");
      expect(info!.startedAt).toBeInstanceOf(Date);
    });
  });

  describe("listActive()", () => {
    it("lists all running sessions", () => {
      processManager.start("cc1", { mode: "code", prompt: "test" });
      processManager.start("codex1", { mode: "code", prompt: "test" }, "codex");
      const active = processManager.listActive();
      expect(active.length).toBe(2);
      const providers = active.map((a) => a.provider);
      expect(providers).toContain("claude-code");
      expect(providers).toContain("codex");
    });

    it("excludes cancelled sessions", () => {
      processManager.start("cc2", { mode: "code", prompt: "test" });
      processManager.cancel("cc2");
      expect(processManager.listActive().length).toBe(0);
    });
  });

  describe("listAll()", () => {
    it("includes both running and cancelled sessions", () => {
      processManager.start("a1", { mode: "code", prompt: "test" });
      processManager.start("a2", { mode: "code", prompt: "test" }, "codex");
      processManager.cancel("a1");
      const all = processManager.listAll();
      expect(all.length).toBe(2);
    });
  });

  describe("remove()", () => {
    it("removes a cancelled session", () => {
      processManager.start("r1", { mode: "code", prompt: "test" });
      processManager.cancel("r1");
      expect(processManager.remove("r1")).toBe(true);
      expect(processManager.getStatus("r1")).toBeNull();
    });

    it("cannot remove a running session", () => {
      processManager.start("r2", { mode: "code", prompt: "test" });
      expect(processManager.remove("r2")).toBe(false);
    });
  });

  describe("activeCount", () => {
    it("counts running sessions across providers", () => {
      processManager.start("c1", { mode: "code", prompt: "test" });
      processManager.start("c2", { mode: "code", prompt: "test" }, "codex");
      expect(processManager.activeCount).toBe(2);
      processManager.cancel("c1");
      expect(processManager.activeCount).toBe(1);
    });
  });
});
