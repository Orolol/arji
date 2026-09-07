#!/usr/bin/env node
/**
 * THE KEY-COVERAGE GATE. Two directions, both failing:
 *
 *   missing — code references a key the `en` catalogue does not define. The
 *             screen would render its dotted path to the user.
 *   orphan  — the catalogue defines a key no code references. Dead copy that
 *             a translator would still be asked to translate.
 *
 *   node scripts/i18n/check-keys.mjs           report and exit non-zero on either
 *   node scripts/i18n/check-keys.mjs --json    machine-readable, for the sweeps
 *
 * IT PARSES, IT DOES NOT GREP. Class-string and prop scanners written against
 * source text lose sites to template literals and to the slash of a
 * self-closing tag; this walks the TypeScript AST.
 *
 * WHAT COUNTS AS A REFERENCE, matching the three call shapes the catalogue
 * header prescribes:
 *
 *   1. `const t = useTranslations("Desk")`  →  `t("upNext.empty")` is
 *      `Desk.upNext.empty`. Same for `await getTranslations("Ns")` and
 *      `translatorFor(locale, "Ns")`. `t.rich`, `t.raw` and `t.has` resolve
 *      the same way.
 *   2. `const t = useTranslations()` (namespace-less) → the argument is
 *      already the full dotted path.
 *   3. A module-scope copy table's KEY REFERENCE: a string literal assigned
 *      to a property whose name ends in `Key` (`labelKey`, `titleKey`), or
 *      passed to `catalogueValue(locale, key)`. This is the pattern-3 half
 *      that never appears inside a `t(...)` call, because the table is read
 *      by pure logic and the literal sits in the data.
 *
 * An indirect call — `t(entry.labelKey)` — contributes nothing here, and
 * needs to contribute nothing: the literal it resolves lives in the table and
 * was counted there.
 *
 * A `…Key` PROPERTY IS ONLY A CATALOGUE REFERENCE WHEN ITS FIRST DOTTED
 * SEGMENT NAMES A REAL NAMESPACE. `chunkKey: "final-output"` in
 * `lib/providers/base-provider.ts` is domain data that happens to match the
 * field-name convention, and reading it as a key reported a missing string
 * that never existed. Scoping to the known namespaces is what separates the
 * two, and it costs nothing: a typo INSIDE a namespace
 * (`Nav.entries.tickts`) is still reported missing, and a typo IN the
 * namespace is a `TranslationKey` compile error at the table plus an orphan
 * here.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MESSAGES_DIR = path.join(ROOT, "lib", "i18n", "messages", "en");
const SOURCE_ROOTS = ["components", "app", "lib", "hooks"];

/**
 * Paths the catalogue header lists as NOT COPY. The dev harness is marked for
 * deletion, the agent-facing files are read by models rather than users, and
 * `lib/i18n` is the runtime itself — its own keys are data, not references.
 */
const EXCLUDED = [
  path.join("app", "piscine-preview"),
  path.join("app", "_piscine-preview"),
  path.join("lib", "i18n", "messages"),
];

const NAMESPACE_FACTORIES = new Set(["useTranslations", "getTranslations"]);

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (EXCLUDED.some((excluded) => rel === excluded || rel.startsWith(`${excluded}${path.sep}`))) {
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walkFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Every leaf of the source catalogue as a full dotted path. */
export function catalogueKeys() {
  const keys = new Set();
  const namespaces = existsSync(MESSAGES_DIR)
    ? readdirSync(MESSAGES_DIR).filter((name) => name.endsWith(".json"))
    : [];
  for (const file of namespaces) {
    const namespace = file.slice(0, -".json".length);
    const tree = JSON.parse(readFileSync(path.join(MESSAGES_DIR, file), "utf8"));
    const visit = (node, prefix) => {
      for (const [key, value] of Object.entries(node)) {
        const dotted = `${prefix}.${key}`;
        if (value !== null && typeof value === "object") visit(value, dotted);
        else keys.add(dotted);
      }
    };
    visit(tree, namespace);
  }
  return keys;
}

const KEY_PROPERTY = /Key$/;

function literalOf(node) {
  return node && ts.isStringLiteralLike(node) && !ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

/** The identifier a translator was bound to, and the namespace it carries. */
function collectTranslatorBindings(source) {
  /** @type {Map<string, string | null>} name → namespace (`null` = namespace-less) */
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let call = node.initializer;
      if (ts.isAwaitExpression(call)) call = call.expression;
      if (ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
        const fn = call.expression.text;
        if (NAMESPACE_FACTORIES.has(fn)) {
          bindings.set(node.name.text, literalOf(call.arguments[0]));
        } else if (fn === "translatorFor") {
          // translatorFor(locale, "Ns") — the namespace is the second argument.
          bindings.set(node.name.text, literalOf(call.arguments[1]));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

export function referencedKeys() {
  /** @type {Map<string, string[]>} key → the files that reference it */
  const references = new Map();
  const namespaces = new Set(
    existsSync(MESSAGES_DIR)
      ? readdirSync(MESSAGES_DIR)
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -".json".length))
      : [],
  );
  /** A pattern-3 literal, only when it addresses a namespace that exists. */
  const asCatalogueKey = (value) =>
    value && namespaces.has(value.split(".")[0]) ? value : null;
  const files = SOURCE_ROOTS.flatMap((root) => walkFiles(path.join(ROOT, root)));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // Cheap prefilter: a file with no translator and no `…Key:` property
    // cannot contribute a reference, and most of the tree is that.
    if (!/useTranslations|getTranslations|translatorFor|catalogueValue|Key:|Key=/.test(text)) {
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const bindings = collectTranslatorBindings(source);
    const rel = path.relative(ROOT, file);

    const record = (key) => {
      if (!key) return;
      const seen = references.get(key);
      if (seen) seen.push(rel);
      else references.set(key, [rel]);
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // `t(...)`, and the `t.rich` / `t.raw` / `t.has` members.
        let name = null;
        if (ts.isIdentifier(callee)) name = callee.text;
        else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          ["rich", "raw", "has", "markup"].includes(callee.name.text)
        ) {
          name = callee.expression.text;
        }
        if (name && bindings.has(name)) {
          const key = literalOf(node.arguments[0]);
          const namespace = bindings.get(name);
          if (key) record(namespace ? `${namespace}.${key}` : key);
        }
        // `catalogueValue(locale, "Full.Dotted.Key")`
        if (ts.isIdentifier(callee) && callee.text === "catalogueValue") {
          record(literalOf(node.arguments[1]));
        }
      }
      // Pattern 3: a copy table's `…Key` field holding a full dotted path.
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        KEY_PROPERTY.test(node.name.text)
      ) {
        record(asCatalogueKey(literalOf(node.initializer)));
      }
      // The same field passed as a JSX prop: `labelKey="Nav.entries.tickets"`.
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && KEY_PROPERTY.test(node.name.text)) {
        const value = node.initializer;
        if (value && ts.isStringLiteral(value)) record(asCatalogueKey(value.text));
        else if (value && ts.isJsxExpression(value)) {
          record(asCatalogueKey(literalOf(value.expression)));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return references;
}

export function audit() {
  const defined = catalogueKeys();
  const referenced = referencedKeys();
  const missing = [...referenced.keys()].filter((key) => !defined.has(key)).sort();
  const orphans = [...defined].filter((key) => !referenced.has(key)).sort();
  return { defined, referenced, missing, orphans };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { defined, referenced, missing, orphans } = audit();
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          defined: defined.size,
          referenced: referenced.size,
          missing,
          orphans,
          references: Object.fromEntries([...referenced].map(([key, files]) => [key, files])),
        },
        null,
        2,
      ),
    );
  } else {
    for (const key of missing) {
      console.error(`missing  ${key}\n         referenced by ${referenced.get(key).join(", ")}`);
    }
    for (const key of orphans) console.error(`orphan   ${key}`);
    console.log(
      `\n${defined.size} keys defined, ${referenced.size} referenced — ` +
        `${missing.length} missing, ${orphans.length} orphan.`,
    );
  }
  process.exit(missing.length || orphans.length ? 1 : 0);
}
