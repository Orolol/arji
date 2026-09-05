/**
 * The scripted CLI that the end-to-end journeys spawn in place of a real
 * coding agent.
 *
 * `lib/providers/*` spawn their CLI by BARE NAME (`claude`, `codex`, `omp`,
 * `agy`) with the server's own environment, so the only seam a browser test
 * has on the agent boundary is the dev server's PATH — `playwright.config.ts`
 * prepends `bin/` (next to this file) to it. Everything on the Arij side of
 * that seam then runs for real: the build route, the worktree, the prompt
 * assembly, the session row, the scheduler, the MCP token, the review route,
 * the workflow transitions and the merge. Only the model's judgement is
 * replaced — by a scenario the test wrote down in advance.
 *
 * A stub is NOT a way to make a red journey green. Every deviation from the
 * script (no scenario for this epic, a step the scenario does not describe, a
 * review dispatched without an MCP channel, a failed submit_findings) exits
 * non-zero with the reason on stderr, which Arij persists as the session's
 * error and shows in the ticket. A journey whose stub went off-script fails.
 *
 * ## Runtime shape
 *
 * The entry points in `bin/` must be named exactly `claude`, `codex`, `omp`
 * and `agy` for PATH resolution, and Node loads an extensionless file as
 * CommonJS — so each one is a one-line CommonJS shim that `import()`s this
 * module, which is ESM like the rest of the repository's `bin/` scripts.
 *
 * ## What lives where
 *
 * Everything is under one directory in the OS temp dir, computed identically
 * here and in `e2e/fixtures/cli-stub.ts` (the runner-side half) — the stub
 * runs on the same machine as the test, so a shared directory is the whole
 * transport:
 *
 *   <tmp>/arij-e2e-cli-stub/
 *     handshake.json          the last invocation of any stub, with the PATH
 *                             and ARIJ_BASE_URL the server passed down; the
 *                             preflight reads it to prove the server under
 *                             test really resolves to these stubs BEFORE any
 *                             journey dispatches an agent
 *     scenarios/<epicId>.json the script for one ticket's journey
 *     invocations/<epicId>-<n>.json  what actually happened, in order
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const STUB_ROOT = path.join(os.tmpdir(), "arij-e2e-cli-stub-" + createHash("sha256")
  .update(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")).digest("hex").slice(0, 12));
const SCENARIO_DIR = path.join(STUB_ROOT, "scenarios");
const INVOCATION_DIR = path.join(STUB_ROOT, "invocations");
const HANDSHAKE_FILE = path.join(STUB_ROOT, "handshake.json");

/** Identity used for the stub's commits, so the scratch repo needs no config. */
const COMMIT_IDENTITY = ["-c", "user.email=stub@arij.local", "-c", "user.name=Arij E2E Stub"];

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * Records that a stub ran, and under which environment.
 *
 * Written by EVERY entry point, including the ones that refuse: the fact
 * being recorded is "the server under test resolves this CLI name to the
 * stub", which a refusal proves just as well as a scripted run does. The
 * runner's preflight (`assertCliStubInstalled`) triggers it through
 * `GET /api/providers/available`, which makes the server execute
 * `codex login status`.
 *
 * Written whole via a rename so a concurrent reader never sees a half-file.
 */
function recordHandshake(binary) {
  const payload = {
    binary,
    at: new Date().toISOString(),
    pid: process.pid,
    cwd: safeCwd(),
    // The two facts the preflight checks. PATH proves these stubs shadow any
    // real CLI of the same name; ARIJ_BASE_URL is what the MCP channel hands
    // an agent to call back on, and a wrong one would aim a review's
    // submit_findings at somebody else's dev server.
    path: process.env.PATH || "",
    arijBaseUrl: process.env.ARIJ_BASE_URL || "",
  };
  try {
  fs.mkdirSync(STUB_ROOT, { recursive: true });
    const temp = `${HANDSHAKE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, HANDSHAKE_FILE);
  } catch {
    // The handshake is evidence, never a precondition: a stub that cannot
    // write it still has a journey to run, and the preflight is what turns
    // its absence into a readable failure.
  }
}

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Scenarios and invocations
// ---------------------------------------------------------------------------

/**
 * The script for the ticket this spawn belongs to.
 *
 * Keyed by epic id and matched as a SUBSTRING of the working directory: every
 * code-producing spawn runs in the epic's worktree, whose directory name is
 * `feature-epic-<epicId>-<slug>` (lib/git/manager.ts). Substring rather than a
 * parsed segment because a nanoid may itself contain a dash, which makes
 * `feature-epic-([^-]+)` wrong. The prompt is searched too, so a scenario
 * still resolves for a spawn that runs somewhere other than the worktree.
 */
function findScenario(cwd, prompt) {
  let names = [];
  try {
    names = fs.readdirSync(SCENARIO_DIR);
  } catch {
    return null;
  }

  const haystack = `${cwd}\n${prompt}`;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!haystack.includes(id)) continue;
    try {
      const scenario = JSON.parse(fs.readFileSync(path.join(SCENARIO_DIR, name), "utf8"));
      return { id, ...scenario };
    } catch (error) {
      throw new Error(`scenario ${name} is unreadable: ${String(error)}`);
    }
  }
  return null;
}

/**
 * Claims the next step of a scenario and opens its invocation record.
 *
 * `wx` makes the claim atomic: two spawns racing for the same ticket take
 * different indexes rather than both believing they are the build. The
 * journeys are sequential by construction, so a race here means the product
 * dispatched something unexpected — which the test reads back from these
 * records.
 */
function claimInvocation(scenarioId, record) {
  fs.mkdirSync(INVOCATION_DIR, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    const file = path.join(INVOCATION_DIR, `${scenarioId}-${index}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ index, ...record }, null, 2), {
        flag: "wx",
      });
      return { index, file };
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`scenario ${scenarioId} was invoked more than 100 times`);
}

/** Rewrites an invocation record once the step has run (or failed). */
function completeInvocation(claim, patch) {
  try {
    const current = JSON.parse(fs.readFileSync(claim.file, "utf8"));
    fs.writeFileSync(claim.file, JSON.stringify({ ...current, ...patch }, null, 2));
  } catch {
    // best-effort: the stub's own exit code and stderr are the primary signal
  }
}

// ---------------------------------------------------------------------------
// Reading what the provider handed us
// ---------------------------------------------------------------------------

/**
 * The prompt, from wherever this spawn put it.
 *
 * `lib/providers/prompt-transport.ts` moves a prompt off argv once it exceeds
 * the kernel's per-argument ceiling, and an assembled build prompt routinely
 * does — so both transports are real, and a stub that only read `-p` would
 * silently see an empty prompt on the large ones.
 */
function readPrompt(argv) {
  const flag = argv.indexOf("-p");
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1];
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * The Arij MCP channel, read out of the `--mcp-config` file claude is given.
 *
 * The file is the real per-session config (`lib/claude/mcp-injection.ts`), so
 * the token this returns is the same short-lived, session-scoped bearer a real
 * agent's MCP shim would use.
 */
function readMcpChannel(argv) {
  const flag = argv.indexOf("--mcp-config");
  if (flag === -1 || argv[flag + 1] === undefined) return null;
  try {
    const config = JSON.parse(fs.readFileSync(argv[flag + 1], "utf8"));
    const server = config?.mcpServers?.arij;
    const env = server?.env ?? {};
    if (!env.ARIJ_MCP_TOKEN || !env.ARIJ_BASE_URL) return null;
    return { baseUrl: String(env.ARIJ_BASE_URL).replace(/\/+$/, ""), token: env.ARIJ_MCP_TOKEN };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The build step: a real commit, in the real worktree, on the epic's branch.
 *
 * This is what makes the merge at the end of a journey a genuine `git merge`
 * of work that Arij's own build path produced, rather than of a commit the
 * test manufactured beside it.
 */
function runBuildStep(step) {
  const file = step.file || "AGENT.md";
  const cwd = process.cwd();
  fs.writeFileSync(path.join(cwd, file), step.content ?? `Written by the e2e agent stub.\n`);
  git(cwd, ["add", "--", file]);
  git(cwd, [...COMMIT_IDENTITY, "commit", "-m", step.message || "Work from the e2e agent stub"]);
  return { committed: file, head: git(cwd, ["rev-parse", "HEAD"]).trim() };
}

/**
 * The review step: a real `submit_findings` call over the session's own token.
 *
 * Deliberately calls the HTTP route the MCP shim (`bin/arij-mcp.mjs`) fronts
 * rather than speaking JSON-RPC to the shim: the shim's transport is a unit
 * concern, while what a journey needs to prove is that a review session's
 * structured verdict reaches the transition service and moves the ticket.
 *
 * No prose verdict is emitted anywhere in this step. If the structured
 * channel breaks, nothing else promotes the ticket and the journey fails —
 * which is the point.
 */
async function runReviewStep(step, channel) {
  if (!channel) {
    throw new Error(
      "review step reached the stub without an MCP channel — the session was spawned without --mcp-config, " +
        "so no structured verdict can be filed (is mcp_tools_enabled false?)"
    );
  }

  const body = {
    verdict: step.verdict || "approved",
    summary: step.summary || "Reviewed by the e2e agent stub.",
    findings: step.findings || [],
  };

  const response = await fetch(`${channel.baseUrl}/api/mcp/submit-findings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${channel.token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`submit_findings failed: ${response.status} ${text}`);
  }
  return { submitFindings: { status: response.status, verdict: body.verdict } };
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The claude-code entry point — the one that actually plays a scenario.
 *
 * Its stdout is the `--output-format json` result envelope
 * `lib/claude/json-parser.ts` parses: `type: "result"` with the final message
 * in `result`, which is what makes the run classify as `answered` (a delivered
 * build) rather than `silent`.
 */
async function runClaude(argv) {
  if (argv.includes("--version")) {
    process.stdout.write("0.0.0-arij-e2e-stub\n");
    return;
  }

  const prompt = readPrompt(argv);
  const cwd = safeCwd();
  const scenario = findScenario(cwd, prompt);
  if (!scenario) {
    throw new Error(
      `no e2e scenario matches this spawn (cwd ${cwd}). The stub refuses to improvise: ` +
        `write one with writeScenario() before dispatching an agent.`
    );
  }

  const sessionIdFlag = argv.indexOf("--session-id");
  const cliSessionId =
    sessionIdFlag !== -1 ? argv[sessionIdFlag + 1] : `stub-${process.pid}`;
  const channel = readMcpChannel(argv);

  const claim = claimInvocation(scenario.id, {
    binary: "claude",
    at: new Date().toISOString(),
    cwd,
    argv,
    prompt,
    hasMcpChannel: !!channel,
    cliSessionId,
  });

  const step = (scenario.steps || [])[claim.index];
  if (!step) {
    const error = `scenario ${scenario.id} has no step ${claim.index} — the product dispatched an agent the journey did not expect`;
    completeInvocation(claim, { kind: null, ok: false, error });
    throw new Error(error);
  }

  try {
    let detail = {};
    if (step.kind === "build") {
      detail = runBuildStep(step);
    } else if (step.kind === "review") {
      detail = await runReviewStep(step, channel);
    } else if (step.kind === "fail") {
      throw new Error(step.error || "the scenario asked this step to fail");
    } else {
      throw new Error(`unknown scenario step kind: ${String(step.kind)}`);
    }
    completeInvocation(claim, { kind: step.kind, ok: true, ...detail });

    process.stdout.write(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: cliSessionId,
        result: step.say || `Step ${claim.index} (${step.kind}) done.`,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      })}\n`
    );
  } catch (error) {
    completeInvocation(claim, {
      kind: step.kind ?? null,
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
    throw error;
  }
}

/**
 * The codex entry point — availability handshake only.
 *
 * `CodexProvider.isAvailable()` runs `codex login status` and looks for
 * "logged in", which is what makes codex the one provider whose availability
 * check EXECUTES its binary — and therefore the one the preflight can use to
 * prove these stubs are installed without dispatching anything.
 *
 * Anything else is refused: a journey pins its provider to claude-code, so a
 * codex `exec` here means the resolution landed somewhere the test did not
 * intend, and running it would be a real agent's worth of nondeterminism.
 */
function runCodex(argv) {
  if (argv[0] === "login" && argv[1] === "status") {
    process.stdout.write("Logged in as arij-e2e-stub\n");
    return;
  }
  if (argv.includes("--version")) {
    process.stdout.write("codex 0.0.0-arij-e2e-stub\n");
    return;
  }
  refuse("codex", argv);
}

/**
 * Every other provider binary: present so the availability surface is honest,
 * refusing so a mis-resolved dispatch fails loudly instead of reaching a real,
 * billed CLI.
 */
function refuse(binary, argv) {
  throw new Error(
    `${binary} is the Arij e2e stub and does not run agents. This dispatch resolved to the ` +
      `${binary} provider, but the journey pins claude-code — check the project's agent-config ` +
      `defaults. (argv: ${argv.slice(0, 6).join(" ")})`
  );
}

/** Shared bootstrap for the four entry points in `bin/`. */
export function main(binary) {
  const argv = process.argv.slice(2);
  recordHandshake(binary);

  const run = async () => {
    if (binary === "claude") return runClaude(argv);
    if (binary === "codex") return runCodex(argv);
    return refuse(binary, argv);
  };

  Promise.resolve()
    .then(run)
    .catch((error) => {
      process.stderr.write(
        `[arij-e2e-stub:${binary}] ${String(error && error.message ? error.message : error)}\n`
      );
      // Exit code rather than process.exit(): stdout/stderr still have to
      // flush, and the provider reads both.
      process.exitCode = 1;
    });
}
