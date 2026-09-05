"use client";

/**
 * QuietLink — the chromeless inline link ending in →.
 *
 * "open full session →", "open usage →", "open diff →", "voir le prompt exact →",
 * "régénérer", "N autres bloqués par des findings ouverts →".
 *
 * The arrow is a literal U+2192 inside the children, NOT an icon — pass it:
 *   <QuietLink href="/x">open diff →</QuietLink>
 *
 * No background, no border, no underline. Hover darkens 8%.
 * Size 12 is the card-header variant (600); 11.5 is the quieter on-ground
 * variant (400).
 */

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

/** Named so the contract is explicit rather than inferred. */
export type QuietLinkTone = "next" | "live" | "land" | "muted";

const TONE_CLASS: Record<QuietLinkTone, string> = {
  next: "text-strata-next-deep",
  live: "text-strata-live-deep",
  land: "text-strata-land-mid",
  muted: "text-muted-foreground",
};

export interface QuietLinkProps {
  href?: string;
  onClick?: () => void;
  tone?: QuietLinkTone;
  size?: 11.5 | 12;
  /**
   * `data-testid` on the interactive element itself. Additive: a test has to
   * be able to CLICK the link, so the id cannot live on a wrapper.
   */
  testId?: string;
  className?: string;
  children: React.ReactNode;
}

export function QuietLink({
  href,
  onClick,
  tone = "next",
  size = 12,
  testId,
  className,
  children,
}: QuietLinkProps) {
  const classes = cn(
    "inline-flex items-center gap-1 border-0 bg-transparent p-0",
    "cursor-pointer font-sans leading-none no-underline shadow-none outline-none",
    "hover:brightness-[0.92] dark:hover:brightness-[1.12]",
    "transition-[filter,opacity] duration-150 motion-reduce:transition-none",
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
    size === 12 ? "text-[12px] font-semibold" : "text-[11.5px] font-normal",
    TONE_CLASS[tone],
    className,
  );

  if (href) {
    return (
      <Link
        data-slot="quiet-link"
        data-testid={testId}
        href={href}
        onClick={onClick}
        className={classes}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      data-slot="quiet-link"
      data-testid={testId}
      type="button"
      onClick={onClick}
      className={classes}
    >
      {children}
    </button>
  );
}
