import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { namedAgents } from "@/lib/db/schema";
import {
  DEFAULT_PERSONA_PROMPT,
  PERSONA_PROMPT_MAX_CHARS,
  isAgentProvider,
  type AgentProvider,
} from "@/lib/agent-config/constants";
import {
  normalizeProviderOptions,
  parseStoredProviderOptions,
  type NamedAgentCliOptions,
} from "@/lib/providers/options-registry";
import { createId } from "@/lib/utils/nanoid";

export interface NamedAgentRecord {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  /** Non-default per-CLI options only; `{}` means "all CLI defaults". */
  options: NamedAgentCliOptions;
  /** Persona injected at the head of the prompt; null injects nothing. */
  personaPrompt: string | null;
  escalatesTo: string | null;
  createdAt: string | null;
}

/**
 * Blank and whitespace-only personas are stored as NULL, so "cleared" is one
 * state rather than two that the prompt builder would have to tell apart.
 *
 * An over-long persona is REJECTED, not truncated. Truncating is the one
 * silent alteration this feature could make to a user-supplied value: the
 * editor keeps showing the full text it holds in local state, so the field
 * would read as saved while the tail had been dropped — and every option in
 * the registry already fails loudly instead. The error travels the same path
 * as an invalid option value and lands in the editor's alert.
 */
function normalizePersonaPrompt(
  value: string | null | undefined
): { persona: string | null; error?: string } {
  if (typeof value !== "string") return { persona: null };
  const trimmed = value.trim();
  if (!trimmed) return { persona: null };
  if (trimmed.length > PERSONA_PROMPT_MAX_CHARS) {
    return {
      persona: null,
      error: `Persona must be ${PERSONA_PROMPT_MAX_CHARS} characters or fewer (received ${trimmed.length})`,
    };
  }
  return { persona: trimmed };
}

function toRecord(row: typeof namedAgents.$inferSelect): NamedAgentRecord {
  const provider = normalizeProvider(row.provider) || "claude-code";
  return {
    id: row.id,
    name: row.name,
    provider,
    model: row.model,
    options: parseStoredProviderOptions(provider, row.options),
    personaPrompt: row.personaPrompt ?? null,
    escalatesTo: row.escalatesTo,
    createdAt: row.createdAt,
  };
}

function normalizeProvider(provider: string): AgentProvider | null {
  if (!isAgentProvider(provider)) return null;
  return provider;
}

export async function listNamedAgents(): Promise<NamedAgentRecord[]> {
  const rows = db
    .select()
    .from(namedAgents)
    .orderBy(namedAgents.name)
    .all();

  return rows.map(toRecord);
}

export async function getNamedAgent(agentId: string): Promise<NamedAgentRecord | null> {
  const row = db
    .select()
    .from(namedAgents)
    .where(eq(namedAgents.id, agentId))
    .get();

  if (!row) return null;

  return toRecord(row);
}

function normalizeEscalationTarget(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

/**
 * Validates the directed named-agent escalation graph before a write.
 *
 * The model ordering itself belongs to the user/provider configuration, but
 * every edge must stay on the same provider so the pipeline increases effort
 * before it changes provider. Walking the complete target chain rejects both
 * a direct self-link and longer cycles such as a -> b -> c -> a.
 */
function validateEscalationTarget(input: {
  agentId: string;
  provider: AgentProvider;
  escalatesTo: string | null;
}): string | null {
  if (!input.escalatesTo) return null;

  const visited = new Set<string>();
  let currentId: string | null = input.escalatesTo;

  while (currentId) {
    if (currentId === input.agentId || visited.has(currentId)) {
      return "Escalation cycle detected";
    }
    visited.add(currentId);

    const current = db
      .select({
        id: namedAgents.id,
        provider: namedAgents.provider,
        escalatesTo: namedAgents.escalatesTo,
      })
      .from(namedAgents)
      .where(eq(namedAgents.id, currentId))
      .get();
    if (!current) {
      return "Escalation agent not found";
    }
    if (current.provider !== input.provider) {
      return "Escalation agent must use the same provider";
    }
    currentId = current.escalatesTo;
  }

  return null;
}

/** A provider change must not invalidate agents that escalate into this one. */
function validateIncomingEscalations(
  agentId: string,
  provider: AgentProvider
): string | null {
  const incoming = db
    .select({ provider: namedAgents.provider })
    .from(namedAgents)
    .where(eq(namedAgents.escalatesTo, agentId))
    .all();

  return incoming.some((agent) => agent.provider !== provider)
    ? "Escalation agent must use the same provider"
    : null;
}

export async function createNamedAgent(input: {
  id?: string;
  name: string;
  provider: string;
  // Optional: empty/absent means "use the CLI's default model".
  model?: string;
  // Optional: absent means "every CLI option at its default".
  options?: unknown;
  /**
   * Optional. ABSENT applies the product default persona; an explicit empty
   * string creates an agent with no persona at all. The two are deliberately
   * distinguishable, which is why this is not defaulted at the schema layer.
   */
  personaPrompt?: string | null;
  escalatesTo?: string | null;
}): Promise<{ data: NamedAgentRecord | null; error?: string }> {
  const name = input.name.trim();
  const model = (input.model ?? "").trim();
  const provider = normalizeProvider(input.provider);

  if (!name) {
    return { data: null, error: "Name must not be empty" };
  }

  if (!provider) {
    return { data: null, error: "Invalid provider" };
  }

  const duplicate = db
    .select({ id: namedAgents.id })
    .from(namedAgents)
    .where(sql`LOWER(${namedAgents.name}) = LOWER(${name})`)
    .get();
  if (duplicate) {
    return { data: null, error: "name already exists" };
  }

  const { options, errors } = normalizeProviderOptions(provider, input.options);
  if (errors.length > 0) {
    return { data: null, error: errors[0] };
  }

  let personaPrompt: string | null = DEFAULT_PERSONA_PROMPT;
  if (input.personaPrompt !== undefined) {
    const persona = normalizePersonaPrompt(input.personaPrompt);
    if (persona.error) {
      return { data: null, error: persona.error };
    }
    personaPrompt = persona.persona;
  }

  const id = input.id || createId();
  const escalatesTo = normalizeEscalationTarget(input.escalatesTo);
  const escalationError = validateEscalationTarget({
    agentId: id,
    provider,
    escalatesTo,
  });
  if (escalationError) {
    return { data: null, error: escalationError };
  }

  db.insert(namedAgents)
    .values({
      id,
      name,
      provider,
      model,
      options: JSON.stringify(options),
      personaPrompt,
      escalatesTo,
      createdAt: new Date().toISOString(),
    })
    .run();

  const created = await getNamedAgent(id);
  return { data: created };
}

export async function updateNamedAgent(
  agentId: string,
  updates: {
    name?: string;
    provider?: string;
    model?: string;
    options?: unknown;
    personaPrompt?: string | null;
    escalatesTo?: string | null;
  }
): Promise<{ data: NamedAgentRecord | null; error?: string }> {
  const existing = db
    .select()
    .from(namedAgents)
    .where(eq(namedAgents.id, agentId))
    .get();
  if (!existing) {
    return { data: null, error: "Named agent not found" };
  }

  const patch: Partial<typeof namedAgents.$inferInsert> = {};

  if (typeof updates.name === "string") {
    const name = updates.name.trim();
    if (!name) {
      return { data: null, error: "name is required" };
    }

    const duplicate = db
      .select({ id: namedAgents.id })
      .from(namedAgents)
      .where(
        and(
          sql`LOWER(${namedAgents.name}) = LOWER(${name})`,
          sql`${namedAgents.id} != ${agentId}`
        )
      )
      .get();
    if (duplicate) {
      return { data: null, error: "name already exists" };
    }

    patch.name = name;
  }

  if (typeof updates.provider === "string") {
    const provider = normalizeProvider(updates.provider);
    if (!provider) {
      return { data: null, error: "invalid provider" };
    }
    patch.provider = provider;
  }

  if (typeof updates.model === "string") {
    // Empty string clears the override: the agent then uses the CLI's default.
    patch.model = updates.model.trim();
  }

  if (updates.personaPrompt !== undefined) {
    const persona = normalizePersonaPrompt(updates.personaPrompt);
    if (persona.error) {
      return { data: null, error: persona.error };
    }
    patch.personaPrompt = persona.persona;
  }

  if (updates.escalatesTo !== undefined) {
    patch.escalatesTo = normalizeEscalationTarget(updates.escalatesTo);
  }

  const effectiveProvider = normalizeProvider(patch.provider ?? existing.provider);
  // Existing rows can only contain valid providers, but retain the defensive
  // check for databases modified outside Arij.
  if (!effectiveProvider) {
    return { data: null, error: "invalid provider" };
  }
  const effectiveEscalatesTo =
    updates.escalatesTo !== undefined
      ? normalizeEscalationTarget(updates.escalatesTo)
      : existing.escalatesTo;
  const escalationError = validateEscalationTarget({
    agentId,
    provider: effectiveProvider,
    escalatesTo: effectiveEscalatesTo,
  });
  if (escalationError) {
    return { data: null, error: escalationError };
  }
  const incomingError = validateIncomingEscalations(agentId, effectiveProvider);
  if (incomingError) {
    return { data: null, error: incomingError };
  }

  // Options are validated against the EFFECTIVE provider, and re-validated
  // even when the caller sent none: changing an agent's CLI has to drop the
  // previous CLI's options rather than leave them stored, unreachable from
  // the editor and unread by the spawn.
  //
  // The two paths differ in what an unusable value means. A value the CALLER
  // just sent is a mistake worth reporting. A value already STORED that the
  // new CLI cannot express is not the user's mistake — it is the cost of
  // switching CLI, so it resets silently rather than making the agent
  // unsaveable until someone hand-edits a bag the editor no longer shows.
  let nextOptions: string;
  if (updates.options !== undefined) {
    const explicit = normalizeProviderOptions(effectiveProvider, updates.options);
    if (explicit.errors.length > 0) {
      return { data: null, error: explicit.errors[0] };
    }
    nextOptions = JSON.stringify(explicit.options);
  } else {
    const carried = normalizeProviderOptions(
      effectiveProvider,
      parseStoredProviderOptions(existing.provider, existing.options),
    );
    nextOptions = JSON.stringify(carried.options);
  }
  if (nextOptions !== (existing.options ?? "{}")) {
    patch.options = nextOptions;
  }

  if (Object.keys(patch).length === 0) {
    return { data: await getNamedAgent(agentId) };
  }

  db.update(namedAgents)
    .set(patch)
    .where(eq(namedAgents.id, agentId))
    .run();

  return { data: await getNamedAgent(agentId) };
}

export async function deleteNamedAgent(agentId: string): Promise<boolean> {
  const result = db.delete(namedAgents).where(eq(namedAgents.id, agentId)).run();
  return result.changes > 0;
}

export interface NamedAgentRuntimeConfig {
  /** Options valid for the SPAWNING provider; `{}` when there are none. */
  options: NamedAgentCliOptions;
  /** Persona to inject, already trimmed; null injects nothing. */
  personaPrompt: string | null;
}

const NO_RUNTIME_CONFIG: NamedAgentRuntimeConfig = {
  options: {},
  personaPrompt: null,
};

/**
 * The per-CLI options and persona a spawn should apply, read straight from
 * the agent row. Synchronous because it runs on the spawn path, next to the
 * other better-sqlite3 reads in processManager.start().
 *
 * Options are validated against the provider the session is ACTUALLY spawning
 * on, not the provider stored on the agent. The two normally agree, but a
 * mismatch (a row edited outside Arij, a redirect) must degrade to "no
 * options" rather than hand another CLI's flags to a child process that would
 * reject them fatally.
 *
 * The persona is provider-independent: it is prompt text, not argv.
 */
export function getNamedAgentRuntimeConfig(
  agentId: string | null | undefined,
  provider: string | null | undefined,
): NamedAgentRuntimeConfig {
  if (!agentId) return NO_RUNTIME_CONFIG;

  const row = db
    .select({
      provider: namedAgents.provider,
      options: namedAgents.options,
      personaPrompt: namedAgents.personaPrompt,
    })
    .from(namedAgents)
    .where(eq(namedAgents.id, agentId))
    .get();

  if (!row) return NO_RUNTIME_CONFIG;

  return {
    options:
      row.provider === provider
        ? parseStoredProviderOptions(provider, row.options)
        : {},
    // Stored rows are already within the limit; an over-long value can only
    // come from a hand-edited database, and it injects nothing rather than
    // an arbitrarily long preamble.
    personaPrompt: normalizePersonaPrompt(row.personaPrompt).persona,
  };
}
