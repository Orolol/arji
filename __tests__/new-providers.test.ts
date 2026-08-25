/**
 * Tests for new CLI providers added in the multi-provider epic.
 *
 * These test the provider implementations at the unit level:
 * - Correct buildArgs output for each mode
 * - extractResult parsing
 * - parseSessionId behavior
 * - isAvailable checks
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("child_process", () => {
  const execSync = vi.fn();
  return {
    execSync,
    spawn: vi.fn(),
    default: { execSync, spawn: vi.fn() },
  };
});

// Real @/lib/db/schema; the shared chain mock returns null from get() while
// its queue is empty, matching the previous hand-rolled stub.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import { getProvider } from "@/lib/providers";
import { MistralVibeProvider } from "@/lib/providers/mistral-vibe";
import { QwenCodeProvider } from "@/lib/providers/qwen-code";
import { OpenCodeProvider } from "@/lib/providers/opencode";
import { DeepSeekProvider } from "@/lib/providers/deepseek";
import { KimiProvider } from "@/lib/providers/kimi";
import { ZaiProvider } from "@/lib/providers/zai";
import type { ProviderSpawnOptions } from "@/lib/providers/types";
// Typed as the base class on purpose: the concrete providers narrow
// extractResult/parseSessionId to fewer parameters, but the contract the
// runtime calls through (BaseCliProvider) passes stdout/stderr/fallback.
import type { BaseCliProvider } from "@/lib/providers/base-provider";

const baseOptions: ProviderSpawnOptions = {
  sessionId: "test-session-1",
  prompt: "Implement a hello world function",
  cwd: "/tmp/test",
  mode: "code",
};

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

describe("Provider Factory - New Providers", () => {
  it("returns MistralVibeProvider for 'mistral-vibe'", () => {
    const provider = getProvider("mistral-vibe");
    expect(provider.type).toBe("mistral-vibe");
    expect(provider).toBeInstanceOf(MistralVibeProvider);
  });

  it("returns QwenCodeProvider for 'qwen-code'", () => {
    const provider = getProvider("qwen-code");
    expect(provider.type).toBe("qwen-code");
    expect(provider).toBeInstanceOf(QwenCodeProvider);
  });

  it("returns OpenCodeProvider for 'opencode'", () => {
    const provider = getProvider("opencode");
    expect(provider.type).toBe("opencode");
    expect(provider).toBeInstanceOf(OpenCodeProvider);
  });

  it("returns DeepSeekProvider for 'deepseek'", () => {
    const provider = getProvider("deepseek");
    expect(provider.type).toBe("deepseek");
    expect(provider).toBeInstanceOf(DeepSeekProvider);
  });

  it("returns KimiProvider for 'kimi'", () => {
    const provider = getProvider("kimi");
    expect(provider.type).toBe("kimi");
    expect(provider).toBeInstanceOf(KimiProvider);
  });

  it("returns ZaiProvider for 'zai'", () => {
    const provider = getProvider("zai");
    expect(provider.type).toBe("zai");
    expect(provider).toBeInstanceOf(ZaiProvider);
  });

  it("falls back to claude-code for unknown provider type", () => {
    // @ts-expect-error - testing unknown provider
    const provider = getProvider("nonexistent");
    expect(provider.type).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// MistralVibeProvider
// ---------------------------------------------------------------------------

describe("MistralVibeProvider", () => {
  const provider: BaseCliProvider = new MistralVibeProvider();

  it("has type 'mistral-vibe'", () => {
    expect(provider.type).toBe("mistral-vibe");
  });

  it("has binary name 'vibe'", () => {
    expect(provider.binaryName).toBe("vibe");
  });

  describe("buildArgs", () => {
    it("builds args for code mode", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--prompt");
      expect(args).toContain("--agent");
      expect(args).toContain("auto-approve");
      expect(args).toContain("--output");
      expect(args).toContain("json");
      expect(args).toContain("--max-turns");
    });

    it("uses plan agent for plan mode", () => {
      const args = provider.buildArgs({ ...baseOptions, mode: "plan" });
      expect(args).toContain("plan");
      expect(args).not.toContain("auto-approve");
    });

    it("uses accept-edits agent for analyze mode", () => {
      const args = provider.buildArgs({ ...baseOptions, mode: "analyze" });
      expect(args).toContain("accept-edits");
    });

    it("includes --resume when resumeSession is true", () => {
      const args = provider.buildArgs({
        ...baseOptions,
        cliSessionId: "sess-123",
        resumeSession: true,
      });
      expect(args).toContain("--resume");
      expect(args).toContain("sess-123");
    });

    it("includes --model when model is specified", () => {
      const args = provider.buildArgs({ ...baseOptions, model: "devstral-large" });
      expect(args).toContain("--model");
      expect(args).toContain("devstral-large");
    });
  });

  describe("extractResult", () => {
    it("extracts result from JSON output", () => {
      const json = JSON.stringify({ result: "Hello world!" });
      expect(provider.extractResult(json, "")).toBe("Hello world!");
    });

    it("extracts text from NDJSON events", () => {
      const ndjson = [
        '{"text": "Hello "}',
        '{"text": "world!"}',
      ].join("\n");
      expect(provider.extractResult(ndjson, "")).toBe("Hello world!");
    });

    it("returns raw text as fallback", () => {
      expect(provider.extractResult("raw output", "")).toBe("raw output");
    });
  });
});

// ---------------------------------------------------------------------------
// QwenCodeProvider
// ---------------------------------------------------------------------------

describe("QwenCodeProvider", () => {
  const provider: BaseCliProvider = new QwenCodeProvider();

  it("has type 'qwen-code'", () => {
    expect(provider.type).toBe("qwen-code");
  });

  it("has binary name 'qwen'", () => {
    expect(provider.binaryName).toBe("qwen");
  });

  describe("buildArgs", () => {
    it("uses -p for prompt", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("-p");
      expect(args).toContain(baseOptions.prompt);
    });

    it("includes --yolo for code mode", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--yolo");
    });

    it("does not include --yolo for plan mode", () => {
      const args = provider.buildArgs({ ...baseOptions, mode: "plan" });
      expect(args).not.toContain("--yolo");
    });

    it("includes --yolo for analyze mode so imports can create arji.json", () => {
      const args = provider.buildArgs({ ...baseOptions, mode: "analyze" });
      expect(args).toContain("--yolo");
    });

    it("includes --model when model is specified", () => {
      const args = provider.buildArgs({ ...baseOptions, model: "qwen3-coder" });
      expect(args).toContain("--model");
      expect(args).toContain("qwen3-coder");
    });
  });

  it("parseSessionId always returns undefined (non-resumable)", () => {
    expect(provider.parseSessionId("output", "stderr", "fallback")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// OpenCodeProvider
// ---------------------------------------------------------------------------

describe("OpenCodeProvider", () => {
  const provider: BaseCliProvider = new OpenCodeProvider();

  it("has type 'opencode'", () => {
    expect(provider.type).toBe("opencode");
  });

  it("has binary name 'opencode'", () => {
    expect(provider.binaryName).toBe("opencode");
  });

  describe("buildArgs", () => {
    it("uses run subcommand with prompt", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args[0]).toBe("run");
      expect(args[1]).toBe(baseOptions.prompt);
    });

    it("includes --format json", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--format");
      expect(args).toContain("json");
    });

    it("includes --session for resume", () => {
      const args = provider.buildArgs({
        ...baseOptions,
        cliSessionId: "sess-456",
        resumeSession: true,
      });
      expect(args).toContain("--session");
      expect(args).toContain("sess-456");
    });
  });

  describe("extractResult", () => {
    it("extracts text from JSON events", () => {
      const ndjson = '{"text": "Result text"}\n';
      expect(provider.extractResult(ndjson, "")).toBe("Result text");
    });
  });
});

// ---------------------------------------------------------------------------
// DeepSeekProvider
// ---------------------------------------------------------------------------

describe("DeepSeekProvider", () => {
  const provider: BaseCliProvider = new DeepSeekProvider();

  it("has type 'deepseek'", () => {
    expect(provider.type).toBe("deepseek");
  });

  it("has binary name 'deepseek'", () => {
    expect(provider.binaryName).toBe("deepseek");
  });

  describe("buildArgs", () => {
    it("uses -q for prompt", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("-q");
      expect(args).toContain(baseOptions.prompt);
    });

    it("always includes --no-stream", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--no-stream");
    });

    it("includes --model when model is specified", () => {
      const args = provider.buildArgs({ ...baseOptions, model: "deepseek-reasoner" });
      expect(args).toContain("--model");
      expect(args).toContain("deepseek-reasoner");
    });
  });

  it("parseSessionId always returns undefined (non-resumable)", () => {
    expect(provider.parseSessionId("output", "stderr", "fallback")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KimiProvider
// ---------------------------------------------------------------------------

describe("KimiProvider", () => {
  const provider: BaseCliProvider = new KimiProvider();

  it("has type 'kimi'", () => {
    expect(provider.type).toBe("kimi");
  });

  it("has binary name 'kimi'", () => {
    expect(provider.binaryName).toBe("kimi");
  });

  describe("buildArgs", () => {
    it("uses --print for headless mode", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--print");
    });

    it("uses -c for prompt", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("-c");
      expect(args).toContain(baseOptions.prompt);
    });

    it("includes --continue for resume", () => {
      const args = provider.buildArgs({
        ...baseOptions,
        resumeSession: true,
      });
      expect(args).toContain("--continue");
    });

    it("does not include --continue without resume", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).not.toContain("--continue");
    });
  });

  describe("extractResult", () => {
    it("extracts text from stream-json events", () => {
      const ndjson = [
        '{"type": "content_block_delta", "delta": {"text": "Hello "}}',
        '{"type": "content_block_delta", "delta": {"text": "world!"}}',
      ].join("\n");
      expect(provider.extractResult(ndjson, "")).toBe("Hello world!");
    });
  });

  it("parseSessionId returns fallback ID", () => {
    expect(provider.parseSessionId("out", "err", "fallback-id")).toBe("fallback-id");
    expect(provider.parseSessionId("out", "err")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ZaiProvider
// ---------------------------------------------------------------------------

describe("ZaiProvider", () => {
  const provider: BaseCliProvider = new ZaiProvider();

  it("has type 'zai'", () => {
    expect(provider.type).toBe("zai");
  });

  it("has binary name 'zai'", () => {
    expect(provider.binaryName).toBe("zai");
  });

  describe("buildArgs", () => {
    it("uses --prompt for prompt", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--prompt");
      expect(args).toContain(baseOptions.prompt);
    });

    it("defaults to glm-4 model", () => {
      const args = provider.buildArgs(baseOptions);
      expect(args).toContain("--model");
      expect(args).toContain("glm-4");
    });

    it("uses custom model when specified", () => {
      const args = provider.buildArgs({ ...baseOptions, model: "glm-4-plus" });
      expect(args).toContain("--model");
      expect(args).toContain("glm-4-plus");
      expect(args).not.toContain("glm-4");
    });
  });

  describe("extractResult", () => {
    it("extracts result from JSON response", () => {
      const json = JSON.stringify({ result: "API response" });
      expect(provider.extractResult(json, "")).toBe("API response");
    });

    it("extracts from Zhipu API choices format", () => {
      const json = JSON.stringify({
        choices: [{ message: { content: "GLM response" } }],
      });
      expect(provider.extractResult(json, "")).toBe("GLM response");
    });

    it("returns raw text as fallback", () => {
      expect(provider.extractResult("plain text", "")).toBe("plain text");
    });
  });

  it("parseSessionId always returns undefined (non-resumable)", () => {
    expect(provider.parseSessionId("output", "stderr", "fallback")).toBeUndefined();
  });

  describe("isAvailable", () => {
    it("returns true when ZHIPU_API_KEY is set", async () => {
      const original = process.env.ZHIPU_API_KEY;
      process.env.ZHIPU_API_KEY = "test-key";
      expect(await provider.isAvailable()).toBe(true);
      if (original !== undefined) {
        process.env.ZHIPU_API_KEY = original;
      } else {
        delete process.env.ZHIPU_API_KEY;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Resume Validation
// ---------------------------------------------------------------------------

import { isResumableProvider } from "@/lib/agent-sessions/validate-resume";

describe("Resume Provider Classification", () => {

  it("classifies resumable providers correctly", () => {
    expect(isResumableProvider("claude-code")).toBe(true);
    expect(isResumableProvider("gemini-cli")).toBe(true);
    expect(isResumableProvider("mistral-vibe")).toBe(true);
    expect(isResumableProvider("opencode")).toBe(true);
    expect(isResumableProvider("kimi")).toBe(true);
  });

  it("classifies non-resumable providers correctly", () => {
    expect(isResumableProvider("codex")).toBe(false);
    expect(isResumableProvider("qwen-code")).toBe(false);
    expect(isResumableProvider("deepseek")).toBe(false);
    expect(isResumableProvider("zai")).toBe(false);
  });
});
