/**
 * `MentionTextarea` is mounted by surfaces whose project resolves *after* the
 * first paint — the chat page's composer is the reported case, and it used to
 * hand the field `projectId ?? ""`.
 *
 * An empty (or `null`) segment does not produce an empty path component: the
 * URL parser collapses `/api/projects//documents` to `/api/projects/documents`,
 * a route nothing serves, so every /chat load left 404s in the network log.
 * The guard is on the identifier, not on the response.
 *
 * The second half is the project switch: the documents in state belong to the
 * project that was asked for, so a switch must drop them immediately AND a
 * response from the project that was left behind must never land.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { MentionTextarea } from "@/components/documents/MentionTextarea";

interface Doc {
  id: string;
  originalFilename: string;
}

function jsonOk(docs: Doc[]) {
  return { ok: true, json: () => Promise.resolve({ data: docs }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonOk([]));
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** Every URL the component asked for that looks like a documents list. */
function documentRequests(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes("documents"));
}

/** The field is controlled; the harness owns the value so typing sticks. */
function Harness({ projectId }: { projectId: string | null }) {
  const [value, setValue] = useState("");
  return (
    <MentionTextarea
      projectId={projectId}
      value={value}
      onValueChange={setValue}
      aria-label="Message"
    />
  );
}

function field() {
  return screen.getByLabelText("Message");
}

describe("MentionTextarea before a project is resolved", () => {
  it("issues no documents request while the project id is null", async () => {
    await act(async () => {
      render(<Harness projectId={null} />);
    });

    expect(documentRequests()).toEqual([]);
  });

  it("issues no documents request for an empty project id", async () => {
    await act(async () => {
      render(<Harness projectId="" />);
    });

    expect(documentRequests()).toEqual([]);
  });

  it("loads exactly the resolved project's documents once it arrives", async () => {
    fetchMock.mockResolvedValue(
      jsonOk([{ id: "d1", originalFilename: "alpha.md" }]),
    );

    const { rerender } = render(<Harness projectId={null} />);
    await act(async () => {
      rerender(<Harness projectId="p1" />);
    });

    await waitFor(() =>
      expect(documentRequests()).toEqual(["/api/projects/p1/documents"]),
    );

    // The suggestions still work — the guard delays the load, it does not
    // disable the mention menu.
    await userEvent.type(field(), "@");
    expect(
      await screen.findByRole("button", { name: "alpha.md" }),
    ).toBeInTheDocument();
  });
});

describe("MentionTextarea across a project change", () => {
  it("drops the previous project's documents while the new list is in flight", async () => {
    const first = deferred<ReturnType<typeof jsonOk>>();
    const second = deferred<ReturnType<typeof jsonOk>>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/p1/")) return first.promise;
      if (String(url).includes("/p2/")) return second.promise;
      return Promise.resolve(jsonOk([]));
    });

    const { rerender } = render(<Harness projectId="p1" />);
    await act(async () => {
      first.resolve(jsonOk([{ id: "d1", originalFilename: "alpha.md" }]));
    });

    await userEvent.type(field(), "@");
    expect(
      await screen.findByRole("button", { name: "alpha.md" }),
    ).toBeInTheDocument();

    // p2's list has not answered yet: nothing may be suggested, least of all
    // a filename that belongs to p1.
    await act(async () => {
      rerender(<Harness projectId="p2" />);
    });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "alpha.md" })).toBeNull(),
    );
  });

  it("never lets a late response from the project left behind land", async () => {
    const first = deferred<ReturnType<typeof jsonOk>>();
    const second = deferred<ReturnType<typeof jsonOk>>();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/p1/")) return first.promise;
      if (String(url).includes("/p2/")) return second.promise;
      return Promise.resolve(jsonOk([]));
    });

    const { rerender } = render(<Harness projectId="p1" />);
    await act(async () => {
      rerender(<Harness projectId="p2" />);
    });

    await act(async () => {
      second.resolve(jsonOk([{ id: "d2", originalFilename: "beta.md" }]));
    });
    // p1 answers only now, long after the switch.
    await act(async () => {
      first.resolve(jsonOk([{ id: "d1", originalFilename: "alpha.md" }]));
    });

    await userEvent.type(field(), "@");
    expect(
      await screen.findByRole("button", { name: "beta.md" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "alpha.md" })).toBeNull();
  });
});
