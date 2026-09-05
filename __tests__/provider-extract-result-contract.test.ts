// @vitest-environment node
import { describe, it, expect } from "vitest";
import path from "node:path";
import ts from "typescript";

/**
 * `npm run build` broke on main inside `lib/providers/pi.ts`, and no unit test
 * could see it.
 *
 * `BaseCliProvider` declares the hook as
 *
 *   abstract extractResult(stdout: string, stderr: string,
 *                          spawnContext?: ProviderSpawnContext): string
 *
 * and calls it with all three arguments in `handleExit`. `PiProvider` overrode
 * it as `extractResult(stdout: string)` — legal TypeScript, an override may
 * drop trailing parameters it ignores — and then `PiProvider.handleExit`
 * re-derived the deliverable with `this.extractResult(stdout, stderr,
 * spawnContext)`. `this` is the subclass, so that call resolved against the
 * one-parameter override rather than the base declaration: `TS2554: Expected 1
 * arguments, but got 3`, and `next build` exited 1.
 *
 * Argument lists are erased at runtime, so the extra arguments were simply
 * dropped and every behavioural test stayed green. Only a typecheck sees this
 * class of defect, so this file asserts the contract at the type level:
 * it compiles probe modules against the project's real `tsconfig.json`
 * compiler options and requires them to be diagnostic-free.
 *
 * WHY THE PROBE IS WRITTEN AGAINST A CONCRETE PROVIDER, NOT THE BASE CLASS
 *
 * The narrowing is invisible through a `BaseCliProvider`-typed reference —
 * that call resolves against the abstract declaration and compiles fine. It is
 * only reachable when the receiver's static type is the narrowing subclass,
 * which is exactly what `this` is inside `PiProvider`. That asymmetry is
 * asserted below as a control, because it is the reason a whole-tree `tsc`
 * can go green again by editing the *call site* while leaving the narrowed
 * signature — and the trap — in place for the next caller.
 *
 * WHAT THIS FILE DOES NOT PROVE
 *
 * It typechecks probe modules, not `lib/providers/*.ts` itself; a defect in a
 * call site that no probe mirrors is `npx tsc --noEmit`'s job (enforced in CI
 * since the `verify` job was added). What it pins is the signature contract:
 * a provider must accept the arguments its own base class calls it with.
 */

const CWD = process.cwd();

/** Reused across programs — each probe otherwise re-parses ~228 files. */
const sourceCache = new Map<string, ts.SourceFile | undefined>();

let baseOptions: ts.CompilerOptions | undefined;

function compilerOptions(): ts.CompilerOptions {
  if (!baseOptions) {
    const configPath = path.join(CWD, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, CWD);
    baseOptions = {
      ...parsed.options,
      noEmit: true,
      // `incremental` would have the probe programs fight over the project's
      // .tsbuildinfo; they are throwaway compilations.
      incremental: false,
      tsBuildInfoFile: undefined,
    };
  }
  return baseOptions;
}

/**
 * Compile `source` as a module inside the project (so `@/` and the real
 * provider sources resolve) and return its diagnostics, formatted.
 *
 * The probe is served from memory rather than written to disk: the repo is a
 * live worktree with a dev server watching it, and a stray root-level `.ts`
 * file would show up in `git status` and in `tsc`'s own `include` glob.
 */
function typecheckProbe(source: string): string[] {
  const options = compilerOptions();
  const probePath = path.join(CWD, "__extract-result-probe.ts");
  const host = ts.createCompilerHost(options, true);

  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.readFile = (fileName) =>
    fileName === probePath ? source : readFile(fileName);
  host.fileExists = (fileName) =>
    fileName === probePath || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (fileName === probePath) {
      return ts.createSourceFile(fileName, source, languageVersion, true);
    }
    if (!sourceCache.has(fileName)) {
      sourceCache.set(
        fileName,
        getSourceFile(fileName, languageVersion, onError, shouldCreate),
      );
    }
    return sourceCache.get(fileName);
  };

  const program = ts.createProgram([probePath], options, host);

  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === probePath)
    .map(
      (d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
}

describe("a provider's extractResult accepts what its base class calls it with", () => {
  it("compiles the base-contract call on a pi provider", () => {
    // The exact shape of the build break: PiProvider.handleExit re-deriving
    // the deliverable from a ProviderExitInfo it was handed.
    const diagnostics = typecheckProbe(`
      import type { ProviderExitInfo } from "@/lib/providers/base-provider";
      import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";

      export function reextract(
        provider: OhMyPiProvider,
        info: ProviderExitInfo,
      ): string {
        return provider.extractResult(info.stdout, info.stderr, info.spawnContext);
      }
    `);

    expect(
      diagnostics,
      "lib/providers/pi.ts narrows extractResult below the signature " +
        "BaseCliProvider declares and calls — this is the TS2554 that broke " +
        "`npm run build`",
    ).toEqual([]);
  });

  it("compiles the base-contract call on a codex provider", () => {
    // Control, green on both sides of the fix: CodexProvider already declares
    // the full signature, so a red here means the harness itself is broken
    // rather than the pi lineage.
    const diagnostics = typecheckProbe(`
      import type { ProviderExitInfo } from "@/lib/providers/base-provider";
      import { CodexProvider } from "@/lib/providers/codex";

      export function reextract(
        provider: CodexProvider,
        info: ProviderExitInfo,
      ): string {
        return provider.extractResult(info.stdout, info.stderr, info.spawnContext);
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  it("compiles the same call through a base-class reference", () => {
    // Control, also green on both sides — and the reason the narrowing can
    // hide. Through `BaseCliProvider` the call resolves against the abstract
    // declaration, so a whole-tree typecheck stays silent about it until some
    // caller holds the concrete subclass.
    const diagnostics = typecheckProbe(`
      import type {
        BaseCliProvider,
        ProviderExitInfo,
      } from "@/lib/providers/base-provider";

      export function reextract(
        provider: BaseCliProvider,
        info: ProviderExitInfo,
      ): string {
        return provider.extractResult(info.stdout, info.stderr, info.spawnContext);
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  it("still reports a genuinely wrong call", () => {
    // Non-vacuity: a probe that returned [] unconditionally would make every
    // assertion above pass for free.
    const diagnostics = typecheckProbe(`
      import { OhMyPiProvider } from "@/lib/providers/oh-my-pi";

      export function reextract(provider: OhMyPiProvider): string {
        return provider.extractResult(42);
      }
    `);

    expect(diagnostics.join("\n")).toContain("TS2345");
  });
});
