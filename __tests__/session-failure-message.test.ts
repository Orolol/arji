import { describe, expect, it } from "vitest";
import {
  buildSessionFailureMessage,
  buildSessionLogsRecord,
} from "@/lib/agent-sessions/failure-message";

describe("buildSessionFailureMessage", () => {
  it("explicitly names the no-output case and points to the log file", () => {
    const msg = buildSessionFailureMessage({
      hadOutput: false,
      logPath: "/app/data/sessions/s1/logs.json",
    });
    // The whole point of the epic: no bare "Agent error" label — the user
    // must see WHAT happened and WHERE the capture lives.
    expect(msg).toMatch(/failed without any error message and without any output/i);
    expect(msg).toContain("/app/data/sessions/s1/logs.json");
  });

  it("falls back to the session view hint when no log path is known", () => {
    const msg = buildSessionFailureMessage({ hadOutput: false });
    expect(msg).toMatch(/failed without any error message and without any output/i);
    expect(msg).toMatch(/session view/i);
  });

  it("distinguishes the failed-but-had-output case", () => {
    const msg = buildSessionFailureMessage({
      hadOutput: true,
      logPath: "/app/data/sessions/s1/logs.json",
    });
    expect(msg).toMatch(/failed without an error message, but it did produce output/i);
    expect(msg).toContain("/app/data/sessions/s1/logs.json");
    expect(msg).not.toMatch(/without any output/i);
  });

  it("treats whitespace-only log paths as unknown", () => {
    const msg = buildSessionFailureMessage({
      hadOutput: false,
      logPath: "   ",
    });
    expect(msg).toMatch(/session view/i);
  });
});

describe("buildSessionLogsRecord", () => {
  it("passes a surviving result through untouched", () => {
    const result = { success: false, error: "boom", duration: 1200 };
    expect(buildSessionLogsRecord(result, "whatever")).toBe(result);
  });

  it("synthesizes a record with the terminal error when the result was lost", () => {
    const record = buildSessionLogsRecord(undefined, "The agent session failed...");
    expect(record.success).toBe(false);
    expect(record.error).toBe("The agent session failed...");
    expect(record.duration).toBeNull();
  });

  it("keeps an honest null error when even the terminal message is missing", () => {
    const record = buildSessionLogsRecord(null, null);
    expect(record.success).toBe(false);
    expect(record.error).toBeNull();
  });

  it("is JSON-serializable for the on-disk log file", () => {
    const serialized = JSON.stringify(buildSessionLogsRecord(null, "x"), null, 2);
    expect(JSON.parse(serialized)).toMatchObject({ success: false, error: "x" });
  });
});