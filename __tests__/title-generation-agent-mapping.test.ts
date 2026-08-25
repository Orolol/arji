import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAgent: vi.fn(),
  getProvider: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgent: mocks.resolveAgent,
}));

vi.mock("@/lib/providers", () => ({
  getProvider: mocks.getProvider,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "title-session"),
}));

describe("conversation title agent mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgent.mockReturnValue({
      provider: "gemini-cli",
      model: "gemini-flash",
      name: "Lightweight",
      namedAgentId: "agent-light",
    });
    mocks.getProvider.mockReturnValue({ spawn: mocks.spawn });
    mocks.spawn.mockReturnValue({
      promise: Promise.resolve({
        success: true,
        result: JSON.stringify({ result: "Fast Conversations" }),
      }),
    });
  });

  it("runs title generation on the project-scoped resolved named agent", async () => {
    const { generateConversationTitle } = await import(
      "@/lib/chat/title-generation"
    );

    await expect(
      generateConversationTitle({
        projectId: "project-123",
        userContent: "Make chat titles cheaper",
        assistantContent: "We can assign a lightweight model.",
      })
    ).resolves.toBe("Fast Conversations");

    expect(mocks.resolveAgent).toHaveBeenCalledWith(
      "title_generation",
      "project-123"
    );
    expect(mocks.getProvider).toHaveBeenCalledWith("gemini-cli");
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "title-title-session",
        mode: "plan",
        model: "gemini-flash",
      })
    );
  });
});
