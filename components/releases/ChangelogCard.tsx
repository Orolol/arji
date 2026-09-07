import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { FieldKicker, Mono, SurfaceCard } from "@/components/piscine";

export interface ChangelogCardProps {
  /** Already uppercase — the kicker adds no text-transform of its own. */
  caption: string;
  /** Right-aligned slot of the header row. */
  right?: ReactNode;
  markdown: string | null;
}

const HEADING = /^#{1,6}\s/;
const TOP_HEADING = /^#\s/;

/**
 * The white CHANGELOG card of the NEXT RELEASE band.
 *
 * The body renders the changelog SOURCE as mono lines, not rendered markdown:
 * the frame draws the raw `#` / `##` / `- ` source and that is the intent — a
 * changelog is a text artefact here, not a document.
 *
 * READ-ONLY, deliberately. `createReleaseSchema` has no `changelog` field and
 * `app/api/projects/[projectId]/releases/[releaseId]/` holds only
 * `publish/route.ts` — there is no PATCH, so a textarea would silently discard
 * whatever the user typed. The frame's caption ("CHANGELOG — généré, éditable")
 * returns verbatim the day a PATCH route lands.
 */
export function ChangelogCard({ caption, right, markdown }: ChangelogCardProps) {
  const t = useTranslations("Releases");
  const empty = markdown === null || markdown.trim() === "";

  // Everything after a heading whose text mentions "notes" is dimmed, the way
  // the frame dims its trailing ### Notes bullets.
  let notesSeen = false;
  const lines = empty
    ? []
    : markdown.split("\n").map((line, index) => {
        if (line === "") {
          // The 1.6 line-height supplies the gap; an empty block would collapse.
          return <span key={index} aria-hidden="true" className="block h-[1.6em]" />;
        }
        const dim = notesSeen;
        const isHeading = HEADING.test(line);
        if (isHeading && /notes/i.test(line)) notesSeen = true;
        return (
          <span
            key={index}
            className={`block ${TOP_HEADING.test(line) ? "font-bold" : "font-normal"} ${
              dim ? "text-muted-foreground" : "text-foreground"
            }`}
          >
            {line}
          </span>
        );
      });

  return (
    <SurfaceCard
      radius={11}
      className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-hidden px-[16px] py-[13px]"
    >
      <div className="flex items-baseline gap-[10px]">
        <FieldKicker stratum="land" size={10}>
          {caption}
        </FieldKicker>
        {right ? <span className="ml-auto">{right}</span> : null}
      </div>

      <div
        data-testid="release-changelog"
        className="min-h-0 overflow-y-auto font-mono text-[11.5px] leading-[1.6] tabular-nums break-words whitespace-pre-wrap"
      >
        {empty ? (
          <Mono size={11} tone="muted">
            {t("changelogCard.empty")}
          </Mono>
        ) : (
          lines
        )}
      </div>
    </SurfaceCard>
  );
}
