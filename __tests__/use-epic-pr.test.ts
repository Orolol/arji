import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useEpicPr } from "@/hooks/useEpicPr";

/**
 * useEpicPr — PR creation request contract.
 *
 * The hook used to send `baseBranch: "main"` unconditionally, forcing the
 * route into a wrong base for develop-default clones. The base is now
 * decided by the route from the project's stored default branch, so the
 * hook omits the field unless the user explicitly chose one.
 */
describe("useEpicPr", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function postBodies(): Array<Record<string, unknown>> {
    return fetchSpy.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) =>
        JSON.parse((init as RequestInit).body as string)
      );
  }

  it("omits baseBranch when none was explicitly chosen", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: null }), { status: 200 })
    );

    const { result } = renderHook(() => useEpicPr("proj-1", "epic-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.createPr();

    const bodies = postBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].draft).toBe(false);
    expect(bodies[0]).not.toHaveProperty("baseBranch");
  });

  it("forwards an explicitly chosen base branch verbatim", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { pr: null } }), { status: 200 })
    );

    const { result } = renderHook(() => useEpicPr("proj-1", "epic-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.createPr({ baseBranch: "release-1.0", draft: true });

    const bodies = postBodies();
    expect(bodies[0]).toEqual({ baseBranch: "release-1.0", draft: true });
  });
});