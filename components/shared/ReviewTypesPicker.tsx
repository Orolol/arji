"use client";

import { useTranslations } from "next-intl";

import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * A module-scope copy table, so it holds catalogue KEY REFERENCES and the
 * picker resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
const REVIEW_TYPES: ReadonlyArray<{
  value: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    value: "feature_review",
    labelKey: "Shared.reviewTypes.featureReview.label",
    descriptionKey: "Shared.reviewTypes.featureReview.description",
  },
  {
    value: "security",
    labelKey: "Shared.reviewTypes.security.label",
    descriptionKey: "Shared.reviewTypes.security.description",
  },
  {
    value: "code_review",
    labelKey: "Shared.reviewTypes.codeReview.label",
    descriptionKey: "Shared.reviewTypes.codeReview.description",
  },
  {
    value: "compliance",
    labelKey: "Shared.reviewTypes.compliance.label",
    descriptionKey: "Shared.reviewTypes.compliance.description",
  },
];

interface ReviewTypesPickerProps {
  selected: Set<string>;
  onToggle: (type: string) => void;
}

/** Checkbox cards for choosing which agent review types to dispatch. */
export function ReviewTypesPicker({ selected, onToggle }: ReviewTypesPickerProps) {
  // The table above holds full dotted paths, so it resolves through the
  // namespace-less translator.
  const t = useTranslations();

  return (
    <div className="space-y-3">
      {REVIEW_TYPES.map((type) => (
        <label
          key={type.value}
          className="flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={selected.has(type.value)}
            onChange={() => onToggle(type.value)}
            className="mt-0.5 h-4 w-4 rounded border-border"
          />
          <div>
            <p className="text-sm font-medium">{t(type.labelKey)}</p>
            <p className="text-xs text-muted-foreground">
              {t(type.descriptionKey)}
            </p>
          </div>
        </label>
      ))}
    </div>
  );
}
