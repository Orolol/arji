"use client";

import { useLocale } from "next-intl";
import Link from "next/link";

import {
  BreathingDot,
  IdentityChip,
  Mono,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaCheck } from "@/lib/qa/types";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/i18n/format";

/**
 * One line of QA CHECKS: a tech check, an E2E pass or a failure digest.
 *
 * A REAL ANCHOR, not an `onClick` row. The report itself is a whole markdown
 * document with its own "create epics from findings" actions, and it is drawn
 * by `/projects/:id/qa` — a different screen, not an overlay this one owns. A
 * link is what that is: middle-clickable, copyable, and reachable by keyboard
 * without this row re-implementing Enter/Space.
 *
 * `?reportId=` is the deep link that page already consumes (it selects the
 * report once and then strips the parameter — see its own header).
 *
 * NO STATE COLOUR. `running` is told by the breathing dot and the word, the way
 * every other live thing in the Piscine is; a failed check is told by the word
 * `failed`. The only colour on the row is the project's identity chip.
 *
 * THE WORD AND THE DOT CANNOT DISAGREE. `check.status` is not the raw column —
 * a report stranded on `running` behind a finished session reads `interrupted`
 * and draws no dot (see `checkStatusLabel`), so the row never breathes beside a
 * check that stopped hours ago.
 */
export interface QaCheckRowProps {
  check: QaCheck;
  project: DeskProject | undefined;
  className?: string;
}

export function QaCheckRow({ check, project, className }: QaCheckRowProps) {
  const locale = useLocale();
  /**
   * A check with no summary yet has genuinely nothing to say — an em-dash,
   * never an invented sentence.
   *
   * A LIVE one says nothing at all here, deliberately: the breathing dot and
   * the word `running` beside it already carry that state, and a second
   * "En cours…" in the summary slot printed the same fact twice, in two
   * languages, on one row.
   */
  const line = check.summary?.trim() || (check.live ? "" : "—");

  return (
    <Link
      href={`/projects/${check.projectId}/qa?reportId=${check.reportId}`}
      data-testid="qa-check-row"
      data-status={check.status}
      className={cn(
        "block rounded-[10px] outline-none",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <SurfaceCard
        radius={10}
        interactive
        className="flex items-center gap-[10px] px-[12px] py-[8px]"
      >
        <IdentityChip
          label={project?.shortName ?? "—"}
          tone={projectTone(project?.colorIndex ?? 0)}
          size="sm"
        />
        {/* `Mono` takes no arbitrary DOM props, so the check type is read
            through its text rather than through an attribute on it. */}
        <Mono size={10} weight={700} tone="feed-deep" className="shrink-0">
          {check.checkLabel}
        </Mono>
        <span className="flex shrink-0 items-center gap-1.5">
          {check.live ? <BreathingDot size={6} /> : null}
          <Mono size={10} tone="muted">
            {check.status}
          </Mono>
        </span>
        <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[12.5px] text-foreground">
          {line}
        </span>
        <Mono size={10} tone="muted" className="shrink-0">
          {formatRelative(check.createdAt, { locale })}
        </Mono>
      </SurfaceCard>
    </Link>
  );
}
