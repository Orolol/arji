import { cn } from "@/lib/utils";

/**
 * AvatarSquare — the rounded initial square: the app logo mark ("A" on
 * `--action`, present in every header) and the 7a agent roster initials. The
 * same shape, different colours.
 *
 * NOTE the README calls the logo an "ink logo square"; every frame paints it
 * `var(--action)` deep water-green. The frames win.
 *
 * Colour here is IDENTITY (the app, or which agent), never state.
 */

/** `action` = the app logo. 1..4 = the fixed project-identity colour cycle. */
export type AvatarTone = "action" | 1 | 2 | 3 | 4;

/** 30px in headers, 34px in the 7a roster. */
export type AvatarSize = 30 | 34;

export interface AvatarSquareProps {
  /** The glyph(s) inside: "A" for the logo, two-letter initials for an agent. */
  label: string;
  tone: AvatarTone;
  /** Defaults to 30. */
  size?: AvatarSize;
  className?: string;
}

const TONE: Record<string, string> = {
  action: "bg-action text-action-foreground",
  1: "bg-project-1 text-project-1-deep",
  2: "bg-project-2 text-project-2-deep",
  3: "bg-project-3 text-project-3-deep",
  4: "bg-project-4 text-project-4-deep",
};

/** Geometry pairs measured off the frames: 30/r10/15px and 34/r11/14px. */
const SIZE: Record<AvatarSize, string> = {
  30: "size-[30px] rounded-[10px] text-[15px]",
  34: "size-[34px] rounded-[11px] text-[14px]",
};

export function AvatarSquare({
  label,
  tone,
  size = 30,
  className,
}: AvatarSquareProps) {
  return (
    <span
      data-slot="avatar-square"
      data-tone={String(tone)}
      className={cn(
        "flex shrink-0 select-none items-center justify-center",
        "font-display font-bold leading-none",
        SIZE[size],
        TONE[String(tone)],
        className,
      )}
    >
      {label}
    </span>
  );
}
