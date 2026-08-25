/**
 * Settings page — "Autonomous Pipeline" card: loads the stored values,
 * round-trips the toggle and the two numeric caps through PATCH
 * /api/settings, clamps out-of-range input, and reverts on failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import {
  parsePipelineMaxAttempts,
  parsePipelineMaxFixCycles,
  resolvePipelineEnabledDefault,
  resolvePipelineGraderEnabledDefault,
} from "@/lib/pipeline/constants";
import {
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
} from "@/lib/verify/regression-constants";

let stored: Record<string, unknown> = {};
let patchCalls: Array<Record<string, unknown>> = [];
let patchShouldFail = false;

beforeEach(() => {
  stored = {};
  patchCalls = [];
  patchShouldFail = false;

  global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/settings" && opts?.method === "PATCH") {
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      patchCalls.push(body);
      if (!patchShouldFail) Object.assign(stored, body);
      return Promise.resolve({
        ok: !patchShouldFail,
        json: () => Promise.resolve(patchShouldFail ? { error: "nope" } : { data: body }),
      });
    }
    if (url === "/api/settings") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: stored }) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { webhooks: [] } }),
    });
  });
});

describe("Settings page — Autonomous Pipeline card", () => {
  it("renders defaults when nothing is stored", async () => {
    render(<SettingsPage />);

    expect(
      screen.getByRole("heading", { name: "Autonomous Pipeline" })
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId("pipeline-enabled-toggle")).not.toBeChecked()
    );
    expect(screen.getByTestId("pipeline-grader-toggle")).not.toBeChecked();
    expect(screen.getByLabelText("Attempts per stage")).toHaveValue(2);
    expect(screen.getByLabelText("Review → fix cycles")).toHaveValue(2);
  });

  it("hydrates the card from the stored settings", async () => {
    stored = {
      pipeline_enabled: true,
      pipeline_grader_enabled: true,
      pipeline_max_attempts: 4,
      pipeline_max_fix_cycles: 0,
    };

    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("pipeline-enabled-toggle")).toBeChecked()
    );
    expect(screen.getByTestId("pipeline-grader-toggle")).toBeChecked();
    expect(screen.getByLabelText("Attempts per stage")).toHaveValue(4);
    expect(screen.getByLabelText("Review → fix cycles")).toHaveValue(0);
  });

  it("PATCHes pipeline_enabled when the toggle flips", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-enabled-toggle")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("pipeline-enabled-toggle"));

    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_enabled: true })
    );
    expect(screen.getByTestId("pipeline-enabled-toggle")).toBeChecked();
  });

  it("PATCHes the independently opt-in grader setting", async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByTestId("pipeline-grader-toggle"));

    fireEvent.click(screen.getByTestId("pipeline-grader-toggle"));

    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_grader_enabled: true })
    );
  });

  it("PATCHes the caps and clamps out-of-range values", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Attempts per stage")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Attempts per stage"), {
      target: { value: "9" },
    });
    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_max_attempts: 5 })
    );

    fireEvent.change(screen.getByLabelText("Review → fix cycles"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_max_fix_cycles: 0 })
    );
    expect(
      screen.getByText(
        "Fix cycles disabled: blocking findings end the run immediately."
      )
    ).toBeInTheDocument();
  });

  it("reverts the toggle and reports an error when the PATCH fails", async () => {
    patchShouldFail = true;
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("pipeline-enabled-toggle")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("pipeline-enabled-toggle"));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to save the pipeline settings.")
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId("pipeline-enabled-toggle")).not.toBeChecked();
  });

  it("ignores non-numeric input instead of PATCHing garbage", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Attempts per stage")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Attempts per stage"), {
      target: { value: "" },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(patchCalls).toHaveLength(0);
  });
});

describe("Settings page — bug regression command and patterns", () => {
  it("hides the command and pattern fields until the gate is switched on", async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByTestId("bug-regression-toggle"));

    expect(screen.queryByTestId("bug-regression-command")).toBeNull();
    expect(screen.queryByTestId("test-file-patterns")).toBeNull();

    fireEvent.click(screen.getByTestId("bug-regression-toggle"));
    await waitFor(() => screen.getByTestId("bug-regression-command"));
    expect(screen.getByTestId("test-file-patterns")).toBeInTheDocument();
  });

  it("shows the effective defaults and PATCHes an edited command", async () => {
    stored = { bug_regression_check: true };
    render(<SettingsPage />);

    const command = (await waitFor(() =>
      screen.getByTestId("bug-regression-command")
    )) as HTMLInputElement;
    // The built-in default, not an empty box that would read as unset.
    expect(command.value).toBe(DEFAULT_BUG_REGRESSION_COMMAND);

    fireEvent.change(command, { target: { value: "bundle exec rspec {files}" } });
    fireEvent.blur(command);

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        bug_regression_command: "bundle exec rspec {files}",
      })
    );
  });

  it("refuses a command without the {files} placeholder instead of storing it", async () => {
    // Such a template would run the entire suite on every check.
    stored = { bug_regression_check: true };
    render(<SettingsPage />);

    const command = (await waitFor(() =>
      screen.getByTestId("bug-regression-command")
    )) as HTMLInputElement;
    fireEvent.change(command, { target: { value: "npm test" } });
    fireEvent.blur(command);

    await waitFor(() => screen.getByText(/must contain \{files\}/i));
    expect(
      patchCalls.some((c) => "bug_regression_command" in c)
    ).toBe(false);
  });

  it("PATCHes comma-separated patterns as an array", async () => {
    stored = { bug_regression_check: true };
    render(<SettingsPage />);

    const patterns = (await waitFor(() =>
      screen.getByTestId("test-file-patterns")
    )) as HTMLInputElement;
    expect(patterns.value).toBe(DEFAULT_TEST_FILE_PATTERNS.join(", "));

    fireEvent.change(patterns, { target: { value: "spec/**/*.rb, test/**/*.rb" } });
    fireEvent.blur(patterns);

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        test_file_patterns: ["spec/**/*.rb", "test/**/*.rb"],
      })
    );
  });
});

describe("pipeline setting parsers", () => {
  it("clamps attempts into [1,5] and fix cycles into [0,5]", () => {
    expect(parsePipelineMaxAttempts(0)).toBe(1);
    expect(parsePipelineMaxAttempts(99)).toBe(5);
    expect(parsePipelineMaxAttempts("3")).toBe(3);
    expect(parsePipelineMaxAttempts("abc")).toBeNull();
    expect(parsePipelineMaxFixCycles(-4)).toBe(0);
    expect(parsePipelineMaxFixCycles(2.5)).toBeNull();
  });

  it("resolves the effective enabled default project-first", () => {
    expect(resolvePipelineEnabledDefault({}, "p1")).toBe(false);
    expect(resolvePipelineEnabledDefault({ pipeline_enabled: true }, "p1")).toBe(
      true
    );
    expect(
      resolvePipelineEnabledDefault(
        { pipeline_enabled: true, "pipeline_enabled:p1": false },
        "p1"
      )
    ).toBe(false);
    expect(
      resolvePipelineEnabledDefault({ "pipeline_enabled:p1": "true" }, "p1")
    ).toBe(true);
    expect(resolvePipelineEnabledDefault(null, "p1")).toBe(false);
    expect(resolvePipelineGraderEnabledDefault({}, "p1")).toBe(false);
    expect(
      resolvePipelineGraderEnabledDefault(
        {
          pipeline_grader_enabled: true,
          "pipeline_grader_enabled:p1": false,
        },
        "p1",
      ),
    ).toBe(false);
  });
});
