"use client";

import {
  BandHeader,
  PipelineChain,
  StrataBand,
  type PipelineStep,
  type PipelineStepState,
} from "@/components/piscine";

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
 */
function stageLabels(agentType: string): [string, string, string] {
  if (agentType === "grading") return ["Build", "Grading", "Land si review clean"];
  if (OWN_STAGE[agentType] === 0) {
    return ["Build", "Review auto", "Land si review clean"];
  }
  if (OWN_STAGE[agentType] === 2) return ["Build", "Review", "Land"];
  return ["Build", "Review", "Land si review clean"];
}

export function NextChainCard({ agentType, status }: NextChainCardProps) {
  const failedOrCancelled = status === "failed" || status === "cancelled";
  if (failedOrCancelled) return null;

  const own = agentType ? OWN_STAGE[agentType] : undefined;
  const labels = agentType && own !== undefined ? stageLabels(agentType) : null;

  const steps: PipelineStep[] =
    labels && own !== undefined
      ? labels.map((base, index) => {
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
          return { label: state === "live" ? `${base} — en cours` : base, state };
        })
      : [];

  return (
    <StrataBand stratum="card" density="rail" gap={8}>
      <BandHeader label="Ensuite" stratum="neutral" labelSize={12} standalone />
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
