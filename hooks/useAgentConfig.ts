"use client";

import { useState, useEffect, useCallback } from "react";
import type { AgentType, AgentProvider } from "@/lib/agent-config/constants";

type PromptSource = "builtin" | "global" | "project";
type ProviderSource = "builtin" | "global" | "project";

export interface ResolvedAgentPrompt {
  agentType: AgentType;
  systemPrompt: string;
  source: PromptSource;
  scope: string;
}

export interface ResolvedAgentProvider {
  agentType: AgentType;
  provider: AgentProvider;
  source: ProviderSource;
  scope: string;
  namedAgentId: string | null;
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

export interface NamedAgent {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  createdAt: string | null;
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

export function useAgentProviders(
  scope: "global" | "project",
  projectId?: string
) {
  const [data, setData] = useState<ResolvedAgentProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = buildUrl("/agent-config/providers", scope, projectId);
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

  const updateProvider = useCallback(
    async (
      agentType: AgentType,
      provider: AgentProvider,
      namedAgentId?: string | null
    ) => {
      const url = buildUrl(
        `/agent-config/providers/${agentType}`,
        scope,
        projectId
      );
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          namedAgentId: namedAgentId || null,
        }),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [scope, projectId, load]
  );

  return { data, loading, refresh: load, updateProvider };
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

  const createAgent = useCallback(
    async (payload: { name: string; provider: AgentProvider; model: string }) => {
      const res = await fetch("/api/agent-config/named-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load]
  );

  const updateAgent = useCallback(
    async (
      agentId: string,
      payload: { name?: string; provider?: AgentProvider; model?: string }
    ) => {
      const res = await fetch(`/api/agent-config/named-agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load]
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      const res = await fetch(`/api/agent-config/named-agents/${agentId}`, {
        method: "DELETE",
      });
      if (res.ok) await load();
      return res.ok;
    },
    [load]
  );

  return { data, loading, refresh: load, createAgent, updateAgent, deleteAgent };
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
