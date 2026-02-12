import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCodexAvailable } from "@/hooks/useCodexAvailable";

describe("useCodexAvailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when codex provider is available", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { codex: true, codexInstalled: true } }),
    });

    const { result } = renderHook(() => useCodexAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.codexAvailable).toBe(true);
    expect(result.current.codexInstalled).toBe(true);
  });

  it("returns false when codex provider is unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { codex: false, codexInstalled: true } }),
    });

    const { result } = renderHook(() => useCodexAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.codexAvailable).toBe(false);
    expect(result.current.codexInstalled).toBe(true);
  });

  it("returns false when codex_api_key is missing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });

    const { result } = renderHook(() => useCodexAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.codexAvailable).toBe(false);
  });

  it("returns false when fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useCodexAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.codexAvailable).toBe(false);
  });

  it("starts in loading state", () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });

    const { result } = renderHook(() => useCodexAvailable());
    expect(result.current.loading).toBe(true);
  });
});
