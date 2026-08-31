"use client";

interface PipelineDispatchCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The "run full pipeline" option offered by every build dispatch dialog. The
 * copy lives here once so every surface explains the mode identically.
 */
export function PipelineDispatchCheckbox({
  checked,
  onChange,
}: PipelineDispatchCheckboxProps) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5"
        data-testid="pipeline-checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">
          Run full pipeline (build → review → auto-fix)
        </span>
        <span className="block text-xs text-muted-foreground">
          After the build, Arij runs a code review and dispatches fix agents
          until the review is clean. Stopping the running session stops the
          pipeline.
        </span>
      </span>
    </label>
  );
}
