import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The checklist chips of LA RUBRIQUE — the bold headings of the feature-review
 * checklist the reviewers are actually handed, read from the real prompt
 * section rather than restated here.
 *
 * The trailing translucent chip counts the project's own enabled custom review
 * agents. It carries no check icon: those rules are not part of the shared
 * checklist, they are added on top of it.
 */
export interface RubricChipsProps {
  items: readonly string[];
  projectRuleCount: number;
  className?: string;
}

export function RubricChips({
  items,
  projectRuleCount,
  className,
}: RubricChipsProps) {
  return (
    <div className={cn("flex flex-wrap gap-[7px]", className)}>
      {items.map((item) => (
        <span
          key={item}
          data-testid="qa-rubric-chip"
          className="flex h-[27px] items-center gap-[6px] rounded-full bg-card px-[11px] font-sans text-[12px] font-medium text-foreground"
        >
          <Check
            size={11}
            aria-hidden="true"
            className="shrink-0 text-strata-live-deep"
          />
          {item}
        </span>
      ))}

      {projectRuleCount > 0 ? (
        <span
          data-testid="qa-rubric-project-rules"
          className="flex h-[27px] items-center rounded-full bg-card-translucent px-[11px] font-sans text-[12px] text-strata-next-mid"
        >
          {`+ ${projectRuleCount} règle${projectRuleCount === 1 ? "" : "s"} projet`}
        </span>
      ) : null}
    </div>
  );
}
