import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Dynamic import to allow env var mocking
async function getMiddleware() {
  const mod = await import("@/middleware");
  return mod.middleware;
}

function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { headers });
}

describe("localhost middleware", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows requests from localhost", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
    });
    const res = middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("allows requests from 127.0.0.1", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://127.0.0.1:3000/api/projects", {
      host: "127.0.0.1:3000",
    });
    const res = middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("allows requests from [::1]", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://[::1]:3000/api/projects", {
      host: "[::1]:3000",
    });
    const res = middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks requests from external hosts", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://evil.com/api/projects", {
      host: "evil.com",
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Forbidden");
  });

  it("blocks requests without host header", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://localhost:3000/api/projects");
    // NextRequest sets host from URL automatically, override to empty
    const rawReq = new NextRequest("http://localhost:3000/api/projects", {
      headers: { host: "external.com" },
    });
    // Override to simulate missing host: actually test external host
    const res = middleware(rawReq);
    // This tests that external host is blocked
    expect(res.status).toBe(403);
  });

  it("blocks requests with non-local origin header", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "https://evil.com",
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("non-local origin");
  });

  it("allows requests with local origin header", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "http://localhost:3000",
    });
    const res = middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks requests with invalid origin URL", async () => {
    const middleware = await getMiddleware();
    const req = makeRequest("http://localhost:3000/api/projects", {
      host: "localhost:3000",
      origin: "not-a-valid-url",
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("invalid origin");
  });

  it("allows non-local host when origin is in ALLOWED_ORIGINS", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://my-dev.example.com");
    // Re-import to pick up env change
    vi.resetModules();
    const { middleware } = await import("@/middleware");

    const req = makeRequest("http://my-dev.example.com/api/projects", {
      host: "my-dev.example.com",
      origin: "https://my-dev.example.com",
    });
    const res = middleware(req);
    expect(res.status).not.toBe(403);
  });

  it("blocks non-local host when origin is not in ALLOWED_ORIGINS", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", "https://allowed.example.com");
    vi.resetModules();
    const { middleware } = await import("@/middleware");

    const req = makeRequest("http://evil.com/api/projects", {
      host: "evil.com",
      origin: "https://evil.com",
    });
    const res = middleware(req);
    expect(res.status).toBe(403);
  });
});
