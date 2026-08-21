import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "@/lib/validation/error-message";

/**
 * What a form shows when the server refuses the body it sent.
 *
 * `validateBody` puts the summary in `error` and the reasons in `details`, so
 * a caller that renders `error` alone tells the user only that something was
 * wrong. These are the shapes that actually come back over the wire.
 */
describe("apiErrorMessage", () => {
  it("prefers the field reason over the bare summary", () => {
    expect(
      apiErrorMessage(
        {
          error: "Validation failed",
          details: { title: ["Title is required"] },
        },
        "Failed to create bug"
      )
    ).toBe("Title is required");
  });

  it("joins reasons from several fields", () => {
    expect(
      apiErrorMessage(
        {
          error: "Validation failed",
          details: {
            title: ["Title is required"],
            images: ["A bug may carry at most 10 screenshots"],
          },
        },
        "Failed to create bug"
      )
    ).toBe("Title is required · A bug may carry at most 10 screenshots");
  });

  it("reports the same reason once when several fields share it", () => {
    expect(
      apiErrorMessage(
        {
          error: "Validation failed",
          details: { title: ["Too long"], description: ["Too long"] },
        },
        "fallback"
      )
    ).toBe("Too long");
  });

  it("uses the summary when there are no field reasons", () => {
    expect(
      apiErrorMessage({ error: "Project not found" }, "Failed to create bug")
    ).toBe("Project not found");
  });

  it("falls back when details carry nothing usable", () => {
    expect(
      apiErrorMessage({ details: { title: [], images: [" "] } }, "Failed to create bug")
    ).toBe("Failed to create bug");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["a bare string", "Failed"],
    ["an array", ["nope"]],
    ["a blank error", { error: "   " }],
    ["a non-string error", { error: 500 }],
    ["details that are an array", { details: ["Title is required"] }],
  ])("falls back for %s", (_label, payload) => {
    expect(apiErrorMessage(payload, "Failed to create bug")).toBe(
      "Failed to create bug"
    );
  });

  it("trims what it returns", () => {
    expect(apiErrorMessage({ error: "  Project not found  " }, "x")).toBe(
      "Project not found"
    );
  });
});
