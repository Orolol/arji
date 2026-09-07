"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { RoutinesSettings } from "@/components/routines/RoutinesSettings";
import { McpServersSection } from "@/components/settings/McpServersSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  promptTokenBudgetSettingKey,
  parsePromptTokenBudget,
} from "@/lib/tokens/budget-settings";

function ProjectTokenBudgetSection({ projectId }: { projectId: string }) {
  const t = useTranslations("ProjectSettings");
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
        setMessage(t("tokenBudget.invalid"));
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
        setMessage(t("tokenBudget.saveFailed"));
        return;
      }
      setBudget(val === null ? "" : String(val));
      setMessage(
        val === null ? t("tokenBudget.cleared") : t("tokenBudget.saved")
      );
    } catch {
      setMessage(t("tokenBudget.saveFailed"));
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
        <h2 className="text-lg font-semibold">{t("tokenBudget.heading")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("tokenBudget.description")}
        </p>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="project-prompt-token-budget-setting"
          className="block text-sm font-medium"
        >
          {t("tokenBudget.fieldLabel")}
        </label>
        <Input
          id="project-prompt-token-budget-setting"
          data-testid="project-prompt-token-budget-setting"
          type="text"
          value={budget}
          disabled={saving}
          placeholder={
            globalDefault != null
              ? t("tokenBudget.placeholderGlobal", {
                  // The raw digits, as the template literal printed them: a
                  // number argument would pick up locale grouping.
                  tokens: String(globalDefault),
                })
              : t("tokenBudget.placeholder")
          }
          onChange={(e) => setBudget(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("tokenBudget.hint")}
        </p>
      </div>

      <Button
        type="button"
        onClick={handleSave}
        disabled={saving}
        data-testid="project-prompt-token-budget-save"
      >
        {saving ? t("tokenBudget.savePending") : t("tokenBudget.save")}
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
      {/* Project-scoped MCP servers, plus the globals this project inherits. */}
      <McpServersSection projectId={projectId} />
    </div>
  );
}
