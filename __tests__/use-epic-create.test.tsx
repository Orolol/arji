import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEpicCreate } from "@/hooks/useEpicCreate";

describe("useEpicCreate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it("extracts epic data from conversation and posts to /epics", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { role: "user", content: "I want to improve account security." },
              {
                role: "assistant",
                content: `
Epic Title: Account Security
Description: Improve authentication and alerts across the platform.

User Stories:
- As a user, I want two-factor authentication so that my account stays secure.
Acceptance Criteria:
- [ ] Users can enable 2FA from settings
- [ ] Recovery codes are generated
- As an admin, I want suspicious login alerts so that I can respond quickly.
Acceptance Criteria:
- [ ] Alerts are sent for unusual login locations
`,
              },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              id: "epic-1",
              title: "Account Security",
              userStoriesCreated: 2,
            },
          }),
      });

    const onEpicCreated = vi.fn();
    const { result } = renderHook(() =>
      useEpicCreate({
        projectId: "proj1",
        conversationId: "conv1",
        onEpicCreated,
      }),
    );

    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.createEpic();
    });

    expect(createdId).toBe("epic-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects/proj1/chat?conversationId=conv1",
    );

    const createCall = fetchMock.mock.calls[1];
    expect(createCall[0]).toBe("/api/projects/proj1/epics");
    expect(createCall[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const payload = JSON.parse((createCall[1] as { body: string }).body);
    expect(payload.title).toBe("Account Security");
    expect(payload.description).toContain("Improve authentication");
    expect(payload.userStories).toHaveLength(2);
    expect(payload.userStories[0].title).toContain("As a user");

    await waitFor(() => {
      expect(result.current.createdEpic).toEqual({
        epicId: "epic-1",
        title: "Account Security",
        userStoriesCreated: 2,
      });
    });

    expect(onEpicCreated).toHaveBeenCalledWith({
      epicId: "epic-1",
      title: "Account Security",
      userStoriesCreated: 2,
    });
  });

  it("returns a user-friendly error when no conversation is selected", async () => {
    const { result } = renderHook(() =>
      useEpicCreate({
        projectId: "proj1",
        conversationId: null,
      }),
    );

    let createdId: string | null = "placeholder";
    await act(async () => {
      createdId = await result.current.createEpic();
    });

    expect(createdId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Select an epic creation conversation first.");
  });

  it("surfaces API errors when epic creation fails", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { role: "assistant", content: '{"title":"Epic A","description":"Desc","user_stories":[{"title":"As a user, I want x so that y"}]}' },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: "Title is required" }),
      });

    const { result } = renderHook(() =>
      useEpicCreate({
        projectId: "proj1",
        conversationId: "conv1",
      }),
    );

    await act(async () => {
      await result.current.createEpic();
    });

    expect(result.current.createdEpic).toBeNull();
    expect(result.current.error).toBe("Title is required");
  });
});
