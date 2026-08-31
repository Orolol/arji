"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { projectTone } from "@/components/piscine";
import { NextReleaseBand } from "@/components/releases/NextReleaseBand";
import { ReleaseHeaderCluster } from "@/components/releases/ReleaseHeaderCluster";
import { ReleaseHistory } from "@/components/releases/ReleaseHistory";
import { ReleaseStatTiles } from "@/components/releases/ReleaseStatTiles";
import type { ReleaseTicketEpic } from "@/components/releases/ReleaseTicketRow";
import {
  buildChangelogPreview,
  nextPatchVersion,
  parseEpicIds,
  projectToneIndex,
  releaseState,
  ticketExclusionReason,
  versionBumps,
  type ReleaseEpic,
  type ReleaseRow,
} from "@/components/releases/derive";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { useReleasePublish } from "@/hooks/useReleasePublish";
import { cn } from "@/lib/utils";

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

/** The fields of the project row this screen reads. */
interface ProjectRecord {
  defaultBranch?: string | null;
  gitRepoPath?: string | null;
  /** Not a column today; read defensively so the day it lands nothing changes. */
  colorIndex?: number | null;
}

export default function ReleasesPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [releases, setReleases] = useState<ReleaseRow[]>([]);
  const [allEpics, setAllEpics] = useState<ReleaseEpic[]>([]);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // GitHub config. `isConfigured` reads the MASKED settings shape
  // (`github_pat.hasToken === true`); testing it as a string made it
  // permanently false once. `!ghLoading &&` keeps the control from flashing
  // in and out on first paint.
  const { isConfigured: hasGitHub, loading: ghLoading } =
    useGitHubConfig(projectId);
  const { publish, isPublishing, error: publishError } =
    useReleasePublish(projectId);

  // Compose-form state. The version and the ticket selection are DERIVED from
  // the loaded data with a user override on top, so neither needs a
  // set-state-in-effect to catch up when the fetch lands.
  const [versionOverride, setVersionOverride] = useState<string | null>(null);
  const [checkOverrides, setCheckOverrides] = useState<Map<string, boolean>>(
    new Map()
  );
  const [pushToGitHub, setPushToGitHub] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const { agents: namedAgents } = useNamedAgentsList();

  // The redesign draws no title field, so the release title stays empty and the
  // changelog header degrades to `# {version}` — exactly what the server does.
  // The POST body keeps its shape, so the day a title control returns only the
  // source of this value changes.
  const title = "";

  // Resolve selected agent's provider for SessionPicker filtering
  // When no named agent is selected, let the server resolve the default via agentType
  const selectedAgentProvider = namedAgentId
    ? namedAgents.find((a) => a.id === namedAgentId)?.provider
    : undefined;

  // Shared by the mount fetch and by `loadData`, so the effect only ever
  // updates state from a promise callback instead of synchronously.
  const applyData = useCallback(
    (
      releasesData: { data?: unknown },
      epicsData: { data?: unknown },
      projectData: { data?: unknown }
    ) => {
      setReleases((releasesData.data || []) as ReleaseRow[]);
      setAllEpics((epicsData.data || []) as ReleaseEpic[]);
      setProject((projectData.data || null) as ProjectRecord | null);
      setLoading(false);
    },
    []
  );

  const fetchData = useCallback(
    () =>
      Promise.all([
        fetch(`/api/projects/${projectId}/releases`).then((r) => r.json()),
        fetch(`/api/projects/${projectId}/epics`).then((r) => r.json()),
        fetch(`/api/projects/${projectId}`).then((r) => r.json()),
      ]),
    [projectId]
  );

  const loadData = useCallback(async () => {
    const [releasesData, epicsData, projectData] = await fetchData();
    applyData(releasesData, epicsData, projectData);
  }, [fetchData, applyData]);

  useEffect(() => {
    let cancelled = false;
    void fetchData().then(([releasesData, epicsData, projectData]) => {
      if (!cancelled) applyData(releasesData, epicsData, projectData);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchData, applyData]);

  // Both halves matter: the second is what stops an already-released ticket
  // from being offered again.
  const doneEpics = useMemo(
    () => allEpics.filter((e) => e.status === "done" && !e.releaseId),
    [allEpics]
  );

  const epicById = useMemo(
    () => new Map(allEpics.map((epic) => [epic.id, epic] as const)),
    [allEpics]
  );

  const latest = releases[0] ?? null;
  const bumps = versionBumps(latest?.version);
  const version =
    versionOverride ?? nextPatchVersion(latest?.version) ?? "0.1.0";

  const isChecked = useCallback(
    (epic: ReleaseEpic) =>
      checkOverrides.get(epic.id) ?? ticketExclusionReason(epic) === null,
    [checkOverrides]
  );

  const selectedEpics = useMemo(
    () => doneEpics.filter(isChecked),
    [doneEpics, isChecked]
  );
  const selectedEpicIds = useMemo(
    () => new Set(selectedEpics.map((epic) => epic.id)),
    [selectedEpics]
  );

  // Mirrors the server's own fallback changelog byte for byte, so what the user
  // reads is what they get if the changelog agent run fails.
  const changelogPreview = useMemo(
    () => buildChangelogPreview(version, title || null, selectedEpics),
    [version, title, selectedEpics]
  );

  // Derived, not stored: the composer is shown until a release is picked, and
  // a release that disappears on reload falls back to the composer.
  const [inspectReleaseId, setInspectReleaseId] = useState<string | null>(null);
  const inspectRelease =
    releases.find((release) => release.id === inspectReleaseId) ?? null;

  const inspectEpics: ReleaseTicketEpic[] = useMemo(() => {
    if (!inspectRelease) return [];
    return parseEpicIds(inspectRelease).map((id) => {
      const epic = epicById.get(id);
      // The epic was deleted; the release still recorded it.
      return epic
        ? { id: epic.id, title: epic.title, readableId: epic.readableId }
        : { id, title: "—", readableId: null };
    });
  }, [inspectRelease, epicById]);

  async function handleCreateRelease() {
    if (!version.trim() || selectedEpicIds.size === 0) return;
    setCreating(true);

    const res = await fetch(`/api/projects/${projectId}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: version.trim(),
        title: title.trim() || undefined,
        epicIds: Array.from(selectedEpicIds),
        generateChangelog: true,
        // The conjunction matters: without it a stale toggle would ask the
        // server to push to a repo that has no GitHub config.
        pushToGitHub: hasGitHub && pushToGitHub,
        resumeSessionId,
        namedAgentId: namedAgentId || undefined,
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (res.ok) {
      setVersionOverride(null);
      setCheckOverrides(new Map());
      setPushToGitHub(false);
      // A stale resume id otherwise survives into the next release.
      setResumeSessionId(undefined);
      setNamedAgentId(null);
      // PARTIAL SUCCESS. The route answers 201 with `githubErrors` when the
      // release row WAS written but the tag push or the GitHub draft failed.
      // res.ok is true and the release exists, so this must still be an
      // ERROR-toned toast and must still reload — treating 201 as
      // unconditional success tells the user a GitHub release exists when it
      // does not.
      const githubErrors: string[] = json.data?.githubErrors || [];
      if (githubErrors.length > 0) {
        showToast(
          "error",
          "Release v" + version.trim() + " created, but GitHub sync failed: " + githubErrors[0]
        );
      } else {
        showToast("success", "Release v" + version.trim() + " created");
      }
      loadData();
    } else {
      showToast("error", json.error || "Failed to create release");
    }

    setCreating(false);
  }

  async function handlePublish(release: ReleaseRow) {
    const success = await publish(release.id);
    if (success) loadData();
  }

  function toggleEpic(epicId: string) {
    const epic = doneEpics.find((e) => e.id === epicId);
    if (!epic) return;
    const next = !isChecked(epic);
    setCheckOverrides((prev) => {
      const copy = new Map(prev);
      copy.set(epicId, next);
      return copy;
    });
  }

  // The stored default branch is authoritative; "main" is only the legacy
  // fallback for rows that predate the column.
  const branch = project?.defaultBranch || "main";
  const hasRepo = Boolean(project?.gitRepoPath);
  const tone = projectTone(
    typeof project?.colorIndex === "number"
      ? project.colorIndex
      : projectToneIndex(projectId)
  );

  return (
    <div
      data-testid="releases-screen"
      className="flex h-full min-h-0 flex-col font-sans text-foreground"
    >
      {/* The screen's second row. The project layout draws no header at all
          any more (frame 13a), so this is the page's own pinned row above the
          body — on the same 14px gutter as the columns under it. */}
      <ReleaseHeaderCluster
        projectId={projectId}
        branch={branch}
        enabled={hasRepo}
      />

      <div className="flex min-h-0 flex-1 gap-[12px] px-[14px] pb-[14px]">
        <NextReleaseBand
          projectId={projectId}
          tone={tone}
          loading={loading}
          inspectRelease={inspectRelease}
          inspectEpics={inspectEpics}
          onLeaveInspect={() => setInspectReleaseId(null)}
          version={version}
          bumps={bumps}
          onVersionSelect={setVersionOverride}
          candidates={doneEpics}
          isChecked={isChecked}
          onToggleEpic={toggleEpic}
          selectedCount={selectedEpicIds.size}
          changelogPreview={changelogPreview}
          namedAgentId={namedAgentId}
          onNamedAgentChange={setNamedAgentId}
          selectedAgentProvider={selectedAgentProvider}
          resumeSessionId={resumeSessionId}
          onResumeSessionChange={setResumeSessionId}
          showGitHubToggle={!ghLoading && hasGitHub}
          pushToGitHub={pushToGitHub}
          onTogglePushToGitHub={() => setPushToGitHub((prev) => !prev)}
          creating={creating}
          onCreate={handleCreateRelease}
          canPublish={
            inspectRelease !== null &&
            releaseState(inspectRelease) === "draft" &&
            hasGitHub
          }
          isPublishing={isPublishing}
          publishError={publishError}
          onPublish={() => {
            if (inspectRelease) void handlePublish(inspectRelease);
          }}
        />

        <div className="flex min-w-0 flex-[4] flex-col gap-[12px]">
          <ReleaseStatTiles
            loading={loading}
            latest={latest}
            readyCount={selectedEpicIds.size}
            releaseCount={releases.length}
            version={version}
          />
          <ReleaseHistory
            releases={releases}
            epicById={epicById}
            loading={loading}
            onInspect={setInspectReleaseId}
          />
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              data-testid="release-toast"
              data-type={toast.type}
              className={cn(
                "animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
                "rounded-[10px] px-4 py-2 text-[13px] font-medium",
                toast.type === "success"
                  ? "bg-action text-action-foreground"
                  : "bg-destructive text-action-foreground"
              )}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
