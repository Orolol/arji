/**
 * Getting an oversized prompt out of argv.
 *
 * Linux caps a SINGLE argv element at MAX_ARG_STRLEN — 32 pages, 128 KiB,
 * hard-coded in the kernel and not raisable by ulimit (the much larger
 * ARG_MAX applies to the whole argv+env block, not one string). Every CLI
 * Arij drives takes the prompt as one argument, so a prompt past that cap
 * makes `execve()` fail before the child process exists: the session dies in
 * milliseconds with `spawn E2BIG` and an empty raw stream, which reads like
 * a broken agent rather than a full argument list.
 *
 * Arij prompts cross the line on their own, with nothing wrong: the project
 * spec, the learned memory, the epic and the ENTIRE comment history are
 * concatenated, and a ticket that collected a handful of pasted code reviews
 * clears 128 KiB. Growth is monotonic, so the failure is deterministic —
 * relaunching identically fails identically, and each new comment makes it
 * worse.
 *
 * The fix is per-CLI because the escape hatch is: pi/omp inline a `@path`
 * argument, codex reads a `-` prompt from stdin, claude reads stdin when
 * `--print` gets no prompt. Providers with no such channel are caught by the
 * argv guard in BaseCliProvider.spawn() and fail with a readable message.
 */

import { chmodSync, unlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

/** The kernel's per-argument cap: 32 pages of 4 KiB. */
export const MAX_ARG_STRLEN_BYTES = 131_072;

/**
 * Prompt size above which providers switch to their out-of-band channel.
 * Below it the prompt keeps riding argv, which is the shape every provider
 * is verified against; the headroom under the cap absorbs the difference
 * between what we measure here and what the CLI ends up passing on.
 */
export const ARGV_PROMPT_LIMIT_BYTES = 120_000;

/** Whether `prompt` is too large to ride argv safely. */
export function promptExceedsArgv(prompt: string): boolean {
  return Buffer.byteLength(prompt, "utf8") > ARGV_PROMPT_LIMIT_BYTES;
}

/** The first argument that would make execve() fail with E2BIG, if any. */
export function findOversizedArg(args: string[]): string | undefined {
  return args.find((a) => Buffer.byteLength(a, "utf8") >= MAX_ARG_STRLEN_BYTES);
}

/**
 * The error shown instead of a bare `spawn E2BIG` when a provider has no way
 * to move the prompt off argv. It names the measured size and the cap so the
 * next step (trim the ticket, or switch provider) is obvious.
 *
 * PINNED TO "en-US" ON PURPOSE. This text is persisted on the session as its
 * error and read back by agents and by the forensic pass; it is not interface
 * copy and must never follow the interface locale (see lib/i18n/format.ts).
 */
export function oversizedArgMessage(cliName: string, bytes: number): string {
  return (
    `Prompt too large for the ${cliName} CLI: ${bytes.toLocaleString("en-US")} bytes ` +
    `in a single argument, over the ${MAX_ARG_STRLEN_BYTES.toLocaleString("en-US")}-byte ` +
    `kernel limit (E2BIG). Trim the ticket's comment history or the project ` +
    `specification, or run the ticket on Claude Code, Codex, Pi or Oh My Pi, ` +
    `which pass long prompts out of band.`
  );
}

/**
 * Writes `prompt` to a private temp file and returns its path. The caller
 * owns the file and must pass it to removePromptFile() once the process is
 * done — see the prepareSpawn/cleanupSpawnContext pair in the providers.
 */
export function writePromptFile(label: string, prompt: string): string {
  const filePath = path.join(
    os.tmpdir(),
    `arij-prompt-${label}-${process.pid}-${Date.now()}.md`,
  );
  writeFileSync(filePath, prompt, { mode: 0o600 });
  // writeFileSync's mode only applies on creation; a reused path keeps its
  // old permissions, so restate them.
  chmodSync(filePath, 0o600);
  return filePath;
}

/** Deletes a prompt file written by writePromptFile(). Best-effort. */
export function removePromptFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch {
    // already gone, or the temp dir was cleaned under us
  }
}
