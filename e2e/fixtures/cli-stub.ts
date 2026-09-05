import { expect, type APIRequestContext } from "@playwright/test";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDatabase } from "./data-root";

/**
 * Runner-side half of the agent stub (`e2e/fixtures/cli-stub/`).
 *
 * A journey that has to reach the build and review routes has to survive the
 * agent they spawn, and a real CLI is the one thing a browser suite cannot
 * own: slow, billed, and never twice the same. So the CLI is replaced — and
 * ONLY the CLI. `playwright.config.ts` prepends the stub's `bin/` to the dev
 * server's PATH, the providers spawn it by bare name, and everything between
 * the route and the workflow engine runs for real.
 *
 * Two things this file exists to guarantee:
 *
 * 1. **No journey ever reaches a real CLI.** `assertCliStubInstalled` proves,
 *    before anything is dispatched, that the server under test resolves these
 *    stubs — otherwise a suite pointed at a dev server started without them
 *    would quietly spawn the developer's actual `claude` with a build prompt.
 * 2. **A stub that goes off-script fails the test.** It refuses to improvise:
 *    the scenario is written before the dispatch, and what it actually did is
 *    read back from `readInvocations`.
 */

/** The directory `playwright.config.ts` prepends to the dev server's PATH. */
export const CLI_STUB_BIN_DIR = path.join(__dirname, "cli-stub", "bin");

/** Shared with `cli-stub/runtime.mjs`, which computes it the same way. */
const STUB_HOME = path.join(tmpdir(), "arij-e2e-cli-stub");
const SCENARIO_DIR = path.join(STUB_HOME, "scenarios");
const INVOCATION_DIR = path.join(STUB_HOME, "invocations");
const HANDSHAKE_FILE = path.join(STUB_HOME, "handshake.json");

/** One scripted spawn. `kind` is what the stub does when it is reached. */
export type ScenarioStep =
  | {
      kind: "build";
      /** File the "agent" writes and commits in the epic worktree. */
      file: string;
      content: string;
      message: string;
      /** The final message, which Arij posts as the ticket's agent comment. */
      say?: string;
    }
  | {
      kind: "review";
      verdict?: "approved" | "approved_with_minor_issues" | "changes_requested";
      summary?: string;
      findings?: {
        file_path: string;
        line: number;
        body: string;
        severity: "critical" | "major" | "minor" | "info";
      }[];
      say?: string;
    }
  | { kind: "fail"; error?: string };

/** What one spawn of the stub actually received and did. */
export interface StubInvocation {
  index: number;
  binary: string;
  at: string;
  cwd: string;
  argv: string[];
  prompt: string;
  hasMcpChannel: boolean;
  cliSessionId: string;
  kind: string | null;
  ok?: boolean;
  error?: string;
  committed?: string;
  head?: string;
  submitFindings?: { status: number; verdict: string };
}

const writtenScenarios = new Set<string>();

/**
 * Scripts the spawns a ticket's journey will make, in order.
 *
 * Keyed by epic id because that is the one identifier the stub can recover
 * from a spawn without being told: every code-producing session runs in the
 * epic's worktree, whose directory name embeds it.
 */
export function writeScenario(epicId: string, steps: ScenarioStep[]): void {
  mkdirSync(SCENARIO_DIR, { recursive: true });
  writeFileSync(
    path.join(SCENARIO_DIR, `${epicId}.json`),
    JSON.stringify({ steps }, null, 2)
  );
  writtenScenarios.add(epicId);
}

/** Every spawn the stub made for this ticket, in the order it made them. */
export function readInvocations(epicId: string): StubInvocation[] {
  if (!existsSync(INVOCATION_DIR)) return [];
  return readdirSync(INVOCATION_DIR)
    .filter((name) => name.startsWith(`${epicId}-`) && name.endsWith(".json"))
    .map(
      (name) =>
        JSON.parse(readFileSync(path.join(INVOCATION_DIR, name), "utf8")) as StubInvocation
    )
    .sort((a, b) => a.index - b.index);
}

/** Removes every scenario and invocation this worker wrote. */
export function cleanupScenarios(): void {
  for (const epicId of writtenScenarios) {
    rmSync(path.join(SCENARIO_DIR, `${epicId}.json`), { force: true });
    if (existsSync(INVOCATION_DIR)) {
      for (const name of readdirSync(INVOCATION_DIR)) {
        if (name.startsWith(`${epicId}-`)) {
          rmSync(path.join(INVOCATION_DIR, name), { force: true });
        }
      }
    }
  }
  writtenScenarios.clear();
}

/**
 * The CLI each registered provider spawns, keyed by provider type.
 *
 * Exhaustive by construction rather than by inspection: the preflight checks
 * these keys against the provider types `GET /api/providers/available` reports
 * (`ALL_PROVIDERS` in that route). Registering a fifth provider therefore
 * fails the journey here, naming the binary that has no stub, instead of
 * leaving it unshadowed for a dispatch to reach a real CLI.
 */
const PROVIDER_BINARIES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "oh-my-pi": "omp",
  agy: "agy",
};

/**
 * What the server's PATH resolves a bare command name to — the same first-match
 * walk `execvp` does for a spawn, run over the PATH the stub reported.
 *
 * The runner and the server share a filesystem (Arij is a local application),
 * so this is a real resolution rather than a model of one.
 */
function resolveOnPath(pathValue: string, binary: string): string | null {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here, or not executable — keep walking, exactly as execvp does
    }
  }
  return null;
}

interface Handshake {
  binary: string;
  at: string;
  path: string;
  arijBaseUrl: string;
}

function readHandshake(): Handshake | null {
  try {
    return JSON.parse(readFileSync(HANDSHAKE_FILE, "utf8")) as Handshake;
  } catch {
    return null;
  }
}

const START_THE_SERVER_WITH_THE_STUB = [
  "Let Playwright start the dev server (it sets both), or start the one you reuse with:",
  "",
  `  PATH="${CLI_STUB_BIN_DIR}:$PATH" ARIJ_BASE_URL=<base-url> npm run dev -- --port <port>`,
].join("\n");

/**
 * Proves the server under test spawns the stub — before anything is dispatched.
 *
 * `GET /api/providers/available` is the handshake because
 * `CodexProvider.isAvailable()` EXECUTES its binary (`codex login status`),
 * unlike the other three, which only run `which`. The stub writes down the
 * PATH and `ARIJ_BASE_URL` it saw, and both are checked here:
 *
 * - every provider binary must RESOLVE to the stub's copy, which is what
 *   proves these stubs shadow any real CLI of the same name — a real `claude`
 *   sitting in an earlier PATH entry would otherwise take the build.
 * - `ARIJ_BASE_URL` must be the server under test, because that is the address
 *   the MCP channel hands the agent to call back on. Its default is
 *   `http://localhost:3000` (lib/webhooks/send.ts), i.e. whatever OTHER dev
 *   server happens to be running — a review would then file its findings
 *   there, get a 401, and fail for a reason that has nothing to do with the
 *   code under test.
 *
 * Fails rather than skips: a journey that quietly stops covering the build and
 * review paths is the exact vacuity this suite exists to rule out.
 */
export async function assertCliStubInstalled(
  request: APIRequestContext,
  baseURL: string
): Promise<void> {
  const pingedAt = Date.now();
  const response = await request.get("/api/providers/available");
  expect(
    response.ok(),
    `provider availability probe failed: ${response.status()}`
  ).toBeTruthy();

  const handshake = readHandshake();
  expect(
    handshake && Date.parse(handshake.at) >= pingedAt - 5_000,
    `the server under test did not spawn the e2e CLI stub when asked which providers are available, ` +
      `so a dispatched agent would reach a REAL CLI.\n${START_THE_SERVER_WITH_THE_STUB}`
  ).toBeTruthy();

  // Not "the stub directory is first on PATH" — `npm run dev` legitimately
  // prepends `node_modules/.bin` — but the fact that actually matters: for
  // every provider binary Arij can spawn, the first PATH entry holding one is
  // the stub's. A real `claude` in an earlier directory would otherwise take
  // the dispatch.
  const { data: availability } = (await response.json()) as {
    data: Record<string, boolean>;
  };
  expect(
    Object.keys(availability).sort(),
    `a provider was registered in lib/providers/ that this fixture has no stub for, so its binary ` +
      `is unshadowed and a dispatch resolving to it would reach a real CLI. Add it to ` +
      `PROVIDER_BINARIES and to e2e/fixtures/cli-stub/bin/.`
  ).toEqual(Object.keys(PROVIDER_BINARIES).sort());

  for (const binary of Object.values(PROVIDER_BINARIES)) {
    expect(
      resolveOnPath(handshake!.path, binary),
      `\`${binary}\` resolves to a CLI that is not the e2e stub on the server under test, so a ` +
        `dispatch could reach a real agent.\n${START_THE_SERVER_WITH_THE_STUB}`
    ).toBe(path.join(CLI_STUB_BIN_DIR, binary));
  }

  expect(
    handshake!.arijBaseUrl.replace(/\/+$/, ""),
    `the server under test hands agents the wrong ARIJ_BASE_URL, so a review's submit_findings ` +
      `would be filed against another server.\n${START_THE_SERVER_WITH_THE_STUB}`
  ).toBe(baseURL.replace(/\/+$/, ""));

  assertMcpToolsEnabled();
}

/**
 * The structured review channel has to be on, or the journey's verdict has
 * nowhere to go.
 *
 * An absent row means enabled (lib/claude/mcp-injection.ts); only an explicit
 * `false` disables it. Checked here rather than left to fail inside the stub
 * so the reason is legible: a review session spawned without `--mcp-config`
 * cannot call `submit_findings`, and the ticket then sits in Review with no
 * verdict at all.
 */
function assertMcpToolsEnabled(): void {
  const row = withDatabase((db) =>
    db
      .prepare("SELECT value FROM settings WHERE key = 'mcp_tools_enabled'")
      .get() as { value: string } | undefined
  );
  if (!row) return;

  let parsed: unknown = row.value;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // raw string value — compare as-is
  }
  expect(
    parsed === false || parsed === "false",
    "mcp_tools_enabled is off in the database under test, so review sessions are spawned without " +
      "the MCP channel and cannot file a structured verdict. Turn it back on to run this journey."
  ).toBe(false);
}
