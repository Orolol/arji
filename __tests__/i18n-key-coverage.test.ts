/**
 * The key-coverage gate, proven in BOTH directions by breaking the tree for
 * real and putting it back.
 *
 * A gate asserted only against a fixture proves the fixture. These cases write
 * an actual file into the actual source tree, run the actual script over it,
 * and assert the actual verdict — which is the only way to know the walker
 * reaches `components/`, resolves a namespace from `useTranslations("Ns")`,
 * and reads the catalogue off disk.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// A plain .mjs script, deliberately dependency-free so CI can run it with bare
// node before anything is built. Imported here so the gate under test is the
// exact file CI runs, not a re-implementation of it.
import { audit } from "../scripts/i18n/check-keys.mjs";

const ROOT = path.resolve(__dirname, "..");
const SCRATCH_DIR = path.join(ROOT, "components", "__i18n_coverage_probe__");
const SCRATCH_TSX = path.join(SCRATCH_DIR, "Probe.tsx");
const SCRATCH_NS = path.join(ROOT, "lib", "i18n", "messages", "en", "CoverageProbe.json");

function cleanup() {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  rmSync(SCRATCH_NS, { force: true });
}

afterEach(cleanup);

describe("the i18n key-coverage gate", () => {
  it("passes on the tree as committed", () => {
    const { missing, orphans } = audit();
    expect({ missing, orphans }).toEqual({ missing: [], orphans: [] });
  });

  it("fails on a key the code references and the catalogue does not define", () => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    writeFileSync(
      SCRATCH_TSX,
      [
        'import { useTranslations } from "next-intl";',
        "export function Probe() {",
        '  const t = useTranslations("Nav");',
        '  return <span>{t("entries.thisKeyDoesNotExist")}</span>;',
        "}",
        "",
      ].join("\n"),
    );

    const { missing } = audit();
    expect(missing).toContain("Nav.entries.thisKeyDoesNotExist");
  });

  it("fails on a catalogue key no code references", () => {
    writeFileSync(SCRATCH_NS, JSON.stringify({ unreferenced: "Nobody renders this" }, null, 2));

    const { orphans } = audit();
    expect(orphans).toContain("CoverageProbe.unreferenced");
  });

  it("keeps two namespaces apart when one file binds both to `t`", () => {
    // A file-wide `name → namespace` map reads this as one binding and
    // last-wins: `t("entries.tickets")` in `A` gets attributed to `TopBar`
    // and reported missing, while `Nav.entries.tickets` is reported orphan.
    // Both are phantoms, and the "fix" is to rename a variable in correct
    // code — so the walk is scoped instead.
    mkdirSync(SCRATCH_DIR, { recursive: true });
    writeFileSync(
      SCRATCH_TSX,
      [
        'import { useTranslations } from "next-intl";',
        "export function A() {",
        '  const t = useTranslations("Nav");',
        '  return <span>{t("entries.tickets")}</span>;',
        "}",
        "export function B() {",
        '  const t = useTranslations("TopBar");',
        '  return <span>{t("pills.now")}</span>;',
        "}",
        "",
      ].join("\n"),
    );

    const { missing, referenced } = audit();
    expect(missing).toEqual([]);
    expect(referenced.get("Nav.entries.tickets")).toEqual(
      expect.arrayContaining([expect.stringContaining("__i18n_coverage_probe__")]),
    );
    expect(referenced.get("TopBar.pills.now")).toEqual(
      expect.arrayContaining([expect.stringContaining("__i18n_coverage_probe__")]),
    );
  });

  it("reads key-reference tables without a hook or a Key-suffixed field", () => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    writeFileSync(SCRATCH_TSX, 'export const labels = { tickets: "Nav.entries.tickets", broken: "Nav.entries.missingProbe" };');
    const { missing, referenced } = audit();
    expect(missing).toContain("Nav.entries.missingProbe");
    expect(referenced.get("Nav.entries.tickets")).toEqual(
      expect.arrayContaining([expect.stringContaining("__i18n_coverage_probe__")]),
    );
  });

  it("does not mistake prose beginning with a namespace word for a key", () => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    writeFileSync(SCRATCH_TSX, 'export const prompt = "Review. If the move is refused, leave a comment.";');
    expect(audit().missing).toEqual([]);
  });

  it("puts the tree back, so the two probes above cannot mask a real break", () => {
    expect(existsSync(SCRATCH_TSX)).toBe(false);
    expect(existsSync(SCRATCH_NS)).toBe(false);
    const { missing, orphans } = audit();
    expect({ missing, orphans }).toEqual({ missing: [], orphans: [] });
  });
});
