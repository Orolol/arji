"use client";

import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Trash2, User, Bot } from "lucide-react";
import type { ReviewComment } from "@/hooks/useReviewComments";
import { formatDateTime } from "@/lib/i18n/format";

interface InlineCommentThreadProps {
  comments: ReviewComment[];
  onUpdate: (id: string, updates: { body?: string; status?: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}

export function InlineCommentThread({
  comments,
  onUpdate,
  onDelete,
}: InlineCommentThreadProps) {
  const locale = useLocale();
  const t = useTranslations("Review");
  return (
    <div className="space-y-1">
      {comments.map((comment) => (
        <div
          key={comment.id}
          className={`border rounded-lg p-2 text-xs ${
            comment.status === "resolved"
              ? "border-border/50 bg-muted/30 opacity-60"
              : "border-blue-500/30 bg-blue-500/5"
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            {comment.author === "agent" ? (
              <Bot className="h-3 w-3 text-blue-500" />
            ) : (
              <User className="h-3 w-3 text-muted-foreground" />
            )}
            <span className="font-medium">
              {comment.author === "agent" ? t("thread.agent") : t("thread.you")}
            </span>
            <span className="text-muted-foreground">
              {formatDateTime(comment.createdAt, { locale, style: "dayTime" })}
            </span>
            {comment.status === "resolved" && (
              <Badge variant="outline" className="text-[10px] h-4 px-1">
                {t("thread.resolved")}
              </Badge>
            )}
            <div className="flex-1" />
            {comment.status === "open" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => onUpdate(comment.id, { status: "resolved" })}
                title={t("thread.resolve")}
              >
                <Check className="h-3 w-3" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 text-destructive"
              onClick={() => onDelete(comment.id)}
              title={t("thread.delete")}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
          <p className="whitespace-pre-wrap">{comment.body}</p>
        </div>
      ))}
    </div>
  );
}
