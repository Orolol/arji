import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/db/schema", () => ({
  projects: {
    id: "id",
    name: "name",
    defaultBranch: "default_branch",
    cloneSource: "clone_source",
    gitRepoPath: "git_repo_path",
    description: "description",
    githubOwnerRepo: "github_owner_repo",
    gitRemoteUrl: "git_remote_url",
    status: "status",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

vi.mock("@/lib/export/arji-json", () => ({
  tryExportArjiJson: vi.fn(),
}));

import { PATCH } from "@/app/api/projects/[projectId]/route";
import { POST } from "@/app/api/projects/route";

describe("projects route defaultBranch validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PATCH /api/projects/[projectId]", () => {
    it("rejects defaultBranch beginning with a leading dash", async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({
              id: "proj-1",
              cloneSource: "local",
              gitRepoPath: "/path",
              defaultBranch: "main",
            }),
          }),
        }),
      });

      const req = new NextRequest("http://localhost/api/projects/proj-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: " --invalid-flag" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ projectId: "proj-1" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("Invalid default branch: --invalid-flag");
    });

    it("accepts valid defaultBranch", async () => {
      const project = {
        id: "proj-1",
        cloneSource: "local",
        gitRepoPath: "/path",
        defaultBranch: "main",
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue(project),
          }),
        }),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            run: vi.fn(),
          }),
        }),
      });

      const req = new NextRequest("http://localhost/api/projects/proj-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultBranch: "main" }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ projectId: "proj-1" }) });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/projects", () => {
    it("rejects defaultBranch beginning with a leading dash", async () => {
      const req = new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Project With Bad Branch",
          defaultBranch: " --upload-pack=touch /tmp/pwn",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toContain("Invalid default branch: --upload-pack=touch /tmp/pwn");
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("accepts valid defaultBranch on create", async () => {
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          run: vi.fn(),
        }),
      });

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({
              id: "proj-2",
              name: "Clean Project",
              defaultBranch: "main",
            }),
          }),
        }),
      });

      const req = new NextRequest("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Clean Project",
          defaultBranch: "main",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });
});
