"use client";

import * as React from "react";

import { GhostInputPill, SelectPill } from "@/components/piscine";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import { displayVersion } from "./derive";

export interface VersionPillProps {
  /** The version to print. `displayVersion` adds the leading `v` when absent,
   *  so both a composed "0.4.3" and a stored "v0.4.3" render as `v0.4.3`. */
  version: string;
  /** Computed bumps off the latest release, or null when there is none. */
  bumps: { patch: string; minor: string; major: string } | null;
  onSelect: (version: string) => void;
  /** Inspect mode: same geometry, no trigger. */
  readOnly?: boolean;
}

/** Shared geometry so the static and the interactive pill are pixel-identical. */
const PILL =
  "h-[30px] px-[13px] rounded-full bg-card font-mono text-[12px] font-bold tabular-nums text-foreground";

/**
 * The `v0.4.3 ▾` pill of the NEXT RELEASE band header.
 *
 * The frame draws a literal ▾ (U+25BE); per the primitives contract the system
 * ships a lucide chevron-down instead — SelectPill owns that decision.
 */
export function VersionPill({
  version,
  bumps,
  onSelect,
  readOnly = false,
}: VersionPillProps) {
  const [draft, setDraft] = React.useState("");

  if (readOnly) {
    return (
      <span
        data-testid="release-version-pill"
        className={`flex shrink-0 items-center leading-none ${PILL}`}
      >
        {displayVersion(version)}
      </span>
    );
  }

  const commit = () => {
    // A user who types "v1.0.0" means 1.0.0: the server names the tag
    // `v${version}` and the branch `release/v${version}` literally, so a stored
    // leading v would produce "vv1.0.0" everywhere downstream.
    const next = draft.trim().replace(/^v/i, "");
    if (!next) return;
    onSelect(next);
    setDraft("");
  };

  return (
    <span data-testid="release-version-pill">
      <SelectPill label={displayVersion(version)} tone="mono" fill="card" className={PILL}>
        {bumps ? (
          <>
            <DropdownMenuItem
              className="font-mono text-[11px] font-normal tabular-nums"
              onSelect={() => onSelect(bumps.patch)}
            >
              {`patch · ${bumps.patch}`}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="font-mono text-[11px] font-normal tabular-nums"
              onSelect={() => onSelect(bumps.minor)}
            >
              {`minor · ${bumps.minor}`}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="font-mono text-[11px] font-normal tabular-nums"
              onSelect={() => onSelect(bumps.major)}
            >
              {`major · ${bumps.major}`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <div className="px-1 py-1">
          {/*
            The field IS `GhostInputPill` — its recipe used to be transcribed
            here by hand with the height quietly changed to 30px, which is how
            a primitive drifts. `width` is not passed: neither a fixed px width
            nor `flex-1` fills a block container, so the pill takes `w-full`
            through `className`.
          */}
          <GhostInputPill
            aria-label="Version"
            data-testid="release-version-input"
            value={draft}
            onChange={setDraft}
            placeholder="1.0.0"
            className="w-full"
            // Radix's menu typeahead would otherwise swallow every keystroke
            // and move focus off the field. GhostInputPill spreads `{...props}`
            // AFTER its own handler, so owning `onKeyDown` means owning Enter
            // (and its IME guard) as well — `onSubmit` would never fire.
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              commit();
            }}
          />
        </div>
      </SelectPill>
    </span>
  );
}
