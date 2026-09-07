"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import {
  FieldKicker,
  PillButton,
  SegmentedControl,
  SelectPill,
  type SegmentedControlOption,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { NamedAgent } from "@/hooks/useAgentConfig";
import type { AgentProvider } from "@/lib/agent-config/constants";

import { CliDropdown } from "./CliDropdown";
import { FieldBoxInput } from "./FieldBox";

/**
 * The dashed create card at the foot of the roster.
 *
 * Clicking it swaps the body for the create form IN PLACE — no dialog. The
 * whole promise of the card is that creating an agent is small, and a modal
 * would contradict the copy directly underneath it.
 *
 * CREATE SEMANTICS THAT MUST NOT DRIFT: for a simple agent only
 * `{ name, provider }` is sent. `createNamedAgent` distinguishes an ABSENT
 * personaPrompt (→ apply the product default) from an explicit empty string
 * (→ no persona at all), so posting `personaPrompt: ""` from a form nobody
 * typed in would silently create persona-less agents.
 *
 * A COMPOSITE takes the other branch: a name and an ordered member list, and
 * nothing else. The two are one card with a kind switch rather than two cards,
 * because they answer the same question — "add an agent" — and the choice
 * between a CLI and a list is the whole distinction worth showing.
 */
type CreateKind = "simple" | "composite";

export interface AddAgentCardProps {
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  /** Simple agents only: the pool a new composite can be built from. */
  candidates: NamedAgent[];
  onCreate: (input: {
    name: string;
    provider: AgentProvider;
  }) => Promise<{ ok: boolean; error?: string }>;
  onCreateComposite: (input: {
    name: string;
    memberIds: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function AddAgentCard({
  availability,
  availabilityLoading,
  candidates,
  onCreate,
  onCreateComposite,
}: AddAgentCardProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CreateKind>("simple");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude-code");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = new Set(memberIds);
  const addable = candidates.filter((candidate) => !chosen.has(candidate.id));
  const canCreate =
    !!name.trim() && (kind === "simple" || memberIds.length > 0);

  const kindOptions: SegmentedControlOption<CreateKind>[] = [
    { value: "simple", label: "One CLI", flex: 1 },
    {
      value: "composite",
      label: "Composite",
      flex: 1,
      disabled: candidates.length === 0,
      hint:
        candidates.length === 0
          ? "a composite needs at least one existing agent to list"
          : undefined,
    },
  ];

  function reset() {
    setOpen(false);
    setKind("simple");
    setName("");
    setProvider("claude-code");
    setMemberIds([]);
    setError(null);
  }

  async function handleCreate() {
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    try {
      const result =
        kind === "composite"
          ? await onCreateComposite({ name: name.trim(), memberIds })
          : await onCreate({ name: name.trim(), provider });
      if (result.ok) {
        setName("");
        setProvider("claude-code");
        setMemberIds([]);
        setKind("simple");
        setOpen(false);
      } else {
        // A 409 here is a duplicate name the user needs to read.
        setError(result.error || "Could not create this agent. Try again.");
      }
    } catch {
      setError(
        "Could not create this agent. Check the connection and try again.",
      );
    } finally {
      setCreating(false);
    }
  }

  const shell =
    "shrink-0 rounded-[14px] border-[1.5px] border-dashed border-border-strong bg-transparent p-4";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${shell} flex flex-col gap-[5px] text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring`}
      >
        <span className="flex items-center gap-[7px] font-sans text-[13.5px] font-semibold text-foreground">
          <Plus size={14} aria-hidden="true" />
          Add agent
        </span>
        <span className="font-sans text-[12px] leading-[1.5] text-muted-foreground">
          A name and a CLI are all it takes — everything runs with sensible
          defaults.
        </span>
      </button>
    );
  }

  return (
    <div
      className={`${shell} flex flex-col gap-[10px]`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          reset();
        }
      }}
    >
      <div className="flex flex-col gap-[5px]">
        <FieldKicker stratum="card" size={10}>
          NAME
        </FieldKicker>
        <FieldBoxInput
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleCreate();
            }
          }}
          placeholder="e.g. Fast builder"
          aria-label="Name"
          disabled={creating}
        />
      </div>

      <div className="flex flex-col gap-[5px]">
        <FieldKicker stratum="card" size={10}>
          KIND
        </FieldKicker>
        <SegmentedControl<CreateKind>
          options={kindOptions}
          value={kind}
          onChange={setKind}
          chrome="bordered"
          size="md"
          wrap
        />
      </div>

      {kind === "simple" ? (
        <div className="flex flex-col gap-[5px]">
          <FieldKicker stratum="card" size={10}>
            CLI
          </FieldKicker>
          <CliDropdown
            value={provider}
            onChange={setProvider}
            availability={availability}
            availabilityLoading={availabilityLoading}
            disabled={creating}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-[5px]">
          <FieldKicker stratum="card" size={10}>
            FALLBACK LIST
          </FieldKicker>
          {memberIds.length > 0 ? (
            <ol
              data-testid="add-composite-members"
              className="flex flex-col gap-[3px] font-sans text-[12.5px] text-foreground"
            >
              {memberIds.map((id, index) => (
                <li key={id} className="flex min-w-0 items-baseline gap-[6px]">
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="truncate">
                    {candidates.find((candidate) => candidate.id === id)?.name ??
                      id}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="font-sans text-[12px] leading-[1.5] text-muted-foreground">
              Add agents in the order they should be tried. The list is the
              attempt budget.
            </p>
          )}
          <SelectPill
            tone="ink"
            fill="card"
            data-testid="add-composite-member"
            disabled={creating || addable.length === 0}
            label={addable.length === 0 ? "No agent left to add" : "Add agent"}
          >
            {addable.map((candidate) => (
              <DropdownMenuItem
                key={candidate.id}
                onSelect={() => setMemberIds((ids) => [...ids, candidate.id])}
              >
                {candidate.name}
                {candidate.model ? ` — ${candidate.model}` : " — CLI default"}
              </DropdownMenuItem>
            ))}
          </SelectPill>
        </div>
      )}

      {error ? (
        <p role="alert" className="font-sans text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <PillButton
          variant="filled"
          size="sm"
          onClick={handleCreate}
          disabled={!canCreate}
          pending={creating}
          pendingLabel="Adding…"
        >
          Add agent
        </PillButton>
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          onClick={reset}
          disabled={creating}
        >
          Cancel
        </PillButton>
      </div>
    </div>
  );
}
