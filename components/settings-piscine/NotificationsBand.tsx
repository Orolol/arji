"use client";

import { BandHeader, CheckMark, Mono, QuietLink, StrataBand } from "@/components/piscine";

import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";

/**
 * NOTIFICATIONS — the linden half of frame 11c's split row.
 *
 * The frame draws four event rows with a `push / email / off` channel column.
 * Arij has neither push nor email: the only notification channel is a
 * per-project webhook URL (`webhook_url:<projectId>`, posted on session end
 * and on a published release). The frame's row grammar survives; what fills it
 * is what exists.
 *
 * READ-ONLY HERE. Editing lives on Intégrations, where the existing
 * `webhooks-settings` test id and its per-row Save already are — two editors
 * of one value on one screen is how a value gets lost.
 *
 * EMPTY COLLAPSES TO THE LABEL LINE. No projects → header plus one mono line.
 * A failed read → header plus the truthful footnote, never a fabricated "no
 * projects" state.
 */
export interface NotificationWebhook {
  projectId: string;
  projectName: string;
  /** "" when no webhook is configured. */
  url: string;
}

export interface NotificationsBandProps {
  webhooks: readonly NotificationWebhook[];
  /** `GET /api/settings/webhooks` failed — say nothing about projects. */
  failed?: boolean;
}

export function NotificationsBand({ webhooks, failed = false }: NotificationsBandProps) {
  return (
    <SettingsSection id="notifications" testId="notifications-settings" className="min-w-0">
      <StrataBand stratum="feed" gap={9} grow>
        <BandHeader
          stratum="feed"
          label="Notifications"
          right={
            <QuietLink href="/settings/integrations" tone="next" size={12}>
              tout configurer →
            </QuietLink>
          }
        />

        {failed ? null : webhooks.length === 0 ? (
          <Mono size={11} tone="feed-deep" as="div">
            aucun projet — crée un projet pour brancher une notification
          </Mono>
        ) : (
          webhooks.map((entry) => (
            <SettingRow
              key={entry.projectId}
              grow
              toggle={
                <CheckMark checked={entry.url !== ""} shape="disc" tone="live" />
              }
              label={entry.projectName}
              off={entry.url === ""}
              suffix={entry.url !== "" ? "webhook" : "off"}
              suffixTone="feed-deep"
            />
          ))
        )}

        <Mono size={10.5} tone="feed-deep" as="div">
          une session qui se termine et une release publiée sont postées au
          webhook du projet
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
