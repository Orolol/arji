import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { namedAgents } from "@/lib/db/schema";
import { isAgentProvider, type AgentProvider } from "@/lib/agent-config/constants";
import { createId } from "@/lib/utils/nanoid";

export interface NamedAgentRecord {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  escalatesTo: string | null;
  createdAt: string | null;
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

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: normalizeProvider(row.provider) || "claude-code",
    model: row.model,
    escalatesTo: row.escalatesTo,
    createdAt: row.createdAt,
  }));
}

export async function getNamedAgent(agentId: string): Promise<NamedAgentRecord | null> {
  const row = db
    .select()
    .from(namedAgents)
    .where(eq(namedAgents.id, agentId))
    .get();

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    provider: normalizeProvider(row.provider) || "claude-code",
    model: row.model,
    escalatesTo: row.escalatesTo,
    createdAt: row.createdAt,
  };
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
