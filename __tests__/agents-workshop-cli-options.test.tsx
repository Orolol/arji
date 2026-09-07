/**
 * Successor to named-agent-options-editor.test.tsx.
 *
 * EVERY EXPECTATION IS DERIVED FROM `getProviderOptionDefinitions()`, never
 * from a hard-coded option list. The retired file's header said why: "a
 * hard-coded option list in the frontend is exactly what this design forbids,
 * and a test that repeated the list would hide it." The same holds for a test.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import { CliOptionsBand } from "@/components/agents-workshop/CliOptionsBand";
import {
  cliOptionControlKind,
  cliOptionKicker,
  cliOptionKickerSuffixKey,
  resetOptionsForProvider,
} from "@/components/agents-workshop/cli-options";
import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";
import { catalogueValue, type TranslationKey } from "@/lib/i18n/catalogue";
import {
  getProviderOptionDefinitions,
  type NamedAgentCliOptions,
} from "@/lib/providers/options-registry";

/**
 * The namespace-less translator, resolved against the source catalogue — the
 * registry holds catalogue KEY REFERENCES, so a test that wants the rendered
 * word has to resolve one exactly as the band does.
 */
const t = (key: TranslationKey) => catalogueValue("en", key);

function Harness({
  provider,
  initial = {},
  onChange,
}: {
  provider: string;
  initial?: NamedAgentCliOptions;
  onChange?: (options: NamedAgentCliOptions) => void;
}) {
  const [options, setOptions] = useState<NamedAgentCliOptions>(initial);
  return (
    <CliOptionsBand
      provider={provider}
      options={options}
      onChange={(next) => {
        setOptions(next);
        onChange?.(next);
      }}
      disabled={false}
    />
  );
}

/**
 * The option group for one definition, found by its kicker.
 *
 * The kicker text comes from `cliOptionKicker`, not from a copy of the string:
 * the test locates the group the same way the band labels it.
 */
function groupFor(definition: {
  key: string;
  labelKey: TranslationKey;
}): HTMLElement {
  const suffixKey = cliOptionKickerSuffixKey(definition.key);
  const text = cliOptionKicker({
    label: t(definition.labelKey),
    suffix: suffixKey ? t(suffixKey) : "",
  });
  const kicker = screen.getByText(text, {
    selector: '[data-slot="field-kicker"]',
  });
  const group = kicker.parentElement;
  if (!group) throw new Error(`no group for ${definition.key}`);
  return group as HTMLElement;
}

describe("CLI options band — control kind is decided by the registry", () => {
  for (const provider of PROVIDER_OPTIONS) {
    const definitions = getProviderOptionDefinitions(provider);
    if (definitions.length === 0) continue;

    it(`renders every ${provider} definition with the control its shape implies`, () => {
      render(<Harness provider={provider} />);

      for (const definition of definitions) {
        const group = groupFor(definition);
        const kind = cliOptionControlKind(definition);

        if (kind === "segmented") {
          const control = within(group).getByRole("group");
          expect(control).toHaveAttribute(
            "data-slot",
            "segmented-control",
          );
          // A leading "CLI default" segment, then one per registry choice.
          const segments = within(control).getAllByRole("button");
          expect(segments).toHaveLength(
            (definition.choices?.length ?? 0) + 1,
          );
          expect(segments[0]).toHaveTextContent("CLI default");
          expect(segments.slice(1).map((s) => s.textContent)).toEqual(
            definition.choices?.map((choice) => t(choice.labelKey)),
          );
        } else if (kind === "menu") {
          expect(
            group.querySelector('[data-slot="select-pill"]'),
          ).not.toBeNull();
          expect(group.querySelector('[data-slot="segmented-control"]')).toBeNull();
        } else if (kind === "checkmark") {
          expect(group.querySelector('[data-slot="check-mark"]')).not.toBeNull();
        } else {
          expect(
            group.querySelector('[data-slot="field-box-input"]'),
          ).not.toBeNull();
        }
      }
    });
  }

  it("uses a dropdown, not a nine-segment track, past five choices", () => {
    // oh-my-pi's `thinking` has eight levels today; the assertion is written
    // against the count, so adding a ninth changes nothing here.
    const wide = PROVIDER_OPTIONS.flatMap((provider) =>
      getProviderOptionDefinitions(provider)
        .filter(
          (definition) =>
            definition.type === "select" &&
            (definition.choices?.length ?? 0) > 5,
        )
        .map((definition) => ({ provider, definition })),
    );
    expect(wide.length).toBeGreaterThan(0);

    for (const { provider, definition } of wide) {
      const { unmount } = render(<Harness provider={provider} />);
      const group = groupFor(definition);
      expect(group.querySelector('[data-slot="select-pill"]')).not.toBeNull();
      unmount();
    }
  });

  it("collapses the band to its label line for a CLI with no registry entry", () => {
    render(<Harness provider="not-a-registered-cli" />);

    // The header survives; nothing else does.
    expect(screen.getByText("CLI options")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="segmented-control"]')).toBeNull();
    expect(document.querySelector('[data-slot="select-pill"]')).toBeNull();
    expect(document.querySelector('[data-slot="field-box-input"]')).toBeNull();
    expect(document.querySelector('[data-slot="check-mark"]')).toBeNull();
  });
});

describe("CLI options band — what gets stored", () => {
  it("stores a chosen segment and deletes the key on CLI default", () => {
    const onChange = vi.fn();
    const definition = getProviderOptionDefinitions("claude-code").find(
      (candidate) => candidate.key === "effort",
    )!;
    render(<Harness provider="claude-code" onChange={onChange} />);

    const group = groupFor(definition);
    const control = within(group).getByRole("group");
    const buttons = within(control).getAllByRole("button");
    const chosen = definition.choices![1];

    fireEvent.click(buttons[2]);
    expect(onChange).toHaveBeenLastCalledWith({ effort: chosen.value });

    fireEvent.click(buttons[0]);
    // Deleted, not set to "" or undefined: the server treats "absent" and
    // "equal to the default" as the same state, and that is what keeps an
    // unconfigured agent's argv byte-identical to the pre-registry argv.
    expect(onChange).toHaveBeenLastCalledWith({});
    expect("effort" in onChange.mock.calls.at(-1)![0]).toBe(false);
  });

  it("stores `undefined` rather than `false` for an unchecked bool", () => {
    const onChange = vi.fn();
    const definition = getProviderOptionDefinitions("oh-my-pi").find(
      (candidate) => candidate.type === "bool",
    )!;
    render(
      <Harness
        provider="oh-my-pi"
        initial={{ [definition.key]: true }}
        onChange={onChange}
      />,
    );

    const group = groupFor(definition);
    fireEvent.click(group.querySelector('[data-slot="check-mark"]')!);

    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("clears the key when a number input is emptied", () => {
    const onChange = vi.fn();
    const definition = getProviderOptionDefinitions("oh-my-pi").find(
      (candidate) => candidate.type === "number",
    )!;
    render(
      <Harness
        provider="oh-my-pi"
        initial={{ [definition.key]: 120 }}
        onChange={onChange}
      />,
    );

    const group = groupFor(definition);
    const input = group.querySelector('[data-slot="field-box-input"]')!;
    fireEvent.change(input, { target: { value: "" } });

    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("clears the key when a text input holds only whitespace", () => {
    const onChange = vi.fn();
    const definition = getProviderOptionDefinitions("codex").find(
      (candidate) => candidate.type === "text",
    )!;
    render(
      <Harness
        provider="codex"
        initial={{ [definition.key]: "fast" }}
        onChange={onChange}
      />,
    );

    const group = groupFor(definition);
    const input = group.querySelector('[data-slot="field-box-input"]')!;
    fireEvent.change(input, { target: { value: "   " } });

    expect(onChange).toHaveBeenLastCalledWith({});
  });
});

describe("permission mode never offers `plan`", () => {
  /**
   * The assertion the old suite lacked. `plan` was removed after measurement:
   * it refuses mutating tools INCLUDING the Arij MCP tools, so an agent set to
   * it cannot call update_ticket_status, and a reviewer set to it filed no
   * findings and persisted no review_verdict — silently degrading every review
   * to the prose fallback. Frame 7a draws a "Plan" segment; shipping one would
   * re-open a fixed bug.
   */
  it("offers no `plan` choice, for any provider, in the registry", () => {
    for (const provider of PROVIDER_OPTIONS) {
      for (const definition of getProviderOptionDefinitions(provider)) {
        if (definition.key !== "permission_mode") continue;
        expect(
          definition.choices?.some((choice) => choice.value === "plan"),
        ).toBe(false);
      }
    }
  });

  it("renders no `Plan` segment, for any provider", () => {
    for (const provider of PROVIDER_OPTIONS) {
      const { unmount } = render(<Harness provider={provider} />);
      expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
      unmount();
    }
  });
});

describe("resetOptionsForProvider", () => {
  it("drops a key the target CLI does not declare", () => {
    // codex `profile` has no counterpart on claude-code.
    const next = resetOptionsForProvider("claude-code", {
      profile: "fast",
      effort: "high",
    });
    expect(next).toEqual({ effort: "high" });
  });

  it("drops a value the target CLI does not accept for the SAME key", () => {
    // `effort` exists on both claude-code and agy, but agy has no `max`. A
    // key-only check would carry the ghost across.
    const claudeEffort = getProviderOptionDefinitions("claude-code").find(
      (definition) => definition.key === "effort",
    )!;
    const agyEffort = getProviderOptionDefinitions("agy").find(
      (definition) => definition.key === "effort",
    )!;
    const onlyOnClaude = claudeEffort.choices!.find(
      (choice) =>
        !agyEffort.choices!.some((other) => other.value === choice.value),
    )!;
    const sharedValue = agyEffort.choices![0].value;

    expect(
      resetOptionsForProvider("agy", { effort: onlyOnClaude.value }),
    ).toEqual({});
    expect(resetOptionsForProvider("agy", { effort: sharedValue })).toEqual({
      effort: sharedValue,
    });
  });

  it("drops everything for a CLI with no registry entry", () => {
    expect(
      resetOptionsForProvider("not-a-registered-cli", { effort: "high" }),
    ).toEqual({});
  });
});
