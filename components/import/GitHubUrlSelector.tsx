"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("Import");

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
      <p className="text-muted-foreground">{t("github.help")}</p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Github className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={t("github.urlPlaceholder")}
            aria-label={t("github.urlLabel")}
            aria-invalid={showError || undefined}
            className="pl-10"
          />
        </div>
        <Button onClick={submit} disabled={!parsed}>
          {t("github.import")}
        </Button>
      </div>
      {showError ? (
        <p className="text-sm text-destructive">{t("github.invalid")}</p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {parsed
            ? t("github.willClone", { repo: parsed.ownerRepo })
            : t("github.tokenHint")}
        </p>
      )}
    </div>
  );
}
