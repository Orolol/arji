import { isEpicCreationConversationAgentType } from "@/lib/chat/conversation-agent";

export type LegacyChatTabType = "brainstorm" | "epic_creation";

export const LEGACY_CHAT_TAB_TAXONOMY: ReadonlyArray<{
  type: LegacyChatTabType;
  defaultLabel: string;
}> = [
  {
    type: "brainstorm",
    defaultLabel: "Brainstorm",
  },
  {
    type: "epic_creation",
    defaultLabel: "New Epic",
  },
] as const;

export type LegacyConversationStatus =
  | "active"
  | "generating"
  | "generated"
  | "error";

export const LEGACY_CONVERSATION_STATUSES: ReadonlyArray<LegacyConversationStatus> =
  ["active", "generating", "generated", "error"] as const;

export type LegacyConversationFilterId = "all";

export const LEGACY_CONVERSATION_FILTERS: ReadonlyArray<{
  id: LegacyConversationFilterId;
  label: string;
}> = [
  {
    id: "all",
    label: "All conversations",
  },
] as const;

export type LegacyConversationSortId = "created_at_asc";

export const LEGACY_CONVERSATION_SORTS: ReadonlyArray<{
  id: LegacyConversationSortId;
  label: string;
}> = [
  {
    id: "created_at_asc",
    label: "Oldest first",
  },
] as const;

const legacyConversationStatusSet = new Set<string>(LEGACY_CONVERSATION_STATUSES);

export function normalizeLegacyConversationStatus(
  status: string | null | undefined,
): LegacyConversationStatus {
  if (status && legacyConversationStatusSet.has(status)) {
    return status as LegacyConversationStatus;
  }
  return "active";
}

export function isLegacyConversationGenerating(
  status: string | null | undefined,
): boolean {
  return normalizeLegacyConversationStatus(status) === "generating";
}

export function resolveLegacyConversationLabel(
  type: string | null | undefined,
  label: string | null | undefined,
): string {
  if (typeof label === "string") {
    const trimmed = label.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return isEpicCreationConversationAgentType(type) ? "New Epic" : "Brainstorm";
}

interface SortableConversation {
  id: string;
  createdAt: string | null | undefined;
}

function parseCreatedAt(createdAt: string | null | undefined): number {
  if (!createdAt) {
    return 0;
  }
  const asMs = Date.parse(createdAt);
  return Number.isFinite(asMs) ? asMs : 0;
}

export function compareConversationsByLegacyOrder(
  a: SortableConversation,
  b: SortableConversation,
): number {
  const createdAtDiff = parseCreatedAt(a.createdAt) - parseCreatedAt(b.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return a.id.localeCompare(b.id);
}

export function sortConversationsForLegacyParity<T extends SortableConversation>(
  conversations: readonly T[],
): T[] {
  return [...conversations].sort(compareConversationsByLegacyOrder);
}

export function applyLegacyConversationFilter<T>(
  conversations: readonly T[],
  filterId: LegacyConversationFilterId = "all",
): T[] {
  if (filterId !== "all") {
    return [...conversations];
  }
  return [...conversations];
}
