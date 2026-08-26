"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PriorityBadge } from "@/components/shared/PriorityBadge";
import { TicketTypeBadge } from "@/components/shared/TicketTypeBadge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type KanbanEpic,
  type KanbanAgentActionType,
  type KanbanEpicAgentActivity,
} from "@/lib/types/kanban";
import { formatElapsed } from "@/lib/utils/format-elapsed";
import {
  GitPullRequest,
  Bot,
  TriangleAlert,
  RefreshCw,
  Link2,
} from "lucide-react";
import type {
  DependencyFocusRole,
  ReadinessScore,
} from "@/lib/kanban/queue";
import type { FailedSessionInfo } from "@/lib/agent-sessions/latest-failure";
import {
  isChatProvider,
  PROVIDER_LABELS,
} from "@/lib/agent-config/constants";
import { GradingStatusBadge } from "@/components/grading/GradingStatusBadge";

function providerLabel(provider?: string): string {
  if (!provider) return "Agent";
  if (provider === "gemini-cli") return "Gemini";
  return isChatProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

/**
 * Per-epic state and callbacks derived by the Board and handed to a single card.
 *
 * Grouping these keeps the Board -> Column -> EpicCard chain from growing a new
 * prop on three interfaces every time a card feature ships: Column only forwards
 * the view object, and only this type plus the Board's builder change.
 */
export interface EpicCardView {
  selected?: boolean;
  autoIncluded?: boolean;
  isRunning?: boolean;
  /** Agent action currently running for this epic, if any */
  activity?: KanbanEpicAgentActivity;
  /** Whether the latest comment is AI-origin and still unseen */
  unreadAi?: boolean;
  /**
   * Latest agent session ended by asking a question and no user reply since
   * (delivery-verdict signal, derived by the Board from the epic row)
   */
  awaitingReply?: boolean;
  /** Info about the most recent failed agent session for this epic */
  failedSession?: FailedSessionInfo;
  onToggleSelect?: () => void;
  onLinkedAgentHoverChange?: (activityId: string | null) => void;
  /** Called when user clicks the retry button on a failed session indicator */
  onRetryBuild?: () => void;
  /** Effective position in the To Do execution queue (todo column only). */
  queueRank?: number;
  /** The card is queue position 1 — the "next up" ticket. */
  isNextEpic?: boolean;
  /** Readable ids of dependency targets that are not delivered yet. */
  blockedOn?: string[];
  /** Backlog readiness: criteria met out of the ones that apply to this card. */
  readiness?: ReadinessScore;
  /**
   * Report this card gaining (`true`) or losing (`false`) the pointer/keyboard
   * focus. The Board owns the 150 ms intent timer and only retracts a focus the
   * same card armed, so the id travels in both directions.
   */
  onDependencyHoverChange?: (epicId: string, active: boolean) => void;
}

interface EpicCardProps {
  epic: KanbanEpic;
  isOverlay?: boolean;
  onClick?: () => void;
  /** Flash highlight when ticket state changes */
  highlight?: boolean;
  /** Per-epic state and callbacks, built by the Board */
  view?: EpicCardView;
  /**
   * This card's role in the active dependency hover focus, if any. Kept off
   * `view` deliberately: focus changes on every pointer move, and folding it
   * into the view map would rebuild every card's view object — selection,
   * agent activity, unread cursors and all — on each hover.
   */
  focus?: DependencyFocusRole;
}

/**
 * A card with no description and no stories is a bare idea (e.g. from quick
 * capture): flag it as a draft to nudge refinement before dispatching agents.
 */
export function isDraftEpic(
  epic: Pick<KanbanEpic, "description" | "usCount">
): boolean {
  return (!epic.description || epic.description.trim() === "") && epic.usCount === 0;
}

const ACTIVITY_LABEL_BY_TYPE: Record<KanbanAgentActionType, string> = {
  build: "Build",
  review: "Review",
  merge: "Merge",
};

const EMPTY_VIEW: EpicCardView = {};

/**
 * Tooltip wording per readiness total. Bugs are scored out of 2 — their
 * creation flow has no mandatory rubric — so naming acceptance criteria on a
 * bug card would advertise a requirement that does not apply to it.
 */
const READINESS_CRITERIA: Record<number, string> = {
  2: "no open agent question · has a description",
  3: "no open agent question · has a description · has acceptance criteria",
};

export function EpicCard({
  epic,
  isOverlay,
  onClick,
  highlight = false,
  view = EMPTY_VIEW,
  focus,
}: EpicCardProps) {
  const {
    selected,
    autoIncluded,
    activity: activeAgentActivity,
    unreadAi: hasUnreadAiUpdate = false,
    awaitingReply = false,
    failedSession,
    onToggleSelect,
    onLinkedAgentHoverChange,
    onRetryBuild,
    queueRank,
    isNextEpic,
    blockedOn,
    readiness,
    onDependencyHoverChange,
  } = view;

  const dimmed = focus === "dimmed";

  // React fires no mouseleave when a card unmounts, and a card that changes
  // column re-mounts under a different Column — so a hovered ticket moved by an
  // SSE update would otherwise leave the board dimmed with the pointer nowhere
  // near a card. The card reports its own departure on the way out.
  const hoverChangeRef = useRef(onDependencyHoverChange);
  useEffect(() => {
    hoverChangeRef.current = onDependencyHoverChange;
  });
  useEffect(
    () => () => {
      hoverChangeRef.current?.(epic.id, false);
    },
    [epic.id]
  );
  // Story 2 asks for a greyed card, not just a label: a blocked ticket has to
  // be legible at a glance in a dense column, where the 11px "Waiting on:" row
  // is the first thing to scroll out of view.
  const blocked = !!blockedOn?.length;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: epic.id });

  const isDraft = isDraftEpic(epic);

  // Flash highlight animation state
  const [isHighlighted, setIsHighlighted] = useState(false);
  const prevHighlight = useRef(highlight);
  useEffect(() => {
    if (highlight && !prevHighlight.current) {
      setIsHighlighted(true);
      const timer = setTimeout(() => setIsHighlighted(false), 1500);
      return () => clearTimeout(timer);
    }
    prevHighlight.current = highlight;
  }, [highlight]);

  // Every opacity state lives in this inline object because the drag opacity
  // does: an inline declaration beats any non-`!important` class rule, and
  // Tailwind emits `.opacity-*` without `!important`, so a class-based variant
  // would never reach the screen while this object is applied to the same
  // element. Ordered by precedence — a card being dragged reads as dragged
  // first, an unrelated card under a hover focus recedes furthest, and blocked
  // is the resting state that has to stay readable.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : dimmed ? 0.4 : blocked ? 0.62 : 1,
  };

  const activityLabel = activeAgentActivity
    ? ACTIVITY_LABEL_BY_TYPE[activeAgentActivity.actionType]
    : null;
  const linkedActivityId = activeAgentActivity?.sessionId ?? null;
  const showFailure = !!failedSession && !activeAgentActivity;
  const remainingStories = Math.max(epic.usCount - epic.usDone, 0);
  const showDeliveredWithRemainingStories =
    (epic.status === "done" || epic.status === "released") &&
    remainingStories > 0;

  // Elapsed time ticker for active agent
  const [elapsedText, setElapsedText] = useState("");
  useEffect(() => {
    if (!activeAgentActivity?.startedAt) {
      setElapsedText("");
      return;
    }
    const update = () => setElapsedText(formatElapsed(activeAgentActivity.startedAt!));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeAgentActivity?.startedAt]);

  function handleCardClick(event: MouseEvent) {
    const additiveSelection = event.metaKey || event.ctrlKey || event.shiftKey;

    if (additiveSelection && onToggleSelect) {
      event.preventDefault();
      onToggleSelect();
      return;
    }

    onClick?.();
  }

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleCardClick}
      onMouseEnter={() => {
        onDependencyHoverChange?.(epic.id, true);
        if (!linkedActivityId) return;
        onLinkedAgentHoverChange?.(linkedActivityId);
      }}
      onMouseLeave={() => {
        onDependencyHoverChange?.(epic.id, false);
        onLinkedAgentHoverChange?.(null);
      }}
      onFocusCapture={() => {
        onDependencyHoverChange?.(epic.id, true);
        if (!linkedActivityId) return;
        onLinkedAgentHoverChange?.(linkedActivityId);
      }}
      onBlurCapture={(event) => {
        // Focus moving WITHIN this card (body -> selection checkbox -> link)
        // is not a leave. Clearing above this guard would drop the dependency
        // focus and re-arm the 150 ms timer on every internal tab step, which
        // is exactly the flicker that intent window exists to prevent.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        onDependencyHoverChange?.(epic.id, false);
        onLinkedAgentHoverChange?.(null);
      }}
      data-selected={selected ? "true" : undefined}
      data-auto-included={autoIncluded ? "true" : undefined}
      className={cn(
        "cursor-pointer gap-[9px] rounded-[11px] border border-border bg-card px-[15px] py-[14px]",
        "shadow-[0_1px_2px_rgba(36,33,29,.04)] transition-all duration-300 motion-reduce:transition-none",
        "hover:border-muted-foreground/25 hover:shadow-[0_1px_2px_rgba(36,33,29,.09)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40",
        isDraft && "border-dashed",
        activeAgentActivity && "gap-[11px] border-agent-border",
        showFailure && "gap-[11px] border-destructive",
        // The auto-included dependency reads as agent-added, not user-picked,
        // so it keeps its dashed teal frame even though the Board also marks
        // it selected (it ships with the batch).
        autoIncluded
          ? "gap-[8px] border-dashed border-agent"
          : selected
            ? "gap-[8px] border-primary shadow-[0_0_0_3px] shadow-primary/10"
            : undefined,
        isOverlay &&
          "rotate-[1.5deg] shadow-[0_8px_20px_rgba(58,48,44,.16)]",
        isHighlighted &&
          "ring-2 ring-primary/70 bg-primary/5 motion-reduce:ring-0 motion-reduce:bg-transparent",
        dimmed && "saturate-50",
        // Desaturation carries the "greyed" reading that opacity alone does
        // not; the destructive-tinted border keeps the state findable once the
        // card is muted. Both yield to an active hover focus.
        blocked && !dimmed && "saturate-[.55] border-destructive/40",
        focus === "predecessor" && "ring-2 ring-primary/50",
        focus === "successor" && "ring-2 ring-agent/50",
      )}
    >
      <h4 className="line-clamp-2 text-[14px] font-medium leading-[1.35] [text-wrap:pretty]">
        {epic.title}
      </h4>

      {activityLabel && (
        <>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex items-center gap-[8px] text-[12px] text-agent"
                  aria-label={`${activityLabel} active: ${activeAgentActivity!.agentName}`}
                  data-testid={`epic-activity-${epic.id}`}
                >
                  <span className="breathing-dot h-[7px] w-[7px] shrink-0" />
                  <span className="truncate">
                    {activityLabel} {"·"}{" "}
                    {providerLabel(activeAgentActivity!.provider)}
                    {elapsedText && ` · ${elapsedText}`}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" className="text-xs">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {activityLabel}: {activeAgentActivity!.agentName}
                  </span>
                  <span className="text-muted-foreground">
                    {providerLabel(activeAgentActivity!.provider)}
                    {elapsedText && ` · ${elapsedText}`}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="progress-track" aria-hidden="true">
            <div className="crawl-fill" />
          </div>
        </>
      )}

      {awaitingReply && (
        <div
          className="flex items-center gap-[7px] text-[12px] text-primary"
          aria-label="Agent asked a question — awaiting your reply"
          title="Agent asked a question — awaiting your reply"
          data-testid={`epic-awaiting-reply-${epic.id}`}
        >
          <Bot className="h-[13px] w-[13px] shrink-0" />
          Awaiting your reply
        </div>
      )}

      {showFailure && (
        <>
          {/* The failure line is the failure signal itself: an anchor into
              the session view, so the detail (full error + logs) is one
              click away from the very text the user reads. The full text
              stays on hover (title) — the visible line is clamped so a long
              error cannot balloon the card. */}
          <a
            href={`/projects/${epic.projectId}/sessions/${failedSession!.sessionId}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-start gap-[7px] rounded-[7px] px-1 py-0.5 -mx-1 text-[12px] text-destructive transition-colors hover:bg-band motion-reduce:transition-none"
            aria-label="Agent session failed — open session view for details"
            title={failedSession!.error}
            data-testid={`epic-error-${epic.id}`}
          >
            <TriangleAlert className="mt-[2px] h-[13px] w-[13px] shrink-0" />
            <span className="min-w-0 break-words line-clamp-3">
              Session failed {"·"} {failedSession!.error}
            </span>
          </a>
          <div className="flex flex-wrap items-center gap-[8px]">
            {onRetryBuild && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryBuild();
                }}
                className="inline-flex h-[27px] shrink-0 items-center gap-[6px] rounded-[7px] bg-destructive px-[11px] text-[12.5px] text-primary-foreground transition-colors hover:bg-destructive/90 motion-reduce:transition-none"
                aria-label="Retry failed agent session"
                data-testid={`epic-retry-${epic.id}`}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
            <a
              href={`/projects/${epic.projectId}/sessions/${failedSession!.sessionId}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex h-[27px] shrink-0 items-center rounded-[7px] border border-border px-[11px] text-[12.5px] transition-colors hover:bg-band motion-reduce:transition-none"
              data-testid={`epic-view-log-${epic.id}`}
            >
              View log
            </a>
          </div>
        </>
      )}

      {autoIncluded && (
        <div
          className="text-[12px] text-agent"
          data-testid={`epic-auto-included-${epic.id}`}
        >
          Added — required dependency
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-[9px] font-mono text-[11px] text-meta"
        data-testid={`epic-meta-${epic.id}`}
      >
        <span className="font-mono">{epic.readableId || epic.id}</span>
        <span aria-hidden="true">{"·"}</span>
        {epic.type === "bug" ? (
          <TicketTypeBadge type={epic.type} variant="meta" />
        ) : (
          <span>
            {epic.usDone}/{epic.usCount} US
          </span>
        )}
        {queueRank !== undefined && (
          <span
            className={cn(
              "inline-flex items-center rounded-[4px] px-[5px] text-[10px]",
              isNextEpic
                ? "border border-agent-border bg-agent-bg text-agent"
                : "text-muted-foreground"
            )}
            title={
              isNextEpic
                ? "Next in board order. Full Auto sorts by priority first, so its dispatch order can differ."
                : `Position ${queueRank} in board order`
            }
            data-testid={`epic-queue-rank-${epic.id}`}
          >
            #{queueRank}
            {isNextEpic && <span className="ml-[4px] font-sans">Next</span>}
          </span>
        )}
        {isDraft && (
          <span
            className="inline-flex items-center rounded-[4px] border border-dashed border-muted-foreground/40 px-[5px] text-[10px] uppercase tracking-wide"
            title="Draft — add a description or stories before dispatching"
            data-testid={`epic-draft-${epic.id}`}
          >
            Draft
          </span>
        )}
        {readiness && (
          <span
            className={cn(
              "inline-flex items-center rounded-[4px] px-[5px] text-[10px]",
              readiness.met === readiness.total
                ? "border border-agent-border bg-agent-bg text-agent"
                : "border border-muted-foreground/30 text-muted-foreground"
            )}
            title={
              readiness.met === readiness.total
                ? `Ready for To Do: ${READINESS_CRITERIA[readiness.total]}`
                : `Ready when: ${READINESS_CRITERIA[readiness.total]}`
            }
            data-testid={`epic-readiness-${epic.id}`}
          >
            Ready {readiness.met}/{readiness.total}
          </span>
        )}
        {showDeliveredWithRemainingStories && (
          <span
            className="inline-flex items-center gap-1 rounded-[4px] border border-amber-500/40 px-[5px] text-[10px] text-amber-600 dark:text-amber-400"
            title={`${remainingStories} ${remainingStories === 1 ? "story remains" : "stories remain"} unfinished`}
            data-testid={`epic-incomplete-stories-${epic.id}`}
          >
            <TriangleAlert className="h-3 w-3" aria-hidden="true" />
            {remainingStories} {remainingStories === 1 ? "story" : "stories"} left
          </span>
        )}
        {hasUnreadAiUpdate && (
          <span
            className="inline-flex items-center justify-center text-agent"
            aria-label="Unread AI update"
            title="Unread AI update"
            data-testid={`epic-unread-ai-${epic.id}`}
          >
            <Bot className="h-3 w-3" />
          </span>
        )}
        {epic.gradingStatus && (
          <GradingStatusBadge
            status={epic.gradingStatus}
            evidence={epic.gradingSummary}
            label={`Criteria ${epic.gradingStatus}`}
            testId={`epic-grading-${epic.id}`}
            className="font-sans"
          />
        )}
        <PriorityBadge priority={epic.priority} className="font-sans" />
        {epic.prNumber && epic.prUrl && (
          <a
            href={epic.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="ml-auto inline-flex items-center gap-[4px] text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
          >
            <GitPullRequest className="h-3 w-3" />
            <span>#{epic.prNumber}</span>
          </a>
        )}
      </div>
      {blockedOn && blockedOn.length > 0 && (
        <div
          className="flex items-center gap-[5px] font-mono text-[11px] text-destructive"
          data-testid={`epic-blocked-${epic.id}`}
        >
          <Link2 className="h-[12px] w-[12px] shrink-0" aria-hidden="true" />
          {/* Comma-separated: `readableId` is nullable, so entries fall back to
              the epic title, and multi-word titles joined by a bare space read
              as a single blocker. */}
          <span className="truncate">Waiting on: {blockedOn.join(", ")}</span>
        </div>
      )}
    </Card>
  );
}
