import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { AvatarSquare } from "@/components/piscine/AvatarSquare";

/**
 * DeskHeader — the 60px page-header shell shared by 5a, 7a, 8a, 8b, 8c and 8d.
 *
 * Only the shell, the logo square and the page title are shared. Every screen
 * composes its OWN right cluster and passes it as `children`; push it right
 * with `ml-auto` on the first element, exactly as the frames do.
 *
 * No bottom border, no shadow — the header sits directly on the shell paper.
 *
 * The header gutter is 24px while every body gutter is 14px. That asymmetry is
 * intentional; do not unify it.
 */
export interface DeskHeaderProps {
  /** Page title, e.g. "Now". Rendered in Bricolage 17px/700. */
  title: string;
  /** When given, the title becomes a link (typically back to the desk). */
  titleHref?: string;
  /** The screen's own right cluster. Give its first element `ml-auto`. */
  children?: React.ReactNode;
  className?: string;
}

const TITLE_CLASS =
  "font-display text-[17px] font-bold tracking-[-0.01em] text-foreground";

export function DeskHeader({
  title,
  titleHref,
  children,
  className,
}: DeskHeaderProps) {
  return (
    <header
      data-slot="desk-header"
      className={cn(
        "flex h-[60px] shrink-0 items-center gap-[14px] px-[24px]",
        className,
      )}
    >
      <AvatarSquare label="A" tone="action" size={30} />
      {titleHref ? (
        <Link href={titleHref} className={TITLE_CLASS}>
          {title}
        </Link>
      ) : (
        <span className={TITLE_CLASS}>{title}</span>
      )}
      {children}
    </header>
  );
}
