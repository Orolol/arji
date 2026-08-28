/**
 * The Piscine primitive set — one import surface for every screen.
 *
 *     import { StrataBand, BandHeader, PillButton } from "@/components/piscine";
 *
 * SHARED VOCABULARY (learn these four words once, they mean the same thing on
 * every primitive):
 *
 *   `stratum`  — WHICH GROUND AM I ON. Always the `SurfaceStratum` union:
 *                "live" | "you" | "land" | "next" | "feed" | "card" | "paper".
 *                `BandHeader` additionally accepts "neutral" (= card/paper).
 *   `fill`     — WHAT DO I PAINT MYSELF. A small per-component enum naming a
 *                surface ("field" | "card", "card" | "transparent").
 *   `tone`     — WHICH IDENTITY OR STATE FAMILY. Project 1..4, or a named
 *                colour family ("live" | "asks" | "failed" | …).
 *   `size`     — THE COMPONENT'S OWN SIZE. A `<part>Size` prop (`labelSize`,
 *                `markerSize`) sizes a named sub-element instead.
 *
 * Anything ending in `Color` (`fillColor`, `trackColor`) or a segment's
 * `color` takes a raw `var(--token)` STRING, never a hex and never an enum.
 *
 * Raw colour strings, when a class name cannot reach (SVG fills, canvas):
 * `lib/piscine/tokens.ts` — STRATUM, PROJECT, PROMPT_SEGMENT, projectTone().
 */

export { StrataBand } from "./StrataBand";
export type {
  StrataBandProps,
  BandStratum,
  BandDensity,
} from "./StrataBand";

export { BandHeader } from "./BandHeader";
export type { BandHeaderProps, BandHeaderStratum } from "./BandHeader";

export { PillButton, pillButtonVariants } from "./PillButton";
export type { PillButtonProps, PillButtonSize } from "./PillButton";

export { IdentityChip, identityChipVariants } from "./IdentityChip";
export type { IdentityChipProps } from "./IdentityChip";

export { Stamp, stampVariants } from "./Stamp";
export type { StampProps, StampTone } from "./Stamp";

export { BreathingDot } from "./BreathingDot";
export type { BreathingDotProps } from "./BreathingDot";

export { ProgressTrack } from "./ProgressTrack";
export type { ProgressTrackProps } from "./ProgressTrack";

export { Chrono } from "./Chrono";
export type { ChronoProps } from "./Chrono";

export { Mono, MONO_TONE, MONO_TONE_CLASS } from "./Mono";
export type { MonoProps, MonoTone } from "./Mono";

export { FieldKicker } from "./FieldKicker";
export type { FieldKickerProps, KickerSize } from "./FieldKicker";

export { SegmentedControl } from "./SegmentedControl";
export type {
  SegmentedControlProps,
  SegmentedControlOption,
} from "./SegmentedControl";

export { SelectPill } from "./SelectPill";
export type { SelectPillProps } from "./SelectPill";

export { GhostInputPill } from "./GhostInputPill";
export type { GhostInputPillProps } from "./GhostInputPill";

export { CheckMark } from "./CheckMark";
export type { CheckMarkProps } from "./CheckMark";

export { PipelineChain } from "./PipelineChain";
export type {
  PipelineChainProps,
  PipelineStep,
  PipelineStepState,
} from "./PipelineChain";

export { TimelineLine } from "./TimelineLine";
export type { TimelineLineProps, TimelineKind } from "./TimelineLine";

export { DiffDelta } from "./DiffDelta";
export type { DiffDeltaProps } from "./DiffDelta";

export { AvatarSquare } from "./AvatarSquare";
export type { AvatarSquareProps, AvatarTone, AvatarSize } from "./AvatarSquare";

export { DeskHeader } from "./DeskHeader";
export type { DeskHeaderProps } from "./DeskHeader";

export { UnderlineTabNav } from "./UnderlineTabNav";
export type {
  UnderlineTabNavProps,
  UnderlineTabNavItem,
} from "./UnderlineTabNav";

export { StatNumeral } from "./StatNumeral";
export type { StatNumeralProps } from "./StatNumeral";

export { RatioBar } from "./RatioBar";
export type { RatioBarProps, RatioSegment } from "./RatioBar";

export { CappedBarChart } from "./CappedBarChart";
export type { CappedBarChartProps, CappedBar } from "./CappedBarChart";

export { SurfaceCard } from "./SurfaceCard";
export type { SurfaceCardProps, SurfaceRadius } from "./SurfaceCard";

export { KbdHint } from "./KbdHint";
export type { KbdHintProps } from "./KbdHint";

export { QuietLink } from "./QuietLink";
export type { QuietLinkProps, QuietLinkTone } from "./QuietLink";

export { QuietDangerAction } from "./QuietDangerAction";
export type { QuietDangerActionProps } from "./QuietDangerAction";

/**
 * The token maps, re-exported so a screen needs ONE import for the whole
 * system. `SurfaceStratum` is the shared `stratum` vocabulary above.
 */
export {
  STRATA,
  STRATUM,
  STRATUM_MOTION_CLASS,
  PROJECT,
  PROJECT_TONES,
  PROMPT_SEGMENT,
  projectTone,
} from "@/lib/piscine/tokens";
export type {
  Stratum,
  SurfaceStratum,
  ProjectTone,
} from "@/lib/piscine/tokens";
