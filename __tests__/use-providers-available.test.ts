import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useProvidersAvailable } from "@/hooks/useProvidersAvailable";

describe("useProvidersAvailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports each provider from the availability payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: { "claude-code": true, codex: true, "oh-my-pi": false },
        }),
    });

    const { result } = renderHook(() => useProvidersAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.providers["claude-code"]).toBe(true);
    expect(result.current.providers.codex).toBe(true);
    expect(result.current.providers["oh-my-pi"]).toBe(false);
  });

  it("defaults every provider to unavailable when data is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });

    const { result } = renderHook(() => useProvidersAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(Object.values(result.current.providers).every((v) => v === false)).toBe(
      true
    );
  });

  it("falls back to all-unavailable when fetch fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useProvidersAvailable());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(Object.values(result.current.providers).every((v) => v === false)).toBe(
      true
    );
  });

  it("starts in loading state", () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });

    const { result } = renderHook(() => useProvidersAvailable());
    expect(result.current.loading).toBe(true);
  });
});
