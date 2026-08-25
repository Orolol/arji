import { describe, expect, it, vi } from "vitest";
import {
  VerificationAlreadyRunningError,
  withVerificationWorktreeLock,
} from "@/lib/verify/execution-lock";

describe("verification worktree lock", () => {
  it("fails fast for an interactive run when the worktree is occupied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withVerificationWorktreeLock(
      "/tmp/arij-verify-lock",
      () => gate,
    );

    await expect(
      withVerificationWorktreeLock(
        "/tmp/arij-verify-lock",
        async () => undefined,
        { wait: false },
      ),
    ).rejects.toBeInstanceOf(VerificationAlreadyRunningError);

    release();
    await first;
  });

  it("queues pipeline work and releases the lock after failure", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withVerificationWorktreeLock(
      "/tmp/arij-verify-queue",
      () => gate,
    );
    const secondTask = vi.fn(async () => {
      order.push("second");
      throw new Error("verification failed");
    });
    const second = withVerificationWorktreeLock(
      "/tmp/arij-verify-queue",
      secondTask,
    );

    expect(secondTask).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).rejects.toThrow("verification failed");
    expect(order).toEqual(["second"]);

    await expect(
      withVerificationWorktreeLock(
        "/tmp/arij-verify-queue",
        async () => "released",
        { wait: false },
      ),
    ).resolves.toBe("released");
  });
});
