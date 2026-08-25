"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, FileCode2, Loader2, TriangleAlert, X } from "lucide-react";
import type { Friction } from "@/lib/db/schema";
import {
  FRICTION_CATEGORIES,
  FRICTION_STATUSES,
  OPEN_FRICTION_STATUSES,
  type FrictionCategory,
  type FrictionStatus,
} from "@/lib/frictions/constants";
import {
  FRICTION_CATEGORY_LABELS,
  FRICTION_STATUS_LABELS,
  frictionToEpicDraft,
} from "@/lib/frictions/presentation";
import { EpicCreateDialog } from "@/components/kanban/EpicCreateDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type CategoryFilter = "all" | FrictionCategory;
type StatusFilter = "all" | "open" | FrictionStatus;

const STATUS_STYLES: Record<FrictionStatus, string> = {
  new: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  triaged: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  converted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  dismissed: "border-border bg-muted text-muted-foreground",
};

function isOpen(friction: Friction): boolean {
  return OPEN_FRICTION_STATUSES.includes(
    friction.status as (typeof OPEN_FRICTION_STATUSES)[number],
  );
}

export default function ProjectFrictionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [frictions, setFrictions] = useState<Friction[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selectedFriction, setSelectedFriction] = useState<Friction | null>(null);

  const loadFrictions = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/frictions`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to load frictions");
      setFrictions(payload.data?.frictions ?? []);
      setOpenCount(payload.data?.openCount ?? 0);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load frictions",
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadFrictions();
  }, [loadFrictions]);

  const visibleFrictions = useMemo(
    () =>
      frictions
        .filter(
          (friction) =>
            categoryFilter === "all" || friction.category === categoryFilter,
        )
        .filter((friction) => {
          if (statusFilter === "all") return true;
          if (statusFilter === "open") return isOpen(friction);
          return friction.status === statusFilter;
        })
        .sort(
          (left, right) =>
            right.occurrences - left.occurrences ||
            right.createdAt.localeCompare(left.createdAt) ||
            left.id.localeCompare(right.id),
        ),
    [categoryFilter, frictions, statusFilter],
  );

  const selectedDraft = useMemo(
    () => (selectedFriction ? frictionToEpicDraft(selectedFriction) : undefined),
    [selectedFriction],
  );

  async function dismissFriction(frictionId: string) {
    setPendingId(frictionId);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/frictions/${frictionId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "dismissed" }),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to dismiss friction");
      await loadFrictions();
    } catch (dismissError) {
      setError(
        dismissError instanceof Error
          ? dismissError.message
          : "Failed to dismiss friction",
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <TriangleAlert className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              Frictions
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Recurring obstacles reported by coding agents while they kept working.
            </p>
          </div>
          <Badge variant="outline" className="px-2.5 py-1 text-xs">
            {openCount} open
          </Badge>
        </div>

        <div className="flex flex-wrap gap-3" aria-label="Friction filters">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Category
            <select
              value={categoryFilter}
              onChange={(event) =>
                setCategoryFilter(event.target.value as CategoryFilter)
              }
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="all">All categories</option>
              {FRICTION_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {FRICTION_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="open">Open</option>
              <option value="all">All statuses</option>
              {FRICTION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {FRICTION_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">Loading frictions</span>
          </div>
        ) : visibleFrictions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
            No frictions match these filters.
          </div>
        ) : (
          <div className="space-y-3" data-testid="friction-list">
            {visibleFrictions.map((friction) => (
              <Card key={friction.id} data-testid={`friction-${friction.id}`}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div
                      className="flex h-10 min-w-10 items-center justify-center rounded-lg bg-amber-500/10 px-2 text-sm font-semibold text-amber-700 dark:text-amber-300"
                      title={`${friction.occurrences} occurrences`}
                    >
                      ×{friction.occurrences}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {FRICTION_CATEGORY_LABELS[friction.category]}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn("text-[11px]", STATUS_STYLES[friction.status])}
                        >
                          {FRICTION_STATUS_LABELS[friction.status]}
                        </Badge>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                        {friction.description}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        {friction.filePath && (
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                            <code className="truncate">{friction.filePath}</code>
                          </span>
                        )}
                        <Link
                          href={`/projects/${projectId}/sessions/${friction.agentSessionId}`}
                          className="hover:text-foreground hover:underline"
                        >
                          Source session
                        </Link>
                        <time dateTime={friction.createdAt}>
                          {new Date(friction.createdAt).toLocaleString()}
                        </time>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {isOpen(friction) && (
                        <>
                          <Button
                            size="sm"
                            onClick={() => setSelectedFriction(friction)}
                            disabled={pendingId === friction.id}
                          >
                            Create ticket
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void dismissFriction(friction.id)}
                            disabled={pendingId === friction.id}
                          >
                            {pendingId === friction.id ? (
                              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                            ) : (
                              <X className="h-4 w-4" />
                            )}
                            Dismiss
                          </Button>
                        </>
                      )}
                      {friction.status === "converted" && friction.epicId && (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/projects/${projectId}?ticket=${friction.epicId}`}>
                            <CheckCircle2 className="h-4 w-4" />
                            View ticket
                          </Link>
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <EpicCreateDialog
        projectId={projectId}
        open={selectedFriction !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSelectedFriction(null);
        }}
        initialDraft={selectedDraft}
        frictionId={selectedFriction?.id}
        dialogTitle="Create ticket from friction"
        dialogDescription="Review the agent report, then edit the ticket before creating it."
        submitLabel="Create Ticket"
        onCreated={() => {
          setSelectedFriction(null);
          void loadFrictions();
        }}
      />
    </div>
  );
}
