/**
 * Settings → Pipeline: the PIPELINE and VÉRIFICATION bands load the stored
 * values, batch every edit into one PATCH /api/settings through the tab's
 * shared footer, and refuse a value the gate could not use rather than storing
 * it.
 *
 * The tab itself is a declared deviation from frame 11c, which draws no home
 * for these nine settings; see app/settings/layout.tsx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PipelineSettingsPage from "@/app/settings/pipeline/page";
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
import { DEFAULT_VERIFY_TIMEOUT_MS } from "@/lib/verify/verify-constants";

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
        json: () =>
          Promise.resolve(patchShouldFail ? { error: "nope" } : { data: body }),
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

/** Every toggle on this screen is a real switch, not a checkbox. */
function expectSwitch(testId: string, on: boolean) {
  expect(screen.getByTestId(testId)).toHaveAttribute(
    "aria-checked",
    on ? "true" : "false"
  );
}

function save() {
  fireEvent.click(screen.getByTestId("settings-save"));
}

describe("Settings page — Autonomous Pipeline band", () => {
  it("renders defaults when nothing is stored", async () => {
    render(<PipelineSettingsPage />);

    expect(
      screen.getByRole("heading", { name: "Autonomous Pipeline" })
    ).toBeInTheDocument();

    await waitFor(() => expectSwitch("pipeline-enabled-toggle", true));
    expectSwitch("pipeline-grader-toggle", false);
    expect(screen.getByLabelText("Attempts per stage")).toHaveValue(2);
    expect(screen.getByLabelText("Review → fix cycles")).toHaveValue(2);
  });

  it("hydrates the band from the stored settings", async () => {
    stored = {
      pipeline_enabled: true,
      pipeline_grader_enabled: true,
      pipeline_max_attempts: 4,
      pipeline_max_fix_cycles: 0,
    };

    render(<PipelineSettingsPage />);

    await waitFor(() => expectSwitch("pipeline-enabled-toggle", true));
    expectSwitch("pipeline-grader-toggle", true);
    expect(screen.getByLabelText("Attempts per stage")).toHaveValue(4);
    expect(screen.getByLabelText("Review → fix cycles")).toHaveValue(0);
  });

  it("PATCHes pipeline_enabled when the toggle flips and Save is pressed", async () => {
    render(<PipelineSettingsPage />);
    await waitFor(() => screen.getByTestId("pipeline-enabled-toggle"));

    // The default is ON: the flip turns the full pipeline off.
    fireEvent.click(screen.getByTestId("pipeline-enabled-toggle"));
    // Nothing travels until Save: the tab is draft-and-commit.
    expect(patchCalls).toHaveLength(0);
    save();

    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_enabled: false })
    );
    expectSwitch("pipeline-enabled-toggle", false);
  });

  it("batches both pipeline flags into a single PATCH", async () => {
    render(<PipelineSettingsPage />);
    await waitFor(() => screen.getByTestId("pipeline-grader-toggle"));

    fireEvent.click(screen.getByTestId("pipeline-enabled-toggle"));
    fireEvent.click(screen.getByTestId("pipeline-grader-toggle"));
    save();

    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0]).toEqual({
      pipeline_enabled: false,
      pipeline_grader_enabled: true,
    });
  });

  it("PATCHes the caps and clamps out-of-range values", async () => {
    render(<PipelineSettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Attempts per stage")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Attempts per stage"), {
      target: { value: "9" },
    });
    save();
    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_max_attempts: 5 })
    );
    // Stored is what is shown: the field snaps to the clamped value.
    await waitFor(() =>
      expect(screen.getByLabelText("Attempts per stage")).toHaveValue(5)
    );

    fireEvent.change(screen.getByLabelText("Review → fix cycles"), {
      target: { value: "0" },
    });
    save();
    await waitFor(() =>
      expect(patchCalls).toContainEqual({ pipeline_max_fix_cycles: 0 })
    );
  });

  it("keeps the edit on screen and reports the error when the PATCH fails", async () => {
    patchShouldFail = true;
    render(<PipelineSettingsPage />);
    await waitFor(() => screen.getByTestId("pipeline-enabled-toggle"));

    fireEvent.click(screen.getByTestId("pipeline-enabled-toggle"));
    save();

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent("nope")
    );
    // Draft-and-commit: the unsaved edit stays, so the user can retry it.
    expectSwitch("pipeline-enabled-toggle", false);
  });

  it("ignores non-numeric input instead of PATCHing garbage", async () => {
    render(<PipelineSettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Attempts per stage")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText("Attempts per stage"), {
      target: { value: "" },
    });
    save();

    await new Promise((r) => setTimeout(r, 0));
    expect(patchCalls).toHaveLength(0);
  });
});

describe("Settings page — bug regression command and patterns", () => {
  it("hides the command and pattern fields until the gate is switched on", async () => {
    render(<PipelineSettingsPage />);
    await waitFor(() => screen.getByTestId("bug-regression-toggle"));

    expect(screen.queryByTestId("bug-regression-command")).toBeNull();
    expect(screen.queryByTestId("test-file-patterns")).toBeNull();

    fireEvent.click(screen.getByTestId("bug-regression-toggle"));
    await waitFor(() => screen.getByTestId("bug-regression-command"));
    expect(screen.getByTestId("test-file-patterns")).toBeInTheDocument();
  });

  it("shows the effective defaults and PATCHes an edited command", async () => {
    stored = { bug_regression_check: true };
    render(<PipelineSettingsPage />);

    const command = (await waitFor(() =>
      screen.getByTestId("bug-regression-command")
    )) as HTMLInputElement;
    // The built-in default, not an empty box that would read as unset.
    expect(command.value).toBe(DEFAULT_BUG_REGRESSION_COMMAND);

    fireEvent.change(command, { target: { value: "bundle exec rspec {files}" } });
    save();

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        bug_regression_command: "bundle exec rspec {files}",
      })
    );
  });

  it("refuses a command without the {files} placeholder instead of storing it", async () => {
    // Such a template would run the entire suite on every check.
    stored = { bug_regression_check: true };
    render(<PipelineSettingsPage />);

    const command = (await waitFor(() =>
      screen.getByTestId("bug-regression-command")
    )) as HTMLInputElement;
    fireEvent.change(command, { target: { value: "npm test" } });
    save();

    await waitFor(() => screen.getByText(/must contain \{files\}/i));
    expect(patchCalls.some((c) => "bug_regression_command" in c)).toBe(false);
  });

  it("PATCHes comma-separated patterns as an array", async () => {
    stored = { bug_regression_check: true };
    render(<PipelineSettingsPage />);

    const patterns = (await waitFor(() =>
      screen.getByTestId("test-file-patterns")
    )) as HTMLInputElement;
    expect(patterns.value).toBe(DEFAULT_TEST_FILE_PATTERNS.join(", "));

    fireEvent.change(patterns, { target: { value: "spec/**/*.rb, test/**/*.rb" } });
    save();

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        test_file_patterns: ["spec/**/*.rb", "test/**/*.rb"],
      })
    );
    // Re-joined from what was stored, not from what was typed.
    await waitFor(() =>
      expect(screen.getByTestId("test-file-patterns")).toHaveValue(
        "spec/**/*.rb, test/**/*.rb"
      )
    );
  });
});

describe("Settings page — deterministic verification", () => {
  it("renders the disabled defaults when no verify setting is stored", async () => {
    render(<PipelineSettingsPage />);

    const commands = (await waitFor(() =>
      screen.getByTestId("verify-commands")
    )) as HTMLTextAreaElement;
    expect(JSON.parse(commands.value)).toEqual([]);
    expect(screen.getByTestId("verify-timeout-ms")).toHaveValue(
      DEFAULT_VERIFY_TIMEOUT_MS
    );
  });

  it("hydrates PATCH-encoded commands and saves normalized settings", async () => {
    stored = {
      verify_commands: JSON.stringify([{ name: "test", command: "npm test" }]),
      verify_timeout_ms: "45000",
    };
    render(<PipelineSettingsPage />);

    const commands = (await waitFor(() =>
      screen.getByTestId("verify-commands")
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(JSON.parse(commands.value)).toEqual([
        { name: "test", command: "npm test" },
      ])
    );
    expect(screen.getByTestId("verify-timeout-ms")).toHaveValue(45_000);

    fireEvent.change(commands, {
      target: {
        value: JSON.stringify([
          { name: "lint", command: "npm run lint" },
          { name: "build", command: "npm run build" },
        ]),
      },
    });
    fireEvent.change(screen.getByTestId("verify-timeout-ms"), {
      target: { value: "90000" },
    });
    save();

    await waitFor(() =>
      expect(patchCalls).toContainEqual({
        verify_commands: [
          { name: "lint", command: "npm run lint" },
          { name: "build", command: "npm run build" },
        ],
        verify_timeout_ms: 90_000,
      })
    );
  });

  it("rejects malformed commands without PATCHing settings", async () => {
    render(<PipelineSettingsPage />);
    const commands = await waitFor(() => screen.getByTestId("verify-commands"));

    fireEvent.change(commands, { target: { value: '[{"name":"test"}]' } });
    save();

    expect(
      await screen.findByText(/must be a JSON array of objects/i)
    ).toBeInTheDocument();
    expect(patchCalls).toHaveLength(0);
  });

  it("puts the typed value back when the PATCH fails", async () => {
    patchShouldFail = true;
    render(<PipelineSettingsPage />);
    const commands = (await waitFor(() =>
      screen.getByTestId("verify-commands")
    )) as HTMLTextAreaElement;

    const typed = '[{"name":"test","command":"npm test"}]';
    fireEvent.change(commands, { target: { value: typed } });
    fireEvent.change(screen.getByTestId("verify-timeout-ms"), {
      target: { value: "45000" },
    });
    save();

    expect(await screen.findByText("nope")).toBeInTheDocument();
    // Leaving the pretty-printed value on screen next to the error would
    // imply a value that was never persisted.
    expect(commands.value).toBe(typed);
    expect(screen.getByTestId("verify-timeout-ms")).toHaveValue(45_000);
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
    expect(resolvePipelineEnabledDefault({}, "p1")).toBe(true);
    expect(resolvePipelineEnabledDefault(null, "p1")).toBe(true);
    expect(
      resolvePipelineEnabledDefault({ pipeline_enabled: false }, "p1")
    ).toBe(false);
    expect(
      resolvePipelineEnabledDefault(
        { pipeline_enabled: true, "pipeline_enabled:p1": false },
        "p1"
      )
    ).toBe(false);
    expect(
      resolvePipelineEnabledDefault({ "pipeline_enabled:p1": "true" }, "p1")
    ).toBe(true);
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
