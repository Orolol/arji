"use client";

import { useEffect, useState } from "react";

import {
  BudgetBand,
  FullAutoBand,
  NightRunsBand,
  NotificationsBand,
  SettingsFooter,
  WorkspaceBand,
  useSettingsDraft,
  type NotificationWebhook,
} from "@/components/settings-piscine";
import type { UsageMonthlyCap } from "@/lib/types/usage";

/**
 * Paramètres → Workspace — frame 11c.
 *
 * One stratum per subject, in the frame's order: WORKSPACE (white) → FULL AUTO
 * (turquoise, it is what makes the WORKING stratum live) → NIGHT RUNS (pool
 * blue, it consumes UP NEXT) → NOTIFICATIONS (linden) | BUDGET (sun) → one
 * Discard / Save footer.
 *
 * This replaces 1862 lines that held ~58 `useState` in one component and gave
 * every control its own save button and its own status paragraph. The values
 * now live in one draft map (`useSettingsDraft`) and leave in ONE
 * `PATCH /api/settings`, which validates every key before writing any.
 *
 * READS, and what each costs:
 * - `GET /api/settings` — a scan of a small key/value table. Once, on mount.
 * - `GET /api/settings/webhooks` — projects + their webhook rows. Once.
 * - `GET /api/projects` — only for the Full Auto blast-radius count. Once.
 * - `GET /api/usage` — LAZY, after mount, never with `?fresh`: that route
 *   re-scans codex rollouts on every read, and better-sqlite3 is synchronous
 *   on one shared connection, so putting it in first paint would stall SSE for
 *   the whole app. The Budget band simply never grows a bar if it is slow.
 * Nothing here polls: settings do not change under the user's feet.
 */
export default function SettingsPage() {
  const draft = useSettingsDraft();

  const [webhooks, setWebhooks] = useState<NotificationWebhook[]>([]);
  const [webhooksFailed, setWebhooksFailed] = useState(false);
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [cap, setCap] = useState<UsageMonthlyCap | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/settings/webhooks")
      .then(async (response) => {
        if (!response.ok) throw new Error("webhooks read failed");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const list = payload?.data?.webhooks;
        if (Array.isArray(list)) {
          setWebhooks(list as NotificationWebhook[]);
        } else {
          // A shape we cannot read is not "no projects".
          setWebhooksFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setWebhooksFailed(true);
      });

    fetch("/api/projects")
      .then(async (response) => {
        if (!response.ok) throw new Error("projects read failed");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const list = payload?.data;
        // null, never 0: an unknown count must read as an em-dash.
        if (Array.isArray(list)) setProjectCount(list.length);
      })
      .catch(() => {});

    // Lazy and last. No `?fresh`.
    fetch("/api/usage")
      .then(async (response) => {
        if (!response.ok) throw new Error("usage read failed");
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const next = payload?.data?.dashboard?.cap;
        if (next && typeof next === "object") setCap(next as UsageMonthlyCap);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-[10px]">
      <WorkspaceBand draft={draft} />
      <FullAutoBand draft={draft} projectCount={projectCount} />
      <NightRunsBand draft={draft} />

      <div className="grid shrink-0 grid-cols-1 gap-[12px] lg:grid-cols-2">
        <NotificationsBand webhooks={webhooks} failed={webhooksFailed} />
        <BudgetBand draft={draft} cap={cap} />
      </div>

      <SettingsFooter
        dirty={draft.dirty}
        saving={draft.saving}
        onSave={() => void draft.save()}
        onDiscard={draft.discard}
        message={draft.message}
        messageTone={draft.messageTone}
        disabled={draft.loadFailed}
      />
    </div>
  );
}
