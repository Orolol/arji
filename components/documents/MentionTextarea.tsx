"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Textarea } from "@/components/ui/textarea";
import { formatDocumentMention } from "@/lib/documents/mention-format";
import {
  DEFAULT_MENTION_MENU_FIT,
  resolveMentionMenuFit,
  type MentionMenuFit,
} from "@/lib/documents/mention-placement";
import { cn } from "@/lib/utils";

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
  /**
   * Nullable on purpose: the chat composer mounts before its active project
   * resolves. An absent id means "no documents yet", never an empty segment.
   */
  projectId: string | null | undefined;
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

  // An unresolved project is not an id. `/api/projects/${""}/documents`
  // collapses to `/api/projects/documents` — a route nothing serves — so the
  // guard belongs on the identifier, before the request.
  const resolvedProjectId = projectId?.trim() ? projectId.trim() : null;

  // The loaded list belongs to one project. Reset it during render (React's
  // documented alternative to a reset effect) so a switch cannot leave the
  // previous project's filenames suggestable while the new list is in flight.
  const [loadedProjectId, setLoadedProjectId] = useState(resolvedProjectId);
  if (loadedProjectId !== resolvedProjectId) {
    setLoadedProjectId(resolvedProjectId);
    setDocuments([]);
  }

  useEffect(() => {
    if (!resolvedProjectId) return;

    let cancelled = false;

    async function loadDocuments() {
      const res = await fetch(`/api/projects/${resolvedProjectId}/documents`);
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
  }, [resolvedProjectId]);

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

  // WHICH SIDE OF THE FIELD THE MENU OPENS ON, and how tall it may be.
  //
  // The list is anchored to a composer that sits at the bottom of a page that
  // does not scroll (/chat), so "always below" put it off-screen on the frames
  // where the band fits on one row. `mt-1`/`top-full` remains the default; the
  // flip only happens when below cannot hold the list and above holds more.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuFit, setMenuFit] = useState<MentionMenuFit>(DEFAULT_MENTION_MENU_FIT);

  const measureMenuFit = useCallback(() => {
    const anchorEl = anchorRef.current;
    const menuEl = menuRef.current;
    if (!anchorEl || !menuEl) return;

    const anchorRect = anchorEl.getBoundingClientRect();
    const next = resolveMentionMenuFit({
      anchorTop: anchorRect.top,
      anchorBottom: anchorRect.bottom,
      viewportHeight: window.innerHeight,
      // `scrollHeight` and not the rendered height: the clamp we applied last
      // pass must not be mistaken for the list's natural size, or a menu that
      // once flipped could never measure its way back.
      contentHeight: menuEl.scrollHeight,
    });

    setMenuFit((prev) =>
      prev.placement === next.placement && prev.maxHeight === next.maxHeight ? prev : next,
    );
  }, []);

  // Before paint, so the menu is never seen in the wrong place. The list length
  // is a dependency because it changes the height the decision is made against
  // as the user narrows the query.
  //
  // This measures the DOM and places against it, which is the case
  // `useLayoutEffect` exists for; `measureMenuFit` bails on an unchanged fit so
  // there is no cascade. No reset when the menu closes: the fit is only read
  // while it is open, and reopening re-measures before paint.
  useLayoutEffect(() => {
    if (!hasSuggestionMenu) return;
    measureMenuFit();
  }, [hasSuggestionMenu, filteredDocuments.length, measureMenuFit]);

  // The anchor moves under the menu: the window resizes, or the surface the
  // field lives in scrolls (the comment thread and the spec editor both do —
  // /chat's composer is the one that does not). `capture` catches scrolls on
  // the ancestors rather than only on the document.
  useEffect(() => {
    if (!hasSuggestionMenu) return;

    const onViewportChange = () => measureMenuFit();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [hasSuggestionMenu, measureMenuFit]);

  return (
    <div ref={anchorRef} data-slot="mention-anchor" className="relative flex-1 min-w-0 w-full">
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
        <div
          ref={menuRef}
          data-testid="mention-suggestions"
          data-placement={menuFit.placement}
          // The clamp is the measured room on the chosen side, so it is a
          // number and not a class. `max-h-48` survives as the ceiling inside
          // `resolveMentionMenuFit`.
          style={{ maxHeight: menuFit.maxHeight }}
          className={cn(
            "absolute z-30 w-full overflow-auto rounded-[10px] border border-border bg-popover shadow-[0_8px_20px_rgba(58,48,44,.16)]",
            menuFit.placement === "above" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="p-1">
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
