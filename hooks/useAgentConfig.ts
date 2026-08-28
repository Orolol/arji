"use client";

import { useState, useEffect, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";
import type { AgentType, AgentProvider } from "@/lib/agent-config/constants";
import type { NamedAgentCliOptions } from "@/lib/providers/options-registry";

type PromptSource = "builtin" | "global" | "project";
type AssignmentSource = "builtin" | "global" | "project";

export interface ResolvedAgentPrompt {
  agentType: AgentType;
  systemPrompt: string;
  source: PromptSource;
  scope: string;
}

export interface ResolvedAgentAssignment {
  agentType: AgentType;
  provider: AgentProvider;
  namedAgentId: string | null;
  source: AssignmentSource;
  scope: string;
  namedAgent?: {
    id: string;
    name: string;
    provider: AgentProvider;
    model: string;
  } | null;
}


export interface CustomReviewAgent {
  id: string;
  name: string;
  systemPrompt: string;
  scope: string;
  position: number;
  isEnabled: number;
  createdAt: string | null;
  updatedAt: string | null;
  source?: "global" | "project";
}

function buildUrl(
  basePath: string,
  scope: "global" | "project",
  projectId?: string
): string {
  if (scope === "project" && projectId) {
    return `/api/projects/${projectId}${basePath}`;
  }
  return `/api${basePath}`;
}

export function useAgentPrompts(
  scope: "global" | "project",
  projectId?: string
) {
  const [data, setData] = useState<ResolvedAgentPrompt[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildUrl("/agent-config/prompts", scope, projectId);
      const res = await fetch(url);
      const json = await res.json();
      setData(json.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [scope, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const updatePrompt = useCallback(
    async (agentType: AgentType, systemPrompt: string) => {
      const url = buildUrl(
        `/agent-config/prompts/${agentType}`,
        scope,
        projectId
      );
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt }),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [scope, projectId, load]
  );

  const resetPrompt = useCallback(
    async (agentType: AgentType) => {
      if (scope !== "project" || !projectId) return false;
      const url = `/api/projects/${projectId}/agent-config/prompts/${agentType}`;
      const res = await fetch(url, { method: "DELETE" });
      if (res.ok) await load();
      return res.ok;
    },
    [scope, projectId, load]
  );

  return { data, loading, refresh: load, updatePrompt, resetPrompt };
}

export function useAgentAssignments(
  scope: "global" | "project",
  projectId?: string
) {
  const [data, setData] = useState<ResolvedAgentAssignment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildUrl("/agent-config/providers", scope, projectId);
      const res = await fetch(url);
      const json = await res.json();
      setData(json.data || []);
    } catch {
      setData([]);
    }
    setLoading(false);
  }, [scope, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const assignAgent = useCallback(
    async (agentType: AgentType, namedAgentId: string | null) => {
      const url = buildUrl(
        `/agent-config/providers/${agentType}`,
        scope,
        projectId
      );
      const res = await fetch(url, {
        method: namedAgentId ? "PUT" : "DELETE",
        headers: namedAgentId
          ? { "Content-Type": "application/json" }
          : undefined,
        body: namedAgentId ? JSON.stringify({ namedAgentId }) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) await load();
      return {
        ok: res.ok,
        error:
          typeof json.error === "string"
            ? json.error
            : res.ok
              ? undefined
              : "Could not update this assignment.",
      };
    },
    [scope, projectId, load]
  );

  return { data, loading, refresh: load, assignAgent };
}

export function useReviewAgents(
  scope: "global" | "project",
  projectId?: string
) {
  const [data, setData] = useState<CustomReviewAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildUrl("/agent-config/review-agents", scope, projectId);
      const res = await fetch(url);
      const json = await res.json();
      setData(json.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [scope, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const createAgent = useCallback(
    async (name: string, systemPrompt: string) => {
      const url = buildUrl("/agent-config/review-agents", scope, projectId);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, systemPrompt }),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [scope, projectId, load]
  );

  const updateAgent = useCallback(
    async (
      agentId: string,
      updates: { name?: string; systemPrompt?: string; isEnabled?: boolean }
    ) => {
      const res = await fetch(`/api/agent-config/review-agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load]
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      const res = await fetch(`/api/agent-config/review-agents/${agentId}`, {
        method: "DELETE",
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load]
  );

  return { data, loading, refresh: load, createAgent, updateAgent, deleteAgent };
}

// ---------------------------------------------------------------------------
// Named Agents
// ---------------------------------------------------------------------------

export interface NamedAgent {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  /** Non-default per-CLI options only; `{}` means "all CLI defaults". */
  options: NamedAgentCliOptions;
  /** Persona injected at the head of the prompt; null injects nothing. */
  personaPrompt: string | null;
  escalatesTo: string | null;
  createdAt: string | null;
}

export function useNamedAgents() {
  const [data, setData] = useState<NamedAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent-config/named-agents");
      const json = await res.json();
      setData(json.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createNamedAgent = useCallback(
    async (input: {
      name: string;
      provider: AgentProvider;
      model?: string;
      options?: NamedAgentCliOptions;
      personaPrompt?: string | null;
      escalatesTo?: string | null;
    }) => {
      const res = await fetch("/api/agent-config/named-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.ok) await load();
      const json = await res.json();
      return { ok: res.ok, error: json.error };
    },
    [load],
  );

  const updateNamedAgent = useCallback(
    async (
      id: string,
      updates: {
        name?: string;
        provider?: AgentProvider;
        model?: string;
        options?: NamedAgentCliOptions;
        personaPrompt?: string | null;
        escalatesTo?: string | null;
      },
    ) => {
      const res = await fetch(`/api/agent-config/named-agents/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) await load();
      const json = await res.json();
      return { ok: res.ok, error: json.error };
    },
    [load],
  );

  const deleteNamedAgent = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/agent-config/named-agents/${id}`, {
        method: "DELETE",
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load],
  );

  return {
    data,
    loading,
    refresh: load,
    createNamedAgent,
    updateNamedAgent,
    deleteNamedAgent,
  };
}

// ---------------------------------------------------------------------------
// Named-agent statistics (the /agents workshop)
// ---------------------------------------------------------------------------

/** Today's figures on a roster card. Mirrors lib/agent-config/agent-stats.ts. */
export interface AgentDayStats {
  namedAgentId: string;
  runsToday: number;
  /** completed / (completed + failed) today; null when nothing is terminal. */
  cleanRate: number | null;
  /** null when no session reported a cost — the card then shows an em-dash. */
  costTodayUsd: number | null;
  liveSessions: number;
}

/**
 * Today's numbers for EVERY named agent, from one request.
 *
 * The roster renders a card per agent; fetching per card would be an N+1 over
 * the largest table in the database. The route answers every agent in a single
 * query, keyed here by agent id for O(1) lookup at render time.
 *
 * Polled at 10s (the dashboard cadence) so the live dots and today's counters
 * move without a reload. Do not poll faster: this is a five-column aggregate
 * over the whole session table.
 */
export function useAgentRosterStats(): {
  data: Record<string, AgentDayStats>;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<Record<string, AgentDayStats>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-config/named-agents/all/stats");
      const json = await res.json();
      const rows: AgentDayStats[] = json?.data?.agents ?? [];
      const next: Record<string, AgentDayStats> = {};
      for (const row of rows) next[row.namedAgentId] = row;
      setData(next);
    } catch {
      // A missing aggregate collapses the card figures to em-dashes; it must
      // never take the roster down with it.
    }
    setLoading(false);
  }, []);

  usePolling(load, 10_000);

  return { data, loading, refresh: load };
}

/** One calendar day of the 14-day sparkline. */
export interface AgentDaySeriesPoint {
  date: string;
  runs: number;
  failed: number;
}

/** The 14-day payload behind THE NUMBERS. */
export interface NamedAgentStats {
  windowDays: number;
  runCount: number;
  completedCount: number;
  failedCount: number;
  cleanRate: number | null;
  medianDurationMs: number | null;
  totalCostUsd: number | null;
  escalationCount: number | null;
  /** Exactly `windowDays` entries, oldest first. */
  days: AgentDaySeriesPoint[];
  byRole: { role: string; runs: number }[];
}

/**
 * The selected agent's 14-day aggregate.
 *
 * CANCELLED-FETCH DISCIPLINE: this re-fetches on every roster click. Without
 * the `cancelled` flag, clicking three agents quickly paints whichever
 * response happens to land last — which is the slowest one, not the one the
 * user is looking at.
 */
export function useNamedAgentStats(agentId: string | null): {
  data: NamedAgentStats | null;
  loading: boolean;
} {
  // The payload is STAMPED with the agent it describes, and read back only
  // when the stamp still matches. That serves two purposes at once: the
  // previous agent's numbers never flash under the newly selected name, and
  // `loading` is a derivation rather than a setState the effect has to make
  // synchronously on every change of selection.
  const [entry, setEntry] = useState<{
    agentId: string;
    data: NamedAgentStats | null;
  } | null>(null);

  useEffect(() => {
    if (!agentId) return;

    let cancelled = false;
    fetch(`/api/agent-config/named-agents/${agentId}/stats`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setEntry({ agentId, data: json?.data ?? null });
      })
      .catch(() => {
        if (cancelled) return;
        setEntry({ agentId, data: null });
      });

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const fresh = agentId !== null && entry?.agentId === agentId;
  return { data: fresh ? entry.data : null, loading: agentId !== null && !fresh };
}
