/**
 * The provider registry is the single source of truth for which CLI providers
 * exist. This file pins that.
 *
 * Why it exists: epic H3WaoKFiwd8j asked whether `lib/providers/pi.ts` should
 * be deleted or registered, on the premise that it was "unreachable production
 * code" gating the build. The premise was wrong — `OhMyPiProvider extends
 * PiProvider`, so the module is live infrastructure for a *registered*
 * provider, reached through inheritance rather than through a registry key.
 * The decision recorded on the ticket is therefore **neither**: keep it as the
 * shared abstract base (see the header of lib/providers/pi.ts).
 *
 * What made that question hard to answer is the real defect, and it is what
 * these tests close: "is X a provider?" had four possible answers living in
 * four hand-maintained places, and nothing forced them to agree. A file could
 * look orphaned while being load-bearing, and a genuinely orphaned one would
 * look exactly the same.
 *
 * The invariants, all of them mechanical:
 *
 *  1. Reachability — every module under lib/providers/ is in the import
 *     closure of the registry. An orphan is a build-gating liability with no
 *     runtime consumer; that is precisely the thing this epic was filed about.
 *  2. Agreement — the registry, PROVIDER_OPTIONS, `ProviderType` and
 *     `AgentProvider` name the same set.
 *  3. No private copies — modules on the provider surface must derive the
 *     list from the registry rather than restate it. A restated list does not
 *     fail loudly when it drifts; it silently omits the new provider.
 *  4. Capability — every registered provider can be handed the MCP channel,
 *     which lib/providers/types.ts states as a hard admission rule.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getProvider } from "@/lib/providers";
import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";
import { providerSupportsMcp } from "@/lib/claude/mcp-injection";

const REPO_ROOT = path.resolve(__dirname, "..");
const PROVIDERS_DIR = path.join(REPO_ROOT, "lib/providers");
const REGISTRY_ENTRY = path.join(PROVIDERS_DIR, "index.ts");

const read = (absolute: string) => fs.readFileSync(absolute, "utf8");
const rel = (absolute: string) => path.relative(REPO_ROOT, absolute);

// ---------------------------------------------------------------------------
// Import-closure walker
// ---------------------------------------------------------------------------

/**
 * Resolve one import specifier to a file on disk. Only relative and `@/`
 * specifiers can point back into this repo; a bare specifier is a package and
 * is deliberately dropped.
 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    base = path.join(REPO_ROOT, specifier.slice(2));
  } else {
    return null;
  }

  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every repo file reachable from `entry` by following imports.
 *
 * `import type` is followed as well as a value import: a type-only module is
 * still typechecked, still gates `npm run build`, and is exactly the shape of
 * dead weight this epic was filed about.
 */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = read(file);
    // `from "x"`, `import "x"` and `import("x")`.
    const specifiers = /(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = specifiers.exec(source)) !== null) {
      const resolved = resolveSpecifier(match[1], file);
      if (resolved) pending.push(resolved);
    }
  }

  return seen;
}

// ---------------------------------------------------------------------------
// Private-copy detector
// ---------------------------------------------------------------------------

/**
 * Provider ids quoted as string literals in a module.
 *
 * Three or more is the signal: a module naming that many is enumerating the
 * provider set rather than special-casing one CLI's quirk (which is legitimate
 * and common — see the `oh-my-pi` tool-name separator in mcp-injection.ts).
 */
function quotedProviderIds(source: string): string[] {
  return PROVIDER_OPTIONS.filter((id) =>
    new RegExp(`["'\`]${id}["'\`]`).test(source),
  );
}

const ENUMERATION_THRESHOLD = 3;

function enumeratesProviderSet(source: string): boolean {
  return quotedProviderIds(source).length >= ENUMERATION_THRESHOLD;
}

/**
 * Files allowed to spell the set out, because they are where it is declared:
 * the `ProviderType` union and the registry map itself. Everything else on the
 * provider surface must derive it.
 */
const DECLARATION_SITES = new Set([
  "lib/providers/types.ts",
  "lib/providers/index.ts",
]);

/** The provider surface: the registry's own directory plus its HTTP surface. */
function providerSurfaceFiles(): string[] {
  const roots = [PROVIDERS_DIR, path.join(REPO_ROOT, "app/api/providers")];
  const files: string[] = [];

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };

  roots.forEach(walk);
  return files;
}

// ---------------------------------------------------------------------------
// 1. Reachability — the criterion this epic states literally
// ---------------------------------------------------------------------------

describe("provider modules are reachable from the registry", () => {
  const closure = importClosure(REGISTRY_ENTRY);

  it("has no module under lib/providers/ outside the registry's import closure", () => {
    const orphans = fs
      .readdirSync(PROVIDERS_DIR)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(PROVIDERS_DIR, name))
      .filter((file) => !closure.has(file))
      .map(rel);

    expect(orphans).toEqual([]);
  });

  it("reaches lib/providers/pi.ts through OhMyPiProvider's inheritance", () => {
    // The load-bearing half of the ticket's decision. `pi.ts` has no registry
    // key of its own, so a key-based audit reads it as dead; it is reached
    // because oh-my-pi.ts extends the class. If this ever goes red, deleting
    // pi.ts has genuinely become an option — and until then it has not.
    expect(closure.has(path.join(PROVIDERS_DIR, "pi.ts"))).toBe(true);
    expect(read(path.join(PROVIDERS_DIR, "oh-my-pi.ts"))).toMatch(
      /class OhMyPiProvider extends PiProvider/,
    );
  });

  it("detects an orphan when one exists (the walker is not vacuously green)", () => {
    // Same walker, an entry point that imports nothing: every provider module
    // must then read as unreachable. Without this, a walker that silently
    // matched no imports at all would keep the first test green forever.
    const isolated = importClosure(path.join(PROVIDERS_DIR, "extra-mcp-scope.ts"));
    expect(isolated.has(path.join(PROVIDERS_DIR, "oh-my-pi.ts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Agreement between the four declarations of "which providers exist"
// ---------------------------------------------------------------------------

describe("the provider set has one definition", () => {
  /** Members of a `export type X = "a" | "b"` union, read from source. */
  function unionMembers(file: string, typeName: string): string[] {
    const source = read(path.join(REPO_ROOT, file));
    const declaration = new RegExp(
      `export type ${typeName}\\s*=([^;]+);`,
      "m",
    ).exec(source);
    if (!declaration) throw new Error(`no '${typeName}' union in ${file}`);
    return [...declaration[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  }

  it("registers a distinct provider instance for every PROVIDER_OPTIONS entry", () => {
    // getProvider() falls back to claude-code for an unknown type, so an
    // option missing from the registry would silently answer with the wrong
    // provider rather than throw. Comparing `.type` is what catches that.
    for (const option of PROVIDER_OPTIONS) {
      expect(getProvider(option).type).toBe(option);
    }
  });

  it("has no registry key outside PROVIDER_OPTIONS", () => {
    const registry = read(REGISTRY_ENTRY);
    const body = /const providers[^{]*{([\s\S]*?)^};/m.exec(registry);
    expect(body, "registry map not found in lib/providers/index.ts").toBeTruthy();

    const keys = [...(body as RegExpExecArray)[1].matchAll(/^\s*"?([\w-]+)"?:/gm)]
      .map((m) => m[1])
      .sort();

    expect(keys).toEqual([...PROVIDER_OPTIONS].sort());
  });

  it("keeps ProviderType and AgentProvider naming the same set", () => {
    // Two independently declared unions over the same strings; nothing in the
    // type system ties them together.
    expect(unionMembers("lib/providers/types.ts", "ProviderType")).toEqual(
      unionMembers("lib/agent-config/constants.ts", "AgentProvider"),
    );
    expect(unionMembers("lib/providers/types.ts", "ProviderType")).toEqual(
      [...PROVIDER_OPTIONS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. No private copies of the list on the provider surface
// ---------------------------------------------------------------------------

describe("the provider surface derives the list instead of restating it", () => {
  it("has no module enumerating the provider set outside its declaration sites", () => {
    const copies = providerSurfaceFiles()
      .filter((file) => !DECLARATION_SITES.has(rel(file)))
      .filter((file) => enumeratesProviderSet(read(file)))
      .map(rel);

    expect(copies).toEqual([]);
  });

  it("probes exactly the registered providers on /api/providers/available", async () => {
    // The behavioural half of the check above: whatever the route enumerates,
    // it must answer for every registered provider and no one else. The
    // availability values are whichever CLIs this machine happens to have
    // installed — only the key set is the contract, because that is what the
    // workshop's "CLI detected" indicators iterate.
    const { GET } = await import("@/app/api/providers/available/route");
    const body = (await (await GET()).json()) as { data: Record<string, boolean> };

    expect(Object.keys(body.data).sort()).toEqual([...PROVIDER_OPTIONS].sort());
  });

  it("flags a hand-copied list and accepts a derived one", () => {
    // The teeth. A detector that matched nothing would keep the test above
    // green while every module kept its own copy.
    const copied = `const ALL: ProviderType[] = ${JSON.stringify(PROVIDER_OPTIONS)};`;
    const derived = `import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";`;

    expect(enumeratesProviderSet(copied)).toBe(true);
    expect(enumeratesProviderSet(derived)).toBe(false);
    // One id quoted is a per-CLI special case, not an enumeration.
    expect(enumeratesProviderSet(`provider === "oh-my-pi" ? "_" : "__"`)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Admission rule: a registered provider can be handed the MCP channel
// ---------------------------------------------------------------------------

describe("every registered provider satisfies the MCP admission rule", () => {
  it("reports MCP support for each PROVIDER_OPTIONS entry", () => {
    // lib/providers/types.ts states this as the rule for being registered at
    // all, and it is why the 2026-08 cleanup dropped `pi`. MCP_CAPABLE_PROVIDERS
    // is its own list, so registering a provider without adding it there would
    // ship a CLI whose sessions get no tool channel — which, per
    // docs/architecture/mcp-provider-matrix.md, is then judged by prose
    // instead of refused.
    const withoutChannel = PROVIDER_OPTIONS.filter(
      (provider) => !providerSupportsMcp(provider),
    );
    expect(withoutChannel).toEqual([]);
  });

  it("still reports no MCP support for the providers the cleanup removed", () => {
    // Non-vacuity: providerSupportsMcp must be able to say no.
    expect(providerSupportsMcp("pi")).toBe(false);
    expect(providerSupportsMcp("gemini-cli")).toBe(false);
  });
});
