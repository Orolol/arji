/**
 * The global navigation model — frame 13a.
 *
 * ONE definition of "what the app contains", shared by the top bar, by the
 * screens that need to know where they sit, and by the tests. Three categories,
 * each reusing a strata ground, each with an ordered list of entries:
 *
 *   Work      pool blue  (next)  Tickets · Spec & Memory · QA · Releases
 *   Agents    turquoise  (live)  Named agents · Sessions · Chat · Usage
 *   Réglages  linden     (feed)  Workspace & Full Auto · Night runs ·
 *                                Notifications · Intégrations
 *
 * "Now" is NEVER a category, and nothing here describes it — but the bar now
 * DRAWS it as a fourth pill, first in the centred island, ahead of these three.
 *
 * The distinction is the whole point. A category owns a menu, a strata ground,
 * an entry list and a panel; the model above is what supplies all four. Now
 * owns none of them: it is a plain link to the desk, with no menu, no
 * `aria-haspopup` and no hover intent. It shares the pill shape and the active
 * liseré with its neighbours because it is a peer DESTINATION, not because it
 * is a peer category — and it is drawn in the bar rather than declared here so
 * that `activeNavCategory` keeps returning `null` on `/`, which is what stops
 * the three real bubbles from lighting up on the desk.
 *
 * TWO KINDS OF UNREACHABLE ENTRY, and they are different on purpose:
 *
 * - `planned` — the screen does not exist yet. The path is recorded here so
 *   the screen agent has one place to match, but the entry never links: a dead
 *   link that 404s is worse than a visibly soft one. NOTHING carries this flag
 *   today — 12a Tickets, 11b QA and 11a Chat all shipped in wave 2 — and the
 *   mechanism is kept for the next screen that is claimed before it is built.
 * - `forProject` — the screen exists but only per project (`/projects/:id/…`).
 *   It resolves against the ACTIVE PROJECT, which is the one in the URL and,
 *   off a project route, the last one the user actually visited — see
 *   `resolveScopeProjectId`. It renders soft only when there is no such
 *   project at all.
 *
 * `resolveNavHref` is the single answer to "can I click this, and where does it
 * go?" — `null` means "not right now", whichever of the two reasons applies.
 */

import {
  Activity,
  Bell,
  Bot,
  FileText,
  Gauge,
  Github,
  Layers,
  MessageSquare,
  Moon,
  Rows3,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  type LucideIcon,
} from "lucide-react";

import type { Stratum } from "./tokens";

export type NavCategoryId = "work" | "agents" | "settings";

export interface NavEntry {
  /** Stable key. Also the id the top bar looks up a live status under. */
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * The route this entry MEANS. For a per-project entry this is the template
   * (`/projects/:projectId/spec`) and `forProject` builds the real path — the
   * string is still the documentation of record.
   */
  href: string;
  /** Present exactly when `href` is a per-project template. */
  forProject?: (projectId: string) => string;
  /** The route does not exist yet. Renders soft; never links. */
  planned?: boolean;
}

export interface NavCategory {
  id: NavCategoryId;
  label: string;
  icon: LucideIcon;
  /** Which strata ground the bubble and its menu reuse. */
  stratum: Extract<Stratum, "next" | "live" | "feed">;
  entries: readonly NavEntry[];
  /**
   * The menu's right-hand context panel. `morning` = the CE MATIN digest,
   * `live` = the EN CE MOMENT agent list, `null` = no panel (the menu card is
   * then a single narrow column, as Réglages is drawn).
   */
  panel: "morning" | "live" | null;
}

export const NAV_CATEGORIES: readonly NavCategory[] = [
  {
    id: "work",
    label: "Work",
    icon: Layers,
    stratum: "next",
    panel: "morning",
    entries: [
      // 12a — the exhaustive ticket registry. It is also where "New" leads.
      { id: "tickets", label: "Tickets", icon: Rows3, href: "/tickets" },
      {
        id: "spec",
        label: "Spec & Memory",
        icon: FileText,
        href: "/projects/:projectId/spec",
        forProject: (projectId) => `/projects/${projectId}/spec`,
      },
      // 11b — cross-project QA. The per-project /projects/:id/qa still exists
      // but is the OLD screen, not this entry.
      { id: "qa", label: "QA", icon: ShieldCheck, href: "/qa" },
      {
        id: "releases",
        label: "Releases",
        icon: Tag,
        href: "/projects/:projectId/releases",
        forProject: (projectId) => `/projects/${projectId}/releases`,
      },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    icon: Bot,
    stratum: "live",
    panel: "live",
    entries: [
      { id: "named-agents", label: "Named agents", icon: Bot, href: "/agents" },
      {
        id: "sessions",
        label: "Sessions",
        icon: Activity,
        href: "/projects/:projectId/sessions",
        forProject: (projectId) => `/projects/${projectId}/sessions`,
      },
      // 11a — chat as a full page.
      { id: "chat", label: "Chat", icon: MessageSquare, href: "/chat" },
      { id: "usage", label: "Usage", icon: Gauge, href: "/usage" },
    ],
  },
  {
    id: "settings",
    label: "Réglages",
    icon: SlidersHorizontal,
    stratum: "feed",
    panel: null,
    entries: [
      // 11c is ONE page with sections; `?tab=` names the section. /settings
      // exists today and ignores an unknown tab, so none of these 404 — they
      // land on the settings page, which is why they are not `planned`.
      {
        id: "workspace",
        label: "Workspace & Full Auto",
        icon: SlidersHorizontal,
        href: "/settings",
      },
      { id: "night-runs", label: "Night runs", icon: Moon, href: "/settings#night-runs" },
      {
        id: "notifications",
        label: "Notifications",
        icon: Bell,
        href: "/settings#notifications",
      },
      {
        id: "integrations",
        label: "Intégrations",
        icon: Github,
        href: "/settings/integrations",
      },
    ],
  },
];

/**
 * Where this entry leads right now, or `null` when it leads nowhere: the route
 * is not built yet, or it is per-project and no project is active.
 */
export function resolveNavHref(
  entry: NavEntry,
  activeProjectId: string | null,
): string | null {
  if (entry.planned) return null;
  if (entry.forProject) {
    return activeProjectId ? entry.forProject(activeProjectId) : null;
  }
  return entry.href;
}

/** Why an entry has no destination — the top bar turns this into a tooltip. */
export function navHrefBlockedReason(
  entry: NavEntry,
  activeProjectId: string | null,
): "planned" | "needs-project" | null {
  if (entry.planned) return "planned";
  if (entry.forProject && !activeProjectId) return "needs-project";
  return null;
}

/** Strip the query so `?tab=` variants compare on their path alone. */
function pathOf(href: string): string {
  const query = href.indexOf("?");
  return query === -1 ? href : href.slice(0, query);
}

/**
 * Is the current route this entry's route?
 *
 * A prefix match on the path, so `/agents/limits` keeps "Named agents" lit and
 * `/projects/p1/sessions/s9` keeps "Sessions" lit. Query strings never
 * participate: the four Réglages entries share `/settings`, so only the first
 * of them (the one whose href carries no query) is ever marked active — which
 * is the truth until 11c ships real sections.
 */
export function isNavEntryActive(
  entry: NavEntry,
  pathname: string,
  activeProjectId: string | null,
): boolean {
  const href = resolveNavHref(entry, activeProjectId);
  if (!href) return false;
  if (href.includes("?")) return false;
  const path = pathOf(href);
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * The category the current route belongs to, or `null`.
 *
 * `null` on the desk is CORRECT and load-bearing: "Now" is not a category, so
 * no CATEGORY bubble carries a border there. The bar lights its own Now pill
 * from `pathname === "/"` and never from this function.
 */
export function activeNavCategory(
  pathname: string,
  activeProjectId: string | null,
): NavCategory | null {
  for (const category of NAV_CATEGORIES) {
    for (const entry of category.entries) {
      if (isNavEntryActive(entry, pathname, activeProjectId)) return category;
    }
  }
  return null;
}

/**
 * The destination a CLICK on the bubble takes: the menu's first entry — or,
 * when that one leads nowhere yet, the first that does. `null` when the whole
 * category is currently unreachable, and the bubble then only opens its menu.
 */
export function firstReachableHref(
  category: NavCategory,
  activeProjectId: string | null,
): string | null {
  for (const entry of category.entries) {
    const href = resolveNavHref(entry, activeProjectId);
    if (href) return href;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Which project the per-project entries resolve against               */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS. The bar is on every route, and half of Work (Spec & Memory,
 * Releases) plus Sessions are per-project. Off a `/projects/:id` route the bar
 * used to refuse to pick a project whenever more than one existed — right
 * intent, wrong effect: on a workspace with several projects the Work menu
 * opened with every row soft and nothing to click.
 *
 * The fix is not to guess. It is to remember: the LAST PROJECT THE USER
 * ACTUALLY VISITED is a choice they made, not an arbitrary pick, so it stands
 * in when the URL says nothing. The id is written on every `/projects/:id`
 * route and validated against the live project list before it is used, so a
 * deleted or archived project can never leave a stale link behind.
 */
export const LAST_PROJECT_STORAGE_KEY = "arij:piscine:last-project";

/**
 * The remembered project, or `null` on the server and whenever storage is
 * unavailable (Safari private mode throws on `localStorage` access, and a bar
 * that crashed the whole app over a nav convenience would be absurd).
 */
export function readLastVisitedProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Record a real visit. Called from a `/projects/:id` route and nowhere else. */
export function rememberVisitedProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Best effort: the bar falls back to "no project in scope".
  }
}

export interface ScopeProjectInput {
  /** The project in the URL, from `projectIdFromPath`. */
  routeProjectId: string | null;
  /** What `readLastVisitedProjectId()` returned, or `null` before hydration. */
  lastVisitedProjectId: string | null;
  /** The projects that exist right now — a remembered id must still be one. */
  knownProjectIds: readonly string[];
}

/**
 * The project a per-project nav entry resolves against.
 *
 * In order: the URL (it is the current truth), then the last project visited
 * (a real choice, and only while it still exists), then the sole project of a
 * one-project workspace (there is nothing to disambiguate). `null` means the
 * entry genuinely has nowhere to go and must render soft.
 */
export function resolveScopeProjectId({
  routeProjectId,
  lastVisitedProjectId,
  knownProjectIds,
}: ScopeProjectInput): string | null {
  if (routeProjectId) return routeProjectId;
  if (lastVisitedProjectId && knownProjectIds.includes(lastVisitedProjectId)) {
    return lastVisitedProjectId;
  }
  if (knownProjectIds.length === 1) return knownProjectIds[0];
  return null;
}
