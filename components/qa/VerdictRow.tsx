"use client";

import { Check, ShieldAlert } from "lucide-react";

import { IdentityChip, Mono, SurfaceCard, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaVerdict } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

/**
 * One line of VERDICTS RÉCENTS: what the last review on this ticket concluded,
 * and where the ticket went.
 *
 * THE ONE PLACE ON THIS SCREEN A COLOUR LEANS ON STATE, and it is allowed
 * because the arrow names a DESTINATION STRATUM rather than a status: "→ your
 * turn" is drawn in the coral deep because coral is where the ticket went. The
 * other two arrows are muted; the verdict itself is told by an icon and a word,
 * never by a colour.
 *
 * BELOW `sm` THE ROW FOLDS — B-arij-S3gpcD1w-ZEB. The desk grammar above is one
 * flex line whose icon, id chip and outcome are each `shrink-0`, with only the
 * verdict text able to give way. The chip is the problem: a readable id is
 * `E-<slug≤20>-NNN`, up to 26 characters, and Space Mono draws that at 173px —
 * against an outcome of 71px on a 230px content line at 320px. MEASURED IN
 * CHROME on the unfixed row (2026-09-06, `/qa`, one seeded verdict, a
 * 26-character readable id), verdict text width by viewport:
 *
 *     320px   0.0px   band scrollWidth 318 vs clientWidth 292 — the defect
 *     360px   0.0px   no band overflow, and no verdict text either
 *     390px  12.7px
 *     414px  36.7px
 *     640px 262.7px   readable
 *     768px 390.7px
 *    1024px 142.7px   (the bottom split is two columns from `lg`)
 *
 * So 320px was where the row stopped fitting, but the row stopped being
 * READABLE one breakpoint earlier: the whole phone band drew a ticket id, an
 * arrow, and nothing of what the review actually concluded. Both are the same
 * arithmetic, and the fold fixes both.
 *
 * The fold is two lines, in the frame's own reading order:
 *
 *     [✓] [E-e2e-keeps-every-band-001]
 *     changes requested · 0 findings        → your turn
 *
 * `lg:` is deliberately NOT the breakpoint here — `sm` is. From 640px up the
 * text has 262px and the frame's single line is the right drawing; below it
 * there is nothing to preserve. DOM order never changes, and `sm:contents`
 * dissolves the fold group so that from 640px up the row is the four flex
 * items it always was, to the pixel.
 */
export interface VerdictRowProps {
  verdict: QaVerdict;
  project: DeskProject | undefined;
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

export function VerdictRow({
  verdict,
  project,
  onOpenTicket,
  className,
}: VerdictRowProps) {
  const Icon = verdict.kind === "clean" ? Check : ShieldAlert;

  return (
    <SurfaceCard
      radius={10}
      interactive={Boolean(onOpenTicket)}
      onClick={() => onOpenTicket?.(verdict.epicId)}
      data-testid="qa-verdict-row"
      data-kind={verdict.kind}
      className={cn(
        "flex flex-wrap items-center gap-x-[10px] gap-y-[4px] px-[12px] py-[8px]",
        "sm:flex-nowrap",
        className,
      )}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className={cn(
          "shrink-0",
          verdict.kind === "clean"
            ? "text-strata-live-deep"
            : "text-strata-you-deep",
        )}
      />
      <IdentityChip
        label={verdict.readableId ?? project?.shortName ?? "—"}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
      />
      {/* `basis-full` is what drops the verdict onto its own line: the chip is
          173px of unshrinkable mono, so anything sharing its line at 320px is
          either crushed to zero or laid out past the band's edge. The two stay
          TOGETHER on that line — the outcome is the end of the sentence the
          verdict text starts, not a third row — and `min-w-0` is what lets the
          text clamp instead of pushing the outcome out in turn.

          `sm:contents` removes this wrapper from the layout entirely, so from
          640px up the row is `icon · chip · text · outcome` as four direct flex
          items with the row's own 10px gap. Not `sm:flex`: an extra flex level
          would give the text a second container to grow inside and change the
          desktop line the frames draw. */}
      <div
        data-testid="qa-verdict-line"
        className="flex min-w-0 basis-full items-center gap-[10px] sm:contents"
      >
        <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[12.5px] text-foreground">
          {verdict.verdictText}
        </span>
        <Mono
          size={10}
          tone={verdict.outcome === "→ your turn" ? "you-deep" : "muted"}
          className="shrink-0"
        >
          {verdict.outcome}
        </Mono>
      </div>
    </SurfaceCard>
  );
}
