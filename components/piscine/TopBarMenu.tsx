"use client";

import * as React from "react";
import { useMemo } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Moon } from "lucide-react";

import { useControlDesk } from "@/hooks/useControlDesk";
import type { NavCategory, NavEntry } from "@/lib/piscine/nav";
import { isNavEntryActive, navHrefBlockedReason, resolveNavHref } from "@/lib/piscine/nav";
import { cn } from "@/lib/utils";

import { BreathingDot } from "./BreathingDot";
import { Mono } from "./Mono";

/**
 * The category menu of frame 13a: a white card, r16, 1.5px border, one row per
 * entry, and — on Work and Agents — a context panel down the right.
 *
 * IT OWNS THE DESK READ, AND ONLY WHILE IT IS OPEN.
 *
 * The bar renders this component only when its category is open, so
 * `useControlDesk` mounts on open and unmounts on close: closed menus cost
 * nothing, and a bar that is on every route never adds a standing poll of the
 * heaviest aggregate in the app. Everything the bar shows AT REST (the project
 * chips, their breathing dots, the live dot on a bubble) comes from the much
 * cheaper `useProjects`, which is why none of it is passed down from here.
 *
 * NO FABRICATED NUMERALS. Every status on the right of an entry is printed only
 * when the desk payload actually carries it; an absent figure is omitted
 * entirely rather than printed as `0`. That is why Tickets, Named agents and
 * the whole Réglages column are statusless: nothing the desk serves answers
 * "how many tickets exist" or "how many named agents are configured", and a
 * plausible-looking substitute would be a lie.
 */

/** Poll cadence while a menu is held open. Slower than the desk's own 4s. */
const OPEN_POLL_MS = 10_000;

/** Per-panel geometry, measured off the frame. */
const CARD: Record<string, { card: number; panel: number }> = {
  morning: { card: 560, panel: 200 },
  live: { card: 540, panel: 190 },
  none: { card: 300, panel: 0 },
};

/** Kicker + active-row ground per category stratum. Written out for Tailwind. */
const STRATUM_CLASS: Record<
  NavCategory["stratum"],
  { kicker: string; activeRow: string; icon: string; link: string }
> = {
  next: {
    kicker: "text-strata-next-deep",
    activeRow: "bg-strata-next",
    icon: "text-strata-next-deep",
    link: "text-strata-next-deep",
  },
  live: {
    kicker: "text-strata-live-deep",
    activeRow: "bg-strata-live",
    icon: "text-strata-live-deep",
    link: "text-strata-live-deep",
  },
  feed: {
    kicker: "text-strata-feed-deep",
    activeRow: "bg-strata-feed",
    icon: "text-strata-feed-deep",
    link: "text-strata-feed-deep",
  },
};

/**
 * The three runs `deriveStatuses` can print, ALREADY RESOLVED by the menu.
 *
 * `deriveStatuses` decides WHICH entry carries a figure and in what tone; the
 * words are the caller's, per `lib/i18n/catalogue.ts` — a helper that composes
 * a display string takes resolved phrases rather than a translator, so every
 * key stays a literal next to a `useTranslations` binding.
 */
export interface EntryStatusCopy {
  blocking: string;
  live: string;
  usage: string;
}

/** The mono run printed at the right of an entry. */
interface EntryStatus {
  text: string;
  tone: "muted" | "danger" | "live-deep";
  /** Prefix the run with a breathing dot ("4 live"). */
  live?: boolean;
}

export interface TopBarMenuProps {
  category: NavCategory;
  /** The project per-project entries resolve against, or `null`. */
  activeProjectId: string | null;
  pathname: string;
  /** Close the menu — called after a row navigates. */
  onNavigate: () => void;
  /** Pointer re-entered the menu: cancel any pending close. */
  onPointerEnter?: () => void;
  /** Pointer left the menu: start the close grace. */
  onPointerLeave?: () => void;
  className?: string;
}

export function TopBarMenu({
  category,
  activeProjectId,
  pathname,
  onNavigate,
  onPointerEnter,
  onPointerLeave,
  className,
}: TopBarMenuProps) {
  const { data } = useControlDesk(null, OPEN_POLL_MS);
  const t = useTranslations();
  const tBar = useTranslations("TopBar");
  const stratum = STRATUM_CLASS[category.stratum];
  const geometry = CARD[category.panel ?? "none"];

  const statuses = useMemo(
    () =>
      deriveStatuses(data, {
        blocking: tBar("status.blocking", { count: String(data?.heldBackCount ?? 0) }),
        live: tBar("status.live", { count: String(data?.working.length ?? 0) }),
        usage: tBar("status.usage", {
          amount: `$${(data?.today.costUsd ?? 0).toFixed(2)}`,
        }),
      }),
    [data, tBar],
  );

  /*
   * The 8px offset below the bar is PADDING on a transparent wrapper, never a
   * margin or a `top` offset on the card itself.
   *
   * The card used to sit at `top: calc(100% + 8px)`, which left 8px of dead
   * space between the bar and the menu. The pointer crossing that band is over
   * the <header>, which is not a descendant of the bubble row that carries
   * `onMouseLeave` — so the browser fired mouseleave mid-traverse and the close
   * timer started before the pointer ever reached the menu. The menu is 560px
   * wide against a 310px bubble row, so any diagonal move toward an outer entry
   * spent long enough in that band to lose the race.
   *
   * Padding keeps the gap inside the subtree: the pointer never leaves the
   * wrapper on its way down, so mouseleave never fires. `onPointerEnter` below
   * is the second line of defence for pointers that exit and come back.
   */
  return (
    <div
      data-testid={`top-bar-menu-${category.id}`}
      role="menu"
      aria-label={t(category.labelKey)}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className={cn(
        "absolute left-1/2 top-full z-50 -translate-x-1/2 pt-[8px]",
        className,
      )}
    >
      {/*
        The card is a fixed 540-560px, which is wider than the phone the bar
        now fits (B-arij-164). A menu opened by the keyboard at 320px would
        otherwise be the one thing left scrolling the page sideways, so the
        width becomes a ceiling there — and the side panel, which carries a
        second fixed 190-200px column, steps out below `sm` rather than
        squeezing the entries it sits next to.
      */}
      <div
        className={cn(
          "flex gap-[12px] rounded-[16px] border-[1.5px] border-border bg-card p-[14px]",
          "max-w-[calc(100vw-20px)]",
        )}
        style={{ width: `${geometry.card}px` }}
      >
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <Mono
          size={9.5}
          weight={700}
          uppercase
          tracking={0.08}
          className={cn("px-[10px] py-[4px]", stratum.kicker)}
        >
          {t(category.labelKey)}
        </Mono>

        {category.entries.map((entry) => (
          <MenuRow
            key={entry.id}
            entry={entry}
            stratum={stratum}
            activeProjectId={activeProjectId}
            pathname={pathname}
            status={statuses.get(entry.id)}
            onNavigate={onNavigate}
          />
        ))}
      </div>

      {category.panel ? (
        <>
          <span aria-hidden="true" className="hidden w-[1.5px] shrink-0 bg-muted sm:block" />
          <div
            className="hidden shrink-0 flex-col gap-[6px] px-[2px] py-[4px] sm:flex"
            style={{ width: `${geometry.panel}px` }}
          >
            {category.panel === "morning" ? (
              <MorningPanel data={data} linkClass={stratum.link} onNavigate={onNavigate} />
            ) : (
              <RightNowPanel data={data} />
            )}
          </div>
        </>
      ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const ROW_CLASS =
  "flex items-center gap-[9px] rounded-[10px] px-[10px] py-[8px] font-sans text-[13px] leading-none";

function MenuRow({
  entry,
  stratum,
  activeProjectId,
  pathname,
  status,
  onNavigate,
}: {
  entry: NavEntry;
  stratum: (typeof STRATUM_CLASS)[NavCategory["stratum"]];
  activeProjectId: string | null;
  pathname: string;
  status: EntryStatus | undefined;
  onNavigate: () => void;
}) {
  const href = resolveNavHref(entry, activeProjectId);
  const blocked = navHrefBlockedReason(entry, activeProjectId);
  const active = isNavEntryActive(entry, pathname, activeProjectId);
  const Icon = entry.icon;
  const t = useTranslations();
  const tBar = useTranslations("TopBar");
  const label = t(entry.labelKey);

  const body = (
    <>
      <Icon
        size={14}
        aria-hidden="true"
        className={cn("shrink-0", active ? stratum.icon : "text-muted-foreground")}
      />
      <span className="min-w-0 truncate">{label}</span>
      {blocked ? (
        <Mono size={11} tone="muted" className="ml-auto shrink-0">
          {blocked === "planned" ? tBar("menu.planned") : tBar("menu.needsProject")}
        </Mono>
      ) : status ? (
        <span className="ml-auto flex shrink-0 items-center gap-[5px]">
          {status.live ? <BreathingDot size={6} /> : null}
          <Mono size={11} tone={status.tone}>
            {status.text}
          </Mono>
        </span>
      ) : null}
    </>
  );

  // No destination: a soft, non-interactive row. The frame has no drawing for
  // this because in the frame every screen exists; a dead link that 404s is the
  // one thing we must not ship instead.
  if (!href) {
    return (
      <span
        data-testid={`top-bar-entry-${entry.id}`}
        data-disabled="true"
        aria-disabled="true"
        title={
          blocked === "planned"
            ? tBar("menu.plannedTitle", { label, href: entry.href })
            : tBar("menu.needsProjectTitle", { label })
        }
        className={cn(ROW_CLASS, "cursor-default font-medium text-muted-foreground opacity-60")}
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      href={href}
      role="menuitem"
      data-testid={`top-bar-entry-${entry.id}`}
      data-active={active ? "true" : undefined}
      onClick={onNavigate}
      className={cn(
        ROW_CLASS,
        "text-foreground no-underline outline-none",
        "transition-colors motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        active ? cn("font-semibold", stratum.activeRow) : "font-medium hover:bg-muted",
      )}
    >
      {body}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Context panels                                                      */
/* ------------------------------------------------------------------ */

const PANEL_KICKER = "text-muted-foreground";

function PanelKicker({ children }: { children: React.ReactNode }) {
  return (
    <Mono size={9.5} weight={700} uppercase tracking={0.08} className={PANEL_KICKER}>
      {children}
    </Mono>
  );
}

/**
 * CE MATIN — the Work digest.
 *
 * Every line is a figure the desk already computed for its own bands. A line
 * whose figure is null or zero is dropped rather than printed, so an empty
 * digest collapses to one dim sentence instead of a wall of noughts.
 */
function MorningPanel({
  data,
  linkClass,
  onNavigate,
}: {
  data: ReturnType<typeof useControlDesk>["data"];
  linkClass: string;
  onNavigate: () => void;
}) {
  // Agreement lives in the catalogue as ICU plurals (`{count, plural, …}`),
  // where the language that needs it declares it — not in a helper here.
  const tBar = useTranslations("TopBar");
  const lines: { key: string; text: string; danger?: boolean }[] = [];

  if (data) {
    const shipped = data.today.ticketsShipped;
    if (shipped !== null && shipped > 0) {
      lines.push({ key: "shipped", text: tBar("digest.shipped", { count: shipped }) });
    }
    if (data.heldBackCount > 0) {
      lines.push({
        key: "blocking",
        text: tBar("digest.blocking", { count: data.heldBackCount }),
        danger: true,
      });
    }
    if (data.readyToLand.length > 0) {
      lines.push({ key: "ready", text: tBar("digest.ready", { count: data.readyToLand.length }) });
    }
    const waiting =
      data.yourTurn.awaitingReply.length +
      data.yourTurn.failed.length +
      data.yourTurn.conflicts.length;
    if (waiting > 0) {
      lines.push({ key: "waiting", text: tBar("digest.waiting", { count: waiting }) });
    }
  }

  return (
    <>
      <PanelKicker>{tBar("digest.kicker")}</PanelKicker>
      {lines.length === 0 ? (
        <span className="font-sans text-[12px] leading-[1.5] text-muted-foreground">
          {data ? tBar("digest.empty") : tBar("loading")}
        </span>
      ) : (
        lines.map((line) => (
          <span
            key={line.key}
            data-testid={`top-bar-digest-${line.key}`}
            className={cn(
              "font-sans text-[12px] leading-[1.5]",
              line.danger ? "text-strata-you-deep" : "text-muted-foreground",
            )}
          >
            {line.text}
          </span>
        ))
      )}
      <Link
        href="/"
        onClick={onNavigate}
        className={cn(
          "mt-auto font-sans text-[12px] font-semibold no-underline outline-none",
          "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
          linkClass,
        )}
      >
        {tBar("digest.open")}
      </Link>
    </>
  );
}

/**
 * EN CE MOMENT — who is actually running, grouped by agent.
 *
 * The frame prints agent names ("Opus Builder × 2"); a session without a named
 * agent falls back to its dispatch role, which is what the desk's own cards do.
 */
function RightNowPanel({ data }: { data: ReturnType<typeof useControlDesk>["data"] }) {
  const tBar = useTranslations("TopBar");
  const groups = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const session of data.working) {
      const label = session.agentName ?? session.taskType;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3);
  }, [data]);

  const nightRuns = data ? data.working.filter((session) => session.nightRun).length : 0;

  return (
    <>
      <PanelKicker>{tBar("live.kicker")}</PanelKicker>
      {groups.length === 0 ? (
        <span className="font-sans text-[12px] leading-[1.5] text-muted-foreground">
          {data ? tBar("live.empty") : tBar("loading")}
        </span>
      ) : (
        groups.map(([label, count]) => (
          <span
            key={label}
            data-testid="top-bar-live-agent"
            className="flex items-center gap-[7px] font-sans text-[12px] text-foreground"
          >
            <BreathingDot size={6} />
            {count > 1 ? tBar("live.agent", { label, count: String(count) }) : label}
          </span>
        ))
      )}
      {nightRuns > 0 ? (
        <span className="flex items-center gap-[7px] font-sans text-[12px] text-muted-foreground">
          <Moon size={12} aria-hidden="true" />
          {tBar("live.nightRuns", { count: nightRuns })}
        </span>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Statuses                                                            */
/* ------------------------------------------------------------------ */

/**
 * Entry id → the mono run on its right, derived from the desk payload only.
 *
 * Deliberately partial. `heldBackCount` is the count of `to_merge` tickets a
 * blocker keeps out of READY TO LAND — the desk's own definition of "what is
 * blocking" — and it is the only honest source for the frame's coral
 * "1 blocking". Everything the payload does not answer stays absent.
 */
export function deriveStatuses(
  data: ReturnType<typeof useControlDesk>["data"],
  copy: EntryStatusCopy,
): Map<string, EntryStatus> {
  const statuses = new Map<string, EntryStatus>();
  if (!data) return statuses;

  if (data.heldBackCount > 0) {
    statuses.set("qa", { text: copy.blocking, tone: "danger" });
  }
  if (data.working.length > 0) {
    statuses.set("sessions", {
      text: copy.live,
      tone: "live-deep",
      live: true,
    });
  }
  if (data.today.costUsd !== null && data.today.costUsd > 0) {
    statuses.set("usage", {
      text: copy.usage,
      tone: "muted",
    });
  }

  return statuses;
}
