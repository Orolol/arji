import type { ReactNode } from "react";

/**
 * Labeled field shell shared by the agent-config forms. Every control on
 * these screens carries a visible label and a one-line hint — no field may
 * rely on its placeholder alone.
 */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-xs font-medium leading-none text-foreground"
      >
        {label}
      </label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
