"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { formatDocumentMention } from "@/lib/documents/mention-format";

interface MentionDocument {
  id: string;
  originalFilename: string;
}

interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

interface MentionTextareaProps
  extends Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> {
  projectId: string;
  value: string;
  onValueChange: (value: string) => void;
}

function detectActiveMention(value: string, cursorPosition: number): ActiveMention | null {
  const beforeCursor = value.slice(0, cursorPosition);

  const braced = /(?:^|\s)@\{([^}\n]*)$/.exec(beforeCursor);
  if (braced) {
    const mentionSlice = braced[0];
    const start = beforeCursor.length - mentionSlice.length + mentionSlice.lastIndexOf("@");
    return {
      start,
      end: cursorPosition,
      query: (braced[1] || "").trim().toLowerCase(),
    };
  }

  const simple = /(?:^|\s)@([A-Za-z0-9._-]*)$/.exec(beforeCursor);
  if (simple) {
    const mentionSlice = simple[0];
    const start = beforeCursor.length - mentionSlice.length + mentionSlice.lastIndexOf("@");
    return {
      start,
      end: cursorPosition,
      query: (simple[1] || "").trim().toLowerCase(),
    };
  }

  return null;
}

export function MentionTextarea({
  projectId,
  value,
  onValueChange,
  onKeyDown,
  onBlur,
  onFocus,
  ref: forwardedRef,
  ...props
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [documents, setDocuments] = useState<MentionDocument[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadDocuments() {
      const res = await fetch(`/api/projects/${projectId}/documents`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || cancelled) return;

      const docs = (json.data || []) as Array<{
        id: string;
        originalFilename: string;
      }>;

      setDocuments(
        docs
          .filter((doc) => typeof doc.originalFilename === "string" && doc.originalFilename.length > 0)
          .map((doc) => ({ id: doc.id, originalFilename: doc.originalFilename }))
      );
    }

    loadDocuments().catch(() => {
      // best-effort load
    });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const filteredDocuments = useMemo(() => {
    if (!activeMention) return [];
    const q = activeMention.query;
    if (!q) return documents.slice(0, 8);

    return documents
      .filter((doc) => doc.originalFilename.toLowerCase().includes(q))
      .slice(0, 8);
  }, [activeMention, documents]);

  // Reset the highlight when the query changes. Adjusting state during render
  // (React's documented alternative to a reset effect) keeps the first
  // suggestion highlighted without the extra commit an effect would cost.
  const [lastQuery, setLastQuery] = useState(activeMention?.query);
  if (activeMention?.query !== lastQuery) {
    setLastQuery(activeMention?.query);
    setSelectedIndex(0);
  }

  const updateActiveMention = useCallback(
    (nextValue: string, cursorPosition: number | null) => {
      if (cursorPosition == null) {
        setActiveMention(null);
        return;
      }
      setActiveMention(detectActiveMention(nextValue, cursorPosition));
    },
    []
  );

  const applyMention = useCallback(
    (doc: MentionDocument) => {
      if (!activeMention) return;

      const mentionToken = formatDocumentMention(doc.originalFilename);
      const replacement = `${mentionToken} `;
      const nextValue =
        value.slice(0, activeMention.start) + replacement + value.slice(activeMention.end);
      const nextCursor = activeMention.start + replacement.length;

      onValueChange(nextValue);
      setActiveMention(null);

      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeMention, onValueChange, value]
  );

  const hasSuggestionMenu = Boolean(activeMention && filteredDocuments.length > 0);

  return (
    <div className="relative flex-1 min-w-0 w-full">
      <Textarea
        {...props}
        ref={(node) => {
          textareaRef.current = node;
          if (typeof forwardedRef === "function") {
            forwardedRef(node);
          } else if (forwardedRef) {
            forwardedRef.current = node;
          }
        }}
        value={value}
        onChange={(e) => {
          const nextValue = e.target.value;
          onValueChange(nextValue);
          updateActiveMention(nextValue, e.target.selectionStart);
        }}
        onFocus={(e) => {
          onFocus?.(e);
          updateActiveMention(value, e.currentTarget.selectionStart);
        }}
        onBlur={(e) => {
          onBlur?.(e);
          // Delay hide so suggestion click can commit before blur clears state.
          setTimeout(() => setActiveMention(null), 100);
        }}
        onClick={(e) => {
          updateActiveMention(value, (e.target as HTMLTextAreaElement).selectionStart);
        }}
        onKeyUp={(e) => {
          updateActiveMention(value, (e.target as HTMLTextAreaElement).selectionStart);
        }}
        onKeyDown={(e) => {
          if (hasSuggestionMenu) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedIndex((idx) => (idx + 1) % filteredDocuments.length);
              return;
            }

            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedIndex((idx) => (idx - 1 + filteredDocuments.length) % filteredDocuments.length);
              return;
            }

            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              const chosen = filteredDocuments[selectedIndex] || filteredDocuments[0];
              if (chosen) {
                applyMention(chosen);
                return;
              }
            }

            if (e.key === "Escape") {
              e.preventDefault();
              setActiveMention(null);
              return;
            }
          }

          onKeyDown?.(e);
        }}
      />

      {hasSuggestionMenu && (
        <div className="absolute z-30 mt-1 w-full rounded-[10px] border border-border bg-popover shadow-[0_8px_20px_rgba(58,48,44,.16)]">
          <div className="max-h-48 overflow-auto p-1">
            {filteredDocuments.map((doc, index) => (
              <button
                key={doc.id}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMention(doc);
                }}
                className={`w-full rounded-[7px] px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                  index === selectedIndex ? "bg-band" : "hover:bg-band/70"
                }`}
              >
                {doc.originalFilename}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
