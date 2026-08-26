import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import {
  errorResponse,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { resolveMaxConcurrentForProject } from "@/lib/agents/scheduler";
import {
  autoModeBuildAgentSettingKey,
  autoModeBuildConcurrencySettingKey,
  autoModeEnabledSettingKey,
  autoModeReviewAgentSettingKey,
  autoModeReviewConcurrencySettingKey,
  autoModeSmartDispatchSettingKey,
  fullAutoSecondOpinionSettingKey,
  parseAutoModeAgent,
  parseAutoModeConcurrency,
  parseAutoModeEnabled,
} from "@/lib/auto-mode/constants";
import { resolveAutoModeConfigForProject } from "@/lib/auto-mode/config";
import { autoModeRegistry } from "@/lib/auto-mode/registry";
import { kickAutoMode } from "@/lib/auto-mode/engine";
import {
  loadAutoModeBoard,
  selectBuildCandidates,
  selectMergeCandidates,
  selectReviewCandidates,
} from "@/lib/auto-mode/select";
import type { AutoModeStatus } from "@/lib/auto-mode/status";

/**
 * GET/PUT /api/projects/[projectId]/auto-mode
 *
 * The dialog's whole contract: the seven persisted settings, the scheduler
 * budget they have to live inside, and a live picture of what the supervisor
 * is doing (in-flight counts, candidate counts, parked tickets, recent
 * dispatches).
 *
 * PUT writes the settings and kicks an immediate sweep — enabling the mode
 * must not feel like it did nothing for up to 15 seconds.
 */

/** Builds the response payload shared by GET and PUT. */
function buildStatus(projectId: string): AutoModeStatus {
  const config = resolveAutoModeConfigForProject(projectId);
  const snapshot = autoModeRegistry.snapshot(projectId);

  // Candidate counts are informational; a broken board read must not 500 the
  // dialog, so they degrade to zero rather than throw.
  let candidates = { build: 0, review: 0, merge: 0 };
  try {
    const board = loadAutoModeBoard(projectId);
    candidates = {
      build: selectBuildCandidates(projectId, board).length,
      review: selectReviewCandidates(projectId, board).length,
      merge: selectMergeCandidates(projectId, board).length,
    };
  } catch (error) {
    console.warn(
      "[auto-mode/route] Failed to count candidates:",
      error instanceof Error ? error.message : error
    );
  }

  return {
    enabled: config.enabled,
    buildAgent: config.buildAgent,
    buildConcurrency: config.buildConcurrency,
    reviewAgent: config.reviewAgent,
    reviewConcurrency: config.reviewConcurrency,
    smartDispatch: config.smartDispatch,
    secondOpinion: config.secondOpinion,
    effectiveSchedulerBudget: (() => {
      // Unlimited is Infinity in-process, which JSON would silently turn
      // into null anyway — send the null contract explicitly.
      const budget = resolveMaxConcurrentForProject(projectId);
      return Number.isFinite(budget) ? budget : null;
    })(),
    running: snapshot.enabled,
    lastSweepAt: snapshot.lastSweepAt,
    inFlight: snapshot.inFlight,
    candidates,
    parked: snapshot.parked,
    recentDispatches: snapshot.recentDispatches,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  try {
    return NextResponse.json({ data: buildStatus(projectId) });
  } catch (error) {
    return errorResponse(error, "Failed to read auto mode status");
  }
}

/** Upserts one settings row, JSON-encoded exactly like PATCH /api/settings. */
function putSetting(key: string, value: unknown): void {
  const jsonValue = JSON.stringify(value);
  const now = new Date().toISOString();
  const existing = db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, key))
    .get();

  if (existing) {
    db.update(settings)
      .set({ value: jsonValue, updatedAt: now })
      .where(eq(settings.key, key))
      .run();
  } else {
    db.insert(settings).values({ key, value: jsonValue, updatedAt: now }).run();
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Invalid payload. Send a JSON object of auto mode settings." },
      { status: 400 }
    );
  }

  const payload = body as Record<string, unknown>;

  // Every field is optional so the dialog can toggle the switch without
  // resending the whole form. Values go through the same parsers the resolver
  // uses, so a clamp applies at write time as well as read time.
  //
  // The whole payload is validated into `writes` BEFORE anything is
  // persisted. Validating as we went would let `{enabled: true,
  // buildConcurrency: "lots"}` arm the mode and then return 400 — the caller
  // would believe nothing happened while a supervisor started dispatching.
  const writes: Array<[string, unknown]> = [];

  if ("enabled" in payload) {
    const enabled = parseAutoModeEnabled(payload.enabled);
    if (enabled === null) {
      return NextResponse.json(
        { error: "`enabled` must be a boolean." },
        { status: 400 }
      );
    }
    writes.push([autoModeEnabledSettingKey(projectId), enabled]);
  }

  if ("buildAgent" in payload) {
    writes.push([
      autoModeBuildAgentSettingKey(projectId),
      parseAutoModeAgent(payload.buildAgent),
    ]);
  }
  if ("reviewAgent" in payload) {
    writes.push([
      autoModeReviewAgentSettingKey(projectId),
      parseAutoModeAgent(payload.reviewAgent),
    ]);
  }

  if ("buildConcurrency" in payload) {
    const value = parseAutoModeConcurrency(payload.buildConcurrency);
    if (value === null) {
      return NextResponse.json(
        { error: "`buildConcurrency` must be an integer between 0 and 10." },
        { status: 400 }
      );
    }
    writes.push([autoModeBuildConcurrencySettingKey(projectId), value]);
  }

  if ("reviewConcurrency" in payload) {
    const value = parseAutoModeConcurrency(payload.reviewConcurrency);
    if (value === null) {
      return NextResponse.json(
        { error: "`reviewConcurrency` must be an integer between 0 and 10." },
        { status: 400 }
      );
    }
    writes.push([autoModeReviewConcurrencySettingKey(projectId), value]);
  }

  if ("smartDispatch" in payload) {
    const smartDispatch = parseAutoModeEnabled(payload.smartDispatch);
    if (smartDispatch === null) {
      return NextResponse.json(
        { error: "`smartDispatch` must be a boolean." },
        { status: 400 }
      );
    }
    writes.push([autoModeSmartDispatchSettingKey(projectId), smartDispatch]);
  }

  if ("secondOpinion" in payload) {
    const secondOpinion = parseAutoModeEnabled(payload.secondOpinion);
    if (secondOpinion === null) {
      return NextResponse.json(
        { error: "`secondOpinion` must be a boolean." },
        { status: 400 }
      );
    }
    writes.push([
      fullAutoSecondOpinionSettingKey(projectId),
      secondOpinion,
    ]);
  }

  try {
    // All-or-nothing: a half-applied configuration is how an unattended mode
    // ends up running with settings nobody chose.
    db.transaction(() => {
      for (const [key, value] of writes) putSetting(key, value);
    });

    // Mirror the persisted flag into the registry BEFORE building the
    // response, so the runtime fields the dialog reads back (`running`, and
    // the in-flight counts a disable clears) describe the state the caller
    // just asked for rather than the one the sweep has not caught up with.
    const config = resolveAutoModeConfigForProject(projectId);
    autoModeRegistry.setEnabled(projectId, config.enabled);

    const status = buildStatus(projectId);

    // Enabling (or retuning) takes effect now, not on the next 15s tick.
    // Disabling also sweeps: that pass is what settles the registry state.
    kickAutoMode(projectId);

    return NextResponse.json({ data: status });
  } catch (error) {
    return errorResponse(error, "Failed to update auto mode settings");
  }
}
