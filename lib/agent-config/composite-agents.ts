import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { compositeAgentMembers, namedAgents, settings } from "@/lib/db/schema";
import {
  COMPOSITE_AGENT_KIND,
  DEFAULT_COMPOSITE_AGENT_SETTING_KEY,
  FALLBACK_PROVIDER,
  SIMPLE_AGENT_KIND,
  isAgentProvider,
  type AgentProvider,
} from "./constants";
import { parseStoredProviderOptions } from "@/lib/providers/options-registry";
import { createId } from "@/lib/utils/nanoid";

/**
 * Composite agents — the one fallback mechanism in the codebase.
 *
 * A composite is an ORDERED LIST of simple named agents. Attempt N of a
 * pipeline stage runs the member at rank N-1; the length of the list is the
 * attempt budget. It replaces both halves of the retired escalation: the
 * same-provider agent chain dropped by migration 0054 (it fired at attempt 3
 * while the default attempt cap was 2, so it never fired at all) and the
 * provider-escalation branch of `resolveStageAgent()`.
 *
 * The product model is binary: a specific agent, which is retried as itself,
 * or a composite, which descends a rank. There is no third path.
 *
 * NESTING IS REFUSED AT WRITE TIME. A member must be `kind = 'simple'`, so
 * the membership relation is a flat list and not a graph — which is why
 * nothing here walks a chain looking for cycles, unlike the escalation
 * validator it replaces.
 */

export interface CompositeMember {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  position: number;
}

export interface CompositeAgentRecord {
  id: string;
  name: string;
  members: CompositeMember[];
  createdAt: string | null;
}

/** Result shape shared by every write in this module. */
export interface CompositeWriteResult {
  data: CompositeAgentRecord | null;
  error?: string;
}

function normalizeProvider(value: string | null | undefined): AgentProvider {
  return value && isAgentProvider(value) ? value : FALLBACK_PROVIDER;
}

/** True when `agentId` names a row whose kind is `composite`. */
export function isCompositeAgentId(
  agentId: string | null | undefined
): boolean {
  if (!agentId) return false;
  const row = db
    .select({ kind: namedAgents.kind })
    .from(namedAgents)
    .where(eq(namedAgents.id, agentId))
    .get();
  return row?.kind === COMPOSITE_AGENT_KIND;
}

/**
 * The composite's members in rank order, joined to their agent rows.
 *
 * A member row whose agent vanished cannot exist (ON DELETE CASCADE), so the
 * join is total; the filter below is defensive only, for a database edited
 * outside Arij. Positions are re-read as stored rather than re-derived, so
 * the caller sees the same rank the ladder will use.
 */
export function listCompositeMembers(compositeId: string): CompositeMember[] {
  const rows = db
    .select({
      position: compositeAgentMembers.position,
      id: namedAgents.id,
      name: namedAgents.name,
      provider: namedAgents.provider,
      model: namedAgents.model,
      kind: namedAgents.kind,
    })
    .from(compositeAgentMembers)
    .innerJoin(namedAgents, eq(namedAgents.id, compositeAgentMembers.memberId))
    .where(eq(compositeAgentMembers.compositeId, compositeId))
    .orderBy(asc(compositeAgentMembers.position))
    .all();

  return rows
    .filter((row) => row.kind !== COMPOSITE_AGENT_KIND)
    .map((row) => ({
      id: row.id,
      name: row.name,
      provider: normalizeProvider(row.provider),
      model: row.model,
      position: row.position,
    }));
}

/** Per-CLI options of a member, read at unfold time like any agent's. */
export function readMemberCliOptions(memberId: string) {
  const row = db
    .select({ provider: namedAgents.provider, options: namedAgents.options })
    .from(namedAgents)
    .where(eq(namedAgents.id, memberId))
    .get();
  if (!row) return {};
  return parseStoredProviderOptions(row.provider, row.options);
}

/** Members of every composite in one pass, for list endpoints and pickers. */
export function listMembersByComposite(): Map<string, CompositeMember[]> {
  const compositeIds = db
    .select({ id: namedAgents.id })
    .from(namedAgents)
    .where(eq(namedAgents.kind, COMPOSITE_AGENT_KIND))
    .all()
    .map((row) => row.id);

  const byComposite = new Map<string, CompositeMember[]>();
  for (const id of compositeIds) byComposite.set(id, []);
  if (compositeIds.length === 0) return byComposite;

  const rows = db
    .select({
      compositeId: compositeAgentMembers.compositeId,
      position: compositeAgentMembers.position,
      id: namedAgents.id,
      name: namedAgents.name,
      provider: namedAgents.provider,
      model: namedAgents.model,
      kind: namedAgents.kind,
    })
    .from(compositeAgentMembers)
    .innerJoin(namedAgents, eq(namedAgents.id, compositeAgentMembers.memberId))
    .where(inArray(compositeAgentMembers.compositeId, compositeIds))
    .orderBy(asc(compositeAgentMembers.position))
    .all();

  for (const row of rows) {
    if (row.kind === COMPOSITE_AGENT_KIND) continue;
    byComposite.get(row.compositeId)?.push({
      id: row.id,
      name: row.name,
      provider: normalizeProvider(row.provider),
      model: row.model,
      position: row.position,
    });
  }
  return byComposite;
}

/**
 * Validates a proposed member list.
 *
 * Four refusals, and each one exists because the alternative is a silent
 * misconfiguration rather than a loud one:
 *  - an EMPTY list is an agent that can never dispatch anything;
 *  - a member that does not exist would shorten the ladder invisibly;
 *  - a COMPOSITE member would reintroduce the graph this design removed;
 *  - SELF-CONTAINMENT is the degenerate case of that graph, and is checked
 *    separately so the message names what the user actually did.
 */
export function validateCompositeMembers(
  compositeId: string,
  memberIds: string[]
): string | null {
  if (memberIds.length === 0) {
    return "A composite agent must have at least one member";
  }

  const seen = new Set<string>();
  for (const memberId of memberIds) {
    if (memberId === compositeId) {
      return "A composite agent cannot contain itself";
    }
    if (seen.has(memberId)) {
      return "A composite agent cannot list the same member twice";
    }
    seen.add(memberId);
  }

  const rows = db
    .select({ id: namedAgents.id, kind: namedAgents.kind })
    .from(namedAgents)
    .where(inArray(namedAgents.id, memberIds))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row.kind]));

  for (const memberId of memberIds) {
    const kind = byId.get(memberId);
    if (kind === undefined) {
      return `Member agent not found: ${memberId}`;
    }
    if (kind === COMPOSITE_AGENT_KIND) {
      return "A composite agent cannot contain another composite agent";
    }
  }

  return null;
}

/**
 * Replaces the membership of `compositeId` with `memberIds`, in order.
 *
 * Delete-then-insert inside one transaction rather than a diff: the position
 * column is uniquely indexed per composite, so any reordering that moved two
 * members past each other would collide mid-update. The whole list is small
 * by construction (it is an attempt budget, not a catalogue).
 */
export function setCompositeMembers(
  compositeId: string,
  memberIds: string[]
): string | null {
  const error = validateCompositeMembers(compositeId, memberIds);
  if (error) return error;

  db.transaction((tx) => {
    tx.delete(compositeAgentMembers)
      .where(eq(compositeAgentMembers.compositeId, compositeId))
      .run();
    memberIds.forEach((memberId, index) => {
      tx.insert(compositeAgentMembers)
        .values({
          id: createId(),
          compositeId,
          memberId,
          position: index,
          createdAt: new Date().toISOString(),
        })
        .run();
    });
  });

  return null;
}

function toCompositeRecord(row: {
  id: string;
  name: string;
  createdAt: string | null;
}): CompositeAgentRecord {
  return {
    id: row.id,
    name: row.name,
    members: listCompositeMembers(row.id),
    createdAt: row.createdAt,
  };
}

export function getCompositeAgent(
  compositeId: string
): CompositeAgentRecord | null {
  const row = db
    .select({
      id: namedAgents.id,
      name: namedAgents.name,
      kind: namedAgents.kind,
      createdAt: namedAgents.createdAt,
    })
    .from(namedAgents)
    .where(eq(namedAgents.id, compositeId))
    .get();
  if (!row || row.kind !== COMPOSITE_AGENT_KIND) return null;
  return toCompositeRecord(row);
}

export function listCompositeAgents(): CompositeAgentRecord[] {
  const rows = db
    .select({
      id: namedAgents.id,
      name: namedAgents.name,
      createdAt: namedAgents.createdAt,
    })
    .from(namedAgents)
    .where(eq(namedAgents.kind, COMPOSITE_AGENT_KIND))
    .orderBy(asc(namedAgents.name))
    .all();
  return rows.map(toCompositeRecord);
}

/* ------------------------------------------------------------------ */
/* The designated default composite                                    */
/* ------------------------------------------------------------------ */

/**
 * Id of the composite that answers the picker's "Default agent" row, or null.
 *
 * A stale id (the composite was deleted) reads as "no designated default"
 * rather than as an unresolvable one: the setting is a pointer, and the row
 * it points at is authoritative.
 */
export function readDefaultCompositeAgentId(): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, DEFAULT_COMPOSITE_AGENT_SETTING_KEY))
    .get();
  const id = row?.value?.trim();
  if (!id) return null;

  const exists = db
    .select({ kind: namedAgents.kind })
    .from(namedAgents)
    .where(eq(namedAgents.id, id))
    .get();
  return exists?.kind === COMPOSITE_AGENT_KIND ? id : null;
}

/**
 * Designates `compositeId` as the default agent, or clears the designation
 * with `null`. One key, so "only one at a time" is a property of the storage
 * rather than an invariant a write path has to maintain across rows.
 */
export function setDefaultCompositeAgentId(
  compositeId: string | null
): string | null {
  if (compositeId === null) {
    db.delete(settings)
      .where(eq(settings.key, DEFAULT_COMPOSITE_AGENT_SETTING_KEY))
      .run();
    return null;
  }

  const row = db
    .select({ kind: namedAgents.kind })
    .from(namedAgents)
    .where(eq(namedAgents.id, compositeId))
    .get();
  if (!row) return "Named agent not found";
  if (row.kind !== COMPOSITE_AGENT_KIND) {
    return "Only a composite agent can be designated as the default agent";
  }

  const now = new Date().toISOString();
  db.insert(settings)
    .values({
      key: DEFAULT_COMPOSITE_AGENT_SETTING_KEY,
      value: compositeId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: compositeId, updatedAt: now },
    })
    .run();
  return null;
}

/** Kind of a named agent row, or null when the row is gone. */
export function readNamedAgentKind(agentId: string): string | null {
  return (
    db
      .select({ kind: namedAgents.kind })
      .from(namedAgents)
      .where(eq(namedAgents.id, agentId))
      .get()?.kind ?? null
  );
}

export { COMPOSITE_AGENT_KIND, SIMPLE_AGENT_KIND };
