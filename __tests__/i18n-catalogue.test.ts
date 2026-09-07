/**
 * The catalogue contract: `en.json` is the source, `fr.json` a partial seed
 * keyed identically, and a locale's messages are its seed over the source so
 * a missing key renders English rather than its dotted path.
 */
import { describe, expect, it } from "vitest";

import { messagesFor, partialCatalogueFor } from "@/lib/i18n/catalogue";
import { UI_LOCALES } from "@/lib/i18n/locales";
import { en, fr } from "@/lib/i18n/messages";

type Tree = { [key: string]: string | Tree };

function leafPaths(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [`${prefix}${key}`]
      : leafPaths(value, `${prefix}${key}.`),
  );
}

function leafAt(tree: Tree, path: string): string | Tree | undefined {
  return path.split(".").reduce<string | Tree | undefined>(
    (node, part) => (node && typeof node === "object" ? node[part] : undefined),
    tree,
  );
}

describe("the source catalogue", () => {
  const keys = leafPaths(en as Tree);

  it("has keys with no dots and no empty values", () => {
    for (const path of keys) {
      const value = leafAt(en as Tree, path);
      expect(typeof value, path).toBe("string");
      expect((value as string).trim().length, path).toBeGreaterThan(0);
    }
    const walk = (tree: Tree) => {
      for (const [key, value] of Object.entries(tree)) {
        expect(key, `key ${key}`).not.toContain(".");
        if (typeof value !== "string") walk(value);
      }
    };
    walk(en as Tree);
  });

  it("is English: no French accented characters in any value", () => {
    for (const path of keys) {
      expect(leafAt(en as Tree, path) as string, path).not.toMatch(/[àâäéèêëîïôöùûüçœ]/i);
    }
  });
});

describe("the French seed", () => {
  it("only holds keys that exist in en.json, under the same paths", () => {
    const enKeys = new Set(leafPaths(en as Tree));
    for (const path of leafPaths(fr as Tree)) {
      expect(enKeys.has(path), `fr.json key ${path} is not in en.json`).toBe(true);
    }
  });

  it("holds no English placeholder: every seeded value differs from the source", () => {
    for (const path of leafPaths(fr as Tree)) {
      expect(leafAt(fr as Tree, path), path).not.toBe(leafAt(en as Tree, path));
    }
  });
});

describe("messagesFor", () => {
  it("returns the source catalogue itself for en", () => {
    expect(messagesFor("en")).toBe(en);
  });

  it("lays the seed over the source for fr, so a missing key falls back to English", () => {
    const messages = messagesFor("fr") as unknown as Tree;
    expect(leafAt(messages, "Nav.categories.settings")).toBe("Réglages");
    // Never seeded in French: falls back to the English source.
    expect(leafAt(messages, "Nav.categories.work")).toBe("Work");
    expect(leafPaths(messages)).toEqual(leafPaths(en as Tree));
  });

  it("does not mutate the source when merging", () => {
    messagesFor("fr");
    expect(leafAt(en as Tree, "Nav.categories.settings")).toBe("Settings");
  });

  it("has a complete tree for every locale", () => {
    for (const locale of UI_LOCALES) {
      expect(leafPaths(messagesFor(locale) as unknown as Tree)).toEqual(leafPaths(en as Tree));
      expect(partialCatalogueFor(locale)).toBeTruthy();
    }
  });
});
