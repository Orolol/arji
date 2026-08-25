/**
 * Claude Code provider — wraps the existing CLI spawn logic
 * behind the AgentProvider interface.
 *
 * Claude Code's spawn logic is kept in lib/claude/spawn.ts because it
 * has unique features (streaming, --allowedTools, --permission-mode)
 * that don't fit neatly into the base class spawn. The provider delegates
 * to spawnClaude() rather than using BaseCliProvider.spawn().
 */

import { spawnClaude } from "@/lib/claude/spawn";
import { BaseCliProvider } from "./base-provider";
import type {
  ProviderSpawnOptions,
  ProviderSession,
  ProviderResult,
} from "./types";

export class ClaudeCodeProvider extends BaseCliProvider {
  readonly type = "claude-code" as const;

  get binaryName(): string {
    return "claude";
  }

  buildArgs(_options: ProviderSpawnOptions): string[] {
    // Not used — Claude Code overrides spawn() entirely
    return [];
  }

  extractResult(stdout: string): string {
    // Not used — Claude Code overrides spawn() entirely
    return stdout.trim();
  }

  /**
   * Override spawn to delegate to the existing spawnClaude() function,
   * which handles Claude Code's unique CLI arguments and streaming.
   */
  spawn(options: ProviderSpawnOptions): ProviderSession {
    const {
      prompt,
      cwd,
      mode,
      allowedTools,
      model,
      cliSessionId,
      resumeSession,
      logIdentifier,
      mcp,
    } = options;

    const { promise: rawPromise, kill, command } = spawnClaude({
      mode,
      prompt,
      cwd,
      allowedTools,
      model,
      cliSessionId,
      resumeSession,
      logIdentifier,
      mcp,
    });

    // Map ClaudeResult → ProviderResult
    const promise: Promise<ProviderResult> = rawPromise.then((r) => ({
      success: r.success,
      result: r.result,
      error: r.error,
      duration: r.duration,
      cliSessionId: r.cliSessionId,
      endedWithQuestion: r.endedWithQuestion,
    }));

    return {
      handle: `cc-${options.sessionId}`,
      kill,
      promise,
      command,
    };
  }
}
