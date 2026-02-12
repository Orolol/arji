import { execFileSync } from "node:child_process";
import { readFileSync, accessSync, constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const cliBin = resolve(projectRoot, "bin", "arij.mjs");
const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf-8")
);

describe("package.json configuration", () => {
  it("should have package name set to 'arij'", () => {
    expect(pkg.name).toBe("arij");
  });

  it("should have a bin field pointing to the CLI entry script", () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.arij).toBe("./bin/arij.mjs");
  });

  it("should not be marked as private", () => {
    expect(pkg.private).not.toBe(true);
  });
});

describe("CLI entry script", () => {
  it("should exist at bin/arij.mjs", () => {
    expect(() => accessSync(cliBin, constants.F_OK)).not.toThrow();
  });

  it("should be executable", () => {
    expect(() => accessSync(cliBin, constants.X_OK)).not.toThrow();
  });

  it("should have a node shebang line", () => {
    const content = readFileSync(cliBin, "utf-8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("should print help with --help flag", () => {
    const output = execFileSync("node", [cliBin, "--help"], {
      encoding: "utf-8",
    });
    expect(output).toContain("arij");
    expect(output).toContain("Usage");
  });

  it("should print version with --version flag", () => {
    const output = execFileSync("node", [cliBin, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe(pkg.version);
  });

  it("should exit with error for unknown commands", () => {
    expect(() =>
      execFileSync("node", [cliBin, "nonexistent"], {
        encoding: "utf-8",
        stdio: "pipe",
      })
    ).toThrow();
  });
});

describe("start command launches Next.js server", () => {
  it("should invoke next start when run with no arguments", () => {
    const content = readFileSync(cliBin, "utf-8");
    expect(content).toContain('"start"');
    expect(content).toContain("next");
  });

  it("should invoke next start when run with 'start' argument", () => {
    const content = readFileSync(cliBin, "utf-8");
    expect(content).toMatch(/command === "start"/);
  });

  it("should invoke next dev when run with 'dev' argument", () => {
    const content = readFileSync(cliBin, "utf-8");
    expect(content).toMatch(/command === "dev"/);
    expect(content).toContain('"dev"');
  });

  it("should invoke next build when run with 'build' argument", () => {
    const content = readFileSync(cliBin, "utf-8");
    expect(content).toMatch(/command === "build"/);
    expect(content).toContain('"build"');
  });
});
