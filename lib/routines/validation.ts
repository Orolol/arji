import { z } from "zod";
import { AVAILABLE_ROUTINE_KINDS } from "@/lib/routines/constants";

const routineFields = z.object({
  kind: z.enum(AVAILABLE_ROUTINE_KINDS),
  enabled: z.boolean(),
  timeOfDay: z.string(),
  config: z.record(z.string(), z.unknown()),
});

export const createRoutineSchema = routineFields
  .extend({
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const updateRoutineSchema = routineFields
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one routine field is required.",
  });

export const updateCiAutofixSchema = z
  .object({ enabled: z.boolean() })
  .strict();
