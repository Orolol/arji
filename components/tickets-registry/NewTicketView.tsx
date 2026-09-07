"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  BandHeader,
  FieldKicker,
  GhostInputPill,
  Mono,
  PillButton,
  SelectPill,
  StrataBand,
  QuietLink,
  projectTone,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useProjects } from "@/hooks/useProjects";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { cn } from "@/lib/utils";

/**
 * `/tickets/new` — the app's real create-a-ticket surface (frame 12a's
 * "New ticket").
 *
 * WHY A SCREEN AND NOT A DIALOG. The global bar's "New" is a `<Link>`, so its
 * destination has to be a route; `components/piscine/TopBar.tsx` says as much
 * where it parks the button on "/" until this screen exists. A route is also
 * what makes the surface linkable — `/tickets/new?project=…` opens it already
 * scoped.
 *
 * IT INTRODUCES NO WRITE PATH OF ITS OWN. The form POSTs to the existing
 * `POST /api/projects/:projectId/epics`, byte for byte the payload the desk
 * composer and the board's QuickCapture send: there is no `draft` epic status,
 * so a new ticket lands in `backlog` unless the user promotes it to `todo`
 * here. No new route, no new column, no migration.
 *
 * The registry itself renders NO second create affordance — one create surface,
 * reached from the one global button.
 */

/** A module-scope copy table: it holds the catalogue key, not the word. */
const STATUS_CHOICES: readonly { value: "backlog" | "todo"; labelKey: TranslationKey }[] = [
  { value: "backlog", labelKey: "Registry.newTicket.columnBacklog" },
  { value: "todo", labelKey: "Registry.newTicket.columnTodo" },
];

type NewTicketStatus = (typeof STATUS_CHOICES)[number]["value"];


const PRIORITY_CHOICES = [3, 2, 1, 0] as const;

export interface NewTicketViewProps {
  projectId?: string;
}

export function NewTicketView({ projectId }: NewTicketViewProps) {
  // Namespace-less: `STATUS_CHOICES` holds full dotted catalogue keys.
  const t = useTranslations();
  const router = useRouter();
  const { allProjects, loading } = useProjects();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projectId ?? null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isBug, setIsBug] = useState(false);
  const [priority, setPriority] = useState(1);
  const [status, setStatus] = useState<NewTicketStatus>("backlog");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derived, never synced: falling back to the first project means no effect
  // has to chase the fetched list.
  const project = useMemo(
    () =>
      allProjects.find((candidate) => candidate.id === selectedProjectId) ??
      allProjects[0] ??
      null,
    [allProjects, selectedProjectId],
  );
  const colorIndex = project
    ? Math.max(0, allProjects.findIndex((candidate) => candidate.id === project.id))
    : 0;

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || !project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/epics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          description: description.trim() || null,
          priority,
          status,
          type: isBug ? "bug" : "feature",
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The typed title is KEPT on failure, so a rejected POST costs a retry
        // and not a re-type.
        setError(
          body?.error
            ? String(body.error)
            : t("Registry.newTicket.refused", { status: res.status }),
        );
        return;
      }
      router.push(`/tickets?project=${encodeURIComponent(project.id)}`);
    } catch {
      setError(t("Registry.newTicket.unreachable"));
    } finally {
      setBusy(false);
    }
  }, [busy, description, isBug, priority, project, router, status, t, title]);

  return (
    <div
      data-testid="new-ticket"
      className="flex h-full min-h-0 w-full flex-col bg-background font-sans text-foreground"
    >
      <div className="flex shrink-0 items-center gap-[7px] px-[24px] pb-[12px]">
        <QuietLink href="/tickets" tone="next" size={12} testId="new-ticket-back">
          {t("Registry.newTicket.back")}
        </QuietLink>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-[14px] pb-[14px]">
        <StrataBand stratum="card" gap={14} className="mx-auto w-full max-w-[720px]">
          <BandHeader
            stratum="card"
            label={t("Registry.newTicket.band")}
            meta={project ? project.name : undefined}
          />

          <label className="flex flex-col gap-[6px]">
            <FieldKicker stratum="card">{t("Registry.newTicket.fieldTitle")}</FieldKicker>
            <GhostInputPill
              value={title}
              onChange={setTitle}
              onSubmit={() => void submit()}
              placeholder={t("Registry.newTicket.titlePlaceholder")}
              fill="field"
              width="flex"
              disabled={busy}
              data-testid="new-ticket-title"
            />
          </label>

          <label className="flex flex-col gap-[6px]">
            <FieldKicker stratum="card">
              {t("Registry.newTicket.fieldDescription")}
            </FieldKicker>
            {/* No multiline primitive exists in the Piscine set, so this field
                is written from the same tokens `GhostInputPill` uses — border
                `--input`, fill `--field` — at the house radius for a field (10)
                rather than a pill's 9999. */}
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              disabled={busy}
              rows={5}
              placeholder={t("Registry.newTicket.descriptionPlaceholder")}
              data-testid="new-ticket-description"
              className={cn(
                "w-full resize-y rounded-[10px] border-[1.5px] border-input bg-field px-3 py-[9px]",
                "font-sans text-[12.5px] leading-[1.5] text-foreground placeholder:text-muted-foreground",
                "shadow-none outline-none",
                "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            />
          </label>

          <div className="flex flex-wrap items-center gap-[10px]">
            <div className="flex flex-col gap-[6px]">
              <FieldKicker stratum="card">{t("Registry.newTicket.fieldProject")}</FieldKicker>
              <SelectPill
                label={
                  project?.name ?? (loading ? "…" : t("Registry.newTicket.projectNone"))
                }
                tone="project"
                projectTone={projectTone(colorIndex)}
                disabled={allProjects.length === 0}
              >
                {allProjects.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.id}
                    onSelect={() => setSelectedProjectId(candidate.id)}
                  >
                    {candidate.name}
                  </DropdownMenuItem>
                ))}
              </SelectPill>
            </div>

            <div className="flex flex-col gap-[6px]">
              <FieldKicker stratum="card">{t("Registry.newTicket.fieldPriority")}</FieldKicker>
              <SelectPill
                label={PRIORITY_LABELS[priority] ?? t("Registry.newTicket.priorityFallback")}
                tone="ink"
              >
                {PRIORITY_CHOICES.map((value) => (
                  <DropdownMenuItem key={value} onSelect={() => setPriority(value)}>
                    {PRIORITY_LABELS[value]}
                  </DropdownMenuItem>
                ))}
              </SelectPill>
            </div>

            <div className="flex flex-col gap-[6px]">
              <FieldKicker stratum="card">{t("Registry.newTicket.fieldColumn")}</FieldKicker>
              <SelectPill
                label={t(
                  STATUS_CHOICES.find((choice) => choice.value === status)?.labelKey ??
                    "Registry.newTicket.columnBacklog",
                )}
                tone="ink"
              >
                {STATUS_CHOICES.map((choice) => (
                  <DropdownMenuItem
                    key={choice.value}
                    onSelect={() => setStatus(choice.value)}
                  >
                    {t(choice.labelKey)}
                  </DropdownMenuItem>
                ))}
              </SelectPill>
            </div>

            <div className="flex flex-col gap-[6px]">
              <FieldKicker stratum="card">{t("Registry.newTicket.fieldType")}</FieldKicker>
              {/* A toggle is a SELECTION: 2px ink border, never a second filled
                  control — the row already carries "Créer le ticket". */}
              <PillButton
                size="sm"
                variant="outline"
                outlineTone="neutral"
                onClick={() => setIsBug(!isBug)}
                aria-pressed={isBug}
                data-testid="new-ticket-bug"
                className={
                  isBug ? "border-2 border-foreground text-foreground" : "text-muted-foreground"
                }
              >
                {t("Registry.newTicket.bug")}
              </PillButton>
            </div>
          </div>

          <div className="flex items-center gap-[12px]">
            <PillButton
              size="md"
              variant="filled"
              icon={Plus}
              onClick={() => void submit()}
              disabled={!project || title.trim().length === 0}
              pending={busy}
              pendingLabel={t("Registry.newTicket.submitPending")}
              data-testid="new-ticket-submit"
            >
              {t("Registry.newTicket.submit")}
            </PillButton>
            {error ? (
              <Mono size={11} tone="danger">
                {error}
              </Mono>
            ) : null}
          </div>
        </StrataBand>
      </div>
    </div>
  );
}
