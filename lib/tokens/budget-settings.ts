/** Client-safe prompt-budget setting names and value parsing. */

export const PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY = "prompt_token_budget";

export function promptTokenBudgetSettingKey(projectId: string): string {
  return `${PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY}:${projectId}`;
}

export function parsePromptTokenBudget(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if (typeof value !== "string") return null;

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
    // Not JSON; parse the documented raw-token format below.
  }

  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([km])?$/);
  if (!match) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (match[2] === "k") return Math.round(number * 1_000);
  if (match[2] === "m") return Math.round(number * 1_000_000);
  return Math.round(number);
}
