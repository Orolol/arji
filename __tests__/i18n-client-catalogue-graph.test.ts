import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const configPath = ts.findConfigFile(root, ts.sys.fileExists)!;
const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root);

/** Follow only static runtime imports/exports, never type-only catalogue references. */
function messageDependencies(entry: string): string[] {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file) || file.includes("/node_modules/")) return;
    seen.add(file);
    if (file.endsWith(".json")) return;
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) continue;
        if (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((item) => item.isTypeOnly)) continue;
      } else if (node.isTypeOnly) continue;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const dependency = ts.resolveModuleName(node.moduleSpecifier.text, file, config.options, ts.sys).resolvedModule;
      if (dependency) visit(dependency.resolvedFileName);
    }
  }
  visit(path.join(root, entry));
  return [...seen].filter((file) => file.includes("/i18n/messages/") && file.endsWith(".json")).map((file) => path.relative(root, file)).sort();
}

describe("client helpers do not import the whole catalogue", () => {
  it("formats using only the tiny Format namespaces", () => {
    expect(messageDependencies("lib/i18n/format.ts")).toEqual([
      "lib/i18n/messages/en/Format.json", "lib/i18n/messages/fr/Format.json",
    ]);
  });
  it("pins provider validation to only the English options namespace", () => {
    expect(messageDependencies("lib/providers/options-registry.ts")).toEqual([
      "lib/i18n/messages/en/ProviderOptions.json",
    ]);
  });
});
