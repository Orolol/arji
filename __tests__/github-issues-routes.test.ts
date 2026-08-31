import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockSync = vi.hoisted(() => vi.fn());
const mockIsDue = vi.hoisted(() => vi.fn());
const mockList = vi.hoisted(() => vi.fn());
const mockImport = vi.hoisted(() => vi.fn());
const mockAssertConfigured = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github/issues", () => ({
  syncProjectGitHubIssues: mockSync,
  isGitHubIssueSyncDue: mockIsDue,
  listTriagedIssues: mockList,
  importGitHubIssuesAsTickets: mockImport,
  // GET triage asserts the GitHub configuration before anything else; the
  // unconfigured branch has its own suite in github-issues-not-configured.
  assertGitHubIssuesConfigured: mockAssertConfigured,
}));

// The routes import shared helpers from @/lib/api/route-helpers, which pulls
// in @/lib/db at module load. These routes never touch the db themselves.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

describe("GitHub issues routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET triage triggers sync when due and returns issues", async () => {
    mockAssertConfigured.mockReturnValue("Orolol/arij");
    mockIsDue.mockReturnValue(true);
    mockSync.mockResolvedValue({ synced: 10 });
    mockList.mockReturnValue([{ id: "ghi_1", issueNumber: 123, title: "Bug" }]);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/issues/triage/route"
    );

    const req = mockNextRequest({
      url: "http://localhost/api/projects/proj-1/github/issues/triage?label=bug",
    });

    const res = await GET(req, mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockSync).toHaveBeenCalledWith("proj-1");
    expect(mockList).toHaveBeenCalledWith("proj-1", {
      label: "bug",
      milestone: null,
    });
    expect(json.data).toHaveLength(1);
  });

  it("POST import validates issueNumbers and imports selected issues", async () => {
    mockImport.mockReturnValue([
      { issueNumber: 1, epicId: "ep_1", type: "feature" },
      { issueNumber: 2, epicId: "ep_2", type: "bug" },
    ]);

    const { POST } = await import(
      "@/app/api/projects/[projectId]/github/issues/import/route"
    );

    const request = mockNextRequest({
      url: "http://localhost/",
      body: { issueNumbers: [1, 2] },
    });

    const res = await POST(request, mockRouteContext({ projectId: "proj-1" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(mockImport).toHaveBeenCalledWith("proj-1", [1, 2]);
    expect(json.data.imported).toHaveLength(2);
  });
});
