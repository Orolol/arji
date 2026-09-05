"use client";

import * as React from "react";
import { ImagePlus, Sparkles } from "lucide-react";

import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { PillButton, SelectPill, StrataBand, projectTone } from "@/components/piscine";
import { ImageAttachmentStrip } from "@/components/shared/ImageAttachmentStrip";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import {
  OPENAI_COMPATIBLE_PROVIDER,
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  type AgentProvider,
  type ChatModeProvider,
} from "@/lib/agent-config/constants";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

export const CHAT_COMPOSER_PLACEHOLDER =
  "Écris — ⏎ envoie, ⇧⏎ saute une ligne, @ cite un doc";

/**
 * The largest share an agent pill may take — of two different rows.
 *
 * WRAPPED, the pill shares its row with the attach button and the project
 * pill and nothing else, so 45% of the band is affordable and is what a phone
 * has always rendered. ONE ROW, it shares with the FIELD, and 30% of the
 * composer is the share the 36rem wrap threshold below is computed from.
 *
 * Measured: giving the wrapped row the tighter cap truncated "Claude Code" —
 * an ordinary provider label, not a long one — from 116px to 109px at 390.
 * The single-row cap is in `cqw` rather than `%` because a percentage
 * resolves against the band's content box while the threshold that justifies
 * it is expressed on the container; keeping both on the container is what
 * makes the arithmetic below checkable.
 *
 * Literal classes rather than numbers: Tailwind cannot see a computed one.
 */
const AGENT_PILL_MAX = "max-w-[45%] @min-[36rem]:max-w-[30cqw]";

/**
 * The linden composer band (frame 11a).
 *
 * ⏎ SENDS, ⇧⏎ IS A NEWLINE — the OPPOSITE of `DeskComposer`'s contract, and
 * exactly what the frame's own placeholder promises. The IME guard is the same
 * one `DeskComposer` carries: without it an Enter that only closes a candidate
 * window sends half a word.
 *
 * The ground comes from `StrataBand stratum="feed"`, never a hand-rolled
 * linden: the band also carries the `.stratum-feed` figure-colour scope, and a
 * re-implementation drifts the first time the band changes. `flex-row` and
 * `py-0` are the two overrides a single-row bar legitimately makes.
 *
 * THE ATTACH PILL IS NOT IN THE FRAME, and is here on purpose: it is one of
 * the three attachment entry points (picker, clipboard paste, the hidden file
 * input), and dropping it would delete `openFilePicker` outright. Outline /
 * neutral, so the row's filled-button budget stays at zero.
 *
 * NO DRAG-AND-DROP: `useImageAttachments` exposes drop handlers and this screen
 * deliberately does not wire them (house rule).
 */
export interface ChatAgentChoice {
  namedAgentId: string | null;
  provider: ChatModeProvider;
}

export interface ChatComposerProps {
  projectId: string | null;
  projects: readonly DeskProject[];
  project: DeskProject | null;
  onSelectProject: (projectId: string) => void;
  /** Label for the agent pill — a named agent, or the provider's label. */
  agentLabel: string;
  onSelectAgent: (choice: ChatAgentChoice) => void;
  /** The picker is locked once the conversation has a message. */
  agentLocked: boolean;
  /** The active provider cannot take images (OpenAI-compatible fast mode). */
  attachmentsDisabled?: boolean;
  disabled?: boolean;
  onSend: (content: string, attachmentIds: string[]) => void;
}

export function ChatComposer({
  projectId,
  projects,
  project,
  onSelectProject,
  agentLabel,
  onSelectAgent,
  agentLocked,
  attachmentsDisabled = false,
  disabled = false,
  onSend,
}: ChatComposerProps) {
  const [value, setValue] = React.useState("");
  const composingRef = React.useRef(false);
  const { agents } = useNamedAgentsList();
  const safeAgents = Array.isArray(agents) ? agents : [];

  const {
    attachments,
    uploading,
    fileInputProps,
    openFilePicker,
    handlePaste,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useImageAttachments({
    projectId: projectId ?? "",
    disabled: attachmentsDisabled,
  });

  const effectiveAttachments = attachmentsDisabled ? [] : attachments;

  function handleSubmit() {
    const trimmed = value.trim();
    if (
      (!trimmed && effectiveAttachments.length === 0) ||
      disabled ||
      uploading
    ) {
      return;
    }
    onSend(
      trimmed,
      effectiveAttachments.map((attachment) => attachment.id),
    );
    setValue("");
    if (!attachmentsDisabled) {
      // clear(), not discardAll(): the uploads are now owned by the message
      // that was sent, so the files stay on disk.
      clearAttachments();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Enter") return;
    // Shift+Enter is a newline — let the textarea have it.
    if (event.shiftKey) return;
    // Never swallow Enter while an IME candidate window is open.
    if (composingRef.current || event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSubmit();
  }

  return (
    /*
      `@container`: the band's row is decided by the COMPOSER's width, not by
      the window's (B-arij-180, round 2). The two are not the same number —
      the chat page puts the thread between two 300px flanks from `lg`, so the
      band is 372px wide at a 1024px window and 740px wide at a 768px one. A
      viewport breakpoint gets that backwards, and did: the widest layout in
      the app held the narrowest composer, with 89px of field measured at 1024.
    */
    <div data-testid="chat-composer" className="@container flex shrink-0 flex-col">
      {/* Self-hides when empty and nothing is uploading. */}
      <ImageAttachmentStrip
        attachments={effectiveAttachments}
        onRemove={removeAttachment}
        uploading={uploading}
        className="px-[18px] pb-1"
      />

      {/*
        ONE ROW FROM 36rem OF BAND, TWO BELOW IT (B-arij-180). The row is a
        16px glyph, a text field and three fixed controls: at 390px the
        controls' own min-content took all of it and the field was measured at
        24px — on screen, uncovered, and useless. Wrapping gives the field its
        own row and drops the controls underneath.

        36rem is arithmetic, not taste. A single row spends 96px on the glyph,
        the four gaps and the attach button, up to 100px on the project pill
        (`shortProjectName` caps its label at 8 characters) and up to
        `AGENT_PILL_MAX` of the band on the agent pill, which leaves the field
        `0.7 x band - 232`. That crosses the 160px the e2e calls a usable field
        at 560px of band, and 36rem is the first round number above it. A
        628px desktop band stays one row, so the 1280 and 1440 frames are
        untouched; a 372px band at 1024 now wraps instead of pretending.
      */}
      <StrataBand
        stratum="feed"
        gap={13}
        className={cn(
          "min-h-[58px] shrink-0 flex-row flex-wrap items-center px-[18px] py-[9px]",
          "@min-[36rem]:flex-nowrap @min-[36rem]:py-0",
        )}
      >
        <Sparkles
          size={16}
          aria-hidden="true"
          className="shrink-0 text-strata-feed-deep"
        />

        {/*
          THE FLEX ITEM IS THIS DIV, not the textarea. `MentionTextarea` owns
          its own `relative flex-1 min-w-0 w-full` wrapper (the mention popover
          anchors on it), so a basis set through `className` lands one level
          too deep and never reaches the row.
        */}
        <div className="flex min-w-0 grow shrink basis-[calc(100%-29px)] @min-[36rem]:basis-0">
          <MentionTextarea
            projectId={projectId ?? ""}
            value={value}
            onValueChange={setValue}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={CHAT_COMPOSER_PLACEHOLDER}
            aria-label="Écris un message"
            data-testid="chat-composer-input"
            rows={1}
            disabled={disabled}
            className="min-h-[24px] max-h-[120px] min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent p-0 py-[17px] text-[13.5px] font-medium text-foreground shadow-none placeholder:text-strata-feed-deep placeholder:opacity-90 focus-visible:border-0 focus-visible:ring-0"
          />
        </div>

        <PillButton
          variant="outline"
          outlineTone="neutral"
          iconOnly
          icon={ImagePlus}
          onClick={openFilePicker}
          disabled={disabled || attachmentsDisabled || uploading}
          className="h-[28px] w-[28px]"
        >
          Joindre une image
        </PillButton>

        <SelectPill
          label={project?.shortName ?? "—"}
          tone="project"
          projectTone={projectTone(project?.colorIndex ?? 0)}
          disabled={projects.length === 0}
        >
          {projects.map((candidate) => (
            <DropdownMenuItem
              key={candidate.id}
              onSelect={() => onSelectProject(candidate.id)}
            >
              {candidate.name}
            </DropdownMenuItem>
          ))}
        </SelectPill>

        {/*
          A named agent's name is an arbitrary string — `createNamedAgentSchema`
          only refuses a blank one — and `SelectPill` is `shrink-0`, which is
          right for the project pill's 8-character short name and wrong here.
          Measured with a 107-character name: the pill took its max-content
          width of 663px, overflowed the band, was clipped by the thread
          column, and left the field at ZERO at 640, 768, 1024, 1280 and 1440.
          The page never scrolled sideways — the field simply collapsed.

          Three tokens, one behaviour: `max-w` in `cqw` is a share of the
          composer rather than of the window, so the cap holds in the narrow
          three-column band as well as on a phone; `min-w-0` lets the label's
          own `truncate` engage; `shrink` makes the PILL the item that yields
          when the row is over-subscribed, which is what the field used to do.
        */}
        <SelectPill
          label={agentLabel}
          tone="ink"
          disabled={agentLocked}
          className={cn(AGENT_PILL_MAX, "min-w-0 shrink")}
        >
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Direct API
          </DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="chat-option-openai-compatible"
            onSelect={() =>
              onSelectAgent({
                namedAgentId: null,
                provider: OPENAI_COMPATIBLE_PROVIDER,
              })
            }
          >
            {PROVIDER_LABELS[OPENAI_COMPATIBLE_PROVIDER]}
          </DropdownMenuItem>

          {safeAgents.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                Named Agents
              </DropdownMenuLabel>
              {safeAgents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  data-testid={`chat-option-agent-${agent.id}`}
                  onSelect={() =>
                    // A named agent OWNS its provider: the PATCH route
                    // re-derives it from the agent row, so sending a provider
                    // alongside it is silently ignored.
                    onSelectAgent({
                      namedAgentId: agent.id,
                      provider: agent.provider as ChatModeProvider,
                    })
                  }
                >
                  {agent.name}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            Persistent CLI
          </DropdownMenuLabel>
          {PERSISTENT_CHAT_PROVIDER_OPTIONS.map((provider) => (
            <DropdownMenuItem
              key={provider}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() =>
                onSelectAgent({ namedAgentId: null, provider })
              }
            >
              {PROVIDER_LABELS[provider]}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] text-muted-foreground">
            CLI Providers
          </DropdownMenuLabel>
          {PROVIDER_OPTIONS.map((provider: AgentProvider) => (
            <DropdownMenuItem
              key={provider}
              data-testid={`chat-option-provider-${provider}`}
              onSelect={() =>
                onSelectAgent({ namedAgentId: null, provider })
              }
            >
              {`${PROVIDER_LABELS[provider]} (CLI)`}
            </DropdownMenuItem>
          ))}
        </SelectPill>

        <input {...fileInputProps} />
      </StrataBand>
    </div>
  );
}
