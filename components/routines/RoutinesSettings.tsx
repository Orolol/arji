"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatDateTime } from "@/lib/i18n/format";
import type { UiLocale } from "@/lib/i18n/locales";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock3, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  AVAILABLE_ROUTINE_KINDS,
  ROUTINE_KIND_DESCRIPTIONS,
  ROUTINE_KIND_LABELS,
  defaultRoutineConfig,
  isAvailableRoutineKind,
  type AvailableRoutineKind,
} from "@/lib/routines/constants";

interface RoutineRecord {
  id: string;
  projectId: string;
  kind: AvailableRoutineKind;
  enabled: boolean;
  timeOfDay: string;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  lastStatus: string | null;
}

interface RoutineKindOption {
  kind: AvailableRoutineKind;
  label: string;
  description: string;
}

interface RoutinesResponse {
  data?: RoutineRecord[];
  meta?: {
    availableKinds?: Array<{
      kind?: unknown;
      label?: unknown;
      description?: unknown;
    }>;
    serverTimezone?: unknown;
    ciAutofixEnabled?: unknown;
  };
  error?: string;
}

const DEFAULT_TIME_OF_DAY = "22:00";

/*
 * NO COPY IN THE HELPERS BELOW. `parseConfig`, `formatLastRun` and
 * `statusLabel` are pure and evaluated outside React, so they take their
 * phrases ALREADY RESOLVED from the component that calls them — they compose,
 * they do not word (`lib/i18n/catalogue.ts`, pattern 3).
 */

function fallbackKindOptions(): RoutineKindOption[] {
  return AVAILABLE_ROUTINE_KINDS.map((kind) => ({
    kind,
    label: ROUTINE_KIND_LABELS[kind],
    description: ROUTINE_KIND_DESCRIPTIONS[kind],
  }));
}

function parseKindOptions(
  value: RoutinesResponse["meta"],
): RoutineKindOption[] {
  const parsed = (value?.availableKinds ?? []).flatMap((option) => {
    if (!isAvailableRoutineKind(option.kind)) return [];
    return [
      {
        kind: option.kind,
        label:
          typeof option.label === "string"
            ? option.label
            : ROUTINE_KIND_LABELS[option.kind],
        description:
          typeof option.description === "string"
            ? option.description
            : ROUTINE_KIND_DESCRIPTIONS[option.kind],
      },
    ];
  });
  return parsed.length > 0 ? parsed : fallbackKindOptions();
}

function formatConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

function parseConfig(
  config: string,
  copy: { notJson: string; notObject: string },
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new Error(copy.notJson);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(copy.notObject);
  }
  return parsed as Record<string, unknown>;
}

function formatLastRun(
  value: string | null,
  serverTimezone: string,
  locale: UiLocale,
  never: string,
): string {
  if (!value) return never;
  return (
    formatDateTime(value, {
      locale,
      style: "dateTime",
      ...(serverTimezone !== "local" ? { timeZone: serverTimezone } : {}),
    }) || value
  );
}

/**
 * The routine's last outcome. `status` is the SERVER's own value
 * (`completed`, `failed`, `running`, `scheduled`) and stays out of the
 * catalogue like every other persisted string; only the "no run yet" wording
 * is copy.
 */
function statusLabel(status: string | null, notRun: string): string {
  if (!status) return notRun;
  return status.replaceAll("_", " ");
}

function statusClass(status: string | null): string {
  if (status === "completed") return "text-agent border-agent/30";
  if (status === "failed") return "text-destructive border-destructive/30";
  if (status === "running") return "text-primary border-primary/30";
  return "text-muted-foreground border-border";
}

interface RoutineEditorProps {
  projectId: string;
  routine: RoutineRecord | null;
  kindOptions: RoutineKindOption[];
  serverTimezone: string;
  onSaved: (routine: RoutineRecord) => void;
  onDeleted: (routineId: string) => void;
  onCancelNew: () => void;
}

function RoutineEditor({
  projectId,
  routine,
  kindOptions,
  serverTimezone,
  onSaved,
  onDeleted,
  onCancelNew,
}: RoutineEditorProps) {
  const locale = useLocale();
  const t = useTranslations("Routines");
  const initialKind = routine?.kind ?? kindOptions[0]?.kind ?? "night_run";
  const [kind, setKind] = useState<AvailableRoutineKind>(initialKind);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [timeOfDay, setTimeOfDay] = useState(
    routine?.timeOfDay ?? DEFAULT_TIME_OF_DAY,
  );
  const [configText, setConfigText] = useState(
    formatConfig(routine?.config ?? defaultRoutineConfig(initialKind)),
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preserveDraftOnNextRoutineUpdate = useRef(false);
  const isNew = routine === null;
  const selectedKind =
    kindOptions.find((option) => option.kind === kind) ?? kindOptions[0];

  useEffect(() => {
    if (!routine) return;
    if (preserveDraftOnNextRoutineUpdate.current) {
      preserveDraftOnNextRoutineUpdate.current = false;
      setEnabled(routine.enabled);
      return;
    }
    setKind(routine.kind);
    setEnabled(routine.enabled);
    setTimeOfDay(routine.timeOfDay);
    setConfigText(formatConfig(routine.config));
  }, [routine]);

  async function save() {
    setError(null);
    setMessage(null);
    let config: Record<string, unknown>;
    try {
      config = parseConfig(configText, {
        notJson: t("errors.configNotJson"),
        notObject: t("errors.configNotObject"),
      });
    } catch (parseError) {
      setError(
        parseError instanceof Error
          ? parseError.message
          : t("errors.invalidConfig"),
      );
      return;
    }

    setSaving(true);
    try {
      const url = routine
        ? `/api/projects/${projectId}/routines/${routine.id}`
        : `/api/projects/${projectId}/routines`;
      const response = await fetch(url, {
        method: routine ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, enabled, timeOfDay, config }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: RoutineRecord;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || t("errors.save"));
      }
      onSaved(payload.data);
      setMessage(isNew ? t("editor.created") : t("editor.saved"));
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : t("errors.save"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(next: boolean) {
    if (!routine) {
      setEnabled(next);
      return;
    }

    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/routines/${routine.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        data?: RoutineRecord;
        error?: string;
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error || t("errors.update"));
      }
      preserveDraftOnNextRoutineUpdate.current = true;
      onSaved(payload.data);
    } catch (toggleError) {
      setEnabled(previous);
      setError(
        toggleError instanceof Error ? toggleError.message : t("errors.update"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!routine) return;
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/routines/${routine.id}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || t("errors.delete"));
      }
      onDeleted(routine.id);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : t("errors.delete"),
      );
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  function changeKind(next: AvailableRoutineKind) {
    setKind(next);
    setConfigText(formatConfig(defaultRoutineConfig(next)));
    setMessage(null);
    setError(null);
  }

  return (
    <article
      className="rounded-[12px] border border-border bg-card px-[18px] py-[16px]"
      data-testid={routine ? `routine-${routine.id}` : "new-routine"}
    >
      <div className="flex flex-wrap items-start gap-[12px]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-[9px]">
            <h3 className="text-[14px] font-semibold">
              {isNew ? t("editor.newRoutine") : ROUTINE_KIND_LABELS[routine.kind]}
            </h3>
            {!isNew && (
              <span
                className={`rounded-full border px-[8px] py-[2px] text-[11px] capitalize ${statusClass(
                  routine.lastStatus,
                )}`}
              >
                {statusLabel(routine.lastStatus, t("editor.statusNotRun"))}
              </span>
            )}
          </div>
          <p className="mt-[3px] text-[12.5px] text-muted-foreground">
            {selectedKind?.description}
          </p>
        </div>

        <div className="flex items-center gap-[7px]">
          <Checkbox
            id={`enabled-${routine?.id ?? "new"}`}
            checked={enabled}
            disabled={saving || deleting}
            aria-label={t("editor.enableAria", {
              label: selectedKind?.label ?? t("editor.routineFallback"),
            })}
            onCheckedChange={(checked) => void toggleEnabled(checked === true)}
          />
          <label
            className="cursor-pointer text-[12.5px] font-medium"
            htmlFor={`enabled-${routine?.id ?? "new"}`}
          >
            {t("editor.enabled")}
          </label>
        </div>
      </div>

      <div className="mt-[16px] grid gap-[14px] md:grid-cols-[minmax(180px,0.7fr)_160px_minmax(280px,1.3fr)]">
        <div className="space-y-[6px]">
          <label
            className="text-[12px] font-medium"
            htmlFor={`kind-${routine?.id ?? "new"}`}
          >
            {t("editor.kind")}
          </label>
          <Select
            value={kind}
            disabled={saving || deleting}
            onValueChange={(value) => {
              if (isAvailableRoutineKind(value)) changeKind(value);
            }}
          >
            <SelectTrigger
              id={`kind-${routine?.id ?? "new"}`}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kindOptions.map((option) => (
                <SelectItem key={option.kind} value={option.kind}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-[6px]">
          <label
            className="text-[12px] font-medium"
            htmlFor={`time-${routine?.id ?? "new"}`}
          >
            {t("editor.dailyTime")}
          </label>
          <Input
            id={`time-${routine?.id ?? "new"}`}
            type="time"
            value={timeOfDay}
            disabled={saving || deleting}
            onChange={(event) => setTimeOfDay(event.target.value)}
          />
          {kind === "ci_watch" && (
            <p className="text-[11px] text-muted-foreground">
              {t("editor.ciWatchTimeNote")}
            </p>
          )}
        </div>

        <div className="space-y-[6px]">
          <label
            className="text-[12px] font-medium"
            htmlFor={`config-${routine?.id ?? "new"}`}
          >
            {t("editor.configuration")}
          </label>
          <Textarea
            id={`config-${routine?.id ?? "new"}`}
            value={configText}
            rows={5}
            spellCheck={false}
            disabled={saving || deleting}
            onChange={(event) => setConfigText(event.target.value)}
            className="font-mono text-[12px]"
          />
          <p className="text-[11px] text-muted-foreground">
            {kind === "night_run"
              ? t("editor.configHintNightRun")
              : kind === "github_issue_sync"
                ? t("editor.configHintGithubIssueSync")
                : kind === "retention"
                  ? t("editor.configHintRetention")
                  : t("editor.configHintInterval")}
          </p>
        </div>
      </div>

      {!isNew && routine.lastStatus === "scheduled" && (
        <div className="mt-[13px] flex items-center gap-[7px] text-[11.5px] text-muted-foreground">
          <Clock3 className="h-[13px] w-[13px]" />
          {t("editor.scheduledTomorrow", {
            time: routine.timeOfDay,
            timezone: serverTimezone,
          })}
        </div>
      )}

      {!isNew && routine.lastStatus !== "scheduled" && (
        <div className="mt-[13px] flex items-center gap-[7px] text-[11.5px] text-muted-foreground">
          <Clock3 className="h-[13px] w-[13px]" />
          {t("editor.lastRun", {
            time: formatLastRun(
              routine.lastRunAt,
              serverTimezone,
              locale,
              t("editor.lastRunNever"),
            ),
          })}
          <span aria-hidden="true">·</span>
          {t("editor.status", {
            status: statusLabel(routine.lastStatus, t("editor.statusNotRun")),
          })}
        </div>
      )}

      {(error || message) && (
        <p
          role={error ? "alert" : "status"}
          className={`mt-[12px] text-[12px] ${
            error ? "text-destructive" : "text-agent"
          }`}
        >
          {error ?? message}
        </p>
      )}

      <div className="mt-[15px] flex items-center gap-[8px]">
        <Button
          type="button"
          size="sm"
          disabled={saving || deleting}
          onClick={() => void save()}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isNew ? t("editor.create") : t("editor.save")}
        </Button>

        {isNew ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancelNew}>
            {t("editor.cancel")}
          </Button>
        ) : confirmDelete ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("editor.confirmDelete")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={deleting}
              onClick={() => setConfirmDelete(false)}
            >
              {t("editor.cancel")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            aria-label={t("editor.deleteAria", {
              label: selectedKind?.label ?? t("editor.routineFallback"),
            })}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("editor.delete")}
          </Button>
        )}
      </div>
    </article>
  );
}

export function RoutinesSettings({ projectId }: { projectId: string }) {
  const t = useTranslations("Routines");
  const [routines, setRoutines] = useState<RoutineRecord[]>([]);
  const [kindOptions, setKindOptions] = useState<RoutineKindOption[]>(
    fallbackKindOptions(),
  );
  const [serverTimezone, setServerTimezone] = useState("local");
  const [ciAutofixEnabled, setCiAutofixEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingAutofix, setSavingAutofix] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autofixError, setAutofixError] = useState<string | null>(null);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/routines`);
        const payload = (await response
          .json()
          .catch(() => ({}))) as RoutinesResponse;
        if (!response.ok) {
          throw new Error(payload.error || t("errors.load"));
        }
        const options = parseKindOptions(payload.meta);
        const allowed = new Set(options.map((option) => option.kind));
        setKindOptions(options);
        setRoutines(
          (Array.isArray(payload.data) ? payload.data : []).filter((routine) =>
            allowed.has(routine.kind),
          ),
        );
        if (typeof payload.meta?.serverTimezone === "string") {
          setServerTimezone(payload.meta.serverTimezone);
        }
        setCiAutofixEnabled(payload.meta?.ciAutofixEnabled === true);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : t("errors.load"),
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const availableKindsLabel = useMemo(
    () => kindOptions.map((option) => option.label).join(", "),
    [kindOptions],
  );
  const configuredKinds = useMemo(
    () => new Set(routines.map((routine) => routine.kind)),
    [routines],
  );
  const newRoutineKindOptions = useMemo(
    () => kindOptions.filter((option) => !configuredKinds.has(option.kind)),
    [configuredKinds, kindOptions],
  );

  function upsertRoutine(next: RoutineRecord) {
    setRoutines((current) => {
      const index = current.findIndex((routine) => routine.id === next.id);
      if (index < 0) return [...current, next];
      return current.map((routine) =>
        routine.id === next.id ? next : routine,
      );
    });
    setCreating(false);
  }

  async function toggleAutofix(next: boolean) {
    const previous = ciAutofixEnabled;
    setCiAutofixEnabled(next);
    setSavingAutofix(true);
    setAutofixError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/routines/ci-autofix`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        data?: { enabled?: boolean };
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || t("errors.autofix"));
      }
      setCiAutofixEnabled(payload.data?.enabled === true);
    } catch (saveError) {
      setCiAutofixEnabled(previous);
      setAutofixError(
        saveError instanceof Error ? saveError.message : t("errors.autofix"),
      );
    } finally {
      setSavingAutofix(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col px-[26px] pb-[30px] pt-[24px]">
      <div className="flex flex-wrap items-start gap-[16px]">
        <div>
          <h2 className="text-[19px] font-semibold">{t("page.title")}</h2>
          <p className="mt-[4px] text-[13px] text-muted-foreground">
            {t("page.subtitle")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[8px]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            {t("page.refresh")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading || creating || newRoutineKindOptions.length === 0}
            onClick={() => setCreating(true)}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("page.addRoutine")}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="routines" className="mt-[20px] gap-0">
        <TabsList
          variant="line"
          className="w-full justify-start border-b border-border px-0"
          aria-label={t("page.title")}
        >
          <TabsTrigger value="routines" className="px-[12px] pb-[9px]">
            {t("page.routinesTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="routines">
          <section className="mt-[20px]" aria-labelledby="routines-heading">
            <div className="flex flex-wrap items-start gap-[16px]">
              <div>
                <h3 id="routines-heading" className="text-[16px] font-semibold">
                  {t("section.heading")}
                </h3>
                <p className="mt-[4px] max-w-3xl text-[12.5px] text-muted-foreground">
                  {serverTimezone !== "local"
                    ? t("section.timezoneNoteZoned", {
                        timezone: serverTimezone,
                      })
                    : t("section.timezoneNote")}
                </p>
                <p className="mt-[3px] text-[11.5px] text-muted-foreground">
                  {t("section.availableKinds", { kinds: availableKindsLabel })}
                </p>
              </div>
            </div>

            <div className="mt-[16px] rounded-[12px] border border-border bg-band/40 px-[18px] py-[15px]">
              <div className="flex items-start gap-[9px] text-[13px]">
                <Checkbox
                  id="ci-autofix-enabled"
                  className="mt-[2px]"
                  checked={ciAutofixEnabled}
                  disabled={savingAutofix}
                  aria-label={t("autofix.label")}
                  onCheckedChange={(checked) =>
                    void toggleAutofix(checked === true)
                  }
                />
                <label className="cursor-pointer" htmlFor="ci-autofix-enabled">
                  <span className="font-medium">{t("autofix.label")}</span>
                  <span className="block text-[12px] text-muted-foreground">
                    {t("autofix.description")}
                  </span>
                </label>
              </div>
              {autofixError && (
                <p
                  className="mt-[8px] text-[12px] text-destructive"
                  role="alert"
                >
                  {autofixError}
                </p>
              )}
            </div>

            {loading ? (
              <div className="mt-[22px] flex items-center gap-[8px] text-[13px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("page.loading")}
              </div>
            ) : error ? (
              <p
                className="mt-[22px] text-[13px] text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : (
              <div className="mt-[16px] space-y-[12px]">
                {creating && (
                  <RoutineEditor
                    projectId={projectId}
                    routine={null}
                    kindOptions={newRoutineKindOptions}
                    serverTimezone={serverTimezone}
                    onSaved={upsertRoutine}
                    onDeleted={() => {}}
                    onCancelNew={() => setCreating(false)}
                  />
                )}

                {routines.length === 0 && !creating && (
                  <div className="rounded-[12px] border border-dashed border-border px-[20px] py-[28px] text-center">
                    <p className="text-[13.5px] font-medium">
                      {t("empty.title")}
                    </p>
                    <p className="mt-[4px] text-[12.5px] text-muted-foreground">
                      {t("empty.description")}
                    </p>
                  </div>
                )}

                {routines.map((routine) => (
                  <RoutineEditor
                    key={routine.id}
                    projectId={projectId}
                    routine={routine}
                    kindOptions={kindOptions.filter(
                      (option) =>
                        option.kind === routine.kind ||
                        !configuredKinds.has(option.kind),
                    )}
                    serverTimezone={serverTimezone}
                    onSaved={upsertRoutine}
                    onDeleted={(routineId) =>
                      setRoutines((current) =>
                        current.filter((item) => item.id !== routineId),
                      )
                    }
                    onCancelNew={() => {}}
                  />
                ))}
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
