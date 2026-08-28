/**
 * `GET /api/projects/:projectId/sessions/:sessionId/files` — the read-only
 * diffstat behind the live session's FILES TOUCHED card.
 *
 * Two properties matter more than the parsing: the route must never CREATE a
 * worktree (the epic diff route does, at its line 44, and this one is polled
 * while a session runs), and it must never 500 — a broken git state has to
 * degrade to "no diff", not take the whole live-session page down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const mocks = vi.hoisted(() => {
  const raw = vi.fn<(args: string[]) => Promise<string>>();
  const simpleGit = vi.fn(() => ({ raw }));
  return { raw, simpleGit };
});

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("simple-git", () => ({ default: mocks.simpleGit }));

vi.mock("@/lib/git/manager", () => ({
  resolveDefaultBranch: vi.fn(async () => "main"),
  createWorktree: vi.fn(),
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions } = await import("@/lib/db/schema");
const { createWorktree, resolveDefaultBranch } = await import(
  "@/lib/git/manager"
);
const { GET } = await import(
  "@/app/api/projects/[projectId]/sessions/[sessionId]/files/route"
);

const PROJECT = "proj-1";
const SESSION = "sess-1";
const MERGE_BASE = "e4f21c9aa11bb22cc33dd44ee55ff6600aa11bb2";
/** A directory that really exists, so the route's existsSync guard passes. */
const WORKTREE = process.cwd();

interface FileRow {
  path: string;
  added: number | null;
  removed: number | null;
  inProgress: boolean;
}

function get(projectId = PROJECT, sessionId = SESSION) {
  return GET(mockNextRequest(), mockRouteContext({ projectId, sessionId }));
}

async function body(response: Response) {
  return (await response.json()) as {
    error?: string;
    data?: {
      sessionId: string;
      ticket: { id: string; readableId: string | null; title: string } | null;
      project: { id: string; name: string } | null;
      diff: {
        available: boolean;
        reason?: string;
        baseBranch: string | null;
        mergeBase: string | null;
        behind: number | null;
        ahead: number | null;
        files: FileRow[];
        totals: { files: number; added: number; removed: number } | null;
        truncated: boolean;
      };
    };
  };
}

/** Answer each `git raw` call by the subcommand the route asked for. */
function gitAnswers({
  mergeBase = `${MERGE_BASE}\n`,
  revList = "0\t3\n",
  committed = "",
  unstaged = "",
  staged = "",
}: {
  mergeBase?: string;
  revList?: string;
  committed?: string;
  unstaged?: string;
  staged?: string;
} = {}) {
  mocks.raw.mockImplementation(async (args: string[]) => {
    if (args[0] === "merge-base") return mergeBase;
    if (args[0] === "rev-list") return revList;
    if (args[0] === "diff") {
      if (args.includes("--cached")) return staged;
      // ["diff", "--numstat", <base>, "HEAD"] is the committed one.
      if (args.length > 2) return committed;
      return unstaged;
    }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveDefaultBranch).mockResolvedValue("main");

  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();

  db.insert(projects)
    .values({ id: PROJECT, name: "Arij", gitRepoPath: "/repo/arij" })
    .run();
  db.insert(projects).values({ id: "proj-2", name: "Other" }).run();
  db.insert(epics)
    .values({
      id: "epic-1",
      projectId: PROJECT,
      readableId: "ARJ-122",
      title: "Streaming session logs over SSE",
    })
    .run();
  db.insert(agentSessions)
    .values({
      id: SESSION,
      projectId: PROJECT,
      epicId: "epic-1",
      status: "running",
      mode: "code",
      agentType: "build",
      branchName: "arij/arj-122-sse-logs",
      worktreePath: WORKTREE,
    })
    .run();

  gitAnswers();
});

describe("session files route — scoping", () => {
  it("404s a session that belongs to another project, and touches no git", async () => {
    const response = await get("proj-2", SESSION);

    expect(response.status).toBe(404);
    expect((await body(response)).error).toBe("Session not found");
    expect(mocks.simpleGit).not.toHaveBeenCalled();
    expect(resolveDefaultBranch).not.toHaveBeenCalled();
  });
});

describe("session files route — identity does not depend on git", () => {
  it("still answers ticket and project when there is no worktree", async () => {
    db.update(agentSessions).set({ worktreePath: null }).run();

    const response = await get();
    const { data } = await body(response);

    expect(response.status).toBe(200);
    expect(data?.diff.available).toBe(false);
    expect(data?.diff.reason).toBe("no-worktree");
    // The header renders from these; a missing worktree must not blank it.
    expect(data?.ticket).toEqual({
      id: "epic-1",
      readableId: "ARJ-122",
      title: "Streaming session logs over SSE",
    });
    expect(data?.project).toEqual({ id: PROJECT, name: "Arij" });
    expect(mocks.simpleGit).not.toHaveBeenCalled();
  });
});

describe("session files route — numstat", () => {
  it("parses counts and totals them over every row", async () => {
    gitAnswers({
      committed:
        "142\t18\tlib/sse/stream.ts\n87\t0\thooks/useProjectEvents.ts\n",
    });

    const { data } = await body(await get());

    expect(data?.diff.available).toBe(true);
    expect(data?.diff.files).toEqual([
      {
        path: "lib/sse/stream.ts",
        added: 142,
        removed: 18,
        inProgress: false,
      },
      {
        path: "hooks/useProjectEvents.ts",
        added: 87,
        removed: 0,
        inProgress: false,
      },
    ]);
    expect(data?.diff.totals).toEqual({ files: 2, added: 229, removed: 18 });
    expect(data?.diff.mergeBase).toBe(MERGE_BASE);
    expect(data?.diff.baseBranch).toBe("main");
    expect(data?.diff.behind).toBe(0);
    expect(data?.diff.ahead).toBe(3);
  });

  it("gives a binary file null counts, never a false +0 −0", async () => {
    gitAnswers({ committed: "-\t-\tassets/logo.png\n" });

    const { data } = await body(await get());

    expect(data?.diff.files).toEqual([
      { path: "assets/logo.png", added: null, removed: null, inProgress: false },
    ]);
  });

  it("flags a path the agent is still writing, and only that one", async () => {
    gitAnswers({
      committed: "142\t18\tlib/sse/stream.ts\n",
      unstaged: "4\t2\ttests/sse.spec.ts\n",
    });

    const { data } = await body(await get());
    const byPath = new Map(data?.diff.files.map((f) => [f.path, f]));

    expect(byPath.get("tests/sse.spec.ts")?.inProgress).toBe(true);
    expect(byPath.get("lib/sse/stream.ts")?.inProgress).toBe(false);
  });

  it("caps the list at 60 rows while keeping the totals honest", async () => {
    const rows = Array.from(
      { length: 75 },
      (_, i) => `${i + 1}\t0\tsrc/file-${i}.ts`
    ).join("\n");
    gitAnswers({ committed: `${rows}\n` });

    const { data } = await body(await get());

    expect(data?.diff.files).toHaveLength(60);
    expect(data?.diff.truncated).toBe(true);
    // 1 + 2 + ... + 75
    expect(data?.diff.totals).toEqual({ files: 75, added: 2850, removed: 0 });
  });
});

describe("session files route — it never writes and never 500s", () => {
  it("does not create a worktree as a side effect of a polled GET", async () => {
    await get();
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("answers 200 with git-failed rather than throwing", async () => {
    mocks.raw.mockRejectedValue(new Error("fatal: not a git repository"));
    vi.mocked(resolveDefaultBranch).mockRejectedValue(
      new Error("fatal: not a git repository")
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await get();
    const { data } = await body(response);

    expect(response.status).toBe(200);
    expect(data?.diff.available).toBe(false);
    expect(data?.diff.reason).toBe("git-failed");
    expect(data?.project).toEqual({ id: PROJECT, name: "Arij" });
    warn.mockRestore();
  });

  it("says not-a-repo when the project has no git repository at all", async () => {
    db.update(projects).set({ gitRepoPath: null }).run();

    const { data } = await body(await get());

    expect(data?.diff.available).toBe(false);
    expect(data?.diff.reason).toBe("not-a-repo");
    expect(mocks.simpleGit).not.toHaveBeenCalled();
  });
});
