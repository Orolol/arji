/**
 * Tests for "Reviewer must differ from builder" (review provider segregation).
 *
 * Covers:
 * - resolveAgentForDispatch(): segregation on/off, deterministic alternative
 *   pick, single-provider fallback, story vs epic targets, and the precedence
 *   rule that an explicitly picked named agent is NEVER overridden.
 * - isReviewProviderSegregationEnabled(): settings parsing + default-off.
 * - findLastSuccessfulBuildProvider(): target handling.
 * - pickAlternativeReviewProvider(): stable order, skip builder, failures.
 *
 * Companion of legacy-fallback-named-agents.test.ts (same db-mock pattern).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

// Controllable provider availability (lib/providers is imported lazily by
// pickAlternativeReviewProvider, so this mock intercepts the dynamic import).
const availabilityState = vi.hoisted(() => ({
  available: new Set<string>(),
  throwing: new Set<string>(),
}));

vi.mock("@/lib/providers", () => ({
  getProvider: (type: string) => ({
    isAvailable: async () => {
      if (availabilityState.throwing.has(type)) {
        throw new Error("availability check failed");
      }
      return availabilityState.available.has(type);
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  availabilityState.available.clear();
  availabilityState.throwing.clear();
});

const REVIEW_CONTEXT_EPIC = {
  purpose: "review" as const,
  projectId: "proj-1",
  epicId: "epic-1",
};

const REVIEW_CONTEXT_STORY = {
  purpose: "review" as const,
  projectId: "proj-1",
  epicId: "epic-1",
  storyId: "us-1",
};

/** Seeds resolveAgent's chain: no project override, global named assignment. */
function seedDefaultResolution(provider: string) {
  const namedAgentId = `default-${provider}`;
  dbMockState.getQueue.push(
    null, // project-scoped default: none
    { provider, namedAgentId }, // global assignment
    {
      id: namedAgentId,
      name: `Default ${provider}`,
      provider,
      model: "",
    },
  );
}

const SEGREGATION_ON = { key: "review_provider_segregation", value: '"true"' };

describe("resolveAgentForDispatch — segregation off / non-review", () => {
  it("returns the default resolution when the setting is absent (default off)", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(null); // settings row: absent

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBeUndefined();
    expect(result.builderProvider).toBeUndefined();
    // Setting was off — the builder-session lookup never ran.
    expect(dbMockState.getQueue).toHaveLength(0);
  });

  it("returns the default resolution when the setting is 'false'", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push({
      key: "review_provider_segregation",
      value: '"false"',
    });

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBeUndefined();
  });

  it("does not consult the setting at all without a review context", async () => {
    seedDefaultResolution("claude-code");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch("build", "proj-1", null);

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBeUndefined();
    // Only the two resolution lookups ran — no settings / sessions reads.
    expect(dbMockState.getQueue).toHaveLength(0);
  });
});

describe("resolveAgentForDispatch — segregation on", () => {
  it("redirects to a different available provider when the builder matches", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "claude-code" }); // builder session
    availabilityState.available.add("codex");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("codex");
    expect(result.segregated).toBe(true);
    expect(result.builderProvider).toBe("claude-code");
    expect(result.namedAgentId).toBeNull();
  });

  it("picks the alternative deterministically in stable PROVIDER_OPTIONS order", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "claude-code" });
    // codex unavailable, several later options available: the first available
    // option in PROVIDER_OPTIONS order (gemini-cli) must win.
    availabilityState.available.add("gemini-cli");
    availabilityState.available.add("opencode");
    availabilityState.available.add("zai");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_code",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("gemini-cli");
    expect(result.segregated).toBe(true);
  });

  it("works for story targets (ticket_build) too", async () => {
    seedDefaultResolution("codex");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "codex" }); // last ticket_build
    availabilityState.available.add("claude-code");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_STORY
    );

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBe(true);
    expect(result.builderProvider).toBe("codex");
  });

  it("falls back to the builder's provider when no alternative CLI is installed", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "claude-code" });
    availabilityState.available.add("claude-code"); // only the builder itself

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBeUndefined();
    expect(result.builderProvider).toBe("claude-code");
  });

  it("keeps the default resolution when it already differs from the builder", async () => {
    seedDefaultResolution("codex");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "claude-code" });

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("codex");
    expect(result.segregated).toBeUndefined();
    expect(result.builderProvider).toBe("claude-code");
  });

  it("returns the default resolution when the target has no successful build", async () => {
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push(null); // no completed build session

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      null,
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("claude-code");
    expect(result.segregated).toBeUndefined();
    expect(result.builderProvider).toBeUndefined();
  });

  it("NEVER overrides an explicitly picked named agent", async () => {
    // Named-agent lookup is first — and last — db read on this path.
    dbMockState.getQueue.push({
      id: "named-1",
      name: "CC Opus",
      provider: "claude-code",
      model: "claude-opus-4-6",
      createdAt: "2026-01-01",
    });
    availabilityState.available.add("codex");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      "named-1",
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("CC Opus");
    expect(result.segregated).toBeUndefined();
    // Segregation was short-circuited: no settings/session reads happened.
    expect(dbMockState.getQueue).toHaveLength(0);
  });

  it("applies segregation when the picked named agent no longer exists", async () => {
    dbMockState.getQueue.push(null); // named agent deleted
    seedDefaultResolution("claude-code");
    dbMockState.getQueue.push(SEGREGATION_ON);
    dbMockState.getQueue.push({ provider: "claude-code" });
    availabilityState.available.add("codex");

    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const result = await resolveAgentForDispatch(
      "review_feature",
      "proj-1",
      "deleted-id",
      REVIEW_CONTEXT_EPIC
    );

    expect(result.provider).toBe("codex");
    expect(result.segregated).toBe(true);
  });
});

describe("isReviewProviderSegregationEnabled", () => {
  async function loadHelper() {
    const mod = await import("@/lib/agent-config/review-segregation");
    return mod.isReviewProviderSegregationEnabled;
  }

  it("defaults to false when the setting row is missing", async () => {
    dbMockState.getQueue.push(null);
    expect((await loadHelper())()).toBe(false);
  });

  it("parses the JSON-encoded 'true' string", async () => {
    dbMockState.getQueue.push({ key: "x", value: '"true"' });
    expect((await loadHelper())()).toBe(true);
  });

  it("accepts a raw (non-JSON) 'true' string", async () => {
    dbMockState.getQueue.push({ key: "x", value: "true" });
    expect((await loadHelper())()).toBe(true);
  });

  it("accepts a JSON boolean true", async () => {
    dbMockState.getQueue.push({ key: "x", value: "true" });
    expect((await loadHelper())()).toBe(true);
  });

  it("is false for 'false'", async () => {
    dbMockState.getQueue.push({ key: "x", value: '"false"' });
    expect((await loadHelper())()).toBe(false);
  });
});

describe("findLastSuccessfulBuildProvider", () => {
  it("returns the provider of the latest completed build for an epic", async () => {
    dbMockState.getQueue.push({ provider: "codex" });
    const { findLastSuccessfulBuildProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(
      findLastSuccessfulBuildProvider({ projectId: "p1", epicId: "e1" })
    ).toBe("codex");
  });

  it("returns the provider for a story target", async () => {
    dbMockState.getQueue.push({ provider: "gemini-cli" });
    const { findLastSuccessfulBuildProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(
      findLastSuccessfulBuildProvider({
        projectId: "p1",
        epicId: "e1",
        storyId: "s1",
      })
    ).toBe("gemini-cli");
  });

  it("returns null without querying when the target has no epic or story", async () => {
    dbMockState.getQueue.push({ provider: "codex" }); // must NOT be consumed
    const { findLastSuccessfulBuildProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(findLastSuccessfulBuildProvider({ projectId: "p1" })).toBeNull();
    expect(dbMockState.getQueue).toHaveLength(1);
  });

  it("returns null for an unknown provider value", async () => {
    dbMockState.getQueue.push({ provider: "not-a-provider" });
    const { findLastSuccessfulBuildProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(
      findLastSuccessfulBuildProvider({ projectId: "p1", epicId: "e1" })
    ).toBeNull();
  });
});

describe("pickAlternativeReviewProvider", () => {
  it("returns the first available provider in stable order, skipping the builder", async () => {
    availabilityState.available.add("claude-code"); // builder — must be skipped
    availabilityState.available.add("gemini-cli");
    availabilityState.available.add("codex");

    const { pickAlternativeReviewProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    // PROVIDER_OPTIONS order: claude-code, codex, gemini-cli, ...
    expect(await pickAlternativeReviewProvider("claude-code")).toBe("codex");
  });

  it("returns null when only the builder's CLI is installed", async () => {
    availabilityState.available.add("codex");
    const { pickAlternativeReviewProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(await pickAlternativeReviewProvider("codex")).toBeNull();
  });

  it("treats availability-check failures as unavailable", async () => {
    availabilityState.throwing.add("claude-code");
    availabilityState.available.add("gemini-cli");
    const { pickAlternativeReviewProvider } = await import(
      "@/lib/agent-config/review-segregation"
    );
    expect(await pickAlternativeReviewProvider("codex")).toBe("gemini-cli");
  });
});
