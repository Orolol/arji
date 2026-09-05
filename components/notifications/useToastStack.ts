"use client";

import { useCallback, useState } from "react";

import { AGENT_ALREADY_RUNNING_CODE } from "@/lib/agents/concurrency-shared";

import {
  MAX_TOASTS,
  type RaiseToast,
  type ToastItem,
} from "./ToastStack";

/**
 * The state half of `ToastStack` — one per surface that raises notifications.
 *
 * Seven surfaces each owned a copy of this: an id scheme, a `setTimeout`
 * expiry, and (on two of them) a ceiling. Expiry now belongs to the stack,
 * which pauses it on hover and on keyboard focus and never expires an error at
 * all, so the only thing left here is the list and its cap.
 *
 * HOST SINK. Pass `onToast` and nothing is stored: the raise is forwarded to
 * the host, which owns the one stack for the route. `/projects/:id` renders
 * both the desk and its own dialogs, and two stacks would overlap in the same
 * corner.
 */
export interface ToastStackController {
  toasts: readonly ToastItem[];
  raise: RaiseToast;
  dismiss: (id: string) => void;
}

export function useToastStack(onToast?: RaiseToast): ToastStackController {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const raise = useCallback<RaiseToast>(
    (tone, message, action) => {
      if (onToast) {
        onToast(tone, message, action);
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [
        // The stack renders the newest MAX_TOASTS; dropping the rest here as
        // well keeps a chatty surface from growing an unbounded array behind
        // a bounded view.
        ...current.slice(-(MAX_TOASTS - 1)),
        { id, type: tone, message, href: action?.href, actionLabel: action?.label },
      ]);
    },
    [onToast],
  );

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, raise, dismiss };
}

/** The 409 payload shape, from `lib/agents/client-error.ts`. */
export interface DispatchErrorBody {
  error?: string;
  code?: string;
  data?: { activeSessionId?: string; sessionUrl?: string };
}

export type ReportDispatchFailure = (
  res: Response,
  body: DispatchErrorBody,
  fallback: string,
  ownerProjectId: string,
) => void;

/**
 * Turns a failed dispatch response into a toast.
 *
 * 409 AGENT_ALREADY_RUNNING is not an error the user can do anything with
 * unless the toast can take them to the session that is in the way — so that
 * one case, and only that one, carries a deep link.
 */
export function useDispatchFailureReporter(raise: RaiseToast): ReportDispatchFailure {
  return useCallback<ReportDispatchFailure>(
    (res, body, fallback, ownerProjectId) => {
      if (
        res.status === 409 &&
        body.code === AGENT_ALREADY_RUNNING_CODE &&
        body.data?.activeSessionId
      ) {
        raise("error", body.error ?? fallback, {
          href:
            body.data.sessionUrl ||
            `/projects/${ownerProjectId}/sessions/${body.data.activeSessionId}`,
          label: "Open active session",
        });
        return;
      }
      raise("error", body.error || fallback);
    },
    [raise],
  );
}
