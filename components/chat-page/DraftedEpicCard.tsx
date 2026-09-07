"use client";

import { useCallback, useState } from "react";
import { Hammer } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  CheckMark,
  IdentityChip,
  Mono,
  PillButton,
  Stamp,
} from "@/components/piscine";
import type { ProjectTone } from "@/lib/piscine/tokens";

import {
  acceptanceCriteriaCount,
  totalAcceptanceCriteria,
  type ParsedEpic,
} from "./message-epics";

/**
 * The drafted epic, IN THE THREAD, as an actionable card (frame 11a).
 *
 * This is what the frame promises and the shipped flow does not do: the epic
 * an assistant message wrote appears attached to that message and stays
 * actionable afterwards — Send to dev / Edit stories / Backlog, with no detour
 * through the board. The old surface was a single card at the FOOT of the flow
 * (`ChatWorkspaceHeader.ChatProposalCard`), which a second epic hid and which
 * could not be re-actioned from history.
 *
 * NOTES THAT BITE IF IGNORED:
 * - `Stamp tone="next"` is `bg-strata-next` on `text-strata-next-deep`, i.e.
 *   INVISIBLE on this card's pool ground. The `bg-card` override is mandatory —
 *   the frame's stamp is a white pill.
 * - `Stamp` is 10px and `CheckMark` is 18px where the frame draws 9.5 and 16.
 *   The primitives are frozen and win at ≤1-2px.
 * - Exactly ONE filled button in the row: `Send to dev`. `Backlog` is outline
 *   even though it mutates too.
 * - `pending` swaps the WORD, never the colour.
 * - A failed POST leaves every button live: a rejection must cost a retry, not
 *   a re-type.
 */
export type EpicCreateStatus = "todo" | "backlog";

export interface DraftedEpicCardProps {
  projectId: string;
  epic: ParsedEpic;
  /** Project identity colour for the id chip. Never state. */
  tone: ProjectTone;
  /** The real epic this card is bound to, once one exists. */
  epicId: string | null;
  /** Resolved `ARJ-143`. `null` renders an em-dash — never a fabricated id. */
  readableId: string | null;
  /** `created in To Do · #3`. `null` renders an em-dash. */
  placement: string | null;
  /** The composer's named agent, forwarded to the build dispatch. */
  namedAgentId: string | null;
  onCreated: (created: {
    epicId: string;
    readableId: string | null;
    status: EpicCreateStatus;
  }) => void;
  onOpenTicket: (epicId: string) => void;
  onToast: (tone: "success" | "error", message: string) => void;
}

type PendingAction = "dev" | "backlog" | "edit" | null;

export function DraftedEpicCard({
  projectId,
  epic,
  tone,
  epicId,
  readableId,
  placement,
  namedAgentId,
  onCreated,
  onOpenTicket,
  onToast,
}: DraftedEpicCardProps) {
  const t = useTranslations("Chat");
  const [pending, setPending] = useState<PendingAction>(null);

  const storyCount = epic.userStories.length;
  const acTotal = totalAcceptanceCriteria(epic);
  // Never "0 AC": a count we do not have is a phrase that does not appear.
  const meta =
    acTotal > 0
      ? t("epicCard.storiesWithAc", { count: storyCount, ac: acTotal })
      : t("epicCard.stories", { count: storyCount });

  /** Create the ticket. Returns its id, or null when the route refused. */
  const createEpic = useCallback(
    async (status: EpicCreateStatus): Promise<string | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/epics`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: epic.title,
            description: epic.description,
            status,
            type: "feature",
            userStories: epic.userStories,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error || !body.data?.id) {
          onToast("error", body.error || t("epicCard.createFailed"));
          return null;
        }
        onCreated({
          epicId: body.data.id as string,
          readableId:
            typeof body.data.readableId === "string" ? body.data.readableId : null,
          status,
        });
        return body.data.id as string;
      } catch {
        onToast("error", t("epicCard.createFailed"));
        return null;
      }
    },
    [projectId, epic, onCreated, onToast, t],
  );

  /** Create-then-dispatch, in that order: the builder's prompt must see it. */
  async function handleSendToDev() {
    setPending("dev");
    try {
      const id = epicId ?? (await createEpic("todo"));
      if (!id) return;
      const res = await fetch(`/api/projects/${projectId}/epics/${id}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(namedAgentId ? { namedAgentId } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        onToast("error", body.error || t("epicCard.buildNotStarted"));
        return;
      }
      onToast("success", t("epicCard.sentToDev"));
    } catch {
      onToast("error", t("epicCard.buildFailed"));
    } finally {
      setPending(null);
    }
  }

  async function handleBacklog() {
    setPending("backlog");
    try {
      const id = await createEpic("backlog");
      if (id) onToast("success", t("epicCard.createdInBacklog"));
    } finally {
      setPending(null);
    }
  }

  /** The 6a overlay already owns story editing; this only makes sure a ticket
   *  exists for it to open. */
  async function handleEditStories() {
    if (epicId) {
      onOpenTicket(epicId);
      return;
    }
    setPending("edit");
    try {
      const id = await createEpic("backlog");
      if (id) onOpenTicket(id);
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      data-testid="chat-epic-card"
      className="stratum-next flex w-[76%] flex-col gap-[9px] self-start rounded-[14px] bg-strata-next px-4 py-[14px]"
    >
      <div className="flex items-center gap-[9px]">
        <IdentityChip label={readableId ?? "—"} tone={tone} size="sm" />
        <Stamp tone="next" className="bg-card tracking-[.08em]">
          {epicId ? t("epicCard.stamp") : t("epicCard.stampDraft")}
        </Stamp>
        <Mono size={10} tone="next-mid" className="ml-auto">
          {meta}
        </Mono>
      </div>

      <span className="text-[14.5px] font-semibold text-foreground">
        {epic.title}
      </span>

      <div className="flex flex-col gap-[6px]">
        {epic.userStories.map((story, index) => {
          const acCount = acceptanceCriteriaCount(story.acceptanceCriteria);
          return (
            <div
              key={`${index}-${story.title}`}
              data-testid="chat-epic-story"
              className="flex items-center gap-[9px] rounded-[10px] bg-card px-[11px] py-2"
            >
              <CheckMark checked={false} shape="disc" />
              <span className="min-w-0 flex-1 text-[12.5px] text-foreground">
                {story.title}
              </span>
              {acCount > 0 ? (
                <Mono size={10} tone="muted" className="shrink-0">
                  {t("epicCard.acceptanceCriteria", { count: acCount })}
                </Mono>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-[2px]">
        <PillButton
          variant="filled"
          size="sm"
          icon={Hammer}
          pending={pending === "dev"}
          pendingLabel={t("epicCard.sendToDevPending")}
          onClick={() => void handleSendToDev()}
        >
          {t("epicCard.sendToDev")}
        </PillButton>
        <PillButton
          variant="outline"
          size="sm"
          pending={pending === "edit"}
          pendingLabel={t("epicCard.createPending")}
          onClick={() => void handleEditStories()}
        >
          {t("epicCard.editStories")}
        </PillButton>
        <PillButton
          variant="outline"
          size="sm"
          // Already a ticket: there is nothing left to send to the backlog.
          disabled={Boolean(epicId)}
          pending={pending === "backlog"}
          pendingLabel={t("epicCard.createPending")}
          onClick={() => void handleBacklog()}
        >
          {t("epicCard.backlog")}
        </PillButton>
        <Mono size={10} tone="next-mid" className="ml-auto">
          {placement ?? "—"}
        </Mono>
      </div>
    </div>
  );
}
