"use client";

import * as React from "react";
import { useRef, useState } from "react";
import { ImagePlus, Sparkles } from "lucide-react";

import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { PillButton, SelectPill, StrataBand, projectTone } from "@/components/piscine";
import {
  AGENT_PILL_IN_COMPOSER,
  AgentSelectPill,
  type AgentSelection,
} from "@/components/shared/AgentSelectPill";
import { ImageAttachmentStrip } from "@/components/shared/ImageAttachmentStrip";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

export const CHAT_COMPOSER_PLACEHOLDER =
  "Écris — ⏎ envoie, ⇧⏎ saute une ligne, @ cite un doc";

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
export interface ChatComposerProps {
  projectId: string | null;
  projects: readonly DeskProject[];
  project: DeskProject | null;
  onSelectProject: (projectId: string) => void;
  /** What the conversation runs on; the pill names it itself. */
  agentSelection: AgentSelection;
  onSelectAgent: (choice: AgentSelection) => void;
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
  agentSelection,
  onSelectAgent,
  agentLocked,
  attachmentsDisabled = false,
  disabled = false,
  onSend,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const composingRef = useRef(false);

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
        `AGENT_PILL_IN_COMPOSER` of the band on the agent pill, which leaves the field
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
            // NOT `?? ""`: an empty segment is what produced the
            // `/api/projects/documents` 404s on every /chat load.
            projectId={projectId}
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
          The cap, its measurement and the reason it is applied here rather
          than inside the component all live on `AGENT_PILL_IN_COMPOSER`.

          IT IS SHARED, NOT COPIED, since B-arij-OZUKyqpxmKaT: the desk's
          composer turned out to have the same row — a field beside an
          uncapped pill — and measured the same 0px field. Two mounts with one
          behaviour is one constant; the project panel's header and the
          ticket's AGENTS band still take neither, because no field shares
          their row.
        */}
        <AgentSelectPill
          mode="chat"
          selection={agentSelection}
          onSelect={onSelectAgent}
          disabled={agentLocked}
          className={AGENT_PILL_IN_COMPOSER}
        />

        <input {...fileInputProps} />
      </StrataBand>
    </div>
  );
}
