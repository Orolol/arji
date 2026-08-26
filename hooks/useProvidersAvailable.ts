"use client";

import { useEffect, useState } from "react";
import type { AgentProvider } from "@/lib/agent-config/constants";

export interface ProvidersAvailability {
  /** Per-provider availability map, one entry per PROVIDER_OPTIONS value. */
  providers: Record<AgentProvider, boolean>;
  loading: boolean;
}

const DEFAULT_PROVIDERS: Record<AgentProvider, boolean> = {
  "claude-code": false,
  codex: false,
  "oh-my-pi": false,
  agy: false,
};

/**
 * Checks availability of all CLI providers.
 */
export function useProvidersAvailable(): ProvidersAvailability {
  const [providers, setProviders] = useState<Record<AgentProvider, boolean>>({
    ...DEFAULT_PROVIDERS,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/providers/available")
      .then((r) => r.json())
      .then((d) => {
        const data = d.data ?? {};
        setProviders({
          "claude-code": !!data["claude-code"],
          codex: !!data.codex,
          "oh-my-pi": !!data["oh-my-pi"],
          agy: !!data.agy,
        });
      })
      .catch(() => {
        setProviders({ ...DEFAULT_PROVIDERS });
      })
      .finally(() => setLoading(false));
  }, []);

  return { providers, loading };
}
