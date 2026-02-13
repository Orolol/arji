"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useEpicDependencies } from "@/hooks/useEpicDependencies";
import { Plus, X, Loader2, AlertTriangle, ArrowRight } from "lucide-react";

interface EpicSummary {
  id: string;
  title: string;
  status: string;
}

interface DependencyEditorProps {
  projectId: string;
  epicId: string;
  /** All epics in the project (for the dropdown) */
  projectEpics: EpicSummary[];
}

export function DependencyEditor({
  projectId,
  epicId,
  projectEpics,
}: DependencyEditorProps) {
  const {
    predecessors,
    successors,
    loading,
    saving,
    error,
    saveDependencies,
    clearError,
  } = useEpicDependencies(projectId, epicId);

  const [selectedPredecessorIds, setSelectedPredecessorIds] = useState<
    string[]
  >([]);
  const [addingId, setAddingId] = useState<string>("");

  // Sync local state from fetched predecessors
  useEffect(() => {
    setSelectedPredecessorIds(predecessors.map((p) => p.dependsOnTicketId));
  }, [predecessors]);

  // Epics available as predecessors (same project, not self, not already selected)
  const availableEpics = useMemo(() => {
    const selectedSet = new Set(selectedPredecessorIds);
    return projectEpics.filter(
      (e) => e.id !== epicId && !selectedSet.has(e.id)
    );
  }, [projectEpics, epicId, selectedPredecessorIds]);

  const epicLookup = useMemo(() => {
    const map = new Map<string, EpicSummary>();
    for (const e of projectEpics) {
      map.set(e.id, e);
    }
    return map;
  }, [projectEpics]);

  function handleAdd() {
    if (!addingId) return;
    const newIds = [...selectedPredecessorIds, addingId];
    setSelectedPredecessorIds(newIds);
    setAddingId("");
    clearError();
    saveDependencies(newIds);
  }

  function handleRemove(depId: string) {
    const newIds = selectedPredecessorIds.filter((id) => id !== depId);
    setSelectedPredecessorIds(newIds);
    clearError();
    saveDependencies(newIds);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading dependencies...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Dependencies</h4>

      {/* Predecessors (depends on) */}
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Depends on ({selectedPredecessorIds.length})
        </p>
        {selectedPredecessorIds.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No predecessors — this epic can start independently.
          </p>
        )}
        {selectedPredecessorIds.map((depId) => {
          const depEpic = epicLookup.get(depId);
          return (
            <div
              key={depId}
              className="flex items-center gap-2 p-1.5 rounded bg-muted/30 text-xs"
            >
              <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="flex-1 truncate">
                {depEpic?.title || depId}
              </span>
              <Badge variant="outline" className="text-[10px] shrink-0">
                {depEpic?.status || "unknown"}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={() => handleRemove(depId)}
                disabled={saving}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* Add predecessor */}
      {availableEpics.length > 0 && (
        <div className="flex gap-2">
          <Select value={addingId} onValueChange={setAddingId}>
            <SelectTrigger className="h-7 text-xs flex-1">
              <SelectValue placeholder="Add predecessor..." />
            </SelectTrigger>
            <SelectContent>
              {availableEpics.map((e) => (
                <SelectItem key={e.id} value={e.id} className="text-xs">
                  {e.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={!addingId || saving}
            className="h-7 text-xs"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </Button>
        </div>
      )}

      {/* Error display with cycle context */}
      {error && (
        <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 text-destructive text-xs">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Successors (depended on by) — read-only info */}
      {successors.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Depended on by ({successors.length})
          </p>
          {successors.map((s) => {
            const succEpic = epicLookup.get(s.ticketId);
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 p-1.5 rounded bg-muted/20 text-xs"
              >
                <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 rotate-180" />
                <span className="flex-1 truncate">
                  {succEpic?.title || s.ticketId}
                </span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {succEpic?.status || "unknown"}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
