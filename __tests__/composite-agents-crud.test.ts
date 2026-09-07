/**
 * Composite agents: the write service and the schema guarantees behind it
 * (lib/agent-config/composite-agents.ts, lib/agent-config/named-agents.ts).
 *
 * A composite is a ROW of `named_agents` carrying `kind = 'composite'` plus an
 * ordered `composite_agent_members` list — not a table of its own — so every
 * existing `named_agent_id` foreign key keeps working untouched. What this
 * file pins is the set of refusals that keep the list a FLAT list: no nesting,
 * no self-containment, no duplicates and never empty. Together they are why
 * the feature contains no cycle detection at all.
 *
 * Runs against the REAL migrated schema (`createTestDb`), not hand-written
 * DDL: the unique indexes on `(composite_id, position)` and
 * `(composite_id, member_id)` are half the contract, and hand-written DDL
 * could drift from the migration that ships.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";

const { db: testDb, sqlite: testSqlite } = createTestDb();

vi.mock("@/lib/db", () => ({ db: testDb, sqlite: testSqlite }));

let counter = 0;
vi.mock("@/lib/utils/nanoid", () => ({
  createId: () => `cid-${++counter}`,
  nanoid: () => `cid-${++counter}`,
}));

beforeEach(() => {
  testSqlite.exec("DELETE FROM composite_agent_members");
  testSqlite.exec("DELETE FROM agent_provider_defaults");
  testSqlite.exec("DELETE FROM named_agents");
  testSqlite.exec("DELETE FROM settings");
  counter = 0;
});

async function makeSimple(name: string, provider = "claude-code", model = "") {
  const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
  const { data, error } = await createNamedAgent({ name, provider, model });
  expect(error).toBeUndefined();
  return data!;
}

describe("createCompositeAgent", () => {
  it("creates a composite row plus its ordered membership", async () => {
    const { createCompositeAgent, getNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const first = await makeSimple("First", "claude-code", "opus");
    const second = await makeSimple("Second", "codex", "gpt-5");

    const { data, error } = await createCompositeAgent({
      name: "Ladder",
      memberIds: [first.id, second.id],
    });

    expect(error).toBeUndefined();
    expect(data?.kind).toBe("composite");
    expect(data?.members.map((member) => member.name)).toEqual([
      "First",
      "Second",
    ]);
    expect(data?.members.map((member) => member.position)).toEqual([0, 1]);

    // The composite carries the documented sentinels rather than a plausible
    // provider: a caller reading a composite's provider is asking the wrong
    // question and must not receive an answer it can spawn.
    expect(data?.provider).toBe("composite");
    expect(data?.model).toBe("");

    // And it reads back identically — the record is not a create-time
    // fabrication.
    const reread = await getNamedAgent(data!.id);
    expect(reread?.members.map((member) => member.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("refuses a composite with no members at all", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data, error } = await createCompositeAgent({
      name: "Empty",
      memberIds: [],
    });

    expect(data).toBeNull();
    expect(error).toMatch(/at least one member/i);

    // And nothing was written: the row and its membership are one transaction,
    // so a refusal must not leave a nameless composite behind.
    expect(
      testSqlite.prepare("SELECT COUNT(*) AS n FROM named_agents").get()
    ).toEqual({ n: 0 });
  });

  it("refuses a composite that contains another composite", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const leaf = await makeSimple("Leaf");
    const { data: inner } = await createCompositeAgent({
      name: "Inner",
      memberIds: [leaf.id],
    });

    const { data, error } = await createCompositeAgent({
      name: "Outer",
      memberIds: [inner!.id],
    });

    expect(data).toBeNull();
    expect(error).toMatch(/cannot contain another composite/i);
  });

  it("refuses a composite that lists the same member twice", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const only = await makeSimple("Only");

    const { data, error } = await createCompositeAgent({
      name: "Doubled",
      memberIds: [only.id, only.id],
    });

    expect(data).toBeNull();
    expect(error).toMatch(/same member twice/i);
  });

  it("refuses a member that does not exist", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data, error } = await createCompositeAgent({
      name: "Ghost",
      memberIds: ["no-such-agent"],
    });

    expect(data).toBeNull();
    expect(error).toMatch(/not found/i);
  });

  it("shares the name space of simple agents", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    await makeSimple("Taken");
    const member = await makeSimple("Member");

    const { data, error } = await createCompositeAgent({
      name: "taken",
      memberIds: [member.id],
    });

    expect(data).toBeNull();
    expect(error).toMatch(/already exists/i);
  });
});

describe("setCompositeMembers", () => {
  it("refuses a composite that would contain itself", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { setCompositeMembers } = await import(
      "@/lib/agent-config/composite-agents"
    );
    const member = await makeSimple("Member");
    const { data: composite } = await createCompositeAgent({
      name: "Selfish",
      memberIds: [member.id],
    });

    const error = setCompositeMembers(composite!.id, [composite!.id]);
    expect(error).toMatch(/cannot contain itself/i);

    // The membership is untouched by the refusal.
    const { listCompositeMembers } = await import(
      "@/lib/agent-config/composite-agents"
    );
    expect(listCompositeMembers(composite!.id).map((m) => m.id)).toEqual([
      member.id,
    ]);
  });

  it("reorders by full replacement without colliding on the position index", async () => {
    const { createCompositeAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { listCompositeMembers, setCompositeMembers } = await import(
      "@/lib/agent-config/composite-agents"
    );
    const a = await makeSimple("Alpha");
    const b = await makeSimple("Beta");
    const c = await makeSimple("Gamma");
    const { data: composite } = await createCompositeAgent({
      name: "Ordered",
      memberIds: [a.id, b.id, c.id],
    });

    // A swap of the first two is exactly the case a diff-based update would
    // collide on: (composite_id, position) is uniquely indexed.
    expect(setCompositeMembers(composite!.id, [b.id, a.id, c.id])).toBeNull();
    expect(listCompositeMembers(composite!.id).map((m) => m.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
    expect(listCompositeMembers(composite!.id).map((m) => m.position)).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("member deletion", () => {
  it("removes a deleted member from the composite and keeps the rest", async () => {
    const { createCompositeAgent, deleteNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { listCompositeMembers } = await import(
      "@/lib/agent-config/composite-agents"
    );
    const a = await makeSimple("Alpha");
    const b = await makeSimple("Beta");
    const { data: composite } = await createCompositeAgent({
      name: "Survivor",
      memberIds: [a.id, b.id],
    });

    expect(await deleteNamedAgent(a.id)).toBe(true);

    // ON DELETE CASCADE on member_id: the membership row goes with the agent,
    // and the composite continues with what is left.
    expect(listCompositeMembers(composite!.id).map((m) => m.name)).toEqual([
      "Beta",
    ]);
  });

  it("drops the whole membership when the composite itself is deleted", async () => {
    const { createCompositeAgent, deleteNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const member = await makeSimple("Member");
    const { data: composite } = await createCompositeAgent({
      name: "Doomed",
      memberIds: [member.id],
    });

    expect(await deleteNamedAgent(composite!.id)).toBe(true);
    expect(
      testSqlite
        .prepare("SELECT COUNT(*) AS n FROM composite_agent_members")
        .get()
    ).toEqual({ n: 0 });
    // The MEMBER survives: deleting a list must not delete its agents.
    expect(
      testSqlite
        .prepare("SELECT COUNT(*) AS n FROM named_agents WHERE id = ?")
        .get(member.id)
    ).toEqual({ n: 1 });
  });
});

describe("updateNamedAgent on a composite", () => {
  it("renames and reorders, and refuses CLI fields it does not own", async () => {
    const { createCompositeAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const a = await makeSimple("Alpha");
    const b = await makeSimple("Beta");
    const { data: composite } = await createCompositeAgent({
      name: "Ladder",
      memberIds: [a.id, b.id],
    });

    const renamed = await updateNamedAgent(composite!.id, {
      name: "Better ladder",
      memberIds: [b.id, a.id],
    });
    expect(renamed.error).toBeUndefined();
    expect(renamed.data?.name).toBe("Better ladder");
    expect(renamed.data?.members.map((m) => m.name)).toEqual([
      "Beta",
      "Alpha",
    ]);

    // A CLI field on a composite is a caller bug, and it is REFUSED rather
    // than silently dropped — a silent drop is how a UI comes to believe it
    // saved a CLI choice.
    const refused = await updateNamedAgent(composite!.id, {
      provider: "codex",
    });
    expect(refused.data).toBeNull();
    expect(refused.error).toMatch(/no CLI, model, options or persona/i);
  });

  it("refuses emptying a composite through an update", async () => {
    const { createCompositeAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const member = await makeSimple("Member");
    const { data: composite } = await createCompositeAgent({
      name: "Ladder",
      memberIds: [member.id],
    });

    const result = await updateNamedAgent(composite!.id, { memberIds: [] });
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/at least one member/i);
  });

  it("refuses memberIds on a SIMPLE agent", async () => {
    const { updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const simple = await makeSimple("Plain");
    const other = await makeSimple("Other");

    const result = await updateNamedAgent(simple.id, {
      memberIds: [other.id],
    });
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/only a composite/i);
  });
});

describe("the designated default composite", () => {
  it("designates exactly one at a time and clears with null", async () => {
    const { createCompositeAgent, listNamedAgents } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { readDefaultCompositeAgentId, setDefaultCompositeAgentId } =
      await import("@/lib/agent-config/composite-agents");
    const member = await makeSimple("Member");
    const { data: first } = await createCompositeAgent({
      name: "First",
      memberIds: [member.id],
    });
    const { data: second } = await createCompositeAgent({
      name: "Second",
      memberIds: [member.id],
    });

    expect(readDefaultCompositeAgentId()).toBeNull();

    expect(setDefaultCompositeAgentId(first!.id)).toBeNull();
    expect(readDefaultCompositeAgentId()).toBe(first!.id);

    // One settings key, so designating another REPLACES rather than adds —
    // "only one at a time" is a property of the storage.
    expect(setDefaultCompositeAgentId(second!.id)).toBeNull();
    expect(readDefaultCompositeAgentId()).toBe(second!.id);
    const defaults = (await listNamedAgents()).filter(
      (agent) => agent.isDefault
    );
    expect(defaults.map((agent) => agent.id)).toEqual([second!.id]);

    expect(setDefaultCompositeAgentId(null)).toBeNull();
    expect(readDefaultCompositeAgentId()).toBeNull();
  });

  it("refuses a simple agent as the default composite", async () => {
    const { setDefaultCompositeAgentId } = await import(
      "@/lib/agent-config/composite-agents"
    );
    const simple = await makeSimple("Plain");
    expect(setDefaultCompositeAgentId(simple.id)).toMatch(
      /only a composite agent/i
    );
  });

  it("reads a designation whose composite was deleted as no designation", async () => {
    const { createCompositeAgent, deleteNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { readDefaultCompositeAgentId, setDefaultCompositeAgentId } =
      await import("@/lib/agent-config/composite-agents");
    const member = await makeSimple("Member");
    const { data: composite } = await createCompositeAgent({
      name: "Doomed",
      memberIds: [member.id],
    });
    setDefaultCompositeAgentId(composite!.id);

    await deleteNamedAgent(composite!.id);

    // The setting is a POINTER; the row it points at is authoritative. A
    // stale id must read as "nothing designated" rather than as an
    // unresolvable one.
    expect(readDefaultCompositeAgentId()).toBeNull();
  });
});

describe("updateNamedAgent on a composite is atomic", () => {
  it("does not persist the rename when the member list is refused", async () => {
    const { createCompositeAgent, updateNamedAgent, getNamedAgent } =
      await import("@/lib/agent-config/named-agents");
    const a = await makeSimple("A");
    const b = await makeSimple("B");
    const { data: composite } = await createCompositeAgent({
      name: "Before",
      memberIds: [a.id, b.id],
    });

    // A rename and an invalid reorder in ONE call. The rename used to commit
    // first and the member write to refuse afterwards, so the route answered
    // 400 while the new name had already persisted — and the workshop's hook
    // only reloads on success, leaving the user looking at an error message
    // next to a name that had silently changed.
    const { error } = await updateNamedAgent(composite!.id, {
      name: "After",
      memberIds: [a.id, a.id],
    });

    expect(error).toMatch(/same member twice/i);
    const reread = await getNamedAgent(composite!.id);
    expect(reread?.name).toBe("Before");
    expect(reread?.members.map((member) => member.name)).toEqual(["A", "B"]);
  });

  it("commits both halves when the member list is accepted", async () => {
    const { createCompositeAgent, updateNamedAgent, getNamedAgent } =
      await import("@/lib/agent-config/named-agents");
    const a = await makeSimple("A");
    const b = await makeSimple("B");
    const { data: composite } = await createCompositeAgent({
      name: "Before",
      memberIds: [a.id, b.id],
    });

    const { error } = await updateNamedAgent(composite!.id, {
      name: "After",
      memberIds: [b.id, a.id],
    });

    expect(error).toBeUndefined();
    const reread = await getNamedAgent(composite!.id);
    expect(reread?.name).toBe("After");
    expect(reread?.members.map((member) => member.name)).toEqual(["B", "A"]);
  });
});

/**
 * An EMPTIED composite in the resolution chain.
 *
 * Deleting a simple agent from the roster is an ordinary action with no
 * guard: `composite_agent_members` cascades, and a composite whose only
 * member went away is left with an empty list. Whether that is fatal depends
 * entirely on WHO chose the composite, and this block pins both halves —
 * they are the same code path with two different callers.
 */
describe("an emptied composite in the resolution chain", () => {
  async function emptiedComposite(name = "Ladder") {
    const { createCompositeAgent, deleteNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const member = await makeSimple("Only member", "codex", "gpt-5");
    const { data: composite } = await createCompositeAgent({
      name,
      memberIds: [member.id],
    });
    // The cascade: no composite API is called, only the roster delete.
    await deleteNamedAgent(member.id);
    return composite!;
  }

  /** The seeded catch-all `resolveAgent()` ends on. */
  async function seedCatchAll() {
    const { GLOBAL_DEFAULT_AGENT_NAME } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    return makeSimple(GLOBAL_DEFAULT_AGENT_NAME, "claude-code", "opus");
  }

  it("falls through to the builtin fallback when it is the DESIGNATED DEFAULT", async () => {
    const { setDefaultCompositeAgentId } = await import(
      "@/lib/agent-config/composite-agents"
    );
    const { resolveAgent } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    await seedCatchAll();
    const composite = await emptiedComposite();
    setDefaultCompositeAgentId(composite.id);

    // The user set a default once and then deleted an agent. Throwing here
    // takes down every unassigned resolution in the app — build routes, the
    // chat stream, night runs, Full Auto, the scheduled routines.
    expect(() => resolveAgent("build")).not.toThrow();
    expect(resolveAgent("build").name).toBe("Claude Code");
    expect(resolveAgent("chat").name).toBe("Claude Code");
  });

  it("falls through when it is a ROLE ASSIGNMENT, at global and project scope", async () => {
    const { resolveAgent } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const { agentProviderDefaults } = await import("@/lib/db/schema");
    await seedCatchAll();
    const composite = await emptiedComposite();

    for (const scope of ["global", "proj-1"]) {
      testDb
        .insert(agentProviderDefaults)
        .values({
          id: `apd-${scope}`,
          agentType: "build",
          provider: "composite",
          scope,
          namedAgentId: composite.id,
        })
        .run();
    }

    // Same shape as the designated default, same cascade, second call site.
    expect(() => resolveAgent("build", "proj-1")).not.toThrow();
    expect(resolveAgent("build", "proj-1").name).toBe("Claude Code");
  });

  it("still THROWS for a caller that named the composite explicitly", async () => {
    const { resolveAgentByNamedId, CompositeAgentUnusableError } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    await seedCatchAll();
    const composite = await emptiedComposite("Named by hand");

    // The other half of the contract: an explicit choice must hear the
    // refusal rather than silently run on some other agent.
    expect(() => resolveAgentByNamedId("build", undefined, composite.id))
      .toThrow(CompositeAgentUnusableError);
    expect(() => resolveAgentByNamedId("build", undefined, composite.id))
      .toThrow(/has no members left/i);
  });
});
