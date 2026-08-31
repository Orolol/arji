"use client";

import { XCircle } from "lucide-react";

import {
  BandHeader,
  Mono,
  StrataBand,
} from "@/components/piscine";
import {
  ArijActionsList,
  type ArijActionItem,
} from "@/components/shared/ArijActionsList";

import { FilesTouchedCard } from "./FilesTouchedCard";
import { LiveLogBand } from "./LiveLogBand";
import { NextChainCard } from "./NextChainCard";
import { PromptComposedCard } from "./PromptComposedCard";
import { SessionHeaderBar } from "./SessionHeaderBar";
import { SessionInfoCard } from "./SessionInfoCard";
import { WorktreeCard } from "./WorktreeCard";
import { useSessionFiles } from "./useSessionFiles";
import type { SessionDetail } from "./types";

/**
 * Frame 8a, "la session en direct" — the log IS the content, the prompt and
 * the pipeline read down the right.
 *
 * Pure presentation: every piece of state and every handler arrives as a prop
 * from `page.tsx`, which keeps all the preserved behaviour in one reviewable
 * file. The only fetching that starts here is the 15s `/files` read and, one
 * level down, the log's own chunk pager.
 *
 * SEAM CLOSED (frame 13a). This screen used to sit under two other bars: the
 * global top bar AND a 54px project header the project layout drew, with its
 * own 60px header under both. The project header is gone and `SessionHeaderBar`
 * is now a body row, so the only header on the route is the global bar. The
 * root stays height-bounded so the terminal scrolls internally rather than
 * scrolling the page.
 */

export interface LiveSessionScreenProps {
  projectId: string;
  sessionId: string;
  session: SessionDetail;
  isRunning: boolean;
  providerLabel: string;
  typeLabel: string;
  arijActions: ArijActionItem[] | null;

  onStop: () => void;
  stopping: boolean;
  stopError: string | null;

  onRefresh: () => void;
  onExportLogs: () => void;
  onDistill: () => void;
  distilling: boolean;
  distillError: string | null;

  promptOpen: boolean;
  onTogglePrompt: () => void;
  prompt: string | null;
  promptState: "idle" | "loading" | "loaded" | "error";
  onRetryPrompt: () => void;
}

/** Verbatim, minus the four words that pointed at a tab that no longer exists. */
const SILENT_FAILURE_COPY =
  "This session failed before Arij could record an error message: the process exited (or was lost) without writing stderr or text. Whatever it did produce is kept in the live log above.";

export function LiveSessionScreen({
  projectId,
  sessionId,
  session,
  isRunning,
  providerLabel,
  typeLabel,
  arijActions,
  onStop,
  stopping,
  stopError,
  onRefresh,
  onExportLogs,
  onDistill,
  distilling,
  distillError,
  promptOpen,
  onTogglePrompt,
  prompt,
  promptState,
  onRetryPrompt,
}: LiveSessionScreenProps) {
  const { ticket, project, diff } = useSessionFiles(
    projectId,
    sessionId,
    isRunning
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <SessionHeaderBar
        projectId={projectId}
        session={session}
        ticket={ticket}
        project={project}
        providerLabel={providerLabel}
        typeLabel={typeLabel}
        isRunning={isRunning}
        onStop={onStop}
        stopping={stopping}
        stopError={stopError}
      />

      {/* No top padding: the control row above is the only separation, and it
          shares this body's 14px gutter so the two line up. */}
      <div className="flex min-h-0 flex-1 gap-[12px] px-[14px] pb-[14px]">
        <div className="flex min-w-0 flex-[7] flex-col gap-[12px]">
          {session.error && (
            <StrataBand stratum="card" density="full" gap={9} className="shrink-0">
              <BandHeader
                label="Error"
                stratum="neutral"
                labelSize={12}
                standalone
                meta={
                  <XCircle
                    width={14}
                    height={14}
                    className="text-destructive"
                    aria-hidden="true"
                  />
                }
              />
              <Mono
                as="div"
                size={11.5}
                tone="danger"
                className="max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words"
              >
                {session.error}
              </Mono>
            </StrataBand>
          )}

          {/* Failed with no captured error message (legacy rows predating the
              failure-message synthesis, or a loss that escaped it): say so
              explicitly rather than showing nothing. */}
          {!session.error && session.status === "failed" && (
            <StrataBand stratum="card" density="full" gap={9} className="shrink-0">
              <BandHeader
                label="Failed — no error message captured"
                stratum="neutral"
                labelSize={12}
                standalone
                meta={
                  <XCircle
                    width={14}
                    height={14}
                    className="text-destructive"
                    aria-hidden="true"
                  />
                }
              />
              <p className="font-sans text-[12.5px] leading-relaxed text-muted-foreground">
                {SILENT_FAILURE_COPY}
              </p>
            </StrataBand>
          )}

          <LiveLogBand
            projectId={projectId}
            sessionId={sessionId}
            session={session}
            isRunning={isRunning}
            providerLabel={providerLabel}
          />

          <FilesTouchedCard
            projectId={projectId}
            epicId={session.epicId ?? null}
            diff={diff}
          />

          {/* Structured board effects (MCP tool calls + dispatch artifacts).
              The payload carries the durable half; the separate raw-stream
              scan supersedes it with the chunk-derived half once it lands.
              Renders null when the list is empty, which satisfies the collapse
              rule for free. Its card is still in the old cassette palette — a
              known seam owned by no packet in this wave. */}
          {(arijActions ?? session.arijActions ?? []).length > 0 && (
            // Bounded for the same reason as the file list above: a busy
            // build posts dozens of actions, and the log must not be the thing
            // that gives way. The list itself is untouched — this is the
            // layout box around it.
            <div className="max-h-[220px] shrink-0 overflow-y-auto">
              <ArijActionsList actions={arijActions ?? session.arijActions} />
            </div>
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-[3] flex-col gap-[12px] overflow-y-auto">
          <SessionInfoCard
            session={session}
            providerLabel={providerLabel}
            isRunning={isRunning}
            onRefresh={onRefresh}
            onExportLogs={onExportLogs}
            onDistill={onDistill}
            distilling={distilling}
            distillError={distillError}
          />

          <WorktreeCard
            branchName={session.branchName ?? null}
            worktreePath={session.worktreePath ?? null}
            diff={diff}
          />

          <PromptComposedCard
            session={session}
            open={promptOpen}
            onToggle={onTogglePrompt}
            prompt={prompt}
            promptState={promptState}
            onRetry={onRetryPrompt}
          />

          <NextChainCard
            agentType={session.agentType}
            status={session.status}
          />
        </div>
      </div>
    </div>
  );
}
