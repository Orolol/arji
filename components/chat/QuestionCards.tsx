"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Send, Check, ChevronLeft, ChevronRight } from "lucide-react";
import type { QuestionData } from "@/lib/claude/spawn";

interface QuestionCardsProps {
  questions: QuestionData[];
  onSubmit: (formatted: string) => void;
  disabled?: boolean;
}

export function QuestionCards({ questions, onSubmit, disabled }: QuestionCardsProps) {
  const t = useTranslations("ChatLegacy");
  const [currentIdx, setCurrentIdx] = useState(0);
  // selections[questionIdx] = set of selected option indices
  const [selections, setSelections] = useState<Map<number, Set<number>>>(
    () => new Map(questions.map((_, i) => [i, new Set<number>()]))
  );

  const q = questions[currentIdx];
  const isFirst = currentIdx === 0;
  const isLast = currentIdx === questions.length - 1;
  const currentAnswered = (selections.get(currentIdx)?.size || 0) > 0;
  const allAnswered = questions.every((_, i) => (selections.get(i)?.size || 0) > 0);

  function toggleOption(optIdx: number) {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(prev.get(currentIdx) || []);

      if (q.multiSelect) {
        if (current.has(optIdx)) current.delete(optIdx);
        else current.add(optIdx);
      } else {
        current.clear();
        current.add(optIdx);
      }

      next.set(currentIdx, current);
      return next;
    });
  }

  function handleSubmit() {
    const parts: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const qi = questions[i];
      const selected = selections.get(i) || new Set();
      if (selected.size === 0) continue;
      const labels = [...selected].map((idx) => qi.options[idx].label);
      parts.push(`**${qi.header}**: ${labels.join(", ")}`);
    }
    if (parts.length > 0) {
      onSubmit(parts.join("\n"));
    }
  }

  return (
    <div className="space-y-3">
      {/* Step indicator */}
      {questions.length > 1 && (
        <div className="flex items-center justify-between text-[12px] text-muted-foreground">
          <span>
            {t("questions.step", {
              current: currentIdx + 1,
              total: questions.length,
            })}
          </span>
          <div className="flex gap-1">
            {questions.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  i === currentIdx
                    ? "bg-primary"
                    : (selections.get(i)?.size || 0) > 0
                      ? "bg-primary/50"
                      : "bg-meta/40"
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Current question */}
      <p className="text-[13.5px] font-medium leading-[1.5]">{q.question}</p>

      {/* Options */}
      <div className="grid gap-2">
        {q.options.map((opt, optIdx) => {
          const isSelected = selections.get(currentIdx)?.has(optIdx) || false;
          return (
            <button
              key={optIdx}
              onClick={() => toggleOption(optIdx)}
              disabled={disabled}
              className={`rounded-[11px] border p-3 text-left transition-colors ${
                isSelected
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border hover:border-primary/50 hover:bg-band"
              } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <div className="flex items-start gap-2">
                <div
                  className={`mt-0.5 shrink-0 w-4 h-4 ${q.multiSelect ? "rounded-sm" : "rounded-full"} border flex items-center justify-center ${
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40"
                  }`}
                >
                  {isSelected && <Check className="h-3 w-3" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">{opt.label}</div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {opt.description}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Navigation + submit */}
      <div className="flex items-center gap-2">
        {!isFirst && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCurrentIdx((i) => i - 1)}
            disabled={disabled}
            className="px-2"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}

        <div className="flex-1">
          {isLast ? (
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={disabled || !allAnswered}
              className="w-full"
            >
              <Send className="h-3 w-3 mr-2" />
              {t("questions.submit")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCurrentIdx((i) => i + 1)}
              disabled={disabled || !currentAnswered}
              className="w-full"
            >
              {t("questions.next")}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
