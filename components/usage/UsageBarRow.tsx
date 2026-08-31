import { Mono, PROJECT, RatioBar, type ProjectTone } from "@/components/piscine";
import { cn } from "@/lib/utils";
import { formatCostUsd } from "@/lib/utils/format-usage";
import { resolveProjectTone } from "@/components/usage/formatters";
import type { UsageBar, UsageProjectBar } from "@/lib/types/usage";

/**
 * One `name · track · amount` line inside BY AGENT or BY PROJECT (frame 8d).
 *
 * The row is the same shape in both bands; only the colours differ:
 *   BY AGENT   — ink name, turquoise `--strata-live-bar` fill for every row.
 *   BY PROJECT — the project's identity deep for the name, its mid for the
 *                fill. Colour = WHO, never state.
 *
 * A row whose `sharePercent` is null draws the track with NO fill and an
 * em-dash amount: the group never reported a cost, and a 0%-wide bar would
 * claim it was free. A real but tiny share floors at 1% so a genuine spender
 * never becomes invisible.
 */
interface RowProps {
  label: string;
  costUsd: number | null;
  sharePercent: number | null;
  fillColor: string;
  nameClassName?: string;
  testId: string;
}

function Row({
  label,
  costUsd,
  sharePercent,
  fillColor,
  nameClassName,
  testId,
}: RowProps) {
  const segments =
    sharePercent === null
      ? []
      : [{ percent: Math.max(1, sharePercent), color: fillColor }];

  return (
    <div
      className="flex items-center gap-[10px] text-[12.5px]"
      data-testid={testId}
    >
      <span
        className={cn(
          "w-[96px] shrink-0 truncate font-sans font-semibold",
          nameClassName,
        )}
        title={label}
      >
        {label}
      </span>
      <RatioBar segments={segments} height={16} track="card" width="flex" />
      <Mono size={11} className="min-w-[44px] shrink-0 text-right">
        {formatCostUsd(costUsd) ?? "—"}
      </Mono>
    </div>
  );
}

export interface AgentBarRowProps {
  bar: UsageBar;
  index: number;
  /**
   * The frame dims the FOURTH agent name. No rule was specified, so the
   * shipped one is the simple defensible reading: the smallest spender is
   * de-emphasised once the band is full, i.e. the last row of a band of four
   * or more.
   */
  dimmed: boolean;
}

export function AgentBarRow({ bar, index, dimmed }: AgentBarRowProps) {
  return (
    <Row
      label={bar.label}
      costUsd={bar.costUsd}
      sharePercent={bar.sharePercent}
      fillColor="var(--strata-live-bar)"
      nameClassName={dimmed ? "text-strata-live-mid" : "text-foreground"}
      testId={`usage-agent-row-${index}`}
    />
  );
}

/** Static per-tone class names: Tailwind cannot see an interpolated one. */
const PROJECT_NAME_CLASS: Record<ProjectTone, string> = {
  1: "text-project-1-deep",
  2: "text-project-2-deep",
  3: "text-project-3-deep",
  4: "text-project-4-deep",
};

export function ProjectBarRow({ bar }: { bar: UsageProjectBar }) {
  const tone = resolveProjectTone(bar.colorIndex, bar.projectId);

  return (
    <Row
      label={bar.label}
      costUsd={bar.costUsd}
      sharePercent={bar.sharePercent}
      fillColor={PROJECT[tone].mid}
      nameClassName={PROJECT_NAME_CLASS[tone]}
      testId={`usage-project-${bar.projectId || "none"}`}
    />
  );
}
