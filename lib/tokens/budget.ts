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

export const PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY = "prompt_token_budget";

export function promptTokenBudgetSettingKey(projectId: string): string {
  return `${PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY}:${projectId}`;
}

export function parsePromptTokenBudget(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    try {
      const parsedJson = JSON.parse(trimmed);
      if (typeof parsedJson === "number") {
        return Number.isFinite(parsedJson) && parsedJson > 0
          ? Math.round(parsedJson)
          : null;
      }
    } catch {
      // not json, continue parsing string
    }
    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/);
    if (match) {
      const num = parseFloat(match[1]);
      const suffix = match[2];
      if (Number.isFinite(num) && num > 0) {
        if (suffix === "k") return Math.round(num * 1000);
        if (suffix === "m") return Math.round(num * 1000000);
        return Math.round(num);
      }
    }
  }
  return null;
}

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
