import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import { en } from "@/lib/i18n/messages";
import { useProjects } from "@/hooks/useProjects";
import { useReleasePublish } from "@/hooks/useReleasePublish";

// Exercise the real provider, not the global component-test translator mock.
vi.unmock("next-intl");
afterEach(() => vi.unstubAllGlobals());

function wrapper({ children }: { children: ReactNode }) {
  return <NextIntlClientProvider locale="en" messages={{ ...en, ClientErrors: {
    ...en.ClientErrors,
    failedToLoadProjects: "The project list is unavailable.",
    projectsHttp: "The project request returned {status}.",
  } }}>{children}</NextIntlClientProvider>;
}

it("resolves network fallback copy from the provider and can recover on refresh", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetcher);
  const { result } = renderHook(() => useProjects(), { wrapper });
  await waitFor(() => expect(result.current.error).toBe("The project list is unavailable."));
  await act(() => result.current.refresh());
  expect(result.current.error).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("formats the response status with the same catalogue", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  const { result } = renderHook(() => useProjects(), { wrapper });
  await waitFor(() => expect(result.current.error).toBe("The project request returned 503."));
});

it("preserves server-provided errors instead of translating persisted text", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Server-owned detail" }) }));
  const { result } = renderHook(() => useReleasePublish("project"), { wrapper });
  await act(() => result.current.publish("release"));
  expect(result.current.error).toBe("Server-owned detail");
});
