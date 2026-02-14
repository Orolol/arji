/**
 * Regression tests — ensure no runtime path still depends on raw provider
 * selection (ProviderSelect component or providerOverride parameter).
 *
 * After the named-agent migration, runtime components should use
 * namedAgentId exclusively. ProviderSelect should only appear in admin
 * screens (components/settings/, components/shared/).
 */
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf-8");
}

// ---------------------------------------------------------------------------
// 1. ProviderSelect must NOT be imported in runtime components
// ---------------------------------------------------------------------------

describe("ProviderSelect not imported in runtime components", () => {
  const runtimeComponents = [
    "components/epic/EpicActions.tsx",
    "components/story/StoryActions.tsx",
    "components/chat/UnifiedChatPanel.tsx",
    "app/projects/[projectId]/page.tsx",
  ];

  for (const filePath of runtimeComponents) {
    it(`${filePath} does not import ProviderSelect`, () => {
      const content = readFile(filePath);
      expect(content).not.toMatch(/import\s+.*ProviderSelect/);
      expect(content).not.toMatch(/from\s+['"].*ProviderSelect['"]/);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. ProviderSelect only exists in admin / shared paths
// ---------------------------------------------------------------------------

describe("ProviderSelect only in admin paths", () => {
  it("ProviderSelect component file lives under components/shared/", () => {
    const filePath = path.join(root, "components/shared/ProviderSelect.tsx");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("no runtime component directory imports ProviderSelect", () => {
    const runtimeDirs = [
      "components/epic",
      "components/story",
      "components/chat",
      "components/kanban",
    ];

    for (const dir of runtimeDirs) {
      const absDir = path.join(root, dir);
      if (!fs.existsSync(absDir)) continue;

      const files = fs
        .readdirSync(absDir)
        .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

      for (const file of files) {
        const content = fs.readFileSync(path.join(absDir, file), "utf-8");
        expect(content, `${dir}/${file} should not import ProviderSelect`).not.toMatch(
          /import\s+.*ProviderSelect/
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. API routes use namedAgentId, not raw provider
// ---------------------------------------------------------------------------

describe("API routes use namedAgentId, not provider", () => {
  const apiRoutes = [
    "app/api/projects/[projectId]/stories/[storyId]/build/route.ts",
    "app/api/projects/[projectId]/stories/[storyId]/review/route.ts",
    "app/api/projects/[projectId]/epics/[epicId]/build/route.ts",
    "app/api/projects/[projectId]/epics/[epicId]/review/route.ts",
    "app/api/projects/[projectId]/build/route.ts",
    "app/api/projects/[projectId]/chat/route.ts",
  ];

  for (const routePath of apiRoutes) {
    describe(routePath, () => {
      it("contains namedAgentId", () => {
        const content = readFile(routePath);
        expect(content).toMatch(/namedAgentId/);
      });

      it("does not destructure provider from body for agent selection", () => {
        const content = readFile(routePath);
        // Should not have { provider } or { ..., provider, ... } destructured from body
        // for the purpose of agent selection / override.
        // We look for the providerOverride pattern specifically.
        expect(content).not.toMatch(/providerOverride/);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 4. resolveAgent has no providerOverride parameter
// ---------------------------------------------------------------------------

describe("resolveAgent signature", () => {
  it("resolveAgent accepts at most 2 parameters (agentType, projectId)", () => {
    const content = readFile("lib/agent-config/providers.ts");

    // Find the resolveAgent function signature (not resolveAgentByNamedId or resolveAgentProvider)
    const signatureMatch = content.match(
      /export\s+function\s+resolveAgent\s*\(([^)]*)\)/
    );
    expect(signatureMatch).not.toBeNull();

    const params = signatureMatch![1]
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    expect(params.length).toBeLessThanOrEqual(2);
  });

  it("resolveAgent does not accept providerOverride", () => {
    const content = readFile("lib/agent-config/providers.ts");

    const signatureMatch = content.match(
      /export\s+function\s+resolveAgent\s*\(([^)]*)\)/
    );
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch![1]).not.toMatch(/providerOverride/);
  });
});

// ---------------------------------------------------------------------------
// 5. Hooks send namedAgentId in request bodies
// ---------------------------------------------------------------------------

describe("hooks send namedAgentId", () => {
  const hooks = [
    "hooks/useTicketAgent.ts",
    "hooks/useEpicAgent.ts",
  ];

  for (const hookPath of hooks) {
    it(`${hookPath} includes namedAgentId in request body`, () => {
      const content = readFile(hookPath);
      expect(content).toMatch(/namedAgentId/);
    });
  }
});
