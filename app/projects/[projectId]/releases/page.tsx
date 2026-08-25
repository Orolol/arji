"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SessionPicker } from "@/components/shared/SessionPicker";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ExternalLink, Loader2, Plus, Tag, Upload } from "lucide-react";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useReleasePublish } from "@/hooks/useReleasePublish";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { cn } from "@/lib/utils";

interface Epic {
  id: string;
  title: string;
  status: string;
  type?: string;
  readableId?: string | null;
  releaseId?: string | null;
  usCount?: number;
  usDone?: number;
}

interface Release {
  id: string;
  version: string;
  title: string | null;
  changelog: string | null;
  epicIds: string | null;
  releaseBranch: string | null;
  gitTag: string | null;
  githubReleaseId: number | null;
  githubReleaseUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
}

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

type ReleaseState = "published" | "draft" | "local";

function releaseState(release: Release): ReleaseState {
  if (release.githubReleaseId !== null && release.pushedAt !== null) {
    return "published";
  }
  if (release.githubReleaseId !== null) return "draft";
  return "local";
}

const STATE_TONE: Record<ReleaseState, string> = {
  published: "text-agent",
  draft: "text-primary",
  local: "text-meta",
};

function parseEpicIds(release: Release | null): string[] {
  if (!release?.epicIds) return [];
  try {
    const parsed = JSON.parse(release.epicIds);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export default function ReleasesPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [releases, setReleases] = useState<Release[]>([]);
  const [allEpics, setAllEpics] = useState<Epic[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // GitHub config
  const { isConfigured: hasGitHub, loading: ghLoading } =
    useGitHubConfig(projectId);
  const { publish, isPublishing, error: publishError } =
    useReleasePublish(projectId);

  // Create release form
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [selectedEpicIds, setSelectedEpicIds] = useState<Set<string>>(
    new Set()
  );
  const [pushToGitHub, setPushToGitHub] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const { agents: namedAgents } = useNamedAgentsList();

  // Resolve selected agent's provider for SessionPicker filtering
  // When no named agent is selected, let the server resolve the default via agentType
  const selectedAgentProvider = namedAgentId
    ? namedAgents.find((a) => a.id === namedAgentId)?.provider
    : undefined;

  const loadData = useCallback(async () => {
    const [releasesRes, epicsRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/releases`),
      fetch(`/api/projects/${projectId}/epics`),
    ]);

    const releasesData = await releasesRes.json();
    const epicsData = await epicsRes.json();

    setReleases(releasesData.data || []);
    setAllEpics((epicsData.data || []) as Epic[]);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const doneEpics = useMemo(
    () => allEpics.filter((e) => e.status === "done" && !e.releaseId),
    [allEpics]
  );

  // Derived, not stored: the newest release is shown until one is picked, and
  // a release that disappears on reload falls back to the newest one.
  const selectedRelease =
    releases.find((release) => release.id === selectedReleaseId) ||
    releases[0] ||
    null;

  const releaseEpics = useMemo(() => {
    const ids = new Set(parseEpicIds(selectedRelease));
    if (ids.size === 0) return [];
    return allEpics.filter((epic) => ids.has(epic.id));
  }, [selectedRelease, allEpics]);

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
        pushToGitHub: hasGitHub && pushToGitHub,
        resumeSessionId,
        namedAgentId: namedAgentId || undefined,
      }),
    });

    const json = await res.json().catch(() => ({}));

    if (res.ok) {
      setVersion("");
      setTitle("");
      setSelectedEpicIds(new Set());
      setPushToGitHub(false);
      setResumeSessionId(undefined);
      setNamedAgentId(null);
      setDialogOpen(false);
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

  async function handlePublish(release: Release) {
    const success = await publish(release.id);
    if (success) loadData();
  }

  function toggleEpic(epicId: string) {
    setSelectedEpicIds((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) next.delete(epicId);
      else next.add(epicId);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">Releases</h2>
          <p className="text-[13px] text-muted-foreground">
            Group delivered tickets, generate the changelog, publish the GitHub
            tag.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[9px]">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="h-[31px] rounded-[8px] px-[13px] text-[13px]">
                <Plus className="h-[14px] w-[14px]" />
                New Release
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-[14px] shadow-[0_18px_40px_rgba(58,48,44,.14)]">
              <DialogHeader>
                <DialogTitle>Create Release</DialogTitle>
              </DialogHeader>
              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-1 block text-[12.5px] text-muted-foreground">
                    Version *
                  </label>
                  <Input
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder="1.0.0"
                    className="h-[34px] rounded-[8px] text-[13px]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12.5px] text-muted-foreground">
                    Title
                  </label>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Initial Release"
                    className="h-[34px] rounded-[8px] text-[13px]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12.5px] text-muted-foreground">
                    Include Epics ({selectedEpicIds.size} selected)
                  </label>
                  {doneEpics.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground">
                      No completed epics available for release
                    </p>
                  ) : (
                    <div className="max-h-48 space-y-1 overflow-auto">
                      {doneEpics.map((epic) => (
                        <button
                          key={epic.id}
                          onClick={() => toggleEpic(epic.id)}
                          className={cn(
                            "w-full rounded-[8px] p-2 text-left text-[13px] transition-colors",
                            selectedEpicIds.has(epic.id)
                              ? "bg-primary/10 text-primary"
                              : "hover:bg-band"
                          )}
                        >
                          {epic.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-[12.5px] text-muted-foreground">
                    Changelog Agent
                  </label>
                  <NamedAgentSelect
                    value={namedAgentId}
                    onChange={(id) => {
                      setNamedAgentId(id);
                      setResumeSessionId(undefined);
                    }}
                    className="h-[34px] w-full rounded-[8px] text-[13px]"
                    dispatchRole="release"
                  />
                </div>

                {!ghLoading && hasGitHub && (
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="push-to-github"
                      checked={pushToGitHub}
                      onCheckedChange={(checked) =>
                        setPushToGitHub(checked === true)
                      }
                    />
                    <label
                      htmlFor="push-to-github"
                      className="cursor-pointer text-[13px] font-medium leading-none"
                    >
                      Push to GitHub as draft
                    </label>
                  </div>
                )}

                <SessionPicker
                  projectId={projectId}
                  agentType="release_notes"
                  namedAgentId={namedAgentId}
                  provider={selectedAgentProvider}
                  selectedSessionId={resumeSessionId}
                  onSelect={setResumeSessionId}
                />

                <Button
                  onClick={handleCreateRelease}
                  disabled={
                    creating || !version.trim() || selectedEpicIds.size === 0
                  }
                  className="h-[31px] w-full rounded-[8px] text-[13px]"
                >
                  {creating ? (
                    <Loader2 className="h-[14px] w-[14px] animate-spin" />
                  ) : (
                    <Tag className="h-[14px] w-[14px]" />
                  )}
                  Create Release
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading ? (
        <p className="px-[26px] text-[13px] text-muted-foreground">
          Loading releases...
        </p>
      ) : releases.length === 0 ? (
        <p className="px-[26px] text-[13px] text-muted-foreground">
          No releases yet
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 gap-[22px] px-[26px] pb-[26px]">
          <div className="flex w-[320px] flex-none flex-col gap-[10px] overflow-y-auto">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Releases
            </span>
            {releases.map((release) => {
              const state = releaseState(release);
              const ticketCount = parseEpicIds(release).length;
              return (
                <button
                  key={release.id}
                  type="button"
                  onClick={() => setSelectedReleaseId(release.id)}
                  className={cn(
                    "flex flex-col gap-[8px] rounded-[11px] border px-[16px] py-[14px] text-left transition-colors",
                    selectedRelease?.id === release.id
                      ? "border-primary bg-card"
                      : "border-border hover:bg-band"
                  )}
                >
                  <div className="flex items-center gap-[9px]">
                    <Tag className="h-[14px] w-[14px] flex-none text-meta" />
                    <span className="font-mono text-[13px] font-medium">
                      {release.version}
                    </span>
                    <span
                      className={cn("ml-auto text-[12px]", STATE_TONE[state])}
                    >
                      {state}
                    </span>
                  </div>
                  {release.title && (
                    <span className="text-[13.5px] leading-[1.35]">
                      {release.title}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-meta">
                    {new Date(release.createdAt).toLocaleDateString()} ·{" "}
                    {ticketCount} ticket{ticketCount === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>

          {selectedRelease && (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[18px] rounded-[12px] border border-border bg-card px-[26px] py-[24px]">
              <div className="flex flex-wrap items-baseline gap-[12px]">
                <span className="font-mono text-[20px] font-semibold">
                  {selectedRelease.version}
                </span>
                {selectedRelease.title && (
                  <span className="text-[16px]">{selectedRelease.title}</span>
                )}
                <span
                  className={cn(
                    "ml-auto rounded-full bg-band px-[10px] py-[4px] text-[12px]",
                    STATE_TONE[releaseState(selectedRelease)]
                  )}
                >
                  {releaseState(selectedRelease)}
                </span>
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-[12px] overflow-y-auto">
                <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
                  Changelog
                </span>
                {selectedRelease.changelog ? (
                  <div className="text-[14px] leading-[1.75]">
                    <MarkdownContent content={selectedRelease.changelog} />
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No changelog generated for this release.
                  </p>
                )}
              </div>

              {releaseEpics.length > 0 && (
                <div className="flex flex-wrap gap-[8px]">
                  {releaseEpics.map((epic) => (
                    <span
                      key={epic.id}
                      title={epic.title}
                      className="rounded-full border border-border px-[9px] py-[3px] font-mono text-[11.5px] text-muted-foreground"
                    >
                      {epic.readableId || epic.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              )}

              {publishError && (
                <p className="text-[12.5px] text-destructive">{publishError}</p>
              )}

              <div className="flex flex-wrap items-center gap-[10px]">
                {selectedRelease.gitTag && (
                  <span className="text-[12.5px] text-muted-foreground">
                    Tag{" "}
                    <span className="font-mono">{selectedRelease.gitTag}</span>
                    {selectedRelease.releaseBranch ? (
                      <>
                        {" "}
                        on{" "}
                        <span className="font-mono">
                          {selectedRelease.releaseBranch}
                        </span>
                      </>
                    ) : null}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-[10px]">
                  {selectedRelease.githubReleaseUrl && (
                    <a
                      href={selectedRelease.githubReleaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button
                        variant="outline"
                        className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
                      >
                        <ExternalLink className="h-[14px] w-[14px]" />
                        View on GitHub
                      </Button>
                    </a>
                  )}
                  {releaseState(selectedRelease) === "draft" && hasGitHub && (
                    <Button
                      className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
                      onClick={() => handlePublish(selectedRelease)}
                      disabled={isPublishing}
                    >
                      {isPublishing ? (
                        <Loader2 className="h-[14px] w-[14px] animate-spin" />
                      ) : (
                        <Upload className="h-[14px] w-[14px]" />
                      )}
                      Publish
                    </Button>
                  )}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                "animate-in fade-in slide-in-from-bottom-2 rounded-[10px] px-4 py-2 text-[13px] font-medium shadow-[0_8px_20px_rgba(58,48,44,.16)] transition-all",
                toast.type === "success"
                  ? "bg-agent text-background"
                  : "bg-destructive text-background"
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
