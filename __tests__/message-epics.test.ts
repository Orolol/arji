/**
 * The per-message epic parse behind frame 11a's in-thread cards.
 *
 * The shipped flow parses the WHOLE conversation and renders one card at the
 * foot of the flow; this pins the change — the same parser, called with a
 * single message, so an epic stays attached to the message that wrote it and a
 * chatty message never grows a card.
 */

import { describe, expect, it } from "vitest";

import {
  acceptanceCriteriaCount,
  epicInMessage,
  epicsByMessageId,
  totalAcceptanceCriteria,
} from "@/components/chat-page/message-epics";

const JSON_EPIC = `Here you go:

\`\`\`json
{
  "title": "Spec diff view before agent dispatch",
  "description": "Snapshot the spec and guard the dispatch.",
  "userStories": [
    {
      "title": "Snapshot the spec hash on epic creation",
      "acceptanceCriteria": ["hash stored", "shown in the overlay"]
    },
    {
      "title": "Dispatch guard: diff snapshot vs current spec",
      "acceptanceCriteria": ["diff computed", "asks on drift", "logged"]
    }
  ]
}
\`\`\`
`;

/**
 * Byte-identical to the fixture in `__tests__/use-epic-create.test.tsx`, so the
 * per-message parse and the conversation-scoped one cannot disagree about what
 * prose counts as an epic.
 */
const PROSE_EPIC = `
Epic Title: Account Security
Description: Improve authentication and alerts across the platform.

User Stories:
- As a user, I want two-factor authentication so that my account stays secure.
Acceptance Criteria:
- [ ] Users can enable 2FA from settings
- [ ] Recovery codes are generated
- As an admin, I want suspicious login alerts so that I can respond quickly.
Acceptance Criteria:
- [ ] Alerts are sent for unusual login locations
`;

describe("epicInMessage", () => {
  it("returns the epic a fenced JSON assistant message declares", () => {
    const parsed = epicInMessage({ role: "assistant", content: JSON_EPIC });

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("Spec diff view before agent dispatch");
    expect(parsed?.userStories).toHaveLength(2);
  });

  it("returns null for the same JSON in a user message", () => {
    expect(epicInMessage({ role: "user", content: JSON_EPIC })).toBeNull();
  });

  it("returns null for assistant prose with no story", () => {
    expect(
      epicInMessage({
        role: "assistant",
        content:
          "Bonne friction à attraper : la spec citée dans le prompt peut avoir dérivé.",
      }),
    ).toBeNull();
  });

  it("returns null for an empty assistant message", () => {
    expect(epicInMessage({ role: "assistant", content: "   " })).toBeNull();
  });

  it("parses the prose format the conversation-scoped flow accepts", () => {
    const parsed = epicInMessage({ role: "assistant", content: PROSE_EPIC });

    expect(parsed?.title).toBe("Account Security");
    expect(parsed?.userStories).toHaveLength(2);
  });
});

describe("epicsByMessageId", () => {
  it("binds the epic to the message that wrote it, not to the newest one", () => {
    const messages = [
      { id: "m1", role: "user", content: "Je veux un diff de la spec." },
      { id: "m2", role: "assistant", content: "Voici l'epic." },
      { id: "m3", role: "assistant", content: JSON_EPIC },
      { id: "m4", role: "user", content: "Parfait, ajoute une story." },
      { id: "m5", role: "assistant", content: "Je mets à jour." },
    ];

    const found = epicsByMessageId(messages);

    expect([...found.keys()]).toEqual(["m3"]);
    expect(found.get("m3")?.userStories).toHaveLength(2);
    for (const id of ["m1", "m2", "m4", "m5"]) {
      expect(found.get(id)).toBeUndefined();
    }
  });
});

describe("acceptance criteria counting", () => {
  it("counts the checklist lines the parser normalises to", () => {
    expect(acceptanceCriteriaCount("- [ ] one\n- [ ] two")).toBe(2);
    expect(acceptanceCriteriaCount(null)).toBe(0);
    expect(acceptanceCriteriaCount("free prose, no checklist")).toBe(0);
  });

  it("totals the criteria across a parsed epic's stories", () => {
    const parsed = epicInMessage({ role: "assistant", content: JSON_EPIC });
    expect(parsed).not.toBeNull();
    expect(totalAcceptanceCriteria(parsed!)).toBe(5);
  });
});
