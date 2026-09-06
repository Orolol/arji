"use client";

import { useLocale } from "next-intl";
import { Check, ExternalLink, Tag, Upload } from "lucide-react";

import {
  BandHeader,
  Mono,
  PillButton,
  QuietLink,
  StrataBand,
  pillButtonVariants,
  type ProjectTone,
} from "@/components/piscine";
import { formatRelative } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";

import { ChangelogAgentPopover } from "./ChangelogAgentPopover";
import { ChangelogCard } from "./ChangelogCard";
import { ReleaseTicketRow, type ReleaseTicketEpic } from "./ReleaseTicketRow";
import { VersionPill } from "./VersionPill";
import {
  parseEpicIds,
  releaseState,
  ticketExclusionReason,
  type ReleaseEpic,
  type ReleaseRow,
} from "./derive";

export interface NextReleaseBandProps {
  projectId: string;
  /** Project identity colour for every ticket chip on the screen. */
  tone: ProjectTone;
  loading: boolean;

  /** null = compose mode. A release = inspect mode. */
  inspectRelease: ReleaseRow | null;
  /** The inspected release's recorded tickets, in the order it recorded them. */
  inspectEpics: ReleaseTicketEpic[];
  onLeaveInspect: () => void;

  /* ---- compose ---- */
  version: string;
  bumps: { patch: string; minor: string; major: string } | null;
  onVersionSelect: (version: string) => void;
  candidates: ReleaseEpic[];
  isChecked: (epic: ReleaseEpic) => boolean;
  onToggleEpic: (epicId: string) => void;
  selectedCount: number;
  changelogPreview: string;
  namedAgentId: string | null;
  onNamedAgentChange: (id: string | null) => void;
  selectedAgentProvider: string | undefined;
  resumeSessionId: string | undefined;
  onResumeSessionChange: (id: string | undefined) => void;
  /** `!ghLoading && hasGitHub` — both halves, so the control does not flash. */
  showGitHubToggle: boolean;
  pushToGitHub: boolean;
  onTogglePushToGitHub: () => void;
  creating: boolean;
  onCreate: () => void;

  /* ---- inspect ---- */
  canPublish: boolean;
  isPublishing: boolean;
  publishError: string | null;
  onPublish: () => void;
}

/**
 * The left 6/10 of frame 8c: the sun-yellow band where the next release is
 * composed, and — in inspect mode — where a past release's changelog is read
 * and its GitHub draft published.
 *
 * Rule (5) is what shapes the layout: only the changelog card grows, so with
 * zero candidates the band collapses to its label line, and with many tickets
 * the capped list grows while the changelog card gives up its slack. The footer
 * is never pushed out of view.
 */
export function NextReleaseBand({
  projectId,
  tone,
  loading,
  inspectRelease,
  inspectEpics,
  onLeaveInspect,
  version,
  bumps,
  onVersionSelect,
  candidates,
  isChecked,
  onToggleEpic,
  selectedCount,
  changelogPreview,
  namedAgentId,
  onNamedAgentChange,
  selectedAgentProvider,
  resumeSessionId,
  onResumeSessionChange,
  showGitHubToggle,
  pushToGitHub,
  onTogglePushToGitHub,
  creating,
  onCreate,
  canPublish,
  isPublishing,
  publishError,
  onPublish,
}: NextReleaseBandProps) {
  const locale = useLocale();
  const inspecting = inspectRelease !== null;
  // Only reached after loading: an unknown candidate list is not an empty one.
  const composeEmpty = !inspecting && !loading && candidates.length === 0;

  const bandClass = "min-h-0 min-w-0 flex-[6] shrink px-[20px] py-[16px]";

  const header = (
    <BandHeader
      stratum="land"
      labelSize={12}
      label={inspecting ? "Release" : "Next release"}
      meta={
        inspectRelease ? (
          <span className="inline-flex items-baseline gap-[10px]">
            {releaseState(inspectRelease)}
            <QuietLink tone="next" size={11.5} onClick={onLeaveInspect}>
              ← revenir au brouillon
            </QuietLink>
          </span>
        ) : composeEmpty ? (
          "No completed epics available for release"
        ) : (
          "draft"
        )
      }
      right={
        <VersionPill
          version={inspectRelease ? inspectRelease.version : version}
          bumps={bumps}
          onSelect={onVersionSelect}
          readOnly={inspecting}
        />
      }
    />
  );

  // The band collapses to its label line: no list, no changelog card, no footer.
  if (composeEmpty || (!inspecting && loading)) {
    return (
      <StrataBand stratum="land" gap={11} className={bandClass}>
        {header}
      </StrataBand>
    );
  }

  const rowCount = inspectRelease ? inspectEpics.length : candidates.length;

  const footerSummary = inspectRelease
    ? inspectSummary(inspectRelease)
    : `${selectedCount} ticket${selectedCount === 1 ? "" : "s"} · tag v${version} sur release/v${version}`;

  return (
    <StrataBand stratum="land" gap={11} className={bandClass}>
      {header}

      {rowCount > 0 ? (
        <div className="flex max-h-[42%] min-h-0 shrink-0 flex-col gap-[7px] overflow-y-auto">
          {inspectRelease
            ? inspectEpics.map((row) => (
                <ReleaseTicketRow
                  key={row.id}
                  epic={row}
                  tone={tone}
                  checked
                  reason={null}
                  meta={null}
                  readOnly
                />
              ))
            : candidates.map((epic) => (
                <ReleaseTicketRow
                  key={epic.id}
                  epic={epic}
                  tone={tone}
                  checked={isChecked(epic)}
                  reason={ticketExclusionReason(epic)}
                  // There is no mergedAt column; for a `done` epic updatedAt IS
                  // the transition timestamp. An unknown one is an em-dash.
                  meta={`merged ${formatRelative(epic.updatedAt, { locale }) || "—"}`}
                  onToggle={() => onToggleEpic(epic.id)}
                />
              ))}
        </div>
      ) : null}

      <ChangelogCard
        caption={inspecting ? "CHANGELOG" : "CHANGELOG — GÉNÉRÉ À LA CRÉATION"}
        markdown={inspectRelease ? inspectRelease.changelog : changelogPreview}
        right={
          inspecting ? undefined : (
            <ChangelogAgentPopover
              projectId={projectId}
              namedAgentId={namedAgentId}
              onNamedAgentChange={onNamedAgentChange}
              selectedAgentProvider={selectedAgentProvider}
              resumeSessionId={resumeSessionId}
              onResumeSessionChange={onResumeSessionChange}
            />
          )
        }
      />

      {inspecting && publishError ? (
        <span data-testid="release-publish-error">
          <Mono size={11} tone="danger">
            {publishError}
          </Mono>
        </span>
      ) : null}

      <div className="flex items-center gap-[10px]">
        <Mono size={10.5} tone="land-mid" clamp={1}>
          {footerSummary}
        </Mono>

        {inspectRelease ? (
          <>
            {inspectRelease.githubReleaseUrl ? (
              <a
                href={inspectRelease.githubReleaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="release-view-on-github"
                className={cn(
                  pillButtonVariants({
                    variant: "outline",
                    outlineTone: "action",
                    size: "md",
                  }),
                  "ml-auto h-[31px] px-[14px] no-underline",
                )}
              >
                <ExternalLink size={13} aria-hidden="true" />
                View on GitHub
              </a>
            ) : null}
            {canPublish ? (
              <PillButton
                variant="filled"
                size="lg"
                icon={Upload}
                pending={isPublishing}
                pendingLabel="Publishing…"
                disabled={isPublishing}
                onClick={onPublish}
                data-testid="release-publish-button"
                className={`h-[31px] px-[15px] ${inspectRelease.githubReleaseUrl ? "" : "ml-auto"}`}
              >
                Publish
              </PillButton>
            ) : null}
          </>
        ) : (
          <>
            {showGitHubToggle ? (
              <PillButton
                variant="outline"
                outlineTone="action"
                size="md"
                aria-pressed={pushToGitHub}
                icon={pushToGitHub ? Check : undefined}
                onClick={onTogglePushToGitHub}
                data-testid="release-github-draft-toggle"
                className="ml-auto h-[31px] px-[14px]"
              >
                GitHub draft
              </PillButton>
            ) : null}
            <PillButton
              variant="filled"
              size="lg"
              icon={Tag}
              pending={creating}
              pendingLabel="Creating…"
              disabled={creating || !version.trim() || selectedCount === 0}
              onClick={onCreate}
              data-testid="release-create-button"
              className={`h-[31px] px-[15px] ${showGitHubToggle ? "" : "ml-auto"}`}
            >
              Create release
            </PillButton>
          </>
        )}
      </div>
    </StrataBand>
  );
}

/** `3 tickets · tag v0.4.2 sur release/v0.4.2`, dropping each null clause. */
function inspectSummary(release: ReleaseRow): string {
  const count = parseEpicIds(release).length;
  const head = `${count} ticket${count === 1 ? "" : "s"}`;
  if (release.gitTag && release.releaseBranch) {
    return `${head} · tag ${release.gitTag} sur ${release.releaseBranch}`;
  }
  if (release.gitTag) return `${head} · tag ${release.gitTag}`;
  if (release.releaseBranch) return `${head} · sur ${release.releaseBranch}`;
  return head;
}
