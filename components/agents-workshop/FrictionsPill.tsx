"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { pillButtonVariants } from "@/components/piscine";
import { cn } from "@/lib/utils";

/**
 * `Frictions · N open` in the workshop header.
 *
 * CONDITIONAL BY DESIGN. Frictions are per project — there is no cross-project
 * rollup endpoint, and summing would mean one request per project from a page
 * header. So the pill appears only when /agents is opened with `?project=`,
 * and is omitted entirely otherwise. An affordance with no destination is
 * worse than its absence, and `Frictions · — open` would be exactly that.
 *
 * The border stays NEUTRAL; only the label and its icon are coral. It is a
 * real link, so it composes `pillButtonVariants` rather than nesting an
 * anchor inside a `<button>` — the recipe is exported for exactly this.
 *
 * It reads `?project=` itself rather than taking it as a prop, so that the
 * `useSearchParams()` bailout is contained to this one optional pill instead of
 * costing the whole header its server render. Its caller wraps it in
 * `Suspense fallback={null}`.
 */
export function FrictionsPill() {
  const projectId = useSearchParams().get("project")?.trim() || null;
  const [openCount, setOpenCount] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    async function loadCount() {
      try {
        const response = await fetch(`/api/projects/${projectId}/frictions`);
        const payload = await response.json();
        if (!cancelled && response.ok) {
          setOpenCount(payload.data?.openCount ?? 0);
        }
      } catch {
        // The workshop stays usable when the optional summary cannot load.
      }
    }

    void loadCount();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // No project in scope, or the count has not landed: there is no honest
  // number to print, and an affordance with no destination is worse than its
  // absence — `Frictions · — open` would be exactly that.
  if (!projectId || openCount === null) return null;

  return (
    <Link
      href={`/projects/${projectId}/frictions`}
      data-testid="agents-frictions-pill"
      className={cn(
        pillButtonVariants({ variant: "outline", outlineTone: "neutral", size: "md" }),
        "gap-1.5 px-3 text-[12px] text-destructive no-underline",
      )}
    >
      <TriangleAlert size={12} aria-hidden="true" />
      {`Frictions · ${openCount} open`}
    </Link>
  );
}
