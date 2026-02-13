"use client";

import { useState } from "react";
import { useReviewAgents, type CustomReviewAgent } from "@/hooks/useAgentConfig";
import { AGENT_TYPE_LABELS } from "@/lib/agent-config/constants";
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
  onUpdate,
  onDelete,
}: {
  agent: CustomReviewAgent;
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

  const dirty = name !== agent.name || prompt !== agent.systemPrompt;

  const handleSave = async () => {
    setSaving(true);
    const updates: { name?: string; systemPrompt?: string } = {};
    if (name !== agent.name) updates.name = name;
    if (prompt !== agent.systemPrompt) updates.systemPrompt = prompt;
    await onUpdate(agent.id, updates);
    setSaving(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(agent.id);
    setDeleting(false);
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 bg-transparent border-b border-border px-1 py-0.5 text-sm font-medium focus:outline-none focus:border-primary"
          placeholder="Agent name"
        />
        {agent.source && (
          <Badge
            variant={agent.source === "project" ? "default" : "secondary"}
            className="text-xs"
          >
            {agent.source}
          </Badge>
        )}
      </div>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="System prompt for this review agent..."
        className="min-h-24 text-sm font-mono"
      />
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
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setCreating(true);
    const ok = await onCreate(name.trim(), prompt.trim());
    if (ok) {
      setName("");
      setPrompt("");
      setOpen(false);
    }
    setCreating(false);
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
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full bg-transparent border-b border-border px-1 py-0.5 text-sm font-medium focus:outline-none focus:border-primary"
        placeholder="New agent name"
        autoFocus
      />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="System prompt..."
        className="min-h-24 text-sm font-mono"
      />
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setName("");
            setPrompt("");
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
                  builtin
                </Badge>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Built-in review prompts are editable from the Prompts tab.
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
