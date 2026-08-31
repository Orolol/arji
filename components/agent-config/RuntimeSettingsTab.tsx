"use client";

import { useEffect, useState } from "react";
import { REVIEW_PROVIDER_SEGREGATION_SETTING_KEY } from "@/lib/agent-config/review-segregation-constants";
import {
  AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  agentMaxConcurrentSettingKey,
  formatMaxConcurrent,
  parseMaxConcurrentSetting,
} from "@/lib/agents/scheduler-constants";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";

interface RuntimeSettingsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

/**
 * Runtime-only settings: the reviewer-segregation toggle and the per-scope
 * concurrency cap. Automatic task-to-agent choices live in Assignments;
 * each selected CLI owns its own provider configuration.
 */
export function RuntimeSettingsTab({
  scope,
  projectId,
}: RuntimeSettingsTabProps) {
  // null = not loaded yet
  const [segregation, setSegregation] = useState<boolean | null>(null);
  const [savingSegregation, setSavingSegregation] = useState(false);
  // Explicit values stored per settings key (null = key unset / inherits).
  const [maxConcurrent, setMaxConcurrent] = useState<{
    global: number | null;
    project: number | null;
  } | null>(null);
  const [maxConcurrentInput, setMaxConcurrentInput] = useState("");
  const [savingMaxConcurrent, setSavingMaxConcurrent] = useState(false);
  // Feedback under the field: the change is invisible otherwise, and a value
  // typed but never committed used to vanish on the next open.
  const [maxConcurrentStatus, setMaxConcurrentStatus] = useState<
    "idle" | "saved" | "error"
  >("idle");

  const projectScoped = scope === "project" && !!projectId;
  const maxConcurrentKey = projectScoped
    ? agentMaxConcurrentSettingKey(projectId!)
    : AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY;
  const savedMaxConcurrent = maxConcurrent
    ? projectScoped
      ? maxConcurrent.project
      : maxConcurrent.global
    : null;
  const inheritedMaxConcurrent = projectScoped
    ? maxConcurrent?.global ?? DEFAULT_MAX_CONCURRENT_AGENTS
    : DEFAULT_MAX_CONCURRENT_AGENTS;
  /** What the scheduler will actually enforce for this scope right now. */
  const effectiveMaxConcurrent = savedMaxConcurrent ?? inheritedMaxConcurrent;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        const value = json?.data?.[REVIEW_PROVIDER_SEGREGATION_SETTING_KEY];
        setSegregation(value === true || value === "true");

        const global = parseMaxConcurrentSetting(
          json?.data?.[AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY]
        );
        const project = projectId
          ? parseMaxConcurrentSetting(
              json?.data?.[agentMaxConcurrentSettingKey(projectId)]
            )
          : null;
        setMaxConcurrent({ global, project });
      })
      .catch(() => {
        if (!cancelled) {
          setSegregation(false);
          setMaxConcurrent({ global: null, project: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Re-seed the input whenever the loaded value or the scope changes, and drop
  // the previous save feedback with it — switching scope shows a different
  // setting. Adjusting state during render rather than in an effect keeps the
  // input from showing the outgoing scope's value for one commit.
  // Unlimited round-trips as 0 — "Infinity" is not a number-input value.
  const seed: [number | null, string] = [savedMaxConcurrent, maxConcurrentKey];
  const [seededFrom, setSeededFrom] = useState(seed);
  if (seededFrom[0] !== seed[0] || seededFrom[1] !== seed[1]) {
    setSeededFrom(seed);
    setMaxConcurrentInput(
      savedMaxConcurrent === null
        ? ""
        : Number.isFinite(savedMaxConcurrent)
          ? String(savedMaxConcurrent)
          : "0"
    );
    setMaxConcurrentStatus("idle");
  }

  async function toggleSegregation(next: boolean) {
    const previous = segregation;
    setSegregation(next);
    setSavingSegregation(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [REVIEW_PROVIDER_SEGREGATION_SETTING_KEY]: next ? "true" : "false",
        }),
      });
      if (!res.ok) setSegregation(previous);
    } catch {
      setSegregation(previous);
    }
    setSavingSegregation(false);
  }

  const trimmedMaxConcurrentInput = maxConcurrentInput.trim();
  const parsedMaxConcurrentInput =
    trimmedMaxConcurrentInput === ""
      ? null
      : parseMaxConcurrentSetting(trimmedMaxConcurrentInput);
  const maxConcurrentInputValid =
    trimmedMaxConcurrentInput === "" || parsedMaxConcurrentInput !== null;
  const maxConcurrentDirty =
    maxConcurrent !== null && parsedMaxConcurrentInput !== savedMaxConcurrent;

  /**
   * Persists the field. Called by the Save button, by Enter, and on blur —
   * a number typed and left there is a change the user made, and losing it
   * silently is what made this setting look like it did nothing.
   */
  async function saveMaxConcurrent() {
    if (
      !maxConcurrent ||
      !maxConcurrentInputValid ||
      !maxConcurrentDirty ||
      savingMaxConcurrent
    ) {
      return;
    }
    const nextValue = parsedMaxConcurrentInput;
    setSavingMaxConcurrent(true);
    setMaxConcurrentStatus("idle");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // null clears the key so the scope falls back to its inherited value.
        // Infinity is not valid JSON, so unlimited is stored as 0.
        body: JSON.stringify({
          [maxConcurrentKey]:
            nextValue === null
              ? null
              : Number.isFinite(nextValue)
                ? nextValue
                : 0,
        }),
      });
      if (res.ok) {
        setMaxConcurrent((prev) =>
          prev
            ? { ...prev, [projectScoped ? "project" : "global"]: nextValue }
            : prev
        );
        setMaxConcurrentStatus("saved");
      } else {
        setMaxConcurrentStatus("error");
      }
    } catch {
      // keep the dirty input; the user can retry
      setMaxConcurrentStatus("error");
    }
    setSavingMaxConcurrent(false);
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-1">
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-border">
          <Checkbox
            id="review-provider-segregation"
            checked={segregation === true}
            disabled={segregation === null || savingSegregation}
            onCheckedChange={(checked) => toggleSegregation(checked === true)}
          />
          <div className="space-y-1">
            <label
              htmlFor="review-provider-segregation"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Reviewer must differ from builder
            </label>
            <p className="text-xs text-muted-foreground">
              When enabled, review agents avoid the CLI that built the ticket,
              when another CLI is available. An explicitly picked named agent
              always wins. Applies globally.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-border">
          <div className="flex-1 space-y-1">
            <label
              htmlFor="agent-max-concurrent"
              className="text-sm font-medium leading-none cursor-pointer"
            >
              Max concurrent agents
            </label>
            <p className="text-xs text-muted-foreground">
              {projectScoped
                ? `How many batch agents (builds, reviews, merges, QA) may run at once for this project. Extra launches wait in a queue. 0 means no limit; leave empty to inherit the global default (${formatMaxConcurrent(inheritedMaxConcurrent)}).`
                : `Default cap on batch agents (builds, reviews, merges, QA) running at once per project. Extra launches wait in a queue. 0 means no limit; leave empty for the built-in default (${formatMaxConcurrent(DEFAULT_MAX_CONCURRENT_AGENTS)}).`}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="agent-max-concurrent-effective">
              {maxConcurrent === null
                ? "Loading…"
                : maxConcurrentStatus === "error"
                  ? "Could not save — try again."
                  : `In effect: ${formatMaxConcurrent(effectiveMaxConcurrent)}${
                      savedMaxConcurrent === null
                        ? projectScoped
                          ? " (inherited)"
                          : " (built-in)"
                        : ""
                    }${maxConcurrentStatus === "saved" ? " · saved" : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              id="agent-max-concurrent"
              type="number"
              min={0}
              step={1}
              value={maxConcurrentInput}
              onChange={(e) => setMaxConcurrentInput(e.target.value)}
              // Enter and blur commit too: the Save button alone meant a typed
              // value could be lost without a word.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveMaxConcurrent();
                }
              }}
              onBlur={() => saveMaxConcurrent()}
              placeholder={formatMaxConcurrent(inheritedMaxConcurrent)}
              disabled={maxConcurrent === null || savingMaxConcurrent}
              className="w-24 bg-transparent border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:border-primary"
            />
            <Button
              size="sm"
              onClick={saveMaxConcurrent}
              disabled={
                savingMaxConcurrent ||
                !maxConcurrentDirty ||
                !maxConcurrentInputValid
              }
            >
              {savingMaxConcurrent ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
