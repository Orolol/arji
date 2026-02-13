import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderSelect, type ProviderType } from "@/components/shared/ProviderSelect";

describe("ProviderSelect", () => {
  it("renders with claude-code as default value", () => {
    const onChange = vi.fn();
    render(
      <ProviderSelect
        value="claude-code"
        onChange={onChange}
        codexAvailable={true}
      />
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("renders with codex value", () => {
    const onChange = vi.fn();
    render(
      <ProviderSelect
        value="codex"
        onChange={onChange}
        codexAvailable={true}
      />
    );
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("renders with gemini-cli value", () => {
    const onChange = vi.fn();
    render(
      <ProviderSelect
        value="gemini-cli"
        onChange={onChange}
        codexAvailable={true}
      />
    );
    expect(screen.getByText("Gemini CLI")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ProviderSelect
        value="claude-code"
        onChange={onChange}
        codexAvailable={true}
        className="w-48 h-10 text-sm"
      />
    );
    const trigger = container.querySelector("button");
    expect(trigger?.className).toContain("w-48");
  });

  it("is disabled when disabled prop is true", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ProviderSelect
        value="claude-code"
        onChange={onChange}
        codexAvailable={true}
        disabled={true}
      />
    );
    const trigger = container.querySelector("button");
    expect(trigger).toBeDisabled();
  });

  it("exports ProviderType type correctly", () => {
    const value: ProviderType = "claude-code";
    expect(value).toBe("claude-code");
    const codex: ProviderType = "codex";
    expect(codex).toBe("codex");
    const gemini: ProviderType = "gemini-cli";
    expect(gemini).toBe("gemini-cli");
  });
});
