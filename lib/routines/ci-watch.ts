import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  epics,
  projects,
  routines,
  type Routine,
} from "@/lib/db/schema";
import {
  fetchPullRequestCiFailureEvidence,
  fetchPullRequestCiStatus,
  type PullRequestCiFailureEvidence,
  type PullRequestCiState,
  type PullRequestCiStatus,
} from "@/lib/github/pull-requests";
import { parseOwnerRepo } from "@/lib/github/client";
import { createCiWatchFailureNotification } from "@/lib/notifications/create";
import type { RoutineActionResult } from "@/lib/routines/actions";
import {
  launchCiAutofixSession,
  type CiAutofixLaunchResult,
} from "@/lib/routines/ci-autofix";
import { isCiAutofixEnabled } from "@/lib/routines/settings";

export {
  CI_AUTOFIX_ENABLED_SETTING_KEY,
  ciAutofixEnabledSettingKey,
  isCiAutofixEnabled,
} from "@/lib/routines/settings";

export const DEFAULT_CI_WATCH_INTERVAL_MINUTES = 15;
const CI_WATCH_STATE_CONFIG_KEY = "ciWatchState";

export interface CiWatchEpic {
  id: string;
  title: string;
  readableId: string | null;
  prNumber: number | null;
  prStatus: string | null;
}

export interface StoredCiObservation {
  prNumber: number;
  headSha: string;
  state: PullRequestCiState;
  failureNotified: boolean;
  /** Claimed before dispatch so a crash cannot replay the same PR head. */
  autofixAttempted: boolean;
  autofixSessionId: string | null;
}

type StoredCiWatchState = Record<string, StoredCiObservation>;

export interface CiWatchDeps {
  listOpenPullRequestEpics(projectId: string): CiWatchEpic[];
  getGitHubOwnerRepo(projectId: string): string | null;
  fetchPullRequestCi(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PullRequestCiStatus>;
  isAutofixEnabled(projectId: string): boolean;
  fetchFailureEvidence(
    owner: string,
    repo: string,
    snapshot: PullRequestCiStatus
  ): Promise<PullRequestCiFailureEvidence[]>;
  launchAutofix(input: {
    projectId: string;
    epicId: string;
    prNumber: number;
    headSha: string;
    failures: PullRequestCiFailureEvidence[];
  }): Promise<CiAutofixLaunchResult>;
  persistConfig(routineId: string, config: string): void;
  notifyFailure(input: {
    projectId: string;
    epicId: string;
    epicTitle: string;
    epicReadableId: string | null;
    prNumber: number;
    headSha: string;
    failedChecks: string[];
  }): void;
}

export const defaultCiWatchDeps: CiWatchDeps = {
  listOpenPullRequestEpics: (projectId) =>
    db
      .select({
        id: epics.id,
        title: epics.title,
        readableId: epics.readableId,
        prNumber: epics.prNumber,
        prStatus: epics.prStatus,
      })
      .from(epics)
      .where(
        and(
          eq(epics.projectId, projectId),
          eq(epics.prStatus, "open"),
          isNotNull(epics.prNumber)
        )
      )
      .all(),
  getGitHubOwnerRepo: (projectId) =>
    db
      .select({ githubOwnerRepo: projects.githubOwnerRepo })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()?.githubOwnerRepo ?? null,
  fetchPullRequestCi: fetchPullRequestCiStatus,
  isAutofixEnabled: isCiAutofixEnabled,
  fetchFailureEvidence: fetchPullRequestCiFailureEvidence,
  launchAutofix: launchCiAutofixSession,
  persistConfig: (routineId, config) => {
    db.update(routines)
      .set({ config })
      .where(eq(routines.id, routineId))
      .run();
  },
  notifyFailure: createCiWatchFailureNotification,
};

function parseConfig(routine: Routine): Record<string, unknown> {
  try {
    const config = JSON.parse(routine.config) as unknown;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("config must be a JSON object");
    }
    return config as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Routine ${routine.id} has invalid config: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`
    );
  }
}

function parseStoredState(value: unknown): StoredCiWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const state: StoredCiWatchState = {};
  for (const [epicId, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const row = candidate as Partial<StoredCiObservation>;
    if (
      !Number.isInteger(row.prNumber) ||
      typeof row.headSha !== "string" ||
      !["passing", "pending", "failing"].includes(row.state ?? "") ||
      typeof row.failureNotified !== "boolean"
    ) {
      continue;
    }
    state[epicId] = {
      prNumber: row.prNumber,
      headSha: row.headSha,
      state: row.state,
      failureNotified: row.failureNotified,
      autofixAttempted:
        typeof row.autofixAttempted === "boolean"
          ? row.autofixAttempted
          : false,
      autofixSessionId:
        typeof row.autofixSessionId === "string"
          ? row.autofixSessionId
          : null,
    } as StoredCiObservation;
  }
  return state;
}

/**
 * CI failures are notified once for each (PR, head SHA). A pending or passing
 * first observation is retained so a later failure on the same SHA is still
 * recognized, while a green interlude never resets the per-SHA notification
 * guard.
 */
export function nextCiObservation(
  previous: StoredCiObservation | undefined,
  prNumber: number,
  snapshot: PullRequestCiStatus
): { observation: StoredCiObservation; shouldNotify: boolean } {
  const sameHead =
    previous?.prNumber === prNumber && previous.headSha === snapshot.headSha;
  const alreadyNotified = sameHead && previous.failureNotified;
  const shouldNotify = snapshot.state === "failing" && !alreadyNotified;

  return {
    observation: {
      prNumber,
      headSha: snapshot.headSha,
      state: snapshot.state,
      failureNotified: alreadyNotified || shouldNotify,
      autofixAttempted: sameHead
        ? previous?.autofixAttempted ?? false
        : false,
      autofixSessionId: sameHead
        ? previous?.autofixSessionId ?? null
        : null,
    },
    shouldNotify,
  };
}

export async function runCiWatchRoutine(
  routine: Routine,
  deps: CiWatchDeps = defaultCiWatchDeps
): Promise<RoutineActionResult> {
  const openPullRequests = deps
    .listOpenPullRequestEpics(routine.projectId)
    .filter(
      (epic): epic is CiWatchEpic & { prNumber: number } =>
        epic.prStatus === "open" && epic.prNumber !== null
    );
  if (openPullRequests.length === 0) {
    return {
      status: "skipped",
      message: "No open pull requests are currently attached to epics.",
      targetUrl: `/projects/${routine.projectId}`,
    };
  }

  const ownerRepo = deps.getGitHubOwnerRepo(routine.projectId);
  if (!ownerRepo) {
    throw new Error("Project is not connected to a GitHub repository");
  }
  const { owner, repo } = parseOwnerRepo(ownerRepo);
  const config = parseConfig(routine);
  const previousState = parseStoredState(config[CI_WATCH_STATE_CONFIG_KEY]);
  // Preserve still-unprocessed observations if one GitHub request fails
  // halfway through the sweep; otherwise the following retry could replay an
  // alert for an epic whose durable entry was accidentally dropped.
  const nextState: StoredCiWatchState = { ...previousState };
  const eligibleEpicIds = new Set(openPullRequests.map((epic) => epic.id));
  let failingPullRequests = 0;
  let newFailures = 0;
  let autofixesLaunched = 0;
  let autofixesSkipped = 0;
  const autofixEnabled = deps.isAutofixEnabled(routine.projectId);

  for (const epic of openPullRequests) {
    const snapshot = await deps.fetchPullRequestCi(
      owner,
      repo,
      epic.prNumber
    );
    const decision = nextCiObservation(
      previousState[epic.id],
      epic.prNumber,
      snapshot
    );
    nextState[epic.id] = decision.observation;
    if (snapshot.state === "failing") failingPullRequests += 1;

    // Persist the SHA guard before ringing the bell. This makes a process
    // restart immediately after the notification unable to replay it.
    deps.persistConfig(
      routine.id,
      JSON.stringify({ ...config, [CI_WATCH_STATE_CONFIG_KEY]: nextState })
    );

    if (decision.shouldNotify) {
      deps.notifyFailure({
        projectId: routine.projectId,
        epicId: epic.id,
        epicTitle: epic.title,
        epicReadableId: epic.readableId,
        prNumber: epic.prNumber,
        headSha: snapshot.headSha,
        failedChecks: snapshot.failedChecks,
      });
      newFailures += 1;
    }

    if (
      snapshot.state === "failing" &&
      autofixEnabled &&
      !decision.observation.autofixAttempted
    ) {
      // Claim before fetching logs or invoking the build route. A process
      // crash anywhere below consumes this head, honoring the strict
      // one-session-per-(PR, SHA) contract after restart.
      nextState[epic.id] = {
        ...decision.observation,
        autofixAttempted: true,
      };
      deps.persistConfig(
        routine.id,
        JSON.stringify({ ...config, [CI_WATCH_STATE_CONFIG_KEY]: nextState })
      );

      let failures: PullRequestCiFailureEvidence[];
      try {
        failures = await deps.fetchFailureEvidence(owner, repo, snapshot);
      } catch (error) {
        console.warn(
          `[ci-watch] Could not fetch CI log tails for PR #${epic.prNumber}`,
          error
        );
        failures = snapshot.failedChecks.map((name) => ({
          name,
          logTail: null,
        }));
      }

      const launch = await deps.launchAutofix({
        projectId: routine.projectId,
        epicId: epic.id,
        prNumber: epic.prNumber,
        headSha: snapshot.headSha,
        failures,
      });
      if (launch.status === "launched") autofixesLaunched += 1;
      else autofixesSkipped += 1;
      nextState[epic.id] = {
        ...nextState[epic.id],
        autofixSessionId: launch.sessionId,
      };
      deps.persistConfig(
        routine.id,
        JSON.stringify({ ...config, [CI_WATCH_STATE_CONFIG_KEY]: nextState })
      );
    }
  }

  for (const epicId of Object.keys(nextState)) {
    if (!eligibleEpicIds.has(epicId)) delete nextState[epicId];
  }
  deps.persistConfig(
    routine.id,
    JSON.stringify({ ...config, [CI_WATCH_STATE_CONFIG_KEY]: nextState })
  );

  return {
    status: "completed",
    message: `Checked ${openPullRequests.length} open pull request${
      openPullRequests.length === 1 ? "" : "s"
    }; ${failingPullRequests} failing, ${newFailures} newly reported${
      autofixesLaunched + autofixesSkipped > 0
        ? `; ${autofixesLaunched} autofix launched, ${autofixesSkipped} skipped`
        : ""
    }.`,
    targetUrl: `/projects/${routine.projectId}`,
  };
}
