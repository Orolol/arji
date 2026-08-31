"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * UnderlineTabNav — 7a's five workshop tabs, and the project tab bar reused by
 * 8b and 8c (rendered from the foundation-owned project layout).
 *
 * The active tab's 3px underline is deliberately the SAME weight as a band
 * label's underline — keep them identical.
 *
 * Inactive tabs carry a 3px *transparent* underline so activating a tab never
 * shifts the baseline.
 *
 * Client component: the active tab is decided from `usePathname()`.
 */
export interface UnderlineTabNavItem {
  href: string;
  label: string;
  /**
   * Match the pathname exactly. Without it a tab is also active for its own
   * sub-routes (`/x` matches `/x/y`), which is what an index tab wants to
   * avoid — mark the index tab `exact`.
   */
  exact?: boolean;
}

export interface UnderlineTabNavProps {
  items: UnderlineTabNavItem[];
  className?: string;
}

function isActive(pathname: string, item: UnderlineTabNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function UnderlineTabNav({ items, className }: UnderlineTabNavProps) {
  const pathname = usePathname() ?? "";

  return (
    <nav
      data-slot="underline-tab-nav"
      className={cn("flex items-center gap-[16px]", className)}
    >
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            data-active={active ? "" : undefined}
            className={cn(
              "font-sans px-[2px] py-[4px] text-[13px]",
              "border-b-[3px]",
              active
                ? "border-foreground font-bold text-foreground"
                : "border-transparent font-medium text-muted-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
