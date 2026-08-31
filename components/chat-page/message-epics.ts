import { parseEpicFromConversation, type ParsedEpic } from "@/lib/epic-parsing";

/**
 * The epic ONE assistant message declares, or null.
 *
 * Frame 11a's promise is that a drafted epic appears *in the thread*, attached
 * to the message that wrote it, and stays actionable after the fact. The
 * shipped flow (`hooks/useEpicCreate.ts`) is conversation-scoped: it parses the
 * whole history, newest-first, and renders one card at the FOOT of the flow —
 * so a second epic later in the same conversation hides the first, and nothing
 * is re-actionable from history.
 *
 * WHY CALLING THE CONVERSATION PARSER WITH ONE MESSAGE IS SOUND, and not a
 * re-implementation of it:
 * - `parseEpicFromJson` filters to assistant messages and reverses them
 *   (`lib/epic-parsing.ts`) — on a single element both are no-ops.
 * - the prose fallback joins the assistant text — on a single element that join
 *   is that message's own text.
 * - the parse is pure and synchronous: no fetch, no state, no ordering.
 * - it requires a non-empty title AND at least one story, so a chatty message
 *   never produces a card.
 *
 * COST: the JSON candidate scan does a greedy brace match over the content, so
 * this is O(content) per message. Fine at chat scale, NOT fine once per render
 * of a 200-message history — memoise by message id (see `epicsByMessageId`).
 */
export function epicInMessage(message: {
  role: string;
  content: string;
}): ParsedEpic | null {
  if (message.role !== "assistant") return null;
  if (!message.content || !message.content.trim()) return null;
  return parseEpicFromConversation([
    { role: message.role, content: message.content },
  ]);
}

/**
 * The same parse across a message list, keyed by message id.
 *
 * Call this inside a `useMemo` over `messages`: it is what keeps the O(content)
 * scan at once per message per change instead of once per render.
 */
export function epicsByMessageId(
  messages: readonly { id: string; role: string; content: string }[],
): Map<string, ParsedEpic> {
  const found = new Map<string, ParsedEpic>();
  for (const message of messages) {
    const parsed = epicInMessage(message);
    if (parsed) found.set(message.id, parsed);
  }
  return found;
}

/** How many `- [ ]` / `- [x]` lines a story's acceptance criteria carries. */
export function acceptanceCriteriaCount(
  acceptanceCriteria: string | null | undefined,
): number {
  if (!acceptanceCriteria) return 0;
  const matches = acceptanceCriteria.match(/^\s*[-*]\s*\[[ xX]\]/gm);
  return matches ? matches.length : 0;
}

/** Total AC across a parsed epic's stories. */
export function totalAcceptanceCriteria(epic: ParsedEpic): number {
  return epic.userStories.reduce(
    (sum, story) => sum + acceptanceCriteriaCount(story.acceptanceCriteria),
    0,
  );
}

export type { ParsedEpic };
