"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Infinity as InfinityIcon } from "lucide-react";

import { PillButton, projectTone } from "@/components/piscine";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useControlDesk } from "@/hooks/useControlDesk";
import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import { buildRetryDispatch } from "@/lib/agent-sessions/retry-dispatch";
import type { DeskDismissalKind } from "@/lib/control-desk/aggregate";
import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
  DeskLandRow,
} from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";
import {
  ToastStack,
  type ToastAction,
  type ToastTone,
} from "@/components/notifications/ToastStack";
import {
  useDispatchFailureReporter,
  useToastStack,
} from "@/components/notifications/useToastStack";

import { FullAutoProjectRow } from "./FullAutoProjectRow";
import { DeskComposer } from "./DeskComposer";
import { DeskProjectMenu } from "./DeskProjectMenu";
import { ReadyToLandBand } from "./ReadyToLandBand";
import { UpNextBand } from "./UpNextBand";
import { WorkingBand } from "./WorkingBand";
import { YourTurnBand } from "./YourTurnBand";

/**
 * "Now" — the cross-project control desk (frame 5a).
 *
 * Five strata, top to bottom, in order of urgency: WORKING (turquoise) →
 * YOUR TURN (coral) → READY TO LAND (sun) | UP NEXT (pool) → the composer
 * (linden). Only WORKING grows; every other band sizes to its content, which
 * is what makes an empty stratum fold to its label line.
 *
 * ONE READ, ONE POLL. Everything comes from `GET /api/control-desk`; see
 * `hooks/useControlDesk.ts` for why the desk polls instead of opening one
 * EventSource per project.
 *
 * NO HEADER OF ITS OWN. `components/piscine/TopBar.tsx` is mounted once in
 * `app/layout.tsx` and already carries the logo, the project chips, ⌘K, the
 * inbox, Usage, Agents, Settings and the Auto state — the desk used to draw all
 * of it a second time, 60px below. What remains here is the SECOND ROW: the two
 * controls only the desk can offer, because both act on the payload it is
 * already holding. The `/projects/:id` host draws its own control row, so the
 * second row is skipped when the desk is scoped by its host.
 *
 * TOASTS. The desk raises its own unless the host page passes `onToast` — the
 * `/projects/:id` route already owns a toast stack for its dialogs and deep
 * links, and two stacks would overlap in the same corner.
 */
export type DeskToastTone = ToastTone;
export type DeskToastAction = ToastAction;

export interface NowDeskProps {
  /** Pre-filter the desk to one project (`/projects/:id`). */
  projectId?: string | null;
  /** Host-owned toast sink. Omit and the desk renders its own stack. */
  onToast?: (tone: DeskToastTone, message: string, action?: DeskToastAction) => void;
  /** Host-owned "the data moved" signal, e.g. to refresh a sibling panel. */
  onChanged?: () => void;
  /**
   * Batch selection, owned by the host page (`hooks/useBatchSelection.ts`,
   * which resolves transitive dependencies server-side). ⌘/Ctrl-click on a
   * ticket toggles it instead of opening the overlay — invisible at rest, which
   * is why the frame never draws it.
   */
  selectedEpicIds?: ReadonlySet<string>;
  onToggleSelect?: (epicId: string) => void;
  /**
   * Host override for "open this ticket". Defaults to the TicketOverlay
   * context. The `/projects/:id` route passes its own so a ticket click lands
   * in the shared panel that route already owns, instead of opening a second
   * ticket surface on top of it.
   */
  onOpenTicket?: (epicId: string) => void;
  className?: string;
}

export function NowDesk({
  projectId,
  onToast,
  onChanged,
  selectedEpicIds,
  onToggleSelect,
  onOpenTicket,
  className,
}: NowDeskProps) {
  const router = useRouter();
  const { openTicket } = useTicketOverlay();
  /**
   * The desk's scope is its host's route and nothing else now: the header rail
   * that used to filter it in place was a second row of project chips directly
   * under the bar's own, differing only in what a click did. The bar's chips
   * lead to `/projects/:id`, which renders THIS desk filtered — one gesture,
   * one meaning.
   */
  const activeProjectId = projectId ?? null;

  const { data, refresh } = useControlDesk(activeProjectId);
  const { toasts, raise, dismiss: dismissToast } = useToastStack(onToast);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [landingEpicId, setLandingEpicId] = useState<string | null>(null);
  const [landingAll, setLandingAll] = useState(false);
  const [composerProjectId, setComposerProjectId] = useState<string | null>(null);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);

  const changed = useCallback(() => {
    void refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const markPending = useCallback((epicId: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(epicId);
      else next.delete(epicId);
      return next;
    });
  }, []);

  /* ---- derived ----------------------------------------------------- */

  const projects = useMemo(() => data?.projects ?? [], [data]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const autoOn = projects.filter((project) => project.autoModeEnabled).length;

  const handleOpenTicket = useCallback(
    (epicId: string) => {
      if (onOpenTicket) {
        onOpenTicket(epicId);
        return;
      }
      const owner =
        data?.upNext.find((row) => row.tickets.some((t) => t.epicId === epicId))
          ?.projectId ?? activeProjectId;
      openTicket(epicId, { projectId: owner });
    },
    [data, activeProjectId, openTicket, onOpenTicket],
  );

  /**
   * Plain click opens the ticket; ⌘/Ctrl-click adds it to the batch selection.
   * One gesture, two meanings, and the selecting one leaves no chrome behind
   * when nothing is selected.
   */
  const handleTicketClick = useCallback(
    (epicId: string, event: React.MouseEvent) => {
      if ((event.metaKey || event.ctrlKey) && onToggleSelect) {
        event.preventDefault();
        onToggleSelect(epicId);
        return;
      }
      handleOpenTicket(epicId);
    },
    [handleOpenTicket, onToggleSelect],
  );

  /* ---- mutations ---------------------------------------------------- */

  const reportFailure = useDispatchFailureReporter(raise);

  const handleReply = useCallback(
    async (item: DeskAwaitingReply, message: string) => {
      markPending(item.epicId, true);
      try {
        const res = await fetch(
          `/api/projects/${item.projectId}/epics/${item.epicId}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ author: "user", content: message }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to post the reply", item.projectId);
          return;
        }
        // The reply is also the read: the durable cursor move is what keeps the
        // row from coming straight back on the next poll.
        await fetch("/api/inbox/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epicId: item.epicId }),
        }).catch(() => {});
        raise("success", "Réponse envoyée");
        changed();
      } catch {
        raise("error", "Failed to post the reply");
      } finally {
        markPending(item.epicId, false);
      }
    },
    [markPending, raise, reportFailure, changed],
  );

  const handleSendToDev = useCallback(
    async (item: DeskAwaitingReply, message: string) => {
      markPending(item.epicId, true);
      try {
        // The typed answer is posted first so the builder's prompt sees it, then
        // the epic build is dispatched. An empty field just dispatches.
        if (message.length > 0) {
          await fetch(`/api/projects/${item.projectId}/epics/${item.epicId}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ author: "user", content: message }),
          }).catch(() => {});
        }
        const res = await fetch(
          `/api/projects/${item.projectId}/epics/${item.epicId}/build`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(namedAgentId ? { namedAgentId } : {}),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to launch the build", item.projectId);
          return;
        }
        raise("success", "Envoyé en dev");
        changed();
      } catch {
        raise("error", "Failed to launch the build");
      } finally {
        markPending(item.epicId, false);
      }
    },
    [markPending, namedAgentId, raise, reportFailure, changed],
  );

  /**
   * Retry = a second attempt at the SAME work by the SAME agent. Which agent
   * and whether to resume its conversation are both decided by
   * `buildRetryDispatch`, because the badged session can be a review or a story
   * build rather than the epic build this button dispatches.
   */
  const handleRetry = useCallback(
    async (item: DeskFailure) => {
      markPending(item.epicId, true);
      try {
        const { url, body: payload } = buildRetryDispatch(
          item.projectId,
          item.epicId,
          {
            sessionId: item.sessionId,
            error: item.error,
            agentType: item.agentType,
            provider: item.provider,
            namedAgentId: item.namedAgentId,
            userStoryId: item.userStoryId,
            producedOutput: item.producedOutput,
          },
          namedAgentId,
        );
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to retry build", item.projectId);
          return;
        }
        raise("success", "Retrying build for epic");
        changed();
      } catch {
        raise("error", "Failed to retry build");
      } finally {
        markPending(item.epicId, false);
      }
    },
    [markPending, namedAgentId, raise, reportFailure, changed],
  );

  /**
   * Dismiss a "Your turn" signal.
   *
   * The optimistic hide goes through `refresh()` rather than local state on
   * purpose: `useControlDesk`'s requestSeq/mutationSeq guards make the refresh
   * win against the in-flight 4s poll, whereas a local hidden-set would fight
   * that poll and flicker the row back.
   *
   * This writes no ticket status and no activity entry — it is bookkeeping.
   */
  const handleDismiss = useCallback(
    async (
      kind: DeskDismissalKind,
      item: { epicId: string; signalAt: string | null },
    ) => {
      markPending(item.epicId, true);
      try {
        const res = await fetch("/api/desk/dismiss", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epicId: item.epicId, kind, signalAt: item.signalAt }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          raise("error", "Impossible d'écarter ce signal");
          return;
        }
        changed();
      } catch {
        raise("error", "Impossible d'écarter ce signal");
      } finally {
        markPending(item.epicId, false);
      }
    },
    [markPending, raise, changed],
  );

  const handleResolveConflict = useCallback(
    async (item: DeskConflict) => {
      markPending(item.epicId, true);
      try {
        const res = await fetch(
          `/api/projects/${item.projectId}/epics/${item.epicId}/resolve-merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to resolve the merge", item.projectId);
          return;
        }
        // Two outcomes: a clean re-merge landed the branch, or a conflict agent
        // was dispatched and the row goes back to ordinary agent activity.
        if (body.data?.resolved) raise("success", "Merged into the base branch");
        else if (body.data?.sessionId) {
          raise("success", "Merge conflict — resolution agent dispatched");
        }
        changed();
      } catch {
        raise("error", "Failed to resolve the merge");
      } finally {
        markPending(item.epicId, false);
      }
    },
    [markPending, raise, reportFailure, changed],
  );

  /**
   * Land — the merge route, which IS the approval: it resolves the remaining
   * findings and moves `to_merge → done` through the transition service.
   *
   * Merges operate on the project repository's shared base checkout, so only
   * ONE can be in flight at a time; `landingEpicId` / `landingAll` are that
   * lock, and they guard git's `index.lock` rather than a double click.
   */
  const landOne = useCallback(
    async (row: DeskLandRow): Promise<"merged" | "agent" | "failed"> => {
      try {
        const res = await fetch(
          `/api/projects/${row.projectId}/epics/${row.epicId}/merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to merge", row.projectId);
          return "failed";
        }
        return body.data?.autoAgent ? "agent" : "merged";
      } catch {
        return "failed";
      }
    },
    [reportFailure],
  );

  const handleLand = useCallback(
    async (row: DeskLandRow) => {
      if (landingEpicId !== null || landingAll) return;
      setLandingEpicId(row.epicId);
      const outcome = await landOne(row);
      setLandingEpicId(null);
      if (outcome === "merged") raise("success", "Merged into the base branch");
      if (outcome === "agent") raise("success", "Launched merge-fix agent");
      changed();
    },
    [landingEpicId, landingAll, landOne, raise, changed],
  );

  const handleLandAll = useCallback(
    async (rows: readonly DeskLandRow[]) => {
      if (landingEpicId !== null || landingAll) return;
      setLandingAll(true);
      let merged = 0;
      let agentLaunched = 0;
      let failed = 0;
      // Sequential on purpose: one shared checkout per project, and a parallel
      // batch would collide on git's index.lock.
      for (const row of rows) {
        const outcome = await landOne(row);
        if (outcome === "merged") merged += 1;
        else if (outcome === "agent") agentLaunched += 1;
        else failed += 1;
      }
      setLandingAll(false);
      if (merged > 0) raise("success", `Merged ${merged} epic${merged > 1 ? "s" : ""}`);
      if (agentLaunched > 0) {
        raise(
          "success",
          `Launched merge-fix agent for ${agentLaunched} epic${agentLaunched > 1 ? "s" : ""}`,
        );
      }
      if (failed > 0) raise("error", `${failed} merge${failed > 1 ? "s" : ""} failed`);
      changed();
    },
    [landingEpicId, landingAll, landOne, raise, changed],
  );

  const handleStopSession = useCallback(
    async (sessionId: string) => {
      const session = data?.working.find((row) => row.sessionId === sessionId);
      if (!session) return;
      try {
        const res = await fetch(
          `/api/projects/${session.projectId}/sessions/${sessionId}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          raise("error", "Failed to stop the session");
          return;
        }
        raise("success", "Session stopped");
        changed();
      } catch {
        raise("error", "Failed to stop the session");
      }
    },
    [data, raise, changed],
  );

  const handleCompose = useCallback(
    async (input: {
      title: string;
      projectId: string;
      namedAgentId: string | null;
      dispatch: boolean;
    }): Promise<boolean> => {
      try {
        // There is no `draft` status — this is QuickCapture's exact payload.
        const res = await fetch(`/api/projects/${input.projectId}/epics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: input.title,
            status: "backlog",
            type: "feature",
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          raise("error", body.error || "Failed to capture the idea");
          return false;
        }
        const epicId: string | undefined = body.data?.id;
        const ticketAction = epicId ? {
          href: `/projects/${input.projectId}?ticket=${epicId}`,
          label: "Voir le ticket",
        } : undefined;
        const confirmation = `Ticket créé dans le backlog : ${input.title}`;
        if (!input.dispatch || !epicId) {
          raise("success", confirmation, ticketAction);
          changed();
          return true;
        }
        // Creation is durable already: a dispatch failure must not invite a duplicate.
        try {
          const dispatched = await fetch(
            `/api/projects/${input.projectId}/epics/${epicId}/build`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input.namedAgentId ? { namedAgentId: input.namedAgentId } : {}),
            },
          );
          const dispatchBody = await dispatched.json().catch(() => ({}));
          if (!dispatched.ok || dispatchBody.error) {
            raise("warning", `Ticket créé, mais le lancement du build a échoué : ${dispatchBody.error || input.title}`, ticketAction);
          } else {
            raise("success", `Ticket créé et envoyé en dev : ${input.title}`, ticketAction);
          }
        } catch {
          raise("warning", `Ticket créé, mais le lancement du build n'a pas pu être confirmé : ${input.title}`, ticketAction);
        }
        changed();
        return true;
      } catch {
        raise("error", "Failed to capture the idea");
        return false;
      }
    },
    [raise, changed],
  );

  /**
   * Effective Full Auto agents per project, as the auto-mode route resolves
   * them. Read only while the popover is open — one request per project, on
   * open, not on the 4s desk poll.
   */
  const [autoPopoverOpen, setAutoPopoverOpen] = useState(false);
  const [autoAgents, setAutoAgents] = useState<
    Record<string, { buildAgent: string | null; reviewAgent: string | null }>
  >({});

  useEffect(() => {
    if (!autoPopoverOpen || projects.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          try {
            const res = await fetch(`/api/projects/${project.id}/auto-mode`);
            const json = await res.json();
            return [
              project.id,
              {
                buildAgent: json?.data?.buildAgent ?? null,
                reviewAgent: json?.data?.reviewAgent ?? null,
              },
            ] as const;
          } catch {
            return [project.id, { buildAgent: null, reviewAgent: null }] as const;
          }
        }),
      );
      if (!cancelled) setAutoAgents(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [autoPopoverOpen, projects]);

  /**
   * Write ONE per-project override. The PUT route keys off `"buildAgent" in
   * payload`, so a body carrying only the agent leaves the enabled flag
   * untouched — the on/off box and these pills cannot clobber each other.
   */
  const setAutoModeAgent = useCallback(
    async (
      targetProjectId: string,
      role: "buildAgent" | "reviewAgent",
      namedAgentId: string | null,
    ) => {
      try {
        const res = await fetch(`/api/projects/${targetProjectId}/auto-mode`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [role]: namedAgentId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.error) {
          raise("error", "Failed to change the Full Auto agent");
          return;
        }
        setAutoAgents((current) => ({
          ...current,
          [targetProjectId]: {
            buildAgent: body?.data?.buildAgent ?? null,
            reviewAgent: body?.data?.reviewAgent ?? null,
          },
        }));
      } catch {
        raise("error", "Failed to change the Full Auto agent");
      }
    },
    [raise],
  );

  const toggleAutoMode = useCallback(
    async (targetProjectId: string, enabled: boolean) => {
      try {
        const res = await fetch(`/api/projects/${targetProjectId}/auto-mode`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        if (!res.ok) {
          raise("error", "Failed to change Full Auto");
          return;
        }
        raise("success", enabled ? "Full Auto Mode is on" : "Full Auto Mode is off");
        changed();
      } catch {
        raise("error", "Failed to change Full Auto");
      }
    },
    [raise, changed],
  );

  /* ---- render ------------------------------------------------------- */

  return (
    <div
      data-testid="now-desk"
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-background font-sans text-foreground",
        /*
          THE DESK SCROLLS ITSELF BELOW `lg` — B-arij-M9zsQujUTCoR.

          Five strata do not fit 844px once each of them is legible, and
          neither host would let the column spill: `/` gives the desk `h-full`
          inside an `overflow-auto` main (so the desk squeezes rather than the
          page scrolling), and `/projects/:id` wraps it in an `overflow-hidden`
          box that would simply cut UP NEXT off. Owning the scroll here is the
          one answer that is right in both. Unchanged from `lg` up: the desk is
          exactly one viewport tall and nothing scrolls but WORKING.
        */
        "max-lg:overflow-y-auto",
        className,
      )}
    >
      {/*
        ── SECOND ROW ────────────────────────────────────────────────────
        Not a header: the global bar is the header. Body gutter (14px), not
        the 24px header gutter. Two controls, both of them things the bar
        cannot do — arm Full Auto across projects, and reach the per-project
        pages the three nav categories do not claim (Docs, Frictions, Git
        Sync, GitHub Issues, per-project Settings).

        Skipped when a host scopes the desk: `/projects/:id` draws its own
        control row above it, carrying that project's Full Auto switch.
      */}
      {projectId ? null : (
        <div
          data-testid="desk-controls"
          className="flex h-[40px] shrink-0 items-center gap-[8px] px-[14px]"
        >
          <div className="ml-auto flex shrink-0 items-center gap-[8px]">
            <DeskProjectMenu projects={projects} />

            {/* Full Auto is PER PROJECT — there is no global flag, so the pill
                reports how many projects are armed and opens the per-project
                switches rather than pretending to be one toggle. The bar's
                "Auto" pill is the read-only rollup and leads to Réglages; this
                is where the switches actually live. */}
            <Popover open={autoPopoverOpen} onOpenChange={setAutoPopoverOpen}>
              <PopoverTrigger asChild>
                <PillButton
                  variant="filled"
                  size="md"
                  icon={InfinityIcon}
                  data-testid="desk-full-auto"
                >
                  {`Full Auto · ${autoOn}/${projects.length}`}
                </PillButton>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[320px] rounded-[12px] border-[1.5px] border-border bg-card p-2 shadow-none"
              >
                <div className="flex flex-col gap-1">
                  {/*
                    The row is the control, and the mark is the CheckMark
                    primitive. A native <input type="checkbox"> painted nothing
                    here: Tailwind's preflight sets `border: 0` on inputs, so the
                    `border-border` it carried never rendered, and its `rounded`
                    was off the 10/12/14/9999 scale the system allows.

                    The row also carries the two per-project agent overrides —
                    the only place they can be set, since /settings writes the
                    bare workspace keys. See FullAutoProjectRow.
                  */}
                  {projects.map((project) => (
                    <FullAutoProjectRow
                      key={project.id}
                      project={project}
                      onToggle={toggleAutoMode}
                      onSetAgent={setAutoModeAgent}
                      agents={autoAgents[project.id]}
                    />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}

      <WorkingBand
        working={data?.working ?? []}
        queued={data?.queued ?? []}
        today={
          data?.today ?? {
            ticketsShipped: null,
            failedSessions: null,
            costUsd: null,
            projects: null,
            sessions: null,
          }
        }
        projectsById={projectsById}
        onOpenTicket={handleOpenTicket}
        onStopSession={handleStopSession}
        projectId={projectId ?? undefined}
        /*
          A floor for the one band that grows. In a scrolling column its
          `flex-1 min-h-0` is not a claim on space, it is permission to be
          squeezed to zero by the `shrink-0` strata under it — which is exactly
          what a legible READY TO LAND and UP NEXT would do on a phone. Two
          tile rows is what the band is for.
        */
        className="max-lg:min-h-[190px]"
      />

      <YourTurnBand
        awaitingReply={data?.yourTurn.awaitingReply ?? []}
        failed={data?.yourTurn.failed ?? []}
        conflicts={data?.yourTurn.conflicts ?? []}
        projectsById={projectsById}
        pendingIds={pendingIds}
        onReply={handleReply}
        onSendToDev={handleSendToDev}
        onRetry={handleRetry}
        onOpenLog={(item) =>
          router.push(`/projects/${item.projectId}/sessions/${item.sessionId}`)
        }
        onResolveConflict={handleResolveConflict}
        onOpenDiff={(item) => handleOpenTicket(item.epicId)}
        onDismiss={handleDismiss}
      />

      {/*
        A floor, not a growth rule: the grid stays `shrink-0` (WORKING remains
        the desk's only growing band) but can no longer be squeezed to nothing
        by a tall YOUR TURN above it.

        ONE COLUMN BELOW `lg`. Half of a 390px desk is 139px, which is what
        reduced the land rows' titles and the queue chips to nothing (22px of
        chip against a 294px label). `lg` and not `md`: at 768 the two columns
        are 328px each and the land title still measured 0px.
      */}
      <div className="mx-[14px] mt-[10px] grid min-h-[168px] shrink-0 grid-cols-1 gap-3 lg:grid-cols-2">
        <ReadyToLandBand
          rows={data?.readyToLand ?? []}
          heldBackCount={data?.heldBackCount ?? 0}
          projectsById={projectsById}
          landingEpicId={landingEpicId}
          landingAll={landingAll}
          onLand={handleLand}
          onLandAll={handleLandAll}
          onOpenTicket={handleTicketClick}
          selectedEpicIds={selectedEpicIds}
        />
        <UpNextBand
          upNext={data?.upNext ?? []}
          projectsById={projectsById}
          onOpenTicket={handleTicketClick}
          selectedEpicIds={selectedEpicIds}
        />
      </div>

      <DeskComposer
        projects={projects}
        targetProjectId={composerProjectId ?? activeProjectId}
        onTargetProjectChange={setComposerProjectId}
        namedAgentId={namedAgentId}
        onNamedAgentChange={setNamedAgentId}
        onSubmit={handleCompose}
      />

      {onToast ? null : (
        <ToastStack items={toasts} onDismiss={dismissToast} testId="desk-toast" />
      )}
    </div>
  );
}

/** Re-exported so the project-scoped route can hint the tone union. */
export type { DeskLandRow };
export { projectTone };
