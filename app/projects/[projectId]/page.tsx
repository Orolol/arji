"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { ToastStack, type ToastItem } from "@/components/notifications/ToastStack";
import { useToastStack } from "@/components/notifications/useToastStack";
import { NowDesk } from "@/components/desk/NowDesk";
import { TicketOverlay } from "@/components/ticket/TicketOverlay";
import { UnifiedChatPanel, type UnifiedChatPanelHandle } from "@/components/chat/UnifiedChatPanel";
import { useAgentPolling } from "@/hooks/useAgentPolling";
import { useBatchSelection } from "@/hooks/useBatchSelection";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Hammer, Layers, Loader2, Users, Search, GitMerge, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";
import { EpicCreateDialog } from "@/components/kanban/EpicCreateDialog";
import { NightRunDialog } from "@/components/night/NightRunDialog";
import { NightRunSummaryDialog } from "@/components/night/NightRunSummaryDialog";
import { AutoModeDialog } from "@/components/auto-mode/AutoModeDialog";
import { AutoModeToggle } from "@/components/auto-mode/AutoModeToggle";
import { RefinementButton } from "@/components/kanban/RefinementButton";
import { getActiveDetailTicketId, selectOnlyTicket } from "@/lib/kanban/selection";
import { consumeQueryParam } from "@/lib/navigation/deep-link";
import { useProjectEvents } from "@/hooks/useProjectEvents";

/**
 * `/projects/:id` — the SAME control desk as "/", pre-filtered to one project.
 *
 * The route stays alive because every deep link the project chrome produces
 * lands here (`?ticket=`, `?panel=`, `?night=`, `?nightRun=`, `?deleted=` —
 * see app/projects/[projectId]/layout.tsx), and because the ticket panel, the
 * night dialogs and the batch dispatch toolbar are project-scoped by nature.
 *
 * What this page owns, and the desk does not:
 * - the toast stack (the desk forwards into it through `onToast`);
 * - the URL deep links, each consumed once per value so a re-render cannot
 *   re-fire an imperative open;
 * - batch dispatch — build / review / merge over a multi-selection, reachable
 *   from the desk by ⌘/Ctrl-clicking tickets. The toolbar only exists while
 *   something is selected, so at rest the route is the desk and nothing else.
 */

export default function ProjectDeskPage() {
  const t = useTranslations("Desk");
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const batch = useBatchSelection(projectId);
  const [buildMode, setBuildMode] = useState<"parallel" | "sequential" | "dag">(
    "parallel"
  );
  const [teamModeRequested, setTeamMode] = useState(false);
  const [autoMergeAgent, setAutoMergeAgent] = useState(false);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [batchMerging, setBatchMerging] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [bugDialogOpen, setBugDialogOpen] = useState(false);
  const [epicDialogOpen, setEpicDialogOpen] = useState(false);
  const [nightDialogOpen, setNightDialogOpen] = useState(false);
  const [autoModeDialogOpen, setAutoModeDialogOpen] = useState(false);
  const [nightSummaryRunId, setNightSummaryRunId] = useState<string | null>(null);
  const { toasts, raise: addToast, dismiss: dismissRaised } = useToastStack();
  // Session completions are spotted during render (see below); the tick feeds
  // `refreshKey` and the id list feeds the completion toasts.
  const [completionTick, setCompletionTick] = useState(0);
  const [completedSessionIds, setCompletedSessionIds] = useState<string[]>([]);
  const panelRef = useRef<UnifiedChatPanelHandle>(null);

  // Real-time events via SSE — the desk polls /api/control-desk on its own, but
  // the surfaces this page still owns (agent monitor, ticket panel) refresh on
  // the project's own event stream. pollTick increments when SSE is down.
  const { pollTick } = useProjectEvents(projectId, {
    "ticket:moved": () => setRefreshTrigger((t) => t + 1),
    "ticket:created": () => setRefreshTrigger((t) => t + 1),
    "ticket:updated": () => setRefreshTrigger((t) => t + 1),
    "ticket:deleted": () => setRefreshTrigger((t) => t + 1),
    "session:started": () => setRefreshTrigger((t) => t + 1),
    "session:completed": () => setRefreshTrigger((t) => t + 1),
    "session:failed": () => setRefreshTrigger((t) => t + 1),
    "session:progress": () => setRefreshTrigger((t) => t + 1),
    "artifact:created": () => setRefreshTrigger((t) => t + 1),
    "release:created": () => setRefreshTrigger((t) => t + 1),
  });

  // Fallback for when SSE is down and polling takes over. All three counters
  // only ever mean "something changed, reload", so the refresh key is their
  // sum rather than an effect copying one into another.
  const refreshKey = refreshTrigger + pollTick + completionTick;

  const { activities } = useAgentPolling(projectId, 3000, refreshKey);

  // Team mode is a decision about the selection that was standing when the box
  // was ticked. Falling below two tickets retires it outright: merely masking
  // it lets a later re-selection resurrect a `team: true` build the user never
  // asked for a second time. Adjusting state during render is React's own
  // answer to "reset when a value changes" — the reset lands in this same pass,
  // before anything is committed, so no one ever observes the stale value.
  if (teamModeRequested && batch.allSelected.size < 2) {
    setTeamMode(false);
  }

  const teamMode = teamModeRequested && batch.allSelected.size >= 2;

  const activeDetailTicketId = getActiveDetailTicketId(batch.selectedTicketIds);

  function handlePrimaryTicketClick(epicId: string) {
    batch.setSelectedTicketIds(selectOnlyTicket(epicId));
  }

  function handleCloseDetailPanel() {
    batch.clear();
  }

  // Refresh when the project layout imports arji.json.
  useEffect(() => {
    const onSynced = () => setRefreshTrigger((t) => t + 1);
    window.addEventListener("arji:synced", onSynced);
    return () => window.removeEventListener("arji:synced", onSynced);
  }, []);

  /**
   * A refinement pass reshapes columns, priorities and dependency edges
   * without emitting one event per write, so everything is reloaded once when
   * the pass ends rather than trusting the incremental SSE stream.
   */
  const handleRefinementFinished = useCallback(() => {
    setRefreshTrigger((t) => t + 1);
    addToast("success", "Board refinement finished — see the notification for the summary");
  }, [addToast]);

  // ?deleted=story|epic — the notice the deleted ticket's own page hands over.
  //
  // Derived from the deep link; ToastStack owns its dismissal lifecycle.
  const deletedParam = searchParams.get("deleted");
  const [handledDeleted, setHandledDeleted] = useState<string | null>(null);
  const [deletedNotice, setDeletedNotice] = useState<string | null>(null);

  if (deletedParam !== handledDeleted) {
    setHandledDeleted(deletedParam);
    if (deletedParam === "story") {
      setDeletedNotice("User story deleted permanently");
    } else if (deletedParam === "epic") {
      setDeletedNotice("Epic deleted permanently");
    }
  }

  const dismissToast = useCallback((id: string) => {
    if (id === "deleted-notice") setDeletedNotice(null);
    else dismissRaised(id);
  }, [dismissRaised]);

  const visibleToasts: readonly ToastItem[] = deletedNotice
    ? [...toasts, { id: "deleted-notice", type: "success", message: deletedNotice }]
    : toasts;

  useEffect(() => {
    if (!searchParams.get("deleted")) return;
    consumeQueryParam(searchParams, "deleted", `/projects/${projectId}`);
  }, [projectId, searchParams]);

  // Deep link: /projects/<id>?ticket=<epicId> opens the ticket detail
  // (used by "Agent asked a question" notifications), then strips the param.
  //
  // Consumed once per value, like ?panel= and ?night= below, and for a sharper
  // reason: `useRouter()` is memoised on the closest CacheNode's bfcache id, so
  // every committed navigation hands this effect a new `router` and re-runs it.
  // Without the ref that re-opens the overlay the user has just closed.
  const handledTicketParam = useRef<string | null>(null);

  useEffect(() => {
    const ticket = searchParams.get("ticket");
    if (!ticket) {
      handledTicketParam.current = null;
      return;
    }
    if (handledTicketParam.current === ticket) return;
    handledTicketParam.current = ticket;

    batch.setSelectedTicketIds(selectOnlyTicket(ticket));

    consumeQueryParam(searchParams, "ticket", `/projects/${projectId}`);
  }, [batch.setSelectedTicketIds, projectId, searchParams]);

  // Header actions live in the project chrome (a layout that outlives this
  // page), so they reach this route through the URL rather than through a
  // shared event bus: ?panel=chat|new-epic|new-epic-manual|new-bug, stripped
  // once handled. Consumed once per value: opening the chat is an imperative
  // act, and the ref keeps a re-render (or a replace() that has not landed
  // yet) from firing it a second time or re-opening a dialog just closed.
  const handledPanelParam = useRef<string | null>(null);

  // The two dialogs this can open are plain state of this component, so they
  // are opened during render; the imperative panel calls and the URL rewrite
  // remain side effects and stay in the effect below.
  const panelParam = searchParams.get("panel");
  const [handledPanel, setHandledPanel] = useState<string | null>(null);

  if (panelParam !== handledPanel) {
    setHandledPanel(panelParam);
    if (panelParam === "new-epic-manual") {
      setEpicDialogOpen(true);
    } else if (panelParam === "new-bug") {
      setBugDialogOpen(true);
    }
  }

  useEffect(() => {
    const panel = searchParams.get("panel");
    if (!panel) {
      handledPanelParam.current = null;
      return;
    }
    if (handledPanelParam.current === panel) return;
    handledPanelParam.current = panel;

    if (panel === "chat") {
      panelRef.current?.openChat();
    } else if (panel === "new-epic") {
      panelRef.current?.openNewEpic();
    }

    consumeQueryParam(searchParams, "panel", `/projects/${projectId}`);
  }, [projectId, searchParams]);

  // Same mechanism for the header's Night run button: ?night=start. The dialog
  // is this component's state, so it opens during render and only the URL
  // rewrite is left to an effect.
  const nightParam = searchParams.get("night");
  const [handledNight, setHandledNight] = useState<string | null>(null);

  if (nightParam !== handledNight) {
    setHandledNight(nightParam);
    if (nightParam === "start") {
      setNightDialogOpen(true);
    }
  }

  useEffect(() => {
    if (searchParams.get("night") !== "start") return;
    consumeQueryParam(searchParams, "night", `/projects/${projectId}`);
  }, [projectId, searchParams]);

  // Deep link: /projects/<id>?nightRun=<runId> opens the morning summary
  // (used by the "Night run finished" notification), then strips the param.
  const nightRunParam = searchParams.get("nightRun");
  const [handledNightRun, setHandledNightRun] = useState<string | null>(null);

  if (nightRunParam !== handledNightRun) {
    setHandledNightRun(nightRunParam);
    if (nightRunParam) {
      setNightSummaryRunId(nightRunParam);
    }
  }

  useEffect(() => {
    if (!searchParams.get("nightRun")) return;
    consumeQueryParam(searchParams, "nightRun", `/projects/${projectId}`);
  }, [projectId, searchParams]);

  // Detect session completions for notifications + refresh. The disappearance
  // is spotted during render — keyed on the joined id list, a primitive, so the
  // comparison cannot differ on every render — and the per-session lookup that
  // turns it into a toast stays in the effect below.
  const activityIdsKey = activities.map((a) => a.id).join("|");
  const [seenActivities, setSeenActivities] = useState<{
    key: string;
    ids: Set<string>;
  }>(() => ({ key: activityIdsKey, ids: new Set(activities.map((a) => a.id)) }));

  if (seenActivities.key !== activityIdsKey) {
    const currentIds = new Set(activities.map((a) => a.id));
    const gone = [...seenActivities.ids].filter((id) => !currentIds.has(id));
    setSeenActivities({ key: activityIdsKey, ids: currentIds });
    if (gone.length > 0) {
      setCompletedSessionIds(gone);
      setCompletionTick((t) => t + 1);
    }
  }

  useEffect(() => {
    if (completedSessionIds.length === 0) return;
    let cancelled = false;

    for (const prevId of completedSessionIds) {
      fetch(`/api/projects/${projectId}/sessions/${prevId}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled || !d.data) return;
          const s = d.data;
          if (s.status === "completed") {
            addToast("success", `Agent #${prevId.slice(0, 6)} completed`);
          } else if (s.status === "failed") {
            addToast(
              "error",
              `Agent #${prevId.slice(0, 6)} failed: ${s.error || "Unknown error"}`
            );
          }
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [completedSessionIds, projectId, addToast]);

  async function handleBuild() {
    if (batch.allSelected.size === 0) return;
    setBuilding(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicIds: Array.from(batch.allSelected),
          mode: buildMode,
          team: teamMode,
          namedAgentId,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        if (
          res.status === 409 &&
          data.code === "AGENT_ALREADY_RUNNING" &&
          data.data?.activeSessionId
        ) {
          addToast("error", data.error, {
            href:
              data.data.sessionUrl ||
              `/projects/${projectId}/sessions/${data.data.activeSessionId}`,
            label: "Open active session",
          });
        } else {
          addToast("error", data.error || "Failed to launch build");
        }
      } else {
        addToast(
          "success",
          teamMode
            ? `Launched team build session coordinating ${batch.allSelected.size} epics`
            : data.data.orchestrationMode === "dag"
              ? `Launched wave 1/${data.data.waves} — later waves start as dependencies finish`
              : `Launched ${data.data.count} build session${data.data.count > 1 ? "s" : ""}`
        );
        batch.clear();
        setRefreshTrigger((t) => t + 1);
      }
    } catch {
      addToast("error", "Failed to launch build");
    }

    setBuilding(false);
  }

  async function handleBatchReview() {
    if (batch.allSelected.size === 0) return;
    setReviewing(true);

    let launched = 0;
    for (const epicId of batch.allSelected) {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reviewTypes: ["code_review"],
              namedAgentId,
            }),
          }
        );
        if (res.ok) launched++;
      } catch {
        // continue with other epics
      }
    }

    if (launched > 0) {
      addToast("success", `Launched review for ${launched} epic${launched > 1 ? "s" : ""}`);
      batch.clear();
      setRefreshTrigger((t) => t + 1);
    } else {
      addToast("error", "Failed to launch any reviews");
    }
    setReviewing(false);
  }

  async function handleBatchMerge() {
    if (batch.allSelected.size === 0) return;
    setBatchMerging(true);

    let merged = 0;
    let failed = 0;
    let agentLaunched = 0;
    for (const epicId of batch.allSelected) {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ autoAgent: autoMergeAgent }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.data?.autoAgent) {
            agentLaunched++;
          } else {
            merged++;
          }
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    if (merged > 0) {
      addToast("success", `Merged ${merged} epic${merged > 1 ? "s" : ""}`);
    }
    if (agentLaunched > 0) {
      addToast(
        "success",
        `Launched merge-fix agent for ${agentLaunched} epic${agentLaunched > 1 ? "s" : ""}`
      );
    }
    if (failed > 0) {
      addToast("error", `${failed} merge${failed > 1 ? "s" : ""} failed`);
    }
    batch.clear();
    setRefreshTrigger((t) => t + 1);
    setBatchMerging(false);
  }

  const totalSelected = batch.allSelected.size;
  const autoCount = batch.autoIncluded.size;
  const canTeamMode = totalSelected >= 2;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {/* The ticket is a modal over a still-live desk now (frame 6a), not a
            column beside the chat: it is rendered below, outside the chat
            panel, so the desk keeps receiving SSE and keeps ticking behind
            the scrim. The chat panel keeps its own view to itself. */}
        <UnifiedChatPanel
          projectId={projectId}
          ref={panelRef}
          onEpicCreated={() => setRefreshTrigger((t) => t + 1)}
        >
          <div className="flex h-full flex-col">
            {/* Project-scoped controls the desk's own chrome does not carry:
                the Full Auto CONFIGURATION dialog (the header pill is an on/off
                switch) and the Refinement pass. */}
            <div
              className="flex h-[46px] shrink-0 items-center gap-[12px] border-b border-border bg-card px-[22px]"
              data-testid="board-capture-bar"
            >
              <AutoModeToggle
                projectId={projectId}
                onOpen={() => setAutoModeDialogOpen(true)}
                refreshTrigger={refreshKey}
              />
              <RefinementButton
                projectId={projectId}
                refreshTrigger={refreshKey}
                onError={(message) => addToast("error", message)}
                onNotice={(message) => addToast("success", message)}
                onStarted={() =>
                  addToast(
                    "success",
                    "Agent Refinement started — re-passing Backlog and To do"
                  )
                }
                onFinished={handleRefinementFinished}
              />
              <span className="ml-auto truncate text-[12.5px] text-muted-foreground">
                {t("projectDesk.selectHint")}
              </span>
            </div>

            {/* Batch action toolbar — only while something is selected. */}
            {totalSelected > 0 && (
              <div className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-[10px] border-b border-border bg-card px-[22px] py-[8px]">
                <span className="text-[13px] font-medium">
                  {batch.userSelected.size} epic{batch.userSelected.size > 1 ? "s" : ""} selected
                  {autoCount > 0 && (
                    <span className="ml-[8px] font-normal text-agent">
                      +{autoCount} required
                    </span>
                  )}
                </span>

                <NamedAgentSelect
                  value={namedAgentId}
                  onChange={setNamedAgentId}
                  dispatchRole="build"
                />

                <Select
                  value={buildMode}
                  onValueChange={(v) =>
                    setBuildMode(v as "parallel" | "sequential" | "dag")
                  }
                >
                  <SelectTrigger className="h-[29px] w-32 rounded-[7px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">Parallel</SelectItem>
                    <SelectItem value="sequential">Sequential</SelectItem>
                    <SelectItem value="dag">Waves (DAG)</SelectItem>
                  </SelectContent>
                </Select>

                {/* Waves mode explainer — visible only when selected */}
                {buildMode === "dag" && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-testid="dag-mode-hint"
                          className="flex cursor-help items-center gap-1 text-[12.5px] text-meta"
                        >
                          <Layers className="h-3 w-3" />
                          Waves
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Dependencies build first: epics run in dependency
                        waves, each wave waiting for the previous one. A
                        failed epic (or one that asks a question) skips its
                        dependents.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Team mode checkbox — visible when 2+ epics selected */}
                {totalSelected >= 2 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-1.5 text-[12.5px]",
                            !canTeamMode && "cursor-not-allowed opacity-50"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={teamMode}
                            onChange={(e) => setTeamMode(e.target.checked)}
                            disabled={!canTeamMode}
                            className="h-3.5 w-3.5 rounded border-border"
                          />
                          <Users className="h-3 w-3" />
                          Team mode
                        </label>
                      </TooltipTrigger>
                      <TooltipContent>
                        {"Launch a single CC session that coordinates sub-agents for each epic"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Merge auto-fix — sits with its Merge all button on the right */}
                {totalSelected >= 2 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                          <input
                            type="checkbox"
                            checked={autoMergeAgent}
                            onChange={(e) => setAutoMergeAgent(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-border"
                            data-testid="auto-merge-agent-checkbox"
                          />
                          <Bot className="h-3 w-3" />
                          Auto-fix
                        </label>
                      </TooltipTrigger>
                      <TooltipContent>
                        When a merge fails, automatically launch an agent to resolve conflicts
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                <div className="ml-auto flex flex-wrap items-center gap-[8px]">
                  <Button
                    size="sm"
                    onClick={handleBuild}
                    disabled={building}
                    className="h-[29px] rounded-[7px] text-[12.5px]"
                  >
                    {building ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                    ) : teamMode ? (
                      <Users className="h-3 w-3 mr-1" />
                    ) : (
                      <Hammer className="h-3 w-3 mr-1" />
                    )}
                    {teamMode ? "Build as Team" : "Build all"}
                  </Button>

                  {/* Review all — appears when multiple selected */}
                  {totalSelected >= 2 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchReview}
                      disabled={reviewing}
                      className="h-[29px] rounded-[7px] text-[12.5px]"
                    >
                      {reviewing ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                      ) : (
                        <Search className="h-3 w-3 mr-1" />
                      )}
                      Review all
                    </Button>
                  )}

                  {/* Merge all — appears when multiple selected */}
                  {totalSelected >= 2 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchMerge}
                      disabled={batchMerging}
                      className="h-[29px] rounded-[7px] text-[12.5px]"
                    >
                      {batchMerging ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                      ) : (
                        <GitMerge className="h-3 w-3 mr-1" />
                      )}
                      Merge all
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={batch.clear}
                    className="h-[29px] rounded-[7px] text-[12.5px] text-meta"
                  >
                    Clear
                  </Button>
                </div>
              </div>
            )}

            <div className="relative min-h-0 flex-1 overflow-hidden">
              <NowDesk
                projectId={projectId}
                onToast={addToast}
                onChanged={() => setRefreshTrigger((t) => t + 1)}
                selectedEpicIds={batch.allSelected}
                onToggleSelect={batch.toggle}
                onOpenTicket={handlePrimaryTicketClick}
              />
            </div>
          </div>
        </UnifiedChatPanel>
      </div>

      {/* The ticket overlay. `?ticket=<epicId>` and a plain desk click both
          land in the batch selection, and the selection's active ticket is
          what opens here — one source of truth for "which ticket is open",
          so closing the overlay clears the selection and vice versa. */}
      {activeDetailTicketId && (
        <TicketOverlay
          projectId={projectId}
          epicId={activeDetailTicketId}
          open
          refreshTrigger={refreshKey}
          onClose={handleCloseDetailPanel}
          onAgentConflict={({ message, sessionUrl }) =>
            addToast(
              "error",
              message,
              sessionUrl
                ? { href: sessionUrl, label: "Open active session" }
                : undefined
            )
          }
          onMerged={() => {
            setRefreshTrigger((t) => t + 1);
            addToast("success", "Branch merged into main");
          }}
          onDeleted={() => {
            setRefreshTrigger((t) => t + 1);
            addToast("success", "Epic deleted permanently");
          }}
        />
      )}

      <ToastStack items={visibleToasts} onDismiss={dismissToast} testId="board-toast" />

      <EpicCreateDialog
        projectId={projectId}
        open={epicDialogOpen}
        onOpenChange={setEpicDialogOpen}
        onCreated={() => {
          setRefreshTrigger((t) => t + 1);
          addToast("success", "Epic created");
        }}
      />

      <BugCreateDialog
        projectId={projectId}
        open={bugDialogOpen}
        onOpenChange={setBugDialogOpen}
        onCreated={() => setRefreshTrigger((t) => t + 1)}
        namedAgentId={namedAgentId}
      />

      <NightRunDialog
        projectId={projectId}
        open={nightDialogOpen}
        onOpenChange={setNightDialogOpen}
        defaultNamedAgentId={namedAgentId}
        onStarted={(result) => {
          addToast("success", result.message);
          setRefreshTrigger((t) => t + 1);
        }}
        onError={(message) => addToast("error", message)}
      />

      <AutoModeDialog
        projectId={projectId}
        open={autoModeDialogOpen}
        onOpenChange={setAutoModeDialogOpen}
        defaultNamedAgentId={namedAgentId}
        onSaved={(status) => {
          addToast(
            "success",
            status.enabled
              ? `Full Auto Mode is on — ${status.candidates.build} to build, ${status.candidates.review} to review`
              : "Full Auto Mode is off"
          );
          setRefreshTrigger((t) => t + 1);
        }}
        onError={(message) => addToast("error", message)}
      />

      <NightRunSummaryDialog
        projectId={projectId}
        runId={nightSummaryRunId}
        open={nightSummaryRunId !== null}
        onOpenChange={(open) => {
          if (!open) setNightSummaryRunId(null);
        }}
      />

    </div>
  );
}
