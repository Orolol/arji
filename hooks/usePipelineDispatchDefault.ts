"use client";

import { useEffect, useState } from "react";
import { resolvePipelineEnabledDefault } from "@/lib/pipeline/constants";

/**
 * The "run full pipeline" default for an immediate build dispatch. The full
 * pipeline is the default build mode, so the state starts ON and a missing,
 * invalid, or failing settings read keeps it ON — exactly what the server
 * resolves for a build request that omits the `pipeline` flag
 * (`resolvePipelineEnabled`). Re-read every time `open` flips true so a
 * settings change is picked up without a reload.
 */
export function usePipelineDispatchDefault(
  projectId: string,
  open: boolean
): [boolean, (value: boolean) => void] {
  const [pipeline, setPipeline] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    try {
      fetch("/api/settings")
        .then((r) => r.json())
        .then((json) => {
          if (cancelled) return;
          setPipeline(
            resolvePipelineEnabledDefault(
              json?.data as Record<string, unknown> | undefined,
              projectId
            )
          );
        })
        .catch(() => {
          // best-effort — the checkbox simply stays on
        });
    } catch {
      // ignore (no fetch in some test environments)
    }
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  return [pipeline, setPipeline];
}
