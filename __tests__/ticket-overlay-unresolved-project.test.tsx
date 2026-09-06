/**
 * The reported access path, end to end.
 *
 * `TicketOverlayProvider` hands `TicketOverlay` `projectId ?? ""` — the
 * overlay's prop is a plain `string`, so an unknown project becomes an empty
 * segment rather than staying absent. Two callers can open a ticket that way:
 *
 *   - `components/qa/QaScreen.tsx` — `openTicket(epicId, { projectId:
 *     ownerProjectId ?? projectId ?? null })`, i.e. a QA finding whose owner
 *     project did not resolve;
 *   - `components/desk/NowDesk.tsx` — the owner falls back to
 *     `activeProjectId`, which is null on the cross-project desk.
 *
 * Downstream, `useTicketOverlayData` derives `activeEpicId = open && projectId
 * ? epicId : null`, which switches the ticket's own loaders off — but
 * `useProjectEvents` was called unconditionally and opened
 * `/api/projects//events`, a URL the parser collapses to
 * `/api/projects/events`. That is what this pins: the whole chain issues no
 * request at all on an unresolved project.
 *
 * The unmocked hooks here are deliberate. `useTicketOverlayData`,
 * `useProjectEvents` and `useTicketComments` are the chain under test; the
 * sibling overlay specs mock all three, which is exactly why the defect
 * survived them. Only presentational leaves that cannot run under jsdom are
 * replaced.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TicketOverlayProvider,
  useTicketOverlay,
} from "@/components/ticket/TicketOverlayProvider";

vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));
vi.mock("@/components/shared/AgentDispatchDialog", () => ({
  AgentDispatchDialog: () => null,
}));
vi.mock("@/components/shared/SendToDevDialog", () => ({
  SendToDevDialog: () => null,
}));
vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

/** Every URL an `EventSource` was constructed with, in order. */
const constructedUrls: string[] = [];

class SpyEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    constructedUrls.push(url);
  }

  close() {}
}

const originalEventSource = (globalThis as Record<string, unknown>).EventSource;
const fetchMock = vi.fn();

/**
 * URL-aware, not a queue of one reply per call. The overlay fires a dozen
 * loaders at once and several of them re-read after a mutation; a single
 * queued response hands the wrong shape to whichever hook happens to be next,
 * which is a flake rather than a signal about the guard.
 */
function payloadFor(url: string): unknown {
  if (url.includes("/dependencies")) {
    return { data: { predecessors: [], successors: [] } };
  }
  if (url.includes("/grading") || url.includes("/verify")) {
    return { data: null };
  }
  // Both the project row and the settings row are read as objects.
  if (/\/api\/projects\/[^/]+$/.test(url) || url.startsWith("/api/settings")) {
    return { data: {} };
  }
  return { data: [] };
}

beforeEach(() => {
  constructedUrls.length = 0;
  (globalThis as Record<string, unknown>).EventSource = SpyEventSource;
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payloadFor(String(input))),
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).EventSource = originalEventSource;
});

/** Every URL the whole tree asked for, over both transports. */
function requestedUrls(): string[] {
  return [
    ...constructedUrls,
    ...fetchMock.mock.calls.map((call) => String(call[0])),
  ];
}

function Opener({ projectId }: { projectId?: string | null }) {
  const { openTicket } = useTicketOverlay();
  return (
    <button onClick={() => openTicket("E-1", { projectId })}>open ticket</button>
  );
}

async function openTicketWith(projectId?: string | null) {
  const user = userEvent.setup();
  render(
    <TicketOverlayProvider>
      <Opener projectId={projectId} />
    </TicketOverlayProvider>,
  );

  await user.click(screen.getByRole("button", { name: "open ticket" }));
  await waitFor(() => {
    expect(screen.getByTestId("epic-detail-panel")).toBeInTheDocument();
  });
}

describe("a ticket opened without a resolved project", () => {
  it("opens no SSE stream", async () => {
    await openTicketWith(null);

    expect(constructedUrls).toEqual([]);
  });

  it("issues no request carrying an empty project segment", async () => {
    await openTicketWith(null);

    // The template's spelling and the collapsed spelling the parser really
    // sends. `/qa` and the cross-project desk both reach this state.
    const offenders = requestedUrls().filter(
      (url) =>
        url.startsWith("/api/projects//") ||
        url === "/api/projects/events" ||
        url === "/api/projects/",
    );
    expect(offenders).toEqual([]);
  });

  it("issues no project-scoped request at all", async () => {
    await openTicketWith(null);

    const projectScoped = requestedUrls().filter((url) =>
      url.startsWith("/api/projects/"),
    );
    expect(projectScoped).toEqual([]);
  });
});

describe("a ticket opened with a resolved project", () => {
  // The control: the same chain still connects and still loads when the
  // caller knows the project, so the guard cannot pass by disabling the
  // overlay outright.

  it("opens that project's stream", async () => {
    await openTicketWith("p1");

    await waitFor(() => {
      expect(constructedUrls).toContain("/api/projects/p1/events");
    });
  });

  it("loads that project's ticket data", async () => {
    await openTicketWith("p1");

    await waitFor(() => {
      expect(requestedUrls()).toContain("/api/projects/p1/epics");
    });
  });
});
