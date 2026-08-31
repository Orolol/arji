"use client";

/**
 * USER STORIES on the pool ground (frame 6a, lines 221-247).
 *
 * The discs have no `onToggle` and there is no add field — story editing lives
 * on the story surface, not in the ticket overlay. That surface is
 * `/projects/:projectId/stories/:storyId`, and the row's trailing QuietLink is
 * the only door to it anywhere in the app, so it is not decoration: without it
 * the route is unreachable.
 *
 * ACCEPTANCE GRADING lands here because that is what it grades — the stories'
 * acceptance criteria. It is a `Stamp`: mono, uppercase, state carried by the
 * WORD, in a colour family the screen already spends (coral for anything that
 * wants you, the land green for a clean pass). Never a per-status colour.
 *
 * EMPTY STATE: zero stories renders the band header and nothing else.
 * `StrataBand` has no min-height, no padding floor and no filler, and its
 * `gap` only materialises *between* children, so the band collapses to its
 * label line for free. That is the system's universal fallback — there is no
 * "No stories yet" copy anywhere in this design.
 */

import {
  BandHeader,
  CheckMark,
  Mono,
  QuietLink,
  Stamp,
  StrataBand,
  type StampTone,
} from "@/components/piscine";
import type { GradingStatus } from "@/lib/grading/report";
import { cn } from "@/lib/utils";
import { countAcceptanceCriteria } from "@/components/ticket/derive";

export interface UserStoryRow {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria: string | null;
  position?: number;
}

export interface UserStoriesBandProps {
  stories: UserStoryRow[];
  /** Needed to build the story-detail href; the band renders no link without it. */
  projectId?: string;
  /** Aggregate of the latest grading report. `null` = never graded. */
  gradingStatus?: GradingStatus | null;
  /** The grader's one-line verdict, shown under the header when there is one. */
  gradingSummary?: string | null;
}

/**
 * met → the land family (this is what "ready" looks like on this screen),
 * partial and missed → the coral family, which is the screen's one colour for
 * "this wants you". Two families, no third loud colour.
 */
const GRADING_STAMP: Record<GradingStatus, { tone: StampTone; label: string }> = {
  met: { tone: "land", label: "GRADED · MET" },
  partial: { tone: "asks", label: "GRADED · PARTIAL" },
  missed: { tone: "failed", label: "GRADED · MISSED" },
};

export function UserStoriesBand({
  stories,
  projectId,
  gradingStatus = null,
  gradingSummary = null,
}: UserStoriesBandProps) {
  const done = stories.filter((story) => story.status === "done").length;
  const grading = gradingStatus ? GRADING_STAMP[gradingStatus] : null;

  return (
    <StrataBand
      stratum="next"
      density="rail"
      gap={8}
      className="shrink-0 pb-[15px]"
    >
      <BandHeader
        label="User stories"
        stratum="next"
        // BandHeader hard-codes gap-[12px]; every 6a band draws 10.
        className="gap-[10px]"
        meta={stories.length > 0 ? `${done}/${stories.length} done` : undefined}
        right={
          grading ? (
            <Stamp tone={grading.tone} className="shrink-0">
              {grading.label}
            </Stamp>
          ) : undefined
        }
      />
      {/* Only ever the grader's own words — no verdict is manufactured for an
          ungraded ticket, which simply has no line here. */}
      {gradingSummary ? (
        <div data-testid="ticket-grading-summary">
          <Mono as="div" size={11} tone="next-mid" clamp={1}>
            {gradingSummary}
          </Mono>
        </div>
      ) : null}
      {stories.map((story) => (
        <StoryRow key={story.id} story={story} projectId={projectId} />
      ))}
    </StrataBand>
  );
}

function StoryRow({
  story,
  projectId,
}: {
  story: UserStoryRow;
  projectId?: string;
}) {
  const isDone = story.status === "done";
  const criteria = countAcceptanceCriteria(story.acceptanceCriteria);

  return (
    <div
      data-testid="ticket-story-row"
      className="flex items-center gap-[10px] rounded-[10px] bg-card px-3 py-[9px]"
    >
      <CheckMark checked={isDone} shape="disc" tone="live" />
      <span
        className={cn(
          "min-w-0 flex-1 line-clamp-1 text-[13px] font-medium",
          isDone ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {story.title}
      </span>
      {/* A story with no acceptance criteria has nothing to say: the chip is
          omitted rather than rendered as "0 AC" or "— AC". */}
      {criteria > 0 ? (
        <Mono size={10} tone="muted" className="shrink-0">
          {`${criteria} AC`}
        </Mono>
      ) : null}
      {projectId ? (
        <QuietLink
          tone="next"
          size={11.5}
          href={`/projects/${projectId}/stories/${story.id}`}
          testId="ticket-story-link"
          className="shrink-0"
        >
          open →
        </QuietLink>
      ) : null}
    </div>
  );
}
