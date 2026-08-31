import { Stamp } from "@/components/piscine";
import type { QaSeverityTier } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

/**
 * The severity pill on a finding row: BLOCKING / MAJOR / MINOR / INFO /
 * UNCLASSIFIED / HUMAN.
 *
 * State is the WORD plus a colour FAMILY (coral = blocking), never a per-status
 * colour — the same rule `Stamp` itself enforces.
 *
 * `blocking` → `Stamp tone="failed"` (`--strata-you-stamp2` on
 * `--strata-you-stamp-text`), which is the frame's BLOCKING pill exactly.
 * `major` → `Stamp tone="asks"` (`--strata-you-stamp`). The primitive paints
 * its label `--strata-you-deep` where the frame draws `--strata-you-stamp-text`;
 * that is the same family, it passes AA, and the primitive set is frozen — so
 * the primitive's value ships rather than a className override.
 */
export interface FindingSeverityStampProps {
  tier: QaSeverityTier;
  label: string;
  className?: string;
}

export function FindingSeverityStamp({
  tier,
  label,
  className,
}: FindingSeverityStampProps) {
  if (tier === "blocking") {
    return (
      <Stamp tone="failed" className={className}>
        {label}
      </Stamp>
    );
  }

  if (tier === "major") {
    return (
      <Stamp tone="asks" className={className}>
        {label}
      </Stamp>
    );
  }

  /*
   * `Stamp` has no card-fill tone and the primitive set is frozen; this is the
   * frame's MINOR pill (`background:#fffef8; color:#8a5442`), built to
   * `stampVariants`' own geometry so it cannot drift from its siblings.
   */
  return (
    <span
      data-slot="stamp"
      data-tone="minor"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full",
        "font-mono text-[10px] font-bold tabular-nums leading-none",
        "bg-card px-2 py-[3px] text-strata-you-mid",
        className,
      )}
    >
      {label}
    </span>
  );
}
