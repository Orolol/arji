import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { verifyReports } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import type { VerifyCommand } from "./verify-constants";

/** Maximum combined stdout/stderr retained for one command. */
export const VERIFY_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Match provider cancellation: allow five seconds before force-killing. */
export const VERIFY_KILL_GRACE_MS = 5_000;

export interface VerifyCommandResult extends VerifyCommand {
  /** Null when the command timed out or could not be started. */
  exitCode: number | null;
  durationMs: number;
  /** Bounded, interleaved stdout/stderr tail. */
  tail: string;
}

export interface VerificationResult {
  id: string;
  projectId: string;
  epicId: string;
  agentSessionId: string | null;
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  commands: VerifyCommandResult[];
}

export interface RunVerificationInput {
  projectId: string;
  epicId: string;
  agentSessionId?: string | null;
  /** Explicit epic worktree. There is deliberately no repository-path fallback. */
  worktreePath: string;
  commands: readonly VerifyCommand[];
  /** Hard timeout applied independently to every command. */
  timeoutMs: number;
  /** Test seam; production callers use Arij's shared database. */
  database?: ArijDatabase;
}

/**
 * A byte-bounded accumulator that never retains the beginning of oversized
 * output. Both streams append to the same instance, preserving their observed
 * event order and making the persisted failure context directly readable.
 */
class OutputTail {
  private value = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length >= VERIFY_OUTPUT_LIMIT_BYTES) {
      this.value = Buffer.from(
        incoming.subarray(incoming.length - VERIFY_OUTPUT_LIMIT_BYTES)
      );
      return;
    }

    const bytesToKeep = VERIFY_OUTPUT_LIMIT_BYTES - incoming.length;
    const previous =
      this.value.length > bytesToKeep
        ? this.value.subarray(this.value.length - bytesToKeep)
        : this.value;
    this.value = Buffer.concat([previous, incoming]);
  }

  toString(): string {
    return this.value.toString("utf8");
  }
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals
): void {
  // detached:true makes the shell the leader of a new process group on POSIX.
  // A negative pid reaches the shell and every descendant it launched.
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone or unsupported. Fall back to the child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process already exited between the close check and the signal.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runCommand(input: {
  command: VerifyCommand;
  worktreePath: string;
  timeoutMs: number;
}): Promise<VerifyCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const output = new OutputTail();
    let child: ChildProcess | null = null;
    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let forceKillHandle: ReturnType<typeof setTimeout> | null = null;

    const finish = (exitCode: number | null, spawnError?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);

      if (spawnError !== undefined) {
        output.append(
          `\n[Arij] Could not start verification command: ${errorMessage(spawnError)}\n`
        );
      } else if (timedOut) {
        output.append(
          `\n[Arij] Verification command timed out after ${input.timeoutMs} ms.\n`
        );
      }

      resolve({
        ...input.command,
        exitCode: timedOut ? null : exitCode,
        durationMs: Date.now() - startedAt,
        tail: output.toString(),
      });
    };

    try {
      child = nodeSpawn(input.command.command, {
        cwd: input.worktreePath,
        env: process.env,
        shell: true,
        // Required for process-group cancellation on POSIX. Windows falls
        // back to signalling the spawned shell itself.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => output.append(chunk));
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));

    timeoutHandle = setTimeout(() => {
      if (!child || settled) return;
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      forceKillHandle = setTimeout(() => {
        if (!child || settled) return;
        signalProcessGroup(child, "SIGKILL");
      }, VERIFY_KILL_GRACE_MS);
    }, input.timeoutMs);
  });
}

/**
 * Execute the configured checks sequentially in an epic worktree, stop at the
 * first failure, and persist the terminal report. This function launches no
 * agent and performs no LLM call.
 */
export async function runVerification(
  input: RunVerificationInput
): Promise<VerificationResult> {
  if (!input.worktreePath.trim()) {
    throw new Error("Verification requires an explicit epic worktree path.");
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Verification timeout must be a positive number.");
  }

  const startedAt = new Date().toISOString();
  const commandResults: VerifyCommandResult[] = [];

  for (const command of input.commands) {
    const result = await runCommand({
      command,
      worktreePath: input.worktreePath,
      timeoutMs: input.timeoutMs,
    });
    commandResults.push(result);
    if (result.exitCode !== 0) break;
  }

  const finishedAt = new Date().toISOString();
  const report: VerificationResult = {
    id: createId(),
    projectId: input.projectId,
    epicId: input.epicId,
    agentSessionId: input.agentSessionId ?? null,
    status:
      commandResults.length === input.commands.length &&
      commandResults.every((command) => command.exitCode === 0)
        ? "pass"
        : "fail",
    startedAt,
    finishedAt,
    commands: commandResults,
  };

  const database = input.database ?? defaultDb;
  database
    .insert(verifyReports)
    .values({
      ...report,
      commands: JSON.stringify(report.commands),
    })
    .run();

  return report;
}
