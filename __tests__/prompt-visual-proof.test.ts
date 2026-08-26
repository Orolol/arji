import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";
import {
  buildBuildPrompt,
  buildTicketBuildPrompt,
  VISUAL_PROOF_SECTION,
} from "@/lib/claude/prompt-builder";
import {
  isVisualProofEnabled,
  parseVisualProofEnabledSetting,
} from "@/lib/claude/visual-proof";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const project = { name: "UI project" };
const epic = { title: "Settings", type: "feature" };
const story = { title: "Save preferences" };

describe("visual proof build prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("adds explicit best-effort instructions to epic and story builds when enabled", () => {
    const options = { visualProofEnabled: true };
    const epicPrompt = buildBuildPrompt(
      project,
      [],
      epic,
      [story],
      undefined,
      undefined,
      options
    );
    const storyPrompt = buildTicketBuildPrompt(
      project,
      [],
      epic,
      story,
      [],
      undefined,
      options
    );

    for (const prompt of [epicPrompt, storyPrompt]) {
      expect(prompt).toContain(VISUAL_PROOF_SECTION);
      expect(prompt).toContain("capture 1 to 3 screenshots");
      expect(prompt).toContain("attach_artifact");
      expect(prompt).toContain("never a completion requirement");
      expect(prompt).toContain("Missing visual proof must never make the build fail");
    }
  });

  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
    ['"true"', true],
    ['"false"', false],
    [undefined, null],
    ["not-a-boolean", null],
  ])("parses tri-state setting value %j", (raw, expected) => {
    expect(parseVisualProofEnabledSetting(raw)).toBe(expected);
  });

  it("resolves the absent setting to the built-in OFF default", () => {
    expect(isVisualProofEnabled()).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["invalid", false],
  ])("resolves stored setting value %j to %j", (value, expected) => {
    dbMockState.getQueue = [{ value }];

    expect(isVisualProofEnabled()).toBe(expected);
  });
});
