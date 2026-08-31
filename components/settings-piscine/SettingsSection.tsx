import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SettingsSection — a `<section>` around one {@link StrataBand}.
 *
 * `StrataBand` is a frozen primitive: it takes `className` and nothing else,
 * so there is no way to hang an `id` (the top bar's `?tab=` deep links scroll
 * to one), a `data-testid` (six existing suites scope their queries with one)
 * or a real heading role on a band without wrapping it. The wrapper is a
 * block-level flex column, so a band inside it lays out exactly as it does
 * bare — in a flex column and as a grid cell alike.
 *
 * `heading` renders a visually-hidden `<h2>`: the visible band label is a
 * styled `<span>`, and a settings page that a screen reader cannot navigate by
 * heading is a settings page nobody can navigate.
 */
export interface SettingsSectionProps {
  /** Anchor target for `/settings?tab=…`. */
  id?: string;
  testId?: string;
  /** Visually-hidden `<h2>` giving the band a real heading role. */
  heading?: string;
  className?: string;
  children: React.ReactNode;
}

export function SettingsSection({
  id,
  testId,
  heading,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <section
      id={id}
      data-testid={testId}
      className={cn("flex min-w-0 shrink-0 flex-col scroll-mt-[14px]", className)}
    >
      {heading ? <h2 className="sr-only">{heading}</h2> : null}
      {children}
    </section>
  );
}
