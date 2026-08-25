"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FolderSelector } from "@/components/import/FolderSelector";
import {
  GitHubUrlSelector,
  type GitHubImportRequest,
} from "@/components/import/GitHubUrlSelector";
import { ImportProgress } from "@/components/import/ImportProgress";
import { ImportPreview } from "@/components/import/ImportPreview";
import type { ImportData } from "@/components/import/types";

type ImportState = "select" | "cloning" | "analyzing" | "preview";
type ImportSource = "local" | "github";

interface DebugInfo {
  duration?: number;
  rawOutput?: string;
  rawPreview?: string;
  parsedContent?: string;
  parseError?: string;
  metadata?: Record<string, unknown>;
  keys?: string[];
  stack?: string;
}

/** Success payload of POST /api/projects/clone. */
interface CloneInfo {
  path: string;
  ownerRepo: string;
  remoteUrl: string;
  defaultBranch?: string | null;
  reused?: boolean;
}

type PostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; debug?: DebugInfo };

function formatDetails(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  return Object.entries(details as Record<string, unknown>)
    .map(([field, messages]) =>
      `${field}: ${Array.isArray(messages) ? messages.join(", ") : String(messages)}`
    )
    .join("; ");
}

/**
 * Every step of the import chain goes through here so a failure is always
 * reported instead of surfacing later as `undefined is not an object`. Routes
 * signal failure either with a non-2xx status or with an `error` key on a 200,
 * so both are treated as failures. A 2xx whose body is not a JSON object — or
 * is missing the `data` envelope — is equally a failure: an unchecked cast
 * there used to turn a broken response into a permanent "Analyzing" spinner.
 */
async function sendJson<T>(
  url: string,
  body: unknown,
  method = "POST"
): Promise<PostResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Network request failed",
    };
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: T;
    error?: string;
    details?: unknown;
    debug?: DebugInfo;
  } | null;

  if (!response.ok || payload?.error) {
    const details = formatDetails(payload?.details);
    return {
      ok: false,
      error: [
        payload?.error || `Request failed (HTTP ${response.status})`,
        details,
      ]
        .filter(Boolean)
        .join(" — "),
      debug: payload?.debug,
    };
  }

  if (payload === null || typeof payload !== "object") {
    return {
      ok: false,
      error: `Unexpected response from ${url} (HTTP ${response.status}): the body is not JSON`,
    };
  }

  if (payload.data === undefined) {
    return {
      ok: false,
      error: `Unexpected response from ${url} (HTTP ${response.status}): the JSON has no "data" field`,
    };
  }

  return { ok: true, data: payload.data };
}

/**
 * Post-creation steps, each reporting its own failure so a half-finished
 * import is legible instead of silent. None of them touch component state.
 */
async function applyProjectUpdate(
  projectId: string,
  data: ImportData,
  spec: string | undefined
): Promise<string[]> {
  const result = await sendJson<unknown>(
    `/api/projects/${projectId}`,
    { status: data.project.status || "specifying", spec },
    "PATCH"
  );
  return result.ok
    ? []
    : [`Project status and spec were not saved: ${result.error}`];
}

async function createEpicsAndStories(
  projectId: string,
  data: ImportData
): Promise<string[]> {
  const failures: string[] = [];

  for (const epic of data.epics) {
    const epicResult = await sendJson<{ id: string }>(
      `/api/projects/${projectId}/epics`,
      {
        title: epic.title,
        description: epic.description,
        status: epic.status,
        confidence: epic.confidence,
        evidence: epic.evidence,
      }
    );

    if (!epicResult.ok || !epicResult.data?.id) {
      failures.push(
        `Epic "${epic.title}" was not created: ${
          epicResult.ok ? "the API returned no epic id" : epicResult.error
        }`
      );
      // Its stories have nowhere to attach — skip them rather than creating
      // orphans, and keep going with the remaining epics.
      continue;
    }

    // Defensive: the preview passed the shape guard before rendering, but an
    // entry without user_stories must fail per-epic, not throw here.
    for (const us of epic.user_stories ?? []) {
      const storyResult = await sendJson<unknown>(
        `/api/projects/${projectId}/user-stories`,
        {
          epicId: epicResult.data.id,
          title: us.title,
          description: us.description,
          acceptanceCriteria: us.acceptance_criteria,
          status: us.status,
        }
      );
      if (!storyResult.ok) {
        failures.push(
          `User story "${us.title}" (epic "${epic.title}") was not created: ${storyResult.error}`
        );
      }
    }
  }

  return failures;
}

/** Write back arij.json with the newly created IDs. */
async function exportArjiJson(projectId: string): Promise<string[]> {
  const result = await sendJson<unknown>(`/api/projects/${projectId}/sync`, {
    action: "export",
  });
  return result.ok ? [] : [`arji.json export failed: ${result.error}`];
}

export default function ImportProjectPage() {
  const router = useRouter();
  const [state, setState] = useState<ImportState>("select");
  const [source, setSource] = useState<ImportSource>("local");
  const [folderPath, setFolderPath] = useState("");
  const [cloneInfo, setCloneInfo] = useState<CloneInfo | null>(null);
  const [cloningRepo, setCloningRepo] = useState("");
  const [importData, setImportData] = useState<ImportData | null>(null);
  const [fromExistingFile, setFromExistingFile] = useState(false);
  const [error, setError] = useState("");
  const [debug, setDebug] = useState<DebugInfo | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  function resetFeedback() {
    setError("");
    setDebug(null);
    setIssues([]);
  }

  /**
   * Wipes every trace of the previous import — feedback, clone info, the
   * parsed preview AND the created-project id. Called both when the user
   * deliberately starts a new import and when they cancel the preview, so a
   * partial creation can never lock the next preview's Validate button.
   */
  function resetForNewImport() {
    resetFeedback();
    setCloneInfo(null);
    setCloningRepo("");
    setImportData(null);
    setFromExistingFile(false);
    setCreatedProjectId(null);
  }

  function handleSourceChange(next: ImportSource) {
    if (next === source) return;
    setSource(next);
    resetFeedback();
  }

  async function runAnalysis(path: string) {
    setFolderPath(path);
    setState("analyzing");

    const result = await sendJson<{
      preview: ImportData;
      fromExistingFile?: boolean;
    }>("/api/projects/import", { path });

    if (!result.ok) {
      setError(result.error);
      setDebug(result.debug ?? null);
      setState("select");
      return;
    }

    // The route may return a valid envelope whose preview is still malformed;
    // rendering it would crash the preview screen, so guard the shape too.
    const preview = result.data?.preview;

    // Envelope level: the route promises { preview: { project, epics } }.
    if (
      !preview ||
      typeof preview !== "object" ||
      !preview.project ||
      typeof preview.project !== "object" ||
      !Array.isArray(preview.epics)
    ) {
      setError(
        "The analysis returned an unexpected preview (missing project or epics). Nothing was imported."
      );
      setState("select");
      return;
    }

    // Entry level: ImportPreview dereferences `epic.title` and
    // `epic.user_stories.length` on every entry. The preview may come from a
    // third-party arji.json inside a freshly cloned repository (spec §5), so
    // an epic missing user_stories must be rejected here — not thrown from
    // the render, which would blank the whole app (no error boundary).
    if (
      !preview.epics.every(
        (epic) =>
          epic &&
          typeof epic === "object" &&
          typeof epic.title === "string" &&
          Array.isArray(epic.user_stories)
      )
    ) {
      setError(
        "The analysis returned an unexpected preview (an epic is missing its title or its user stories). Nothing was imported."
      );
      setState("select");
      return;
    }

    setImportData(preview);
    setFromExistingFile(!!result.data.fromExistingFile);
    setState("preview");
  }

  async function handleAnalyze(path: string) {
    resetForNewImport();
    await runAnalysis(path);
  }

  async function handleGitHubImport({ url, ownerRepo }: GitHubImportRequest) {
    resetForNewImport();
    setCloningRepo(ownerRepo);
    setState("cloning");

    const result = await sendJson<CloneInfo>("/api/projects/clone", { url });
    if (!result.ok) {
      setError(`Could not clone ${ownerRepo}: ${result.error}`);
      setState("select");
      return;
    }

    // The clone contract is { path, ownerRepo, remoteUrl, defaultBranch,
    // reused }. The chain that follows takes minutes and quietly loses the
    // project's remote/default-branch metadata if any of these came back
    // empty — check the full contract here, right after the clone, and fail
    // early with the repository named instead of degrading late.
    const missing = (
      ["path", "ownerRepo", "remoteUrl", "defaultBranch"] as const
    ).filter((field) => !result.data?.[field]);
    if (missing.length > 0) {
      setError(
        `Could not clone ${ownerRepo}: the clone response is incomplete (missing ${missing.join(
          ", "
        )}).`
      );
      setState("select");
      return;
    }

    setCloneInfo(result.data);
    await runAnalysis(result.data.path);
  }

  async function handleValidate(data: ImportData) {
    resetFeedback();
    setValidating(true);
    try {
      const projectResult = await sendJson<{ id: string }>("/api/projects", {
        name: data.project.name,
        description: data.project.description,
        gitRepoPath: folderPath,
        // Set only for an Arij-managed clone; a local folder keeps every
        // clone column NULL so the directory is never treated as ours.
        githubOwnerRepo: cloneInfo?.ownerRepo,
        gitRemoteUrl: cloneInfo?.remoteUrl,
        cloneSource: cloneInfo ? "github" : undefined,
        defaultBranch: cloneInfo?.defaultBranch ?? undefined,
      });

      if (!projectResult.ok || !projectResult.data?.id) {
        // Stay on the preview: the user's edits are still there and the import
        // can be retried without re-running the analysis.
        setError(
          projectResult.ok
            ? "Could not create the project: the API returned no project id."
            : `Could not create the project: ${projectResult.error}`
        );
        return;
      }

      const projectId = projectResult.data.id;
      // Surfaced from here on so a later failure still leaves a way in.
      setCreatedProjectId(projectId);
      const failures: string[] = [];

      const spec = data.project.spec
        ? data.project.spec
        : data.project.architecture
          ? `# ${data.project.name}\n\n${data.project.description}\n\n## Stack\n${data.project.stack}\n\n## Architecture\n${data.project.architecture}`
          : undefined;

      failures.push(...(await applyProjectUpdate(projectId, data, spec)));
      failures.push(...(await createEpicsAndStories(projectId, data)));
      failures.push(...(await exportArjiJson(projectId)));

      if (failures.length > 0) {
        setIssues(failures);
        return;
      }

      router.push(`/projects/${projectId}`);
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Import Existing Project</h1>

      {error && (
        <div className="bg-destructive/10 text-destructive p-3 rounded-md mb-4 text-sm">
          <p className="font-medium">{error}</p>
          {debug && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
                Debug info
              </summary>
              <div className="mt-2 space-y-2 text-xs">
                {debug.duration != null && (
                  <p>Duration: {(debug.duration / 1000).toFixed(1)}s</p>
                )}
                {debug.parseError && (
                  <div>
                    <p className="font-medium">Parse error:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-24">
                      {debug.parseError}
                    </pre>
                  </div>
                )}
                {debug.parsedContent && (
                  <div>
                    <p className="font-medium">Parsed content:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {debug.parsedContent}
                    </pre>
                  </div>
                )}
                {debug.rawOutput && (
                  <div>
                    <p className="font-medium">Raw CLI output:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {debug.rawOutput}
                    </pre>
                  </div>
                )}
                {debug.metadata && (
                  <div>
                    <p className="font-medium">Metadata:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-24">
                      {JSON.stringify(debug.metadata, null, 2)}
                    </pre>
                  </div>
                )}
                {debug.rawPreview && (
                  <div>
                    <p className="font-medium">File preview:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {debug.rawPreview}
                    </pre>
                  </div>
                )}
                {debug.keys && (
                  <div>
                    <p className="font-medium">Top-level keys:</p>
                    <p className="mt-1">{debug.keys.join(", ")}</p>
                  </div>
                )}
                {debug.stack && (
                  <div>
                    <p className="font-medium">Stack:</p>
                    <pre className="mt-1 p-2 bg-black/20 rounded overflow-auto max-h-48 whitespace-pre-wrap">
                      {debug.stack}
                    </pre>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <div className="bg-destructive/10 text-destructive p-3 rounded-md mb-4 text-sm">
          <p className="font-medium">
            The project was created, but {issues.length} step
            {issues.length > 1 ? "s" : ""} failed:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            {issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {createdProjectId && issues.length > 0 && (
        <div className="mb-4 text-sm">
          <Link
            href={`/projects/${createdProjectId}`}
            className="underline underline-offset-4"
          >
            Open the partially created project
          </Link>
        </div>
      )}

      {state === "select" && (
        <div className="mb-6 flex gap-2" role="group" aria-label="Import source">
          <Button
            variant={source === "local" ? "default" : "outline"}
            aria-pressed={source === "local"}
            onClick={() => handleSourceChange("local")}
          >
            Local folder
          </Button>
          <Button
            variant={source === "github" ? "default" : "outline"}
            aria-pressed={source === "github"}
            onClick={() => handleSourceChange("github")}
          >
            GitHub URL
          </Button>
        </div>
      )}

      {state === "select" && source === "local" && (
        <FolderSelector onAnalyze={handleAnalyze} />
      )}
      {state === "select" && source === "github" && (
        <GitHubUrlSelector onImport={handleGitHubImport} />
      )}

      {cloneInfo?.reused && state !== "select" && (
        <div className="bg-blue-500/10 text-blue-400 border border-blue-500/20 p-3 rounded-md mb-4 text-sm">
          Repository already cloned — updating.
        </div>
      )}

      {state === "cloning" && (
        <ImportProgress step="cloning" repo={cloningRepo} />
      )}
      {state === "analyzing" && <ImportProgress step="analyzing" />}
      {state === "preview" && fromExistingFile && (
        <div className="bg-blue-500/10 text-blue-400 border border-blue-500/20 p-3 rounded-md mb-4 text-sm">
          Imported from existing arij.json — Claude analysis was skipped.
        </div>
      )}
      {state === "preview" && importData && (
        <ImportPreview
          data={importData}
          // While the chain runs, the button reads "Importing...".
          busy={validating}
          // Once the project row exists, re-running the import would
          // duplicate it — the link above is the way forward instead. The
          // label reads "Already imported" so the disabled state is
          // legible rather than a hung operation.
          locked={createdProjectId !== null}
          // Never let the user leave the preview while the chain is in flight:
          // a late router.push or state write would land on a second import.
          cancelDisabled={validating}
          onValidate={handleValidate}
          onCancel={() => {
            resetForNewImport();
            setState("select");
          }}
        />
      )}
    </div>
  );
}
