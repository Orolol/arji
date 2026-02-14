"use client";

import { useState, useEffect, useCallback } from "react";

export interface NamedAgentOption {
  id: string;
  name: string;
  provider: string;
  model: string;
}

export function useNamedAgentsList() {
  const [agents, setAgents] = useState<NamedAgentOption[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-config/named-agents");
      const json = await res.json();
      setAgents(json.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { agents, loading, refresh: load };
}
