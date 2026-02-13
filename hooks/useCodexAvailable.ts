"use client";

import { useEffect, useState } from "react";

/**
 * Checks if the Codex CLI is installed, authenticated, and ready to use.
 *
 * Returns:
 * - `codexAvailable`: true if installed AND logged in
 * - `codexInstalled`: true if installed (even if not logged in)
 * - `loading`: true while the check is in progress
 */
export function useCodexAvailable() {
  const { codexAvailable, codexInstalled, loading } = useProvidersAvailable();
  return { codexAvailable, codexInstalled, loading };
}

export interface ProvidersAvailability {
  codexAvailable: boolean;
  codexInstalled: boolean;
  geminiAvailable: boolean;
  geminiInstalled: boolean;
  loading: boolean;
}

/**
 * Checks availability of all external CLI providers (Codex, Gemini CLI).
 */
export function useProvidersAvailable(): ProvidersAvailability {
  const [state, setState] = useState<Omit<ProvidersAvailability, "loading">>({
    codexAvailable: false,
    codexInstalled: false,
    geminiAvailable: false,
    geminiInstalled: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/providers/available")
      .then((r) => r.json())
      .then((d) => {
        setState({
          codexAvailable: !!d.data?.codex,
          codexInstalled: !!d.data?.codexInstalled,
          geminiAvailable: !!d.data?.["gemini-cli"],
          geminiInstalled: !!d.data?.geminiInstalled,
        });
      })
      .catch(() => {
        setState({
          codexAvailable: false,
          codexInstalled: false,
          geminiAvailable: false,
          geminiInstalled: false,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  return { ...state, loading };
}
