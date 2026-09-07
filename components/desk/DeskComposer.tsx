"use client";

import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { SelectPill, StrataBand, projectTone } from "@/components/piscine";
import {
  AGENT_PILL_IN_COMPOSER,
  AgentSelectPill,
} from "@/components/shared/AgentSelectPill";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * The linden bar: type a feature, ⏎ writes the ticket, ⇧⏎ writes it AND sends
 * it to a builder.
 *
 * THERE IS NO `draft` EPIC STATUS. `KANBAN_COLUMNS` is
 * backlog|todo|in_progress|review|to_merge|done|released and `createEpicSchema`
 * accepts that set minus `released`, so the composer POSTs
 * `{title, status:"backlog", type:"feature"}` — byte for byte what the board's
 * QuickCapture posted — and ⇧⏎ then chains the build dispatch with the new
 * epic id. Inventing a draft status would mean a migration and a new column in
 * every consumer of the board.
 *
 * On failure the typed title is KEPT, so a rejected POST costs a retry and not
 * a re-type.
 */
export interface DeskComposerProps {
  projects: readonly DeskProject[];
  /** The project a new ticket lands in. Defaults to the first project. */
  targetProjectId: string | null;
  onTargetProjectChange: (projectId: string) => void;
  namedAgentId: string | null;
  onNamedAgentChange: (namedAgentId: string | null) => void;
  /** `dispatch` is true for ⇧⏎: create, then send straight to a builder. */
  onSubmit: (input: {
    title: string;
    projectId: string;
    namedAgentId: string | null;
    dispatch: boolean;
  }) => Promise<boolean> | boolean;
  disabled?: boolean;
  className?: string;
}

export function DeskComposer({
  projects,
  targetProjectId,
  onTargetProjectChange,
  namedAgentId,
  onNamedAgentChange,
  onSubmit,
  disabled = false,
  className,
}: DeskComposerProps) {
  const t = useTranslations("Desk");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const composingRef = useRef(false);

  const project =
    projects.find((candidate) => candidate.id === targetProjectId) ?? projects[0];

  async function submit(dispatch: boolean) {
    const trimmed = title.trim();
    if (!trimmed || busy || !project) return;
    setBusy(true);
    try {
      const ok = await onSubmit({
        title: trimmed,
        projectId: project.id,
        namedAgentId,
        dispatch,
      });
      // Keep the typed title on failure so a retry costs nothing.
      if (ok) setTitle("");
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
      `@container`: the band's row is decided by the COMPOSER's width, not by
      the window's (B-arij-OZUKyqpxmKaT, and B-arij-180 before it on /chat).
      The two are not the same number: `/projects/:id` mounts this desk beside
      a resizable chat panel (`min-w-[400px]` for the desk column), so the band
      there is a few hundred pixels wide at a 1440px window. A viewport
      breakpoint reads the window and gets that backwards.

      THE OUTER MARGINS MOVED HERE from the band, so the container's box IS the
      band's box — the `30cqw` cap below is a share of the band, which is the
      width the arithmetic in `AGENT_PILL_IN_COMPOSER` is written about.
      `className` still lands on the band: no caller passes one, and the two
      things a caller would style are the band's ground and its padding.
    */
    <div
      data-testid="desk-composer"
      className="@container mx-[14px] mt-[10px] mb-3 shrink-0"
    >
      {/* The linden ground is StrataBand's, not this file's: the hand-rolled
          version repeated the recipe (radius, `bg-strata-feed`, the
          `.stratum-feed` scope class the breathing/progress figures read) and
          would have drifted from it the first time the band changed. `flex-row`
          and the padding overrides are what a composer legitimately overrides.

          ONE ROW FROM 36rem OF BAND, TWO BELOW IT. Measured in Chrome with a
          107-character named agent, before this fix: the band was `h-[58px]`
          with no `flex-wrap`, the pill took its 739.6px max-content width, and
          the field — the one item on a `flex-1` basis of 0 — was left at 0px at
          390, 640 and 768 and at 88.8px at 1024. Wrapping gives the field its
          own row and drops the two pills underneath; `min-h` rather than `h` is
          what lets that second row exist at all.

          NO `data-testid` here: unlike `SurfaceCard`, `StrataBand` does not
          forward extra `<div>` props, so one would be silently dropped. The band
          stamps `data-slot="strata-band" data-stratum="feed"` itself, which is
          what the tests select on. */}
      <StrataBand
        stratum="feed"
        gap={13}
        className={cn(
          "min-h-[58px] flex-row flex-wrap items-center px-[18px] py-[9px]",
          "@min-[36rem]:flex-nowrap @min-[36rem]:py-0",
          className,
        )}
      >
        <Sparkles size={16} aria-hidden="true" className="shrink-0 text-strata-feed-deep" />

        <input
          type="text"
          value={title}
          disabled={disabled || busy || !project}
          placeholder={t("composer.placeholder")}
          aria-label={t("composer.label")}
          data-testid="desk-composer-input"
          onChange={(event) => setTitle(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Never swallow Enter while an IME candidate window is open.
            if (composingRef.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit(event.shiftKey);
          }}
          className={cn(
            // 29px is the sparkle (16) plus the band's gap (13): wrapped, the
            // field takes the whole first row minus what sits before it, and the
            // pills are pushed onto the second. `basis-0` from 36rem puts it
            // back to sharing one row with them.
            "min-w-0 grow shrink basis-[calc(100%-29px)] @min-[36rem]:basis-0",
            "border-0 bg-transparent p-0",
            // What the user types is INK. The linden deep belongs to the band's
            // own chrome — the sparkle and the placeholder — and colouring the
            // typed title with it made the user's words read as decoration of
            // the stratum rather than as content.
            "font-sans text-[13.5px] font-medium text-foreground",
            "placeholder:text-strata-feed-deep placeholder:opacity-80",
            "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:opacity-60",
          )}
        />

        {/* `data-testid`, unlike on `StrataBand` above, actually reaches the
            DOM: `SelectPill` extends the button's props and spreads `...rest`.
            It is what lets a test change the target — the trigger's own label
            is the CURRENT project's `shortName`, which a test cannot know, and
            the cross-project desk has no project of its own to fall back on. */}
        <SelectPill
          data-testid="desk-project-select"
          label={project?.shortName ?? "—"}
          tone="project"
          projectTone={projectTone(project?.colorIndex ?? 0)}
          disabled={projects.length === 0}
        >
          {projects.map((candidate) => (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => onTargetProjectChange(candidate.id)}
            >
              {candidate.name}
            </DropdownMenuItem>
          ))}
        </SelectPill>

        {/* `dispatch`: named agents only. A build runs neither on the direct
            API nor on a persistent CLI — both are chat-only — so the desk keeps
            exactly the options it had, and gains the shared component's
            selection contract.

            The cap is `AGENT_PILL_IN_COMPOSER`, shared with `ChatComposer`
            rather than copied: both surfaces put this pill on a row with a
            field and they have to yield the same way. See that constant for
            the measurement and for the 45% / 30cqw split. */}
        <AgentSelectPill
          mode="dispatch"
          // Its own id: `/projects/:id` mounts this composer AND the chat
          // panel's picker, and one shared id there resolves to two elements.
          testId="desk-agent-select"
          selection={{ namedAgentId, provider: null }}
          onSelect={(selection) => onNamedAgentChange(selection.namedAgentId)}
          className={AGENT_PILL_IN_COMPOSER}
        />
      </StrataBand>
    </div>
  );
}
