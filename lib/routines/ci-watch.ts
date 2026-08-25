import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, projects, routines, type Routine } from "@/lib/db/schema";
import { getRunningSessionForTarget } from "@/lib/agents/concurrency";
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
import { parseRoutineConfig } from "@/lib/routines/constants";
import {
  launchCiAutofixSession,
  type CiAutofixLaunchResult,
} from "@/lib/routines/ci-autofix";
import { boundCiAutofixEvidence } from "@/lib/routines/ci-autofix-limits";
import { isCiAutofixEnabled } from "@/lib/routines/settings";

export {
  CI_AUTOFIX_ENABLED_SETTING_KEY,
  ciAutofixEnabledSettingKey,
  isCiAutofixEnabled,
} from "@/lib/routines/settings";

export const DEFAULT_CI_WATCH_INTERVAL_MINUTES = 15;
const CI_WATCH_STATE_CONFIG_KEY = "ciWatchState";
const CI_WATCH_ERROR_STATE_CONFIG_KEY = "ciWatchErrorState";
const PROJECT_ERROR_SCOPE = "$project";

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
type StoredCiWatchErrorState = Record<string, string>;

export interface CiWatchDeps {
  listOpenPullRequestEpics(projectId: string): CiWatchEpic[];
  getGitHubOwnerRepo(projectId: string): string | null;
  fetchPullRequestCi(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestCiStatus>;
  isAutofixEnabled(projectId: string): boolean;
  fetchFailureEvidence(
    owner: string,
    repo: string,
    snapshot: PullRequestCiStatus,
  ): Promise<PullRequestCiFailureEvidence[]>;
  launchAutofix(input: {
    projectId: string;
    epicId: string;
    prNumber: number;
    headSha: string;
    failures: PullRequestCiFailureEvidence[];
  }): Promise<CiAutofixLaunchResult>;
  persistState(
    routineId: string,
    state: StoredCiWatchState,
    errorState: StoredCiWatchErrorState,
  ): void;
  notifyFailure(input: {
    projectId: string;
    epicId: string;
    epicTitle: string;
    epicReadableId: string | null;
    prNumber: number;
    headSha: string;
    failedChecks: string[];
  }): void;
  /**
   * Writes back the lifecycle Arij just observed so a merged or closed PR
   * stops being polled every interval. Internal state only; never surfaced
   * through the routine CRUD API.
   */
  setEpicPullRequestState(epicId: string, prStatus: string): void;
  /**
   * Cheap pre-check mirroring the build route's one-agent-per-ticket guard:
   * lets the sweep defer a busy epic before downloading log evidence.
   */
  hasActiveSessionForEpic(projectId: string, epicId: string): boolean;
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
          // Drafts run CI too; only closed/merged PRs are dropped, and the
          // sweep writes that state back through setEpicPullRequestState.
          inArray(epics.prStatus, ["open", "draft"]),
          isNotNull(epics.prNumber),
        ),
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
  persistState: (routineId, state, errorState) => {
    db.transaction((tx) => {
      const current = tx
        .select({ config: routines.config })
        .from(routines)
        .where(eq(routines.id, routineId))
        .get();
      if (!current) return;
      const config = parseRoutineConfig({
        id: routineId,
        config: current.config,
      });
      tx.update(routines)
        .set({
          config: JSON.stringify({
            ...config,
            [CI_WATCH_STATE_CONFIG_KEY]: state,
            [CI_WATCH_ERROR_STATE_CONFIG_KEY]: errorState,
          }),
        })
        .where(eq(routines.id, routineId))
        .run();
    });
  },
  notifyFailure: createCiWatchFailureNotification,
  setEpicPullRequestState: (epicId, prStatus) => {
    db.update(epics)
      .set({ prStatus, updatedAt: new Date().toISOString() })
      .where(eq(epics.id, epicId))
      .run();
  },
  hasActiveSessionForEpic: (projectId, epicId) =>
    getRunningSessionForTarget({ scope: "epic", projectId, epicId }) !== null,
};

function parseStoredState(value: unknown): StoredCiWatchState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const state: StoredCiWatchState = {};
  for (const [epicId, candidate] of Object.entries(value)) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
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
        typeof row.autofixSessionId === "string" ? row.autofixSessionId : null,
    } as StoredCiObservation;
  }
  return state;
}

function parseStoredErrorState(value: unknown): StoredCiWatchErrorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const state: StoredCiWatchErrorState = {};
  for (const [scope, signature] of Object.entries(value)) {
    if (typeof signature === "string" && signature.length > 0) {
      state[scope] = signature;
    }
  }
  return state;
}

function ciWatchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "CI watch request failed";
}

/** Stable enough to suppress a persistent GitHub/configuration error. */
function ciWatchErrorSignature(error: unknown): string {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
      ? String(error.status)
      : "error";
  return `${status}:${ciWatchErrorMessage(error)}`.slice(0, 1_000);
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
  snapshot: PullRequestCiStatus,
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
        ? (previous?.autofixAttempted ?? false)
        : false,
      autofixSessionId: sameHead ? (previous?.autofixSessionId ?? null) : null,
    },
    shouldNotify,
  };
}

export async function runCiWatchRoutine(
  routine: Routine,
  deps: CiWatchDeps = defaultCiWatchDeps,
): Promise<RoutineActionResult> {
  const openPullRequests = deps
    .listOpenPullRequestEpics(routine.projectId)
    .filter(
      (epic): epic is CiWatchEpic & { prNumber: number } =>
        (epic.prStatus === "open" || epic.prStatus === "draft") &&
        epic.prNumber !== null,
    );
  if (openPullRequests.length === 0) {
    return {
      status: "skipped",
      message: "No open pull requests are currently attached to epics.",
      targetUrl: `/projects/${routine.projectId}`,
      shouldNotify: false,
    };
  }

  const config = parseRoutineConfig(routine);
  const previousState = parseStoredState(config[CI_WATCH_STATE_CONFIG_KEY]);
  const previousErrorState = parseStoredErrorState(
    config[CI_WATCH_ERROR_STATE_CONFIG_KEY],
  );
  const nextErrorState: StoredCiWatchErrorState = { ...previousErrorState };
  let owner: string;
  let repo: string;
  try {
    const ownerRepo = deps.getGitHubOwnerRepo(routine.projectId);
    if (!ownerRepo) {
      throw new Error("Project is not connected to a GitHub repository");
    }
    ({ owner, repo } = parseOwnerRepo(ownerRepo));
    delete nextErrorState[PROJECT_ERROR_SCOPE];
  } catch (error) {
    const signature = ciWatchErrorSignature(error);
    const shouldNotify = previousErrorState[PROJECT_ERROR_SCOPE] !== signature;
    nextErrorState[PROJECT_ERROR_SCOPE] = signature;
    deps.persistState(routine.id, previousState, nextErrorState);
    return {
      status: "failed",
      message: ciWatchErrorMessage(error),
      targetUrl: `/projects/${routine.projectId}`,
      shouldNotify,
    };
  }
  // Preserve still-unprocessed observations if one GitHub request fails
  // halfway through the sweep; otherwise the following retry could replay an
  // alert for an epic whose durable entry was accidentally dropped.
  const nextState: StoredCiWatchState = { ...previousState };
  const eligibleEpicIds = new Set(openPullRequests.map((epic) => epic.id));
  let failingPullRequests = 0;
  let newFailures = 0;
  let autofixesLaunched = 0;
  let autofixesSkipped = 0;
  let processedPullRequests = 0;
  let reconciledPullRequests = 0;
  let newProcessingErrors = 0;
  const failedPullRequestNumbers: number[] = [];
  const autofixEnabled = deps.isAutofixEnabled(routine.projectId);

  for (const epic of openPullRequests) {
    try {
      const snapshot = await deps.fetchPullRequestCi(
        owner,
        repo,
        epic.prNumber,
      );

      // A merged or closed PR has no living CI. Write the observed state
      // back so it stops being polled, and drop its stale observation.
      if (snapshot.prState === "closed" || snapshot.prState === "merged") {
        deps.setEpicPullRequestState(epic.id, snapshot.prState);
        delete nextState[epic.id];
        delete nextErrorState[epic.id];
        deps.persistState(routine.id, nextState, nextErrorState);
        reconciledPullRequests += 1;
        processedPullRequests += 1;
        continue;
      }
      const decision = nextCiObservation(
        previousState[epic.id],
        epic.prNumber,
        snapshot,
      );
      nextState[epic.id] = decision.observation;
      delete nextErrorState[epic.id];
      if (snapshot.state === "failing") failingPullRequests += 1;

      // Persist the SHA guard before ringing the bell. This makes a process
      // restart immediately after the notification unable to replay it.
      deps.persistState(routine.id, nextState, nextErrorState);

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

      const autofixCandidate =
        snapshot.state === "failing" &&
        autofixEnabled &&
        !decision.observation.autofixAttempted;

      if (
        autofixCandidate &&
        deps.hasActiveSessionForEpic(routine.projectId, epic.id)
      ) {
        // A running agent owns this ticket. Defer without consuming the
        // one-shot claim or downloading log evidence that would be thrown
        // away on every poll until the ticket frees up.
        autofixesSkipped += 1;
      } else if (autofixCandidate) {
        // Claim before fetching logs or invoking the build route. A process
        // crash anywhere below consumes this head, honoring the strict
        // one-session-per-(PR, SHA) contract after restart.
        nextState[epic.id] = {
          ...decision.observation,
          autofixAttempted: true,
        };
        deps.persistState(routine.id, nextState, nextErrorState);

        let failures: PullRequestCiFailureEvidence[];
        try {
          failures = boundCiAutofixEvidence(
            await deps.fetchFailureEvidence(owner, repo, snapshot),
          );
        } catch (error) {
          console.warn(
            `[ci-watch] Could not fetch CI log tails for PR #${epic.prNumber}`,
            error,
          );
          failures = boundCiAutofixEvidence(
            snapshot.failedChecks.map((name) => ({
              name,
              logTail: null,
            })),
          );
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
        const targetWasBusy =
          launch.status === "skipped" && launch.reason === "target_busy";
        nextState[epic.id] = {
          ...nextState[epic.id],
          // A busy target is a transient deferral, not an attempt. Release
          // the pre-dispatch claim so the same SHA is retried on a later
          // poll after the owning agent has finished.
          autofixAttempted: !targetWasBusy,
          autofixSessionId: targetWasBusy ? null : launch.sessionId,
        };
        deps.persistState(routine.id, nextState, nextErrorState);
      }

      processedPullRequests += 1;
    } catch (error) {
      failedPullRequestNumbers.push(epic.prNumber);
      const signature = ciWatchErrorSignature(error);
      if (previousErrorState[epic.id] !== signature) newProcessingErrors += 1;
      nextErrorState[epic.id] = signature;
      console.error(
        `[ci-watch] Failed to process PR #${epic.prNumber}; continuing the sweep`,
        error,
      );
    }
  }

  for (const epicId of Object.keys(nextState)) {
    if (!eligibleEpicIds.has(epicId)) delete nextState[epicId];
  }
  for (const scope of Object.keys(nextErrorState)) {
    if (scope !== PROJECT_ERROR_SCOPE && !eligibleEpicIds.has(scope)) {
      delete nextErrorState[scope];
    }
  }
  deps.persistState(routine.id, nextState, nextErrorState);

  return {
    status: failedPullRequestNumbers.length > 0 ? "failed" : "completed",
    message: `Checked ${processedPullRequests} of ${openPullRequests.length} open pull request${
      openPullRequests.length === 1 ? "" : "s"
    }; ${failingPullRequests} failing, ${newFailures} newly reported${
      autofixesLaunched + autofixesSkipped > 0
        ? `; ${autofixesLaunched} autofix launched, ${autofixesSkipped} skipped`
        : ""
    }${
      reconciledPullRequests > 0
        ? `; ${reconciledPullRequests} closed or merged and no longer watched`
        : ""
    }${
      failedPullRequestNumbers.length > 0
        ? `; ${failedPullRequestNumbers.length} could not be processed (PR ${failedPullRequestNumbers.map((prNumber) => `#${prNumber}`).join(", ")})`
        : ""
    }.`,
    targetUrl: `/projects/${routine.projectId}`,
    shouldNotify:
      newFailures > 0 || autofixesLaunched > 0 || newProcessingErrors > 0,
  };
}
