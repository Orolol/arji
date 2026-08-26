import type { Friction } from "@/lib/db/schema";
import type { FrictionCategory, FrictionStatus } from "./constants";
import type { ManualEpicDraft } from "@/lib/epics/manual-epic-form";

export const FRICTION_CATEGORY_LABELS: Record<FrictionCategory, string> = {
  broken_tooling: "Broken tooling",
  misleading_docs: "Misleading docs",
  flaky_test: "Flaky test",
  unclear_convention: "Unclear convention",
  other: "Other",
};

export const FRICTION_STATUS_LABELS: Record<FrictionStatus, string> = {
  new: "New",
  triaged: "Triaged",
  converted: "Converted",
  dismissed: "Dismissed",
};

/** A useful editable starting point, bounded by the epic title limit. */
export function frictionToEpicDraft(
  friction: Pick<Friction, "category" | "description" | "filePath" | "occurrences">,
): ManualEpicDraft {
  const subject = friction.filePath
    ? `${FRICTION_CATEGORY_LABELS[friction.category]}: ${friction.filePath}`
    : `${FRICTION_CATEGORY_LABELS[friction.category]} friction`;
  const title = subject.length <= 200 ? subject : `${subject.slice(0, 197)}...`;
  const location = friction.filePath ? `\n\nFile: \`${friction.filePath}\`` : "";
  const recurrence = `\n\nReported ${friction.occurrences} ${
    friction.occurrences === 1 ? "time" : "times"
  } by coding agents.`;

  return {
    title,
    description: `${friction.description}${location}${recurrence}`,
    userStories: [],
  };
}
