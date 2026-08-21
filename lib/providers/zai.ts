/**
 * Zai (Zhipu AI) provider — API-based via subprocess wrapper.
 *
 * Zai is API-based (no native CLI binary). Implementation checks for:
 * 1. A `zai` CLI if available at runtime
 * 2. Falls back to checking ZHIPU_API_KEY env var
 *
 * CLI wrapper: zai --prompt <PROMPT> --model <model>
 * (or direct API calls via a bundled bridge script)
 *
 * Resume: not supported (stateless API calls).
 * Output: JSON response from API.
 */

import { execSync } from "child_process";
import { BaseCliProvider } from "./base-provider";
import type { ProviderSpawnOptions } from "./types";

export class ZaiProvider extends BaseCliProvider {
  readonly type = "zai" as const;

  get binaryName(): string {
    return "zai";
  }

  buildArgs(options: ProviderSpawnOptions): string[] {
    const { prompt, model } = options;

    const args: string[] = ["--prompt", prompt];

    if (model) {
      args.push("--model", model);
    } else {
      args.push("--model", "glm-4");
    }

    return args;
  }

  extractResult(stdout: string): string {
    const trimmed = stdout.trim();
    if (!trimmed) return "";

    // Try JSON response parsing
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.result === "string") return parsed.result;
      if (typeof parsed.output === "string") return parsed.output;
      if (typeof parsed.content === "string") return parsed.content;
      if (typeof parsed.text === "string") return parsed.text;
      // Zhipu API response format
      if (parsed.choices?.[0]?.message?.content) {
        return parsed.choices[0].message.content;
      }
    } catch {
      // Not JSON, return raw
    }

    return trimmed;
  }

  /**
   * Zai does not support resume (stateless API calls).
   */
  parseSessionId(): string | undefined {
    return undefined;
  }

  buildEnv(_options: ProviderSpawnOptions): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // Ensure API key is available to the subprocess
      ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    };
  }

  /**
   * Check for ZHIPU_API_KEY env var OR `zai` CLI binary on PATH.
   */
  async isAvailable(): Promise<boolean> {
    // Check for API key
    if (process.env.ZHIPU_API_KEY) {
      return true;
    }

    // Check for CLI binary
    try {
      execSync("which zai", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  buildDisplayCommand(args: string[], prompt: string): string {
    const displayArgs = args.map((a, i) => {
      if (i > 0 && args[i - 1] === "--prompt") return "<prompt>";
      if (a === prompt && a.length > 50) return "<prompt>";
      return a;
    });
    return `zai ${displayArgs.join(" ")}`;
  }
}
