import { StatNumeral, StrataBand } from "@/components/piscine";

/**
 * One of the four white KPI tiles in frame 8d's row 1.
 *
 * Borderless by design: the README's global "borders 1.5px everywhere" rule is
 * NOT applied to any card or band on 8d — only the segmented control has one.
 *
 * The caption is Space Mono 10px/400 with NO letter-spacing, per the frame.
 * `FieldKicker` (which `StatNumeral` renders) applies 700 + .08em tracking by
 * default, so both are zeroed through `className` rather than by forking the
 * primitive — `cn`/twMerge lets a caller override any emitted utility.
 */
export interface StatTileProps {
  /**
   * Already formatted, or `null` when the figure is unavailable — which
   * renders U+2014, never a stand-in "0". The one place a real 0 belongs is
   * the SESSIONS tile: a run counter's zero is a fact, so that caller passes
   * the string "0".
   */
  value: string | null;
  caption: string;
  /** `live` is the CLEAN tile's turquoise; every other tile stays ink. */
  tone?: "ink" | "live";
  testId: string;
}

export function StatTile({ value, caption, tone = "ink", testId }: StatTileProps) {
  return (
    <StrataBand
      stratum="card"
      gap={3}
      className="flex-[1_1_180px] shrink px-[18px] py-[15px]"
    >
      <StatNumeral
        value={<span data-testid={testId}>{value ?? "—"}</span>}
        caption={caption}
        tone={tone}
        size={26}
        captionStratum="card"
        className="[&_[data-slot=field-kicker]]:font-normal [&_[data-slot=field-kicker]]:tracking-normal"
      />
    </StrataBand>
  );
}
