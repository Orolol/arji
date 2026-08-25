"use client";

import { useState } from "react";
import { useReviewAgents, type CustomReviewAgent } from "@/hooks/useAgentConfig";
import {
  AGENT_TYPE_LABELS,
  DEFAULT_REVIEW_AGENT_PROMPT,
} from "@/lib/agent-config/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Plus,
  Trash2,
  Save,
  Loader2,
  Shield,
  Code2,
  Scale,
  ListChecks,
} from "lucide-react";
import { Field } from "@/components/agent-config/Field";

interface ReviewAgentsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

const BUILTIN_REVIEWS = [
  {
    agentType: "review_security" as const,
    label: AGENT_TYPE_LABELS.review_security,
    icon: Shield,
  },
  {
    agentType: "review_code" as const,
    label: AGENT_TYPE_LABELS.review_code,
    icon: Code2,
  },
  {
    agentType: "review_compliance" as const,
    label: AGENT_TYPE_LABELS.review_compliance,
    icon: Scale,
  },
  {
    agentType: "review_feature" as const,
    label: AGENT_TYPE_LABELS.review_feature,
    icon: ListChecks,
  },
];

function CustomAgentRow({
  agent,
  inherited,
  onUpdate,
  onDelete,
}: {
  agent: CustomReviewAgent;
  inherited: boolean;
  onUpdate: (
    id: string,
    updates: { name?: string; systemPrompt?: string }
  ) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(agent.name);
  const [prompt, setPrompt] = useState(agent.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== agent.name || prompt !== agent.systemPrompt;

  const handleSave = async () => {
    if (inherited) return;
    setError(null);
    setSaving(true);
    const updates: { name?: string; systemPrompt?: string } = {};
    if (name !== agent.name) updates.name = name;
    if (prompt !== agent.systemPrompt) updates.systemPrompt = prompt;
    try {
      const saved = await onUpdate(agent.id, updates);
      if (!saved) setError("Could not save this review agent. Try again.");
    } catch {
      setError(
        "Could not save this review agent. Check the connection and try again."
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (inherited) return;
    setError(null);
    setDeleting(true);
    try {
      const deleted = await onDelete(agent.id);
      if (!deleted) setError("Could not delete this review agent. Try again.");
    } catch {
      setError(
        "Could not delete this review agent. Check the connection and try again."
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex justify-end">
        <Badge variant="outline" className="text-xs">
          {inherited ? "Shared across projects" : "Editable here"}
        </Badge>
      </div>
      <Field
        id={`review-agent-name-${agent.id}`}
        label="Name"
        hint={
          inherited
            ? "This reviewer is shared. Switch to All projects to change it."
            : "How you recognise this reviewer in lists and reports."
        }
      >
        <input
          id={`review-agent-name-${agent.id}`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={inherited}
          className="w-full bg-transparent border-b border-border px-1 py-0.5 text-sm font-medium focus:outline-none focus:border-primary"
          placeholder="Agent name"
        />
      </Field>
      <Field
        id={`review-agent-prompt-${agent.id}`}
        label="Instructions"
        hint={
          inherited
            ? "These shared checks apply to every project and are read-only here."
            : "What this reviewer should look for. Edit only if its current checks don't match your needs."
        }
      >
        <Textarea
          id={`review-agent-prompt-${agent.id}`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={inherited}
          placeholder="Describe what this reviewer should check"
          className="min-h-24 text-sm font-mono"
        />
      </Field>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!inherited && (
        <div className="flex items-center gap-2 justify-end">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Trash2 className="h-3 w-3 mr-1" />
            )}
            Delete
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Save className="h-3 w-3 mr-1" />
            )}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function NewAgentForm({
  onCreate,
}: {
  onCreate: (name: string, systemPrompt: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_REVIEW_AGENT_PROMPT);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setError(null);
    setCreating(true);
    try {
      const ok = await onCreate(name.trim(), prompt.trim());
      if (ok) {
        setName("");
        setPrompt(DEFAULT_REVIEW_AGENT_PROMPT);
        setOpen(false);
      } else {
        setError(
          "Could not create this review agent. Check its name and try again."
        );
      }
    } catch {
      setError(
        "Could not create this review agent. Check the connection and try again."
      );
    } finally {
      setCreating(false);
    }
  };

  if (!open) {
    return (
      <Button
        variant="outline"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4 mr-2" />
        Add Review Agent
      </Button>
    );
  }

  return (
    <div className="border border-dashed border-border rounded-lg p-4 space-y-3">
      <Field
        id="new-review-agent-name"
        label="Name"
        hint="A short name you will recognise in review reports."
      >
        <input
          id="new-review-agent-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-transparent border-b border-border px-1 py-0.5 text-sm font-medium focus:outline-none focus:border-primary"
          placeholder="New agent name"
          autoFocus
        />
      </Field>
      <Field
        id="new-review-agent-prompt"
        label="Instructions"
        hint="Pre-filled with sensible default checks — adjust it only if you want this reviewer to focus on something specific."
      >
        <Textarea
          id="new-review-agent-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what this reviewer should check"
          className="min-h-24 text-sm font-mono"
        />
      </Field>
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setName("");
            setPrompt(DEFAULT_REVIEW_AGENT_PROMPT);
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={creating || !name.trim() || !prompt.trim()}
        >
          {creating ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Plus className="h-3 w-3 mr-1" />
          )}
          Create
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReviewAgentsTab({ scope, projectId }: ReviewAgentsTabProps) {
  const { data, loading, createAgent, updateAgent, deleteAgent } =
    useReviewAgents(scope, projectId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-1">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Built-in Review Types
          </h3>
          <div className="space-y-1">
            {BUILTIN_REVIEWS.map(({ agentType, label, icon: Icon }) => (
              <div
                key={agentType}
                className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-border bg-muted/30"
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm">{label}</span>
                <Badge variant="outline" className="ml-auto text-xs">
                  Included
                </Badge>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Built-in review instructions are editable from the Instructions tab.
          </p>
        </div>

        <div className="border-t border-border pt-4">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Custom Review Agents
          </h3>
          <div className="space-y-2">
            {data.map((agent) => (
              <CustomAgentRow
                key={agent.id}
                agent={agent}
                inherited={scope === "project" && agent.source === "global"}
                onUpdate={updateAgent}
                onDelete={deleteAgent}
              />
            ))}
            <NewAgentForm onCreate={createAgent} />
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
