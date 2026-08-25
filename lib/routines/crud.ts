import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { routines, type Routine } from "@/lib/db/schema";
import {
  isDailyRoutineKind,
  isAvailableRoutineKind,
  isSameLocalDay,
  type AvailableRoutineKind,
  TIME_OF_DAY_PATTERN,
} from "@/lib/routines/constants";
import { createId } from "@/lib/utils/nanoid";

const INTERNAL_CONFIG_KEYS = new Set(["ciWatchState", "ciWatchErrorState"]);

export interface RoutineDto {
  id: string;
  projectId: string;
  kind: AvailableRoutineKind;
  enabled: boolean;
  timeOfDay: string;
  config: Record<string, unknown>;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export interface RoutineWriteInput {
  kind: AvailableRoutineKind;
  enabled: boolean;
  timeOfDay: string;
  config: Record<string, unknown>;
}

export type RoutinePatchInput = Partial<RoutineWriteInput>;

export class RoutineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineInputError";
  }
}

export class RoutineNotFoundError extends Error {
  constructor() {
    super("Routine not found");
    this.name = "RoutineNotFoundError";
  }
}

export class RoutineConflictError extends Error {
  constructor(kind: AvailableRoutineKind) {
    super(`A ${kind} routine already exists for this project.`);
    this.name = "RoutineConflictError";
  }
}

function parseStoredConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function publicConfig(config: string): Record<string, unknown> {
  const parsed = parseStoredConfig(config);
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !INTERNAL_CONFIG_KEYS.has(key)),
  );
}

function toDto(row: Routine): RoutineDto | null {
  // Legacy/unavailable rows stay durable for the future, but the current API
  // does not advertise them to the UI as runnable configuration.
  if (!isAvailableRoutineKind(row.kind)) return null;
  return {
    ...row,
    kind: row.kind,
    config: publicConfig(row.config),
  };
}

function assertConfigObject(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutineInputError("`config` must be a JSON object.");
  }
  for (const key of INTERNAL_CONFIG_KEYS) {
    if (key in value) {
      throw new RoutineInputError(`\`config.${key}\` is managed by Arij.`);
    }
  }
}

function optionalBoolean(config: Record<string, unknown>, key: string): void {
  if (config[key] !== undefined && typeof config[key] !== "boolean") {
    throw new RoutineInputError(`\`config.${key}\` must be a boolean.`);
  }
}

function optionalPositiveInteger(
  config: Record<string, unknown>,
  key: string,
): void {
  const value = config[key];
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 1)
  ) {
    throw new RoutineInputError(
      `\`config.${key}\` must be a positive integer.`,
    );
  }
}

function validateConfig(
  kind: AvailableRoutineKind,
  config: Record<string, unknown>,
): void {
  assertConfigObject(config);

  if (kind === "night_run") {
    optionalBoolean(config, "includeBacklog");
    const failurePolicy = config.failurePolicy;
    if (
      failurePolicy !== undefined &&
      failurePolicy !== "halt" &&
      failurePolicy !== "stop"
    ) {
      throw new RoutineInputError(
        "`config.failurePolicy` must be `halt` or `stop`.",
      );
    }
    const circuitBreaker = config.circuitBreaker;
    if (
      circuitBreaker !== undefined &&
      (!Number.isInteger(circuitBreaker) ||
        (circuitBreaker as number) < 0 ||
        (circuitBreaker as number) > 10)
    ) {
      throw new RoutineInputError(
        "`config.circuitBreaker` must be an integer between 0 and 10.",
      );
    }
    const costCapUsd = config.costCapUsd;
    if (
      costCapUsd !== undefined &&
      (typeof costCapUsd !== "number" ||
        !Number.isFinite(costCapUsd) ||
        costCapUsd <= 0)
    ) {
      throw new RoutineInputError(
        "`config.costCapUsd` must be a positive number.",
      );
    }
    const namedAgentId = config.namedAgentId;
    if (
      namedAgentId !== undefined &&
      namedAgentId !== null &&
      typeof namedAgentId !== "string"
    ) {
      throw new RoutineInputError(
        "`config.namedAgentId` must be a string or null.",
      );
    }
    return;
  }

  optionalPositiveInteger(config, "intervalMinutes");
}

function validateWrite(input: RoutineWriteInput): void {
  if (!isAvailableRoutineKind(input.kind)) {
    throw new RoutineInputError("This routine kind is not available.");
  }
  if (typeof input.enabled !== "boolean") {
    throw new RoutineInputError("`enabled` must be a boolean.");
  }
  if (!TIME_OF_DAY_PATTERN.test(input.timeOfDay)) {
    throw new RoutineInputError("`timeOfDay` must use the HH:MM format.");
  }
  validateConfig(input.kind, input.config);
}

function persistedConfig(
  next: Record<string, unknown>,
  previous?: string,
  preserveInternal = false,
): string {
  const internal = Object.fromEntries(
    Object.entries(
      preserveInternal && previous ? parseStoredConfig(previous) : {},
    ).filter(([key]) => INTERNAL_CONFIG_KEYS.has(key)),
  );
  return JSON.stringify({ ...next, ...internal });
}

function findRoutine(projectId: string, routineId: string): Routine {
  const row = db
    .select()
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
    .get();
  if (!row) throw new RoutineNotFoundError();
  return row;
}

function assertUniqueProjectKind(
  projectId: string,
  kind: AvailableRoutineKind,
  currentRoutineId?: string,
): void {
  const existing = db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.projectId, projectId), eq(routines.kind, kind)))
    .get();
  if (existing && existing.id !== currentRoutineId) {
    throw new RoutineConflictError(kind);
  }
}

function missedDailySlot(input: RoutineWriteInput, now: Date): boolean {
  if (!input.enabled || !isDailyRoutineKind(input.kind)) return false;
  const [hours, minutes] = input.timeOfDay.split(":").map(Number);
  return now.getHours() * 60 + now.getMinutes() > hours * 60 + minutes;
}

function seededLastRunAt(
  input: RoutineWriteInput,
  now: Date,
  previous?: Routine,
): string | null {
  const scheduleChanged =
    !previous ||
    previous.kind !== input.kind ||
    previous.timeOfDay !== input.timeOfDay ||
    (!previous.enabled && input.enabled);
  if (!scheduleChanged || !missedDailySlot(input, now)) {
    return previous?.lastRunAt ?? null;
  }

  const previousRun = previous?.lastRunAt ? new Date(previous.lastRunAt) : null;
  if (
    previousRun &&
    !Number.isNaN(previousRun.getTime()) &&
    isSameLocalDay(previousRun, now)
  ) {
    return previous?.lastRunAt ?? null;
  }

  // Claim today's already-missed slot so the minute sweep starts this daily
  // routine tomorrow instead of immediately after creation/reconfiguration.
  return now.toISOString();
}

export function listProjectRoutines(projectId: string): RoutineDto[] {
  return db
    .select()
    .from(routines)
    .where(eq(routines.projectId, projectId))
    .orderBy(asc(routines.kind), asc(routines.id))
    .all()
    .map(toDto)
    .filter((row): row is RoutineDto => row !== null);
}

export function createProjectRoutine(
  projectId: string,
  input: RoutineWriteInput,
): RoutineDto {
  validateWrite(input);
  assertUniqueProjectKind(projectId, input.kind);
  const id = createId();
  const lastRunAt = seededLastRunAt(input, new Date());
  db.insert(routines)
    .values({
      id,
      projectId,
      kind: input.kind,
      enabled: input.enabled,
      timeOfDay: input.timeOfDay,
      config: persistedConfig(input.config),
      lastRunAt,
    })
    .run();
  return toDto(findRoutine(projectId, id)) as RoutineDto;
}

export function updateProjectRoutine(
  projectId: string,
  routineId: string,
  patch: RoutinePatchInput,
): RoutineDto {
  const current = findRoutine(projectId, routineId);
  if (!isAvailableRoutineKind(current.kind)) {
    throw new RoutineInputError("This routine kind is not available.");
  }
  const next: RoutineWriteInput = {
    kind: patch.kind ?? current.kind,
    enabled: patch.enabled ?? current.enabled,
    timeOfDay: patch.timeOfDay ?? current.timeOfDay,
    config: patch.config ?? publicConfig(current.config),
  };
  validateWrite(next);
  assertUniqueProjectKind(projectId, next.kind, routineId);

  db.update(routines)
    .set({
      kind: next.kind,
      enabled: next.enabled,
      timeOfDay: next.timeOfDay,
      config: persistedConfig(
        next.config,
        current.config,
        next.kind === "ci_watch",
      ),
      lastRunAt: seededLastRunAt(next, new Date(), current),
    })
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
    .run();

  return toDto(findRoutine(projectId, routineId)) as RoutineDto;
}

export function deleteProjectRoutine(
  projectId: string,
  routineId: string,
): void {
  findRoutine(projectId, routineId);
  db.delete(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
    .run();
}
