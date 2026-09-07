"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { BandHeader, Mono, PillButton, StrataBand } from "@/components/piscine";

import { SettingField, SettingInput } from "./SettingField";
import { SettingsSection } from "./SettingsSection";

/**
 * WEBHOOKS — the only notification channel Arij has: one URL per project, POSTed
 * when an agent session finishes and when a release is created.
 *
 * Its own route (`PUT /api/settings/webhooks`), its own per-row Save, its own
 * message — a webhook URL is a capability credential (a Slack or Discord
 * incoming webhook grants post access), which is why `GET /api/settings` masks
 * it to `{hasUrl}` and this band reads the dedicated endpoint instead.
 */
export interface WebhookRow {
  projectId: string;
  projectName: string;
  url: string;
}

export function WebhooksBand() {
  const t = useTranslations("Settings");
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/webhooks")
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        const list = payload?.data?.webhooks;
        if (Array.isArray(list)) setRows(list as WebhookRow[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function edit(projectId: string, url: string) {
    setRows((current) =>
      current.map((row) => (row.projectId === projectId ? { ...row, url } : row)),
    );
  }

  async function save(projectId: string) {
    const row = rows.find((entry) => entry.projectId === projectId);
    if (!row) return;

    setMessage(null);
    setError(null);
    setSavingId(projectId);
    try {
      const response = await fetch("/api/settings/webhooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, url: row.url.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? t("webhooks.saveFailed"));
        return;
      }
      setMessage(
        row.url.trim()
          ? t("webhooks.saved", { project: row.projectName })
          : t("webhooks.cleared", { project: row.projectName }),
      );
    } catch {
      setError(t("webhooks.saveOffline"));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <SettingsSection testId="webhooks-settings" heading={t("webhooks.heading")}>
      <StrataBand stratum="feed" gap={9}>
        <BandHeader
          stratum="feed"
          label={t("webhooks.label")}
          meta={
            <span className="font-sans text-[11.5px] leading-normal">
              {t("webhooks.meta")}
            </span>
          }
        />

        {rows.length === 0 ? (
          <Mono size={11} tone="feed-deep" as="div">
            {t("webhooks.empty")}
          </Mono>
        ) : (
          rows.map((row) => (
            <div key={row.projectId} className="flex flex-wrap items-end gap-[10px]">
              <SettingField
                kicker={row.projectName}
                stratum="feed"
                htmlFor={`webhook-${row.projectId}`}
                flex={1}
                className="min-w-[220px]"
              >
                <SettingInput
                  id={`webhook-${row.projectId}`}
                  chrome="ground"
                  type="url"
                  placeholder={t("webhooks.placeholder")}
                  value={row.url}
                  onChange={(event) => edit(row.projectId, event.target.value)}
                />
              </SettingField>
              <PillButton
                variant="outline"
                outlineTone="action"
                size="lg"
                onClick={() => void save(row.projectId)}
                pending={savingId === row.projectId}
                pendingLabel={t("webhooks.saving")}
              >
                {t("webhooks.save")}
              </PillButton>
            </div>
          ))
        )}

        <div role="status" aria-live="polite">
          {message ? (
            <Mono size={10.5} tone="feed-deep" as="div">
              {message}
            </Mono>
          ) : null}
        </div>
        <div role="alert">
          {error ? (
            <Mono size={10.5} tone="danger" as="div">
              {error}
            </Mono>
          ) : null}
        </div>
      </StrataBand>
    </SettingsSection>
  );
}
