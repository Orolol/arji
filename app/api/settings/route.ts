import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { GITHUB_PAT_SETTING_KEY } from "@/lib/github/client";

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

    data[row.key] = parseValue(row.value);
  }

  return NextResponse.json({ data });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Invalid settings payload. Send a JSON object of setting keys." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(body)) {
    if (key === GITHUB_PAT_SETTING_KEY && typeof value !== "string") {
      return NextResponse.json(
        { error: "GitHub token must be saved as a string value." },
        { status: 400 }
      );
    }

    const jsonValue = JSON.stringify(value);
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();

    if (existing) {
      db.update(settings)
        .set({ value: jsonValue, updatedAt: now })
        .where(eq(settings.key, key))
        .run();
    } else {
      db.insert(settings)
        .values({ key, value: jsonValue, updatedAt: now })
        .run();
    }
  }

  return NextResponse.json({ data: { updated: true } });
}
