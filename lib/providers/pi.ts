/**
 * Pi provider — wraps the `pi` CLI (npm: @earendil-works/pi-coding-agent).
 *
 * CLI: pi --mode json [--tools <allowlist>] [--session <ID>] [--model <M>] -p <PROMPT>
 *
 * Mode mapping: pi has no permission system — capability is expressed through
 * the tool allowlist, so read-only modes drop the mutating built-ins.
 * - plan    → --tools read,grep,find,ls
 * - analyze → --tools read,grep,find,ls
 * - code    → default tool set (adds write, edit, bash)
 *
 * Resume: supported via `--session <ID>`, using the id of the session header
 * pi emits as the first line of the `--mode json` stream.
 *
 * Output: NDJSON event stream. The final answer is the last assistant
 * `message_end` — the same message pi's own text mode prints.
 *
 * Caveat: pi's parser only treats the argument after `-p` as the prompt when
 * it does not start with `-`, and pi offers no `--` separator. Every prompt
 * Arij builds starts with a heading, so this is unreachable today, but a
 * prompt beginning with a single dash would be dropped as an unknown option.
 */

import { BaseCliProvider } from "./base-provider";
import type {
  BaseProviderChunkCallbacks,
  ProviderExitInfo,
} from "./base-provider";
import type { StreamLogContext } from "@/lib/claude/logger";
import type {
  ProviderResult,
  ProviderSpawnOptions,
  ProviderType,
} from "./types";

/** Built-in pi tools that cannot modify the working tree. */
export const PI_READONLY_TOOLS = ["read", "grep", "find", "ls"];

/** An assistant turn as reported by a pi `message_end` event. */
export interface PiAssistantMessage {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the NDJSON event lines of a `--mode json` stream, skipping noise. */
function parseEventLines(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // partial or non-JSON line — ignore
    }
  }
  return events;
}

/** Concatenates the `{ type: "text" }` blocks of a pi message content array. */
function readTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Collects the assistant turns pi reported through `message_end` events. */
export function collectPiAssistantMessages(stdout: string): PiAssistantMessage[] {
  const messages: PiAssistantMessage[] = [];

  for (const event of parseEventLines(stdout)) {
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") continue;

    messages.push({
      text: readTextBlocks(message.content),
      stopReason:
        typeof message.stopReason === "string" ? message.stopReason : undefined,
      errorMessage:
        typeof message.errorMessage === "string"
          ? message.errorMessage
          : undefined,
    });
  }

  return messages;
}

/**
 * The final answer of a pi run: the last assistant message, matching what
 * pi's own text mode prints. Falls back to every assistant message and then
 * to the raw output, so an unrecognised stream is never silently dropped.
 */
export function extractPiResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const messages = collectPiAssistantMessages(trimmed);

  const last = messages[messages.length - 1]?.text.trim();
  if (last) return last;

  const all = messages.map((m) => m.text.trim()).filter(Boolean);
  if (all.length > 0) return all.join("\n\n");

  return trimmed;
}

/** Session UUID from pi's `{"type":"session",…}` header line. */
export function extractPiSessionId(raw: string): string | undefined {
  for (const event of parseEventLines(raw)) {
    if (event.type !== "session") continue;
    if (typeof event.id === "string" && event.id.trim().length > 0) {
      return event.id.trim();
    }
  }
  return undefined;
}

/**
 * pi exits 0 in `--mode json` even when the run ended on a model error (only
 * its text mode maps that to exit code 1), so the final assistant message's
 * stopReason is the only failure signal available. Returns null on success.
 * `cliName` labels the fallback messages ("Pi" or "Oh My Pi").
 */
export function findPiRunFailure(stdout: string, cliName = "Pi"): string | null {
  const messages = collectPiAssistantMessages(stdout);
  const last = messages[messages.length - 1];
  if (!last) return null;

  if (last.stopReason !== "error" && last.stopReason !== "aborted") return null;

  return (
    last.errorMessage?.trim() ||
    (last.stopReason === "aborted"
      ? `${cliName} run was aborted.`
      : `${cliName} run ended with an error.`)
  );
}

export class PiProvider extends BaseCliProvider {
  readonly type: ProviderType = "pi";

  get binaryName(): string {
    return "pi";
  }

  /** Human-readable CLI name used in error messages. */
  protected get cliDisplayName(): string {
    return "Pi";
  }

  /** Built-in tools that cannot modify the working tree (omp's set differs). */
  protected readonlyTools(): string[] {
    return PI_READONLY_TOOLS;
  }

  /** Arguments that resume `cliSessionId` — pi's flag is `--session`, omp's is `--resume`. */
  protected resumeArgs(cliSessionId: string): string[] {
    return ["--session", cliSessionId];
  }

  protected notAuthenticatedMessage(): string {
    return "Pi is not authenticated. Run `pi` and use /login, or set the provider API key.";
  }

  buildArgs(options: ProviderSpawnOptions): string[] {
    const { prompt, mode, model, cliSessionId, resumeSession } = options;

    const args: string[] = ["--mode", "json"];

    // plan/analyze must not touch the working tree — drop write/edit/bash.
    // MCP tool names must NEVER be added here: omp validates --tools against
    // built-in names only, and an unknown name is a fatal argv error that
    // kills the spawn. Its MCP tools are orthogonal to this allowlist and
    // stay mounted regardless — see lib/providers/oh-my-pi.ts.
    if (mode !== "code") {
      args.push("--tools", this.readonlyTools().join(","));
    }

    if (cliSessionId && resumeSession) {
      args.push(...this.resumeArgs(cliSessionId));
    }

    if (model) {
      args.push("--model", model);
    }

    args.push("-p", prompt);

    return args;
  }

  extractResult(stdout: string): string {
    return extractPiResult(stdout);
  }

  parseSessionId(
    stdout: string,
    stderr: string,
    fallbackId?: string,
  ): string | undefined {
    return (
      extractPiSessionId(stdout) ?? extractPiSessionId(stderr) ?? fallbackId
    );
  }

  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? "Pi CLI not found. Install it with: npm i -g @earendil-works/pi-coding-agent"
      : `Failed to spawn Pi CLI: ${err.message}`;
  }

  protected buildExitError(
    code: number | null,
    stdout: string,
    stderr: string,
  ): string {
    const combinedOutput = stderr + "\n" + stdout;

    if (/no api key|not authenticated|unauthorized|invalid api key/i.test(combinedOutput)) {
      return this.notAuthenticatedMessage();
    }

    return (
      findPiRunFailure(stdout, this.cliDisplayName) ??
      (stderr.trim() || `${this.cliDisplayName} CLI exited with code ${code}`)
    );
  }

  /**
   * A zero exit code is not proof of success in `--mode json`: pi only maps a
   * failed run to exit 1 in text mode. Downgrade when the event stream says
   * the last turn errored out.
   */
  protected handleExit(
    info: ProviderExitInfo,
    callbacks: BaseProviderChunkCallbacks,
    logCtx: StreamLogContext | null,
  ): ProviderResult {
    const result = super.handleExit(info, callbacks, logCtx);
    if (!result.success) return result;

    const failure = findPiRunFailure(info.stdout, this.cliDisplayName);
    if (!failure) return result;

    return { ...result, success: false, error: failure };
  }
}
