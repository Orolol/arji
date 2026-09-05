"use client";

import * as React from "react";
import { ImagePlus, Sparkles } from "lucide-react";

import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { PillButton, SelectPill, StrataBand, projectTone } from "@/components/piscine";
import {
  AgentSelectPill,
  type AgentSelection,
} from "@/components/shared/AgentSelectPill";
import { ImageAttachmentStrip } from "@/components/shared/ImageAttachmentStrip";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import type { DeskProject } from "@/lib/control-desk/types";

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
  const [value, setValue] = React.useState("");
  const composingRef = React.useRef(false);

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
    <div data-testid="chat-composer" className="flex shrink-0 flex-col">
      {/* Self-hides when empty and nothing is uploading. */}
      <ImageAttachmentStrip
        attachments={effectiveAttachments}
        onRemove={removeAttachment}
        uploading={uploading}
        className="px-[18px] pb-1"
      />

      <StrataBand
        stratum="feed"
        gap={13}
        className="min-h-[58px] shrink-0 flex-row items-center px-[18px] py-0"
      >
        <Sparkles
          size={16}
          aria-hidden="true"
          className="shrink-0 text-strata-feed-deep"
        />

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

        <AgentSelectPill
          mode="chat"
          selection={agentSelection}
          onSelect={onSelectAgent}
          disabled={agentLocked}
        />

        <input {...fileInputProps} />
      </StrataBand>
    </div>
  );
}
