/**
 * OpenAI Codex provider — wraps @openai/codex-sdk behind the AgentProvider interface.
 *
 * Uses the Codex class to start threads and stream events. API key is read
 * from the settings table at spawn time.
 */

import { Codex } from "@openai/codex-sdk";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type {
  AgentProvider,
  ProviderSpawnOptions,
  ProviderSession,
  ProviderResult,
} from "./types";

function getCodexApiKey(): string | null {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "codex_api_key"))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as string;
  } catch {
    return row.value;
  }
}

/**
 * Map Codex sandboxMode from our mode enum.
 * - "plan" → "read-only" (no writes)
 * - "code" → "danger-full-access" (full access for implementation)
 * - "analyze" → "read-only"
 */
function toSandboxMode(mode: "plan" | "code" | "analyze") {
  return mode === "code"
    ? ("danger-full-access" as const)
    : ("read-only" as const);
}

export class CodexProvider implements AgentProvider {
  readonly type = "codex" as const;

  spawn(options: ProviderSpawnOptions): ProviderSession {
    const { sessionId, prompt, cwd, mode } = options;

    const apiKey = getCodexApiKey();
    if (!apiKey) {
      // Return an immediately-failed session
      return {
        handle: `codex-${sessionId}`,
        kill: () => {},
        promise: Promise.resolve({
          success: false,
          error: "Codex API key not configured. Set it in Settings.",
          duration: 0,
        }),
      };
    }

    const codex = new Codex({ apiKey });
    const thread = codex.startThread({
      workingDirectory: cwd,
      sandboxMode: toSandboxMode(mode),
      skipGitRepoCheck: true,
    });

    let abortController: AbortController | null = new AbortController();

    const promise: Promise<ProviderResult> = (async () => {
      const startTime = Date.now();
      try {
        const streamedTurn = await thread.runStreamed(prompt, {
          signal: abortController?.signal,
        });

        const items: string[] = [];

        for await (const event of streamedTurn.events) {
          if (event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message" && item.text) {
              items.push(item.text);
            }
          }
          if (event.type === "turn.failed") {
            return {
              success: false,
              error: event.error?.message || "Codex turn failed",
              duration: Date.now() - startTime,
            };
          }
        }

        return {
          success: true,
          result: items.join("\n\n"),
          duration: Date.now() - startTime,
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        if (abortController?.signal.aborted) {
          return {
            success: false,
            error: "Process was cancelled.",
            duration,
          };
        }
        return {
          success: false,
          error: err instanceof Error ? err.message : "Codex session failed",
          duration,
        };
      }
    })();

    const kill = () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    };

    return {
      handle: `codex-${sessionId}`,
      kill,
      promise,
    };
  }

  cancel(session: ProviderSession): boolean {
    session.kill();
    return true;
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = getCodexApiKey();
    return !!apiKey;
  }
}
