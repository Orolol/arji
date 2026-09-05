import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { GITHUB_PAT_SETTING_KEY } from "@/lib/github/client";
import {
  GITHUB_OAUTH_META_SETTING_KEY,
  githubOAuthMetaSettingSchema,
} from "@/lib/github/oauth-meta";
import { OPENAI_API_KEY_SETTING_KEY } from "@/lib/openai/constants";
import { PROJECTS_ROOT_SETTING_KEY } from "@/lib/projects/workspace-constants";
import { defaultProjectsRoot } from "@/lib/projects/workspace";

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function GET() {
  const rows = db.select().from(settings).all();
  const data: Record<string, unknown> = {};

  for (const row of rows) {
    if (row.key === GITHUB_PAT_SETTING_KEY) {
      const parsed = parseValue(row.value);
      const token =
        typeof parsed === "string"
          ? parsed.trim()
          : parsed &&
              typeof parsed === "object" &&
              "token" in (parsed as Record<string, unknown>) &&
              typeof (parsed as Record<string, unknown>).token === "string"
            ? ((parsed as Record<string, unknown>).token as string).trim()
            : "";
      data[row.key] = { hasToken: token.length > 0 };
      continue;
    }

    if (row.key === OPENAI_API_KEY_SETTING_KEY) {
      const parsed = parseValue(row.value);
      data[row.key] = { hasToken: typeof parsed === "string" && parsed.trim().length > 0 };
      continue;
    }

    // Webhook URLs are capability credentials (Slack/Discord incoming
    // webhooks grant post access) — mask them like the PAT; the dedicated
    // /api/settings/webhooks route serves the editing UI.
    if (row.key.startsWith("webhook_url:")) {
      const parsed = parseValue(row.value);
      data[row.key] = {
        hasUrl: typeof parsed === "string" && parsed.trim().length > 0,
      };
      continue;
    }

    data[row.key] = parseValue(row.value);
  }

  // Server-computed fallbacks the client cannot derive (no process.cwd() in
  // the browser). Kept out of `data` so a round-trip never writes them back
  // as if they were stored settings.
  return NextResponse.json({
    data,
    defaults: { [PROJECTS_ROOT_SETTING_KEY]: defaultProjectsRoot() },
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Invalid settings payload. Send a JSON object of setting keys." },
      { status: 400 }
    );
  }

  const entries = Object.entries(body);

  // Validate everything before writing anything, so a rejected key never
  // leaves a partially-applied payload behind.
  for (const [key, value] of entries) {
    if (key === GITHUB_PAT_SETTING_KEY && typeof value !== "string") {
      return NextResponse.json(
        { error: "GitHub token must be saved as a string value." },
        { status: 400 }
      );
    }

    if (key === OPENAI_API_KEY_SETTING_KEY && typeof value !== "string") {
      return NextResponse.json(
        { error: "OpenAI API key must be saved as a string value." },
        { status: 400 }
      );
    }

    // Written by the device-flow poll route, and editable here so a user who
    // replaces an OAuth connection with a hand-pasted PAT can clear the stale
    // "connected as @someone" with `null`. Typed because the Settings UI reads
    // the fields straight out of it — an arbitrary blob stored under this key
    // would surface as a broken connection card, not as a validation error.
    if (key === GITHUB_OAUTH_META_SETTING_KEY) {
      const parsed = githubOAuthMetaSettingSchema.safeParse(value);
      if (!parsed.success) {
        return NextResponse.json(
          {
            error:
              "GitHub connection metadata must be null, or an object with login, scopes, obtainedAt and tokenSource.",
            details: parsed.error.flatten().fieldErrors,
          },
          { status: 400 }
        );
      }
    }

    // A non-string root would resolve to garbage in path.resolve() and send
    // clones somewhere unexpected. Blank IS valid: it clears the override.
    if (key === PROJECTS_ROOT_SETTING_KEY && typeof value !== "string") {
      return NextResponse.json(
        { error: "Projects directory must be saved as a string value." },
        { status: 400 }
      );
    }
  }

  const now = new Date().toISOString();

  db.transaction((tx) => {
    for (const [key, value] of entries) {
      const jsonValue = JSON.stringify(value);
      const existing = tx
        .select()
        .from(settings)
        .where(eq(settings.key, key))
        .get();

      if (existing) {
        tx.update(settings)
          .set({ value: jsonValue, updatedAt: now })
          .where(eq(settings.key, key))
          .run();
      } else {
        tx.insert(settings)
          .values({ key, value: jsonValue, updatedAt: now })
          .run();
      }
    }
  });

  return NextResponse.json({ data: { updated: true } });
}
