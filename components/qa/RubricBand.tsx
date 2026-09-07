"use client";

import { useTranslations } from "next-intl";

import { BandHeader, QuietLink, StrataBand } from "@/components/piscine";
import type { QaRubric } from "@/lib/qa/types";

import { RubricChips } from "./RubricChips";

/**
 * LA RUBRIQUE — the pool-blue stratum, right half of the bottom split.
 *
 * WHY THE HELPER TEXT IS IN THE `right` SLOT. The frame draws
 * "ce que chaque reviewer vérifie — injectée dans son prompt" in SANS at
 * 11.5px, and `BandHeader.meta` always renders `<Mono>`. The primitive set is
 * frozen, so the helper travels in `right` together with the "éditer →" link,
 * as one baseline cluster. `right` is `ml-auto`, so the cluster sits at the far
 * right of the row rather than hugging the label the way the canvas draws it;
 * the reading ORDER is the frame's (label, helper, link) and no primitive was
 * forked to get it.
 *
 * FALLBACK: if the checklist yields no headings the band is header + helper +
 * link and nothing else. Never a fabricated rule.
 */
export interface RubricBandProps {
  rubric: QaRubric;
  className?: string;
}

export function RubricBand({ rubric, className }: RubricBandProps) {
  const t = useTranslations("Qa");

  return (
    <StrataBand stratum="next" density="full" gap={9} className={className}>
      <BandHeader
        label={t("rubric.label")}
        stratum="next"
        labelSize={13}
        right={
          <div className="flex items-baseline gap-3">
            <span
              data-testid="qa-rubric-helper"
              className="font-sans text-[11.5px] text-strata-next-mid"
            >
              {t("rubric.helper")}
            </span>
            <QuietLink
              tone="next"
              size={12}
              href="/agents/prompts"
              testId="qa-rubric-edit"
            >
              {t("rubric.edit")}
            </QuietLink>
          </div>
        }
      />

      {rubric.items.length > 0 || rubric.projectRuleCount > 0 ? (
        <RubricChips
          items={rubric.items}
          projectRuleCount={rubric.projectRuleCount}
        />
      ) : null}

      <span
        data-testid="qa-rubric-footnote"
        className="font-sans text-[11.5px] text-strata-next-mid"
      >
        {t("rubric.footnote")}
      </span>
    </StrataBand>
  );
}
