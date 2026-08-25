import { describe, expect, it } from "vitest";
import { redactGitError } from "@/lib/git/clone";

const PAT = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

describe("redactGitError", () => {
  it("strips the Basic header this service injects", () => {
    const basic = Buffer.from(`x-access-token:${PAT}`).toString("base64");
    const stderr = [
      `fatal: unable to access 'https://github.com/acme/private.git/':`,
      `while running: git -c http.extraHeader=Authorization: Basic ${basic} clone -- https://github.com/acme/private.git /w/acme-private`,
    ].join("\n");

    const redacted = redactGitError(stderr);

    expect(redacted).not.toContain(basic);
    expect(redacted).not.toContain(PAT);
    expect(redacted).toContain("[REDACTED]");
  });

  it("strips credentials embedded in a remote URL", () => {
    const redacted = redactGitError(
      `fatal: could not read from 'https://x-access-token:${PAT}@github.com/acme/private.git'`
    );

    expect(redacted).not.toContain(PAT);
    expect(redacted).toContain("https://[REDACTED]@github.com/acme/private.git");
  });

  it("strips a raw PAT the caller passes in, wherever it appears", () => {
    const redacted = redactGitError(
      new Error(`remote: token ${PAT} was rejected`),
      [PAT]
    );

    expect(redacted).not.toContain(PAT);
    expect(redacted).toContain("remote: token [REDACTED] was rejected");
  });

  it("strips bare GitHub token shapes even when nothing was passed in", () => {
    expect(redactGitError(`fatal: bad token ${PAT}`)).not.toContain(PAT);
    expect(
      redactGitError("fatal: bad token github_pat_11ABCDEFG0abcdefghij1234")
    ).not.toContain("github_pat_11ABCDEFG0abcdefghij1234");
    expect(redactGitError("Authorization: Bearer abcdef.ghijkl-123")).toBe(
      "Authorization: Bearer [REDACTED]"
    );
  });

  it("keeps the actionable part of the message intact", () => {
    const redacted = redactGitError(
      new Error("fatal: repository 'https://github.com/acme/nope.git/' not found")
    );

    expect(redacted).toBe(
      "fatal: repository 'https://github.com/acme/nope.git/' not found"
    );
  });

  it("fully redacts a real clone failure carrying the token in every form", () => {
    // One sample, every way git manages to echo a credential back: the header
    // we injected, the base64 payload on its own, a URL with userinfo, and the
    // raw PAT in a remote's message. A single leak here reaches the UI and
    // git_sync_log at once.
    const basic = Buffer.from(`x-access-token:${PAT}`).toString("base64");
    const stderr = [
      `Cloning into '/home/user/arij/projects/acme-private'...`,
      `fatal: unable to access 'https://x-access-token:${PAT}@github.com/acme/private.git/': The requested URL returned error: 403`,
      `remote: Invalid username or password for token ${PAT}`,
      `error: RPC failed; HTTP 403 curl 22`,
      `while running: git -c http.extraHeader=Authorization: Basic ${basic} clone -- https://github.com/acme/private.git /home/user/arij/projects/acme-private`,
    ].join("\n");

    const redacted = redactGitError(new Error(stderr), [PAT]);

    expect(redacted).not.toContain(PAT);
    expect(redacted).not.toContain(basic);
    expect(redacted).not.toMatch(/x-access-token:/);
    // Still diagnosable: the repository and the HTTP status survive.
    expect(redacted).toContain("github.com/acme/private.git");
    expect(redacted).toContain("403");
  });

  it("handles non-string inputs without throwing", () => {
    expect(redactGitError(null)).toBe("");
    expect(redactGitError(undefined)).toBe("");
    expect(redactGitError({ toString: () => `boom ${PAT}` }, [PAT])).toBe(
      "boom [REDACTED]"
    );
  });
});
