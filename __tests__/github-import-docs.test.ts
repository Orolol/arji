/**
 * The GitHub import is only discoverable if it is documented, and the docs are
 * only useful while they stay true. These assertions pin the facts a user acts
 * on — where clones land, what private repositories need, why clones are full —
 * and the two that are easy to get wrong from memory: the PAT lives in the
 * settings table (not `GITHUB_TOKEN`), and `projects/` is gitignored.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECTS_ROOT_DIRNAME,
  PROJECTS_ROOT_SETTING_KEY,
} from "@/lib/projects/workspace-constants";

function read(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf-8");
}

const readme = read("README.md");
const claudeMd = read("CLAUDE.md");
const importDoc = read("docs", "architecture", "github-import.md");
const gitignore = read(".gitignore");

describe("README — importing from GitHub", () => {
  it("documents the GitHub URL import in the first-project walkthrough", () => {
    expect(readme).toContain("### Your First Project");
    expect(readme).toMatch(/Import from a GitHub URL/i);

    const firstProject = readme.slice(readme.indexOf("### Your First Project"));
    // Every shape the parser accepts is worth showing: users paste browser
    // URLs and the `owner/repo` shorthand at least as often as clone URLs.
    expect(firstProject).toContain("https://github.com/owner/repo");
    expect(firstProject).toContain("git@github.com:owner/repo.git");
    expect(firstProject).toMatch(/owner\/repo\s+#\s+shorthand/);
  });

  it("says where the code will land, and how to change it", () => {
    expect(readme).toContain(PROJECTS_ROOT_SETTING_KEY);
    expect(readme).toMatch(
      new RegExp(`<arij>/${DEFAULT_PROJECTS_ROOT_DIRNAME}`)
    );
    expect(readme).toMatch(/<projects root>\/<owner>-<repo>/);
    // A relative override would move with the server's cwd, so it is refused.
    expect(readme).toMatch(/relative one.*refused/is);
  });

  it("states that private repositories need the PAT from Paramètres", () => {
    expect(readme).toMatch(/[Pp]rivate repositories.*PAT/s);
    // The settings sheet became the Paramètres screen in the control-desk
    // redesign; the PAT now lives on its Intégrations section. The fact a user
    // acts on is unchanged — only where they go to do it.
    expect(readme).toContain("Paramètres → Intégrations");
    expect(readme).toMatch(/settings.*table/i);
  });

  it("corrects the stale GITHUB_TOKEN mention instead of leaving it", () => {
    // It used to be listed as the way to authenticate. No code reads it.
    expect(readme).not.toMatch(/^GITHUB_TOKEN=/m);
    expect(readme).toMatch(/`GITHUB_TOKEN`[^.]*not[^.]*read/i);
  });

  it("explains that clones are full clones, and why", () => {
    expect(readme).toMatch(/full clones/i);
    expect(readme).toContain("--depth");
    expect(readme).toMatch(/worktrees/i);
  });
});

describe("CLAUDE.md — file structure", () => {
  it("lists projects/ as gitignored, app-managed clones", () => {
    expect(claudeMd).toMatch(/^- `projects\/`/m);

    const entry = claudeMd.slice(claudeMd.indexOf("- `projects/`"));
    expect(entry).toMatch(/gitignored/);
    expect(entry).toMatch(/<owner>-<repo>/);
    expect(entry).toContain(PROJECTS_ROOT_SETTING_KEY);
  });

  it("keeps the tracked source directories distinguishable from it", () => {
    // `app/projects/` and `lib/projects/` are tracked; only the root
    // `projects/` is ignored, and the .gitignore rule is anchored to say so.
    expect(claudeMd).toMatch(/app\/projects\/.*lib\/projects\//s);
    expect(gitignore).toMatch(/^\/projects$/m);
  });

  it("warns that migrations are hand-written", () => {
    expect(claudeMd).toMatch(/drizzle-kit generate/);
    expect(claudeMd).toMatch(/[Dd]o not run `npx drizzle-kit generate`/);
  });
});

describe("docs/architecture/github-import.md", () => {
  it("documents the request flow across the three endpoints", () => {
    expect(importDoc).toContain("POST /api/projects/clone");
    expect(importDoc).toContain("POST /api/projects/import");
    expect(importDoc).toContain("POST /api/projects");
  });

  it("explains the full-clone requirement in terms of what would break", () => {
    expect(importDoc).toContain("--depth");
    expect(importDoc).toContain("--single-branch");
    expect(importDoc).toMatch(/merge.base/i);
    expect(importDoc).toMatch(/worktree/i);
  });

  it("documents the credential handling", () => {
    expect(importDoc).toContain("http.extraHeader");
    expect(importDoc).toMatch(/never\s+reaches\s+`\.git\/config`/);
    expect(importDoc).toContain("redactGitError()");
    expect(importDoc).toMatch(/`GITHUB_TOKEN`.*not read/s);
  });

  it("documents the workspace layout including the worktree directory", () => {
    expect(importDoc).toContain(".arij-worktrees");
    expect(importDoc).toContain("<owner>-<repo>");
    expect(importDoc).toContain("gitignored");
  });

  it("names both migrations that ship with the feature", () => {
    expect(importDoc).toContain("0028_project_clone_source");
    expect(importDoc).toContain("0029_git_sync_log_nullable_project");
  });

  it("points at the test files, and each one exists", () => {
    const referenced = [
      ...importDoc.matchAll(/`((?:__tests__|e2e)\/[\w.-]+\.(?:tsx?|spec\.ts))`/g),
    ].map((match) => match[1]);

    expect(referenced.length).toBeGreaterThan(5);
    for (const file of new Set(referenced)) {
      expect(() => read(file), `${file} is referenced but missing`).not.toThrow();
    }
  });
});
