"use client";

import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { BandHeader, Mono, QuietLink, Stamp, StrataBand } from "@/components/piscine";
import { formatRelative } from "@/lib/i18n/format";

import {
  displayVersion,
  parseEpicIds,
  releaseState,
  RELEASE_STATE_KEYS,
  type ReleaseEpic,
  type ReleaseRow,
} from "./derive";

export interface ReleaseHistoryProps {
  /** In the order the API returned them (createdAt DESC). Never re-sorted. */
  releases: ReleaseRow[];
  epicById: Map<string, ReleaseEpic>;
  loading: boolean;
  onInspect: (releaseId: string) => void;
}

/**
 * The HISTORY card: one expandable row per release, its recorded tickets
 * indented beneath it, and the way into the band's inspect mode.
 *
 * The GH stamp carries the STATE in its word (`GH RELEASE` / `GH DRAFT`) on one
 * shared pool ground — colour is the artefact family, never the state. That is
 * the documented extension of the frame, which only draws the published case.
 */
export function ReleaseHistory({
  releases,
  epicById,
  loading,
  onInspect,
}: ReleaseHistoryProps) {
  const locale = useLocale();
  const t = useTranslations("Releases");
  const all = useTranslations();
  // One at a time: a history card with four open rows is a list, not a history.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <StrataBand
      stratum="card"
      gap={8}
      className="min-h-0 min-w-0 flex-1 shrink px-[16px] py-[14px]"
    >
      <BandHeader
        stratum="neutral"
        labelSize={12}
        standalone
        label={t("history.label")}
      />

      {loading ? null : releases.length === 0 ? (
        <Mono size={11} tone="muted">
          {t("history.empty")}
        </Mono>
      ) : (
        <div
          data-testid="release-history-list"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {releases.map((release, index) => {
            const expanded = expandedId === release.id;
            const isLast = index === releases.length - 1;
            const ticketIds = parseEpicIds(release);
            const state = releaseState(release);
            const hasStamps = release.gitTag !== null || state !== "local";

            return (
              <React.Fragment key={release.id}>
                <button
                  type="button"
                  data-testid={`release-history-row-${release.id}`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : release.id)}
                  className={`flex w-full items-center gap-[10px] px-[2px] py-[10px] text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    isLast && !expanded ? "" : "border-b-[1.5px] border-muted"
                  }`}
                >
                  {/* The icon swaps; it does not rotate. Motion is reserved for
                      liveness, and a rotation would need a reduced-motion gate. */}
                  {expanded ? (
                    <ChevronDown
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <ChevronRight
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <Mono size={12} weight={700}>
                    {displayVersion(release.version)}
                  </Mono>
                  <Mono size={10.5} tone="muted" clamp={1}>
                    {t("history.rowMeta", {
                      count: ticketIds.length,
                      age: formatRelative(release.createdAt, { locale }),
                    })}
                  </Mono>
                  {hasStamps ? (
                    <span className="ml-auto flex shrink-0 items-center gap-[10px]">
                      {release.gitTag !== null ? (
                        <Stamp tone="land">{t("history.tag")}</Stamp>
                      ) : null}
                      {state === "published" ? (
                        <Stamp tone="next">{t("history.githubRelease")}</Stamp>
                      ) : state === "draft" ? (
                        <Stamp tone="next">{t("history.githubDraft")}</Stamp>
                      ) : null}
                    </span>
                  ) : null}
                </button>

                {expanded ? (
                  <div
                    data-testid={`release-history-tickets-${release.id}`}
                    className={`flex flex-col gap-[5px] pt-[9px] pr-[2px] pb-[11px] pl-[25px] ${
                      isLast ? "" : "border-b-[1.5px] border-muted"
                    }`}
                  >
                    {ticketIds.length === 0 ? (
                      <Mono size={11} tone="muted">
                        {t("history.noTickets")}
                      </Mono>
                    ) : (
                      ticketIds.map((id) => {
                        const epic = epicById.get(id);
                        // The epic was deleted; the release still recorded it.
                        const label = epic?.readableId || id.slice(0, 8);
                        return (
                          <Mono key={id} size={11} tone="muted" clamp={1}>
                            {`${label} · ${epic ? epic.title : "—"}`}
                          </Mono>
                        );
                      })
                    )}
                    <QuietLink
                      tone="next"
                      size={11.5}
                      onClick={() => onInspect(release.id)}
                    >
                      {t("history.viewChangelog")}
                    </QuietLink>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </StrataBand>
  );
}
