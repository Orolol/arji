import { describe, it, expect } from "vitest";
import { providerSupportsMcp, buildMcpSpawnConfig } from "@/lib/claude/mcp-injection";
import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";
import { OMP_MCP_GUARD } from "@/lib/providers/oh-my-pi-mcp-guard";
import type { ProviderSpawnOptions } from "@/lib/providers/types";

describe("oh-my-pi MCP token regression (epic pExZSpuOLrY0)", () => {
  it("guard present — branch carries the fix", () => {
    expect(OMP_MCP_GUARD).toBe(true);
  });

  it("providerSupportsMcp admits oh-my-pi", () => {
    expect(providerSupportsMcp("oh-my-pi")).toBe(true);
    expect(providerSupportsMcp("claude-code")).toBe(true);
    expect(providerSupportsMcp("codex")).toBe(true);
  });

  it("OhMyPiProvider.buildEnv injects ARIJ_MCP_TOKEN and ARIJ_BASE_URL", () => {
    const provider = new OhMyPiProvider();
    const mcp = buildMcpSpawnConfig({
      token: "tok-omp-regression",
      provider: "oh-my-pi",
    });
    const options: ProviderSpawnOptions = {
      sessionId: "test-session",
      prompt: "hi",
      cwd: "/tmp",
      mode: "code",
      mcp,
    };
    const env = provider.buildEnv(options);
    expect(env.ARIJ_MCP_TOKEN).toBe("tok-omp-regression");
    expect(env.ARIJ_BASE_URL).toBeDefined();
    expect(typeof env.ARIJ_BASE_URL).toBe("string");
  });

  it("readonly (plan) overlay does not strip MCP env and keeps --tools clean", () => {
    const provider = new OhMyPiProvider();
    const mcp = buildMcpSpawnConfig({
      token: "tok-omp-readonly",
      provider: "oh-my-pi",
    });
    const planOptions: ProviderSpawnOptions = {
      sessionId: "test-session",
      prompt: "hi",
      cwd: "/tmp",
      mode: "plan",
      mcp,
    };
    const env = provider.buildEnv(planOptions);
    expect(env.ARIJ_MCP_TOKEN).toBe("tok-omp-readonly");

    const args = provider.buildArgs(planOptions);
    expect(args).toContain("--config");
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("read,grep,glob");
    expect(args.join(" ")).not.toContain("mcp__arij");
  });

  it("chat toolset selector passes through when present", () => {
    const provider = new OhMyPiProvider();
    const chatMcp = buildMcpSpawnConfig({
      token: "tok-omp-chat",
      provider: "oh-my-pi",
      toolset: "chat",
    });
    const chatOptions: ProviderSpawnOptions = {
      sessionId: "test-session",
      prompt: "hi",
      cwd: "/tmp",
      mode: "code",
      mcp: chatMcp,
    };
    const env = provider.buildEnv(chatOptions);
    expect(env.ARIJ_MCP_TOOLSET).toBe("chat");
  });
});
