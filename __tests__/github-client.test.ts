import { describe, expect, it } from "vitest";
import { parseOwnerRepo } from "@/lib/github/client";

describe("parseOwnerRepo", () => {
  it("parses valid owner/repo format", () => {
    const result = parseOwnerRepo("myorg/myrepo");
    expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("throws on invalid format - no slash", () => {
    expect(() => parseOwnerRepo("myrepo")).toThrow("Invalid GitHub owner/repo format");
  });

  it("throws on invalid format - too many slashes", () => {
    expect(() => parseOwnerRepo("a/b/c")).toThrow("Invalid GitHub owner/repo format");
  });

  it("throws on empty owner", () => {
    expect(() => parseOwnerRepo("/repo")).toThrow("Invalid GitHub owner/repo format");
  });

  it("throws on empty repo", () => {
    expect(() => parseOwnerRepo("owner/")).toThrow("Invalid GitHub owner/repo format");
  });

  it("throws on empty string", () => {
    expect(() => parseOwnerRepo("")).toThrow("Invalid GitHub owner/repo format");
  });
});
