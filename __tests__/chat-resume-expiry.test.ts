import { describe, expect, it } from "vitest";
import { isResumeSessionExpiredError } from "@/lib/chat/resume-expiry";

describe("isResumeSessionExpiredError", () => {
  it("matches the strings the installed CLIs actually emit", () => {
    // Measured 2026-08-27, claude 2.1.245:
    //   claude --print --resume <unknown-uuid>
    expect(
      isResumeSessionExpiredError(
        "No conversation found with session ID: 11111111-2222-4333-8444-555555555555",
      ),
    ).toBe(true);
    // Measured 2026-08-27, omp 18.0.6:
    //   omp --mode rpc --resume <unknown-uuid>
    expect(
      isResumeSessionExpiredError(
        'Error: Session "01a00000-0000-7000-8000-000000000000" not found.\n' +
          "Run `omp --resume` without an argument to pick from recent sessions, or `omp` to start a new one.",
      ),
    ).toBe(true);
  });

  it.each([
    "Session expired",
    "session no longer exists",
    "Invalid session id",
    "unknown resume target",
    "conversation does not exist",
  ])("matches the related phrasing %j", (message) => {
    expect(isResumeSessionExpiredError(message)).toBe(true);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["empty", ""],
    ["a rate limit", "429 rate_limit_error: Overloaded"],
    ["a missing binary", "Claude CLI not found. Ensure `claude` is installed."],
    ["a tool failure", "Error: file not found: src/missing.ts"],
    [
      "an unrelated error that merely mentions a session later",
      "Write failed: disk quota exceeded. Nothing was saved for this session.",
    ],
  ])("does not match %s", (_label, message) => {
    // A false positive costs a pointless respawn and re-sends the whole
    // prompt, so the patterns stay narrow rather than catching any string
    // containing the word "session".
    expect(isResumeSessionExpiredError(message)).toBe(false);
  });
});
