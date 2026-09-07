/**
 * The linden composer of the chat page (frame 11a).
 *
 * ⏎ SENDS and ⇧⏎ is a newline — the opposite of the desk composer's contract,
 * and what the frame's own placeholder promises. The rest of this file is the
 * attachment behaviour that took three bugs to get right: an upload in flight
 * blocks the send, a successful send CLEARS (the files are owned now) while
 * pulling a thumbnail DELETES, and a provider that cannot take images sends an
 * empty array rather than a stale one.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ChatComposer,
  CHAT_COMPOSER_PLACEHOLDER,
} from "@/components/chat-page/ChatComposer";
import { agentSelectionPatch } from "@/components/chat-page/agent-selection";
import type { DeskProject } from "@/lib/control-desk/types";

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [
      { id: "a1", name: "Opus Planner", provider: "claude-code" },
    ],
    loading: false,
    refresh: vi.fn(),
  }),
}));

const PROJECT: DeskProject = {
  id: "p1",
  name: "Arij",
  shortName: "ARIJ",
  colorIndex: 0,
  activeAgents: 0,
  autoModeEnabled: false,
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  // Everything not explicitly routed answers "no documents".
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) });
  global.fetch = fetchMock as unknown as typeof fetch;
});

/**
 * `MentionTextarea` loads the project's documents on mount (that fetch is what
 * makes `@` citation work), so every render is flushed here rather than
 * leaving an un-acted state update behind in each test.
 */
async function renderComposer(
  overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {},
) {
  const onSend = vi.fn();
  const onSelectAgent = vi.fn();
  const props: React.ComponentProps<typeof ChatComposer> = {
    projectId: "p1",
    projects: [PROJECT],
    project: PROJECT,
    onSelectProject: vi.fn(),
    // The pill derives its own label from this selection and the mocked
    // roster above — "Opus Planner" is not passed in as a string any more.
    agentSelection: { namedAgentId: "a1", provider: "claude-code" },
    onSelectAgent,
    agentLocked: false,
    onSend,
    ...overrides,
  };
  await act(async () => {
    render(<ChatComposer {...props} />);
  });
  return { onSend, onSelectAgent, props };
}

function field() {
  return screen.getByTestId("chat-composer-input") as HTMLTextAreaElement;
}

function pngFile(name = "shot.png") {
  return new File(["binary"], name, { type: "image/png" });
}

/** One staged, uploaded attachment, through the real hook. */
async function stageAttachment(id = "up1") {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/chat/upload")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              id,
              fileName: "shot.png",
              mimeType: "image/png",
              filePath: `data/uploads/p1/${id}.png`,
            },
          }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
  });

  fireEvent.paste(field(), {
    clipboardData: { items: [], files: [pngFile()] },
  });

  await screen.findByTestId("image-attachment-strip");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Remove / })).toBeInTheDocument(),
  );
}

describe("the composer's keyboard contract", () => {
  it("sends on Enter and clears the field", async () => {
    const { onSend } = await renderComposer();

    await userEvent.type(field(), "Avant de dispatcher un ticket");
    await userEvent.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("Avant de dispatcher un ticket", []);
    expect(field()).toHaveValue("");
  });

  it("Shift+Enter writes a newline and does not send", async () => {
    const { onSend } = await renderComposer();

    await userEvent.type(field(), "ligne un");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await userEvent.type(field(), "ligne deux");

    expect(onSend).not.toHaveBeenCalled();
    expect(field().value).toContain("\n");
  });

  it("never swallows Enter while an IME candidate window is open", async () => {
    const { onSend } = await renderComposer();

    fireEvent.change(field(), { target: { value: "こんにち" } });
    fireEvent.compositionStart(field());
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(field());
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty send", async () => {
    const { onSend } = await renderComposer();

    await userEvent.click(field());
    await userEvent.keyboard("{Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("prints the frame's placeholder, accents and glyphs included", async () => {
    await renderComposer();
    expect(CHAT_COMPOSER_PLACEHOLDER).toBe(
      "Écris — ⏎ envoie, ⇧⏎ saute une ligne, @ cite un doc",
    );
    expect(
      screen.getByPlaceholderText(
        "Écris — ⏎ envoie, ⇧⏎ saute une ligne, @ cite un doc",
      ),
    ).toBeInTheDocument();
  });

  it("holds the placeholder to a single line with truncation on narrow widths", async () => {
    await renderComposer();
    const input = field();
    const classList = (input.getAttribute("class") ?? "").split(/\s+/);
    // The placeholder is 51 characters. Without truncation, it wraps to two lines
    // when the field is narrower than ~380px, causing the second line ("doc") to be clipped
    // at the bottom of the single-row band. placeholder:truncate (overflow:hidden, text-overflow:ellipsis,
    // white-space:nowrap) holds it to a single line clipped at the right edge without vertical overflow.
    expect(
      classList.includes("placeholder:truncate"),
      "chat composer input textarea must carry placeholder:truncate to prevent multi-line wrapping",
    ).toBe(true);
  });
});

describe("attachments", () => {
  it("sends the staged attachment ids and keeps the files (clear, not discard)", async () => {
    const { onSend } = await renderComposer();
    await stageAttachment("up1");

    await userEvent.type(field(), "voici la capture");
    await userEvent.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("voici la capture", ["up1"]);
    // clear() keeps the uploads: they belong to the message now. discardAll()
    // would have deleted them.
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE"),
    ).toBe(false);
  });

  it("deletes the upload when the thumbnail is pulled", async () => {
    await renderComposer();
    await stageAttachment("up2");

    await userEvent.click(screen.getByRole("button", { name: /^Remove / }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find((call) => call[1]?.method === "DELETE");
      expect(del?.[0]).toBe("/api/projects/p1/chat/uploads/up2");
    });
  });

  it("refuses to send while an upload is still in flight", async () => {
    const { onSend } = await renderComposer();

    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/chat/upload")) {
        // Never settles: the transfer is still going.
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    });

    fireEvent.paste(field(), {
      clipboardData: { items: [], files: [pngFile()] },
    });
    await screen.findByTestId("image-attachment-strip");

    await userEvent.type(field(), "trop tôt");
    await userEvent.keyboard("{Enter}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("a provider that cannot take images disables the picker and sends no ids", async () => {
    const { onSend } = await renderComposer({ attachmentsDisabled: true });

    expect(
      screen.getByRole("button", { name: "Joindre une image" }),
    ).toBeDisabled();

    fireEvent.paste(field(), {
      clipboardData: { items: [], files: [pngFile()] },
    });

    await userEvent.type(field(), "sans image");
    await userEvent.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("sans image", []);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith("/chat/upload"),
      ),
    ).toBe(false);
  });
});

describe("agent and project pills", () => {
  it("names the project by its mono short name and the agent by name", async () => {
    await renderComposer();
    expect(screen.getByText("ARIJ")).toBeInTheDocument();
    expect(screen.getByText("Opus Planner")).toBeInTheDocument();
  });

  it("falls back to an em-dash rather than inventing a project", async () => {
    await renderComposer({
      projects: [],
      project: null,
      projectId: null,
      disabled: true,
    });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("locks the agent picker once the conversation has a message", async () => {
    await renderComposer({ agentLocked: true });

    const pills = screen.getAllByRole("button");
    const agentPill = pills.find((pill) => pill.textContent === "Opus Planner");
    expect(agentPill).toBeDisabled();
  });
});

describe("the documents load before a project is resolved", () => {
  /**
   * /chat paints the composer before the active project resolves. The field
   * used to receive `projectId ?? ""`, and the empty segment collapsed to
   * `/api/projects/documents` — six 404s in one audit session.
   */
  it("asks for no documents at all while the project is null", async () => {
    await renderComposer({ projects: [], project: null, projectId: null, disabled: true });

    const documentCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("documents"));
    expect(documentCalls).toEqual([]);
  });

  it("asks for that project's documents once it resolves", async () => {
    await renderComposer();

    const documentCalls = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.includes("documents"));
    expect(documentCalls).toEqual(["/api/projects/p1/documents"]);
  });
});

describe("what the conversation PATCH carries", () => {
  // A named agent OWNS its provider: sending both loses the user's choice
  // because the route re-derives the provider from the agent row.
  it("sends the named agent alone", () => {
    expect(
      agentSelectionPatch({ namedAgentId: "a1", provider: "claude-code" }),
    ).toEqual({ namedAgentId: "a1" });
  });

  it("sends a raw provider with the named-agent link explicitly cleared", () => {
    expect(
      agentSelectionPatch({ namedAgentId: null, provider: "openai-compatible" }),
    ).toEqual({ provider: "openai-compatible", namedAgentId: null });
  });
});
