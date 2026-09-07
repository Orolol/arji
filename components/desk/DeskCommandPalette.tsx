"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";

/*
 * Leaf imports, NOT the `@/components/piscine` barrel: the barrel exports
 * `TopBar`, `TopBar` mounts this palette, and importing the barrel back from
 * here would close an import cycle.
 */
import { IdentityChip } from "@/components/piscine/IdentityChip";
import { Mono } from "@/components/piscine/Mono";
import { projectTone } from "@/lib/piscine/tokens";
import type { ControlDeskPayload, DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * ⌘K over the control-desk payload — and NOTHING else.
 *
 * Arij has no global command registry, so this is deliberately scoped to what
 * the desk aggregate already holds: its projects, its live sessions, and every
 * ticket in any stratum. Building a general command system is a different piece
 * of work and would have to invent that registry first.
 *
 * IT IS MOUNTED BY THE TOP BAR, not by the desk. It still lives in
 * `components/desk/` because the desk payload is its whole vocabulary, but the
 * bar is the only thing on every route, so the bar owns the ⌘K binding and this
 * component's one instance. What a result DOES is the caller's decision:
 * `onOpenTicket` receives the owning project so a host outside the desk can
 * turn it into a URL.
 */
export interface DeskCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  payload: ControlDeskPayload | null;
  /** The project id is passed too — a host outside the desk needs it to route. */
  onOpenTicket: (epicId: string, projectId: string) => void;
  onSelectProject: (projectId: string) => void;
}

interface Entry {
  key: string;
  kind: "project" | "ticket" | "session";
  label: string;
  hint: string;
  project: DeskProject | undefined;
  run: () => void;
}

/** Subsequence match — "irf" finds "Inline Review Findings". */
export function fuzzyMatches(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  const target = haystack.toLowerCase();
  const query = needle.toLowerCase();
  let index = 0;
  for (const char of query) {
    index = target.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

export function DeskCommandPalette({
  open,
  onClose,
  payload,
  onOpenTicket,
  onSelectProject,
}: DeskCommandPaletteProps) {
  const t = useTranslations("Desk");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  /*
    Closing clears the query, so the next open starts empty rather than on the
    previous search. Adjusted during render rather than from an effect.

    TopBar's only call site mounts this behind `{paletteOpen ? … : null}` and
    passes `open` bare, so today the component unmounts on close and this branch
    never runs. It stays because `open` is a declared prop: a caller that keeps
    the palette mounted and toggles the prop is exactly the case the reset is
    for, and the guard is one comparison when it is not.
  */
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setCursor(0);
    }
  }

  const entries = useMemo<Entry[]>(() => {
    if (!payload) return [];
    const projectsById = new Map(payload.projects.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const rows: Entry[] = [];

    for (const project of payload.projects) {
      rows.push({
        key: `project:${project.id}`,
        kind: "project",
        label: project.name,
        hint: t("palette.hintProject"),
        project,
        run: () => onSelectProject(project.id),
      });
    }

    for (const session of payload.working) {
      rows.push({
        key: `session:${session.sessionId}`,
        kind: "session",
        label: session.title,
        hint: t("palette.hintSession", { taskType: session.taskType }),
        project: projectsById.get(session.projectId),
        run: () => session.epicId && onOpenTicket(session.epicId, session.projectId),
      });
    }

    const pushTicket = (
      epicId: string,
      projectId: string,
      readableId: string | null,
      title: string,
      hint: string,
    ) => {
      if (seen.has(epicId)) return;
      seen.add(epicId);
      rows.push({
        key: `ticket:${epicId}`,
        kind: "ticket",
        label: `${readableId ? `${readableId} ` : ""}${title}`,
        hint,
        project: projectsById.get(projectId),
        run: () => onOpenTicket(epicId, projectId),
      });
    };

    for (const row of payload.yourTurn.awaitingReply) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, t("palette.hintYourTurn"));
    }
    for (const row of payload.yourTurn.failed) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, t("palette.hintFailed"));
    }
    for (const row of payload.yourTurn.conflicts) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, t("palette.hintConflict"));
    }
    for (const row of payload.readyToLand) {
      pushTicket(
        row.epicId,
        row.projectId,
        row.readableId,
        row.title,
        t("palette.hintReadyToLand"),
      );
    }
    for (const group of payload.upNext) {
      for (const ticket of group.tickets) {
        pushTicket(
          ticket.epicId,
          ticket.projectId,
          ticket.readableId,
          ticket.title,
          t("palette.hintUpNext"),
        );
      }
    }

    return rows;
  }, [payload, onOpenTicket, onSelectProject, t]);

  const results = useMemo(
    () => entries.filter((entry) => fuzzyMatches(entry.label, query)).slice(0, 12),
    [entries, query],
  );

  if (!open) return null;

  return (
    <div
      data-testid="desk-command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.dialogLabel")}
        onClick={(event) => event.stopPropagation()}
        // No shadow. `--shadow-overlay` is the system's ONLY shadow and it
        // belongs to the ticket overlay; the scrim behind this panel already
        // separates it from the desk, so borrowing the overlay's one effect
        // would make it the second thing that reads as "the modal".
        className="flex w-[min(620px,92vw)] flex-col gap-2 rounded-lg bg-background p-3"
      >
        <div className="flex items-center gap-2 rounded-[10px] border-[1.5px] border-input bg-field px-3 py-2">
          <Search size={13} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={query}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.inputLabel")}
            data-testid="desk-command-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, Math.max(0, results.length - 1)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const entry = results[cursor];
                if (!entry) return;
                entry.run();
                onClose();
              }
            }}
            // The ring belongs to the input, not to the field box around it.
            // Ringing the box on focus-within would look the same here, but it
            // would leave this element still declaring no affordance of its
            // own — the shape B-arij-203 is about — and every guard that reads
            // one element's classes would keep reporting it as bare.
            // Positive offset: the box's px-3 py-2 leaves room outside the
            // input, and p-0 leaves none inside.
            className={cn(
              "min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[13px] text-foreground",
              "outline-none placeholder:text-muted-foreground",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          />
        </div>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {results.length === 0 ? (
            <Mono size={11} tone="muted" className="px-2 py-3">
              {t("palette.empty")}
            </Mono>
          ) : (
            results.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                data-testid="desk-command-result"
                onClick={() => {
                  entry.run();
                  onClose();
                }}
                className={cn(
                  "flex items-center gap-2 rounded-[10px] border-0 px-2 py-[7px] text-left",
                  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
                  index === cursor ? "bg-muted" : "bg-transparent",
                )}
              >
                <IdentityChip
                  label={entry.project?.shortName ?? "—"}
                  tone={projectTone(entry.project?.colorIndex ?? 0)}
                  size="sm"
                />
                <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[13px] text-foreground">
                  {entry.label}
                </span>
                <Mono size={10.5} tone="muted">
                  {entry.hint}
                </Mono>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
