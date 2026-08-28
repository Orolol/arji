"use client";

/**
 * USER STORIES on the pool ground (frame 6a, lines 221-247).
 *
 * Read-only in this packet: the discs have no `onToggle` and there is no add
 * field — story editing lives on the story surface, not in the ticket overlay.
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
  StrataBand,
} from "@/components/piscine";
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
}

export function UserStoriesBand({ stories }: UserStoriesBandProps) {
  const done = stories.filter((story) => story.status === "done").length;

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
      />
      {stories.map((story) => (
        <StoryRow key={story.id} story={story} />
      ))}
    </StrataBand>
  );
}

function StoryRow({ story }: { story: UserStoryRow }) {
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
    </div>
  );
}
