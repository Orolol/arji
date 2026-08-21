import { describe, it, expect } from "vitest";
import {
  parseEpicFromConversation,
  extractJsonCandidates,
} from "@/lib/epic-parsing";
import { createEpicSchema } from "@/lib/validation/schemas";

describe("extractJsonCandidates", () => {
  it("extracts JSON from standard code fence", () => {
    const content = '```json\n{"title": "Auth"}\n```';
    const candidates = extractJsonCandidates(content);
    expect(candidates).toContainEqual('{"title": "Auth"}');
  });

  it("extracts JSON from code fence without json tag", () => {
    const content = '```\n{"title": "Auth"}\n```';
    const candidates = extractJsonCandidates(content);
    expect(candidates).toContainEqual('{"title": "Auth"}');
  });

  it("extracts JSON when surrounded by preamble text", () => {
    const content =
      'Here is the epic:\n\n```json\n{"title": "Auth", "userStories": [{"title": "As a user, I want login"}]}\n```\n\nLet me know if this looks good.';
    const candidates = extractJsonCandidates(content);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(candidates[0]);
    expect(parsed.title).toBe("Auth");
  });

  it("extracts raw JSON when entire content is a JSON object", () => {
    const content = '{"title": "Auth", "userStories": []}';
    const candidates = extractJsonCandidates(content);
    expect(candidates).toContainEqual(content);
  });

  it("finds JSON object embedded in conversational text without code fences", () => {
    const content =
      'The plan is ready. Here it is:\n{"title": "Auth", "description": "desc", "userStories": [{"title": "As a dev, I want auth"}]}\nShould I proceed?';
    const candidates = extractJsonCandidates(content);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const hasTitle = candidates.some((c) => {
      try {
        return JSON.parse(c).title === "Auth";
      } catch {
        return false;
      }
    });
    expect(hasTitle).toBe(true);
  });

  it("returns empty array for text with no JSON at all", () => {
    const content = "The plan is ready for your review. Should I proceed?";
    const candidates = extractJsonCandidates(content);
    expect(candidates).toEqual([]);
  });
});

describe("parseEpicFromConversation", () => {
  it("parses a well-formed JSON response", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title": "Authentication System", "description": "Implement auth", "userStories": [{"title": "As a user, I want to log in so that I can access my account", "description": "Login flow", "acceptanceCriteria": "- [ ] Login form exists"}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Authentication System");
    expect(result!.userStories.length).toBe(1);
  });

  it("parses epic from text format when JSON is absent", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content:
          "# Authentication System\n\nImplement user authentication.\n\n## User Stories\n\n- As a user, I want to register an account so that I can use the service\n  Acceptance criteria:\n  - [ ] Registration form validates email\n  - [ ] Password is hashed",
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toContain("Authentication");
    expect(result!.userStories.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null for purely conversational text with no structure", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content: "The plan is ready for your review. Should I proceed?",
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).toBeNull();
  });

  it("handles JSON embedded in conversational preamble", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          'Here is the epic:\n\n```json\n{"title": "Auth", "description": "desc", "userStories": [{"title": "As a user, I want login so that I can access the app", "description": "Login", "acceptanceCriteria": "- [ ] works"}]}\n```\n\nLet me know!',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth");
  });

  it("handles JSON without code fences embedded in conversational text", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          'The plan is ready. Here it is:\n{"title": "Auth", "description": "desc", "userStories": [{"title": "As a dev, I want auth so that security works", "description": "Auth flow", "acceptanceCriteria": "- [ ] works"}]}\nShould I proceed?',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth");
  });

  it("handles user_stories snake_case key", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title": "Auth", "description": "desc", "user_stories": [{"title": "As a user, I want login so that I can log in", "description": "desc", "acceptance_criteria": "- [ ] works"}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth");
    expect(result!.userStories.length).toBe(1);
  });

  it("handles acceptanceCriteria as an array of strings", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title": "Auth", "description": "desc", "userStories": [{"title": "As a user, I want login so that I can log in", "description": "desc", "acceptanceCriteria": ["Login form exists", "Password is validated", "Session is created"]}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth");
    expect(result!.userStories.length).toBe(1);
    expect(result!.userStories[0].acceptanceCriteria).toContain("- [ ] Login form exists");
    expect(result!.userStories[0].acceptanceCriteria).toContain("- [ ] Password is validated");
    expect(result!.userStories[0].acceptanceCriteria).toContain("- [ ] Session is created");
  });

  it("handles acceptance_criteria as an array (snake_case)", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title": "Auth", "description": "desc", "user_stories": [{"title": "As a user, I want login so that I can log in", "acceptance_criteria": ["Criterion A", "Criterion B"]}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.userStories[0].acceptanceCriteria).toContain("- [ ] Criterion A");
    expect(result!.userStories[0].acceptanceCriteria).toContain("- [ ] Criterion B");
  });

  it("prefers the latest assistant message", () => {
    const messages = [
      { role: "user", content: "Create an epic" },
      {
        role: "assistant",
        content: "Let me think about this...",
      },
      { role: "user", content: "Generate the JSON" },
      {
        role: "assistant",
        content:
          '```json\n{"title": "Final Auth", "description": "desc", "userStories": [{"title": "As a user, I want login so that access", "description": "d", "acceptanceCriteria": "- [ ] ok"}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Final Auth");
  });

  it("parses wrapped payloads and stories alias", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          '```json\n{"data":{"epic":{"title":"Auth","description":"desc","stories":[{"title":"As a user, I want login so that I can access","description":"story desc","acceptanceCriteria":"- [ ] works"}]}}}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Auth");
    expect(result!.userStories).toHaveLength(1);
    expect(result!.userStories[0].title).toContain("As a user");
  });

  it("normalizes acceptance criteria arrays into checklist markdown", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title":"Auth","description":"desc","userStories":[{"title":"As a user, I want login so that I can access","acceptanceCriteria":["Password reset works","- [ ] MFA can be enabled"]}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.userStories[0].acceptanceCriteria).toBe(
      "- [ ] Password reset works\n- [ ] MFA can be enabled",
    );
  });

  it("unwraps an epics array and keeps the first well-formed epic", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          '```json\n{"epics":[{"title":"Agent model","description":"desc A","userStories":[{"title":"As a dev, I want optional params so that agents stay flexible","acceptanceCriteria":["Model is nullable"]}]},{"title":"Settings UI","description":"desc B","userStories":[{"title":"As a user, I want a settings tab so that I can edit agents"}]}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Agent model");
    expect(result!.userStories).toHaveLength(1);
    expect(result!.userStories[0].acceptanceCriteria).toBe("- [ ] Model is nullable");
  });

  it("normalizes object-array criteria and array descriptions", () => {
    const messages = [
      { role: "user", content: "Generate the final epic" },
      {
        role: "assistant",
        content:
          '```json\n{"title":"Auth","description":["First paragraph","Second paragraph"],"userStories":[{"title":"As a user, I want secure login so that my account stays safe","description":["Flow","Validation"],"acceptanceCriteria":[{"text":"Captcha after retries"},{"description":"Brute-force lockout"}]}]}\n```',
      },
    ];
    const result = parseEpicFromConversation(messages);
    expect(result).not.toBeNull();
    expect(result!.description).toBe("First paragraph\n\nSecond paragraph");
    expect(result!.userStories[0].description).toBe("Flow\n\nValidation");
    expect(result!.userStories[0].acceptanceCriteria).toBe(
      "- [ ] Captcha after retries\n- [ ] Brute-force lockout",
    );
  });
});

/**
 * The chat path posts `parseEpicFromConversation`'s output straight to
 * `POST /api/projects/:id/epics` (`hooks/useEpicCreate.ts`). Tightening
 * `createEpicSchema` to reject blank titles is only safe because the parser
 * already drops them — these pin that agreement, so a future loosening of the
 * parser shows up here instead of as a 400 on a working flow.
 */
describe("chat-parsed epics satisfy createEpicSchema", () => {
  const parsedPayload = (assistant: string) => {
    const parsed = parseEpicFromConversation([
      { role: "user", content: "Generate the final epic" },
      { role: "assistant", content: assistant },
    ]);
    expect(parsed).not.toBeNull();
    return {
      title: parsed!.title,
      description: parsed!.description,
      status: "backlog",
      userStories: parsed!.userStories,
    };
  };

  it("accepts a normal agent-generated epic", () => {
    const payload = parsedPayload(
      '```json\n{"title":"Auth","description":"Harden login","userStories":[{"title":"As a user, I want 2FA so that my account is secure","acceptanceCriteria":"- [ ] toggle"}]}\n```',
    );
    expect(createEpicSchema.safeParse(payload).success).toBe(true);
  });

  it("still validates when the agent pads titles with whitespace", () => {
    const payload = parsedPayload(
      '```json\n{"title":"   Auth   ","userStories":[{"title":"   As a user, I want 2FA so that my account is secure   "}]}\n```',
    );
    expect(payload.title).toBe("Auth");
    expect(createEpicSchema.safeParse(payload).success).toBe(true);
  });

  it("drops a blank story title before it can reach the schema", () => {
    const payload = parsedPayload(
      '```json\n{"title":"Auth","userStories":[{"title":"As a user, I want 2FA so that my account is secure"},{"title":"   "}]}\n```',
    );
    expect(payload.userStories).toHaveLength(1);
    expect(createEpicSchema.safeParse(payload).success).toBe(true);
  });

  /**
   * The story caps (500 for a title, 10 000 for prose) apply to this path too,
   * so they have to sit well clear of what an agent actually writes: a verbose
   * "As a … I want … so that …" title with a full checklist behind it is the
   * worst realistic case, and it is nowhere near the boundary.
   */
  it("leaves a verbose agent story comfortably inside the caps", () => {
    const title =
      "As a returning customer who has already linked a payment method, I want the checkout to remember my preferred card and shipping address so that I can complete a repeat order without retyping details I have entered before";
    const criteria = Array.from(
      { length: 12 },
      (_, i) => `- [ ] Criterion ${i + 1} covering one branch of the checkout flow`,
    ).join("\n");
    const payload = parsedPayload(
      `\`\`\`json\n${JSON.stringify({
        title: "Checkout",
        description: "Reduce friction on repeat orders",
        userStories: [{ title, description: "Repeat orders stall on data entry.", acceptanceCriteria: criteria }],
      })}\n\`\`\``,
    );

    expect(payload.userStories[0].title.length).toBeLessThan(500);
    expect(createEpicSchema.safeParse(payload).success).toBe(true);
  });
});
