"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Github } from "lucide-react";
import { parseGitHubRepoInput } from "@/lib/git/github-url";

export interface GitHubImportRequest {
  /** The raw value the user pasted — the server re-parses it authoritatively. */
  url: string;
  /** Parsed `owner/repo`, used to label the clone progress step. */
  ownerRepo: string;
}

interface GitHubUrlSelectorProps {
  onImport: (request: GitHubImportRequest) => void;
}

export function GitHubUrlSelector({ onImport }: GitHubUrlSelectorProps) {
  const [url, setUrl] = useState("");

  const trimmed = url.trim();
  const parsed = trimmed ? parseGitHubRepoInput(trimmed) : null;
  // An empty field is the initial state, not a mistake — only complain once the
  // user has actually typed something unparseable.
  const showError = trimmed.length > 0 && !parsed;

  function submit() {
    if (!parsed) return;
    onImport({ url: trimmed, ownerRepo: parsed.ownerRepo });
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        Paste a GitHub repository URL. Arij clones it into its own workspace,
        then Claude Code analyzes the codebase and generates epics and user
        stories.
      </p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Github className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="https://github.com/owner/repo"
            aria-label="GitHub repository URL"
            aria-invalid={showError || undefined}
            className="pl-10"
          />
        </div>
        <Button onClick={submit} disabled={!parsed}>
          Import
        </Button>
      </div>
      {showError ? (
        <p className="text-sm text-destructive">
          Not a GitHub repository. Use https://github.com/owner/repo,
          git@github.com:owner/repo.git, or owner/repo.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {parsed
            ? `Will clone ${parsed.ownerRepo}`
            : "Private repositories use the GitHub token from Settings."}
        </p>
      )}
    </div>
  );
}
