import { describe, it, expect } from "vitest";
import { parseRemoteUrl } from "@/lib/git/remote";

describe("parseRemoteUrl", () => {
  it("parses HTTPS URL with .git suffix", () => {
    const result = parseRemoteUrl("https://github.com/octocat/hello-world.git");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses HTTPS URL without .git suffix", () => {
    const result = parseRemoteUrl("https://github.com/octocat/hello-world");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses SSH URL with .git suffix", () => {
    const result = parseRemoteUrl("git@github.com:octocat/hello-world.git");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseRemoteUrl("git@github.com:octocat/hello-world");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("parses HTTPS URL with www prefix", () => {
    const result = parseRemoteUrl("https://www.github.com/octocat/hello-world.git");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });

  it("handles repo names with hyphens and underscores", () => {
    const result = parseRemoteUrl("https://github.com/my-org/my_cool-repo.git");
    expect(result).toEqual({ owner: "my-org", repo: "my_cool-repo" });
  });

  it("returns null for non-GitHub URLs", () => {
    const result = parseRemoteUrl("https://gitlab.com/octocat/hello-world.git");
    expect(result).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    const result = parseRemoteUrl("not-a-url");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseRemoteUrl("");
    expect(result).toBeNull();
  });

  it("handles HTTP URLs (without S)", () => {
    const result = parseRemoteUrl("http://github.com/octocat/hello-world.git");
    expect(result).toEqual({ owner: "octocat", repo: "hello-world" });
  });
});
