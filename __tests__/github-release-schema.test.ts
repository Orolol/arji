import { describe, it, expect } from "vitest";
import * as schema from "@/lib/db/schema";

describe("Schema: releases table GitHub fields", () => {
  it("has githubReleaseId column defined", () => {
    const col = schema.releases.githubReleaseId;
    expect(col).toBeDefined();
    expect(col.name).toBe("github_release_id");
  });

  it("githubReleaseId is nullable (no notNull)", () => {
    const col = schema.releases.githubReleaseId;
    expect(col.notNull).toBeFalsy();
  });

  it("has githubReleaseUrl column defined", () => {
    const col = schema.releases.githubReleaseUrl;
    expect(col).toBeDefined();
    expect(col.name).toBe("github_release_url");
  });

  it("githubReleaseUrl is nullable", () => {
    const col = schema.releases.githubReleaseUrl;
    expect(col.notNull).toBeFalsy();
  });

  it("has pushedAt column defined", () => {
    const col = schema.releases.pushedAt;
    expect(col).toBeDefined();
    expect(col.name).toBe("pushed_at");
  });

  it("pushedAt is nullable", () => {
    const col = schema.releases.pushedAt;
    expect(col.notNull).toBeFalsy();
  });

  it("preserves existing columns alongside new ones", () => {
    expect(schema.releases.id).toBeDefined();
    expect(schema.releases.projectId).toBeDefined();
    expect(schema.releases.version).toBeDefined();
    expect(schema.releases.title).toBeDefined();
    expect(schema.releases.changelog).toBeDefined();
    expect(schema.releases.epicIds).toBeDefined();
    expect(schema.releases.gitTag).toBeDefined();
    expect(schema.releases.createdAt).toBeDefined();
  });
});

describe("Schema: Release exported types", () => {
  it("exports select and insert types", () => {
    const releaseShape: schema.Release = {
      id: "rel_1",
      projectId: "proj_1",
      version: "1.0.0",
      title: "First Release",
      changelog: "# Changes",
      epicIds: '["ep_1"]',
      gitTag: "v1.0.0",
      githubReleaseId: 12345,
      githubReleaseUrl: "https://github.com/owner/repo/releases/12345",
      pushedAt: "2025-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
    };
    expect(releaseShape.githubReleaseId).toBe(12345);
    expect(releaseShape.githubReleaseUrl).toContain("github.com");
    expect(releaseShape.pushedAt).toBeTruthy();
  });

  it("allows null GitHub fields for local-only releases", () => {
    const localRelease: schema.Release = {
      id: "rel_2",
      projectId: "proj_1",
      version: "0.1.0",
      title: null,
      changelog: null,
      epicIds: null,
      gitTag: null,
      githubReleaseId: null,
      githubReleaseUrl: null,
      pushedAt: null,
      createdAt: null,
    };
    expect(localRelease.githubReleaseId).toBeNull();
    expect(localRelease.githubReleaseUrl).toBeNull();
    expect(localRelease.pushedAt).toBeNull();
  });
});
