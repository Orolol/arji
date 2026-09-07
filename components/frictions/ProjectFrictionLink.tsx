"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

interface ProjectFrictionLinkProps {
  projectId: string;
}

/** Compact project-settings entry point with the unresolved friction count. */
export function ProjectFrictionLink({ projectId }: ProjectFrictionLinkProps) {
  const t = useTranslations("Frictions");
  const [openCount, setOpenCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCount() {
      try {
        const response = await fetch(`/api/projects/${projectId}/frictions`);
        const payload = await response.json();
        if (!cancelled && response.ok) {
          setOpenCount(payload.data?.openCount ?? 0);
        }
      } catch {
        // Configuration remains usable when the optional summary cannot load.
      }
    }

    void loadCount();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="shrink-0 border-b border-border px-4 py-2.5">
      <Link
        href={`/projects/${projectId}/frictions`}
        className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm transition-colors hover:bg-accent"
        data-testid="project-frictions-settings-link"
      >
        <TriangleAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <span className="font-medium">{t("link.label")}</span>
        <span
          className="ml-auto rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
          data-testid="project-open-friction-count"
          aria-label={
            openCount === null
              ? t("link.countLoading")
              : t("link.countAria", { count: openCount })
          }
        >
          {openCount === null ? "…" : t("link.count", { count: openCount })}
        </span>
      </Link>
    </div>
  );
}
