import { describe, expect, it, vi, beforeEach } from "vitest";
import { NO_TEXTUAL_OUTPUT_FALLBACK } from "@/lib/claude/json-parser";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// Import after mocks
const { resolveSessionOutput } = await import("@/lib/claude/resolve-session-output");

beforeEach(() => {
  resetDbMockState();
});

describe("resolveSessionOutput", () => {
  it("returns parsed content when result has textual output", () => {
    const result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "The build completed successfully with all tests passing.",
      }),
      duration: 5000,
    };
    const output = resolveSessionOutput(result, "test-session-1");
    expect(output).toBe("The build completed successfully with all tests passing.");
  });

  it("falls back to lastNonEmptyText when result is (no textual output)", () => {
    const result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
        session_id: "sess-123",
      }),
      duration: 5000,
    };
    dbMockState.getQueue = [
      { lastNonEmptyText: "Applied 3 file edits and ran tests successfully." },
    ];
    const output = resolveSessionOutput(result, "test-session-2");
    expect(output).toBe("Applied 3 file edits and ran tests successfully.");
  });

  it("returns error message when result failed and no lastNonEmptyText", () => {
    const result = {
      success: false,
      error: "Context window exceeded",
      duration: 5000,
    };
    dbMockState.getQueue = [null];
    const output = resolveSessionOutput(result, "test-session-3");
    expect(output).toBe("Context window exceeded");
  });

  it("returns default message when no result and no DB fallback", () => {
    dbMockState.getQueue = [null];
    const output = resolveSessionOutput(null, "test-session-4");
    expect(output).toBe("Agent session completed without output.");
  });

  it("returns custom default message", () => {
    dbMockState.getQueue = [null];
    const output = resolveSessionOutput(null, "test-session-5", "Custom fallback message.");
    expect(output).toBe("Custom fallback message.");
  });

  it("uses lastNonEmptyText over the fallback constant", () => {
    const result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
      }),
      duration: 5000,
    };
    dbMockState.getQueue = [
      { lastNonEmptyText: "Chunk-based text from streaming provider." },
    ];
    const output = resolveSessionOutput(result, "test-session-6");
    expect(output).toBe("Chunk-based text from streaming provider.");
    expect(output).not.toBe(NO_TEXTUAL_OUTPUT_FALLBACK);
  });

  it("handles result with content-array in result field", () => {
    const result = {
      success: true,
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: {
          content: [
            { type: "text", text: "I made the requested changes." },
            { type: "tool_use", id: "toolu_1", name: "Edit", input: {} },
          ],
        },
      }),
      duration: 5000,
    };
    const output = resolveSessionOutput(result, "test-session-7");
    expect(output).toContain("I made the requested changes.");
    expect(output).not.toBe(NO_TEXTUAL_OUTPUT_FALLBACK);
  });
});

// ---------------------------------------------------------------------------
// Prompt-echo scrubbing (the 4.9 MB prompt bug, 2026-08-26)
// ---------------------------------------------------------------------------

const { PROMPT_ECHO_MARKER } = await import(
  "@/lib/claude/resolve-session-output"
);

// Long enough to clear PROMPT_ECHO_MIN_CHARS.
const FAKE_PROMPT = `# Project: Arij\n\n## Project Specification\n\n${"spec line\n".repeat(80)}`;

function textResult(text: string) {
  return {
    success: true,
    result: JSON.stringify({ type: "result", subtype: "success", result: text }),
    duration: 100,
  };
}

describe("prompt-echo scrubbing", () => {
  it("treats an output that is only the echoed prompt as no output at all", () => {
    // Measured shape: a failed omp run echoed its prompt twice to stdout.
    const result = {
      ...textResult(`${FAKE_PROMPT}\n\n${FAKE_PROMPT}`),
      success: false,
      error: "Oh My Pi is not authenticated.",
    };
    dbMockState.getQueue = [
      { prompt: FAKE_PROMPT }, // getSessionPrompt for the parsed candidate
      { lastNonEmptyText: null }, // no streamed fallback
    ];
    expect(resolveSessionOutput(result, "s-echo-1")).toBe(
      "Oh My Pi is not authenticated.",
    );
  });

  it("removes the echo but keeps the real content around it", () => {
    const result = textResult(`${FAKE_PROMPT}\n\nActual final report.`);
    dbMockState.getQueue = [{ prompt: FAKE_PROMPT }];
    const output = resolveSessionOutput(result, "s-echo-2");
    expect(output).toContain("Actual final report.");
    expect(output).toContain(PROMPT_ECHO_MARKER);
    expect(output).not.toContain("## Project Specification");
  });

  it("scrubs the streamed lastNonEmptyText fallback too", () => {
    dbMockState.getQueue = [
      { lastNonEmptyText: FAKE_PROMPT },
      { prompt: FAKE_PROMPT },
    ];
    expect(resolveSessionOutput(null, "s-echo-3", "Nothing delivered.")).toBe(
      "Nothing delivered.",
    );
  });

  it("leaves output alone when the session has no stored prompt", () => {
    const result = textResult(FAKE_PROMPT);
    dbMockState.getQueue = [null];
    expect(resolveSessionOutput(result, "s-echo-4")).toBe(FAKE_PROMPT);
  });
});

