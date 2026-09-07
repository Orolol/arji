/** AST guard for direct resolver calls at HTTP boundaries, not background dispatches. */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import ts from "typescript";
import { expect, it } from "vitest";

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? routeFiles(file) : entry.name === "route.ts" ? [file] : [];
  });
}

it("every direct explicit-choice resolver call is inside the common HTTP error boundary", () => {
  const unprotected: string[] = [];
  let checked = 0;
  for (const file of routeFiles("app/api")) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const resolvers = new Set<string>();
    const wrappers = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text;
        if (statement.moduleSpecifier.text === "@/lib/agent-config/agent-resolution" &&
            ["resolveAgentByNamedId", "resolveAgentForDispatch"].includes(imported)) {
          resolvers.add(binding.name.text);
        }
        if (statement.moduleSpecifier.text === "@/lib/api/agent-resolution-response" && imported === "withAgentResolutionErrors") {
          wrappers.add(binding.name.text);
        }
      }
    }
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && resolvers.has(node.expression.text)) {
        checked++;
        let parent: ts.Node | undefined = node.parent;
        while (parent && !(ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && wrappers.has(parent.expression.text))) {
          parent = parent.parent;
        }
        if (!parent) unprotected.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(checked).toBeGreaterThan(0);
  expect(unprotected).toEqual([]);
});
