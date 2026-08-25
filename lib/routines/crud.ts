import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { routines, type Routine } from "@/lib/db/schema";
import {
  isAvailableRoutineKind,
  type AvailableRoutineKind,
} from "@/lib/routines/constants";
import { createId } from "@/lib/utils/nanoid";

const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INTERNAL_CONFIG_KEYS = new Set(["ciWatchState"]);

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
    Object.entries(parsed).filter(([key]) => !INTERNAL_CONFIG_KEYS.has(key))
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

function assertConfigObject(value: unknown): asserts value is Record<string, unknown> {
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
  key: string
): void {
  const value = config[key];
  if (
    value !== undefined &&
    (!Number.isInteger(value) || (value as number) < 1)
  ) {
    throw new RoutineInputError(
      `\`config.${key}\` must be a positive integer.`
    );
  }
}

function validateConfig(
  kind: AvailableRoutineKind,
  config: Record<string, unknown>
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
        "`config.failurePolicy` must be `halt` or `stop`."
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
        "`config.circuitBreaker` must be an integer between 0 and 10."
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
        "`config.costCapUsd` must be a positive number."
      );
    }
    const namedAgentId = config.namedAgentId;
    if (
      namedAgentId !== undefined &&
      namedAgentId !== null &&
      typeof namedAgentId !== "string"
    ) {
      throw new RoutineInputError(
        "`config.namedAgentId` must be a string or null."
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
  preserveInternal = false
): string {
  const internal = Object.fromEntries(
    Object.entries(
      preserveInternal && previous ? parseStoredConfig(previous) : {}
    ).filter(([key]) => INTERNAL_CONFIG_KEYS.has(key))
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
  input: RoutineWriteInput
): RoutineDto {
  validateWrite(input);
  const id = createId();
  db.insert(routines)
    .values({
      id,
      projectId,
      kind: input.kind,
      enabled: input.enabled,
      timeOfDay: input.timeOfDay,
      config: persistedConfig(input.config),
    })
    .run();
  return toDto(findRoutine(projectId, id)) as RoutineDto;
}

export function updateProjectRoutine(
  projectId: string,
  routineId: string,
  patch: RoutinePatchInput
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

  db.update(routines)
    .set({
      kind: next.kind,
      enabled: next.enabled,
      timeOfDay: next.timeOfDay,
      config: persistedConfig(
        next.config,
        current.config,
        next.kind === "ci_watch"
      ),
    })
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
    .run();

  return toDto(findRoutine(projectId, routineId)) as RoutineDto;
}

export function deleteProjectRoutine(
  projectId: string,
  routineId: string
): void {
  findRoutine(projectId, routineId);
  db.delete(routines)
    .where(and(eq(routines.id, routineId), eq(routines.projectId, projectId)))
    .run();
}
