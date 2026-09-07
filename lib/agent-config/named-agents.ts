import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { compositeAgentMembers, namedAgents } from "@/lib/db/schema";
import {
  COMPOSITE_AGENT_KIND,
  COMPOSITE_AGENT_MODEL,
  COMPOSITE_AGENT_PROVIDER,
  DEFAULT_PERSONA_PROMPT,
  PERSONA_PROMPT_MAX_CHARS,
  SIMPLE_AGENT_KIND,
  isAgentProvider,
  type AgentProvider,
  type NamedAgentKind,
} from "@/lib/agent-config/constants";
import {
  listCompositeMembers,
  listMembersByComposite,
  readDefaultCompositeAgentId,
  validateCompositeMembers,
  writeCompositeMembers,
  type CompositeMember,
} from "@/lib/agent-config/composite-agents";
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
  /** 'simple' | 'composite'. See lib/agent-config/composite-agents.ts. */
  kind: NamedAgentKind;
  /**
   * Ordered fallback list — populated for a composite, empty for a simple
   * agent. Attempt N of a stage runs `members[N - 1]`.
   */
  members: CompositeMember[];
  /** True for the composite currently designated as the default agent. */
  isDefault: boolean;
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

/**
 * A composite carries the documented sentinels in the two NOT NULL columns it
 * does not own. `toRecord` reports them verbatim rather than laundering them
 * into `claude-code` / a model string, because a caller that reads a
 * composite's provider is asking the wrong question and must not receive a
 * plausible answer.
 */
function toRecord(
  row: typeof namedAgents.$inferSelect,
  context?: {
    defaultCompositeId?: string | null;
    /**
     * Every composite's membership, fetched once by the caller. Absent means
     * "read this row's members yourself", which is right for a single-row
     * read and wrong for a list — see `listNamedAgents`.
     */
    membersByComposite?: Map<string, CompositeMember[]>;
  },
): NamedAgentRecord {
  const kind: NamedAgentKind =
    row.kind === COMPOSITE_AGENT_KIND ? COMPOSITE_AGENT_KIND : SIMPLE_AGENT_KIND;
  const isComposite = kind === COMPOSITE_AGENT_KIND;
  const provider = isComposite
    ? (COMPOSITE_AGENT_PROVIDER as unknown as AgentProvider)
    : normalizeProvider(row.provider) || "claude-code";
  const defaultCompositeId =
    context?.defaultCompositeId !== undefined
      ? context.defaultCompositeId
      : readDefaultCompositeAgentId();

  return {
    id: row.id,
    name: row.name,
    provider,
    model: isComposite ? COMPOSITE_AGENT_MODEL : row.model,
    options: isComposite
      ? {}
      : parseStoredProviderOptions(row.provider, row.options),
    personaPrompt: isComposite ? null : (row.personaPrompt ?? null),
    kind,
    members: isComposite
      ? (context?.membersByComposite?.get(row.id) ??
        listCompositeMembers(row.id))
      : [],
    isDefault: isComposite && row.id === defaultCompositeId,
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

  // One settings read AND one membership join for the whole list, rather than
  // one of each per row. This route feeds every agent picker in the app, so a
  // query per composite here is the N+1 shape the codebase's own convention
  // flags — `listMembersByComposite` exists for exactly this call site.
  const defaultCompositeId = readDefaultCompositeAgentId();
  const membersByComposite = listMembersByComposite();
  return rows.map((row) =>
    toRecord(row, { defaultCompositeId, membersByComposite })
  );
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

  db.insert(namedAgents)
    .values({
      id,
      name,
      provider,
      model,
      options: JSON.stringify(options),
      personaPrompt,
      kind: SIMPLE_AGENT_KIND,
      createdAt: new Date().toISOString(),
    })
    .run();

  const created = await getNamedAgent(id);
  return { data: created };
}

/**
 * Creates a composite agent: a `named_agents` row of kind `composite` plus its
 * ordered membership.
 *
 * The row shares the name space (and the unique index) of simple agents on
 * purpose — a composite is assignable everywhere a named agent is, so two
 * agents called the same thing would be ambiguous in every picker.
 *
 * The provider and model columns receive their documented sentinels. Nothing
 * ever spawns them: `COMPOSITE_AGENT_PROVIDER` is deliberately absent from
 * `PROVIDER_OPTIONS`, so `isAgentProvider()` rejects it, and resolution
 * unfolds to a member before any provider is read.
 *
 * Row and membership are written in ONE transaction. A composite that existed
 * for even an instant with zero members would be an unusable agent that the
 * pickers already offer.
 */
export async function createCompositeAgent(input: {
  id?: string;
  name: string;
  memberIds: string[];
}): Promise<{ data: NamedAgentRecord | null; error?: string }> {
  const name = input.name.trim();
  if (!name) {
    return { data: null, error: "Name must not be empty" };
  }

  const duplicate = db
    .select({ id: namedAgents.id })
    .from(namedAgents)
    .where(sql`LOWER(${namedAgents.name}) = LOWER(${name})`)
    .get();
  if (duplicate) {
    return { data: null, error: "name already exists" };
  }

  const id = input.id || createId();
  const membersError = validateCompositeMembers(id, input.memberIds);
  if (membersError) {
    return { data: null, error: membersError };
  }

  const createdAt = new Date().toISOString();
  db.transaction((tx) => {
    tx.insert(namedAgents)
      .values({
        id,
        name,
        provider: COMPOSITE_AGENT_PROVIDER,
        model: COMPOSITE_AGENT_MODEL,
        options: "{}",
        personaPrompt: null,
        kind: COMPOSITE_AGENT_KIND,
        createdAt,
      })
      .run();
    input.memberIds.forEach((memberId, index) => {
      tx.insert(compositeAgentMembers)
        .values({
          id: createId(),
          compositeId: id,
          memberId,
          position: index,
          createdAt,
        })
        .run();
    });
  });

  return { data: await getNamedAgent(id) };
}

/**
 * Update path for a composite: its name and its ordered member list.
 *
 * Reordering is a full replacement of the membership rather than a diff — see
 * `setCompositeMembers` for why the uniquely-indexed position column makes a
 * diff collide with itself mid-update.
 */
async function updateCompositeAgent(
  agentId: string,
  existing: typeof namedAgents.$inferSelect,
  updates: {
    name?: string;
    provider?: string;
    model?: string;
    options?: unknown;
    personaPrompt?: string | null;
    memberIds?: string[];
  }
): Promise<{ data: NamedAgentRecord | null; error?: string }> {
  if (
    updates.provider !== undefined ||
    updates.model !== undefined ||
    updates.options !== undefined ||
    updates.personaPrompt !== undefined
  ) {
    return {
      data: null,
      error:
        "A composite agent has no CLI, model, options or persona of its own — those belong to its members",
    };
  }

  // VALIDATE EVERYTHING BEFORE WRITING ANYTHING. The rename and the member
  // list are the whole of a composite's update, and they used to be two
  // sequential writes: the rename committed first, then `setCompositeMembers`
  // validated and could refuse. The route answered 400 and the workshop
  // showed the error while the new name had already persisted — and because
  // the hook only reloads the roster on success, the user was left looking at
  // a failure message next to a name that had silently changed.
  let nextName: string | null = null;
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
    if (name !== existing.name) nextName = name;
  }

  if (updates.memberIds !== undefined) {
    const error = validateCompositeMembers(agentId, updates.memberIds);
    if (error) return { data: null, error };
  }

  const memberIds = updates.memberIds;
  if (nextName !== null || memberIds !== undefined) {
    // One transaction, matching createCompositeAgent: a refused half can no
    // longer leave the other half committed. Delete-then-insert rather than a
    // diff for the same reason as setCompositeMembers — `position` is
    // uniquely indexed per composite, so a reorder that moves two members
    // past each other would collide mid-update.
    const now = new Date().toISOString();
    db.transaction((tx) => {
      if (nextName !== null) {
        tx.update(namedAgents)
          .set({ name: nextName })
          .where(eq(namedAgents.id, agentId))
          .run();
      }
      if (memberIds !== undefined) {
        writeCompositeMembers(tx, agentId, memberIds, now);
      }
    });
  }

  return { data: await getNamedAgent(agentId) };
}

export async function updateNamedAgent(
  agentId: string,
  updates: {
    name?: string;
    provider?: string;
    model?: string;
    options?: unknown;
    personaPrompt?: string | null;
    /** Composite only: the new ordered member list. */
    memberIds?: string[];
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

  // A COMPOSITE owns no provider, model, options or persona, so the update
  // path for one is a different shape rather than the same one with fields
  // ignored: name, and the ordered member list. Sending provider/model here
  // is a caller bug, and it is refused rather than silently dropped — a
  // silent drop is how a UI ends up believing it saved a CLI choice.
  if (existing.kind === COMPOSITE_AGENT_KIND) {
    return updateCompositeAgent(agentId, existing, updates);
  }

  if (updates.memberIds !== undefined) {
    return {
      data: null,
      error: "Only a composite agent has members",
    };
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

  const effectiveProvider = normalizeProvider(patch.provider ?? existing.provider);
  // Existing rows can only contain valid providers, but retain the defensive
  // check for databases modified outside Arij.
  if (!effectiveProvider) {
    return { data: null, error: "invalid provider" };
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
