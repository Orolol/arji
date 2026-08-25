/**
 * Gemini CLI provider — runs the `gemini` CLI through the shared
 * BaseCliProvider lifecycle.
 *
 * Gemini-specific behavior, expressed via the base-class hooks:
 * - JSON / stream-JSON / Vertex output parsing in extractResult()
 * - resume support via `--resume <ID>`
 * - actionable error detection for auth and invalid-model failures
 * - "gemini-…" handle and stream-log prefixes (the provider type is
 *   "gemini-cli" but sessions/logs historically use plain "gemini")
 */

import { BaseCliProvider } from "./base-provider";
import type { ProviderSpawnOptions } from "./types";

/**
 * Extract the agent's final text from Gemini CLI stdout. Handles the
 * `--output-format json` document, stream-json events, Vertex/Gemini API
 * candidates payloads, and falls back to the raw trimmed output.
 */
export function extractGeminiResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Try structured JSON parsing first (handles stream-json and json formats)
  const textParts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // stream-json event formats
      if (event.type === "text" && typeof event.text === "string") {
        textParts.push(event.text);
        continue;
      }
      if (
        event.type === "content_block_delta" &&
        typeof event.delta === "object" &&
        event.delta !== null &&
        typeof (event.delta as Record<string, unknown>).text === "string"
      ) {
        textParts.push((event.delta as Record<string, unknown>).text as string);
        continue;
      }
      if (event.type === "result" && typeof event.result === "string") {
        textParts.push(event.result);
        continue;
      }
      if (typeof event.content === "string") {
        textParts.push(event.content);
        continue;
      }
      // Vertex/Gemini API candidates format
      if (
        Array.isArray(
          (event as { candidates?: unknown[] }).candidates
        )
      ) {
        const candidates = (event as { candidates: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
        if (candidates[0]?.content?.parts) {
          for (const part of candidates[0].content.parts) {
            if (part.text) textParts.push(part.text);
          }
          continue;
        }
      }

      // Simple result/output/text fields (json output format)
      if (typeof event.result === "string" && (event.result as string).trim().length > 0) {
        textParts.push((event.result as string).trim());
        continue;
      }
      if (typeof event.output === "string" && (event.output as string).trim().length > 0) {
        textParts.push((event.output as string).trim());
        continue;
      }
      if (typeof event.text === "string" && (event.text as string).trim().length > 0) {
        textParts.push((event.text as string).trim());
        continue;
      }
    } catch {
      // ignore malformed JSON line
    }
  }

  if (textParts.length > 0) {
    return textParts.join("");
  }

  return trimmed;
}

export class GeminiCliProvider extends BaseCliProvider {
  readonly type = "gemini-cli" as const;

  get binaryName(): string {
    return "gemini";
  }

  // Session handles historically use "gemini-<sessionId>", not "gemini-cli-…"
  protected get handlePrefix(): string {
    return "gemini";
  }

  // NDJSON stream logs historically use "gemini-<logIdentifier>"
  protected get logPrefix(): string {
    return "gemini";
  }

  buildArgs(options: ProviderSpawnOptions): string[] {
    const { mode, prompt, model, cliSessionId, resumeSession } = options;

    const args: string[] = [];

    // Resume support
    if (cliSessionId && resumeSession) {
      args.push("--resume", cliSessionId);
    }

    args.push("-p", prompt, "--output-format", "json");

    // Import analysis must write arji.json. Gemini has no narrower
    // write-only approval posture, so analyze shares code mode's headless
    // approval flag; the import prompt constrains the requested mutation.
    if (mode === "code" || mode === "analyze") {
      args.push("-y");
    }

    if (model) {
      args.push("-m", model);
    }

    return args;
  }

  extractResult(stdout: string): string {
    return extractGeminiResult(stdout);
  }

  protected buildSpawnErrorMessage(err: Error): string {
    return err.message.includes("ENOENT")
      ? "Gemini CLI not found. Install it with: npm i -g @google/gemini-cli"
      : `Failed to spawn Gemini CLI: ${err.message}`;
  }

  protected buildExitError(
    code: number | null,
    stdout: string,
    stderr: string,
  ): string {
    const combinedOutput = stderr + "\n" + stdout;

    if (/not authenticated|authentication|unauthorized|login/i.test(combinedOutput)) {
      return "Gemini CLI is not authenticated. Run `gemini auth login` in your terminal.";
    }
    if (/model.*not found|invalid model/i.test(combinedOutput)) {
      return "Invalid model name. Check available Gemini models with `gemini models list`.";
    }
    return stderr.trim() || `Gemini CLI exited with code ${code}`;
  }
}
