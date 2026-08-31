"use client";

import { Suspense } from "react";

import { UnderlineTabNav } from "@/components/piscine";

import { FrictionsPill } from "./FrictionsPill";

/**
 * The workshop's SECOND ROW — the five tabs, and the Frictions pill on the
 * right.
 *
 * IT IS NOT A HEADER ANY MORE. It used to be a 60px `DeskHeader` with a logo
 * square, the word "Agents" and a filled "Back to board" — every one of which
 * the global bar (`components/piscine/TopBar.tsx`) now draws once for the whole
 * app, 60px above. What is left is the only thing the bar does not carry: which
 * page of the workshop you are on. So the gutter is the 14px BODY gutter, not
 * the 24px header gutter, and there is no filled button in the row.
 *
 * IT DOES NOT READ THE SEARCH PARAMS ITSELF, and that is deliberate.
 * `useSearchParams()` opts a subtree out of server rendering, so a row that
 * called it would arrive empty on first paint and only fill in after hydration.
 * The one thing here that needs the param is the Frictions pill, which is
 * conditional and usually absent — so it owns the hook, and its own
 * `Suspense fallback={null}` costs nothing when it renders nothing. The tabs
 * use `usePathname()`, which has no such cost.
 *
 * It lives in app/agents/layout.tsx so every tab shares one instance and the
 * tab bar never remounts on navigation.
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
    <div
      data-testid="workshop-controls"
      className="flex h-[44px] shrink-0 items-center gap-[12px] px-[14px]"
    >
      <UnderlineTabNav items={TABS} />
      <div className="ml-auto flex items-center gap-2">
        <Suspense fallback={null}>
          <FrictionsPill />
        </Suspense>
      </div>
    </div>
  );
}
