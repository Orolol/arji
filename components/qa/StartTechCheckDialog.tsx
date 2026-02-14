"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, Save, X } from "lucide-react";
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

interface QaPrompt {
  id: string;
  name: string;
  prompt: string;
}

interface StartTechCheckDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted?: (data: { reportId: string; sessionId: string }) => void;
}

export function StartTechCheckDialog({
  projectId,
  open,
  onOpenChange,
  onStarted,
}: StartTechCheckDialogProps) {
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customPromptId, setCustomPromptId] = useState<string | null>(null);
  const [savePromptName, setSavePromptName] = useState("");
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
    setNamedAgentId(null);
    setCustomPrompt("");
    setCustomPromptId(null);
    setSavePromptName("");
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
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok || !json.data) {
        setError(json.error || "Failed to start tech check");
        return;
      }

      onStarted?.(json.data as { reportId: string; sessionId: string });
      onOpenChange(false);
      resetForm();
    } catch {
      setError("Failed to start tech check");
    } finally {
      setStarting(false);
    }
  }

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
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Start Tech Check</DialogTitle>
          <DialogDescription>
            Launch a full project QA audit and generate a markdown report.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Named Agent (optional)</label>
            <div className="flex items-center gap-2">
              <NamedAgentSelect
                value={namedAgentId}
                onChange={setNamedAgentId}
                className="w-56 h-8 text-xs"
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
            <label className="text-xs text-muted-foreground">Saved Prompt</label>
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
            <label className="text-xs text-muted-foreground">Custom Prompt (optional)</label>
            <Textarea
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
              placeholder="Add custom QA instructions..."
              rows={8}
              className="text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <Input
              value={savePromptName}
              onChange={(event) => setSavePromptName(event.target.value)}
              placeholder="Prompt name for reuse"
              className="h-8 text-xs"
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
            Start Tech Check
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
