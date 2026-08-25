import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  settings,
  ticketComments,
} from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { worktreesRootFor } from "@/lib/projects/workspace";
import { createId } from "@/lib/utils/nanoid";
import {
  BUG_REGRESSION_CHECK_SETTING_KEY,
  BUG_REGRESSION_COMMAND_SETTING_KEY,
  TEST_FILE_PATTERNS_SETTING_KEY,
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
  parseBugRegressionCommand,
  parseBugRegressionSetting,
  parseTestFilePatterns,
} from "@/lib/verify/regression-constants";
import {
  formatRegressionReportComment,
  type RegressionReportPayload,
} from "@/lib/verify/regression-report";
import {
  runRegressionCheck,
  type RegressionCheckResult,
} from "@/lib/verify/regression-check";

/**
 * The pipeline's mechanical verify gate for bug tickets (RoboBun rule).
 *
 * Runs between a successful code stage (build or fix) and the review
 * dispatch: when the ticket is a bug AND the `bug_regression_check`
 * setting is on (tri-state, default OFF → behaviour unchanged for every
 * existing ticket), the branch must carry a test file that is green on the
 * branch and red on the merge-base (see lib/verify/regression-check.ts).
 * A failed gate short-circuits review: the runner enters a fix cycle with
 * the exact failure reason injected into the fix prompt.
 *
 * Every run — passed or failed — is persisted as an ordinary ticket
 * comment (formatted by lib/verify/regression-report.ts) so the ticket's
 * activity feed shows the regression block across restarts.
 */

/** Identity the gate needs; startPipelineRun captures it at run start. */
export interface VerifyGateIdentity {
  projectId: string;
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
}

/**
 * The runner-facing gate. Project/ticket identity is captured by
 * createVerifyGate's caller (startPipelineRun knows them); the runner only
 * supplies the code session whose worktree must be verified.
 */
export type VerifyGate = (
  lastCodeSessionId: string | null
) => Promise<VerifyGateOutcome>;

export interface VerifyGateOutcome {
  /** False when the gate did not apply (not a bug / setting off / no worktree). */
  ran: boolean;
  passed: boolean | null;
  result: RegressionCheckResult | null;
}



function notRun(): VerifyGateOutcome {
  return { ran: false, passed: null, result: null };
}

/**
 * Reads the three regression settings from the key/value table —
 * per-project key first (`<key>:<projectId>`), global key second, built-in
 * default last. Re-read on every gate invocation: flipping the switch takes
 * effect on the next stage without a restart, same posture as
 * resolveAutoModeConfigForProject.
 */
function readRegressionConfig(projectId: string): {
  enabled: boolean;
  patterns: readonly string[];
  commandTemplate: string;
} {
  const patternKeys = [
    `${TEST_FILE_PATTERNS_SETTING_KEY}:${projectId}`,
    TEST_FILE_PATTERNS_SETTING_KEY,
  ];
  const commandKeys = [
    `${BUG_REGRESSION_COMMAND_SETTING_KEY}:${projectId}`,
    BUG_REGRESSION_COMMAND_SETTING_KEY,
  ];
  const enabledKeys = [
    `${BUG_REGRESSION_CHECK_SETTING_KEY}:${projectId}`,
    BUG_REGRESSION_CHECK_SETTING_KEY,
  ];

  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...patternKeys, ...commandKeys, ...enabledKeys]))
    .all();
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const firstParsed = <T>(
    keys: readonly string[],
    parse: (value: unknown) => T | null
  ): T | null => {
    for (const key of keys) {
      if (!map.has(key)) continue;
      const parsed = parse(map.get(key));
      if (parsed !== null) return parsed;
    }
    return null;
  };

  return {
    enabled: firstParsed(enabledKeys, parseBugRegressionSetting) ?? false,
    patterns:
      firstParsed(patternKeys, parseTestFilePatterns) ?? DEFAULT_TEST_FILE_PATTERNS,
    commandTemplate:
      firstParsed(commandKeys, parseBugRegressionCommand) ??
      DEFAULT_BUG_REGRESSION_COMMAND,
  };
}

/** Persists the report as an agent-authored ticket comment on the verified ticket. */
function persistReportComment(
  identity: VerifyGateIdentity,
  payload: RegressionReportPayload
): void {
  try {
    db.insert(ticketComments)
      .values({
        id: createId(),
        epicId: identity.epicId,
        ...(identity.scope === "story" && identity.userStoryId
          ? { userStoryId: identity.userStoryId }
          : {}),
        author: "agent",
        content: formatRegressionReportComment(payload),
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch (error) {
    // A lost report comment must never fail the pipeline stage itself —
    // the gate verdict has already been computed.
    console.warn(
      "[pipeline verify] Failed to persist regression report:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Server-side verify gate handed to the pipeline runner by startPipelineRun.
 */
export function createVerifyGate(identity: VerifyGateIdentity): VerifyGate {
  return async (lastCodeSessionId: string | null): Promise<VerifyGateOutcome> => {
    // --- Ticket type: bugs only ----------------------------------------
    const epic = db.select().from(epics).where(eq(epics.id, identity.epicId)).get();
    if (!epic) return notRun();
    if ((epic.type ?? "feature") !== "bug") return notRun();

    // --- Settings ------------------------------------------------------
    const config = readRegressionConfig(identity.projectId);
    if (!config.enabled) return notRun();

    // --- Worktree of the code stage being verified ---------------------
    if (!lastCodeSessionId) return notRun();
    const session = db
      .select({
        worktreePath: agentSessions.worktreePath,
        branchName: agentSessions.branchName,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, lastCodeSessionId),
          eq(agentSessions.projectId, identity.projectId)
        )
      )
      .get();
    if (!session?.worktreePath) return notRun();

    const project = db
      .select({
        defaultBranch: projects.defaultBranch,
        gitRepoPath: projects.gitRepoPath,
      })
      .from(projects)
      .where(eq(projects.id, identity.projectId))
      .get();

    let result: RegressionCheckResult;
    try {
      result = await runRegressionCheck({
        repoPath: session.worktreePath,
        headBranch: session.branchName,
        baseBranch: project?.defaultBranch ?? null,
        // Compute the red worktree's home from the MAIN repository: the
        // green cwd is itself `<root>/.arij-worktrees/<branch>`, and a
        // naive sibling computation would nest `.arij-worktrees` inside
        // `.arij-worktrees`.
        worktreeRoot: project?.gitRepoPath
          ? worktreesRootFor(project.gitRepoPath)
          : null,
        commandTemplate: config.commandTemplate,
      });
    } catch (error) {
      result = {
        status: "failed",
        reason: "command_error",
        testFiles: [],
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    persistReportComment(identity, {
      regression: {
        status: result.status,
        reason: result.reason,
        testFiles: result.testFiles,
        detail: result.detail,
        checkedAt: new Date().toISOString(),
      },
    });

    return { ran: true, passed: result.status === "passed", result };
  };
}
