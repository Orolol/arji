"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface GitHubPatSetting {
  hasToken?: boolean;
}

export default function SettingsPage() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [githubPat, setGitHubPat] = useState("");
  const [hasSavedGitHubPat, setHasSavedGitHubPat] = useState(false);
  const [savingGitHubPat, setSavingGitHubPat] = useState(false);
  const [validatingGitHubPat, setValidatingGitHubPat] = useState(false);
  const [globalMessage, setGlobalMessage] = useState<string | null>(null);
  const [gitHubMessage, setGitHubMessage] = useState<string | null>(null);
  const [gitHubError, setGitHubError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.global_prompt) {
          setGlobalPrompt(d.data.global_prompt);
        }
        const githubSetting = d.data?.github_pat as GitHubPatSetting | undefined;
        setHasSavedGitHubPat(Boolean(githubSetting?.hasToken));
      })
      .catch(() => {});
  }, []);

  async function handleSaveGlobalPrompt() {
    setSavingPrompt(true);
    setGlobalMessage(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          global_prompt: globalPrompt,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setGlobalMessage(
          payload?.error ??
            "Failed to save global prompt. Check the server response and try again."
        );
        return;
      }

      setGlobalMessage("Global prompt saved.");
    } catch {
      setGlobalMessage(
        "Failed to save global prompt. Check your connection and try again."
      );
    } finally {
      setSavingPrompt(false);
    }
  }

  async function handleValidateGitHubPat() {
    setGitHubMessage(null);
    setGitHubError(null);

    if (!githubPat.trim()) {
      setGitHubError("Enter a GitHub personal access token before validating.");
      return;
    }

    setValidatingGitHubPat(true);
    try {
      const response = await fetch("/api/settings/github/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubPat }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload?.data?.valid) {
        setGitHubError(
          payload?.error ??
            "Token validation failed. Verify the token and retry."
        );
        return;
      }

      const login = payload?.data?.login;
      setGitHubMessage(
        login
          ? `Token is valid for GitHub account: ${login}.`
          : "Token is valid."
      );
    } catch {
      setGitHubError(
        "Could not validate token right now. Check your network and try again."
      );
    } finally {
      setValidatingGitHubPat(false);
    }
  }

  async function handleSaveGitHubPat() {
    setGitHubMessage(null);
    setGitHubError(null);

    if (!githubPat.trim()) {
      setGitHubError("Enter a GitHub personal access token before saving.");
      return;
    }

    setSavingGitHubPat(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          github_pat: githubPat.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setGitHubError(
          payload?.error ??
            "Failed to save GitHub token. Check the error details and retry."
        );
        return;
      }

      setHasSavedGitHubPat(true);
      setGitHubPat("");
      setGitHubMessage("GitHub token saved.");
    } catch {
      setGitHubError(
        "Failed to save GitHub token. Check your connection and retry."
      );
    } finally {
      setSavingGitHubPat(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <section className="space-y-6">
        <div>
          <label htmlFor="global-prompt" className="block text-sm font-medium mb-2">
            Global Prompt
          </label>
          <p className="text-sm text-muted-foreground mb-2">
            This prompt is injected into all Claude Code sessions across all projects.
          </p>
          <Textarea
            id="global-prompt"
            value={globalPrompt}
            onChange={(e) => setGlobalPrompt(e.target.value)}
            rows={10}
            placeholder="Enter global instructions for Claude Code..."
          />
          {globalMessage && <p className="mt-2 text-sm text-muted-foreground">{globalMessage}</p>}
        </div>

        <Button onClick={handleSaveGlobalPrompt} disabled={savingPrompt}>
          {savingPrompt ? "Saving..." : "Save Settings"}
        </Button>
      </section>

      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h2 className="text-lg font-semibold">GitHub</h2>
          <p className="text-sm text-muted-foreground">
            Configure a personal access token for pull requests and release APIs.
          </p>
          {hasSavedGitHubPat && (
            <p className="mt-2 text-xs text-muted-foreground">
              A GitHub token is already saved for this workspace.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="github-pat" className="block text-sm font-medium">
            GitHub PAT
          </label>
          <Input
            id="github-pat"
            type="password"
            value={githubPat}
            onChange={(e) => setGitHubPat(e.target.value)}
            placeholder="ghp_..."
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleValidateGitHubPat}
            disabled={validatingGitHubPat}
          >
            {validatingGitHubPat ? "Validating..." : "Validate Token"}
          </Button>
          <Button
            type="button"
            onClick={handleSaveGitHubPat}
            disabled={savingGitHubPat}
          >
            {savingGitHubPat ? "Saving..." : "Save Token"}
          </Button>
        </div>

        {gitHubMessage && <p className="text-sm text-muted-foreground">{gitHubMessage}</p>}
        {gitHubError && <p className="text-sm text-destructive">{gitHubError}</p>}
      </section>
    </div>
  );
}
