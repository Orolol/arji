import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dbMockState,
  mockJsonRequest,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

const mocks = vi.hoisted(() => ({
  resolveAgent: vi.fn(),
  getProvider: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgent: mocks.resolveAgent,
}));

vi.mock("@/lib/providers", () => ({
  getProvider: mocks.getProvider,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "import-session"),
}));

let repoPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "arij-import-agent-"));
  dbMockState.getQueue = [null]; // no global prompt setting

  mocks.resolveAgent.mockReturnValue({
    provider: "codex",
    model: "gpt-5-mini",
    name: "Lightweight Importer",
    namedAgentId: "agent-light",
  });
  mocks.getProvider.mockReturnValue({ spawn: mocks.spawn });
  mocks.spawn.mockImplementation((options: { cwd: string }) => {
    fs.writeFileSync(
      path.join(options.cwd, "arji.json"),
      JSON.stringify({
        project: { name: "Imported", description: "Mapped analysis" },
        epics: [],
      })
    );
    return {
      promise: Promise.resolve({ success: true, result: "done", duration: 10 }),
    };
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("repository import agent mapping", () => {
  it("uses the globally resolved import_analysis named agent", async () => {
    const { POST } = await import("@/app/api/projects/import/route");
    const response = await POST(mockJsonRequest({ path: repoPath }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.preview.project.name).toBe("Imported");
    expect(mocks.resolveAgent).toHaveBeenCalledWith("import_analysis");
    expect(mocks.getProvider).toHaveBeenCalledWith("codex");
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "import-import-session",
        cwd: fs.realpathSync(repoPath),
        mode: "analyze",
        model: "gpt-5-mini",
      })
    );
  });
});
