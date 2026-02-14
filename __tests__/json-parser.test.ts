import { describe, expect, it } from "vitest";
import {
  parseClaudeOutput,
  extractJsonFromOutput,
  extractCliSessionIdFromOutput,
} from "@/lib/claude/json-parser";

describe("parseClaudeOutput", () => {
  it("returns empty content for empty input", () => {
    expect(parseClaudeOutput("")).toEqual({ content: "" });
    expect(parseClaudeOutput("  ")).toEqual({ content: "" });
  });

  it("returns raw text when input is not valid JSON", () => {
    const result = parseClaudeOutput("Hello, this is plain text.");
    expect(result.content).toBe("Hello, this is plain text.");
  });

  // --- Claude CLI result envelope (--output-format json) ---

  it("extracts text from result envelope with non-empty result field", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "The review found no issues.",
      duration_ms: 5000,
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("The review found no issues.");
  });

  it("returns human-readable fallback for result envelope with empty result", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 147329,
      result: "",
      session_id: "a60e829b-df63-4d9b-8f7b-57c0b9d0749b",
      total_cost_usd: 1.12,
      usage: { input_tokens: 2056 },
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("Agent completed successfully (no textual output).");
    expect(result.content).not.toContain("{");
    expect(result.content).not.toContain("session_id");
  });

  it("returns human-readable fallback for error result envelope with empty result", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "",
      error: "Context window exceeded",
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("Agent finished with an error. Context window exceeded");
  });

  it("returns generic fallback for result envelope with unknown subtype", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: "",
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("Agent session completed without output.");
  });

  it("does NOT use fallback for result envelope with null result (no result key)", () => {
    // When result field is missing entirely, extractTextFromBlock returns ""
    // and the type is "result", so fallback should kick in
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("Agent completed successfully (no textual output).");
  });

  // --- Single object with content field ---

  it("extracts content string from single object", () => {
    const obj = JSON.stringify({
      type: "text",
      content: "Here is the review summary.",
    });
    const result = parseClaudeOutput(obj);
    expect(result.content).toBe("Here is the review summary.");
  });

  it("extracts text from single object with text field", () => {
    const obj = JSON.stringify({
      type: "text",
      text: "Some text content here.",
    });
    const result = parseClaudeOutput(obj);
    expect(result.content).toBe("Some text content here.");
  });

  it("extracts text from single object with response field", () => {
    const obj = JSON.stringify({
      response: "Tech check markdown response",
      usage: { input_tokens: 123 },
    });
    const result = parseClaudeOutput(obj);
    expect(result.content).toBe("Tech check markdown response");
  });

  it("extracts nested response text from result envelope string payload", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        response: "# Findings\n\n- Item 1",
        telemetry: { durationMs: 42 },
      }),
    });
    const result = parseClaudeOutput(envelope);
    expect(result.content).toBe("# Findings\n\n- Item 1");
  });

  // --- Array of blocks ---

  it("extracts text from array of blocks", () => {
    const blocks = JSON.stringify([
      { type: "text", content: "First block." },
      { type: "text", content: "Second block." },
    ]);
    const result = parseClaudeOutput(blocks);
    expect(result.content).toBe("First block.\n\nSecond block.");
  });

  it("extracts text from Anthropic message format content array", () => {
    const blocks = JSON.stringify([
      {
        type: "assistant",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
        ],
      },
    ]);
    const result = parseClaudeOutput(blocks);
    expect(result.content).toBe("Part one.\nPart two.");
  });

  it("skips blocks with no extractable text", () => {
    const blocks = JSON.stringify([
      { type: "tool_use", tool_use: { name: "Read", input: {} } },
      { type: "text", content: "Useful text." },
    ]);
    const result = parseClaudeOutput(blocks);
    expect(result.content).toBe("Useful text.");
  });

  // --- Non-result objects still fall back to JSON.stringify ---

  it("falls back to JSON.stringify for non-result objects with no text", () => {
    const obj = JSON.stringify({ type: "unknown", foo: "bar" });
    const result = parseClaudeOutput(obj);
    // Should contain the JSON dump since type is not "result"
    expect(result.content).toContain('"foo"');
    expect(result.content).toContain('"bar"');
  });

  it("extracts text from NDJSON response payloads", () => {
    const ndjson = [
      JSON.stringify({ type: "init", session_id: "sess-1" }),
      JSON.stringify({
        type: "result",
        result: JSON.stringify({
          response: "Only the response should be shown.",
          stats: { totalTokens: 99 },
        }),
      }),
    ].join("\n");
    const result = parseClaudeOutput(ndjson);
    expect(result.content).toBe("Only the response should be shown.");
  });
});

describe("extractJsonFromOutput", () => {
  it("returns null for empty input", () => {
    expect(extractJsonFromOutput("")).toBeNull();
  });

  it("extracts JSON from result envelope with content-array payload", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: {
        content: [
          {
            type: "text",
            text: '[{"title":"Epic A","userStories":[{"title":"Story A"}]}]',
          },
        ],
      },
    });
    const result = extractJsonFromOutput<Array<{ title: string }>>(envelope);
    expect(result).toEqual([{ title: "Epic A", userStories: [{ title: "Story A" }] }]);
  });

  it("extracts JSON from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: JSON.stringify({ project: "test", imports: [] }),
    });
    const result = extractJsonFromOutput<{ project: string }>(envelope);
    expect(result).toEqual({ project: "test", imports: [] });
  });

  it("returns null for result envelope with no JSON payload", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
    });
    expect(extractJsonFromOutput(envelope)).toBeNull();
  });

  it("extracts JSON from markdown code fence", () => {
    const text = 'Here is the output:\n```json\n{"name": "test"}\n```';
    const result = extractJsonFromOutput<{ name: string }>(text);
    expect(result).toEqual({ name: "test" });
  });

  it("extracts JSON object from mixed content", () => {
    const text = 'Some preamble text\n{"key": "value"}\nMore text';
    const result = extractJsonFromOutput<{ key: string }>(text);
    expect(result).toEqual({ key: "value" });
  });

  it("extracts JSON from NDJSON output", () => {
    const ndjson = [
      JSON.stringify({ type: "init", session_id: "sess-1" }),
      JSON.stringify({
        type: "result",
        result: {
          content: [
            {
              type: "text",
              text: "Some preamble\n```json\n{\"epics\":[{\"title\":\"NDJSON Epic\"}]}\n```",
            },
          ],
        },
      }),
    ].join("\n");
    const result = extractJsonFromOutput<{ epics: Array<{ title: string }> }>(ndjson);
    expect(result).toEqual({ epics: [{ title: "NDJSON Epic" }] });
  });

  it("extracts direct JSON arrays of plain objects", () => {
    const text = '[{"title":"Epic A","description":"From plain array"}]';
    const result = extractJsonFromOutput<Array<{ title: string; description: string }>>(text);
    expect(result).toEqual([{ title: "Epic A", description: "From plain array" }]);
  });
});

describe("extractCliSessionIdFromOutput", () => {
  it("extracts session_id from result envelope", () => {
    const output = JSON.stringify({
      type: "result",
      session_id: "sess-abc-123",
      result: "done",
    });
    expect(extractCliSessionIdFromOutput(output)).toBe("sess-abc-123");
  });

  it("extracts nested session.id from NDJSON", () => {
    const output = [
      JSON.stringify({ type: "init", session: { id: "sess-nested-1" } }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    expect(extractCliSessionIdFromOutput(output)).toBe("sess-nested-1");
  });

  it("returns null when no session id is present", () => {
    const output = JSON.stringify({ type: "result", result: "done" });
    expect(extractCliSessionIdFromOutput(output)).toBeNull();
  });
});
