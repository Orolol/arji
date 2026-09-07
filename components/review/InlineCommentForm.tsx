"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, X } from "lucide-react";

interface InlineCommentFormProps {
  onSubmit: (body: string) => Promise<unknown>;
  onCancel: () => void;
  initialValue?: string;
}

export function InlineCommentForm({
  onSubmit,
  onCancel,
  initialValue = "",
}: InlineCommentFormProps) {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const t = useTranslations("Review");

  async function handleSubmit() {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim());
      setValue("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border border-border rounded-lg p-2 bg-background space-y-2">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          }
          if (e.key === "Escape") {
            onCancel();
          }
        }}
        placeholder={t("commentForm.placeholder")}
        rows={2}
        className="text-xs resize-none"
        autoFocus
      />
      <div className="flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className="h-7 text-xs"
        >
          <X className="h-3 w-3 mr-1" />
          {t("commentForm.cancel")}
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!value.trim() || submitting}
          className="h-7 text-xs"
        >
          {submitting ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Send className="h-3 w-3 mr-1" />
          )}
          {t("commentForm.submit")}
        </Button>
      </div>
    </div>
  );
}
