"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, Github, Loader2, RefreshCw } from "lucide-react";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import type { GitHubConfigErrorCode } from "@/lib/github/client";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { cn } from "@/lib/utils";

interface GitHubIssueRow {
  id: string;
  issueNumber: number;
  title: string;
  labels: string[];
  milestone: string | null;
  githubUrl: string;
  createdAtGitHub: string | null;
  importedEpicId: string | null;
}

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

const GRID = "grid-cols-[64px_1fr_180px_110px_120px]";

/**
 * The triage and sync routes answer 400 with one of these codes when GitHub is
 * not set up for the project. Branching on the code -- rather than on the prose
 * message, or on a 500 that says nothing at all -- is what lets the page
 * explain the state instead of reporting a failure.
 *
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES and the page
 * resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3). The shape is load-bearing beyond the
 * copy: `asConfigErrorCode` tests membership against it.
 */
const CONFIG_EMPTY_STATE: Record<
  GitHubConfigErrorCode,
  { titleKey: TranslationKey; detailKey: TranslationKey }
> = {
  GITHUB_REPO_NOT_CONFIGURED: {
    titleKey: "GithubIssues.config.repoTitle",
    detailKey: "GithubIssues.config.repoDetail",
  },
  GITHUB_PAT_NOT_CONFIGURED: {
    titleKey: "GithubIssues.config.patTitle",
    detailKey: "GithubIssues.config.patDetail",
  },
};

function asConfigErrorCode(value: unknown): GitHubConfigErrorCode | null {
  return typeof value === "string" && value in CONFIG_EMPTY_STATE
    ? (value as GitHubConfigErrorCode)
    : null;
}

export default function GitHubIssuesPage() {
  const t = useTranslations("GithubIssues");
  // The empty-state table holds full dotted paths, so it resolves through the
  // namespace-less translator.
  const tKey = useTranslations();
  const params = useParams();
  const projectId = params.projectId as string;

  const [issues, setIssues] = useState<GitHubIssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [labelFilter, setLabelFilter] = useState("");
  const [milestoneFilter, setMilestoneFilter] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [featureLabels, setFeatureLabels] = useState("");
  const [bugLabels, setBugLabels] = useState("");
  const [savingMapping, setSavingMapping] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [serverConfigCode, setServerConfigCode] =
    useState<GitHubConfigErrorCode | null>(null);
  const { ownerRepo, tokenSet, loading: configLoading } =
    useGitHubConfig(projectId);

  // Derived from the project/settings reads the page already makes, so the
  // unconfigured case never has to be discovered by firing a request that
  // cannot succeed.
  const clientConfigCode: GitHubConfigErrorCode | null = configLoading
    ? null
    : !ownerRepo
      ? "GITHUB_REPO_NOT_CONFIGURED"
      : !tokenSet
        ? "GITHUB_PAT_NOT_CONFIGURED"
        : null;
  // The server stays authoritative: it can disagree with the reads above when
  // the configuration changes mid-session.
  const configCode = clientConfigCode ?? serverConfigCode;

  const showToast = useCallback((type: "success" | "error", message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query = new URLSearchParams();
    if (labelFilter.trim()) query.set("label", labelFilter.trim());
    if (milestoneFilter.trim()) query.set("milestone", milestoneFilter.trim());

    try {
      const res = await fetch(`/api/projects/${projectId}/github/issues/triage?${query.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = asConfigErrorCode(json.code);
        setServerConfigCode(code);
        // `json.error` is the route's own text and ships as it came; only the
        // fallback beside it is this screen's copy.
        if (!code) setError(json.error || t("list.loadFailed"));
      } else {
        setServerConfigCode(null);
        setIssues(Array.isArray(json.data) ? json.data : []);
      }
    } catch {
      setError(t("list.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [projectId, labelFilter, milestoneFilter, t]);

  useEffect(() => {
    if (configLoading) return;
    if (clientConfigCode) {
      setIssues([]);
      setError(null);
      setLoading(false);
      return;
    }
    loadIssues();
  }, [configLoading, clientConfigCode, loadIssues]);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/github/label-mapping`)
      .then((r) => r.json())
      .then((json) => {
        if (json.data) {
          setFeatureLabels(json.data.featureLabels.join(", "));
          setBugLabels(json.data.bugLabels.join(", "));
        }
      })
      .catch(() => {});
  }, [projectId]);

  async function saveMappingConfig() {
    setSavingMapping(true);
    try {
      await fetch(`/api/projects/${projectId}/github/label-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          featureLabels: featureLabels
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          bugLabels: bugLabels
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
    } finally {
      setSavingMapping(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/issues/sync`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = asConfigErrorCode(json.code);
        if (code) {
          setServerConfigCode(code);
          return;
        }
        showToast("error", json.error || t("sync.failed"));
        return;
      }
      setServerConfigCode(null);
      await loadIssues();
      showToast("success", t("sync.done"));
    } catch {
      showToast("error", t("sync.failed"));
    } finally {
      setSyncing(false);
    }
  }

  async function importSelected() {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/issues/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueNumbers: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || t("import.failed"));
        showToast("error", json.error || t("import.failed"));
      } else {
        setSelected(new Set());
        await loadIssues();
        showToast("success", t("import.done", { count: selected.size }));
      }
    } catch {
      setError(t("import.failed"));
      showToast("error", t("import.failed"));
    } finally {
      setImporting(false);
    }
  }

  const visible = useMemo(() => issues, [issues]);
  const notImported = visible.filter((issue) => !issue.importedEpicId).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">{t("header.title")}</h2>
          <p className="text-[13px] text-muted-foreground">
            {t("header.subtitle")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[9px]">
          <Button
            variant="outline"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={syncNow}
            disabled={syncing || Boolean(configCode)}
          >
            {syncing ? (
              <Loader2 className="h-[14px] w-[14px] animate-spin" />
            ) : (
              <RefreshCw className="h-[14px] w-[14px]" />
            )}
            {t("header.sync")}
          </Button>
          <Button
            className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
            onClick={importSelected}
            disabled={importing || selected.size === 0}
          >
            {importing ? (
              <Loader2 className="h-[14px] w-[14px] animate-spin" />
            ) : (
              <Download className="h-[14px] w-[14px]" />
            )}
            {t("header.importSelected", { count: selected.size })}
          </Button>
        </div>
      </div>

      <div className="flex flex-none flex-wrap items-center gap-[10px] px-[26px] pb-[16px]">
        <span className="inline-flex items-center gap-[8px] text-[12.5px] text-muted-foreground">
          <Github className="h-[14px] w-[14px]" />
          {ownerRepo || t("filters.notConnected")}
        </span>
        <span className="h-4 w-px bg-border" />
        <Input
          value={labelFilter}
          onChange={(e) => setLabelFilter(e.target.value)}
          placeholder={t("filters.label")}
          aria-label={t("filters.label")}
          className="h-[26px] w-[160px] rounded-full px-[11px] text-[12.5px]"
        />
        <Input
          value={milestoneFilter}
          onChange={(e) => setMilestoneFilter(e.target.value)}
          placeholder={t("filters.milestone")}
          aria-label={t("filters.milestone")}
          className="h-[26px] w-[160px] rounded-full px-[11px] font-mono text-[12px]"
        />
        <span className="ml-auto text-[12.5px] text-muted-foreground">
          {t("filters.summary", { count: visible.length, notImported })}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-[22px] px-[26px] pb-[26px]">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-border bg-card">
          <div
            className={cn(
              "grid flex-none gap-[14px] border-b border-border px-[22px] py-[12px]",
              GRID
            )}
          >
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              #
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("columns.title")}
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("columns.labels")}
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("columns.milestone")}
            </span>
            <span />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {configCode ? (
              <div className="flex flex-col items-center gap-[8px] px-[22px] py-[44px] text-center">
                <Github className="h-[20px] w-[20px] text-meta" />
                <p className="text-[13.5px] font-medium">
                  {tKey(CONFIG_EMPTY_STATE[configCode].titleKey)}
                </p>
                <p className="max-w-[420px] text-[12.5px] leading-[1.5] text-muted-foreground">
                  {tKey(CONFIG_EMPTY_STATE[configCode].detailKey)}
                </p>
              </div>
            ) : (
              <>
                {error && (
                  <p className="px-[22px] py-[14px] text-[13px] text-destructive">
                    {error}
                  </p>
                )}
                {loading ? (
                  <p className="px-[22px] py-[14px] text-[13px] text-muted-foreground">
                    {t("list.loading")}
                  </p>
                ) : visible.length === 0 ? (
                  <p className="px-[22px] py-[14px] text-[13px] text-muted-foreground">
                    {t("list.empty")}
                  </p>
                ) : (
                  visible.map((issue) => {
                    const checked = selected.has(issue.issueNumber);
                    const imported = Boolean(issue.importedEpicId);
                    return (
                      <div
                        key={issue.id}
                        className={cn(
                          "grid items-center gap-[14px] border-b border-border-soft px-[22px] py-[14px] transition-colors hover:bg-band",
                          GRID
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-[6px]">
                          <Checkbox
                            checked={checked}
                            aria-label={t("list.select", {
                              number: issue.issueNumber,
                            })}
                            onCheckedChange={(value) => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (value) next.add(issue.issueNumber);
                                else next.delete(issue.issueNumber);
                                return next;
                              });
                            }}
                            disabled={imported}
                          />
                          <span className="truncate font-mono text-[11.5px] text-meta">
                            #{issue.issueNumber}
                          </span>
                        </span>
                        <a
                          href={issue.githubUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate text-[13.5px] leading-[1.4] hover:underline"
                        >
                          {issue.title}
                        </a>
                        <span className="flex flex-wrap gap-[6px]">
                          {issue.labels.map((label) => (
                            <span
                              key={label}
                              className="rounded-full bg-band px-[8px] py-[2px] text-[11px] text-muted-foreground"
                            >
                              {label}
                            </span>
                          ))}
                        </span>
                        <span className="truncate font-mono text-[11.5px] text-meta">
                          {issue.milestone || ""}
                        </span>
                        <span
                          className={cn(
                            "justify-self-end text-[12px]",
                            imported ? "text-agent" : "text-primary"
                          )}
                        >
                          {imported ? t("list.imported") : t("list.toImport")}
                        </span>
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        </div>

        <aside className="hidden w-[330px] flex-none flex-col gap-[16px] lg:flex">
          <div className="flex flex-col gap-[12px] rounded-[12px] border border-border p-[18px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("mapping.title")}
            </span>
            <div className="flex flex-col gap-[6px]">
              <label
                htmlFor="label-mapping-feature"
                className="text-[12.5px] text-muted-foreground"
              >
                {t("mapping.feature")}
              </label>
              {/*
                The two placeholders are SAMPLE label names, authored here
                rather than read from the repository — so they are copy, and a
                team whose labels are French should see French examples. The
                labels the rows actually draw stay values, never keys.
              */}
              <Input
                id="label-mapping-feature"
                value={featureLabels}
                onChange={(e) => setFeatureLabels(e.target.value)}
                placeholder={t("mapping.featurePlaceholder")}
                className="h-[34px] rounded-[8px] font-mono text-[12.5px]"
                aria-describedby="label-mapping-hint"
              />
            </div>
            <div className="flex flex-col gap-[6px]">
              <label
                htmlFor="label-mapping-bug"
                className="text-[12.5px] text-muted-foreground"
              >
                {t("mapping.bug")}
              </label>
              <Input
                id="label-mapping-bug"
                value={bugLabels}
                onChange={(e) => setBugLabels(e.target.value)}
                placeholder={t("mapping.bugPlaceholder")}
                className="h-[34px] rounded-[8px] font-mono text-[12.5px]"
                aria-describedby="label-mapping-hint"
              />
            </div>
            <p
              id="label-mapping-hint"
              className="text-[12.5px] leading-[1.5] text-muted-foreground"
            >
              {t("mapping.hint")}
            </p>
            <Button
              variant="outline"
              className="h-[31px] w-fit rounded-[8px] px-[12px] text-[13px]"
              onClick={saveMappingConfig}
              disabled={savingMapping}
            >
              {savingMapping ? (
                <Loader2 className="h-[13px] w-[13px] animate-spin" />
              ) : null}
              {t("mapping.save")}
            </Button>
          </div>
        </aside>
      </div>

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
