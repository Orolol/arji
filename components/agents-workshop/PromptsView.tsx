"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  ListChecks,
  Loader2,
  Plus,
  Scale,
  Shield,
} from "lucide-react";

import { FieldBoxInput } from "@/components/agents-workshop/FieldBox";
import { ScopeSwitcher } from "@/components/agents-workshop/ScopeSwitcher";
import { sourceLabel } from "@/components/agents-workshop/agent-initials";
import {
  BandHeader,
  Mono,
  PillButton,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import {
  useAgentPrompts,
  useReviewAgents,
  type CustomReviewAgent,
  type ResolvedAgentPrompt,
} from "@/hooks/useAgentConfig";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  DEFAULT_REVIEW_AGENT_PROMPT,
  type AgentType,
} from "@/lib/agent-config/constants";

/**
 * Role prompts and review agents.
 *
 * Frame 7a has no picture of this page — the workshop's tab bar names it and
 * the deleted sheet owned the behaviour, so this is a functional port in the
 * band grammar rather than pixel work. The textareas keep `font-mono`: they
 * hold prompt text, where alignment carries meaning.
 */
// `outline-none` on its own would leave a keyboard user with NO focus
// indicator at all; the ring is the replacement, matching the buttons below
// and FieldBoxInput's own focus treatment.
const PROMPT_TEXTAREA =
  "min-h-32 w-full resize-y rounded-[10px] border-0 bg-card px-3 py-2 font-mono text-[12.5px] leading-[1.5] text-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring placeholder:text-muted-foreground disabled:opacity-60";

export function PromptsView({ projectId }: { projectId?: string }) {
  const [scope, setScope] = useState<"global" | "project">(
    projectId ? "project" : "global",
  );
  const scopedProjectId = scope === "project" ? projectId : undefined;

  const { data, loading, updatePrompt, resetPrompt } = useAgentPrompts(
    scope,
    scopedProjectId,
  );

  const promptMap = new Map(data.map((prompt) => [prompt.agentType, prompt]));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto px-[14px] pb-[14px]">
      <ScopeSwitcher
        projectId={projectId}
        scope={scope}
        onScopeChange={setScope}
      />

      <StrataBand stratum="feed" density="full" gap={8}>
        <BandHeader
          stratum="feed"
          labelSize={12}
          label="Role prompts"
          meta="ce que chaque rôle fait quand il tourne — les valeurs actuelles marchent déjà"
        />
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-strata-feed-deep motion-reduce:animate-none" />
        ) : (
          <div className="flex flex-col gap-1.5">
            {AGENT_TYPES.map((agentType) => {
              // Every one of the 21 roles renders, even with no stored row:
              // a missing prompt is a builtin, not an absence.
              const prompt: ResolvedAgentPrompt = promptMap.get(agentType) ?? {
                agentType,
                systemPrompt: "",
                source: "builtin",
                scope: "global",
              };
              return (
                <PromptRow
                  key={agentType}
                  prompt={prompt}
                  scope={scope}
                  onSave={updatePrompt}
                  onReset={resetPrompt}
                />
              );
            })}
          </div>
        )}
      </StrataBand>

      <ReviewAgentsBand scope={scope} projectId={scopedProjectId} />
    </div>
  );
}

function PromptRow({
  prompt,
  scope,
  onSave,
  onReset,
}: {
  prompt: ResolvedAgentPrompt;
  scope: "global" | "project";
  onSave: (agentType: AgentType, text: string) => Promise<boolean>;
  onReset: (agentType: AgentType) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(prompt.systemPrompt);
  const [saving, setSaving] = useState(false);
  const dirty = value !== prompt.systemPrompt;
  const panelId = `agent-prompt-${prompt.agentType}-panel`;

  return (
    <SurfaceCard radius={10} className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex items-center gap-3 rounded-[9px] px-4 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-semibold text-foreground">
          {AGENT_TYPE_LABELS[prompt.agentType]}
        </span>
        <Mono size={10} tone="muted">
          {sourceLabel(prompt.source)}
        </Mono>
      </button>
      {expanded ? (
        <div id={panelId} className="flex flex-col gap-2 px-4 pb-3">
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Describe how this role should behave"
            aria-label={`${AGENT_TYPE_LABELS[prompt.agentType]} instructions`}
            className={PROMPT_TEXTAREA}
          />
          <div className="flex items-center justify-end gap-2">
            {/* Only a project-scoped override has anything to reset — the hook
                short-circuits to false in global scope. */}
            {scope === "project" && prompt.source === "project" ? (
              <PillButton
                variant="outline"
                outlineTone="neutral"
                size="sm"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  await onReset(prompt.agentType);
                  setSaving(false);
                }}
              >
                Reset to all projects
              </PillButton>
            ) : null}
            <PillButton
              variant="filled"
              size="sm"
              disabled={saving || !dirty}
              pending={saving}
              pendingLabel="Saving…"
              onClick={async () => {
                setSaving(true);
                await onSave(prompt.agentType, value);
                setSaving(false);
              }}
            >
              Save
            </PillButton>
          </div>
        </div>
      ) : null}
    </SurfaceCard>
  );
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

function ReviewAgentsBand({
  scope,
  projectId,
}: {
  scope: "global" | "project";
  projectId?: string;
}) {
  const { data, loading, createAgent, updateAgent, deleteAgent } =
    useReviewAgents(scope, projectId);

  return (
    <StrataBand stratum="next" density="full" gap={8}>
      <BandHeader
        stratum="next"
        labelSize={12}
        label="Review agents"
        meta="les quatre reviews intégrées, plus les vôtres"
      />

      <div className="flex flex-col gap-1.5">
        {BUILTIN_REVIEWS.map(({ agentType, label, icon: Icon }) => (
          <SurfaceCard
            key={agentType}
            radius={10}
            className="flex items-center gap-3 px-4 py-2.5"
          >
            <Icon className="h-4 w-4 shrink-0 text-strata-next-mid" />
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-foreground">
              {label}
            </span>
            <Mono size={10} tone="muted">
              Included
            </Mono>
          </SurfaceCard>
        ))}
      </div>
      <p className="font-sans text-[11.5px] text-strata-next-mid">
        Built-in review instructions are editable from the role prompts above.
      </p>

      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-strata-next-mid motion-reduce:animate-none" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {data.map((agent) => (
            <CustomReviewAgentRow
              key={agent.id}
              agent={agent}
              // A globally-defined reviewer read from inside a project is
              // shared, so it is read-only here: editing it would silently
              // change every other project too.
              inherited={scope === "project" && agent.source === "global"}
              onUpdate={updateAgent}
              onDelete={deleteAgent}
            />
          ))}
          <NewReviewAgentForm onCreate={createAgent} />
        </div>
      )}
    </StrataBand>
  );
}

function CustomReviewAgentRow({
  agent,
  inherited,
  onUpdate,
  onDelete,
}: {
  agent: CustomReviewAgent;
  inherited: boolean;
  onUpdate: (
    id: string,
    updates: { name?: string; systemPrompt?: string },
  ) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(agent.name);
  const [prompt, setPrompt] = useState(agent.systemPrompt);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== agent.name || prompt !== agent.systemPrompt;

  async function handleSave() {
    if (inherited) return;
    setError(null);
    setSaving(true);
    // Only what actually changed is sent.
    const updates: { name?: string; systemPrompt?: string } = {};
    if (name !== agent.name) updates.name = name;
    if (prompt !== agent.systemPrompt) updates.systemPrompt = prompt;
    try {
      const saved = await onUpdate(agent.id, updates);
      if (!saved) setError("Could not save this review agent. Try again.");
    } catch {
      setError(
        "Could not save this review agent. Check the connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (inherited) return;
    setError(null);
    setDeleting(true);
    try {
      const deleted = await onDelete(agent.id);
      if (!deleted) setError("Could not delete this review agent. Try again.");
    } catch {
      setError(
        "Could not delete this review agent. Check the connection and try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SurfaceCard radius={10} className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <FieldBoxInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={inherited}
          aria-label="Review agent name"
          placeholder="Agent name"
          className="flex-1"
        />
        <Mono size={10} tone="muted">
          {inherited ? "Shared across projects" : "Editable here"}
        </Mono>
      </div>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={inherited}
        aria-label="Review agent instructions"
        placeholder="Describe what this reviewer should check"
        className={`${PROMPT_TEXTAREA} bg-muted`}
      />
      {error ? (
        <p role="alert" className="font-sans text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      {!inherited ? (
        <div className="flex items-center justify-end gap-2">
          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="sm"
            labelTone="danger"
            onClick={handleDelete}
            disabled={saving}
            pending={deleting}
            pendingLabel="Deleting…"
          >
            Delete
          </PillButton>
          <PillButton
            variant="filled"
            size="sm"
            onClick={handleSave}
            disabled={deleting || !dirty}
            pending={saving}
            pendingLabel="Saving…"
          >
            Save
          </PillButton>
        </div>
      ) : null}
    </SurfaceCard>
  );
}

function NewReviewAgentForm({
  onCreate,
}: {
  onCreate: (name: string, systemPrompt: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  // Pre-filled on purpose: the form is meant to be useful after typing only a
  // name.
  const [prompt, setPrompt] = useState(DEFAULT_REVIEW_AGENT_PROMPT);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setName("");
    setPrompt(DEFAULT_REVIEW_AGENT_PROMPT);
    setError(null);
  }

  if (!open) {
    return (
      <PillButton
        variant="outline"
        outlineTone="neutral"
        size="sm"
        icon={Plus}
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        Add review agent
      </PillButton>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border-[1.5px] border-dashed border-border-strong p-4">
      <FieldBoxInput
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="New review agent name"
        placeholder="New agent name"
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        aria-label="New review agent instructions"
        placeholder="Describe what this reviewer should check"
        className={PROMPT_TEXTAREA}
      />
      {error ? (
        <p role="alert" className="font-sans text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          onClick={reset}
          disabled={creating}
        >
          Cancel
        </PillButton>
        <PillButton
          variant="filled"
          size="sm"
          disabled={!name.trim() || !prompt.trim()}
          pending={creating}
          pendingLabel="Creating…"
          onClick={async () => {
            if (!name.trim() || !prompt.trim()) return;
            setError(null);
            setCreating(true);
            try {
              const ok = await onCreate(name.trim(), prompt.trim());
              if (ok) {
                reset();
              } else {
                setError(
                  "Could not create this review agent. Check its name and try again.",
                );
              }
            } catch {
              setError(
                "Could not create this review agent. Check the connection and try again.",
              );
            } finally {
              setCreating(false);
            }
          }}
        >
          Create
        </PillButton>
      </div>
    </div>
  );
}
