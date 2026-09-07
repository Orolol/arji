"use client";

import { useTranslations } from "next-intl";

interface PipelineDispatchCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The effective `pipeline_enabled` setting could not be read and the user
   * has not chosen, so the box shows the product default while the server
   * decides. Say so rather than presenting a guess as the mode.
   */
  unresolved?: boolean;
}

/**
 * The "run full pipeline" option offered by every build dispatch dialog. The
 * copy lives here once so every surface explains the mode identically.
 */
export function PipelineDispatchCheckbox({
  checked,
  onChange,
  unresolved = false,
}: PipelineDispatchCheckboxProps) {
  const t = useTranslations("Shared");

  return (
    <div className="space-y-1">
      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          data-testid="pipeline-checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          <span className="font-medium">{t("pipelineDispatch.label")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("pipelineDispatch.hint")}
          </span>
        </span>
      </label>
      {unresolved && (
        <p
          className="text-xs text-muted-foreground pl-6"
          data-testid="pipeline-setting-unresolved"
        >
          {t.rich("pipelineDispatch.unresolved", {
            code: (chunks) => <code>{chunks}</code>,
          })}
        </p>
      )}
    </div>
  );
}
