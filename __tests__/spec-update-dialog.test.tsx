/**
 * SpecUpdateDialog: the dispatch POST body. The instruction is optional —
 * it is sent only when the user typed one, and the picked named agent only
 * when one is selected (empty selection resolves to the project default at
 * dispatch time). A failed POST surfaces the error instead of reporting a
 * started session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string) => void;
  }) => (
    <button
      data-testid="named-agent-select"
      data-value={value ?? ""}
      onClick={() => onChange("picked-agent")}
    >
      agent
    </button>
  ),
}));

import { SpecUpdateDialog } from "@/components/spec/SpecUpdateDialog";

interface FetchLog {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(responder: (url: string) => unknown): FetchLog[] {
  const log: FetchLog[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      log.push({ url, method: init?.method ?? "GET", body: init?.body });
      return {
        ok: true,
        json: async () => responder(url),
      } as Response;
    })
  );
  return log;
}

function parseBody(log: FetchLog[]): Record<string, unknown> {
  return JSON.parse(String(log[0].body)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("SpecUpdateDialog", () => {
  it("posts an empty body when nothing is filled and reports the started session", async () => {
    const log = installFetch(() => ({ data: { sessionId: "sess-1" } }));
    const onStarted = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <SpecUpdateDialog
        projectId="proj-1"
        open
        onOpenChange={onOpenChange}
        onStarted={onStarted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /update spec/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(log).toHaveLength(1);
    expect(log[0].url).toBe("/api/projects/proj-1/spec/update");
    expect(log[0].method).toBe("POST");
    expect(parseBody(log)).toEqual({});
    expect(onStarted).toHaveBeenCalledWith({ sessionId: "sess-1" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sends instruction and named agent when the user filled them", async () => {
    const log = installFetch(() => ({ data: { sessionId: "sess-2" } }));
    const onStarted = vi.fn();

    render(
      <SpecUpdateDialog
        projectId="proj-1"
        open
        onOpenChange={vi.fn()}
        onStarted={onStarted}
      />
    );

    fireEvent.click(screen.getByTestId("named-agent-select"));
    fireEvent.change(
      screen.getByTestId("spec-update-instruction"),
      { target: { value: "update the architecture section" } }
    );
    fireEvent.click(screen.getByRole("button", { name: /update spec/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(parseBody(log)).toEqual({
      namedAgentId: "picked-agent",
      instruction: "update the architecture section",
    });
  });

  it("shows the API error and does not report a started session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "A spec update is already in progress for this project.",
        }),
      }) as Response)
    );
    const onStarted = vi.fn();

    render(
      <SpecUpdateDialog
        projectId="proj-1"
        open
        onOpenChange={vi.fn()}
        onStarted={onStarted}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /update spec/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "A spec update is already in progress for this project."
      )
    );
    expect(onStarted).not.toHaveBeenCalled();
  });
});
