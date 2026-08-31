"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Inbox,
  Infinity as InfinityIcon,
  LayoutGrid,
  Search,
  Settings,
} from "lucide-react";

import {
  DeskHeader,
  Mono,
  PillButton,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
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

import { DeskCommandPalette } from "./DeskCommandPalette";
import { FullAutoProjectRow } from "./FullAutoProjectRow";
import { DeskComposer } from "./DeskComposer";
import { DeskProjectRail } from "./DeskProjectRail";
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
 * TOASTS. The desk raises its own unless the host page passes `onToast` — the
 * `/projects/:id` route already owns a toast stack for its dialogs and deep
 * links, and two stacks would overlap in the same corner.
 */
export type DeskToastTone = "success" | "error" | "warning";

export interface DeskToastAction {
  href: string;
  label?: string;
}

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

interface DeskToast {
  id: string;
  tone: DeskToastTone;
  message: string;
  href?: string;
  actionLabel?: string;
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
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(
    projectId ?? null,
  );
  React.useEffect(() => {
    setActiveProjectId(projectId ?? null);
  }, [projectId]);

  const { data, refresh } = useControlDesk(activeProjectId);
  const [toasts, setToasts] = React.useState<DeskToast[]>([]);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [pendingIds, setPendingIds] = React.useState<ReadonlySet<string>>(new Set());
  const [landingEpicId, setLandingEpicId] = React.useState<string | null>(null);
  const [landingAll, setLandingAll] = React.useState(false);
  const [composerProjectId, setComposerProjectId] = React.useState<string | null>(null);
  const [namedAgentId, setNamedAgentId] = React.useState<string | null>(null);

  const raise = React.useCallback(
    (tone: DeskToastTone, message: string, action?: DeskToastAction) => {
      if (onToast) {
        onToast(tone, message, action);
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [
        ...current,
        { id, tone, message, href: action?.href, actionLabel: action?.label },
      ]);
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 5000);
    },
    [onToast],
  );

  const changed = React.useCallback(() => {
    void refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const markPending = React.useCallback((epicId: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(epicId);
      else next.delete(epicId);
      return next;
    });
  }, []);

  /* ---- ⌘K --------------------------------------------------------- */

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- derived ----------------------------------------------------- */

  const projects = React.useMemo(() => data?.projects ?? [], [data]);
  const projectsById = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const unreadCount = React.useMemo(
    () => (data?.yourTurn.awaitingReply ?? []).filter((row) => row.unreadAi).length,
    [data],
  );
  const autoOn = projects.filter((project) => project.autoModeEnabled).length;

  const handleOpenTicket = React.useCallback(
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
  const handleTicketClick = React.useCallback(
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

  /**
   * 409 AGENT_ALREADY_RUNNING is not an error the user can do anything with
   * unless the toast can take them to the session that is in the way. The
   * payload shape comes from lib/agents/client-error.ts.
   */
  const reportFailure = React.useCallback(
    (res: Response, body: { error?: string; code?: string; data?: { activeSessionId?: string; sessionUrl?: string } }, fallback: string, ownerProjectId: string) => {
      if (
        res.status === 409 &&
        body.code === "AGENT_ALREADY_RUNNING" &&
        body.data?.activeSessionId
      ) {
        raise("error", body.error ?? fallback, {
          href:
            body.data.sessionUrl ||
            `/projects/${ownerProjectId}/sessions/${body.data.activeSessionId}`,
          label: "Open active session",
        });
        return;
      }
      raise("error", body.error || fallback);
    },
    [raise],
  );

  const handleReply = React.useCallback(
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

  const handleSendToDev = React.useCallback(
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
  const handleRetry = React.useCallback(
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
  const handleDismiss = React.useCallback(
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

  const handleResolveConflict = React.useCallback(
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
  const landOne = React.useCallback(
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

  const handleLand = React.useCallback(
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

  const handleLandAll = React.useCallback(
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

  const handleStopSession = React.useCallback(
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

  const handleCompose = React.useCallback(
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
        if (!input.dispatch || !epicId) {
          raise("success", "Epic créé dans le backlog");
          changed();
          return true;
        }
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
          reportFailure(
            dispatched,
            dispatchBody,
            "Epic créé, mais le build n'a pas démarré",
            input.projectId,
          );
        } else {
          raise("success", "Epic créé et envoyé en dev");
        }
        changed();
        return true;
      } catch {
        raise("error", "Failed to capture the idea");
        return false;
      }
    },
    [raise, reportFailure, changed],
  );

  /**
   * Effective Full Auto agents per project, as the auto-mode route resolves
   * them. Read only while the popover is open — one request per project, on
   * open, not on the 4s desk poll.
   */
  const [autoPopoverOpen, setAutoPopoverOpen] = React.useState(false);
  const [autoAgents, setAutoAgents] = React.useState<
    Record<string, { buildAgent: string | null; reviewAgent: string | null }>
  >({});

  React.useEffect(() => {
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
  const setAutoModeAgent = React.useCallback(
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

  const toggleAutoMode = React.useCallback(
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
        className,
      )}
    >
      <DeskHeader title="Now" titleHref="/">
        <DeskProjectRail
          projects={projects}
          activeProjectId={activeProjectId}
          onSelect={(next) => setActiveProjectId(next)}
        />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PillButton
            variant="outline"
            size="md"
            icon={Search}
            onClick={() => setPaletteOpen(true)}
            data-testid="desk-command-trigger"
          >
            <Mono size={11}>⌘K</Mono>
          </PillButton>

          <PillButton
            variant="outline"
            outlineTone="neutral"
            iconOnly
            icon={Inbox}
            badge={unreadCount}
            onClick={() => router.push("/inbox")}
            data-testid="desk-inbox"
          >
            Inbox
          </PillButton>

          <PillButton
            variant="outline"
            outlineTone="neutral"
            iconOnly
            icon={LayoutGrid}
            onClick={() => router.push("/usage")}
          >
            Usage
          </PillButton>

          <PillButton
            variant="outline"
            outlineTone="neutral"
            iconOnly
            icon={Settings}
            onClick={() => router.push("/agents")}
          >
            Agents
          </PillButton>

          {/* Full Auto is PER PROJECT — there is no global flag, so the pill
              reports how many projects are armed and opens the per-project
              switches rather than pretending to be one toggle. */}
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
      </DeskHeader>

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
      */}
      <div className="mx-[14px] mt-[10px] grid min-h-[168px] shrink-0 grid-cols-2 gap-3">
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

      <DeskCommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        payload={data}
        onOpenTicket={handleOpenTicket}
        onSelectProject={setActiveProjectId}
      />

      {onToast ? null : (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {/*
            The body stays ink whatever the tone. A toast floats over the desk
            and belongs to no stratum, so it has no deep to borrow — and colour
            here would be encoding state, which the strata do not do either.
            The failure is in the wording (every error message names what
            failed) and in the icon beside it.
          */}
          {toasts.map((toast) => (
            <SurfaceCard
              key={toast.id}
              radius={11}
              data-testid="desk-toast"
              className="flex items-center gap-2 px-[14px] py-[10px] font-sans text-[13px] text-foreground"
            >
              {toast.tone === "success" ? null : (
                <AlertTriangle
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
              )}
              <span>{toast.message}</span>
              {toast.href ? (
                <a href={toast.href} className="text-[12px] whitespace-nowrap underline">
                  {toast.actionLabel || "Open session"}
                </a>
              ) : null}
            </SurfaceCard>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-exported so the project-scoped route can hint the tone union. */
export type { DeskLandRow };
export { projectTone };
