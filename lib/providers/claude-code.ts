/**
 * Claude Code provider — wraps the existing CLI spawn logic
 * behind the AgentProvider interface.
 */

import { spawnClaude } from "@/lib/claude/spawn";
import type {
  AgentProvider,
  ProviderSpawnOptions,
  ProviderSession,
  ProviderResult,
} from "./types";

export class ClaudeCodeProvider implements AgentProvider {
  readonly type = "claude-code" as const;

  spawn(options: ProviderSpawnOptions): ProviderSession {
    const {
      prompt,
      cwd,
      mode,
      allowedTools,
      model,
      cliSessionId,
      claudeSessionId,
      resumeSession,
    } = options;

    const { promise: rawPromise, kill, command } = spawnClaude({
      mode,
      prompt,
      cwd,
      allowedTools,
      model,
      cliSessionId: cliSessionId ?? claudeSessionId,
      resumeSession,
    });

    // Map ClaudeResult → ProviderResult
    const promise: Promise<ProviderResult> = rawPromise.then((r) => ({
      success: r.success,
      result: r.result,
      error: r.error,
      duration: r.duration,
      cliSessionId: r.cliSessionId,
    }));

    return {
      handle: `cc-${options.sessionId}`,
      kill,
      promise,
      command,
    };
  }

  cancel(session: ProviderSession): boolean {
    session.kill();
    return true;
  }

  async isAvailable(): Promise<boolean> {
    // Check if the `claude` CLI is on PATH
    const { execSync } = await import("child_process");
    try {
      execSync("which claude", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}
