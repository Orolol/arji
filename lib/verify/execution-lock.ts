import path from "node:path";

/**
 * In-process exclusion for deterministic commands sharing one worktree.
 *
 * Arij is a single local server, so a process-local queue is sufficient and
 * avoids stale lock files after a restart. Pipeline callers wait for an
 * earlier verification; interactive callers can fail fast with a readable
 * conflict instead of leaving an HTTP request queued behind a long command.
 */

const chains = new Map<string, Promise<void>>();

export class VerificationAlreadyRunningError extends Error {
  constructor() {
    super("Verification is already running for this epic worktree.");
    this.name = "VerificationAlreadyRunningError";
  }
}

export function isVerificationAlreadyRunningError(
  error: unknown,
): error is VerificationAlreadyRunningError {
  return error instanceof VerificationAlreadyRunningError;
}

export function withVerificationWorktreeLock<T>(
  rawWorktreePath: string,
  task: () => Promise<T>,
  options: { wait?: boolean } = {},
): Promise<T> {
  const key = path.resolve(rawWorktreePath);
  const previous = chains.get(key);

  if (previous && options.wait === false) {
    return Promise.reject(new VerificationAlreadyRunningError());
  }

  const predecessor = previous ?? Promise.resolve();
  let release!: () => void;
  const ownTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  chains.set(key, ownTail);

  const run = async (): Promise<T> => {
    try {
      return await task();
    } finally {
      release();
      if (chains.get(key) === ownTail) chains.delete(key);
    }
  };

  return predecessor.then(run, run);
}
