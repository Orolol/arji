"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function NewProjectPage() {
  const t = useTranslations("ProjectImport");
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gitRepoPath, setGitRepoPath] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // The submit button is disabled until the name is filled; without a
  // spoken reason that state is invisible to assistive technology.
  const nameInvalid = nameTouched && !name.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameTouched(true);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          gitRepoPath: gitRepoPath.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => null);
      if (data?.data?.id) {
        router.push(`/projects/${data.data.id}`);
        return;
      }

      // A rejected path or a validation error used to leave the form silently
      // stuck on "Creating..." — say what went wrong instead.
      setError(
        data?.error ||
          t("newProject.createFailedStatus", { status: String(res.status) })
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("newProject.createFailed")
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-lg mx-auto">
      <h1 className="text-2xl font-bold mb-6">{t("newProject.heading")}</h1>
      {error && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive p-3 rounded-md mb-4 text-sm"
        >
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="project-name"
            className="block text-sm font-medium mb-1"
          >
            {t("newProject.nameLabel")}
          </label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            placeholder={t("newProject.namePlaceholder")}
            required
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameInvalid ? "project-name-error" : undefined}
          />
          {nameInvalid && (
            <p
              id="project-name-error"
              role="alert"
              className="text-xs text-destructive mt-1"
            >
              {t("newProject.nameRequired")}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="project-description"
            className="block text-sm font-medium mb-1"
          >
            {t("newProject.descriptionLabel")}
          </label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("newProject.descriptionPlaceholder")}
            rows={3}
          />
        </div>
        <div>
          <label
            htmlFor="project-git-repo-path"
            className="block text-sm font-medium mb-1"
          >
            {t("newProject.gitPathLabel")}
          </label>
          <Input
            id="project-git-repo-path"
            value={gitRepoPath}
            onChange={(e) => setGitRepoPath(e.target.value)}
            placeholder={t("newProject.gitPathPlaceholder")}
            aria-describedby="project-git-repo-path-hint"
          />
          <p
            id="project-git-repo-path-hint"
            className="text-xs text-muted-foreground mt-1"
          >
            {t("newProject.gitPathHint")}
          </p>
        </div>
        <div className="flex gap-2 pt-2">
          <Button type="submit" disabled={loading || !name.trim()}>
            {loading ? t("newProject.submitPending") : t("newProject.submit")}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            {t("newProject.cancel")}
          </Button>
        </div>
      </form>
    </div>
  );
}
