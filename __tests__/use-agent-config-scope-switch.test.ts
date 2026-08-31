import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  useAgentAssignments,
  useAgentPrompts,
  type ResolvedAgentAssignment,
} from "@/hooks/useAgentConfig";

const PROJECT_URL = "/api/projects/proj-1/agent-config/providers";
const GLOBAL_URL = "/api/agent-config/providers";

const projectAssignment = {
  agentType: "build",
  provider: "codex",
  namedAgentId: "project-builder",
  source: "project",
  scope: "proj-1",
} as unknown as ResolvedAgentAssignment;

type ScopeProps = {
  scope: "global" | "project";
  projectId: string | undefined;
};

/**
 * These hooks are keyed by the URL they fetch, and the settings screens flip
 * that URL under a live mount when the user switches between the project and
 * the shared scope. A row shown after such a switch is not just stale: the
 * editor writes back to the *currently selected* scope, so a project prompt
 * displayed as a global one is edited into the global scope.
 */
describe("agent config scope switches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows no assignments when the new scope's request fails", async () => {
    global.fetch = vi.fn((url: string) => {
      if (url === PROJECT_URL) {
        return Promise.resolve({
          json: () => Promise.resolve({ data: [projectAssignment] }),
        });
      }
      return Promise.reject(new Error("offline"));
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ scope, projectId }: ScopeProps) => useAgentAssignments(scope, projectId),
      { initialProps: { scope: "project", projectId: "proj-1" } as ScopeProps }
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ scope: "global", projectId: undefined });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
  });

  it("shows no prompts when the new scope's response is unreadable", async () => {
    global.fetch = vi.fn((url: string) => {
      if (url === "/api/projects/proj-1/agent-config/prompts") {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: [
                {
                  agentType: "build",
                  systemPrompt: "project prompt",
                  source: "project",
                  scope: "proj-1",
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        json: () => Promise.reject(new Error("not json")),
      });
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ scope, projectId }: ScopeProps) => useAgentPrompts(scope, projectId),
      { initialProps: { scope: "project", projectId: "proj-1" } as ScopeProps }
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    rerender({ scope: "global", projectId: undefined });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
  });

  it("still serves each scope's own rows when both requests succeed", async () => {
    const globalAssignment = {
      ...projectAssignment,
      namedAgentId: "global-builder",
      source: "global",
      scope: "global",
    } as unknown as ResolvedAgentAssignment;

    global.fetch = vi.fn((url: string) =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            data: url === PROJECT_URL ? [projectAssignment] : [globalAssignment],
          }),
      })
    ) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ scope, projectId }: ScopeProps) => useAgentAssignments(scope, projectId),
      { initialProps: { scope: "project", projectId: "proj-1" } as ScopeProps }
    );

    await waitFor(() =>
      expect(result.current.data[0]?.namedAgentId).toBe("project-builder")
    );

    rerender({ scope: "global", projectId: undefined });

    await waitFor(() =>
      expect(result.current.data[0]?.namedAgentId).toBe("global-builder")
    );
    expect(global.fetch).toHaveBeenCalledWith(GLOBAL_URL);
  });

  it("ignores a scope's reload that lands after the user moved on", async () => {
    const globalAssignment = {
      ...projectAssignment,
      namedAgentId: "global-builder",
      source: "global",
      scope: "global",
    } as unknown as ResolvedAgentAssignment;

    let releaseStaleProject: ((value: unknown) => void) | null = null;
    let projectCalls = 0;

    global.fetch = vi.fn((url: string) => {
      if (url === PROJECT_URL) {
        projectCalls += 1;
        if (projectCalls === 1) {
          return Promise.resolve({
            json: () => Promise.resolve({ data: [projectAssignment] }),
          });
        }
        // The reload a save fires; still in flight when the scope changes.
        return new Promise((resolve) => {
          releaseStaleProject = resolve;
        });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ data: [globalAssignment] }),
      });
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ scope, projectId }: ScopeProps) => useAgentAssignments(scope, projectId),
      { initialProps: { scope: "project", projectId: "proj-1" } as ScopeProps }
    );

    await waitFor(() =>
      expect(result.current.data[0]?.namedAgentId).toBe("project-builder")
    );

    // Every mutation ends in `await load()`, so a request for the project
    // scope can outlive the switch to the shared one.
    act(() => {
      void result.current.refresh();
    });

    rerender({ scope: "global", projectId: undefined });
    await waitFor(() =>
      expect(result.current.data[0]?.namedAgentId).toBe("global-builder")
    );

    // Nothing re-fetches the shared scope on its own: rows evicted here stay
    // gone, and the tab falls back to a spinner over an unchanged URL.
    await act(async () => {
      releaseStaleProject!({
        json: () => Promise.resolve({ data: [projectAssignment] }),
      });
    });

    expect(result.current.data[0]?.namedAgentId).toBe("global-builder");
    expect(result.current.loading).toBe(false);
  });
});
