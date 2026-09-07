"use client";

import { useTranslations } from "next-intl";

import { SegmentedControl } from "@/components/piscine";
import { useProjects } from "@/hooks/useProjects";

/**
 * Global / this-project switch for the three secondary workshop pages.
 *
 * It replaces the sheet's Global|Project buttons and keeps the sheet's rule:
 * the switch only exists when a project is in play (`?project=` on the URL).
 * With no project there is nothing to switch between, and an inert two-state
 * control would only invite a click that does nothing.
 */
export interface ScopeSwitcherProps {
  projectId?: string;
  scope: "global" | "project";
  onScopeChange: (scope: "global" | "project") => void;
}

export function ScopeSwitcher({
  projectId,
  scope,
  onScopeChange,
}: ScopeSwitcherProps) {
  const t = useTranslations("AgentsWorkshop");
  const { allProjects } = useProjects();
  if (!projectId) return null;

  const project = allProjects.find((candidate) => candidate.id === projectId);

  return (
    <SegmentedControl<"global" | "project">
      size="sm"
      chrome="bordered"
      value={scope}
      onChange={onScopeChange}
      options={[
        { value: "global", label: t("scope.global") },
        { value: "project", label: project?.name ?? t("scope.thisProject") },
      ]}
      className="w-fit"
    />
  );
}
