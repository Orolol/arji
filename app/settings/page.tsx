"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

export default function SettingsPage() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  // GitHub PAT state
  const [githubPat, setGithubPat] = useState("");
  const [storedPatMask, setStoredPatMask] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.global_prompt) {
          setGlobalPrompt(d.data.global_prompt);
        }
        if (d.data?.github_pat) {
          setStoredPatMask(d.data.github_pat);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        global_prompt: globalPrompt,
      }),
    });
    setSaving(false);
  }

  async function handleValidateGitHub() {
    if (!githubPat.trim()) return;

    setValidating(true);
    setGithubError(null);
    setGithubLogin(null);

    try {
      const res = await fetch("/api/settings/github/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubPat }),
      });

      const data = await res.json();

      if (res.ok && data.data?.valid) {
        setGithubLogin(data.data.login);
        setGithubPat("");
        // Refresh stored mask
        const settingsRes = await fetch("/api/settings");
        const settingsData = await settingsRes.json();
        if (settingsData.data?.github_pat) {
          setStoredPatMask(settingsData.data.github_pat);
        }
      } else {
        setGithubError(data.message || "Invalid token");
      }
    } catch {
      setGithubError("Failed to validate token");
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="space-y-8">
        {/* Global Prompt Section */}
        <div>
          <label className="block text-sm font-medium mb-2">
            Global Prompt
          </label>
          <p className="text-sm text-muted-foreground mb-2">
            This prompt is injected into all Claude Code sessions across all
            projects.
          </p>
          <Textarea
            value={globalPrompt}
            onChange={(e) => setGlobalPrompt(e.target.value)}
            rows={10}
            placeholder="Enter global instructions for Claude Code..."
          />
          <div className="mt-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </div>

        {/* GitHub PAT Section */}
        <div className="border-t pt-6">
          <label className="block text-sm font-medium mb-2">
            GitHub Personal Access Token
          </label>
          <p className="text-sm text-muted-foreground mb-3">
            Required for remote git operations (push, pull, fetch). The token
            needs <code className="text-xs bg-muted px-1 py-0.5 rounded">repo</code> scope.
          </p>

          {storedPatMask && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm text-muted-foreground">Current token:</span>
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                {storedPatMask}
              </code>
              {githubLogin && (
                <Badge variant="secondary">{githubLogin}</Badge>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              type="password"
              value={githubPat}
              onChange={(e) => setGithubPat(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="font-mono"
            />
            <Button
              onClick={handleValidateGitHub}
              disabled={validating || !githubPat.trim()}
              variant="secondary"
            >
              {validating ? "Validating..." : "Validate & Save"}
            </Button>
          </div>

          {githubError && (
            <p className="text-sm text-destructive mt-2">{githubError}</p>
          )}

          {githubLogin && !githubError && (
            <p className="text-sm text-green-600 dark:text-green-400 mt-2">
              Token validated. Authenticated as <strong>{githubLogin}</strong>.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
