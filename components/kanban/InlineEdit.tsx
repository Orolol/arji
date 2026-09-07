"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { cn } from "@/lib/utils";

interface InlineEditProps {
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  markdown?: boolean;
  className?: string;
  /**
   * Id of the form control this field renders while editing, so a caller's
   * visible `<label htmlFor={...}>` associates with it the plain HTML way.
   * The read state is a `<div>`, which is not labelable — that half of the
   * association is `aria-labelledby` below.
   */
  id?: string;
  /**
   * Id of the element naming this field. Applied to the read state, which is
   * announced as a button ("Description, button") rather than as anonymous
   * text: an `aria-labelledby` on a role-less `<div>` contributes no
   * accessible name at all, so the role is what makes the association real
   * instead of merely present in the DOM.
   */
  "aria-labelledby"?: string;
}

export function InlineEdit({
  value,
  onSave,
  multiline = false,
  markdown = false,
  className = "",
  id,
  "aria-labelledby": ariaLabelledBy,
}: InlineEditProps) {
  const t = useTranslations("Kanban");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  /**
   * Set only by the keyboard exits below. Leaving edit mode unmounts the
   * focused control, so without this focus falls to <body> and the next Tab
   * restarts at the top of the document — WCAG 2.4.3, on the very journey the
   * read state's `role="button"` exists to enable.
   *
   * A blur is deliberately NOT a keyboard exit: clicking or tabbing elsewhere
   * is the user aiming somewhere, and pulling focus back would fight them.
   */
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      readRef.current?.focus();
    }
  }, [editing]);

  function handleSave() {
    setEditing(false);
    if (editValue.trim() !== value) {
      onSave(editValue.trim());
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      restoreFocusRef.current = true;
      handleSave();
    }
    if (e.key === "Escape") {
      restoreFocusRef.current = true;
      setEditValue(value);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <div
        ref={readRef}
        role="button"
        tabIndex={0}
        aria-labelledby={ariaLabelledBy}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          // A click target that only answers to a mouse is unreachable for
          // the same readers the label association is for.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={cn(
          "-mx-2 cursor-pointer rounded-[7px] px-2 py-[2px] transition-colors hover:bg-band",
          // Tab order now reaches this region, so it has to show where focus
          // is. Same ring the Piscine controls paint, and deliberately with no
          // `outline-none` beside it — the two cancel in Tailwind v4 and the
          // ring silently stops being drawn (B-arij-JJ5FdaHpX7d6).
          "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        {value ? (
          markdown ? <MarkdownContent content={value} /> : value
        ) : (
          <span className="italic text-muted-foreground">
            {t("inlineEdit.empty")}
          </span>
        )}
      </div>
    );
  }

  if (multiline) {
    return (
      <Textarea
        id={id}
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        rows={3}
        className={cn("rounded-[8px]", className)}
      />
    );
  }

  return (
    <Input
      id={id}
      ref={inputRef as React.RefObject<HTMLInputElement>}
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      className={cn("rounded-[8px]", className)}
    />
  );
}
