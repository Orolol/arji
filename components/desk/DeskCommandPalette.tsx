"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { IdentityChip, Mono, projectTone } from "@/components/piscine";
import type { ControlDeskPayload, DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * ⌘K over the desk payload — and NOTHING else.
 *
 * Arij has no command palette and no global command registry, so this is
 * deliberately scoped to what the desk already holds in memory: its projects,
 * its live sessions, and every ticket in any stratum. Enter opens the ticket
 * overlay or filters to the project. Building a global command system is a
 * different piece of work and would have to invent its own registry.
 */
export interface DeskCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  payload: ControlDeskPayload | null;
  onOpenTicket: (epicId: string) => void;
  onSelectProject: (projectId: string | null) => void;
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
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const entries = React.useMemo<Entry[]>(() => {
    if (!payload) return [];
    const projectsById = new Map(payload.projects.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const rows: Entry[] = [];

    for (const project of payload.projects) {
      rows.push({
        key: `project:${project.id}`,
        kind: "project",
        label: project.name,
        hint: "filtrer le poste",
        project,
        run: () => onSelectProject(project.id),
      });
    }

    for (const session of payload.working) {
      rows.push({
        key: `session:${session.sessionId}`,
        kind: "session",
        label: session.title,
        hint: `${session.taskType} en cours`,
        project: projectsById.get(session.projectId),
        run: () => session.epicId && onOpenTicket(session.epicId),
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
        run: () => onOpenTicket(epicId),
      });
    };

    for (const row of payload.yourTurn.awaitingReply) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, "votre tour");
    }
    for (const row of payload.yourTurn.failed) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, "échec");
    }
    for (const row of payload.yourTurn.conflicts) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, "conflit");
    }
    for (const row of payload.readyToLand) {
      pushTicket(row.epicId, row.projectId, row.readableId, row.title, "prêt à livrer");
    }
    for (const group of payload.upNext) {
      for (const ticket of group.tickets) {
        pushTicket(
          ticket.epicId,
          ticket.projectId,
          ticket.readableId,
          ticket.title,
          "à venir",
        );
      }
    }

    return rows;
  }, [payload, onOpenTicket, onSelectProject]);

  const results = React.useMemo(
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
        aria-label="Rechercher"
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
            placeholder="Chercher un ticket, un projet, une session…"
            aria-label="Chercher"
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
            className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {results.length === 0 ? (
            <Mono size={11} tone="muted" className="px-2 py-3">
              Rien ne correspond.
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
                  "flex cursor-pointer items-center gap-2 rounded-[10px] border-0 px-2 py-[7px] text-left",
                  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
