"use client";

import { useCallback, useMemo, useState } from "react";

import { Mono } from "@/components/piscine";
import {
  ToastStack,
  type ToastAction,
  type ToastTone,
} from "@/components/notifications/ToastStack";
import {
  useDispatchFailureReporter,
  useToastStack,
} from "@/components/notifications/useToastStack";
import { useTicketOverlay } from "@/components/ticket/TicketOverlayProvider";
import { useQaFindings } from "@/hooks/useQaFindings";
import { sumCheckTotals } from "@/lib/qa/aggregate";
import { QA_COVERAGE_DAYS, type QaFinding, type QaReviewTarget } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

import { DismissDialog } from "./DismissDialog";
import { FindingsBand } from "./FindingsBand";
import {
  applyFindingFilter,
  type FindingFilter,
} from "./FindingFilterPills";
import { NewQaCheckButton } from "./NewQaCheckButton";
import { QaChecksBand } from "./QaChecksBand";
import { QaRunsBand } from "./QaRunsBand";
import { RubricBand } from "./RubricBand";
import { RunQaPassButton } from "./RunQaPassButton";
import { StartQaCheckDialog } from "./StartQaCheckDialog";
import { VerdictsBand } from "./VerdictsBand";

/**
 * QA — the cross-project review layer (frame 11b).
 *
 * Strata, top to bottom: QA RUNS (turquoise) → QA CHECKS (linden) → FINDINGS À
 * ARBITRER (coral, the one band that grows) → VERDICTS RÉCENTS (sun) | LA
 * RUBRIQUE (pool). Everything comes from ONE poll of `GET /api/qa/findings`;
 * see `hooks/useQaFindings.ts` for why it polls at 8 s rather than the desk's
 * 4 s.
 *
 * NO PAGE HEADER. `components/piscine/TopBar.tsx` is mounted once by
 * `app/layout.tsx` and owns the logo, the project chips, ⌘K, the inbox, Auto
 * and "New" on every route. The per-screen controls (the coverage stat and
 * "Run QA pass") live in a second row inside this screen's own content area.
 *
 * NOTHING HERE APPROVES A TICKET. The merge is the approval. Dismiss resolves
 * exactly one finding and records why; Fix with agent dispatches a build; Run
 * QA pass dispatches a review; New check dispatches a tech check, an E2E pass
 * or a failure digest. No status is moved from this screen.
 *
 * TWO KINDS OF QA LIVE HERE, and they are different work. A REVIEW is bound to
 * a ticket and files findings — QA RUNS, FINDINGS, VERDICTS. A CHECK is the
 * project-wide QA agent and produces a `qa_reports` document — QA CHECKS. The
 * redesign moved the nav's QA entry to this screen while the checks stayed
 * behind on `/projects/:id/qa`, which is how "run a tech check" stopped being
 * reachable; the QA CHECKS band and its "New check" button are that entry
 * point, and the band's rows link to the report on the screen that draws it.
 */
export type QaToastTone = ToastTone;
export type QaToastAction = ToastAction;

export interface QaScreenProps {
  /** Pre-filter the screen to one project. The `/qa` route renders it unfiltered. */
  projectId?: string | null;
  /** Host-owned toast sink. Omit and the screen renders its own stack. */
  onToast?: (tone: QaToastTone, message: string, action?: QaToastAction) => void;
  className?: string;
}

export function QaScreen({ projectId, onToast, className }: QaScreenProps) {
  const { openTicket } = useTicketOverlay();
  const { data, error, refresh } = useQaFindings(projectId ?? null);

  const [filter, setFilter] = useState<FindingFilter>("all");
  const { toasts, raise, dismiss: dismissToast } = useToastStack(onToast);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [dismissTarget, setDismissTarget] = useState<QaFinding | null>(null);
  const [dismissPending, setDismissPending] = useState(false);
  const [runPending, setRunPending] = useState(false);
  /**
   * The project the QA-check dialog is composing for, or `null` when it is
   * closed. It holds the id rather than a boolean because `/qa` is
   * cross-project and `POST /api/projects/{p}/qa/check` is not: the choice made
   * in the button IS the dialog's scope.
   */
  const [checkProjectId, setCheckProjectId] = useState<string | null>(null);

  const markPending = useCallback((findingId: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(findingId);
      else next.delete(findingId);
      return next;
    });
  }, []);

  const reportFailure = useDispatchFailureReporter(raise);

  /* ---- derived ------------------------------------------------------ */

  const projects = useMemo(() => data?.projects ?? [], [data]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const checks = useMemo(() => data?.checks ?? [], [data]);
  /**
   * The band's meta. Summed over the projects IN SCOPE rather than read off
   * `checks`, which is a `QA_CHECK_LIMIT` window and would print a constant —
   * and `projects` is already narrowed by `filterQaPayload`, so a
   * project-scoped mount counts that project alone.
   */
  const checkTotals = useMemo(
    () =>
      sumCheckTotals(
        data?.checkTotals ?? {},
        projects.map((project) => project.id),
      ),
    [data, projects],
  );
  /**
   * The projects "New check" may offer. The route decides, not the screen: a
   * project with no `git_repo_path` is refused with a 400, and the payload
   * already carries the answer as `checkableProjectIds`.
   */
  const checkableProjects = useMemo(() => {
    const allowed = new Set(data?.checkableProjectIds ?? []);
    return projects.filter((project) => allowed.has(project.id));
  }, [data, projects]);
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

  /**
   * A QA check was accepted. Two different things can have happened, and the
   * toast must not tell them apart wrongly:
   *
   * - a session was queued (`sessionId`), and the band will show it running on
   *   the next poll — `refresh()` pulls that forward;
   * - an EMPTY failure digest (`noOp`), which the route journals as a completed
   *   report WITHOUT launching an agent. Announcing "check started" for that
   *   would be a lie about work that will never appear in QA RUNS.
   *
   * Either way the toast carries the deep link to the report, because the
   * report is drawn by `/projects/:id/qa` and not by this screen.
   */
  const handleCheckStarted = useCallback(
    (started: { reportId: string; sessionId: string | null; noOp?: boolean }) => {
      const target = checkProjectId;
      setCheckProjectId(null);
      raise(
        "success",
        started.noOp
          ? "Aucune évidence dans la fenêtre : rapport enregistré, aucun agent lancé"
          : "QA check lancé",
        target
          ? {
              href: `/projects/${target}/qa?reportId=${started.reportId}`,
              label: "Voir le rapport",
            }
          : undefined,
      );
      void refresh();
    },
    [checkProjectId, raise, refresh],
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

        <QaChecksBand
          checks={checks}
          totals={checkTotals}
          projectsById={projectsById}
          action={
            <NewQaCheckButton
              projects={checkableProjects}
              onSelect={setCheckProjectId}
            />
          }
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

      {/* Mounted only while a project is chosen: the dialog takes its project
          id as a prop and loads the saved prompts when it opens, so a fresh
          mount per choice is what keeps those two in step. */}
      {checkProjectId ? (
        <StartQaCheckDialog
          key={checkProjectId}
          projectId={checkProjectId}
          open
          onOpenChange={(next) => {
            if (!next) setCheckProjectId(null);
          }}
          onStarted={handleCheckStarted}
        />
      ) : null}

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
        <ToastStack items={toasts} onDismiss={dismissToast} testId="qa-toast" />
      )}
    </div>
  );
}
