import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildImportPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgent } from "@/lib/agent-config/agent-resolution";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { getProvider } from "@/lib/providers";
import { arjiJsonExists, readArjiJson } from "@/lib/sync/arji-json";
import { importProjectSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { validatePath } from "@/lib/validation/path";
import { createId } from "@/lib/utils/nanoid";

const ARJI_JSON = "arji.json";

export async function POST(request: NextRequest) {
  const validated = await validateBody(importProjectSchema, request);
  if (isValidationError(validated)) return validated;

  const { path: inputPath } = validated.data;

  // Validate the path is a real directory and safe
  const pathResult = await validatePath(inputPath);
  if (!pathResult.valid) {
    return NextResponse.json(
      { error: pathResult.error },
      { status: 400 }
    );
  }
  const safePath = pathResult.normalizedPath;

  // Check if arji.json already exists — skip agent analysis if so
  try {
    if (await arjiJsonExists(safePath)) {
      const existing = await readArjiJson(safePath);
      if (existing && existing.project && Array.isArray(existing.epics)) {
        return NextResponse.json({
          data: { preview: existing, path: safePath, fromExistingFile: true },
        });
      }
    }
  } catch (e) {
    // Invalid arji.json — fall through to configured agent analysis
    console.warn("[import] Existing arji.json is invalid, running agent analysis:", e);
  }

  const settingsRow = db.select().from(settings).where(eq(settings.key, "global_prompt")).get();
  const globalPrompt = settingsRow ? JSON.parse(settingsRow.value) : "";

  const importRolePrompt = await resolveAgentPrompt("import_analysis");
  const importSystemPrompt = [globalPrompt, importRolePrompt]
    .filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    .join("\n\n");
  const prompt = buildImportPrompt(importSystemPrompt);
  // Import happens before a project row exists, so only the global mapping
  // can apply here. The resolver's builtin fallback preserves the historical
  // Claude CLI/default-model behavior when no lightweight agent is assigned.
  const resolvedAgent = resolveAgent("import_analysis");

  try {
    console.log("[import] Spawning analysis agent with cwd:", safePath);
    console.log("[import] Prompt length:", prompt.length);

    const sessionId = `import-${createId()}`;
    const session = getProvider(resolvedAgent.provider).spawn({
      sessionId,
      mode: "analyze",
      prompt,
      cwd: safePath,
      model: resolvedAgent.model,
      logIdentifier: sessionId,
    });

    const result = await session.promise;

    console.log("[import] Analysis agent result:", {
      provider: resolvedAgent.provider,
      success: result.success,
      duration: result.duration,
      error: result.error,
      resultLength: result.result?.length ?? 0,
    });

    if (!result.success) {
      return NextResponse.json({
        error: result.error || "Repository analysis failed",
        debug: {
          duration: result.duration,
          rawOutput: result.result?.slice(0, 2000),
        },
      }, { status: 500 });
    }

    // Read the arji.json file that the analysis agent wrote to disk
    const arjiPath = join(safePath, ARJI_JSON);
    let rawJson: string;

    try {
      rawJson = await readFile(arjiPath, "utf-8");
    } catch {
      return NextResponse.json(
        {
          error: `The analysis agent finished but did not write ${ARJI_JSON}. The analysis file was not found at: ${arjiPath}`,
          debug: {
            duration: result.duration,
            rawOutput: result.result?.slice(0, 2000),
          },
        },
        { status: 500 }
      );
    }

    let importData: Record<string, unknown>;

    try {
      importData = JSON.parse(rawJson);
    } catch {
      return NextResponse.json(
        {
          error: `${ARJI_JSON} exists but contains invalid JSON.`,
          debug: {
            duration: result.duration,
            rawPreview: rawJson.slice(0, 2000),
          },
        },
        { status: 500 }
      );
    }

    if (!importData.project || !importData.epics) {
      return NextResponse.json(
        {
          error: `${ARJI_JSON} is missing required "project" or "epics" keys.`,
          debug: {
            duration: result.duration,
            keys: Object.keys(importData),
          },
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: { preview: importData, path: safePath } });
  } catch (e) {
    console.error("[import] Unexpected error:", e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Unknown error",
        debug: { stack: e instanceof Error ? e.stack : undefined },
      },
      { status: 500 }
    );
  }
}
