"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TicketCommentContent } from "@/components/verify/TicketCommentContent";
import { Send, User, Bot, Loader2, Hammer } from "lucide-react";
import type { TicketComment } from "@/hooks/useTicketComments";
import { formatTime } from "@/lib/utils/format-date";

interface CommentThreadProps {
  projectId: string;
  comments: TicketComment[];
  loading: boolean;
  onAddComment: (content: string) => Promise<unknown>;
  /** One-click dispatch: immediately sends to dev without dialog */
  onSendToDev?: () => Promise<unknown>;
  /** Whether the send-to-dev action is disabled (agent running, etc.) */
  sendToDevDisabled?: boolean;
  /** Whether the send-to-dev action is currently dispatching */
  sendToDevLoading?: boolean;
}

export function CommentThread({
  projectId,
  comments,
  loading,
  onAddComment,
  onSendToDev,
  sendToDevDisabled,
  sendToDevLoading,
}: CommentThreadProps) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new comments arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments.length]);

  async function handleSubmit() {
    if (!input.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onAddComment(input.trim());
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add comment");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border">
        <h3 className="text-sm font-medium">
          Comments ({comments.length})
        </h3>
      </div>

      {/* Comments list */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="p-4 space-y-4">
          {loading && comments.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">
              No comments yet. Start the conversation.
            </p>
          ) : (
            comments.map((comment) => (
              <div
                key={comment.id}
                className={`rounded-lg p-3 ${
                  comment.author === "agent"
                    ? "bg-muted/50 border border-border"
                    : "bg-primary/5 border border-primary/10"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  {comment.author === "agent" ? (
                    <Bot className="h-3.5 w-3.5 text-blue-500" />
                  ) : (
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium">
                    {comment.author === "agent" ? "Agent" : "You"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTime(comment.createdAt)}
                  </span>
                </div>
                <div className="text-sm">
                  <TicketCommentContent content={comment.content} />
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-4 border-t border-border">
        {error && <p className="text-xs text-destructive mb-2">{error}</p>}
        <div className="flex gap-2">
          <MentionTextarea
            projectId={projectId}
            value={input}
            onValueChange={setInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Add a comment..."
            rows={3}
            className="min-h-24 resize-none"
          />
          <div className="flex flex-col gap-1 shrink-0 self-end">
            <Button
              size="icon"
              onClick={handleSubmit}
              disabled={!input.trim() || sending}
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
            </Button>
            {onSendToDev && (
              <Button
                size="icon"
                variant="outline"
                onClick={onSendToDev}
                disabled={sendToDevDisabled || sendToDevLoading}
                title="Send to dev"
                data-testid="send-to-dev-button"
              >
                {sendToDevLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Hammer className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
