/**
 * POST /api/mcp/report-friction — the mcp__arij__report_friction tool.
 *
 * The bearer token is the sole source of project, session, and epic scope.
 * The payload cannot name any of them. Reporting is intentionally isolated
 * from the board: this route writes only `frictions` rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { frictions } from "@/lib/db/schema";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import { createId } from "@/lib/utils/nanoid";
import {
  FRICTION_CATEGORIES,
  OPEN_FRICTION_STATUSES,
} from "@/lib/frictions/constants";

const bodySchema = z
  .object({
    category: z.enum(FRICTION_CATEGORIES),
    description: z.string().trim().min(1).max(4000),
    filePath: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

async function parseBody(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid report_friction payload: the request body must be valid JSON.",
        code: "INVALID_PAYLOAD",
      },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (parsed.success) return { data: parsed.data };

  const details = parsed.error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "payload";
      return `${field}: ${issue.message}`;
    })
    .join("; ");

  return NextResponse.json(
    {
      error: `Invalid report_friction payload — ${details}`,
      code: "INVALID_PAYLOAD",
    },
    { status: 400 }
  );
}

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  // CLI chat tokens name a synthetic turn rather than a durable agent
  // session. report_friction belongs to the agent toolset only.
  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error: "report_friction is only available to agent sessions.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const validated = await parseBody(request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  try {
    const result = db.transaction((tx) => {
      // Without a path, category alone is too broad a key: unrelated reports
      // would collapse onto the oldest row and the newer descriptions would
      // be lost. Path-less reports therefore remain distinct.
      const existing = body.filePath
        ? tx
            .select({
              id: frictions.id,
              occurrences: frictions.occurrences,
            })
            .from(frictions)
            .where(
              and(
                eq(frictions.projectId, auth.projectId),
                eq(frictions.category, body.category),
                eq(frictions.filePath, body.filePath),
                inArray(frictions.status, [...OPEN_FRICTION_STATUSES])
              )
            )
            .orderBy(asc(frictions.createdAt), asc(frictions.id))
            .get()
        : undefined;

      if (existing) {
        const occurrences = existing.occurrences + 1;
        tx.update(frictions)
          .set({ occurrences: sql`${frictions.occurrences} + 1` })
          .where(eq(frictions.id, existing.id))
          .run();
        return {
          frictionId: existing.id,
          occurrences,
          deduplicated: true,
        };
      }

      const frictionId = createId();
      tx.insert(frictions)
        .values({
          id: frictionId,
          projectId: auth.projectId,
          epicId: auth.epicId,
          agentSessionId: auth.sessionId,
          category: body.category,
          description: body.description,
          filePath: body.filePath ?? null,
          occurrences: 1,
          status: "new",
          createdAt: new Date().toISOString(),
        })
        .run();

      return { frictionId, occurrences: 1, deduplicated: false };
    });

    return NextResponse.json({ data: result });
  } catch (error) {
    console.error("[report-friction] Failed to persist friction", error);
    return NextResponse.json(
      {
        error:
          "Arij could not record this friction. The board was not changed; continue the task and report the tool failure in your final result.",
        code: "FRICTION_WRITE_FAILED",
      },
      { status: 500 }
    );
  }
}
