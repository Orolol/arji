/**
 * The per-CLI option registry: what each provider declares, how a value
 * becomes CLI arguments, and what it refuses.
 *
 * The option lists asserted here were measured against the CLIs installed on
 * a development machine (claude 2.1.245, codex-cli 0.148.0, omp 18.0.5,
 * agy 1.1.22) rather than copied from the epic — `--max-turns` and a `--fast`
 * flag do not exist on claude, and codex's reasoning effort is a `-c` config
 * override, not a flag. These tests pin the measurement so a later edit has
 * to justify itself.
 */

import { describe, expect, it } from "vitest";
import {
  buildProviderOptionArgs,
  describeProviderOptions,
  getProviderOptionDefinitions,
  normalizeProviderOptions,
  parseStoredProviderOptions,
  resolveClaudePermissionMode,
} from "@/lib/providers/options-registry";
import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";

function keysFor(provider: string): string[] {
  return getProviderOptionDefinitions(provider).map((d) => d.key);
}

describe("registry shape", () => {
  it("declares options for every selectable CLI", () => {
    for (const provider of PROVIDER_OPTIONS) {
      expect(keysFor(provider).length).toBeGreaterThan(0);
    }
  });

  it("gives each option a key, label, hint, type and default", () => {
    for (const provider of PROVIDER_OPTIONS) {
      for (const definition of getProviderOptionDefinitions(provider)) {
        expect(definition.key).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(definition.label.length).toBeGreaterThan(0);
        expect(definition.hint.length).toBeGreaterThan(0);
        expect(["select", "bool", "number", "text"]).toContain(definition.type);
        expect(definition.default).toBeDefined();
        if (definition.type === "select") {
          expect(definition.choices?.length).toBeGreaterThan(0);
        }
        if (definition.type === "number") {
          expect(typeof definition.min).toBe("number");
          expect(typeof definition.max).toBe("number");
        }
      }
    }
  });

  it("has no options for a CLI that is not in the registry", () => {
    // The no-regression path for any provider added later and not yet
    // measured: no editor section, and nothing to translate at spawn.
    expect(keysFor("zai")).toEqual([]);
    expect(keysFor("")).toEqual([]);
    expect(getProviderOptionDefinitions(undefined)).toEqual([]);
    expect(buildProviderOptionArgs("zai", { effort: "high" })).toEqual([]);
    expect(normalizeProviderOptions("zai", { effort: "high" })).toEqual({
      options: {},
      errors: [],
    });
  });
});

describe("claude-code", () => {
  it("exposes the flags claude 2.1.245 actually has", () => {
    expect(keysFor("claude-code")).toEqual(["effort", "permission_mode"]);
  });

  it("does not invent a max-turns or fast option", () => {
    // Both were provisional in the epic; neither exists in `claude --help`.
    expect(keysFor("claude-code")).not.toContain("max_turns");
    expect(keysFor("claude-code")).not.toContain("fast");
  });

  it("translates effort and emits nothing at its default", () => {
    expect(buildProviderOptionArgs("claude-code", { effort: "xhigh" })).toEqual([
      "--effort",
      "xhigh",
    ]);
    expect(buildProviderOptionArgs("claude-code", {})).toEqual([]);
    expect(buildProviderOptionArgs("claude-code", { effort: "" })).toEqual([]);
    expect(buildProviderOptionArgs("claude-code", undefined)).toEqual([]);
  });

  it("never appends a second --permission-mode", () => {
    // The option replaces the mode-derived value; appending would leave two
    // conflicting flags on the same argv.
    expect(
      buildProviderOptionArgs("claude-code", {
        permission_mode: "acceptEdits",
      }),
    ).toEqual([]);
  });
});

describe("claude-code permission mode", () => {
  it("keeps the derived value when nothing is chosen", () => {
    expect(resolveClaudePermissionMode("code", {})).toBe("bypassPermissions");
    expect(resolveClaudePermissionMode("plan", {})).toBe("plan");
    expect(resolveClaudePermissionMode("chat", {})).toBe("default");
    expect(resolveClaudePermissionMode("analyze", {})).toBe("bypassPermissions");
  });

  it("applies the agent's choice on code-producing spawns", () => {
    expect(
      resolveClaudePermissionMode("code", { permission_mode: "acceptEdits" }),
    ).toBe("acceptEdits");
  });

  it("refuses to loosen a read-only posture", () => {
    // A reviewer configured with bypassPermissions would otherwise gain write
    // access to the worktree it is reviewing.
    for (const mode of ["plan", "chat", "analyze"] as const) {
      expect(
        resolveClaudePermissionMode(mode, {
          permission_mode: "bypassPermissions",
        }),
      ).toBe(mode === "plan" ? "plan" : mode === "chat" ? "default" : "bypassPermissions");
    }
  });

  it("ignores a value that is not a known claude permission mode", () => {
    expect(
      resolveClaudePermissionMode("code", { permission_mode: "yolo" }),
    ).toBe("bypassPermissions");
  });
});

describe("codex", () => {
  it("exposes reasoning effort and the config profile", () => {
    expect(keysFor("codex")).toEqual(["reasoning_effort", "profile"]);
  });

  it("translates reasoning effort into a -c config override", () => {
    expect(
      buildProviderOptionArgs("codex", { reasoning_effort: "high" }),
    ).toEqual(["-c", "model_reasoning_effort=high"]);
    expect(buildProviderOptionArgs("codex", {})).toEqual([]);
  });

  it("offers only the effort values the API accepts", () => {
    const effort = getProviderOptionDefinitions("codex").find(
      (d) => d.key === "reasoning_effort",
    );
    expect(effort?.choices?.map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // `minimal` parses in the CLI but the API rejects it for gpt-5.5.
    expect(effort?.choices?.map((c) => c.value)).not.toContain("minimal");
  });

  it("drops --profile on the resume path but keeps -c", () => {
    // `codex exec resume` accepts a strict subset of `codex exec`'s flags and
    // an unknown flag there is a fatal argv error.
    const options = { reasoning_effort: "low", profile: "fast" };
    expect(buildProviderOptionArgs("codex", options)).toEqual([
      "-c",
      "model_reasoning_effort=low",
      "-p",
      "fast",
    ]);
    expect(buildProviderOptionArgs("codex", options, { resume: true })).toEqual([
      "-c",
      "model_reasoning_effort=low",
    ]);
  });

  it("does not expose the sandbox or approval policy", () => {
    // Both sever codex's MCP tool channel — see codexApprovalArgs().
    expect(keysFor("codex")).not.toContain("sandbox");
    expect(keysFor("codex")).not.toContain("approval_policy");
  });
});

describe("oh-my-pi", () => {
  it("exposes the flags omp 18.0.5 actually has", () => {
    expect(keysFor("oh-my-pi")).toEqual(["thinking", "max_time", "advisor"]);
  });

  it("translates each type", () => {
    expect(
      buildProviderOptionArgs("oh-my-pi", {
        thinking: "high",
        max_time: 600,
        advisor: true,
      }),
    ).toEqual(["--thinking", "high", "--max-time", "600", "--advisor"]);
  });

  it("emits nothing when every option is at its default", () => {
    expect(
      buildProviderOptionArgs("oh-my-pi", {
        thinking: "",
        max_time: 0,
        advisor: false,
      }),
    ).toEqual([]);
  });

  it("does not expose the approval mode", () => {
    // always-ask gates device writes behind an approval that auto-blocks in
    // print mode, which severs the MCP channel.
    expect(keysFor("oh-my-pi")).not.toContain("approval_mode");
  });
});

describe("agy", () => {
  it("exposes the flags agy 1.1.22 actually has", () => {
    expect(keysFor("agy")).toEqual(["effort", "sandbox"]);
  });

  it("offers only the three effort levels agy accepts", () => {
    const effort = getProviderOptionDefinitions("agy").find(
      (d) => d.key === "effort",
    );
    expect(effort?.choices?.map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("translates effort and sandbox", () => {
    expect(
      buildProviderOptionArgs("agy", { effort: "high", sandbox: true }),
    ).toEqual(["--effort", "high", "--sandbox"]);
    expect(buildProviderOptionArgs("agy", {})).toEqual([]);
  });
});

describe("validation", () => {
  it("accepts a valid value", () => {
    expect(
      normalizeProviderOptions("codex", { reasoning_effort: "high" }),
    ).toEqual({ options: { reasoning_effort: "high" }, errors: [] });
  });

  it("rejects a value outside the registry's choices with an explicit message", () => {
    const result = normalizeProviderOptions("agy", { effort: "xhigh" });
    expect(result.options).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Reasoning effort");
    expect(result.errors[0]).toContain("low, medium, high");
  });

  it("rejects a number outside its bounds and a non-integer", () => {
    expect(
      normalizeProviderOptions("oh-my-pi", { max_time: 5 }).errors[0],
    ).toContain("between 30 and 86400");
    expect(
      normalizeProviderOptions("oh-my-pi", { max_time: 60.5 }).errors[0],
    ).toContain("whole number");
  });

  it("rejects a wrong type for a boolean", () => {
    expect(
      normalizeProviderOptions("oh-my-pi", { advisor: "yes" }).errors[0],
    ).toContain("true or false");
  });

  it("rejects a profile that is not a plain identifier", () => {
    expect(
      normalizeProviderOptions("codex", { profile: "../etc/passwd" }).errors,
    ).toHaveLength(1);
    expect(
      normalizeProviderOptions("codex", { profile: "fast-2" }).options,
    ).toEqual({ profile: "fast-2" });
  });

  it("drops keys the provider does not declare instead of failing the save", () => {
    // Switching an agent's CLI is an ordinary edit; the previous CLI's
    // leftovers must not become a permanent save error.
    expect(
      normalizeProviderOptions("oh-my-pi", {
        reasoning_effort: "high",
        thinking: "low",
      }),
    ).toEqual({ options: { thinking: "low" }, errors: [] });
  });

  it("drops values equal to the option default", () => {
    expect(
      normalizeProviderOptions("oh-my-pi", {
        thinking: "",
        advisor: false,
        max_time: 0,
      }).options,
    ).toEqual({});
  });

  it("survives a malformed stored payload", () => {
    expect(parseStoredProviderOptions("codex", "not json")).toEqual({});
    expect(parseStoredProviderOptions("codex", null)).toEqual({});
    expect(parseStoredProviderOptions("codex", "[]")).toEqual({});
    expect(
      parseStoredProviderOptions("codex", '{"reasoning_effort":"high"}'),
    ).toEqual({ reasoning_effort: "high" });
  });

  it("rejects a non-object options payload", () => {
    expect(normalizeProviderOptions("codex", "high").errors).toEqual([
      "options must be an object",
    ]);
  });
});

describe("describeProviderOptions", () => {
  it("labels known options and keeps unknown ones readable", () => {
    expect(
      describeProviderOptions("oh-my-pi", { thinking: "high", advisor: true }),
    ).toEqual([
      { key: "thinking", label: "Thinking", value: "High" },
      { key: "advisor", label: "Advisor", value: "on" },
    ]);
    expect(describeProviderOptions("oh-my-pi", { retired: "x" })).toEqual([
      { key: "retired", label: "retired", value: "x" },
    ]);
    expect(describeProviderOptions("oh-my-pi", null)).toEqual([]);
  });
});
