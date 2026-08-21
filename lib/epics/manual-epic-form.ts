/**
 * Draft model for the manual epic form (`EpicCreateDialog`).
 *
 * Kept free of React so the rules the dialog enforces before it fires a
 * request are unit-testable on their own, and so the payload it sends matches
 * `createEpicSchema` without the component having to know that schema.
 */

export interface ManualUserStoryDraft {
  /** Client-side key only — the server mints the persisted story id. */
  key: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
}

export interface ManualEpicDraft {
  title: string;
  description: string;
  userStories: ManualUserStoryDraft[];
}

export interface ManualEpicValidation {
  valid: boolean;
  /** Set when the epic title is missing or over length; `null` when it is fine. */
  titleError: string | null;
  /** Set when the description is over length; `null` when it is fine. */
  descriptionError: string | null;
  /** Keyed by `ManualUserStoryDraft.key` — only untitled stories appear. */
  storyErrors: Record<string, string>;
}

export interface ManualEpicPayload {
  title: string;
  description: string | null;
  status: "backlog";
  type: "feature";
  userStories: Array<{
    title: string;
    description: string | null;
    acceptanceCriteria: string | null;
  }>;
}

/**
 * Mirrors of the caps `createEpicSchema` enforces server-side, epic fields and
 * nested stories alike. They are copied rather than imported because
 * `lib/validation/schemas.ts` is server-route-only today and pulling it in
 * would drag every zod schema into the client bundle.
 * `manual-epic-form.test.ts` round-trips boundary values through the real
 * schema, so a change on either side fails a test rather than drifting.
 */
export const EPIC_TITLE_MAX_LENGTH = 200;
export const EPIC_DESCRIPTION_MAX_LENGTH = 10000;
export const STORY_TITLE_MAX_LENGTH = 500;
export const STORY_TEXT_MAX_LENGTH = 10000;

export const EPIC_TITLE_REQUIRED = "Title is required";
export const EPIC_TITLE_TOO_LONG = `Title must be ${EPIC_TITLE_MAX_LENGTH} characters or fewer`;
export const EPIC_DESCRIPTION_TOO_LONG = `Description must be ${EPIC_DESCRIPTION_MAX_LENGTH} characters or fewer`;
export const STORY_TITLE_REQUIRED = "User story title is required";
export const STORY_TITLE_TOO_LONG = `User story title must be ${STORY_TITLE_MAX_LENGTH} characters or fewer`;
export const STORY_DESCRIPTION_TOO_LONG = `User story description must be ${STORY_TEXT_MAX_LENGTH} characters or fewer`;
export const STORY_CRITERIA_TOO_LONG = `User story acceptance criteria must be ${STORY_TEXT_MAX_LENGTH} characters or fewer`;

export function createEmptyUserStory(key: string): ManualUserStoryDraft {
  return { key, title: "", description: "", acceptanceCriteria: "" };
}

export function createEmptyEpicDraft(): ManualEpicDraft {
  return { title: "", description: "", userStories: [] };
}

/**
 * First rule a story breaks, or `null` when it is fine.
 *
 * The dialog gives each story block a single error line, so the checks report
 * one message at a time — title first, since an untitled story is the one the
 * user is most likely mid-way through writing.
 *
 * The caps matter beyond this form: a story over them is one the create route
 * would store and the story edit routes would then refuse, leaving it
 * permanently un-renamable. Catching it here means the whole epic isn't
 * rejected server-side for a field the user can still fix in place.
 */
function validateStoryDraft(story: ManualUserStoryDraft): string | null {
  const title = story.title.trim();
  if (title.length === 0) return STORY_TITLE_REQUIRED;
  if (title.length > STORY_TITLE_MAX_LENGTH) return STORY_TITLE_TOO_LONG;
  if (story.description.trim().length > STORY_TEXT_MAX_LENGTH) {
    return STORY_DESCRIPTION_TOO_LONG;
  }
  if (story.acceptanceCriteria.trim().length > STORY_TEXT_MAX_LENGTH) {
    return STORY_CRITERIA_TOO_LONG;
  }
  return null;
}

/**
 * Epic title is required; every story the user chose to add must be titled and
 * within the caps the server enforces. Zero user stories is a valid epic — the
 * form is a faster path to a ticket, not a contract to fill in.
 */
export function validateManualEpicDraft(draft: ManualEpicDraft): ManualEpicValidation {
  // Lengths are measured on the trimmed values because that is exactly what
  // `buildManualEpicPayload` sends, so the client and the server agree on the
  // boundary instead of the server rejecting a draft the form called valid.
  const title = draft.title.trim();
  const titleError =
    title.length === 0
      ? EPIC_TITLE_REQUIRED
      : title.length > EPIC_TITLE_MAX_LENGTH
        ? EPIC_TITLE_TOO_LONG
        : null;

  const descriptionError =
    draft.description.trim().length > EPIC_DESCRIPTION_MAX_LENGTH
      ? EPIC_DESCRIPTION_TOO_LONG
      : null;

  const storyErrors: Record<string, string> = {};
  for (const story of draft.userStories) {
    const error = validateStoryDraft(story);
    if (error) storyErrors[story.key] = error;
  }

  return {
    valid:
      titleError === null &&
      descriptionError === null &&
      Object.keys(storyErrors).length === 0,
    titleError,
    descriptionError,
    storyErrors,
  };
}

/**
 * Turns an `{ error, details }` rejection into one readable line.
 *
 * `validateBody` answers a schema failure with a bare `error: "Validation
 * failed"` and puts the actionable part in `details`, so showing `error` alone
 * tells the user nothing about which field to fix.
 */
export function formatEpicCreateError(payload: unknown): string {
  const fallback = "Failed to create epic";
  if (!payload || typeof payload !== "object") return fallback;

  const { error, details } = payload as { error?: unknown; details?: unknown };
  const base =
    typeof error === "string" && error.trim().length > 0 ? error.trim() : fallback;

  if (!details || typeof details !== "object") return base;

  const fields = Object.entries(details as Record<string, unknown>)
    .map(([field, messages]) => {
      if (!Array.isArray(messages)) return null;
      const text = messages.filter((m): m is string => typeof m === "string").join(", ");
      return text.length > 0 ? `${field}: ${text}` : null;
    })
    .filter((part): part is string => part !== null);

  return fields.length > 0 ? `${base} — ${fields.join("; ")}` : base;
}

const trimmedOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Shapes a validated draft for `POST /api/projects/:projectId/epics`, which
 * creates the epic and its stories in one transaction — no orphan epic if a
 * story insert fails.
 */
export function buildManualEpicPayload(draft: ManualEpicDraft): ManualEpicPayload {
  return {
    title: draft.title.trim(),
    description: trimmedOrNull(draft.description),
    status: "backlog",
    type: "feature",
    userStories: draft.userStories.map((story) => ({
      title: story.title.trim(),
      description: trimmedOrNull(story.description),
      acceptanceCriteria: trimmedOrNull(story.acceptanceCriteria),
    })),
  };
}
