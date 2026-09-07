"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";

import { FieldKicker, PillButton } from "@/components/piscine";
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
 * CREATE SEMANTICS THAT MUST NOT DRIFT: only `{ name, provider }` is sent.
 * `createNamedAgent` distinguishes an ABSENT personaPrompt (→ apply the
 * product default) from an explicit empty string (→ no persona at all), so
 * posting `personaPrompt: ""` from a form nobody typed in would silently
 * create persona-less agents.
 */
export interface AddAgentCardProps {
  availability: Record<AgentProvider, boolean>;
  availabilityLoading: boolean;
  onCreate: (input: {
    name: string;
    provider: AgentProvider;
  }) => Promise<{ ok: boolean; error?: string }>;
}

export function AddAgentCard({
  availability,
  availabilityLoading,
  onCreate,
}: AddAgentCardProps) {
  const t = useTranslations("AgentsWorkshop");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude-code");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setName("");
    setProvider("claude-code");
    setError(null);
  }

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    setCreating(true);
    try {
      const result = await onCreate({ name: name.trim(), provider });
      if (result.ok) {
        setName("");
        setProvider("claude-code");
        setOpen(false);
      } else {
        // A 409 here is a duplicate name the user needs to read.
        setError(result.error || t("roster.createFailed"));
      }
    } catch {
      setError(t("roster.createFailedConnection"));
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
          {t("roster.addAgent")}
        </span>
        <span className="font-sans text-[12px] leading-[1.5] text-muted-foreground">
          {t("roster.addAgentHint")}
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
          {t("identity.nameKicker")}
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
          placeholder={t("roster.namePlaceholder")}
          aria-label={t("identity.nameAria")}
          disabled={creating}
        />
      </div>

      <div className="flex flex-col gap-[5px]">
        <FieldKicker stratum="card" size={10}>
          {t("identity.cliKicker")}
        </FieldKicker>
        <CliDropdown
          value={provider}
          onChange={setProvider}
          availability={availability}
          availabilityLoading={availabilityLoading}
          disabled={creating}
        />
      </div>

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
          disabled={!name.trim()}
          pending={creating}
          pendingLabel={t("roster.adding")}
        >
          {t("roster.addAgent")}
        </PillButton>
        <PillButton
          variant="outline"
          outlineTone="neutral"
          size="sm"
          onClick={reset}
          disabled={creating}
        >
          {t("common.cancel")}
        </PillButton>
      </div>
    </div>
  );
}
