import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";

describe("useGitHubConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns configured=true when ownerRepo and token are set", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { configured: true, ownerRepo: "owner/repo", tokenSet: true },
        }),
    });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.configured).toBe(true);
    expect(result.current.ownerRepo).toBe("owner/repo");
    expect(result.current.tokenSet).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("returns configured=false when ownerRepo is missing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { configured: false, ownerRepo: null, tokenSet: true },
        }),
    });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.configured).toBe(false);
    expect(result.current.ownerRepo).toBeNull();
  });

  it("returns configured=false when token is not set", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { configured: false, ownerRepo: "owner/repo", tokenSet: false },
        }),
    });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.configured).toBe(false);
    expect(result.current.tokenSet).toBe(false);
  });

  it("handles API errors gracefully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({ error: "Project not found" }),
    });

    const { result } = renderHook(() => useGitHubConfig("proj-bad"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.configured).toBe(false);
    expect(result.current.error).toBe("Project not found");
  });

  it("handles fetch failure gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.configured).toBe(false);
    expect(result.current.error).toBe("Network error");
  });

  it("starts in loading state", () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { configured: false, ownerRepo: null, tokenSet: false },
        }),
    });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));
    expect(result.current.loading).toBe(true);
  });

  it("does not fetch when projectId is null", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });

    renderHook(() => useGitHubConfig(null));

    // Give it a tick to potentially fire
    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
