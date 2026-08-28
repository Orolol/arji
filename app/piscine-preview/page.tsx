"use client";

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * DEV HARNESS — NOT A PRODUCT SCREEN.
 *
 * Every Piscine primitive, in every variant, on the shell paper, so the
 * geometry can be eyeballed once before it is used hundreds of times across the
 * seven redesigned screens. Purely presentational: no fetch, no DB, no props
 * from outside, so it always renders.
 *
 * ROUTING: `app/_piscine-preview/` is a Next.js PRIVATE folder — the App Router
 * skips any path part starting with `_` (see `ignorePartFilter` in
 * next/dist/build/entries.js), so this file produces NO route on its own.
 * `app/piscine-preview/page.tsx` re-exports it; open the /piscine-preview route.
 *
 * Delete both files (and nothing else) when the redesign lands.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as React from "react";
import { Bell, GitBranch, Grid3x3, Send, Settings, Square, Trash2, X } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  AvatarSquare,
  BandHeader,
  BreathingDot,
  CappedBarChart,
  CheckMark,
  Chrono,
  DeskHeader,
  DiffDelta,
  FieldKicker,
  GhostInputPill,
  IdentityChip,
  KbdHint,
  Mono,
  PillButton,
  PipelineChain,
  ProgressTrack,
  QuietDangerAction,
  QuietLink,
  RatioBar,
  SegmentedControl,
  SelectPill,
  Stamp,
  StatNumeral,
  StrataBand,
  SurfaceCard,
  TimelineLine,
  UnderlineTabNav,
  type BandStratum,
  type MonoTone,
  type ProjectTone,
  type StampTone,
} from "@/components/piscine";

/* ── harness chrome ───────────────────────────────────────────────────────── */

/** One primitive's section: its name, its import line, its specimens. */
function Section({
  name,
  note,
  children,
}: {
  name: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t-[1.5px] border-border pt-5">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-[15px] font-bold text-foreground">
          {name}
        </h2>
        <Mono size={10.5} tone="muted">
          {note}
        </Mono>
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** A labelled specimen. The label is the exact props being demonstrated. */
function Spec({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "flex w-full flex-col gap-1.5" : "flex flex-col gap-1.5"}>
      <FieldKicker size={9.5} stratum="paper">
        {label}
      </FieldKicker>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Specimens laid out in a row of columns. */
function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{children}</div>;
}

const STRATA_ALL: BandStratum[] = [
  "live",
  "you",
  "land",
  "next",
  "feed",
  "card",
  "paper",
];
const PROJECT_ALL: ProjectTone[] = [1, 2, 3, 4];
const MONO_TONES: MonoTone[] = [
  "ink",
  "muted",
  "live-deep",
  "live-mid",
  "you-deep",
  "you-mid",
  "land-mid",
  "land-deep",
  "next-deep",
  "next-mid",
  "feed-deep",
  "danger",
];
const STAMP_TONES: StampTone[] = [
  "live",
  "asks",
  "failed",
  "conflict",
  "land",
  "next",
];

const BARS = [
  { value: 4 }, { value: 7 }, { value: 2 }, { value: 9, failed: true },
  { value: 6 }, { value: 0 }, { value: 11 }, { value: 5 },
  { value: 8, failed: true }, { value: 3 }, { value: 7 }, { value: 12 },
  { value: 6 }, { value: 2 },
];

/* ── the harness ──────────────────────────────────────────────────────────── */

export default function PiscinePreviewPage() {
  // Set after mount: a timestamp computed during render would differ between
  // the server pass and hydration.
  const [startedAt, setStartedAt] = React.useState<string | null>(null);
  React.useEffect(() => {
    setStartedAt(new Date(Date.now() - 252_000).toISOString());
  }, []);

  const [segMd, setSegMd] = React.useState("balanced");
  const [segSm, setSegSm] = React.useState("30d");
  const [segFilled, setSegFilled] = React.useState("write");
  const [reply, setReply] = React.useState("");
  const [replyCard, setReplyCard] = React.useState("Looks right to me");
  const [storyDone, setStoryDone] = React.useState(true);
  const [inRelease, setInRelease] = React.useState(false);

  return (
    <div className="min-h-screen bg-background">
      <DeskHeader title="Piscine primitives">
        <span className="ml-auto">
          <Mono size={10.5} tone="muted" uppercase tracking={0.08}>
            dev harness · not a product screen
          </Mono>
        </span>
      </DeskHeader>

      <div className="mx-auto flex max-w-[1180px] flex-col gap-7 px-6 pb-24">
        {/* ── StrataBand ─────────────────────────────────────────────────── */}
        <Section
          name="StrataBand"
          note="stratum × density · radius 14 · no border, no shadow · an empty band collapses to its label line"
        >
          <Spec label="stratum — every ground, density=full" wide>
            <div className="grid w-full grid-cols-2 gap-2 lg:grid-cols-4">
              {STRATA_ALL.map((s) => (
                <StrataBand key={s} stratum={s} density="full" gap={8}>
                  <BandHeader
                    label={s}
                    stratum={s}
                    meta={`stratum="${s}"`}
                  />
                  <Mono size={11} tone="muted">
                    body copy on the {s} ground
                  </Mono>
                </StrataBand>
              ))}
            </div>
          </Spec>

          <Spec label="density — full 14/18 · half 13/18 · rail 13/16" wide>
            <div className="grid w-full grid-cols-3 gap-2">
              {(["full", "half", "rail"] as const).map((d) => (
                <StrataBand key={d} stratum="next" density={d} gap={8}>
                  <BandHeader label={d} stratum="next" standalone />
                  <Mono size={11} tone="next-mid">
                    density=&quot;{d}&quot;
                  </Mono>
                </StrataBand>
              ))}
            </div>
          </Spec>

          <Spec label="empty band — header only, no min-height, no filler" wide>
            <div className="w-full">
              <StrataBand stratum="land" density="half">
                <BandHeader label="Ready to land" stratum="land" meta="0" standalone />
              </StrataBand>
            </div>
          </Spec>

          <Spec label="grow — exactly one band per screen absorbs the slack" wide>
            <div className="flex h-[220px] w-full max-w-[420px] flex-col gap-2">
              <StrataBand stratum="you" density="rail">
                <BandHeader label="Your turn" stratum="you" meta="2" standalone />
              </StrataBand>
              <StrataBand stratum="live" density="rail" grow>
                <BandHeader label="Working" stratum="live" meta="grow" standalone />
                <Mono size={11} tone="live-mid">
                  grow → flex:1; min-height:0
                </Mono>
              </StrataBand>
              <StrataBand stratum="next" density="rail">
                <BandHeader label="Up next" stratum="next" meta="7" standalone />
              </StrataBand>
            </div>
          </Spec>
        </Section>

        {/* ── BandHeader ─────────────────────────────────────────────────── */}
        <Section
          name="BandHeader"
          note="Bricolage uppercase on a 3px stratum underline · labelSize 12 default, 13 only on the 5a desk"
        >
          <StrataBand stratum="paper" density="full" gap={14}>
            <Spec label="stratum — five strata + neutral (card/paper are aliases)" wide>
              <div className="flex w-full flex-wrap gap-x-9 gap-y-3">
                {(["live", "you", "land", "next", "feed", "neutral"] as const).map(
                  (s) => (
                    <BandHeader key={s} label={s} stratum={s} standalone />
                  ),
                )}
              </div>
            </Spec>
            <Spec label="labelSize 12 (default) vs 13 (5a desk exception)" wide>
              <div className="flex w-full flex-wrap gap-x-9 gap-y-3">
                <BandHeader label="Working" stratum="live" labelSize={12} standalone />
                <BandHeader label="Working" stratum="live" labelSize={13} standalone />
              </div>
            </Spec>
            <Spec label="meta + right slot + align" wide>
              <div className="flex w-full flex-col gap-3">
                <BandHeader label="Live log" stratum="live" meta="04:12 · build" />
                <BandHeader
                  label="Agent activity"
                  stratum="live"
                  meta="3 running"
                  right={<QuietLink tone="live">open full session →</QuietLink>}
                />
                <BandHeader
                  label="Spec"
                  stratum="feed"
                  align="center"
                  right={
                    <SegmentedControl
                      size="sm"
                      chrome="filled"
                      value={segFilled}
                      onChange={setSegFilled}
                      options={[
                        { value: "write", label: "Écrire" },
                        { value: "preview", label: "Prévisualiser" },
                      ]}
                    />
                  }
                />
              </div>
            </Spec>
          </StrataBand>
        </Section>

        {/* ── PillButton ─────────────────────────────────────────────────── */}
        <Section
          name="PillButton"
          note="the ONLY button · filled is always --action, never black, max one per row · borders 1.5px · no shadow ever"
        >
          <Row>
            <Spec label="variant=filled · size sm | md | lg">
              <PillButton size="sm">Stop</PillButton>
              <PillButton size="md">Send to dev</PillButton>
              <PillButton size="lg">Create release</PillButton>
            </Spec>
            <Spec label="variant=outline · outlineTone=action">
              <PillButton variant="outline" size="sm">Diff</PillButton>
              <PillButton variant="outline" size="md">Log</PillButton>
              <PillButton variant="outline" size="lg">Discard</PillButton>
            </Spec>
            <Spec label="variant=outline · outlineTone=neutral">
              <PillButton variant="outline" outlineTone="neutral" size="sm">Now back</PillButton>
              <PillButton variant="outline" outlineTone="neutral" size="md">⌘K</PillButton>
            </Spec>
          </Row>
          <Row>
            <Spec label="icon">
              <PillButton icon={Send} size="md">Send</PillButton>
              <PillButton variant="outline" icon={GitBranch} size="sm">Branch</PillButton>
            </Spec>
            <Spec label="iconOnly — 30×30, icon 14">
              <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Bell}>
                Inbox
              </PillButton>
              <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Grid3x3}>
                Projects
              </PillButton>
              <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Settings}>
                Settings
              </PillButton>
              <PillButton iconOnly icon={X}>Close</PillButton>
            </Spec>
            <Spec label="badge">
              <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Bell} badge={3}>
                Inbox
              </PillButton>
              <PillButton variant="outline" badge={12}>Findings</PillButton>
            </Spec>
          </Row>
          <Row>
            <Spec label="labelTone=danger — label coral, border stays neutral">
              <PillButton variant="outline" outlineTone="neutral" labelTone="danger">
                Frictions · 20 open
              </PillButton>
            </Spec>
            <Spec label="pending — disabled, label swapped, NO spinner">
              <PillButton pending pendingLabel="Sending…">Send to dev</PillButton>
              <PillButton variant="outline" pending pendingLabel="Merging…">Merge</PillButton>
            </Spec>
            <Spec label="disabled">
              <PillButton disabled>Send to dev</PillButton>
              <PillButton variant="outline" disabled>Diff</PillButton>
            </Spec>
          </Row>
        </Section>

        {/* ── IdentityChip ───────────────────────────────────────────────── */}
        <Section
          name="IdentityChip"
          note="colour is ALWAYS project identity, never state · tone from projectTone(colorIndex)"
        >
          <Row>
            <Spec label="size=sm (default) — ticket ids, project short names">
              {PROJECT_ALL.map((t) => (
                <IdentityChip key={t} label={`ARJ-${100 + t}`} tone={t} />
              ))}
            </Spec>
            <Spec label="size=md — header filter chips">
              {PROJECT_ALL.map((t) => (
                <IdentityChip key={t} label={`project-${t}`} tone={t} size="md" />
              ))}
            </Spec>
          </Row>
          <Row>
            <Spec label="live — 6px dot in the project deep colour (md only)">
              {PROJECT_ALL.map((t) => (
                <IdentityChip key={t} label={`project-${t}`} tone={t} size="md" live />
              ))}
            </Spec>
            <Spec label="onGround — card fill, deep text kept">
              {PROJECT_ALL.map((t) => (
                <IdentityChip key={t} label={`ARJ-${200 + t}`} tone={t} onGround />
              ))}
            </Spec>
            <Spec label="onClick — renders a real button">
              <IdentityChip label="arij" tone={1} size="md" onClick={() => {}} />
            </Spec>
          </Row>
        </Section>

        {/* ── Stamp ──────────────────────────────────────────────────────── */}
        <Section
          name="Stamp"
          note="state = word + colour FAMILY, never an arbitrary status colour · FAILED keeps its own heavier coral pair"
        >
          <Spec label="tone — every stamp">
            {STAMP_TONES.map((t) => (
              <Stamp key={t} tone={t}>
                {t.toUpperCase()}
              </Stamp>
            ))}
          </Spec>
          <Spec label="dot — the live stamp only">
            <Stamp tone="live" dot>
              LIVE · BUILD
            </Stamp>
            <Stamp tone="asks">ASKS YOU</Stamp>
            <Stamp tone="failed">FAILED</Stamp>
            <Stamp tone="conflict">CONFLICT</Stamp>
          </Spec>
        </Section>

        {/* ── BreathingDot ───────────────────────────────────────────────── */}
        <Section
          name="BreathingDot"
          note="liveness · animate={false} is the static readiness dot · idle is NEVER animated · never #4ed49b"
        >
          <Row>
            <Spec label="tone=live · sizes 6 / 7 / 8 / 20">
              {[6, 7, 8, 20].map((s) => (
                <BreathingDot key={s} size={s} />
              ))}
            </Spec>
            <Spec label="tone=project (1..4)">
              {PROJECT_ALL.map((t) => (
                <BreathingDot key={t} size={8} tone="project" projectTone={t} />
              ))}
            </Spec>
            <Spec label="tone=idle · animate=false">
              <BreathingDot size={8} tone="idle" />
              <BreathingDot size={8} animate={false} />
              <BreathingDot size={20} tone="idle" />
            </Spec>
          </Row>
        </Section>

        {/* ── ProgressTrack ──────────────────────────────────────────────── */}
        <Section
          name="ProgressTrack"
          note="percent omitted = indeterminate crawl · fillColor/trackColor take raw var(--token) strings"
        >
          <div className="flex w-full max-w-[520px] flex-col gap-4">
            <Spec label="indeterminate — height 4 (every live surface)" wide>
              <div className="w-full"><ProgressTrack /></div>
            </Spec>
            <Spec label="determinate — percent 0 / 35 / 72 / 100" wide>
              <div className="flex w-full flex-col gap-2">
                {[0, 35, 72, 100].map((p) => (
                  <ProgressTrack key={p} percent={p} />
                ))}
              </div>
            </Spec>
            <Spec label="height 8 + fillColor/trackColor — the 8d monthly cap" wide>
              <div className="w-full">
                <ProgressTrack
                  height={8}
                  percent={64}
                  fillColor="var(--strata-feed-deep)"
                  trackColor="var(--strata-feed-under)"
                />
              </div>
            </Spec>
          </div>
        </Section>

        {/* ── Chrono ─────────────────────────────────────────────────────── */}
        <Section
          name="Chrono"
          note="owns a 1s interval · tabular-nums ALWAYS · formats via lib/utils/format-elapsed.ts"
        >
          <Spec label="size 19 / 20 / 21 · tone live | ink">
            {startedAt ? (
              <>
                <Chrono startedAt={startedAt} size={19} />
                <Chrono startedAt={startedAt} size={20} />
                <Chrono startedAt={startedAt} size={21} />
                <Chrono startedAt={startedAt} size={21} tone="ink" />
              </>
            ) : (
              <Mono size={11} tone="muted">
                (starts on mount)
              </Mono>
            )}
          </Spec>
        </Section>

        {/* ── Mono ───────────────────────────────────────────────────────── */}
        <Section
          name="Mono"
          note="every mono run · Space Mono + tabular-nums, impossible to forget · callers pass real codepoints (− U+2212, ✓, ·, →)"
        >
          <Spec label="tone — all twelve" wide>
            <div className="flex w-full flex-wrap gap-x-5 gap-y-1">
              {MONO_TONES.map((t) => (
                <Mono key={t} size={11} tone={t}>
                  {t}
                </Mono>
              ))}
            </div>
          </Spec>
          <Spec label="size — 9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 21 / 22 / 26">
            {[9.5, 10, 10.5, 11, 11.5, 12, 21, 22, 26].map((s) => (
              <Mono key={s} size={s}>
                {s}
              </Mono>
            ))}
          </Spec>
          <Spec label="weight 400 | 700 · uppercase + tracking · clamp={1}">
            <Mono size={12}>weight 400</Mono>
            <Mono size={12} weight={700}>weight 700</Mono>
            <Mono size={10} weight={700} uppercase tracking={0.08} tone="muted">
              kicker label
            </Mono>
            <span className="block w-[180px]">
              <Mono size={11} clamp={1} as="div">
                clamp={1} truncates this very long single line to exactly one line
              </Mono>
            </span>
          </Spec>
          <Spec label="character fidelity — − U+2212, ✓ U+2713, · U+00B7, → U+2192, › U+203A, — U+2014, … U+2026">
            <Mono size={12}>−42 ✓ · → › — …</Mono>
          </Spec>
        </Section>

        {/* ── FieldKicker ────────────────────────────────────────────────── */}
        <Section
          name="FieldKicker"
          note="uppercase mono micro-label · colour from the stratum it is printed on · 9.5px is the system floor"
        >
          <Spec label="size 9.5 / 10 / 10.5 (on card)">
            <FieldKicker size={9.5}>permission mode</FieldKicker>
            <FieldKicker size={10}>retry escalation</FieldKicker>
            <FieldKicker size={10.5}>clis on this machine</FieldKicker>
          </Spec>
          <Spec label="stratum — each ground gets its own mid tone" wide>
            <div className="grid w-full grid-cols-2 gap-2 lg:grid-cols-4">
              {STRATA_ALL.map((s) => (
                <StrataBand key={s} stratum={s} density="rail">
                  <FieldKicker stratum={s}>stratum={s}</FieldKicker>
                </StrataBand>
              ))}
            </div>
          </Spec>
        </Section>

        {/* ── SegmentedControl ───────────────────────────────────────────── */}
        <Section
          name="SegmentedControl"
          note="chrome=bordered on a white card, filled on a coloured ground · inactive colour overridable via --segment-inactive"
        >
          <Row>
            <Spec label="chrome=bordered · size=md (h34/r10) · flex weights 1 / 1.4 / 1.2">
              <div className="w-[300px]">
                <SegmentedControl
                  value={segMd}
                  onChange={setSegMd}
                  options={[
                    { value: "off", label: "Off", flex: 1 },
                    { value: "balanced", label: "Balanced", flex: 1.4 },
                    { value: "aggressive", label: "Aggressive", flex: 1.2 },
                  ]}
                />
              </div>
            </Spec>
            <Spec label="chrome=bordered · disabled + hint">
              <div className="w-[260px]">
                <SegmentedControl
                  value={segMd}
                  onChange={setSegMd}
                  options={[
                    { value: "off", label: "Low" },
                    { value: "balanced", label: "Medium" },
                    {
                      value: "max",
                      label: "Max",
                      disabled: true,
                      hint: "This CLI does not support max effort",
                    },
                  ]}
                />
              </div>
            </Spec>
          </Row>
          <Row>
            <Spec label="chrome=filled · size=sm (h30/pill) on a coloured ground">
              <StrataBand stratum="feed" density="rail">
                <SegmentedControl
                  size="sm"
                  chrome="filled"
                  className="[--segment-inactive:var(--strata-feed-deep)]"
                  value={segFilled}
                  onChange={setSegFilled}
                  options={[
                    { value: "write", label: "Écrire" },
                    { value: "preview", label: "Prévisualiser" },
                  ]}
                />
              </StrataBand>
            </Spec>
            <Spec label="chrome=filled + hairline on paper (8d)">
              <SegmentedControl
                size="sm"
                chrome="filled"
                className="border-[1.5px] border-border"
                value={segSm}
                onChange={setSegSm}
                options={[
                  { value: "7d", label: "7 j" },
                  { value: "30d", label: "30 j" },
                  { value: "all", label: "Tout" },
                ]}
              />
            </Spec>
          </Row>
        </Section>

        {/* ── SelectPill ─────────────────────────────────────────────────── */}
        <Section
          name="SelectPill"
          note="every dropdown trigger · lucide chevron-down, not the ▾ glyph · wraps components/ui/dropdown-menu"
        >
          <StrataBand stratum="feed" density="full" gap={12}>
            <Spec label="tone=ink | mono | project · fill=card">
              <SelectPill label="Claude Opus 5">
                <DropdownMenuItem>Claude Opus 5</DropdownMenuItem>
                <DropdownMenuItem>Claude Sonnet</DropdownMenuItem>
              </SelectPill>
              <SelectPill label="v2.4.1" tone="mono">
                <DropdownMenuItem>v2.4.1</DropdownMenuItem>
                <DropdownMenuItem>v2.4.0</DropdownMenuItem>
              </SelectPill>
              {PROJECT_ALL.map((t) => (
                <SelectPill key={t} label={`project-${t}`} tone="project" projectTone={t}>
                  <DropdownMenuItem>project-{t}</DropdownMenuItem>
                </SelectPill>
              ))}
            </Spec>
            <Spec label="fill=transparent (the 7a FieldBox variant) · disabled">
              <SelectPill label="claude" fill="transparent">
                <DropdownMenuItem>claude</DropdownMenuItem>
              </SelectPill>
              <SelectPill label="unavailable" disabled>
                <DropdownMenuItem>unavailable</DropdownMenuItem>
              </SelectPill>
            </Spec>
          </StrataBand>
        </Section>

        {/* ── GhostInputPill ─────────────────────────────────────────────── */}
        <Section
          name="GhostInputPill"
          note="border is --input (distinct from --border) · Enter fires onSubmit · IME-safe"
        >
          <Row>
            <Spec label="fill=field · width=300 (5a inline reply)">
              <GhostInputPill
                value={reply}
                onChange={setReply}
                placeholder="Reply to the agent…"
                width={300}
              />
            </Spec>
            <Spec label="disabled">
              <GhostInputPill
                value=""
                onChange={() => {}}
                placeholder="Disabled"
                width={200}
                disabled
              />
            </Spec>
          </Row>
          <Spec label="fill=card · width=flex, on the coral ground (6a conversation)" wide>
            <StrataBand stratum="you" density="rail" className="w-full">
              <div className="flex w-full items-center gap-2">
                <GhostInputPill
                  value={replyCard}
                  onChange={setReplyCard}
                  placeholder="Reply…"
                  fill="card"
                  width="flex"
                />
                <PillButton size="lg" icon={Send}>Send</PillButton>
              </div>
            </StrataBand>
          </Spec>
        </Section>

        {/* ── CheckMark ──────────────────────────────────────────────────── */}
        <Section
          name="CheckMark"
          note="18×18 · disc = 6a stories, square = 8c releases · glyph is --action-foreground so it survives night"
        >
          <Row>
            <Spec label="shape=disc · tone=live · checked / unchecked">
              <CheckMark checked />
              <CheckMark checked={false} />
            </Spec>
            <Spec label="shape=square · tone=action">
              <CheckMark checked shape="square" tone="action" />
              <CheckMark checked={false} shape="square" tone="action" />
            </Spec>
            <Spec label="onToggle — a real button (click these)">
              <CheckMark checked={storyDone} onToggle={() => setStoryDone((v) => !v)} />
              <CheckMark
                checked={inRelease}
                shape="square"
                tone="action"
                onToggle={() => setInRelease((v) => !v)}
              />
            </Spec>
            <Spec label="disabled">
              <CheckMark checked onToggle={() => {}} disabled />
            </Spec>
          </Row>
        </Section>

        {/* ── PipelineChain ──────────────────────────────────────────────── */}
        <Section
          name="PipelineChain"
          note="one vocabulary, two layouts · horizontal rings/connectors are 2px — a deliberate exception to the 1.5px rule"
        >
          <Row>
            <Spec label="orientation=horizontal · markerSize 20 (6a PIPELINE)">
              <div className="w-[420px]">
                <PipelineChain
                  steps={[
                    { label: "SPEC", state: "done" },
                    { label: "BUILD", state: "live" },
                    { label: "REVIEW", state: "pending" },
                    { label: "LAND", state: "pending" },
                  ]}
                />
              </div>
            </Spec>
            <Spec label="orientation=vertical · markerSize 8 (8a ENSUITE)">
              <PipelineChain
                orientation="vertical"
                steps={[
                  { label: "Build", state: "done" },
                  { label: "Review", state: "live" },
                  { label: "Land", state: "pending" },
                ]}
              />
            </Spec>
          </Row>
        </Section>

        {/* ── TimelineLine ───────────────────────────────────────────────── */}
        <Section
          name="TimelineLine"
          note="the four-glyph line grammar (✓ $ · ●) plus the documented error extension"
        >
          <SurfaceCard radius={10} className="w-full max-w-[620px] p-4">
            <div className="flex flex-col gap-1">
              <TimelineLine kind="done" size={11.5}>Read lib/db/schema.ts</TimelineLine>
              <TimelineLine kind="command" size={11.5}>npm test -- uploads</TimelineLine>
              <TimelineLine kind="summary" size={11.5}>
                412 passed, 0 failed <DiffDelta added={128} removed={31} size={11.5} />
              </TimelineLine>
              <TimelineLine kind="live" size={11.5}>Writing the migration…</TimelineLine>
              <TimelineLine kind="error" size={11.5}>ENOENT: no such file</TimelineLine>
            </div>
          </SurfaceCard>
          <Spec label="timestamp prefix · size 11 (6a overlay) vs 11.5 (8a log)" wide>
            <div className="flex w-full flex-col gap-1">
              <TimelineLine kind="done" size={11} timestamp="04:12">
                size 11, with a timestamp
              </TimelineLine>
              <TimelineLine kind="done" size={11.5} timestamp="04:12">
                size 11.5, with a timestamp
              </TimelineLine>
            </div>
          </Spec>
        </Section>

        {/* ── DiffDelta ──────────────────────────────────────────────────── */}
        <Section
          name="DiffDelta"
          note="display:contents — the parent's own gap spaces the counts · − is U+2212, never an ASCII hyphen"
        >
          <Spec label="added + removed · added only · removed only · explicit 0 · both null (renders nothing)">
            <span className="flex items-center gap-2.5">
              <DiffDelta added={128} removed={31} />
            </span>
            <span className="flex items-center gap-2.5"><DiffDelta added={12} /></span>
            <span className="flex items-center gap-2.5"><DiffDelta removed={4} /></span>
            <span className="flex items-center gap-2.5"><DiffDelta added={9} removed={0} /></span>
            <Mono size={11} tone="muted">
              [<DiffDelta added={null} removed={null} />]
            </Mono>
          </Spec>
          <Spec label="size 10.5 (band meta) / 11 (file rows) / 11.5 (logs)">
            <span className="flex items-center gap-2.5"><DiffDelta added={7} removed={2} size={10.5} /></span>
            <span className="flex items-center gap-2.5"><DiffDelta added={7} removed={2} size={11} /></span>
            <span className="flex items-center gap-2.5"><DiffDelta added={7} removed={2} size={11.5} /></span>
          </Spec>
        </Section>

        {/* ── AvatarSquare ───────────────────────────────────────────────── */}
        <Section
          name="AvatarSquare"
          note="the app logo mark and the 7a agent initials · --action, not ink (the frames beat the README)"
        >
          <Row>
            <Spec label="size=30 — 30/r10/15px">
              <AvatarSquare label="A" tone="action" />
              {PROJECT_ALL.map((t) => (
                <AvatarSquare key={t} label={`P${t}`} tone={t} />
              ))}
            </Spec>
            <Spec label="size=34 — 34/r11/14px">
              <AvatarSquare label="A" tone="action" size={34} />
              {PROJECT_ALL.map((t) => (
                <AvatarSquare key={t} label={`P${t}`} tone={t} size={34} />
              ))}
            </Spec>
          </Row>
        </Section>

        {/* ── DeskHeader ─────────────────────────────────────────────────── */}
        <Section
          name="DeskHeader"
          note="60px shell · 24px gutter (body is 14px — the asymmetry is intentional) · no border, no shadow"
        >
          <SurfaceCard radius={12} className="w-full overflow-hidden">
            <DeskHeader title="Now">
              <span className="ml-auto flex items-center gap-2">
                <IdentityChip label="arij" tone={1} size="md" live />
                <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Bell} badge={3}>
                  Inbox
                </PillButton>
                <PillButton variant="outline" outlineTone="neutral" iconOnly icon={Settings}>
                  Settings
                </PillButton>
              </span>
            </DeskHeader>
          </SurfaceCard>
        </Section>

        {/* ── UnderlineTabNav ────────────────────────────────────────────── */}
        <Section
          name="UnderlineTabNav"
          note="active underline is 3px — the SAME weight as a band label's · inactive keeps a transparent 3px so nothing shifts"
        >
          <Spec label="items — active decided from usePathname() (none match here, so all read inactive)" wide>
            <UnderlineTabNav
              items={[
                { href: "/piscine-preview", label: "Aperçu", exact: true },
                { href: "/piscine-preview/spec", label: "Spec" },
                { href: "/piscine-preview/agents", label: "Agents" },
                { href: "/piscine-preview/releases", label: "Releases" },
                { href: "/piscine-preview/usage", label: "Usage" },
              ]}
            />
          </Spec>
        </Section>

        {/* ── StatNumeral ────────────────────────────────────────────────── */}
        <Section
          name="StatNumeral"
          note="figure over caption · a data gap is an em-dash, NEVER 0 · only two loud accents exist"
        >
          <Row>
            <Spec label="tone=ink | live | danger · size=22">
              <StatNumeral value="128" caption="sessions" />
              <StatNumeral value="94%" caption="clean" tone="live" />
              <StatNumeral value="7" caption="escalations" tone="danger" />
            </Spec>
            <Spec label="size=26 (8d tiles)">
              <StatNumeral value="1 204" caption="prompts" size={26} />
              <StatNumeral value="18" caption="ready" size={26} tone="live" />
            </Spec>
            <Spec label="value=null → em-dash">
              <StatNumeral value={null} caption="unavailable" />
            </Spec>
          </Row>
          <Spec label="captionStratum — caption colour follows the ground" wide>
            <div className="grid w-full grid-cols-3 gap-2">
              {(["card", "land", "live"] as const).map((s) => (
                <StrataBand key={s} stratum={s} density="rail">
                  <StatNumeral value="42" caption={`captionStratum=${s}`} captionStratum={s} />
                </StrataBand>
              ))}
            </div>
          </Spec>
        </Section>

        {/* ── RatioBar ───────────────────────────────────────────────────── */}
        <Section
          name="RatioBar"
          note="segments carry raw var(--token) colour strings · the wrapper rounds like a pill at height ≥ 8"
        >
          <div className="flex w-full max-w-[520px] flex-col gap-4">
            <Spec label="height=16, track=card — the 8d BY AGENT / BY PROJECT rows" wide>
              <div className="flex w-full flex-col gap-2">
                {PROJECT_ALL.map((t) => (
                  <RatioBar
                    key={t}
                    height={16}
                    segments={[{ percent: 20 + t * 18, color: `var(--project-${t}-mid)` }]}
                  />
                ))}
              </div>
            </Spec>
            <Spec label="height=8 — the 8d monthly cap" wide>
              <div className="w-full">
                <RatioBar
                  height={8}
                  segments={[{ percent: 64, color: "var(--strata-feed-deep)" }]}
                />
              </div>
            </Spec>
            <Spec label="height=6, track=none, two segments sharing one outline — 8a file mini-bars" wide>
              <div className="w-full max-w-[220px]">
                <RatioBar
                  height={6}
                  track="none"
                  segments={[
                    { percent: 72, color: "var(--strata-live-bar)", radius: "left" },
                    { percent: 28, color: "var(--chart-fail)", radius: "right" },
                  ]}
                />
              </div>
            </Spec>
            <Spec label="width as a fixed number" wide>
              <RatioBar
                width={160}
                height={16}
                segments={[{ percent: 45, color: "var(--strata-live-bar)" }]}
              />
            </Spec>
          </div>
        </Section>

        {/* ── CappedBarChart ─────────────────────────────────────────────── */}
        <Section
          name="CappedBarChart"
          note="a failure day is the same green bar wearing a fixed red cap · a zero day still draws a 2px stub"
        >
          <Row>
            <Spec label="height=46, capPx=6, gap=4 — the 7a 14-day sparkline">
              <div className="w-[280px]">
                <CappedBarChart bars={BARS} height={46} capPx={6} gap={4} />
              </div>
            </Spec>
            <Spec label="height omitted → grows into its band · capPx=8, gap=5 (8d BY DAY)">
              <StrataBand stratum="card" density="rail" className="h-[140px] w-[420px]">
                <BandHeader label="By day" stratum="card" standalone />
                <CappedBarChart bars={[...BARS, ...BARS.slice(0, 6)]} capPx={8} gap={5} />
              </StrataBand>
            </Spec>
          </Row>
          <Spec label="bars=[] renders nothing (the caller collapses the band)">
            <Mono size={11} tone="muted">
              [<CappedBarChart bars={[]} />]
            </Mono>
          </Spec>
        </Section>

        {/* ── SurfaceCard ────────────────────────────────────────────────── */}
        <Section
          name="SurfaceCard"
          note="no border, no shadow at rest · selection is reserved with a transparent border so it never reflows"
        >
          <StrataBand stratum="live" density="full" gap={10}>
            <div className="flex flex-wrap items-start gap-2">
              {([10, 11, 12] as const).map((r) => (
                <SurfaceCard key={r} radius={r} className="w-[150px] p-3">
                  <Mono size={11}>radius={r}</Mono>
                </SurfaceCard>
              ))}
              <SurfaceCard translucent radius={12} className="w-[150px] p-3">
                <Mono size={11}>translucent</Mono>
              </SurfaceCard>
              <SurfaceCard interactive radius={12} className="w-[150px] p-3">
                <Mono size={11}>interactive (hover)</Mono>
              </SurfaceCard>
              <SurfaceCard selected radius={12} className="w-[150px] p-3">
                <Mono size={11}>selected</Mono>
              </SurfaceCard>
            </div>
          </StrataBand>
        </Section>

        {/* ── KbdHint ────────────────────────────────────────────────────── */}
        <Section
          name="KbdHint"
          note="a RECTANGLE (radius 6), not a pill — the one small control that reads as a key, not a chip"
        >
          <Spec label="children">
            <KbdHint>esc</KbdHint>
            <KbdHint>⌘K</KbdHint>
            <KbdHint>⏎</KbdHint>
          </Spec>
        </Section>

        {/* ── QuietLink ──────────────────────────────────────────────────── */}
        <Section
          name="QuietLink"
          note="chromeless · the → is a literal U+2192 in the children, not an icon"
        >
          <Row>
            <Spec label="tone=next | live | land | muted · size=12 (600)">
              <QuietLink href="#">open diff →</QuietLink>
              <QuietLink href="#" tone="live">open full session →</QuietLink>
              <QuietLink href="#" tone="land">open usage →</QuietLink>
              <QuietLink href="#" tone="muted">voir le prompt exact →</QuietLink>
            </Spec>
            <Spec label="size=11.5 (400) — the quieter on-ground variant">
              <QuietLink href="#" size={11.5}>
                3 autres bloqués par des findings ouverts →
              </QuietLink>
            </Spec>
            <Spec label="onClick without href — renders a button">
              <QuietLink onClick={() => {}} tone="live">régénérer</QuietLink>
            </Spec>
          </Row>
        </Section>

        {/* ── QuietDangerAction ──────────────────────────────────────────── */}
        <Section
          name="QuietDangerAction"
          note="coral label carries the weight, so a delete never competes with the row's one filled action · the caller owns the confirm dialog"
        >
          <Spec label="icon · size 12 | 11.5 · no icon">
            <QuietDangerAction icon={Trash2} onClick={() => {}}>
              Delete ticket
            </QuietDangerAction>
            <QuietDangerAction icon={Trash2} onClick={() => {}} size={11.5}>
              Delete agent
            </QuietDangerAction>
            <QuietDangerAction onClick={() => {}} size={11.5}>
              jeter
            </QuietDangerAction>
            <QuietDangerAction icon={Square} onClick={() => {}}>
              Stop and discard
            </QuietDangerAction>
          </Spec>
        </Section>
      </div>
    </div>
  );
}
