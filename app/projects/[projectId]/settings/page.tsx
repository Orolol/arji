"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { RoutinesSettings } from "@/components/routines/RoutinesSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  promptTokenBudgetSettingKey,
  parsePromptTokenBudget,
} from "@/lib/tokens/budget-settings";

function ProjectTokenBudgetSection({ projectId }: { projectId: string }) {
  const [budget, setBudget] = useState("");
  const [globalDefault, setGlobalDefault] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const settingKey = promptTokenBudgetSettingKey(projectId);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const projectVal = parsePromptTokenBudget(d?.data?.[settingKey]);
        setBudget(projectVal != null ? String(projectVal) : "");

        const globalVal = parsePromptTokenBudget(
          d?.data?.[PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]
        );
        setGlobalDefault(globalVal);
      })
      .catch(() => {});
  }, [settingKey]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const raw = budget.trim();
    let val: number | null = null;
    if (raw !== "") {
      const parsed = parsePromptTokenBudget(raw);
      if (parsed === null || parsed <= 0) {
        setMessage(
          "Budget must be a positive integer token count (e.g. 50000 or 50k)."
        );
        setSaving(false);
        return;
      }
      val = parsed;
    }

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingKey]: val }),
      });
      if (!res.ok) {
        setMessage("Failed to save project prompt token budget.");
        return;
      }
      setBudget(val === null ? "" : String(val));
      setMessage(
        val === null
          ? "Project override cleared (using global default)."
          : "Project budget saved."
      );
    } catch {
      setMessage("Failed to save project prompt token budget.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-md border border-border p-4 mb-6"
      data-testid="project-prompt-budget-settings"
    >
      <div>
        <h2 className="text-lg font-semibold">Prompt Token Budget (Project Override)</h2>
        <p className="text-xs text-muted-foreground">
          Override the global prompt token budget threshold for this project.
        </p>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="project-prompt-token-budget-setting"
          className="block text-sm font-medium"
        >
          Max prompt tokens warning threshold
        </label>
        <Input
          id="project-prompt-token-budget-setting"
          data-testid="project-prompt-token-budget-setting"
          type="text"
          value={budget}
          disabled={saving}
          placeholder={
            globalDefault != null
              ? `Global default: ${globalDefault} tokens (leave empty to use global)`
              : "e.g. 50000 or 50k (no threshold by default)"
          }
          onChange={(e) => setBudget(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Optional absolute token count warning threshold (e.g. 50000 or 50k). When dispatch estimation exceeds this threshold, a non-blocking warning is shown highlighting the largest context section.
        </p>
      </div>

      <Button
        type="button"
        onClick={handleSave}
        disabled={saving}
        data-testid="project-prompt-token-budget-save"
      >
        {saving ? "Saving..." : "Save Project Budget"}
      </Button>

      {message && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="project-prompt-token-budget-message"
        >
          {message}
        </p>
      )}
    </section>
  );
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <ProjectTokenBudgetSection projectId={projectId} />
      <RoutinesSettings projectId={projectId} />
    </div>
  );
}
