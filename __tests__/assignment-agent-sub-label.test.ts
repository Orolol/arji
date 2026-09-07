/**
 * The second line of an agent row in the two ROLE-ASSIGNMENT pickers
 * (components/agents-workshop/WhereHeWorksBand.tsx and AssignmentsView.tsx).
 *
 * These are the surfaces that fulfil "a composite is assignable to a role in
 * `agent_provider_defaults`, at global and project scope" — and they were the
 * only agent pickers in the app the composite work did not sweep. Both
 * rendered the SIMPLE-agent shape for every row: `PROVIDER_LABELS[provider]`
 * followed by the model or " · CLI default model".
 *
 * That is wrong twice over for a composite. `PROVIDER_LABELS` is keyed on
 * `ChatModeProvider` and has no `composite` entry, so the label resolved to
 * `undefined` and rendered as nothing; and a composite owns no CLI at all, so
 * "CLI default model" is a claim about a thing that does not exist.
 */
import { describe, it, expect } from "vitest";
import { assignmentAgentSubLabel } from "@/components/agents-workshop/agent-initials";
import { COMPOSITE_AGENT_PROVIDER } from "@/lib/agent-config/constants";

describe("assignmentAgentSubLabel", () => {
  it("names a composite's ladder instead of a provider it does not have", () => {
    const label = assignmentAgentSubLabel({
      kind: "composite",
      provider: COMPOSITE_AGENT_PROVIDER,
      model: "",
      members: [{ name: "Opus Builder" }, { name: "Codex Fast" }],
    });

    expect(label).toBe("composite · Opus Builder → Codex Fast");
    // The two failure modes of the old shape, pinned so neither comes back.
    expect(label).not.toMatch(/CLI default model/);
    expect(label).not.toMatch(/undefined/);
  });

  it("says an emptied composite is unusable rather than printing a blank", () => {
    expect(
      assignmentAgentSubLabel({
        kind: "composite",
        provider: COMPOSITE_AGENT_PROVIDER,
        model: "",
        members: [],
      })
    ).toBe("composite · no members — unusable");

    // A payload shaped by an older route carries no `members` at all; it must
    // degrade, not throw, in a dropdown every assignment surface mounts.
    expect(
      assignmentAgentSubLabel({
        kind: "composite",
        provider: COMPOSITE_AGENT_PROVIDER,
        model: "",
      })
    ).toBe("composite · no members — unusable");
  });

  it("keeps the simple-agent shape unchanged", () => {
    expect(
      assignmentAgentSubLabel({
        kind: "simple",
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe("Codex · gpt-5.4");

    expect(
      assignmentAgentSubLabel({
        kind: "simple",
        provider: "claude-code",
        model: "",
      })
    ).toBe("Claude Code · CLI default model");
  });

  it("renders a legacy provider string rather than a blank", () => {
    // `named_agents.provider` is free-form text, so a row written before a
    // provider cleanup carries a value PROVIDER_LABELS cannot name. The old
    // code printed nothing for it; the raw string is at least readable.
    expect(
      assignmentAgentSubLabel({ provider: "gemini-cli", model: "" })
    ).toBe("gemini-cli · CLI default model");
  });
});
