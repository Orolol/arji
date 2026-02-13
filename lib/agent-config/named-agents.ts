import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { namedAgents } from "@/lib/db/schema";
import { isAgentProvider, type AgentProvider } from "@/lib/agent-config/constants";

export interface NamedAgentRecord {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
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
    .orderBy(namedAgents.createdAt, namedAgents.name)
    .all();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: normalizeProvider(row.provider) || "claude-code",
    model: row.model,
    createdAt: row.createdAt,
  }));
}

export async function getNamedAgentById(agentId: string): Promise<NamedAgentRecord | null> {
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
    createdAt: row.createdAt,
  };
}

export async function createNamedAgent(input: {
  id: string;
  name: string;
  provider: string;
  model: string;
}): Promise<{ data: NamedAgentRecord | null; error?: string }> {
  const name = input.name.trim();
  const model = input.model.trim();
  const provider = normalizeProvider(input.provider);

  if (!name) {
    return { data: null, error: "name is required" };
  }

  if (!provider) {
    return { data: null, error: "provider must be 'claude-code', 'codex', or 'gemini-cli'" };
  }

  if (!model) {
    return { data: null, error: "model is required" };
  }

  const duplicate = db
    .select({ id: namedAgents.id })
    .from(namedAgents)
    .where(sql`LOWER(${namedAgents.name}) = LOWER(${name})`)
    .get();
  if (duplicate) {
    return { data: null, error: "name already exists" };
  }

  db.insert(namedAgents)
    .values({
      id: input.id,
      name,
      provider,
      model,
      createdAt: new Date().toISOString(),
    })
    .run();

  const created = await getNamedAgentById(input.id);
  return { data: created };
}

export async function updateNamedAgent(
  agentId: string,
  updates: { name?: string; provider?: string; model?: string }
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
      return { data: null, error: "provider must be 'claude-code', 'codex', or 'gemini-cli'" };
    }
    patch.provider = provider;
  }

  if (typeof updates.model === "string") {
    const model = updates.model.trim();
    if (!model) {
      return { data: null, error: "model is required" };
    }
    patch.model = model;
  }

  if (Object.keys(patch).length === 0) {
    return { data: await getNamedAgentById(agentId) };
  }

  db.update(namedAgents)
    .set(patch)
    .where(eq(namedAgents.id, agentId))
    .run();

  return { data: await getNamedAgentById(agentId) };
}

export async function deleteNamedAgent(agentId: string): Promise<boolean> {
  const result = db.delete(namedAgents).where(eq(namedAgents.id, agentId)).run();
  return result.changes > 0;
}
