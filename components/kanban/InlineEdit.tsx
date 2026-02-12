"use client";

import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

interface InlineEditProps {
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  markdown?: boolean;
  className?: string;
}

export function InlineEdit({
  value,
  onSave,
  multiline = false,
  markdown = false,
  className = "",
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
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
      handleSave();
    }
    if (e.key === "Escape") {
      setEditValue(value);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <div
        onClick={() => setEditing(true)}
        className={`cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 ${className}`}
      >
        {value ? (
          markdown ? <MarkdownContent content={value} /> : value
        ) : (
          <span className="text-muted-foreground italic">Click to edit</span>
        )}
      </div>
    );
  }

  if (multiline) {
    return (
      <Textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        rows={3}
        className={`text-sm ${className}`}
      />
    );
  }

  return (
    <Input
      ref={inputRef as React.RefObject<HTMLInputElement>}
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      className={`text-sm ${className}`}
    />
  );
}
