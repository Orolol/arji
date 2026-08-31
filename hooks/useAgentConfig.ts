"use client";

import { useState, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
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

const EMPTY_LIST: never[] = [];

type KeyedList<T> = { key: string; data: T[] } | null;

/**
 * Fetch `url` and record the rows against it. setState only ever runs from a
 * promise callback, so this never updates state synchronously — safe to call
 * straight from an effect body.
 */
function fetchList<T>(
  url: string,
  setLoaded: Dispatch<SetStateAction<KeyedList<T>>>,
  isCancelled: () => boolean = () => false
) {
  return fetch(url)
    .then((res) => res.json())
    .then((json) => {
      if (!isCancelled()) setLoaded({ key: url, data: (json.data || []) as T[] });
    })
    .catch(() => {
      // Record the failure against *this* URL and nothing else. Carrying the
      // previous URL's rows across would re-label another scope's prompts,
      // assignments and review agents as this scope's own — and the editors
      // write back to whichever scope is selected now, so a stale row shown
      // under the new scope is edited into the new scope.
      if (!isCancelled()) setLoaded({ key: url, data: EMPTY_LIST });
    });
}

/**
 * A GET-backed list keyed by its URL.
 *
 * `data` and `loading` both derive from whether the settled result belongs to
 * the URL being asked for *now*. That replaces the `setLoading(true)` these
 * hooks used to run synchronously at the top of their mount effect, and it also
 * stops the previous scope's rows from being shown while the new scope's
 * request is still in flight.
 */
function useKeyedList<T>(url: string) {
  const [loaded, setLoaded] = useState<KeyedList<T>>(null);

  const data: T[] = loaded?.key === url ? loaded.data : EMPTY_LIST;
  const loading = loaded?.key !== url;

  const refresh = useCallback(() => fetchList<T>(url, setLoaded), [url]);

  useEffect(() => {
    let cancelled = false;
    void fetchList<T>(url, setLoaded, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading, refresh };
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
  const url = buildUrl("/agent-config/prompts", scope, projectId);
  const { data, loading, refresh: load } = useKeyedList<ResolvedAgentPrompt>(url);

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
  const url = buildUrl("/agent-config/providers", scope, projectId);
  const { data, loading, refresh: load } = useKeyedList<ResolvedAgentAssignment>(url);

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
  const url = buildUrl("/agent-config/review-agents", scope, projectId);
  const { data, loading, refresh: load } = useKeyedList<CustomReviewAgent>(url);

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
  const { data, loading, refresh: load } = useKeyedList<NamedAgent>(
    "/api/agent-config/named-agents"
  );

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
