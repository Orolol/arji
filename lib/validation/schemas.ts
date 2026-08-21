import { z } from "zod";
import { isAgentProvider } from "@/lib/agent-config/constants";

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

// --- Epic schemas ---

const userStoryInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  acceptanceCriteria: z.string().nullish(),
});

const dependencyInput = z.object({
  ticketId: z.string(),
  dependsOnTicketId: z.string(),
});

export const createEpicSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "review", "done"])
    .optional(),
  type: z.enum(["feature", "bug"]).optional(),
  branchName: z.string().max(300).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  evidence: z.string().max(10000).nullish(),
  linkedEpicId: z.string().nullish(),
  images: z.array(z.string()).nullish(),
  userStories: z.array(userStoryInput).optional(),
  dependencies: z.array(dependencyInput).optional(),
});

export const updateEpicSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10000).nullish(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "review", "done"])
    .optional(),
  position: z.number().int().min(0).optional(),
  branchName: z.string().max(300).nullish(),
});

// --- Story schemas ---

export const createStorySchema = z.object({
  epicId: z.string().min(1, "epicId is required"),
  title: z.string().min(1, "title is required").max(500),
  description: z.string().max(10000).nullish(),
  acceptanceCriteria: z.string().max(10000).nullish(),
  status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
});

export const updateStorySchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  acceptanceCriteria: z.string().max(10000).nullish(),
  status: z.enum(["todo", "in_progress", "review", "done"]).optional(),
  position: z.number().int().min(0).optional(),
});

// Bulk story PATCH uses `id` in the body
export const updateStoryByIdSchema = z.object({
  id: z.string().min(1, "id is required"),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  acceptanceCriteria: z.string().max(10000).nullish(),
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

// --- Sync schemas ---

export const syncProjectSchema = z.object({
  action: z.enum(["export", "import"], 'action must be "export" or "import"'),
});
