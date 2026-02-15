"use client";

import { useState, useCallback, useRef } from "react";

interface BatchSelectionState {
  /** All selected ticket IDs (user-selected + auto-included) */
  allSelected: Set<string>;
  /** IDs explicitly selected by the user */
  userSelected: Set<string>;
  /** IDs auto-included as transitive prerequisites */
  autoIncluded: Set<string>;
  /** Ordered IDs selected by the user (oldest-first) */
  selectedTicketIds: string[];
}

function createEmptySelectionState(): BatchSelectionState {
  return {
    allSelected: new Set(),
    userSelected: new Set(),
    autoIncluded: new Set(),
    selectedTicketIds: [],
  };
}

function normalizeTicketIds(ticketIds: Iterable<string>) {
  return Array.from(new Set(ticketIds));
}

function sameSelection(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function useBatchSelection(projectId: string) {
  const [state, setState] = useState<BatchSelectionState>(createEmptySelectionState);
  const [loading, setLoading] = useState(false);
  const fetchController = useRef<AbortController | null>(null);

  const resolveTransitive = useCallback(
    async (ticketIds: string[]) => {
      const selectedTicketIds = normalizeTicketIds(ticketIds);

      if (selectedTicketIds.length === 0) {
        fetchController.current?.abort();
        setLoading(false);
        setState(createEmptySelectionState());
        return;
      }

      const userSelected = new Set(selectedTicketIds);

      // Cancel any in-flight request
      fetchController.current?.abort();
      const controller = new AbortController();
      fetchController.current = controller;

      setLoading(true);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/dependencies/transitive`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketIds: selectedTicketIds }),
            signal: controller.signal,
          }
        );

        if (!res.ok) {
          // Fallback: just use user selection
          setState((prev) => {
            if (!sameSelection(prev.selectedTicketIds, selectedTicketIds)) {
              return prev;
            }
            return {
              allSelected: new Set(userSelected),
              userSelected: new Set(userSelected),
              autoIncluded: new Set(),
              selectedTicketIds,
            };
          });
          return;
        }

        const json = await res.json();
        const all = new Set<string>(json.data?.all ?? selectedTicketIds);
        const auto = new Set<string>(json.data?.autoIncluded ?? []);

        setState((prev) => {
          if (!sameSelection(prev.selectedTicketIds, selectedTicketIds)) {
            return prev;
          }
          return {
            allSelected: all,
            userSelected: new Set(userSelected),
            autoIncluded: auto,
            selectedTicketIds,
          };
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        // Fallback: just use user selection
        setState((prev) => {
          if (!sameSelection(prev.selectedTicketIds, selectedTicketIds)) {
            return prev;
          }
          return {
            allSelected: new Set(userSelected),
            userSelected: new Set(userSelected),
            autoIncluded: new Set(),
            selectedTicketIds,
          };
        });
      } finally {
        if (fetchController.current === controller) {
          setLoading(false);
        }
      }
    },
    [projectId]
  );

  const setSelectedTicketIds = useCallback(
    (ticketIds: string[]) => {
      const normalizedIds = normalizeTicketIds(ticketIds);

      if (normalizedIds.length === 0) {
        fetchController.current?.abort();
        setLoading(false);
        setState(createEmptySelectionState());
        return;
      }

      const userSelected = new Set(normalizedIds);
      setState((prev) => ({
        ...prev,
        allSelected: new Set(userSelected),
        userSelected: new Set(userSelected),
        autoIncluded: new Set(),
        selectedTicketIds: normalizedIds,
      }));

      void resolveTransitive(normalizedIds);
    },
    [resolveTransitive]
  );

  const selectPrimary = useCallback(
    (epicId: string) => {
      setSelectedTicketIds([epicId]);
    },
    [setSelectedTicketIds]
  );

  const toggle = useCallback(
    (epicId: string) => {
      const nextTicketIds = state.selectedTicketIds.includes(epicId)
        ? state.selectedTicketIds.filter((id) => id !== epicId)
        : [...state.selectedTicketIds, epicId];

      setSelectedTicketIds(nextTicketIds);
    },
    [setSelectedTicketIds, state.selectedTicketIds]
  );

  const clear = useCallback(() => {
    fetchController.current?.abort();
    setLoading(false);
    setState(createEmptySelectionState());
  }, []);

  const isAutoIncluded = useCallback(
    (epicId: string) => state.autoIncluded.has(epicId),
    [state.autoIncluded]
  );

  const isUserSelected = useCallback(
    (epicId: string) => state.userSelected.has(epicId),
    [state.userSelected]
  );

  return {
    allSelected: state.allSelected,
    userSelected: state.userSelected,
    autoIncluded: state.autoIncluded,
    selectedTicketIds: state.selectedTicketIds,
    loading,
    selectPrimary,
    toggle,
    setSelectedTicketIds,
    clear,
    isAutoIncluded,
    isUserSelected,
  };
}
