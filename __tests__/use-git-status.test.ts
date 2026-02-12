import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useGitStatus } from "@/hooks/useGitStatus";

describe("useGitStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches ahead/behind counts on mount", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { ahead: 3, behind: 1 },
        }),
    });

    const { result } = renderHook(() =>
      useGitStatus("proj-1", "feature/my-branch")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.ahead).toBe(3);
    expect(result.current.behind).toBe(1);
    expect(result.current.error).toBeNull();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/projects/proj-1/git/status?branch=feature%2Fmy-branch"
    );
  });

  it("returns zeros when no remote tracking branch exists", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { ahead: 0, behind: 0, noRemote: true },
        }),
    });

    const { result } = renderHook(() =>
      useGitStatus("proj-1", "feature/new-branch")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.ahead).toBe(0);
    expect(result.current.behind).toBe(0);
    expect(result.current.noRemote).toBe(true);
  });

  it("handles API error gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({ error: "Git repo not found" }),
    });

    const { result } = renderHook(() =>
      useGitStatus("proj-bad", "main")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Git repo not found");
    expect(result.current.ahead).toBe(0);
    expect(result.current.behind).toBe(0);
  });

  it("handles network failure gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() =>
      useGitStatus("proj-1", "main")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
  });

  it("push() sends POST and refreshes status on success", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return Promise.resolve({
          json: () => Promise.resolve({ data: { pushed: true, branch: "feat" } }),
        });
      }
      // GET status — second call returns updated counts
      callCount++;
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: callCount <= 1 ? { ahead: 5, behind: 0 } : { ahead: 0, behind: 0 },
          }),
      });
    });

    const { result } = renderHook(() =>
      useGitStatus("proj-1", "feat")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.ahead).toBe(5);

    let pushResult: { success: boolean; error?: string } | undefined;
    await act(async () => {
      pushResult = await result.current.push();
    });

    expect(pushResult?.success).toBe(true);
    expect(result.current.pushing).toBe(false);
  });

  it("push() returns error on failure", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        return Promise.resolve({
          json: () => Promise.resolve({ error: "Permission denied" }),
        });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ data: { ahead: 2, behind: 0 } }),
      });
    });

    const { result } = renderHook(() =>
      useGitStatus("proj-1", "feat")
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let pushResult: { success: boolean; error?: string } | undefined;
    await act(async () => {
      pushResult = await result.current.push();
    });

    expect(pushResult?.success).toBe(false);
    expect(pushResult?.error).toBe("Permission denied");
    expect(result.current.error).toBe("Permission denied");
  });

  it("does not fetch when projectId or branchName is null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { ahead: 0, behind: 0 } }),
    });

    renderHook(() => useGitStatus(null, "main"));

    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not fetch when branchName is null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { ahead: 0, behind: 0 } }),
    });

    renderHook(() => useGitStatus("proj-1", null));

    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
