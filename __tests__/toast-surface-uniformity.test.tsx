/**
 * Every surface that raises a toast raises it through ONE stack.
 *
 * `ec3cbaf` introduced `components/notifications/ToastStack.tsx` and moved the
 * desk and its project host onto it. Five surfaces kept a stack written by
 * hand — pinned bottom-right instead of top-right, trapped inside whatever
 * scroll container happened to wrap them, with no close button, no
 * `role="status"`/`role="alert"`, a hard 4–5 s expiry and no ceiling. A user
 * therefore met a different notification depending on the screen they were on.
 *
 * This file renders the five and asserts the shared contract on each. The
 * contract itself lives in `./support/toast-contract`; the behaviour behind it
 * (success expiry, hover/focus pause, the MAX_TOASTS ceiling) is pinned once
 * against the primitive in `./toast-stack.test.tsx`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { expectSharedToastContract } from "./support/toast-contract";
import { qaPayload, releaseEpics, releaseProject } from "./support/toast-fixtures";

/* ---- shared stubs --------------------------------------------------- */

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", storyId: "s1" }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1",
}));

vi.mock("@/components/ticket/TicketOverlayProvider", () => ({
  useTicketOverlay: () => ({ openTicket: vi.fn(), closeTicket: vi.fn() }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useGitStatus", () => ({
  useGitStatus: () => ({
    ahead: 0,
    behind: 0,
    lastFetchedAt: null,
    lastFetchError: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    push: vi.fn(async () => {}),
    pushing: false,
  }),
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktrees: [],
    count: 0,
    orphanCount: 0,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    pruning: false,
  }),
}));

vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: () => ({
    isConfigured: false,
    ownerRepo: null,
    tokenSet: false,
    loading: false,
  }),
}));

vi.mock("@/hooks/useReleasePublish", () => ({
  useReleasePublish: () => ({ publish: vi.fn(), isPublishing: false, error: null }),
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/* ---- chat: the workspace's collaborators ---------------------------- */

vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({
    data: {
      generatedAt: new Date().toISOString(),
      projects: [
        {
          id: "p1",
          name: "Arij",
          shortName: "ARIJ",
          colorIndex: 0,
          activeAgents: 0,
          autoModeEnabled: false,
        },
      ],
      working: [],
      queued: [],
      today: {
        ticketsShipped: 0,
        failedSessions: 0,
        costUsd: null,
        projects: 0,
        sessions: 0,
      },
      yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
      readyToLand: [],
      heldBackCount: 0,
      upNext: [],
    },
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: [],
    activeId: null,
    setActiveId: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    restartPersistentSession: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: false,
    error: null,
    pendingQuestions: [],
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSpecGeneration", () => ({
  useSpecGeneration: () => ({ generateSpec: vi.fn(), generating: false, error: null }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({ createEpic: vi.fn(), isLoading: false, error: null }),
}));

vi.mock("@/components/chat-page/chat-context-tokens", () => ({
  useChatContextTokens: () => ({ total: 0, sections: [] }),
}));

vi.mock("@/components/chat-page/ChatThread", () => ({
  ChatThread: ({
    onToast,
  }: {
    onToast: (tone: "success" | "error", message: string) => void;
  }) => (
    <button
      type="button"
      data-testid="stub-thread-fail"
      onClick={() => onToast("error", "Failed to propose the spec addition")}
    >
      fail
    </button>
  ),
}));

vi.mock("@/components/chat-page/ChatComposer", () => ({
  ChatComposer: () => <div data-testid="stub-composer" />,
}));

vi.mock("@/components/chat-page/ConversationRoster", () => ({
  ConversationRoster: () => <div data-testid="stub-roster" />,
}));

vi.mock("@/components/chat-page/ContextRail", () => ({
  ContextRail: () => <div data-testid="stub-rail" />,
}));

vi.mock("@/components/chat-page/CreatedHereCard", () => ({
  CreatedHereCard: () => <div data-testid="stub-created-here" />,
}));

vi.mock("@/components/chat-page/TowardSpecBand", () => ({
  TowardSpecBand: () => <div data-testid="stub-toward-spec" />,
}));

/* ---- story detail: its panels ---------------------------------------- */

vi.mock("@/hooks/useStoryDetail", () => ({
  useStoryDetail: () => ({
    story: {
      id: "s1",
      epicId: "e1",
      title: "Story title",
      description: "",
      acceptanceCriteria: "",
      status: "todo",
      position: 0,
      createdAt: new Date().toISOString(),
      epic: {
        id: "e1",
        title: "Epic",
        description: "",
        status: "todo",
        branchName: null,
        projectId: "p1",
      },
    },
    loading: false,
    updateStory: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTicketComments", () => ({
  useTicketComments: () => ({ comments: [], loading: false, addComment: vi.fn() }),
}));

vi.mock("@/hooks/useAgentDispatch", () => ({
  useAgentDispatch: () => ({
    activeSession: null,
    dispatching: false,
    isRunning: false,
    sendToDev: vi.fn(),
    sendToReview: vi.fn(),
    merge: vi.fn(),
  }),
}));

vi.mock("@/components/story/StoryDetailPanel", () => ({
  StoryDetailPanel: () => <div data-testid="story-detail-panel" />,
}));

vi.mock("@/components/story/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread" />,
}));

vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: () => <div data-testid="story-actions" />,
}));

import { QaScreen } from "@/components/qa/QaScreen";
import { ChatPageView } from "@/components/chat-page/ChatPageView";
import ReleasesPage from "@/app/projects/[projectId]/releases/page";
import GitSyncPage from "@/app/projects/[projectId]/git-sync/page";
import StoryDetailPage from "@/app/projects/[projectId]/stories/[storyId]/page";

function jsonRes(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ---- 1. /qa ---------------------------------------------------------- */

describe("toast uniformity — /qa", () => {
  it("raises the QA dispatch failure through the shared stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/qa/findings") {
          return new Response(JSON.stringify({ data: qaPayload() }), { status: 200 });
        }
        if (url.includes("/build") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ error: "Le worktree est verrouillé" }),
            { status: 500 },
          );
        }
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }),
    );

    const { container } = render(<QaScreen />);
    fireEvent.click(await screen.findByTestId("qa-finding-fix"));
    await screen.findByTestId("qa-toast");

    expectSharedToastContract(container, {
      testId: "qa-toast",
      tone: "error",
      message: "Le worktree est verrouillé",
    });
  });
});

/* ---- 2. /chat -------------------------------------------------------- */

describe("toast uniformity — /chat", () => {
  it("raises the workspace's failure through the shared stack", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ data: [] })));

    const { container } = render(<ChatPageView initialProjectId="p1" />);
    fireEvent.click(await screen.findByTestId("stub-thread-fail"));
    await screen.findByTestId("chat-toast");

    expectSharedToastContract(container, {
      testId: "chat-toast",
      tone: "error",
      message: "Failed to propose the spec addition",
    });
  });
});

/* ---- 3. /projects/:id/releases --------------------------------------- */

describe("toast uniformity — /projects/:id/releases", () => {
  it("raises the release outcome through the shared stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url === "/api/projects/p1/releases") {
          return jsonRes({ error: "Version 0.4.3 already exists" }, {
            ok: false,
            status: 409,
          });
        }
        if (url === "/api/projects/p1/releases") return jsonRes({ data: [] });
        if (url === "/api/projects/p1/epics") return jsonRes({ data: releaseEpics() });
        if (url === "/api/projects/p1") return jsonRes({ data: releaseProject() });
        return jsonRes({ data: null });
      }),
    );

    const { container } = render(<ReleasesPage />);
    const create = await screen.findByTestId("release-create-button");
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    await screen.findByTestId("release-toast");

    expectSharedToastContract(container, {
      testId: "release-toast",
      tone: "error",
      message: "Version 0.4.3 already exists",
    });
  });
});

/* ---- 4. /projects/:id/git-sync --------------------------------------- */

describe("toast uniformity — /projects/:id/git-sync", () => {
  it("raises the pull failure through the shared stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/git/pull") && init?.method === "POST") {
          return jsonRes({ error: "Pull failed: index.lock exists" }, {
            ok: false,
            status: 500,
          });
        }
        if (url.includes("/git/status")) {
          return jsonRes({
            data: {
              branch: "main",
              remote: "origin",
              ahead: 1,
              behind: 2,
              hasRemoteBranch: true,
            },
          });
        }
        return jsonRes({ data: null });
      }),
    );

    const { container } = render(<GitSyncPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pull" }));
    await screen.findByTestId("git-sync-toast");

    expectSharedToastContract(container, {
      testId: "git-sync-toast",
      tone: "error",
      message: "Pull failed: index.lock exists",
    });
  });
});

/* ---- 5. /projects/:id/stories/:storyId ------------------------------- */

describe("toast uniformity — /projects/:id/stories/:storyId", () => {
  it("raises the delete failure through the shared stack", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ error: "Story is owned by a running session" }, {
          ok: false,
          status: 409,
        }),
      ),
    );

    const { container } = render(<StoryDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Delete User Story" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Delete" }));
    await screen.findByTestId("story-toast");

    expectSharedToastContract(container, {
      testId: "story-toast",
      tone: "error",
      message: "Story is owned by a running session",
    });
  });
});
