import { z } from "zod";
import { isAgentProvider } from "@/lib/agent-config/constants";
import { MAX_TICKET_IMAGES } from "@/lib/uploads/image-attachments";
import { DESK_DISMISSAL_KINDS } from "@/lib/control-desk/aggregate";

// --- Project schemas ---

/**
 * Note what is *not* here: `cloneSource`.
 *
 * It is the flag that authorises Arij to delete a directory, so it is never
 * accepted from a request on either route. The create route derives it from the
 * clone marker on disk (`lib/git/clone-marker.ts`), and nothing can change it
 * afterwards — a value a client can set is a request, not provenance.
 */
export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(5000).nullish(),
  gitRepoPath: z.string().max(1000).nullish(),
  githubOwnerRepo: z.string().max(200).nullish(),
  gitRemoteUrl: z.string().max(1000).nullish(),
  defaultBranch: z.string().max(255).nullish(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  gitRepoPath: z.string().max(1000).nullish(),
  githubOwnerRepo: z.string().max(200).nullish(),
  defaultBranch: z.string().max(255).nullish(),
  status: z
    .enum(["ideation", "specifying", "building", "done", "archived"])
    .optional(),
  spec: z.string().nullish(),
});

export const importProjectSchema = z.object({
  path: z.string().min(1, "path is required"),
});

export const cloneProjectSchema = z.object({
  /** URL, SSH remote or `owner/repo` shorthand — parsed server-side. */
  url: z.string("url is required").min(1, "url is required").max(500),
  /**
   * Only set when re-cloning for a project that already exists, so the audit
   * row can be attributed to it. A first-time clone leaves it unset and is
   * logged as an unowned operation.
   */
  projectId: z.string().max(64).nullish(),
});

// --- Story field rules ---

/**
 * One set of caps for every path that writes a user story.
 *
 * Stories are created two ways — nested in `createEpicSchema` (manual form and
 * chat both post the whole epic at once) or on their own via
 * `/api/projects/:id/user-stories` — and edited through the story schemas
 * below. While the nested input was uncapped the create route accepted a title
 * the edit routes then refused, so the story landed in the database renamable
 * only to a shorter title. Same numbers on every path means anything this route
 * stores is something the edit routes still accept.
 */
const STORY_TITLE_MAX_LENGTH = 500;
const STORY_TEXT_MAX_LENGTH = 10000;

const STORY_TITLE_TOO_LONG = `User story title must be ${STORY_TITLE_MAX_LENGTH} characters or fewer`;
const STORY_DESCRIPTION_TOO_LONG = `User story description must be ${STORY_TEXT_MAX_LENGTH} characters or fewer`;
const STORY_CRITERIA_TOO_LONG = `User story acceptance criteria must be ${STORY_TEXT_MAX_LENGTH} characters or fewer`;

// --- Epic schemas ---

/**
 * Nested story for `createEpicSchema`. Every field is trimmed *before* it is
 * checked: `"   "` is a 400 for the whole request rather than a member the
 * route drops on its way to a `201` — a success status that persisted only part
 * of the array is data loss the caller never hears about — and the caps are
 * measured on the value that actually gets stored.
 */
const userStoryInput = z.object({
  title: z
    .string()
    .trim()
    .min(1, "User story title is required")
    .max(STORY_TITLE_MAX_LENGTH, STORY_TITLE_TOO_LONG),
  description: z.string().trim().max(STORY_TEXT_MAX_LENGTH, STORY_DESCRIPTION_TOO_LONG).nullish(),
  acceptanceCriteria: z
    .string()
    .trim()
    .max(STORY_TEXT_MAX_LENGTH, STORY_CRITERIA_TOO_LONG)
    .nullish(),
});

const dependencyInput = z.object({
  ticketId: z.string(),
  dependsOnTicketId: z.string(),
});

export const createEpicSchema = z.object({
  // Trimmed before both checks: `"   "` is not a title, and the caps are
  // measured on the value that actually gets stored — which is also what the
  // manual form measures client-side, so the two agree on the boundary.
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "review", "to_merge", "done"])
    .optional(),
  type: z.enum(["feature", "bug"]).optional(),
  branchName: z.string().max(300).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  evidence: z.string().max(10000).nullish(),
  linkedEpicId: z.string().nullish(),
  images: z.array(z.string()).nullish(),
  /**
   * Optional project-scoped friction converted by the ordinary epic creation
   * transaction. The route, not the client, validates that it is still open
   * and belongs to the project before linking it to the new ticket.
   */
  frictionId: z.string().min(1).max(64).optional(),
  userStories: z.array(userStoryInput).optional(),
  dependencies: z.array(dependencyInput).optional(),
});

/**
 * `POST /api/projects/:id/bugs`.
 *
 * A bug is an epic row (`type = 'bug'`), so the caps are the epic's caps —
 * anything this route stores has to stay editable through `updateEpicSchema`,
 * and a title that only one of the two accepts is a ticket nobody can rename.
 *
 * `images` is checked for *shape* here only. Whether a path is an upload this
 * project actually holds needs the database and the disk, so the route asks
 * `lookupServableUpload` — a JSON array of strings is the most a schema can
 * honestly promise.
 */
export const createBugSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  linkedEpicId: z.string().min(1).max(64).nullish(),
  images: z
    .array(z.string(), "images must be an array of upload paths")
    .max(
      MAX_TICKET_IMAGES,
      `A bug may carry at most ${MAX_TICKET_IMAGES} screenshots`
    )
    .nullish(),
});

export const updateEpicSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "review", "to_merge", "done"])
    .optional(),
  position: z.number().int().min(0).optional(),
  branchName: z.string().max(300).nullish(),
});

// --- Story schemas ---

export const createStorySchema = z.object({
  epicId: z.string().min(1, "epicId is required"),
  title: z.string().min(1, "title is required").max(STORY_TITLE_MAX_LENGTH),
  description: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  acceptanceCriteria: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
});

export const updateStorySchema = z.object({
  title: z.string().min(1).max(STORY_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  acceptanceCriteria: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
  position: z.number().int().min(0).optional(),
});

// Bulk story PATCH uses `id` in the body
export const updateStoryByIdSchema = z.object({
  id: z.string().min(1, "id is required"),
  title: z.string().min(1).max(STORY_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  acceptanceCriteria: z.string().max(STORY_TEXT_MAX_LENGTH).nullish(),
  status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
  position: z.number().int().min(0).optional(),
});

// --- Agent config schemas ---

export const createNamedAgentSchema = z.object({
  name: z
    .string("name is required")
    .refine((v) => v.trim().length > 0, "name is required"),
  provider: z
    .string("invalid provider")
    .refine((v) => isAgentProvider(v), "invalid provider"),
  // Optional: an empty/absent model means "use the CLI's default model".
  model: z.string().optional(),
  // Per-CLI options. Shape only here — which keys and values a given CLI
  // accepts is the registry's business (lib/providers/options-registry.ts),
  // and it produces the user-facing message.
  options: z.record(z.string(), z.unknown()).optional(),
  personaPrompt: z.string().nullable().optional(),
  escalatesTo: z.string().nullable().optional(),
});

export const updateNamedAgentSchema = z.object({
  name: z
    .string()
    .refine((v) => v.trim().length > 0, "name must be a non-empty string")
    .optional(),
  provider: z
    .string()
    .refine((v) => isAgentProvider(v), "invalid provider")
    .optional(),
  model: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  personaPrompt: z.string().nullable().optional(),
  escalatesTo: z.string().nullable().optional(),
});

export const createReviewAgentSchema = z.object({
  name: z
    .string("name is required")
    .refine((v) => v.trim().length > 0, "name is required"),
  systemPrompt: z
    .string("systemPrompt is required")
    .min(1, "systemPrompt is required"),
});

export const updateReviewAgentSchema = z.object({
  name: z.string().optional(),
  systemPrompt: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

export const updateAgentPromptSchema = z.object({
  systemPrompt: z.string("systemPrompt string is required"),
});

// --- QA schemas ---

export const createQaPromptSchema = z.object({
  name: z
    .string("Name and prompt are required")
    .refine((v) => v.trim().length > 0, "Name and prompt are required"),
  prompt: z
    .string("Name and prompt are required")
    .refine((v) => v.trim().length > 0, "Name and prompt are required"),
});

// --- Release schemas ---

export const createReleaseSchema = z.object({
  version: z.string("version is required").min(1, "version is required"),
  title: z.string().nullish(),
  epicIds: z
    .array(z.string(), "epicIds array is required")
    .min(1, "epicIds array is required"),
  generateChangelog: z.boolean().optional(),
  pushToGitHub: z.boolean().optional(),
  resumeSessionId: z.string().nullish(),
  namedAgentId: z.string().nullish(),
});

// --- Inbox schemas ---

export const markInboxReadSchema = z.object({
  epicId: z.string().min(1, "epicId is required"),
});

// --- Desk schemas ---

/**
 * Dismissing a "Your turn" signal.
 *
 * `signalAt` is the timestamp of the signal being waved off — the row's own
 * `askedAt` / `failedAt` / `at`, echoed back by the client. It is validated as
 * a PARSEABLE INSTANT rather than with `z.iso.datetime()`: the three families
 * read from different columns and the older ones store timestamps without a
 * trailing `Z`, which the strict ISO check rejects. Null is legitimate — a
 * session that never recorded an `ended_at` still produces a row the user must
 * be able to dismiss.
 */
export const dismissDeskSignalSchema = z.object({
  epicId: z.string().min(1, "epicId is required"),
  kind: z.enum(DESK_DISMISSAL_KINDS, "kind must be one of asks, failed, conflict"),
  signalAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "signalAt must be a valid timestamp")
    .nullable()
    .optional(),
});

// --- Sync schemas ---

export const syncProjectSchema = z.object({
  action: z.enum(["export", "import"], 'action must be "export" or "import"'),
});
