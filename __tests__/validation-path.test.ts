import { describe, it, expect, vi, beforeEach } from "vitest";
import { validatePath } from "@/lib/validation/path";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises");

describe("validatePath", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid absolute directory path", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("/home/user/project");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalizedPath).toBe("/home/user/project");
    }
  });

  it("normalizes relative path components", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("/home/user/./project");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalizedPath).toBe("/home/user/project");
    }
  });

  it("rejects path with traversal (..) components", async () => {
    const result = await validatePath("/home/user/../../etc/passwd");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("traversal");
    }
  });

  it("rejects a trailing (..) segment", async () => {
    const result = await validatePath("/home/user/project/..");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("traversal");
    }
  });

  it("rejects (..) segments on Windows-style separators too", async () => {
    const result = await validatePath("C:\\projects\\..\\etc");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("traversal");
    }
  });

  it("accepts consecutive dots inside a file or directory name", async () => {
    // A `..` *inside* a segment is not a traversal: the segments are already
    // isolated by the separator and resolve() normalises afterwards. A
    // user-supplied local directory with such a name imports instead of
    // 400ing at the analysis step. (GitHub imports never produce one: the
    // repo-reference parser rejects `..` in owner/repo segments outright.)
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("/home/user/projects/owner-repo..v2");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalizedPath).toBe("/home/user/projects/owner-repo..v2");
    }
  });

  it("rejects empty string", async () => {
    const result = await validatePath("");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("required");
    }
  });

  it("rejects whitespace-only string", async () => {
    const result = await validatePath("   ");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("required");
    }
  });

  it("rejects non-existent path", async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error("ENOENT"));
    const result = await validatePath("/nonexistent/path");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("does not exist");
    }
  });

  it("rejects path that is a file, not a directory", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as any);
    const result = await validatePath("/home/user/file.txt");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("not a directory");
    }
  });

  it("rejects null bytes in path", async () => {
    const result = await validatePath("/home/user/\0malicious");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("invalid characters");
    }
  });

  it("trims whitespace from path before validation", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as any);
    const result = await validatePath("  /home/user/project  ");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalizedPath).toBe("/home/user/project");
    }
  });
});
