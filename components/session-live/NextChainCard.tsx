"use client";

import { useTranslations } from "next-intl";

import {
  BandHeader,
  PipelineChain,
  StrataBand,
  type PipelineStep,
  type PipelineStepState,
} from "@/components/piscine";
import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * ENSUITE — what happens after this session, derived STATICALLY from the
 * dispatch role.
 *
 * The real chain lives in per-project in-memory auto-mode state
 * (`lib/auto-mode/registry.ts`) behind `GET /api/projects/:id/auto-mode`,
 * which loads the whole board and runs three candidate selectors. Far too
 * expensive for a screen that already polls twice, and it answers a different
 * question anyway — what the SUPERVISOR would pick next, not what this
 * session's role implies. So this is read off `agentType` and nothing else.
 *
 * When the role is not part of a pipeline (chat, spec generation, the memory
 * writers, forensics) the band collapses to its label line. When the session
 * FAILED or was CANCELLED the whole card is omitted: the chain no longer
 * describes anything that is going to happen, and drawing pending rings for it
 * would be a lie.
 */

export interface NextChainCardProps {
  agentType: string | null | undefined;
  status: string;
}

/** Which of the three stages this session's role occupies. */
const OWN_STAGE: Record<string, 0 | 1 | 2> = {
  build: 0,
  ticket_build: 0,
  team_build: 0,
  review_security: 1,
  review_code: 1,
  review_compliance: 1,
  review_feature: 1,
  review_second_opinion: 1,
  grading: 1,
  merge: 2,
  tech_check: 2,
};

/**
 * Stage labels per role. The middle stage is named for what this session is:
 * "Review auto" while a build is still running, "Review" once a reviewer owns
 * it, "Grading" for an acceptance pass.
 *
 * `Review auto (Security CC)` in the frame names a reviewing agent that lives
 * in per-project auto-mode configuration this screen deliberately does not
 * fetch, so the parenthetical is dropped rather than guessed.
 *
 * A MODULE-SCOPE COPY TABLE, so the six stage names are catalogue KEY
 * REFERENCES resolved at render (`lib/i18n/catalogue.ts`, pattern 3).
 */
const STAGE_KEYS = {
  buildKey: "SessionLive.chain.stages.build",
  gradingKey: "SessionLive.chain.stages.grading",
  reviewAutoKey: "SessionLive.chain.stages.reviewAuto",
  reviewKey: "SessionLive.chain.stages.review",
  landKey: "SessionLive.chain.stages.land",
  landIfCleanKey: "SessionLive.chain.stages.landIfClean",
} satisfies Record<string, TranslationKey>;

function stageLabelKeys(
  agentType: string,
): [TranslationKey, TranslationKey, TranslationKey] {
  if (agentType === "grading") {
    return [STAGE_KEYS.buildKey, STAGE_KEYS.gradingKey, STAGE_KEYS.landIfCleanKey];
  }
  if (OWN_STAGE[agentType] === 0) {
    return [
      STAGE_KEYS.buildKey,
      STAGE_KEYS.reviewAutoKey,
      STAGE_KEYS.landIfCleanKey,
    ];
  }
  if (OWN_STAGE[agentType] === 2) {
    return [STAGE_KEYS.buildKey, STAGE_KEYS.reviewKey, STAGE_KEYS.landKey];
  }
  return [STAGE_KEYS.buildKey, STAGE_KEYS.reviewKey, STAGE_KEYS.landIfCleanKey];
}

export function NextChainCard({ agentType, status }: NextChainCardProps) {
  const t = useTranslations("SessionLive");
  // Namespace-less, for the stage table's KEY REFERENCES.
  const tKey = useTranslations();
  const failedOrCancelled = status === "failed" || status === "cancelled";
  if (failedOrCancelled) return null;

  const own = agentType ? OWN_STAGE[agentType] : undefined;
  const labelKeys =
    agentType && own !== undefined ? stageLabelKeys(agentType) : null;

  const steps: PipelineStep[] =
    labelKeys && own !== undefined
      ? labelKeys.map((labelKey, index) => {
          const state: PipelineStepState =
            index < own
              ? "done"
              : index > own
                ? "pending"
                : status === "running" || status === "queued"
                  ? "live"
                  : status === "completed"
                    ? "done"
                    : "pending";
          // The frame appends the running suffix to the live step only.
          const base = tKey(labelKey);
          return {
            label: state === "live" ? t("chain.running", { label: base }) : base,
            state,
          };
        })
      : [];

  return (
    <StrataBand stratum="card" density="rail" gap={8}>
      <BandHeader
        label={t("chain.label")}
        stratum="neutral"
        labelSize={12}
        standalone
      />
      {steps.length > 0 && (
        <PipelineChain
          orientation="vertical"
          markerSize={8}
          steps={steps}
        />
      )}
    </StrataBand>
  );
}
