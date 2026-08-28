"use client";

import { Suspense } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { DeskHeader, UnderlineTabNav, pillButtonVariants } from "@/components/piscine";
import { cn } from "@/lib/utils";

import { FrictionsPill } from "./FrictionsPill";

/**
 * The 60px workshop header: logo square, "Agents", the five tabs, then the
 * right cluster.
 *
 * IT DOES NOT READ THE SEARCH PARAMS ITSELF, and that is deliberate.
 * `useSearchParams()` opts a subtree out of server rendering, so a header that
 * called it would arrive as an empty 60px strip on first paint and only fill in
 * after hydration. The one thing here that needs the param is the Frictions
 * pill, which is conditional and usually absent — so it owns the hook, and its
 * own `Suspense fallback={null}` costs nothing when it renders nothing. The
 * tabs use `usePathname()`, which has no such cost.
 *
 * It lives in app/agents/layout.tsx so every tab shares one header instance and
 * the tab bar never remounts on navigation.
 */
const TABS = [
  { href: "/agents", label: "Named agents", exact: true },
  { href: "/agents/assignments", label: "Assignments" },
  { href: "/agents/prompts", label: "Prompts" },
  { href: "/agents/limits", label: "Limits" },
  { href: "/usage", label: "Usage" },
];

export function WorkshopHeader() {
  return (
    <DeskHeader title="Agents">
      <UnderlineTabNav items={TABS} className="ml-[10px]" />
      <div className="ml-auto flex items-center gap-2">
        <Suspense fallback={null}>
          <FrictionsPill />
        </Suspense>
        <Link
          href="/"
          className={cn(
            pillButtonVariants({ variant: "filled", size: "md" }),
            "px-[13px] no-underline",
          )}
        >
          <ArrowLeft size={13} aria-hidden="true" />
          Back to board
        </Link>
      </div>
    </DeskHeader>
  );
}
