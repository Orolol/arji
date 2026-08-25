import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinesSettings } from "@/components/routines/RoutinesSettings";

const fetchMock = vi.fn();

const kinds = [
  {
    kind: "night_run",
    label: "Night run",
    description: "Starts night work.",
  },
  {
    kind: "github_issue_sync",
    label: "GitHub issue sync",
    description: "Syncs issues.",
  },
  { kind: "ci_watch", label: "CI watch", description: "Watches CI." },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("RoutinesSettings", () => {
  it("shows status and server-local scheduling while hiding unavailable kinds", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: "r1",
            projectId: "p1",
            kind: "night_run",
            enabled: true,
            timeOfDay: "23:00",
            config: { includeBacklog: false },
            lastRunAt: "2026-08-25T19:00:00.000Z",
            lastStatus: "completed",
          },
        ],
        meta: {
          availableKinds: kinds,
          serverTimezone: "Europe/Paris",
          ciAutofixEnabled: false,
        },
      })
    );

    render(<RoutinesSettings projectId="p1" />);

    expect(await screen.findByText("Scheduled routines")).toBeInTheDocument();
    expect(await screen.findByTestId("routine-r1")).toBeInTheDocument();
    expect(screen.getByText(/server's local timezone/)).toHaveTextContent(
      "Europe/Paris"
    );
    expect(screen.getByText(/Last run:/)).toBeInTheDocument();
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("option", { name: "Dreaming" })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Enable CI autofix")).not.toBeChecked();
  });

  it("creates a routine with kind, time, enabled state and parsed config", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/routines") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({
          data: {
            id: "created",
            projectId: "p1",
            ...body,
            lastRunAt: null,
            lastStatus: null,
          },
        }, 201);
      }
      return jsonResponse({
        data: [],
        meta: {
          availableKinds: kinds,
          serverTimezone: "Europe/Paris",
          ciAutofixEnabled: false,
        },
      });
    });

    render(<RoutinesSettings projectId="p1" />);
    await screen.findByText("No routines configured");
    fireEvent.click(screen.getByRole("button", { name: "Add routine" }));

    fireEvent.change(screen.getByLabelText("Kind"), {
      target: { value: "ci_watch" },
    });
    fireEvent.change(screen.getByLabelText("Daily time"), {
      target: { value: "08:45" },
    });
    fireEvent.change(screen.getByLabelText("Configuration (JSON)"), {
      target: { value: '{"intervalMinutes": 10}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/routines",
        expect.objectContaining({ method: "POST" })
      );
    });
    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      kind: "ci_watch",
      enabled: true,
      timeOfDay: "08:45",
      config: { intervalMinutes: 10 },
    });
    expect(await screen.findByTestId("routine-created")).toBeInTheDocument();
  });

  it("toggles and deletes an existing routine through scoped endpoints", async () => {
    const routine = {
      id: "r1",
      projectId: "p1",
      kind: "night_run",
      enabled: true,
      timeOfDay: "23:00",
      config: {},
      lastRunAt: null,
      lastStatus: null,
    };
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          data: { ...routine, enabled: JSON.parse(String(init.body)).enabled },
        });
      }
      if (init?.method === "DELETE") {
        return jsonResponse({ data: { deleted: true } });
      }
      return jsonResponse({
        data: [routine],
        meta: {
          availableKinds: kinds,
          serverTimezone: "Europe/Paris",
          ciAutofixEnabled: false,
        },
      });
    });

    render(<RoutinesSettings projectId="p1" />);
    const enabled = await screen.findByLabelText("Enable Night run");
    fireEvent.click(enabled);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/routines/r1",
        expect.objectContaining({ method: "PATCH" })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Night run" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/routines/r1",
        { method: "DELETE" }
      )
    );
    expect(await screen.findByText("No routines configured")).toBeInTheDocument();
  });
});
