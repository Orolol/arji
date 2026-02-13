import { beforeEach, describe, expect, it, vi } from "vitest";

const mockValidateGitHubToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github/client", () => ({
  validateGitHubToken: mockValidateGitHubToken,
}));

describe("POST /api/settings/github/validate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when token is missing", async () => {
    const { POST } = await import("@/app/api/settings/github/validate/route");

    const res = await POST(
      { json: () => Promise.resolve({ token: "" }) } as unknown as import("next/server").NextRequest
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.data.valid).toBe(false);
    expect(json.error).toBe("Enter a GitHub personal access token to validate.");
  });

  it("returns validity and login when token is valid", async () => {
    mockValidateGitHubToken.mockResolvedValue({
      valid: true,
      login: "octocat",
    });

    const { POST } = await import("@/app/api/settings/github/validate/route");
    const res = await POST(
      { json: () => Promise.resolve({ token: "ghp_good" }) } as unknown as import("next/server").NextRequest
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ valid: true, login: "octocat" });
    expect(mockValidateGitHubToken).toHaveBeenCalledWith("ghp_good");
  });

  it("returns 401 with actionable error when token is invalid", async () => {
    mockValidateGitHubToken.mockResolvedValue({
      valid: false,
      error: "GitHub rejected the token. Verify it and try again.",
    });

    const { POST } = await import("@/app/api/settings/github/validate/route");
    const res = await POST(
      { json: () => Promise.resolve({ token: "ghp_bad" }) } as unknown as import("next/server").NextRequest
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data.valid).toBe(false);
    expect(json.error).toBe("GitHub rejected the token. Verify it and try again.");
  });
});
