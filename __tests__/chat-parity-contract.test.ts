import { describe, expect, it } from "vitest";
import {
  LEGACY_CHAT_TAB_TAXONOMY,
  LEGACY_CONVERSATION_FILTERS,
  LEGACY_CONVERSATION_SORTS,
  LEGACY_CONVERSATION_STATUSES,
  applyLegacyConversationFilter,
  isLegacyConversationGenerating,
  normalizeLegacyConversationStatus,
  resolveLegacyConversationLabel,
  sortConversationsForLegacyParity,
} from "@/lib/chat/parity-contract";

describe("chat parity contract", () => {
  it("keeps legacy tab taxonomy labels stable", () => {
    expect(LEGACY_CHAT_TAB_TAXONOMY).toEqual([
      { type: "brainstorm", defaultLabel: "Brainstorm" },
      { type: "epic_creation", defaultLabel: "New Epic" },
    ]);
  });

  it("declares legacy filter and sort contracts", () => {
    expect(LEGACY_CONVERSATION_FILTERS).toEqual([
      { id: "all", label: "All conversations" },
    ]);
    expect(LEGACY_CONVERSATION_SORTS).toEqual([
      { id: "created_at_asc", label: "Oldest first" },
    ]);
    expect(LEGACY_CONVERSATION_STATUSES).toEqual([
      "active",
      "generating",
      "generated",
      "error",
    ]);
  });

  it("normalizes unknown statuses to active and preserves known statuses", () => {
    expect(normalizeLegacyConversationStatus("active")).toBe("active");
    expect(normalizeLegacyConversationStatus("generating")).toBe("generating");
    expect(normalizeLegacyConversationStatus("generated")).toBe("generated");
    expect(normalizeLegacyConversationStatus("error")).toBe("error");
    expect(normalizeLegacyConversationStatus("queued")).toBe("active");
    expect(normalizeLegacyConversationStatus(null)).toBe("active");
  });

  it("marks only generating as active agent status", () => {
    expect(isLegacyConversationGenerating("generating")).toBe(true);
    expect(isLegacyConversationGenerating("active")).toBe(false);
    expect(isLegacyConversationGenerating("error")).toBe(false);
    expect(isLegacyConversationGenerating("unknown")).toBe(false);
  });

  it("resolves labels from explicit value or legacy type fallback", () => {
    expect(resolveLegacyConversationLabel("brainstorm", "  A custom title ")).toBe("A custom title");
    expect(resolveLegacyConversationLabel("brainstorm", "")).toBe("Brainstorm");
    expect(resolveLegacyConversationLabel("epic_creation", " ")).toBe("New Epic");
    expect(resolveLegacyConversationLabel("epic", null)).toBe("New Epic");
  });

  it("sorts conversations by createdAt ascending and id tie-breaker", () => {
    const sorted = sortConversationsForLegacyParity([
      { id: "c3", createdAt: "2026-02-13T00:00:03.000Z" },
      { id: "c2", createdAt: "2026-02-13T00:00:02.000Z" },
      { id: "c1", createdAt: "2026-02-13T00:00:02.000Z" },
      { id: "c4", createdAt: null },
    ]);

    expect(sorted.map((conversation) => conversation.id)).toEqual([
      "c4",
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("all filter preserves all conversations", () => {
    const conversations = [
      { id: "c1" },
      { id: "c2" },
    ];
    expect(applyLegacyConversationFilter(conversations, "all")).toEqual(conversations);
  });
});
