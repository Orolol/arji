"use client";

import { useCallback, useMemo, useState } from "react";

import { AlertTriangle } from "lucide-react";

import { Mono, SurfaceCard } from "@/components/piscine";
import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import { useQaFindings } from "@/hooks/useQaFindings";
import { QA_COVERAGE_DAYS, type QaFinding, type QaReviewTarget } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

import { DismissDialog } from "./DismissDialog";
import { FindingsBand } from "./FindingsBand";
import {
  applyFindingFilter,
  type FindingFilter,
} from "./FindingFilterPills";
import { QaRunsBand } from "./QaRunsBand";
import { RubricBand } from "./RubricBand";
import { RunQaPassButton } from "./RunQaPassButton";
import { VerdictsBand } from "./VerdictsBand";

/**
 * QA — the cross-project review layer (frame 11b).
 *
 * Four strata, top to bottom: QA RUNS (turquoise) → FINDINGS À ARBITRER
 * (coral, the one band that grows) → VERDICTS RÉCENTS (sun) | LA RUBRIQUE
 * (pool). Everything comes from ONE poll of `GET /api/qa/findings`; see
 * `hooks/useQaFindings.ts` for why it polls at 8 s rather than the desk's 4 s.
 *
 * NO PAGE HEADER. `components/piscine/TopBar.tsx` is mounted once by
 * `app/layout.tsx` and owns the logo, the project chips, ⌘K, the inbox, Auto
 * and "New" on every route. The per-screen controls (the coverage stat and
 * "Run QA pass") live in a second row inside this screen's own content area.
 *
 * NOTHING HERE APPROVES A TICKET. The merge is the approval. Dismiss resolves
 * exactly one finding and records why; Fix with agent dispatches a build; Run
 * QA pass dispatches a review. No status is moved from this screen.
 */
export type QaToastTone = "success" | "error" | "warning";

export interface QaToastAction {
  href: string;
  label?: string;
}

export interface QaScreenProps {
  /** Pre-filter the screen to one project. The `/qa` route renders it unfiltered. */
  projectId?: string | null;
  /** Host-owned toast sink. Omit and the screen renders its own stack. */
  onToast?: (tone: QaToastTone, message: string, action?: QaToastAction) => void;
  className?: string;
}

interface QaToast {
  id: string;
  tone: QaToastTone;
  message: string;
  href?: string;
  actionLabel?: string;
}

/** The 409 payload shape, from `lib/agents/client-error.ts`. */
interface DispatchErrorBody {
  error?: string;
  code?: string;
  data?: { activeSessionId?: string; sessionUrl?: string };
}

export function QaScreen({ projectId, onToast, className }: QaScreenProps) {
  const { openTicket } = useTicketOverlay();
  const { data, error, refresh } = useQaFindings(projectId ?? null);

  const [filter, setFilter] = useState<FindingFilter>("all");
  const [toasts, setToasts] = useState<QaToast[]>([]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [dismissTarget, setDismissTarget] = useState<QaFinding | null>(null);
  const [dismissPending, setDismissPending] = useState(false);
  const [runPending, setRunPending] = useState(false);

  const raise = useCallback(
    (tone: QaToastTone, message: string, action?: QaToastAction) => {
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

  const markPending = useCallback((findingId: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(findingId);
      else next.delete(findingId);
      return next;
    });
  }, []);

  /**
   * 409 AGENT_ALREADY_RUNNING is not an error the user can do anything with
   * unless the toast can take them to the session that is in the way.
   */
  const reportFailure = useCallback(
    (
      res: Response,
      body: DispatchErrorBody,
      fallback: string,
      ownerProjectId: string,
    ) => {
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

  /* ---- derived ------------------------------------------------------ */

  const projects = useMemo(() => data?.projects ?? [], [data]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const findings = useMemo(() => data?.findings ?? [], [data]);
  const visibleFindings = useMemo(
    () => applyFindingFilter(findings, filter),
    [findings, filter],
  );

  const coverage =
    data?.coveragePercent === null || data?.coveragePercent === undefined
      ? "—"
      : `${data.coveragePercent}%`;

  const handleOpenTicket = useCallback(
    (epicId: string, ownerProjectId?: string | null) => {
      openTicket(epicId, { projectId: ownerProjectId ?? projectId ?? null });
    },
    [openTicket, projectId],
  );

  /* ---- mutations ----------------------------------------------------- */

  /**
   * "Fix with agent" — the existing finding→build dispatch.
   *
   * There is no dedicated finding→build route. `components/review/
   * ReviewActions.tsx` formats open findings into a markdown comment and hands
   * it to the epic build; this reproduces that markdown EXACTLY, scoped to one
   * finding, so the builder's prompt sees a format it has seen since long
   * before this screen existed. No `namedAgentId` and no `pipeline`: omitting
   * `pipeline` lets the server's `pipeline_enabled` setting chain decide.
   */
  const handleFix = useCallback(
    async (finding: QaFinding) => {
      markPending(finding.findingId, true);
      try {
        const comment = [
          "## Review Comments\n",
          `### ${finding.filePath}`,
          `- **Line ${finding.lineNumber}**: ${finding.rawBody}`,
          "",
        ].join("\n");

        const res = await fetch(
          `/api/projects/${finding.projectId}/epics/${finding.epicId}/build`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ comment }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to launch the build", finding.projectId);
          return;
        }
        raise("success", "Build ciblé lancé sur le finding");
        await refresh();
      } catch {
        raise("error", "Failed to launch the build");
      } finally {
        markPending(finding.findingId, false);
      }
    },
    [markPending, raise, reportFailure, refresh],
  );

  /**
   * Dismiss — two writes through routes that already exist, because
   * `review_comments` has NO dismissal-reason column and this packet may not
   * add one. See `DismissDialog`'s header for the full argument.
   *
   * If the ticket-comment echo fails the first write is NOT rolled back:
   * losing the dismissal is worse than losing its echo.
   */
  const handleDismiss = useCallback(
    async (finding: QaFinding, reason: string) => {
      setDismissPending(true);
      markPending(finding.findingId, true);
      try {
        const res = await fetch(
          `/api/projects/${finding.projectId}/epics/${finding.epicId}/review-comments`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: finding.findingId,
              status: "resolved",
              body: `${finding.rawBody}\n\n[dismissed] ${reason}`,
            }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          raise("error", body.error || "Failed to dismiss the finding");
          return;
        }

        const echoed = await fetch(
          `/api/projects/${finding.projectId}/epics/${finding.epicId}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              author: "user",
              content: `**Finding dismissed** on \`${finding.filePath}:${finding.lineNumber}\`\n\n${reason}`,
            }),
          },
        )
          .then((response) => response.ok)
          .catch(() => false);

        if (echoed) raise("success", "Finding dismissed");
        else {
          raise(
            "warning",
            "Finding dismissed, mais la raison n'a pas été enregistrée dans le ticket",
          );
        }

        setDismissTarget(null);
        await refresh();
      } catch {
        raise("error", "Failed to dismiss the finding");
      } finally {
        markPending(finding.findingId, false);
        setDismissPending(false);
      }
    },
    [markPending, raise, refresh],
  );

  /**
   * "Run QA pass" — one review session on one ticket.
   *
   * `feature_review` is the app's own default everywhere a review is
   * dispatched by hand (the ticket overlay, the agent actions bar). Sending all
   * four types would create four sessions on one ticket: the route creates one
   * per review type.
   */
  const handleRunPass = useCallback(
    async (target: QaReviewTarget) => {
      setRunPending(true);
      try {
        const res = await fetch(
          `/api/projects/${target.projectId}/epics/${target.epicId}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reviewTypes: ["feature_review"] }),
          },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) {
          reportFailure(res, body, "Failed to launch the review", target.projectId);
          return;
        }
        raise("success", "Review lancée");
        await refresh();
      } catch {
        raise("error", "Failed to launch the review");
      } finally {
        setRunPending(false);
      }
    },
    [raise, reportFailure, refresh],
  );

  const handleStopRun = useCallback(
    async (sessionId: string) => {
      const run = data?.runs.find((row) => row.sessionId === sessionId);
      if (!run) return;
      try {
        const res = await fetch(
          `/api/projects/${run.projectId}/sessions/${sessionId}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          raise("error", "Failed to stop the session");
          return;
        }
        raise("success", "Session stopped");
        await refresh();
      } catch {
        raise("error", "Failed to stop the session");
      }
    },
    [data, raise, refresh],
  );

  /* ---- render -------------------------------------------------------- */

  return (
    <div
      data-testid="qa-screen"
      className={cn(
        "flex w-full flex-col bg-background font-sans text-foreground",
        // ONE SCREENFUL IS A DESKTOP MODEL. `h-full` + a growing band means the
        // bands share a fixed height and the coral one absorbs what is left —
        // which on a phone is nothing, so the findings and their actions were
        // squeezed to a zero-height scroller (B-arij-iL4-FmyXgGr). Below `lg`
        // the screen is as tall as its content and `app/layout.tsx`'s <main>
        // scrolls it, the way a phone page is read.
        "min-h-full lg:h-full lg:min-h-0",
        className,
      )}
    >
      {/* Second row: the per-screen controls the global bar does not own. */}
      <div className="flex shrink-0 items-center gap-2 px-[14px] pt-[10px] pb-[2px]">
        <div className="ml-auto flex items-center gap-2">
          {/* Space Mono is non-variable: 700 is the only heavier weight, and
              `Mono` takes no arbitrary DOM props, so the test id sits on a
              wrapper rather than on the primitive. */}
          <span data-testid="qa-coverage">
            <Mono size={11} tone="muted">
              {"review coverage "}
              <Mono size={11} weight={700} tone="ink">
                {coverage}
              </Mono>
              {` · ${QA_COVERAGE_DAYS}j`}
            </Mono>
          </span>
          <RunQaPassButton
            targets={data?.reviewable ?? []}
            projectsById={projectsById}
            onRun={handleRunPass}
            pending={runPending}
          />
        </div>
      </div>

      {/* An error never blanks the payload: the bands keep their last good
          data and the failure is one line under the second row. */}
      {error ? (
        <div
          data-testid="qa-error"
          className="shrink-0 px-[14px] pb-[4px] font-sans text-[12.5px] text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-[12px] px-[14px] pb-[14px] lg:min-h-0 lg:flex-1">
        <QaRunsBand
          runs={data?.runs ?? []}
          queued={data?.queued ?? []}
          projectsById={projectsById}
          onOpenTicket={(epicId) => handleOpenTicket(epicId)}
          onStopRun={handleStopRun}
        />

        <FindingsBand
          findings={findings}
          visible={visibleFindings}
          filter={filter}
          onFilterChange={setFilter}
          projectsById={projectsById}
          pendingIds={pendingIds}
          onFix={handleFix}
          // One click gets the user to the ticket; its own Diff control reaches
          // the diff view. `OpenTicketOptions` has no "open on the diff" flag
          // and `components/ticket/*` is not this packet's to extend.
          onDiff={(finding) => handleOpenTicket(finding.epicId, finding.projectId)}
          onDismiss={(finding) => setDismissTarget(finding)}
        />

        {/* The bottom split stacks on a phone. Two columns of a 390px screen
            are 145px each: the verdict rows lose their ticket chip to the
            column edge and the rubric chips wrap inside a 27px pill. Stacking
            also gives the coral band above — the one band on 11b that grows —
            the height its rows need. Unchanged from `lg` up. */}
        <div className="grid shrink-0 grid-cols-1 gap-[12px] lg:grid-cols-2">
          <VerdictsBand
            verdicts={data?.verdicts ?? []}
            projectsById={projectsById}
            onOpenTicket={(epicId) => {
              const verdict = data?.verdicts.find((row) => row.epicId === epicId);
              handleOpenTicket(epicId, verdict?.projectId);
            }}
          />
          <RubricBand
            rubric={data?.rubric ?? { items: [], projectRuleCount: 0 }}
          />
        </div>
      </div>

      <DismissDialog
        finding={dismissTarget}
        open={dismissTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDismissTarget(null);
        }}
        onConfirm={handleDismiss}
        pending={dismissPending}
      />

      {onToast ? null : (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {/* The body stays ink whatever the tone: a toast floats over the
              screen and belongs to no stratum, so it has no deep to borrow. */}
          {toasts.map((toast) => (
            <SurfaceCard
              key={toast.id}
              radius={11}
              data-testid="qa-toast"
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
