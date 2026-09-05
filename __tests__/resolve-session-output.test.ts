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
const { classifySessionOutcome, resolveSessionOutput } = await import(
  "@/lib/claude/resolve-session-output"
);

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

  // The E-arij-138 leak (2026-08-27): a failed run must not surface its
  // streamed narration ("Now let me look at…") as if it were a deliverable —
  // the ticket comment would read as leaked thinking and feed back into
  // later prompts through the comment history.
  it("prefers the error over streamed narration when the run failed", () => {
    const result = {
      success: false,
      error: "400 Vision is disabled for this server",
      duration: 5000,
    };
    dbMockState.getQueue = [
      { lastNonEmptyText: "Now let me look at the remaining unknowns." },
    ];
    const output = resolveSessionOutput(result, "test-session-8");
    expect(output).toBe("400 Vision is disabled for this server");
  });

  it("keeps a failed run's genuine final text when the envelope has one", () => {
    const result = {
      success: false,
      error: "exit code 1",
      result: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "I could not finish: the migration conflicts with 0042.",
      }),
      duration: 5000,
    };
    const output = resolveSessionOutput(result, "test-session-9");
    expect(output).toBe("I could not finish: the migration conflicts with 0042.");
  });

  it("returns the default message for a failed run with no error text", () => {
    const result = { success: false, duration: 5000 };
    const output = resolveSessionOutput(result, "test-session-10");
    expect(output).toBe("Agent session completed without output.");
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

// ---------------------------------------------------------------------------
// The same scrub, once the stored prompt is capped at persistence
// ---------------------------------------------------------------------------

const { capSessionPrompt } = await import("@/lib/agent-sessions/lifecycle");
const { splitCappedPrompt } = await import("@/lib/agent-sessions/prompt-cap");

/**
 * A prompt over SESSION_PROMPT_MAX_STORED_BYTES: what the row holds is head +
 * marker + tail, and what a CLI echoes is still the WHOLE thing. Recognisable
 * ends, a distinctive middle, so a partial strip is visible as such.
 */
const BIG_PROMPT = `# Project: Arij\n${"SPEC-MIDDLE-LINE\n".repeat(20_000)}\n## Instructions\n\nImplement the ticket.`;

describe("prompt-echo scrubbing with a capped stored prompt", () => {
  it("still recognises a full echo from the two ends the cap kept", () => {
    const storedPrompt = capSessionPrompt(BIG_PROMPT);
    // The premise: the row no longer contains the prompt the CLI echoed.
    expect(splitCappedPrompt(storedPrompt)).not.toBeNull();
    expect(BIG_PROMPT.includes(storedPrompt)).toBe(false);

    const result = textResult(`${BIG_PROMPT}\n\nActual final report.`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-echo-capped-1");
    expect(output).toContain("Actual final report.");
    expect(output).toContain(PROMPT_ECHO_MARKER);
    // The elided middle is what a head-only or tail-only match would leave
    // behind — megabytes of it, straight into a ticket comment.
    expect(output).not.toContain("SPEC-MIDDLE-LINE");
    expect(output).not.toContain("# Project: Arij");
  });

  it("treats an output that is only the echoed prompt as no output at all", () => {
    const result = {
      ...textResult(`${BIG_PROMPT}\n\n${BIG_PROMPT}`),
      success: false,
      error: "Oh My Pi is not authenticated.",
    };
    dbMockState.getQueue = [
      { prompt: capSessionPrompt(BIG_PROMPT) },
      { lastNonEmptyText: null },
    ];
    expect(resolveSessionOutput(result, "s-echo-capped-2")).toBe(
      "Oh My Pi is not authenticated.",
    );
  });

  it("leaves output that merely resembles the prompt alone", () => {
    // The head is there, the tail is not: no span to close, nothing removed.
    const storedPrompt = capSessionPrompt(BIG_PROMPT);
    const head = splitCappedPrompt(storedPrompt)!.head;
    const result = textResult(`${head}\n\nAnd then something else entirely.`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-echo-capped-3");
    expect(output).not.toContain(PROMPT_ECHO_MARKER);
    expect(output).toContain("And then something else entirely.");
  });
});

// ---------------------------------------------------------------------------
// A capped prompt that repeats its own closing lines
// ---------------------------------------------------------------------------

/**
 * The shape a tail-matching scrub gets wrong.
 *
 * The prompt carries its instruction block TWICE — nested instructions, a
 * quoted earlier prompt, a comment echoing a previous run: exactly the data
 * the snowball is made of. The 20 KiB tail the cap kept therefore also occurs
 * in the middle, so closing the span at the first tail match ends the echo far
 * too early and leaves the rest of the prompt standing.
 */
const CLOSING_BLOCK = `\n## Instructions\n\n${"Implement the ticket carefully.\n".repeat(
  1_200,
)}`;
const REPEATED_TAIL_PROMPT =
  `# Project: Arij\n${"SPEC-MIDDLE-LINE\n".repeat(6_000)}` +
  CLOSING_BLOCK +
  `${"SPEC-MIDDLE-LINE\n".repeat(6_000)}` +
  CLOSING_BLOCK;

describe("prompt-echo scrubbing when the prompt repeats its own tail", () => {
  it("removes the whole echo, not just up to the first tail match", () => {
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const parts = splitCappedPrompt(storedPrompt)!;
    // The premise: the kept tail really does occur inside the elided middle,
    // before the copy at the end.
    expect(REPEATED_TAIL_PROMPT.indexOf(parts.tail)).toBeLessThan(
      REPEATED_TAIL_PROMPT.length - parts.tail.length,
    );

    const result = textResult(`${REPEATED_TAIL_PROMPT}\n\nActual final report.`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-repeat-1");
    expect(output).toContain("Actual final report.");
    expect(output).toContain(PROMPT_ECHO_MARKER);
    expect(output).not.toContain("SPEC-MIDDLE-LINE");
    expect(output).not.toContain("Implement the ticket carefully.");
    // The remnant a first-tail-match span leaves is not "bounded": it is
    // everything between the two copies. Measured at 1.04 MB on a 1.18 MB
    // prompt before this was fixed.
    expect(output.length).toBeLessThan(
      PROMPT_ECHO_MARKER.length + "\n\nActual final report.".length + 8,
    );
  });

  it("treats an echo-only run as silent rather than answered", () => {
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = textResult(REPEATED_TAIL_PROMPT);

    dbMockState.getQueue = [{ prompt: storedPrompt }, { lastNonEmptyText: null }];
    expect(classifySessionOutcome(result, "s-repeat-2")).toBe("silent");

    dbMockState.getQueue = [
      { prompt: storedPrompt },
      { lastNonEmptyText: null },
    ];
    expect(resolveSessionOutput(result, "s-repeat-2b", "Nothing delivered.")).toBe(
      "Nothing delivered.",
    );
  });

  it("removes every copy when the prompt is echoed more than once", () => {
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = textResult(
      `${REPEATED_TAIL_PROMPT}\n\n${REPEATED_TAIL_PROMPT}\n\nThe deliverable.`,
    );
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-repeat-3");
    expect(output).toContain("The deliverable.");
    expect(output).not.toContain("SPEC-MIDDLE-LINE");
    // Two echoes, one marker: the n-times collapse in stripPromptEcho.
    expect(output.split(PROMPT_ECHO_MARKER)).toHaveLength(2);
  });

  it("leaves a truncated echo alone rather than eating what follows it", () => {
    // Head present, tail present, but the run stopped mid-prompt: the span is
    // the wrong length, so nothing matches and nothing is removed. Less
    // scrubbing is the safe direction; swallowing real output is not.
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const truncated = REPEATED_TAIL_PROMPT.slice(
      0,
      Math.floor(REPEATED_TAIL_PROMPT.length / 2),
    );
    const result = textResult(`${truncated}\n\nAnd here is the real answer.`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-repeat-4");
    expect(output).not.toContain(PROMPT_ECHO_MARKER);
    expect(output).toContain("And here is the real answer.");
  });
});


// ---------------------------------------------------------------------------
// A capped prompt that is not ASCII
// ---------------------------------------------------------------------------

/**
 * The scrub closes an echo on the prompt's exact BYTE length, and the two ends
 * it matches on are the bytes the cap kept. That arithmetic only holds because
 * `capTextHeadTail` walks each cut off any UTF-8 continuation byte before
 * slicing: a cut left inside a character would decode to U+FFFD, so the stored
 * head would no longer be a substring of what the CLI echoed and the span
 * would never match.
 *
 * The cap's own tests pin "never cuts inside a multi-byte character". They do
 * not pin what that costs the resolver: with the walk-off removed, every test
 * above still passes — they are all ASCII — while a non-ASCII echo silently
 * stops being scrubbed and an echo-only run is classified `answered` again.
 * That is the gap these two cover.
 */
const UTF8_CLOSING_BLOCK = `\n## 指示\n\n${"チケットを慎重に実装してください 🌊\n".repeat(
  1_200,
)}`;
const UTF8_PROMPT =
  `# Projet: Arij\n${"仕様の中間行 — SPEC-MIDDLE 🌊\n".repeat(6_000)}` +
  UTF8_CLOSING_BLOCK +
  `${"仕様の中間行 — SPEC-MIDDLE 🌊\n".repeat(6_000)}` +
  UTF8_CLOSING_BLOCK;

describe("prompt-echo scrubbing when the prompt is multi-byte", () => {
  it("removes the whole echo of a multi-byte capped prompt", () => {
    const storedPrompt = capSessionPrompt(UTF8_PROMPT);
    const parts = splitCappedPrompt(storedPrompt)!;

    // The premise the span arithmetic rests on: neither cut landed inside a
    // character, so the two kept ends plus the elided count are exactly the
    // byte length of the prompt the CLI was handed.
    expect(storedPrompt).not.toContain("�");
    expect(
      Buffer.byteLength(parts.head, "utf8") +
        parts.elidedBytes +
        Buffer.byteLength(parts.tail, "utf8"),
    ).toBe(Buffer.byteLength(UTF8_PROMPT, "utf8"));

    const result = textResult(`${UTF8_PROMPT}\n\nLe rapport final. 🎯`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-utf8-1");
    expect(output).toContain("Le rapport final. 🎯");
    expect(output).toContain(PROMPT_ECHO_MARKER);
    expect(output).not.toContain("SPEC-MIDDLE");
  });

  it("treats a multi-byte echo-only run as silent rather than answered", () => {
    const storedPrompt = capSessionPrompt(UTF8_PROMPT);
    const result = textResult(UTF8_PROMPT);

    dbMockState.getQueue = [{ prompt: storedPrompt }, { lastNonEmptyText: null }];
    expect(classifySessionOutcome(result, "s-utf8-2")).toBe("silent");
  });
});

// ---------------------------------------------------------------------------
// The echo arrives as bare stdout, not inside a JSON envelope
// ---------------------------------------------------------------------------

/**
 * `parseClaudeOutput` opens with `raw.trim()`, and only a JSON envelope
 * shields the text inside it from that trim. The measured echo — an
 * unauthenticated omp writing its prompt to stdout — has no envelope, so what
 * reaches the scrub is the prompt with its trailing newline already gone.
 *
 * 863 of the 974 stored prompts over 500 bytes end in whitespace (88.6%,
 * measured read-only on the live database), so this is the common case, not
 * the corner. Every fixture above wraps its echo in `textResult`, which is
 * why the gap survived the fix for the repeated-tail finding: a byte-length
 * span that expects the trailing newline to still be there overshoots the end
 * of the buffer, the verification fails, and the whole echo is kept.
 */
function rawStdoutResult(text: string) {
  return { success: true, result: text, duration: 100 };
}

describe("prompt-echo scrubbing when the CLI echoed to bare stdout", () => {
  it("scrubs an uncapped echo whose trailing newline the output trim ate", () => {
    const prompt = `${FAKE_PROMPT}\n`;
    // The premise: the echo is no longer a verbatim substring of the output.
    expect(prompt.trim().includes(prompt)).toBe(false);

    dbMockState.getQueue = [{ prompt }, { lastNonEmptyText: null }];
    expect(
      resolveSessionOutput(rawStdoutResult(prompt), "s-bare-1", "Nothing delivered."),
    ).toBe("Nothing delivered.");
  });

  it("treats a bare-stdout echo of a capped prompt as silent, not answered", () => {
    // REPEATED_TAIL_PROMPT ends with its closing block's newline, so the span
    // this scrub closes on runs one byte past the end of the trimmed output.
    expect(/\s$/.test(REPEATED_TAIL_PROMPT)).toBe(true);
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = rawStdoutResult(REPEATED_TAIL_PROMPT);

    dbMockState.getQueue = [{ prompt: storedPrompt }, { lastNonEmptyText: null }];
    expect(classifySessionOutcome(result, "s-bare-2")).toBe("silent");

    dbMockState.getQueue = [{ prompt: storedPrompt }, { lastNonEmptyText: null }];
    const output = resolveSessionOutput(result, "s-bare-2b", "Nothing delivered.");
    // Not "a bounded remnant": before this, all 1.18 MB of it came back.
    expect(output).toBe("Nothing delivered.");
  });

  it("collapses a bare-stdout echo repeated to the end of the output", () => {
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = rawStdoutResult(
      `${REPEATED_TAIL_PROMPT}\n\n${REPEATED_TAIL_PROMPT}`,
    );
    dbMockState.getQueue = [{ prompt: storedPrompt }, { lastNonEmptyText: null }];

    // The first copy keeps its newline and matches exactly; only the last one
    // needs the trimmed variant. Both have to go.
    expect(resolveSessionOutput(result, "s-bare-3", "Nothing delivered.")).toBe(
      "Nothing delivered.",
    );
  });

  it("keeps genuine output that precedes a trailing bare-stdout echo", () => {
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = rawStdoutResult(
      `I rewrote the retention window.\n\n${REPEATED_TAIL_PROMPT}`,
    );
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-bare-4");
    expect(output).toContain("I rewrote the retention window.");
    expect(output).toContain(PROMPT_ECHO_MARKER);
    expect(output).not.toContain("SPEC-MIDDLE-LINE");
  });

  it("does not treat output merely ENDING like the prompt's tail as an echo", () => {
    // Only the whole prompt, minus the whitespace a trim would have taken,
    // counts. The closing block alone is not an echo of the prompt.
    const storedPrompt = capSessionPrompt(REPEATED_TAIL_PROMPT);
    const result = rawStdoutResult(`Here is what I did.${CLOSING_BLOCK}`);
    dbMockState.getQueue = [{ prompt: storedPrompt }];

    const output = resolveSessionOutput(result, "s-bare-5");
    expect(output).toContain("Here is what I did.");
    expect(output).not.toContain(PROMPT_ECHO_MARKER);
  });
});
