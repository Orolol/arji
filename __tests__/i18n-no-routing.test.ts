/**
 * The locale is a stored setting, not a URL. This pins the decision the
 * epic took against Next's `[lang]` guide: no locale segment, no next-intl
 * middleware, and `proxy.ts` keeps doing only its localhost-origin job.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

describe("i18n without routing", () => {
  it("introduces no [lang]/[locale] route segment", () => {
    const segments = readdirSync(path.join(ROOT, "app"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(segments.some((name) => /^\[(lang|locale)\]$/.test(name))).toBe(false);
    expect(existsSync(path.join(ROOT, "middleware.ts"))).toBe(false);
  });

  it("keeps proxy.ts free of any locale logic", () => {
    const proxy = readFileSync(path.join(ROOT, "proxy.ts"), "utf8");
    expect(proxy).not.toContain("next-intl");
    expect(proxy).not.toMatch(/locale/i);
  });

  it("registers the request config through the plugin, without the routing layer", () => {
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain('createNextIntlPlugin("./lib/i18n/request.ts")');
    expect(config).not.toContain("next-intl/middleware");
    expect(config).not.toContain("next-intl/routing");
    expect(existsSync(path.join(ROOT, "lib", "i18n", "request.ts"))).toBe(true);
  });

  it("keeps the request config off the requestLocale segment API", () => {
    const source = readFileSync(path.join(ROOT, "lib", "i18n", "request.ts"), "utf8");
    // Comments may name the API they refuse; the code must not read it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("requestLocale");
    expect(code).toContain("resolveRequestUiLocale");
  });
});
