/**
 * Codex provider — wraps the `codex` CLI behind the AgentProvider interface.
 *
 * Spawns `codex exec` as a child process (same pattern as Claude Code).
 * No API key required — the CLI uses the user's local login.
 */

import { spawnCodex } from "@/lib/codex/spawn";
import { execSync } from "child_process";
import type {
  AgentProvider,
  ProviderSpawnOptions,
  ProviderSession,
} from "./types";

export class CodexProvider implements AgentProvider {
  readonly type = "codex" as const;

  spawn(options: ProviderSpawnOptions): ProviderSession {
    const { sessionId, prompt, cwd, mode, model, onChunk, logIdentifier } =
      options;

    const spawned = spawnCodex({
      mode,
      prompt,
      cwd,
      model,
      logIdentifier,
      onRawChunk: ({ source, index, text, emittedAt }) =>
        onChunk?.({
          streamType: "raw",
          text,
          chunkKey: `${source}:${index}`,
          emittedAt,
        }),
      onOutputChunk: ({ text, emittedAt }) =>
        onChunk?.({
          streamType: "output",
          text,
          chunkKey: "final-output",
          emittedAt,
        }),
      onResponseChunk: ({ text, emittedAt }) =>
        onChunk?.({
          streamType: "response",
          text,
          chunkKey: "final-response",
          emittedAt,
        }),
    });

    return {
      handle: `codex-${sessionId}`,
      kill: spawned.kill,
      promise: spawned.promise,
      command: spawned.command,
    };
  }

  cancel(session: ProviderSession): boolean {
    session.kill();
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which codex", { stdio: "ignore" });
    } catch {
      return false;
    }
    // Also check login status (codex writes to stderr)
    try {
      const output = execSync("codex login status 2>&1", {
        encoding: "utf-8",
        timeout: 5000,
      });
      return /logged in/i.test(output);
    } catch {
      return false;
    }
  }
}
