"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

export type ImportProgressStep = "cloning" | "analyzing";

interface ImportProgressProps {
  /** Defaults to "analyzing" so the local-folder flow reads exactly as before. */
  step?: ImportProgressStep;
  /** `owner/repo` being cloned — named in the heading of the cloning step. */
  repo?: string | null;
}

export function ImportProgress({
  step = "analyzing",
  repo,
}: ImportProgressProps) {
  const t = useTranslations("Import");
  const cloning = step === "cloning";
  const heading = cloning
    ? t("progress.cloning", { repo: repo || t("progress.cloningUnnamedRepo") })
    : t("progress.analyzing");
  const detail = cloning
    ? t("progress.cloningDetail")
    : t("progress.analyzingDetail");

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-lg font-medium">{heading}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}
