"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Play, Save, X } from "lucide-react";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type CheckType = "tech_check" | "e2e_test" | "failure_digest";

interface QaPrompt {
  id: string;
  name: string;
  prompt: string;
}

interface StartQaCheckDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: (data: {
    reportId: string;
    sessionId: string | null;
    noOp?: boolean;
  }) => void;
}

const CHECK_TYPE_CONFIG: Record<CheckType, { title: string; description: string }> = {
  tech_check: {
    title: "Start Tech Check",
    description: "Launch a full project QA audit and generate a markdown report.",
  },
  e2e_test: {
    title: "Start E2E Test",
    description: "Run comprehensive end-to-end tests across all app features.",
  },
  failure_digest: {
    title: "Start Failure Digest",
    description:
      "Analyze mechanically grouped recurring failures in a read-only plan session.",
  },
};

export function StartQaCheckDialog({
  projectId,
  open,
  onOpenChange,
  onStarted,
}: StartQaCheckDialogProps) {
  const [checkType, setCheckType] = useState<CheckType>("tech_check");
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customPromptId, setCustomPromptId] = useState<string | null>(null);
  const [savePromptName, setSavePromptName] = useState("");
  const [failureDigestWindowDays, setFailureDigestWindowDays] = useState("14");
  const [prompts, setPrompts] = useState<QaPrompt[]>([]);
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPrompts() {
    setLoadingPrompts(true);
    try {
      const res = await fetch("/api/qa/prompts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to load saved prompts");
        return;
      }
      setPrompts((json.data || []) as QaPrompt[]);
    } catch {
      setError("Failed to load saved prompts");
    } finally {
      setLoadingPrompts(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    void loadPrompts();
  }, [open]);

  function resetForm() {
    setCheckType("tech_check");
    setNamedAgentId(null);
    setCustomPrompt("");
    setCustomPromptId(null);
    setSavePromptName("");
    setFailureDigestWindowDays("14");
    setError(null);
  }

  async function handleSavePrompt() {
    const name = savePromptName.trim();
    const prompt = customPrompt.trim();
    if (!name || !prompt) return;

    setSavingPrompt(true);
    setError(null);

    try {
      const res = await fetch("/api/qa/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || "Failed to save prompt");
        return;
      }

      const newPromptId =
        typeof json.data?.id === "string" ? json.data.id : null;
      await loadPrompts();
      setSavePromptName("");
      if (newPromptId) {
        setCustomPromptId(newPromptId);
      }
    } catch {
      setError("Failed to save prompt");
    } finally {
      setSavingPrompt(false);
    }
  }

  function handlePromptSelect(value: string) {
    if (value === "__none__") {
      setCustomPromptId(null);
      return;
    }

    const selected = prompts.find((prompt) => prompt.id === value);
    if (!selected) return;
    setCustomPromptId(selected.id);
    setCustomPrompt(selected.prompt);
  }

  async function handleStart() {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/qa/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          namedAgentId,
          customPrompt,
          customPromptId,
          checkType,
          ...(checkType === "failure_digest"
            ? { windowDays: Number(failureDigestWindowDays) }
            : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json.data) {
        setError(json.error || `Failed to start ${config.title.replace(/^Start /, "")}`);
        return;
      }

      onStarted?.(
        json.data as {
          reportId: string;
          sessionId: string | null;
          noOp?: boolean;
        },
      );
      onOpenChange(false);
      resetForm();
    } catch {
      setError(`Failed to start ${config.title.replace(/^Start /, "")}`);
    } finally {
      setStarting(false);
    }
  }

  const config = CHECK_TYPE_CONFIG[checkType];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          resetForm();
        }
      }}
    >
      <DialogContent className="sm:max-w-[680px] rounded-[14px] shadow-[0_18px_40px_rgba(58,48,44,.14)]">
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <label className="text-[12.5px] text-muted-foreground">Check Type</label>
            <Select
              value={checkType}
              onValueChange={(value) => setCheckType(value as CheckType)}
            >
              <SelectTrigger className="h-[34px] rounded-[8px] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tech_check">Tech Check</SelectItem>
                <SelectItem value="e2e_test">E2E Test</SelectItem>
                <SelectItem value="failure_digest">Failure Digest</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {checkType === "e2e_test" && (
            <div className="flex items-start gap-2 rounded-[10px] border border-priority-yellow/40 bg-priority-yellow/10 p-3">
              <AlertTriangle className="h-4 w-4 text-priority-yellow mt-0.5 shrink-0" />
              <p className="text-[12.5px] leading-[1.55] text-priority-yellow">
                E2E testing requires an agent with access to browser automation and testing tools
                (e.g. Playwright, Puppeteer). Ensure your selected agent has the appropriate tool
                permissions.
              </p>
            </div>
          )}

          {checkType === "failure_digest" && (
            <div className="space-y-1.5">
              <label
                htmlFor="failure-digest-window"
                className="text-[12.5px] text-muted-foreground"
              >
                Collection Window (days)
              </label>
              <Input
                id="failure-digest-window"
                type="number"
                min={1}
                step={1}
                value={failureDigestWindowDays}
                onChange={(event) => setFailureDigestWindowDays(event.target.value)}
                className="h-[34px] w-32 rounded-[8px] text-[13px]"
              />
              <p className="text-[11px] text-muted-foreground">
                If the window is empty, Arij records a completed no-op report
                without launching an agent.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[12.5px] text-muted-foreground">Named Agent (optional)</label>
            <div className="flex items-center gap-2">
              <NamedAgentSelect
                value={namedAgentId}
                onChange={setNamedAgentId}
                className="w-56 h-[34px] rounded-[8px] text-[13px]"
                dispatchRole="qa"
              />
              {namedAgentId && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setNamedAgentId(null)}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Use Default
                </Button>
              )}
            </div>
            {!namedAgentId && (
              <p className="text-[11px] text-muted-foreground">
                No agent selected: Arij will automatically use the configured default.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] text-muted-foreground">Saved Prompt</label>
            <Select
              value={customPromptId ?? "__none__"}
              onValueChange={handlePromptSelect}
              disabled={loadingPrompts}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue
                  placeholder={loadingPrompts ? "Loading prompts..." : "Select saved prompt"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {prompts.map((prompt) => (
                  <SelectItem key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12.5px] text-muted-foreground">Custom Prompt (optional)</label>
            <Textarea
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
              placeholder="Add custom QA instructions..."
              rows={8}
              className="rounded-[10px] text-[13.5px] leading-[1.6]"
            />
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={savePromptName}
              onChange={(event) => setSavePromptName(event.target.value)}
              placeholder="Prompt name for reuse"
              className="h-[34px] rounded-[8px] text-[13px]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={handleSavePrompt}
              disabled={!savePromptName.trim() || !customPrompt.trim() || savingPrompt}
            >
              {savingPrompt ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              Save Prompt
            </Button>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              resetForm();
            }}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={starting}>
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Play className="h-4 w-4 mr-1" />
            )}
            {config.title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
