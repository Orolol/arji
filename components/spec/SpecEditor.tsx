"use client";

import { MentionTextarea } from "@/components/documents/MentionTextarea";

interface SpecEditorProps {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * The spec's write surface: a mention-aware textarea with no chrome of its
 * own. It lives INSIDE the white editor card of the SPEC band, so the card is
 * the edge — the field draws no border and no background, and it is the scroll
 * container for the whole band (`flex-1; min-height:0; overflow-y:auto`).
 *
 * The module path, the component name and the prop names are pinned by
 * `__tests__/spec-page-update-feedback.test.tsx`, which mocks this file by
 * path and drives `value` / `onChange` / `disabled`. Only the styling moved.
 */
export function SpecEditor({
  projectId,
  value,
  onChange,
  disabled,
}: SpecEditorProps) {
  return (
    // MentionTextarea wraps its field in a `relative flex-1 min-w-0 w-full`
    // div (it anchors the @-mention popover). That div is not ours to edit, so
    // the arbitrary variant gives it the `min-height: 0` a flex-column scroll
    // container needs — without it the card grows with the document instead of
    // scrolling inside a fixed band.
    <div className="flex min-h-0 flex-1 flex-col [&>div]:min-h-0">
      <MentionTextarea
        projectId={projectId}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        placeholder="Écris la spec du projet en markdown…"
        className="h-full min-h-0 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 font-mono text-[12.5px] leading-[1.7] shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0"
      />
    </div>
  );
}
