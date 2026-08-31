"use client";

import { useCallback, useEffect, useState } from "react";
import { resolvePipelineEnabledDefault } from "@/lib/pipeline/constants";

/** Where the settings read stands for the currently open dialog. */
type SettingsLoad = "pending" | "resolved" | "failed";

interface DispatchDefaultState {
  value: boolean;
  load: SettingsLoad;
  /** The user moved the checkbox — their choice outranks any later read. */
  touched: boolean;
}

export interface PipelineDispatchDefault {
  /** Checkbox state to render. */
  pipeline: boolean;
  /**
   * User toggle. Marks the choice explicit, so a settings response that
   * lands afterwards can no longer overwrite it.
   */
  setPipeline: (value: boolean) => void;
  /**
   * The settings read is still in flight and the user has not chosen: the
   * dialog must not dispatch yet, or it would send a default the server is
   * about to contradict.
   */
  pending: boolean;
  /**
   * The settings read failed and the user has not chosen. The checkbox shows
   * the product default, but the request omits the flag so the build route
   * stays authoritative — see {@link PipelineDispatchDefault.requestValue}.
   */
  unresolved: boolean;
  /**
   * What to put in the build request's `pipeline` field. `undefined` means
   * "omit it": we have no trustworthy answer and no user choice, so the
   * route resolves the `pipeline_enabled` chain itself.
   */
  requestValue: boolean | undefined;
}

/**
 * The "run full pipeline" mode for an immediate build dispatch. The full
 * pipeline is the default build mode, so the checkbox starts ON — but that
 * optimistic value is never sent as an explicit flag on its own: until
 * `GET /api/settings` answers, dispatch is gated (`pending`), and if it
 * never answers usefully the flag is omitted (`unresolved`) rather than
 * overriding a project or global `pipeline_enabled: false`.
 *
 * A user who moves the checkbox owns the value from then on: the read only
 * lifts the gate, it never rewrites a deliberate choice. Re-read (and reset
 * that ownership) every time `open` flips true, so a settings change is
 * picked up without a reload.
 */
export function usePipelineDispatchDefault(
  projectId: string,
  open: boolean
): PipelineDispatchDefault {
  const [state, setState] = useState<DispatchDefaultState>({
    value: true,
    load: "pending",
    touched: false,
  });

  // Re-opening restarts the read. React's documented "adjust state during
  // render" reset — no effect, so no render ever shows the previous open's
  // resolution as if it applied to this one.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setState((prev) => ({ ...prev, load: "pending", touched: false }));
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setState((prev) => ({ ...prev, load: "failed" }));
    };
    try {
      fetch("/api/settings")
        .then((res) => {
          if (!res.ok) throw new Error(`settings read failed (${res.status})`);
          return res.json();
        })
        .then((json) => {
          if (cancelled) return;
          const resolved = resolvePipelineEnabledDefault(
            json?.data as Record<string, unknown> | undefined,
            projectId
          );
          setState((prev) => ({
            value: prev.touched ? prev.value : resolved,
            load: "resolved",
            touched: prev.touched,
          }));
        })
        .catch(fail);
    } catch {
      // No fetch at all (some test environments): same as a failed read.
      fail();
    }
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const setPipeline = useCallback((value: boolean) => {
    setState((prev) => ({ ...prev, value, touched: true }));
  }, []);

  const decided = state.touched || state.load === "resolved";
  return {
    pipeline: state.value,
    setPipeline,
    pending: state.load === "pending" && !state.touched,
    unresolved: state.load === "failed" && !state.touched,
    requestValue: decided ? state.value : undefined,
  };
}
