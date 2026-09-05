import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTicketsRegistry } from "@/components/tickets-registry/useTicketsRegistry";

afterEach(() => vi.unstubAllGlobals());

it("requests project/search/sort before pagination and ignores superseded responses", async () => {
  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveNew = resolve; }))
    .mockResolvedValue(new Response(JSON.stringify({ data: { rows: [] } })));
  vi.stubGlobal("fetch", fetchMock);
  const hook = renderHook(({ project }) => useTicketsRegistry(project, "bug", "titre", "asc", "review"), { initialProps: { project: "p1" } });
  hook.rerender({ project: "p2" });
  const url = new URL(fetchMock.mock.calls[1][0], "http://localhost");
  expect(Object.fromEntries(url.searchParams)).toEqual({ project: "p2", q: "bug", sort: "titre", direction: "asc", status: "review" });
  await act(async () => resolveOld(new Response(JSON.stringify({ data: { rows: [{ epicId: "old" }] } }))));
  expect(hook.result.current.data).toBeNull();
  await act(async () => resolveNew(new Response(JSON.stringify({ data: { rows: [] } }))));
  expect(hook.result.current.data?.rows).toEqual([]);
  act(() => hook.result.current.setWindow("released", 100));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(new URL(fetchMock.mock.calls[2][0], "http://localhost").searchParams.get("releasedLimit")).toBe("100");
});
