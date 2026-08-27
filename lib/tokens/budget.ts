/**
 * Prompt token budget resolution, parsing, and threshold checking.
 */

import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import type {
  PromptTokenBreakdown,
  LargestContextSection,
} from "./estimator";
import { findLargestContextSection } from "./estimator";
import {
  parsePromptTokenBudget,
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  promptTokenBudgetSettingKey,
} from "./budget-settings";

export {
  parsePromptTokenBudget,
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  promptTokenBudgetSettingKey,
} from "./budget-settings";

export function resolvePromptTokenBudget(projectId: string): number | null {
  const projectKey = promptTokenBudgetSettingKey(projectId);
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(settings.key, [
        projectKey,
        PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
      ])
    )
    .all();

  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }

  const projectVal = map[projectKey];
  const parsedProject = parsePromptTokenBudget(projectVal);
  if (parsedProject !== null) return parsedProject;

  const globalVal = map[PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY];
  return parsePromptTokenBudget(globalVal);
}

export interface PromptBudgetCheckResult {
  budget: number | null;
  budgetExceeded: boolean;
  largestSection: LargestContextSection | null;
}

export function checkPromptTokenBudget(
  estimatedTokens: number,
  breakdown: PromptTokenBreakdown,
  budget: number | null
): PromptBudgetCheckResult {
  if (!budget || budget <= 0 || estimatedTokens <= budget) {
    return {
      budget,
      budgetExceeded: false,
      largestSection: null,
    };
  }

  const largest = findLargestContextSection(breakdown, estimatedTokens);
  return {
    budget,
    budgetExceeded: true,
    largestSection: largest,
  };
}
