/** Shared refinement choices and the tools each choice authorizes. */
import { z } from "zod";

export const REFINEMENT_INSTRUCTIONS_MAX_CHARS = 4000;
export const REFINEMENT_ACTION_IDS = [
  "grooming", "dependencies", "ordering", "priorities", "readiness",
  "merge", "discard", "create",
] as const;
export type RefinementAction = (typeof REFINEMENT_ACTION_IDS)[number];

export const REFINEMENT_ACTIONS: ReadonlyArray<{
  id: RefinementAction;
  label: string;
  description: string;
  tools: readonly string[];
}> = [
  {
    id: "grooming",
    label: "Ticket grooming",
    description:
      "Identify unclear scope, missing criteria and unanswered questions in comments.",
    tools: ["post_comment"],
  },
  {
    id: "dependencies",
    label: "Dependencies",
    description:
      "Add missing dependencies and remove obsolete ones.",
    tools: ["add_dependency", "remove_dependency"],
  },
  {
    id: "ordering",
    label: "Execution order",
    description:
      "Reorder tickets within their planning column.",
    tools: ["reorder_tickets"],
  },
  {
    id: "priorities",
    label: "Priorities and deprioritization",
    description:
      "Raise or lower ticket priorities.",
    tools: ["set_priority"],
  },
  {
    id: "readiness",
    label: "Readiness and column moves",
    description:
      "Promote ready tickets to To do; return unclear tickets to Backlog with a question.",
    tools: ["promote_ticket"],
  },
  {
    id: "merge",
    label: "Merge tickets",
    description:
      "Combine related tickets; absorbed tickets are permanently deleted.",
    tools: ["merge_tickets"],
  },
  {
    id: "discard",
    label: "Discard obsolete tickets",
    description:
      "Permanently delete obsolete tickets. There is no undo.",
    tools: ["discard_ticket"],
  },
  {
    id: "create",
    label: "Create missing tickets",
    description:
      "Create planning tickets with acceptance criteria, or file adjacent bugs.",
    tools: ["create_planning_ticket", "create_bug"],
  },
];

// Missing options preserve the existing complete re-pass API contract.
export const refinementOptionsSchema = z.object({
  namedAgentId: z.string().trim().min(1).nullish(),
  instructions: z.string().trim().max(REFINEMENT_INSTRUCTIONS_MAX_CHARS).optional(),
  actions: z.array(z.enum(REFINEMENT_ACTION_IDS)).min(1).max(REFINEMENT_ACTION_IDS.length)
    .refine((items) => new Set(items).size === items.length, "Actions must be unique")
    .optional(),
}).strict();
export type RefinementOptions = z.infer<typeof refinementOptionsSchema>;

export function refinementToolAllowed(
  actions: readonly RefinementAction[],
  tool: string,
): boolean {
  // Only action-owned tools are restricted here. Auxiliary tools (including
  // attach_artifact) retain their existing route-level role/scope guards.
  const owner = REFINEMENT_ACTIONS.find((action) => action.tools.includes(tool));
  return !owner || actions.includes(owner.id);
}

/** Invalid persisted configuration fails closed; NULL denotes legacy full passes. */
export function parseRefinementActions(raw: string | null): readonly RefinementAction[] {
  if (raw === null) return REFINEMENT_ACTION_IDS;
  try {
    const parsed = refinementOptionsSchema.safeParse({ actions: JSON.parse(raw) });
    return parsed.success ? parsed.data.actions ?? [] : [];
  } catch {
    return [];
  }
}
