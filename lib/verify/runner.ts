import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "node:child_process";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { verifyReports } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import type {
  VerificationReport,
  VerifyCommand,
  VerifyCommandResult,
} from "./verify-constants";

/** Maximum combined stdout/stderr retained for one command. */
export const VERIFY_OUTPUT_LIMIT_BYTES = 64 * 1024;

/** Match provider cancellation: allow five seconds before force-killing. */
export const VERIFY_KILL_GRACE_MS = 5_000;

/**
 * After the process exits, `close` still waits for every inherited stdio
 * pipe to close. A descendant that escaped the group kill (e.g. setsid)
 * while holding a pipe would otherwise defer settlement indefinitely; this
 * grace bounds that wait and keeps the worktree lock releasable.
 */
export const VERIFY_CLOSE_GRACE_MS = 1_000;

const CHILD_ENV = (() => {
  const { NODE_ENV: _ignored, ...rest } = process.env;
  // Cast: Next.js's augmented ProcessEnv brands NODE_ENV as required, but
  // the whole point here is that verification children must not inherit it.
  return rest as NodeJS.ProcessEnv;
})();

export interface VerificationResult extends VerificationReport {
  /**
   * False when the commands ran but their report row could not be written.
   *
   * The run itself is still valid — the verdict is computed from the exit
   * codes in hand — but every DURABLE consumer reads the table: the merge
   * gate in lib/auto-mode/merge.ts, the EpicDetail panel, the next sweep. A
   * caller that announced "checks passed" from this in-memory value while
   * the table stayed empty would have the two halves disagreeing forever.
   */
  persisted: boolean;
}
export type { VerifyCommandResult } from "./verify-constants";

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
  const { promise, resolve } = Promise.withResolvers<VerifyCommandResult>();

  const startedAt = Date.now();
  const output = new OutputTail();
  let child: ChildProcess | null = null;
  let timedOut = false;
  let settled = false;
  /** Wall-clock moment the process itself exited, if observed. */
  let exitedAt: number | null = null;
  let exitCode: number | null = null;
  // Every armed timer lives here so one settle path can cancel them all.
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const finish = (code: number | null, spawnError?: unknown): void => {
    if (settled) return;
    settled = true;
    for (const handle of timers) clearTimeout(handle);
    timers.clear();

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
      // A timed-out or unstartable command has no meaningful exit code.
      exitCode: timedOut || spawnError !== undefined ? null : (code ?? exitCode),
      // Measured to process exit when possible, so a lingering descendant
      // holding a stdio pipe cannot inflate the persisted duration.
      durationMs: (exitedAt ?? Date.now()) - startedAt,
      tail: output.toString(),
    });
  };

  try {
    child = nodeSpawn(input.command.command, {
      cwd: input.worktreePath,
      env: CHILD_ENV,
      shell: true,
      // Required for process-group cancellation on POSIX. Windows falls
      // back to signalling the spawned shell itself.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    finish(null, error);
    return promise;
  }
  child.stdout?.on("data", (chunk: Buffer | string) => output.append(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => output.append(chunk));
  child.once("error", (error) => finish(null, error));
  child.once("exit", (code) => {
    exitedAt = Date.now();
    exitCode = typeof code === "number" ? code : null;
    // `close` normally follows immediately; bound the wait in case a
    // descendant that escaped the group kill still holds a stdio pipe.
    timers.add(setTimeout(() => finish(exitCode), VERIFY_CLOSE_GRACE_MS));
  });
  // `close` only fires once every stdio pipe has closed. Prefer the exit
  // code recorded earlier; fall back to the close code when no exit event
  // was observed (synthetic/test emitters).
  child.once("close", (code) => {
    finish(typeof code === "number" && exitedAt === null ? code : exitCode);
  });

  timers.add(
    setTimeout(() => {
      if (!child || settled) return;
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      timers.add(
        setTimeout(() => {
          if (!child || settled) return;
          signalProcessGroup(child, "SIGKILL");
          // Absolute settlement deadline. If even SIGKILL cannot produce an
          // exit event, settle now: a hung verify run must never hold the
          // worktree lock — and with it the whole pipeline — forever.
          timers.add(setTimeout(() => finish(null), VERIFY_KILL_GRACE_MS));
        }, VERIFY_KILL_GRACE_MS)
      );
    }, input.timeoutMs)
  );

  return promise;
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
  if (input.commands.length === 0) {
    // A `pass` row must mean something was mechanically proven. Both
    // production callers pre-check config.enabled, so this is a contract
    // guard against future callers, not a reachable path today.
    throw new Error("Verification requires at least one configured command.");
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
  const report: VerificationReport = {
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

  // A lost report row must never fail the run: the commands already
  // executed and their verdict is computed. This mirrors the regression
  // gate's persistence stance (lib/pipeline/verify.ts). The loss is
  // REPORTED rather than swallowed, so a caller does not announce a verdict
  // that no durable reader will ever see.
  let persisted = true;
  try {
    const database = input.database ?? defaultDb;
    database
      .insert(verifyReports)
      .values({
        ...report,
        commands: JSON.stringify(report.commands),
      })
      .run();
  } catch (error) {
    persisted = false;
    console.warn(
      "[verify] Failed to persist verification report:",
      error instanceof Error ? error.message : error
    );
  }
  return { ...report, persisted };
}
