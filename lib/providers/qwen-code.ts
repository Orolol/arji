/**
 * Qwen Code provider — wraps the `qwen` CLI (Qwen3-Coder).
 *
 * CLI: qwen -p <PROMPT> [--yolo] [--model <model>]
 *
 * Mode mapping:
 * - plan    → no --yolo (read-only default)
 * - code    → --yolo (auto-approve)
 * - analyze → --yolo (the import task must write arji.json)
 *
 * Resume: not supported (uses /resume internal command, not suitable for headless).
 * Output: plain text from stdout.
 */

import { BaseCliProvider } from "./base-provider";
import type { ProviderSpawnOptions } from "./types";

export class QwenCodeProvider extends BaseCliProvider {
  readonly type = "qwen-code" as const;

  get binaryName(): string {
    return "qwen";
  }

  buildArgs(options: ProviderSpawnOptions): string[] {
    const { prompt, mode, model } = options;

    const args: string[] = ["-p", prompt];

    if (mode === "code" || mode === "analyze") {
      args.push("--yolo");
    }

    if (model) {
      args.push("--model", model);
    }

    return args;
  }

  extractResult(stdout: string): string {
    return stdout.trim();
  }

  /**
   * Qwen does not support --resume in headless mode.
   * Always return undefined to prevent resume attempts.
   */
  parseSessionId(): string | undefined {
    return undefined;
  }
}
