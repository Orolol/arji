import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The localhost boundary for `/api/*`, formerly `middleware.ts`, renamed to
 * `proxy.ts` when Next 16 deprecated the `middleware` file convention.
 *
 * These are the behavioural assertions: both directions of the guard, driven
 * through the exported function. That the file is under the name Next actually
 * loads, and is packaged, is pinned separately in
 * `proxy-file-convention.test.ts` — a correct function Next never loads passes
 * everything below and still ships an open API.
 */

async function getProxy() {
  // Dynamic import so `vi.resetModules()` + `vi.stubEnv` can re-read
  // ALLOWED_ORIGINS between cases.
  const mod = await import("@/proxy");
  return mod.proxy;
}

function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { headers });
}

describe("localhost proxy", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports the boundary as `proxy`", async () => {
    const mod = await import("@/proxy");
    expect(typeof mod.proxy).toBe("function");
  });

  it("still scopes the boundary to /api/*", async () => {
    const mod = await import("@/proxy");
    expect(mod.config.matcher).toEqual(["/api/:path*"]);
  });

  it("allows requests from localhost", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
    });
    const res = proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows requests from 127.0.0.1", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://127.0.0.1:3000/api/projects", {
      host: "127.0.0.1:3000",
    });
    const res = proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("allows requests from [::1]", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://[::1]:3000/api/projects", {
      host: "[::1]:3000",
    });
    const res = proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks requests from external hosts", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://evil.com/api/projects", {
      host: "evil.com",
    });
    const res = proxy(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Forbidden");
  });

  it("blocks requests without a host header", async () => {
    // `isLocalHost(null)` is a distinct branch from "host present but
    // foreign", and it is the one that decides a request carrying no `Host`
    // at all. It must deny, not default to allowing.
    //
    // The version of this test inherited from `validation-middleware.test.ts`
    // asserted nothing of the sort: it built a header-less request, dropped it
    // on the floor, and re-tested `external.com` — a duplicate of the case
    // above — under a comment claiming NextRequest backfills `Host` from the
    // URL. It does not; a bare `new NextRequest(url)` carries no `Host`
    // header, so the branch is directly reachable.
    const proxy = await getProxy();
    const req = new NextRequest("http://localhost:3000/api/projects");
    expect(req.headers.get("host")).toBeNull();

    const res = proxy(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("non-local request");
  });

  it("blocks requests with non-local origin header", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "http://evil.com",
    });
    const res = proxy(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("non-local origin");
  });

  it("allows requests with local origin header", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "http://localhost:3000",
    });
    const res = proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks requests with invalid origin URL", async () => {
    const proxy = await getProxy();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "not-a-valid-url",
    });
    const res = proxy(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("invalid origin");
  });

  it("allows non-local host when origin is in ALLOWED_ORIGINS", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://my-dev.example.com");
    // Re-import to pick up env change
    vi.resetModules();
    const { proxy } = await import("@/proxy");

    const req = makeRequest("http://my-dev.example.com/api/projects", {
      host: "my-dev.example.com",
      origin: "https://my-dev.example.com",
    });
    const res = proxy(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks non-local host when origin is not in ALLOWED_ORIGINS", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://allowed.example.com");
    vi.resetModules();
    const { proxy } = await import("@/proxy");

    const req = makeRequest("http://evil.com/api/projects", {
      host: "evil.com",
      origin: "https://evil.com",
    });
    const res = proxy(req);
    expect(res.status).toBe(403);
  });
});
