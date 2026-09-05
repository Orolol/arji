"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  Inbox,
  Infinity as InfinityIcon,
  Plus,
  Radar,
  Search,
} from "lucide-react";

// The palette is mounted here because the bar is the only thing on every
// route. It imports the leaf modules directly, never the `@/components/piscine`
// barrel — the barrel exports this file, and going through it would close an
// import cycle.
import { DeskCommandPalette } from "@/components/desk/DeskCommandPalette";
import { useAutoModeArmed, isProjectArmed } from "@/hooks/useAutoModeArmed";
import { useControlDesk } from "@/hooks/useControlDesk";
import { useInbox } from "@/hooks/useInbox";
import { useProjects } from "@/hooks/useProjects";
import type { NavCategory, NavCategoryId } from "@/lib/piscine/nav";
import {
  NAV_CATEGORIES,
  activeNavCategory,
  firstReachableHref,
  readLastVisitedProjectId,
  readNoVisitedProjectId,
  rememberVisitedProjectId,
  resolveScopeProjectId,
  subscribeLastVisitedProjectId,
} from "@/lib/piscine/nav";
import { projectTone } from "@/lib/piscine/tokens";
import type { DashboardProject } from "@/lib/types/dashboard";
import { cn } from "@/lib/utils";

import { BreathingDot } from "./BreathingDot";
import { IdentityChip } from "./IdentityChip";
import { Mono } from "./Mono";
import { PillButton, pillButtonVariants } from "./PillButton";
import { TopBarMenu } from "./TopBarMenu";

/**
 * TopBar — the ONE global chrome of the app (frame 13a).
 *
 * It replaces both the left project rail (`components/layout/Sidebar.tsx`,
 * retired with this component) and the 60px header every screen used to draw
 * for itself. Mounted once in `app/layout.tsx`, so it is on every route.
 *
 * THE THREE ZONES, and what each is allowed to say:
 *
 * - LEFT is identity, and ONLY identity: the `A` mark, which links to the desk.
 *   Then the project chips: the ACTIVE one (the project in the URL) wears its
 *   pastel fill, the others are deep text on paper. Colour here is WHO, never
 *   state; the only state a chip carries is the breathing dot of a project with
 *   a live agent, and that is motion.
 * - CENTER is navigation, absolutely centred so it does not drift when the
 *   project list grows. FOUR pills: `Now`, then the three category bubbles
 *   reusing three strata grounds. On a bubble, hover opens the menu and click
 *   goes to the menu's first reachable entry; the active one wears a 1.5px
 *   border in its own under-colour plus a chevron.
 *
 *   `Now` IS A DESTINATION, NOT A CATEGORY. It carries the same pill shape and
 *   the same active liseré as its three neighbours, and nothing else of their
 *   behaviour: no menu, no hover intent, no `aria-haspopup`, no chevron. It sat
 *   in the LEFT zone as "A · Now" until this change, which read as branding —
 *   the desk is one of the app's four destinations, so it is drawn as one.
 *   `NAV_CATEGORIES` is unchanged; see the head of `lib/piscine/nav.ts`.
 * - RIGHT never changes, on any route: ⌘K, inbox, Auto, New.
 *
 * DATA, AND WHAT IT COSTS. The bar is on every route, so it may not carry the
 * desk's poll: at rest it reads `useProjects` (one fetch, refreshed when the
 * route changes) and `useInbox` (the 5s poll the retired rail already ran). The
 * control-desk payload — entry counts, the CE MATIN digest, EN CE MOMENT — is
 * read by `TopBarMenu`, which only exists while a menu is open. Full Auto is a
 * per-project setting with no global flag, so `useAutoModeArmed` reads the same
 * settings chain the supervisor reads, once.
 *
 * THE LOGO IS `--action`, NOT INK. Frame 13a paints the pill #2e2d28 (ink)
 * while every other frame paints the logo mark `var(--action)`, and
 * `AvatarSquare` already shipped the latter. One logo colour across the app
 * wins, and it is the only one that survives night: `--foreground` inverts to
 * cream, which would make the pill the loudest object on a dark screen.
 */

/** Hover-intent: open after this, so crossing the bar does not flash menus. */
const HOVER_OPEN_MS = 120;
/** Grace period on the way out, so the pointer can cross the 8px gap. */
const HOVER_CLOSE_MS = 260;
/** Desk poll cadence while ⌘K is held open. Slower than the desk's own 4s. */
const PALETTE_POLL_MS = 10_000;

/**
 * Half the centred pill island, in px, and the clearance the left zone keeps
 * from it.
 *
 * The island is absolutely centred, so the left zone cannot push it — it would
 * slide UNDERNEATH. Its cap is therefore a hard number, and a wrong one is
 * invisible until a workspace has enough projects to reach it.
 *
 * MEASURED IN CHROME, not derived: `top-bar-island` reports 398px at 1440×950
 * with the default text size, so half is 199. The fourth pill is 89px of that,
 * plus the 7px gap it added — which is why this number moved with this change.
 * `__tests__/top-bar.test.tsx` pins BOTH the resulting max-width and the pill
 * count it was measured for, so a fifth pill fails loudly instead of silently
 * sliding the project chips under the island.
 */
const ISLAND_HALF_WIDTH_PX = 199;

/** Breathing room between the last project chip and the island's left edge. */
const ISLAND_CLEARANCE_PX = 15;

/** Bubble colours per stratum. Written out in full — Tailwind scans literals. */
const BUBBLE_CLASS: Record<NavCategory["stratum"], string> = {
  next: "bg-strata-next text-strata-next-deep",
  live: "bg-strata-live text-strata-live-deep",
  feed: "bg-strata-feed text-strata-feed-deep",
};

/** The active bubble's 1.5px liseré, in its own under-colour. */
const BUBBLE_ACTIVE_BORDER: Record<NavCategory["stratum"], string> = {
  next: "border-strata-next-under",
  live: "border-strata-live-under",
  feed: "border-strata-feed-under",
};

export interface TopBarProps {
  className?: string;
}

export function TopBar({ className }: TopBarProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();

  const { allProjects, refresh: refreshProjects } = useProjects();
  const { unreadCount } = useInbox();
  const autoMode = useAutoModeArmed();
  const refreshAutoMode = autoMode.refresh;

  /**
   * Revalidate on navigation instead of on a timer. The rail this replaces
   * fetched projects exactly once and never refreshed; a route change is the
   * cheapest honest moment to re-read, and it keeps the bar off the poll
   * budget the desk already spends.
   */
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      // useProjects loads itself on mount; auto-mode has no initial load.
      void refreshAutoMode();
      return;
    }
    void refreshProjects();
    void refreshAutoMode();
  }, [pathname, refreshProjects, refreshAutoMode]);

  /**
   * Project identity colours must agree with the desk's, which walks the
   * 4-colour cycle in CREATION order over every project (archived included —
   * hiding one must not re-colour the others). Same rule as
   * `deriveProjects()` in lib/control-desk/aggregate.ts.
   */
  const colorIndexById = useMemo(() => {
    const ordered = [...allProjects].sort((a, b) => {
      const byCreated = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      if (byCreated !== 0) return byCreated;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const map = new Map<string, number>();
    ordered.forEach((project, index) => map.set(project.id, index));
    return map;
  }, [allProjects]);

  const visibleProjects = useMemo(
    () => allProjects.filter((project) => project.status !== "archived"),
    [allProjects],
  );

  const routeProjectId = projectIdFromPath(pathname);

  /**
   * The project per-project menu entries (Spec & Memory, Sessions, Releases)
   * resolve against — see `resolveScopeProjectId`.
   *
   * READ AFTER MOUNT, NEVER DURING RENDER. `localStorage` does not exist on the
   * server, so the first client render has to match the server's: the server
   * snapshot is `null` and the client snapshot takes over on hydration. Every
   * visit to a `/projects/:id` route writes it back.
   *
   * This is a read of an external store, so it is one — mirroring it into state
   * from an effect was the same value held twice, and the copy cost a second
   * render on every project visit.
   *
   * That store is document-local and merely SEEDED from `localStorage`; see
   * `readLastVisitedProjectId`. The shared key is where the choice persists,
   * never the live value, so another tab cannot move this bar's project scope
   * and a refused write cannot lose the visit that just happened.
   */
  const lastVisitedProjectId = useSyncExternalStore(
    subscribeLastVisitedProjectId,
    readLastVisitedProjectId,
    readNoVisitedProjectId,
  );

  useEffect(() => {
    if (!routeProjectId) return;
    // The write notifies the store, which is what re-renders the bar.
    rememberVisitedProjectId(routeProjectId);
  }, [routeProjectId]);

  const knownProjectIds = useMemo(
    () => visibleProjects.map((project) => project.id),
    [visibleProjects],
  );

  const scopeProjectId = resolveScopeProjectId({
    routeProjectId,
    lastVisitedProjectId,
    knownProjectIds,
  });

  const liveSessionCount = allProjects.reduce(
    (total, project) => total + (project.activeAgents || 0),
    0,
  );

  const armedCount = visibleProjects.filter((project) =>
    isProjectArmed(autoMode, project.id),
  ).length;
  const autoOn = autoMode.loaded && armedCount > 0;

  const activeCategory = activeNavCategory(pathname, scopeProjectId);

  /*
    The desk is EXACTLY `/`, never a prefix: every other route in the app is a
    child of `/`, so `startsWith` would light Now everywhere. `activeCategory`
    is null here, which is what keeps the three bubbles unlit on the desk.
  */
  const onDesk = pathname === "/";

  /* ---- menu open/close ------------------------------------------------ */

  const [openId, setOpenId] = useState<NavCategoryId | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // A navigation always dismisses the menu, however it was triggered. The
  // pending hover-intent timers are an external resource, so cancelling them
  // stays in an effect; the state reset itself is the guard below.
  useEffect(() => {
    clearTimers();
  }, [pathname, clearTimers]);

  const open = useCallback(
    (id: NavCategoryId) => {
      clearTimers();
      setOpenId(id);
    },
    [clearTimers],
  );

  const hoverOpen = useCallback(
    (id: NavCategoryId) => {
      clearTimers();
      openTimer.current = setTimeout(() => setOpenId(id), HOVER_OPEN_MS);
    },
    [clearTimers],
  );

  const hoverClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpenId(null), HOVER_CLOSE_MS);
  }, [clearTimers]);

  const close = useCallback(() => {
    clearTimers();
    setOpenId(null);
  }, [clearTimers]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape" && openId) {
      event.stopPropagation();
      close();
    }
  };

  /* ---- ⌘K ------------------------------------------------------------ */

  /**
   * THE ONE BINDING. The desk used to listen on `window` for ⌘K and render its
   * own palette, which meant "/" and `/projects/:id` each carried a second
   * listener fighting this one — two components toggling two different pieces
   * of state off the same keystroke. The bar is on every route, so the shortcut
   * belongs here and nowhere else; `NowDesk` no longer binds it.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * A navigation dismisses the palette, exactly as it dismisses a menu.
   *
   * Adjusted during render rather than from an effect. Both resets used to run
   * in `useEffect`, which meant the new route painted for one frame with the
   * old menu or palette still open before a second render tore it down. React
   * re-runs this component before committing, so the route change and the
   * dismissal land in the same paint.
   */
  const [renderedPathname, setRenderedPathname] = useState(pathname);
  if (renderedPathname !== pathname) {
    setRenderedPathname(pathname);
    setOpenId(null);
    setPaletteOpen(false);
  }

  const openPaletteResult = useCallback(
    (href: string) => {
      setPaletteOpen(false);
      router.push(href);
    },
    [router, setPaletteOpen],
  );

  return (
    <header
      data-testid="top-bar"
      className={cn(
        "relative z-40 flex h-[60px] shrink-0 items-center gap-[16px] bg-background px-[24px]",
        className,
      )}
    >
      {/* ── LEFT: identity ────────────────────────────────────────────── */}
      {/*
        The centre pills are absolutely positioned, so a growing project list
        would slide UNDER them instead of pushing them. The cap keeps the left
        zone clear of the pill group — measured, not guessed: see
        ISLAND_HALF_WIDTH_PX — and the chips scroll inside it.
      */}
      <div
        className="flex min-w-0 items-center gap-[10px]"
        style={{ maxWidth: `calc(50% - ${ISLAND_HALF_WIDTH_PX + ISLAND_CLEARANCE_PX}px)` }}
      >
        <Link
          href="/"
          data-testid="top-bar-home"
          aria-label="Now — control desk"
          className={cn(
            "flex size-[34px] shrink-0 items-center justify-center rounded-full",
            "bg-action text-action-foreground no-underline outline-none",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          )}
        >
          <span className="font-display text-[15px] font-bold leading-none">A</span>
        </Link>

        <span aria-hidden="true" className="h-[18px] w-[1.5px] shrink-0 bg-border" />

        <div
          data-testid="top-bar-project-chips"
          className={cn(
            "flex min-w-0 items-center gap-[5px] overflow-x-auto",
            // The chips scroll; they must never push the right cluster away.
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {visibleProjects.map((project) => (
            <ProjectChip
              key={project.id}
              project={project}
              colorIndex={colorIndexById.get(project.id) ?? 0}
              active={routeProjectId === project.id}
            />
          ))}

          <Link
            href="/projects/new"
            aria-label="New project"
            data-testid="top-bar-add-project"
            className={cn(
              "flex size-[26px] shrink-0 items-center justify-center rounded-full",
              "border-[1.5px] border-dashed border-border-strong text-muted-foreground",
              "outline-none transition-colors hover:text-foreground motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          >
            <Plus size={12} aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* ── CENTER: the three category bubbles ────────────────────────── */}
      {/*
        `inset-y-0` makes this container the full 60px of the bar, so the menu's
        `top: 100%` lands on the bar's bottom edge rather than on the 32px
        bubble's — which would have the card overlapping the bar. The 8px the
        frame draws between the two is padding INSIDE the menu wrapper, so the
        pointer never leaves this subtree on its way down; see TopBarMenu.
      */}
      <div
        data-testid="top-bar-island"
        className="absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center gap-[7px]"
        onMouseLeave={hoverClose}
        onKeyDown={onKeyDown}
      >
        {/*
          The desk, as a destination. A LINK, not a button: it has one place to
          go and no menu to open, so it must not answer to the hover intent or
          the arrow keys that drive its three neighbours — hence no
          `onMouseEnter`, no `aria-haspopup` and no chevron. Its liseré is the
          `--action-outline` of its own ground, which is the same rule the
          three bubbles follow with their under-colours.
        */}
        <Link
          href="/"
          data-testid="top-bar-bubble-now"
          data-active={onDesk ? "true" : undefined}
          aria-current={onDesk ? "page" : undefined}
          className={cn(
            "flex h-[32px] shrink-0 cursor-pointer items-center gap-[8px] rounded-full px-[15px]",
            "bg-action font-sans text-[13px] leading-none text-action-foreground",
            "no-underline outline-none",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            // Reserved at rest so the liseré never reflows the row.
            "border-[1.5px] border-transparent",
            onDesk ? "border-action-outline font-bold" : "font-semibold",
          )}
        >
          <Radar size={14} aria-hidden="true" />
          Now
        </Link>

        {NAV_CATEGORIES.map((category) => (
          <CategoryBubble
            key={category.id}
            category={category}
            active={activeCategory?.id === category.id}
            expanded={openId === category.id}
            live={categoryIsLive(category, liveSessionCount)}
            onHoverOpen={() => hoverOpen(category.id)}
            onFocusOpen={() => open(category.id)}
            onActivate={() => {
              const href = firstReachableHref(category, scopeProjectId);
              if (href) {
                close();
                router.push(href);
                return;
              }
              // Nothing in this category is reachable yet: the bubble is then
              // only a menu opener, and the menu explains why.
              open(category.id);
            }}
          />
        ))}

        {openId ? (
          <TopBarMenu
            category={NAV_CATEGORIES.find((category) => category.id === openId)!}
            activeProjectId={scopeProjectId}
            pathname={pathname}
            onNavigate={close}
            onPointerEnter={() => open(openId)}
            onPointerLeave={hoverClose}
          />
        ) : null}
      </div>

      {/* ── RIGHT: the cluster that never changes ─────────────────────── */}
      <div className="ml-auto flex shrink-0 items-center gap-[8px]">
        {/*
          The pill OPENS the palette; it is the same surface ⌘K reaches, and
          the bar owns both. It is not a link any more — there is nowhere to
          lead, the palette is right here.
        */}
        <PillButton
          variant="outline"
          outlineTone="action"
          size="md"
          icon={Search}
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={paletteOpen}
          title="Rechercher — ⌘K"
          data-testid="top-bar-search"
        >
          <Mono size={11}>⌘K</Mono>
        </PillButton>

        <PillButton
          variant="outline"
          outlineTone="neutral"
          iconOnly
          icon={Inbox}
          badge={unreadCount}
          onClick={() => router.push("/inbox")}
          data-testid="top-bar-inbox"
        >
          Inbox
        </PillButton>

        {/*
          Full Auto is PER PROJECT — there is no global flag. The pill is
          turquoise when ANY project is armed and neutral otherwise, and stays
          neutral until the settings read lands: a pill that flashed on and then
          off would be colour claiming a state it did not have.
        */}
        <Link
          href="/settings"
          data-testid="top-bar-auto"
          data-state={autoMode.loaded ? (autoOn ? "on" : "off") : "unknown"}
          title={
            autoMode.loaded
              ? `Full Auto · ${armedCount}/${visibleProjects.length} projets`
              : "Full Auto"
          }
          className={cn(
            pillButtonVariants({ variant: "outline", outlineTone: "neutral", size: "md" }),
            "no-underline",
            autoOn &&
              "border-strata-live-under bg-strata-live text-strata-live-deep hover:border-strata-live-under",
          )}
        >
          <InfinityIcon size={14} aria-hidden="true" />
          Auto
        </Link>

        {/*
          "New" means a new TICKET. It used to point at "/" because the desk's
          linden composer was the only create surface in the app; 12a shipped
          `/tickets/new`, which is a real route — and it has to be a route,
          because this is a `<Link>`.
        */}
        <Link
          href="/tickets/new"
          data-testid="top-bar-new"
          title="New ticket"
          className={cn(
            pillButtonVariants({ variant: "filled", size: "md" }),
            "no-underline",
          )}
        >
          <Plus size={13} aria-hidden="true" />
          New
        </Link>
      </div>

      {paletteOpen ? (
        <CommandPaletteHost
          onClose={() => setPaletteOpen(false)}
          onNavigate={openPaletteResult}
        />
      ) : null}
    </header>
  );
}

/**
 * ⌘K, hosted by the bar.
 *
 * Mounted only while the palette is open, so `useControlDesk` — the heaviest
 * aggregate in the app — costs nothing at rest on a component that renders on
 * every route. Same discipline as `TopBarMenu`.
 *
 * IT NAVIGATES, IT DOES NOT REACH INTO A SCREEN. The desk's version opened the
 * ticket overlay through a React context the bar sits outside of, and filtered
 * the desk in place. From here every result is a URL: a ticket deep-links
 * through `?ticket=`, which `/projects/:id` already reads, and a project opens
 * its own route. That is the only thing that works from /agents or /usage.
 */
function CommandPaletteHost({
  onClose,
  onNavigate,
}: {
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const { data } = useControlDesk(null, PALETTE_POLL_MS);

  return (
    <DeskCommandPalette
      open
      onClose={onClose}
      payload={data}
      onOpenTicket={(epicId, projectId) =>
        onNavigate(`/projects/${projectId}?ticket=${epicId}`)
      }
      onSelectProject={(projectId) => onNavigate(`/projects/${projectId}`)}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function ProjectChip({
  project,
  colorIndex,
  active,
}: {
  project: DashboardProject;
  colorIndex: number;
  active: boolean;
}) {
  return (
    <Link
      href={`/projects/${project.id}`}
      title={project.name}
      data-testid={`top-bar-project-${project.id}`}
      data-active={active ? "true" : undefined}
      className="shrink-0 rounded-full no-underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <IdentityChip
        label={project.name}
        tone={projectTone(colorIndex)}
        size="md"
        // ACTIVE wears the pastel; the rest are deep text on paper.
        fill={active ? "identity" : "none"}
        live={project.activeAgents > 0}
        className={active ? undefined : "font-medium"}
      />
    </Link>
  );
}

function CategoryBubble({
  category,
  active,
  expanded,
  live,
  onHoverOpen,
  onFocusOpen,
  onActivate,
}: {
  category: NavCategory;
  active: boolean;
  expanded: boolean;
  live: boolean;
  onHoverOpen: () => void;
  onFocusOpen: () => void;
  onActivate: () => void;
}) {
  const Icon = category.icon;

  return (
    <button
      type="button"
      data-testid={`top-bar-bubble-${category.id}`}
      data-active={active ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={expanded}
      onMouseEnter={onHoverOpen}
      onFocus={onFocusOpen}
      onClick={onActivate}
      className={cn(
        "flex h-[32px] shrink-0 cursor-pointer items-center gap-[8px] rounded-full px-[15px]",
        "font-sans text-[13px] leading-none outline-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        BUBBLE_CLASS[category.stratum],
        // Reserved at rest so the liseré never reflows the row.
        "border-[1.5px] border-transparent",
        active ? cn("font-bold", BUBBLE_ACTIVE_BORDER[category.stratum]) : "font-semibold",
      )}
    >
      <Icon size={14} aria-hidden="true" />
      {category.label}
      {live ? (
        <span data-testid={`top-bar-live-${category.id}`} className="flex">
          <BreathingDot size={6} />
        </span>
      ) : null}
      {active ? <ChevronDown size={12} aria-hidden="true" /> : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * The project the current route is about, or `null`.
 *
 * `/projects/new` and `/projects/import` are routes, not projects — matching
 * them would light a chip for a project that does not exist.
 */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  const id = match[1];
  return id === "new" || id === "import" ? null : id;
}

/**
 * Does this category contain live activity right now?
 *
 * Only Agents can: a running session is the one thing the bar knows about at
 * rest (summed from `useProjects`), and Sessions is the entry that owns it.
 * The dot is turquoise on every bubble because turquoise means "alive" — it is
 * not the category's own colour.
 */
export function categoryIsLive(
  category: NavCategory,
  liveSessionCount: number,
): boolean {
  if (liveSessionCount <= 0) return false;
  return category.entries.some((entry) => entry.id === "sessions");
}
