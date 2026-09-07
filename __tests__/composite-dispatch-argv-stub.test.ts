/**
 * A composite unfolds all the way down to the ARGV OF A REAL CHILD PROCESS.
 *
 * Every other test in this epic stops at the resolver's return value: it
 * proves which member was chosen, never that the choice survives the provider
 * layer into the command the machine actually runs. The gap is real — the
 * retired escalation used to reach `pickAlternativeReviewProvider()` and hand
 * back `namedAgentId: null` with the CLI's default model, which every
 * resolver-level assertion would still have called "a provider switch".
 *
 * THE BINARIES HERE ARE STUBS. `codex` and `agy` are shell scripts on a
 * temporary PATH that record their own argv and exit 0. That makes this
 * honest evidence about ARIJ'S SELECTION AND ARGV ASSEMBLY — the member's
 * provider becomes the binary, the member's model becomes the model flag —
 * and no evidence whatsoever about the agents' behaviour: nothing here ever
 * runs Codex or Antigravity.
 *
 * The dispatch entry is `processManager.start()`, which is what every build,
 * review, QA and pipeline route calls, so the provider abstraction, the argv
 * builders and the child spawn are all in the loop rather than stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "@/lib/db/test-utils";

const { db: testDb, sqlite: testSqlite } = createTestDb();
vi.mock("@/lib/db", () => ({ db: testDb, sqlite: testSqlite }));

/** Where the stubs live and where they drop their argv recordings. */
let stubDir: string;
let argvDir: string;
let originalPath: string | undefined;

/**
 * A stub CLI: records `$0` and every argument as JSON, satisfies the two
 * output contracts the providers read back, and exits 0.
 *
 * `-o <file>` is codex's final-message file; `--output-format json` is agy's
 * envelope on stdout. Writing both keeps a successful result on either
 * provider, so a failed spawn cannot be mistaken for a wrong argv.
 */
function writeStub(name: string): void {
  const script = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
fs.writeFileSync(
  path.join(${JSON.stringify("__ARGV_DIR__")}, ${JSON.stringify(name)} + ".json"),
  JSON.stringify({ binary: ${JSON.stringify(name)}, argv }, null, 2)
);
const oIndex = argv.indexOf("-o");
if (oIndex !== -1 && argv[oIndex + 1]) {
  try { fs.writeFileSync(argv[oIndex + 1], "stub final message"); } catch {}
}
process.stdout.write(JSON.stringify({ response: "stub final message", conversationId: "stub-conv" }) + "\\n");
`.replace("__ARGV_DIR__", argvDir);
  const file = path.join(stubDir, name);
  fs.writeFileSync(file, script.replace(JSON.stringify("__ARGV_DIR__"), JSON.stringify(argvDir)));
  fs.chmodSync(file, 0o755);
}

/** The argv the named stub recorded, or null if it never ran. */
function recordedArgv(name: string): { binary: string; argv: string[] } | null {
  const file = path.join(argvDir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arij-composite-argv-"));
  stubDir = path.join(root, "bin");
  argvDir = path.join(root, "argv");
  fs.mkdirSync(stubDir);
  fs.mkdirSync(argvDir);
  for (const name of ["codex", "agy"]) writeStub(name);
  originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  try { fs.rmSync(path.dirname(stubDir), { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  testSqlite.exec("DELETE FROM composite_agent_members");
  testSqlite.exec("DELETE FROM agent_sessions");
  testSqlite.exec("DELETE FROM named_agents");
  testSqlite.exec("DELETE FROM epics");
  testSqlite.exec("DELETE FROM projects");
  for (const name of ["codex", "agy"]) {
    const file = path.join(argvDir, `${name}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

/** The two members, deliberately on DIFFERENT providers and models. */
const FIRST = { name: "Codex Builder", provider: "codex", model: "gpt-5.4-codex" };
const SECOND = { name: "Antigravity Backup", provider: "agy", model: "gemini-3-pro" };

async function seedComposite(): Promise<{ compositeId: string; memberIds: string[] }> {
  const { createNamedAgent, createCompositeAgent } = await import(
    "@/lib/agent-config/named-agents"
  );
  const memberIds: string[] = [];
  for (const member of [FIRST, SECOND]) {
    const { data, error } = await createNamedAgent(member);
    expect(error).toBeUndefined();
    memberIds.push(data!.id);
  }
  const { data, error } = await createCompositeAgent({
    name: "Ladder",
    memberIds,
  });
  expect(error).toBeUndefined();
  return { compositeId: data!.id, memberIds };
}

/** A session row, because `processManager.start()` writes `cli_command` onto it. */
function seedSessionRow(sessionId: string, projectId = "proj-1"): void {
  testSqlite
    .prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)")
    .run(projectId, "Composite argv probe", new Date().toISOString());
  testSqlite
    .prepare(
      "INSERT INTO agent_sessions (id, project_id, agent_type, status, provider, prompt, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(sessionId, projectId, "build", "queued", "codex", "stub prompt", new Date().toISOString());
}

/**
 * Dispatch through the real entry point and wait for the child to exit.
 * Polls the manager's own session record rather than reaching for the
 * promise, which is exactly what a route does.
 */
async function dispatchAndWait(
  sessionId: string,
  provider: string,
  model: string
): Promise<void> {
  const { processManager } = await import("@/lib/claude/process-manager");
  processManager.start(
    sessionId,
    { prompt: "stub prompt", cwd: process.cwd(), model },
    provider as never
  );
  for (let i = 0; i < 200; i++) {
    const info = processManager.getStatus(sessionId);
    if (info && info.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} never left "running"`);
}

describe("a composite reaches the child process as its member's provider and model", () => {
  it("rank 0 spawns the FIRST member's binary carrying the FIRST member's model", async () => {
    const { compositeId, memberIds } = await seedComposite();
    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );

    // The resolver half: an explicit composite choice unfolds to member 1.
    const resolved = await resolveAgentForDispatch("build", undefined, compositeId);
    expect(resolved.provider).toBe(FIRST.provider);
    expect(resolved.model).toBe(FIRST.model);
    expect(resolved.namedAgentId).toBe(memberIds[0]);
    expect(resolved.compositeAgentId).toBe(compositeId);

    seedSessionRow("sess-rank-0");
    await dispatchAndWait("sess-rank-0", resolved.provider, resolved.model!);

    // The argv half — the claim the resolver cannot make.
    const record = recordedArgv("codex");
    expect(record, "the codex stub never ran").not.toBeNull();
    expect(record!.binary).toBe("codex");
    // codex takes the model as `-m <model>`.
    expect(record!.argv).toContain("-m");
    expect(record!.argv[record!.argv.indexOf("-m") + 1]).toBe(FIRST.model);
    // The OTHER member's binary was never invoked: rank 0 is not a race.
    expect(recordedArgv("agy")).toBeNull();
  });

  it("rank 1 spawns the SECOND member's binary carrying the SECOND member's model", async () => {
    const { compositeId, memberIds } = await seedComposite();
    const { resolveCompositeMemberAtRank } = await import(
      "@/lib/agent-config/agent-resolution"
    );

    const step = resolveCompositeMemberAtRank(compositeId, 1);
    expect(step.exhausted).toBeFalsy();
    expect(step.resolved?.provider).toBe(SECOND.provider);
    expect(step.resolved?.model).toBe(SECOND.model);
    expect(step.resolved?.namedAgentId).toBe(memberIds[1]);

    seedSessionRow("sess-rank-1");
    await dispatchAndWait("sess-rank-1", step.resolved!.provider, step.resolved!.model!);

    const record = recordedArgv("agy");
    expect(record, "the agy stub never ran").not.toBeNull();
    expect(record!.binary).toBe("agy");
    // agy takes the model as `--model <M>`.
    expect(record!.argv).toContain("--model");
    expect(record!.argv[record!.argv.indexOf("--model") + 1]).toBe(SECOND.model);
    // A descent must not re-run the member that already failed.
    expect(recordedArgv("codex")).toBeNull();
  });

  it("persists the member's binary in the session's displayed command", async () => {
    const { compositeId } = await seedComposite();
    const { resolveAgentForDispatch } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const resolved = await resolveAgentForDispatch("build", undefined, compositeId);

    seedSessionRow("sess-cmd");
    await dispatchAndWait("sess-cmd", resolved.provider, resolved.model!);

    const row = testSqlite
      .prepare("SELECT cli_command FROM agent_sessions WHERE id = ?")
      .get("sess-cmd") as { cli_command: string | null };
    // What a user reads on the session detail has to name the member's CLI and
    // model, or two runs of the same composite are indistinguishable.
    expect(row.cli_command).toContain("codex");
    expect(row.cli_command).toContain(FIRST.model);
  });
});
