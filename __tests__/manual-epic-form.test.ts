import { describe, expect, it } from "vitest";
import {
  EPIC_DESCRIPTION_MAX_LENGTH,
  EPIC_DESCRIPTION_TOO_LONG,
  EPIC_TITLE_MAX_LENGTH,
  EPIC_TITLE_REQUIRED,
  EPIC_TITLE_TOO_LONG,
  STORY_CRITERIA_TOO_LONG,
  STORY_DESCRIPTION_TOO_LONG,
  STORY_TEXT_MAX_LENGTH,
  STORY_TITLE_MAX_LENGTH,
  STORY_TITLE_REQUIRED,
  STORY_TITLE_TOO_LONG,
  buildManualEpicPayload,
  createEmptyEpicDraft,
  createEmptyUserStory,
  formatEpicCreateError,
  validateManualEpicDraft,
  type ManualEpicDraft,
  type ManualUserStoryDraft,
} from "@/lib/epics/manual-epic-form";
import { createEpicSchema } from "@/lib/validation/schemas";

function draftWith(overrides: Partial<ManualEpicDraft> = {}): ManualEpicDraft {
  return { ...createEmptyEpicDraft(), ...overrides };
}

describe("validateManualEpicDraft", () => {
  it("requires a non-blank epic title", () => {
    const blank = validateManualEpicDraft(draftWith({ title: "   " }));
    expect(blank.valid).toBe(false);
    expect(blank.titleError).toBe(EPIC_TITLE_REQUIRED);

    const filled = validateManualEpicDraft(draftWith({ title: "Ship it" }));
    expect(filled.valid).toBe(true);
    expect(filled.titleError).toBeNull();
  });

  it("accepts an epic with zero user stories", () => {
    const result = validateManualEpicDraft(draftWith({ title: "Ship it" }));
    expect(result.valid).toBe(true);
    expect(result.storyErrors).toEqual({});
  });

  it("rejects an added user story left untitled", () => {
    const result = validateManualEpicDraft(
      draftWith({
        title: "Ship it",
        userStories: [
          { ...createEmptyUserStory("a"), title: "Story A" },
          { ...createEmptyUserStory("b"), description: "no title" },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.storyErrors).toEqual({ b: STORY_TITLE_REQUIRED });
  });

  it("rejects a title past the cap the server enforces", () => {
    const atMax = "x".repeat(EPIC_TITLE_MAX_LENGTH);

    expect(validateManualEpicDraft(draftWith({ title: atMax })).valid).toBe(true);

    // Measured after trimming, because that is what the payload actually sends.
    const overByOne = validateManualEpicDraft(draftWith({ title: `  ${atMax}x  ` }));
    expect(overByOne.valid).toBe(false);
    expect(overByOne.titleError).toBe(EPIC_TITLE_TOO_LONG);
  });

  it("rejects a description past the cap the server enforces", () => {
    const atMax = "d".repeat(EPIC_DESCRIPTION_MAX_LENGTH);

    expect(
      validateManualEpicDraft(draftWith({ title: "Ship it", description: atMax })).valid,
    ).toBe(true);

    const tooLong = validateManualEpicDraft(
      draftWith({ title: "Ship it", description: `${atMax}d` }),
    );
    expect(tooLong.valid).toBe(false);
    expect(tooLong.descriptionError).toBe(EPIC_DESCRIPTION_TOO_LONG);
    expect(tooLong.titleError).toBeNull();
  });

  it("rejects a story title past the cap the server enforces", () => {
    const atMax = "s".repeat(STORY_TITLE_MAX_LENGTH);
    const draftWithStoryTitle = (title: string) =>
      validateManualEpicDraft(
        draftWith({
          title: "Ship it",
          userStories: [{ ...createEmptyUserStory("a"), title }],
        }),
      );

    expect(draftWithStoryTitle(atMax).valid).toBe(true);

    // Trimmed before measuring, because that is what the payload sends.
    const overByOne = draftWithStoryTitle(`  ${atMax}s  `);
    expect(overByOne.valid).toBe(false);
    expect(overByOne.storyErrors.a).toBe(STORY_TITLE_TOO_LONG);
  });

  it("rejects story prose past the caps the server enforces", () => {
    const atMax = "d".repeat(STORY_TEXT_MAX_LENGTH);
    const storyDraft = (fields: Partial<ManualUserStoryDraft>) =>
      validateManualEpicDraft(
        draftWith({
          title: "Ship it",
          userStories: [
            { ...createEmptyUserStory("a"), title: "As a user, I want it", ...fields },
          ],
        }),
      );

    expect(storyDraft({ description: atMax }).valid).toBe(true);
    expect(storyDraft({ description: `${atMax}d` }).storyErrors.a).toBe(
      STORY_DESCRIPTION_TOO_LONG,
    );

    expect(storyDraft({ acceptanceCriteria: atMax }).valid).toBe(true);
    expect(storyDraft({ acceptanceCriteria: `${atMax}d` }).storyErrors.a).toBe(
      STORY_CRITERIA_TOO_LONG,
    );
  });

  it("reports the missing story title before its length problems", () => {
    // One error line per story block, so an untitled story names the field the
    // user still has to fill rather than one they can fix later.
    const result = validateManualEpicDraft(
      draftWith({
        title: "Ship it",
        userStories: [
          {
            ...createEmptyUserStory("a"),
            title: "  ",
            description: "d".repeat(STORY_TEXT_MAX_LENGTH + 1),
          },
        ],
      }),
    );

    expect(result.storyErrors.a).toBe(STORY_TITLE_REQUIRED);
  });

  /**
   * The caps are copied into the client-safe helper rather than imported, so
   * this asserts the copies still match what the route really rejects. Drift in
   * either direction fails here instead of surfacing as a 400 the form swore
   * could not happen.
   */
  it("pins its length caps to the ones createEpicSchema enforces", () => {
    const titleAtMax = "x".repeat(EPIC_TITLE_MAX_LENGTH);
    expect(createEpicSchema.safeParse({ title: titleAtMax }).success).toBe(true);
    expect(createEpicSchema.safeParse({ title: `${titleAtMax}x` }).success).toBe(false);

    const descriptionAtMax = "d".repeat(EPIC_DESCRIPTION_MAX_LENGTH);
    expect(
      createEpicSchema.safeParse({ title: "ok", description: descriptionAtMax }).success,
    ).toBe(true);
    expect(
      createEpicSchema.safeParse({ title: "ok", description: `${descriptionAtMax}d` })
        .success,
    ).toBe(false);

    const storyTitleAtMax = "s".repeat(STORY_TITLE_MAX_LENGTH);
    const storyProseAtMax = "p".repeat(STORY_TEXT_MAX_LENGTH);
    const epicWithStory = (story: Record<string, unknown>) =>
      createEpicSchema.safeParse({ title: "ok", userStories: [story] }).success;

    expect(epicWithStory({ title: storyTitleAtMax })).toBe(true);
    expect(epicWithStory({ title: `${storyTitleAtMax}s` })).toBe(false);
    expect(epicWithStory({ title: "ok", description: storyProseAtMax })).toBe(true);
    expect(epicWithStory({ title: "ok", description: `${storyProseAtMax}p` })).toBe(false);
    expect(epicWithStory({ title: "ok", acceptanceCriteria: storyProseAtMax })).toBe(true);
    expect(epicWithStory({ title: "ok", acceptanceCriteria: `${storyProseAtMax}p` })).toBe(
      false,
    );
  });

  /**
   * The form is the only thing between the user and a 400 that would reject the
   * whole epic — including the stories that were fine. A draft it calls valid
   * has to be one the route accepts, boundary values included.
   */
  it("hands the route a payload it accepts at every cap", () => {
    const draft = draftWith({
      title: "x".repeat(EPIC_TITLE_MAX_LENGTH),
      description: "d".repeat(EPIC_DESCRIPTION_MAX_LENGTH),
      userStories: [
        {
          key: "a",
          title: "s".repeat(STORY_TITLE_MAX_LENGTH),
          description: "p".repeat(STORY_TEXT_MAX_LENGTH),
          acceptanceCriteria: "c".repeat(STORY_TEXT_MAX_LENGTH),
        },
      ],
    });

    expect(validateManualEpicDraft(draft).valid).toBe(true);
    expect(createEpicSchema.safeParse(buildManualEpicPayload(draft)).success).toBe(true);
  });

  it("reports the epic title and story errors together", () => {
    const result = validateManualEpicDraft(
      draftWith({
        title: "",
        userStories: [createEmptyUserStory("a")],
      }),
    );

    expect(result.titleError).toBe(EPIC_TITLE_REQUIRED);
    expect(result.storyErrors.a).toBe(STORY_TITLE_REQUIRED);
  });
});

describe("formatEpicCreateError", () => {
  it("appends the field details a bare 'Validation failed' hides", () => {
    const message = formatEpicCreateError({
      error: "Validation failed",
      details: { title: ["Too big: expected string to have <=200 characters"] },
    });

    expect(message).toBe(
      "Validation failed — title: Too big: expected string to have <=200 characters",
    );
  });

  it("joins several offending fields", () => {
    const message = formatEpicCreateError({
      error: "Validation failed",
      details: { title: ["Too big"], description: ["Too big", "Also bad"] },
    });

    expect(message).toBe("Validation failed — title: Too big; description: Too big, Also bad");
  });

  it("passes a plain error through untouched", () => {
    expect(formatEpicCreateError({ error: "Project not found" })).toBe("Project not found");
  });

  it("falls back when the body carries nothing usable", () => {
    const fallback = "Failed to create epic";
    expect(formatEpicCreateError({})).toBe(fallback);
    expect(formatEpicCreateError(null)).toBe(fallback);
    expect(formatEpicCreateError("boom")).toBe(fallback);
    expect(formatEpicCreateError({ error: "   " })).toBe(fallback);
    // Empty or malformed details must not leave a dangling separator.
    expect(formatEpicCreateError({ error: "Validation failed", details: {} })).toBe(
      "Validation failed",
    );
    expect(
      formatEpicCreateError({ error: "Validation failed", details: { title: "nope" } }),
    ).toBe("Validation failed");
  });
});

describe("buildManualEpicPayload", () => {
  it("trims text and drops empty optional fields to null", () => {
    const payload = buildManualEpicPayload(
      draftWith({
        title: "  Direct epic  ",
        description: "   ",
        userStories: [
          {
            key: "a",
            title: "  As a user...  ",
            description: "  why  ",
            acceptanceCriteria: "   ",
          },
        ],
      }),
    );

    expect(payload.title).toBe("Direct epic");
    expect(payload.description).toBeNull();
    expect(payload.userStories).toEqual([
      { title: "As a user...", description: "why", acceptanceCriteria: null },
    ]);
  });

  it("lands the epic in the backlog as a feature, like every other new ticket", () => {
    const payload = buildManualEpicPayload(draftWith({ title: "Direct epic" }));

    expect(payload.status).toBe("backlog");
    expect(payload.type).toBe("feature");
    expect(payload.userStories).toEqual([]);
  });

  it("preserves the order stories were added in", () => {
    const payload = buildManualEpicPayload(
      draftWith({
        title: "Direct epic",
        userStories: [
          { ...createEmptyUserStory("a"), title: "First" },
          { ...createEmptyUserStory("b"), title: "Second" },
          { ...createEmptyUserStory("c"), title: "Third" },
        ],
      }),
    );

    expect(payload.userStories.map((story) => story.title)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});
