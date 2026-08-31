import * as React from "react";

import { Mono, type MonoTone } from "@/components/piscine";
import { cn } from "@/lib/utils";

/**
 * SettingRow — `control · label · (spacer) · mono suffix`, the row grammar of
 * frame 11c's Full Auto / Night runs / Notifications bands.
 *
 * The control slot takes either a {@link SettingToggle} (a real setting) or a
 * `CheckMark` (a statement of an invariant the user cannot change). That
 * distinction is deliberate: a permanently-on toggle reads as "you could turn
 * this off", and you cannot.
 *
 * When the row is OFF the label drops to `--muted-foreground` and the suffix
 * to `muted`. Ink weight carries the state — never a colour.
 */
export interface SettingRowProps {
  /** The toggle or check mark that opens the row. */
  toggle: React.ReactNode;
  label: React.ReactNode;
  /** Trailing mono note, e.g. `· toujours`, `webhook`, `off`. */
  suffix?: React.ReactNode;
  suffixTone?: MonoTone;
  /** Dim the label and mute the suffix. */
  off?: boolean;
  /** `flex-1` on the label, so the suffix right-aligns (Notifications rows). */
  grow?: boolean;
  className?: string;
}

export function SettingRow({
  toggle,
  label,
  suffix,
  suffixTone = "muted",
  off = false,
  grow = false,
  className,
}: SettingRowProps) {
  return (
    <div
      data-slot="setting-row"
      className={cn("flex items-center gap-[9px]", className)}
    >
      {toggle}
      <span
        className={cn(
          "font-sans text-[12.5px] leading-tight",
          grow && "min-w-0 flex-1",
          off ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {label}
      </span>
      {suffix !== undefined && suffix !== null ? (
        <Mono size={10} tone={off ? "muted" : suffixTone}>
          {suffix}
        </Mono>
      ) : null}
    </div>
  );
}
