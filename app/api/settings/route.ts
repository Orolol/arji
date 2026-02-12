import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Redacts a GitHub PAT, keeping only the prefix and last 4 characters.
 */
function redactPat(pat: string): string {
  if (pat.length <= 8) return "****";
  const prefix = pat.slice(0, 4);
  const suffix = pat.slice(-4);
  return `${prefix}${"*".repeat(Math.min(pat.length - 8, 20))}${suffix}`;
}

export async function GET() {
  const rows = db.select().from(settings).all();
  const data: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      data[row.key] = JSON.parse(row.value);
    } catch {
      data[row.key] = row.value;
    }
  }

  // Redact GitHub PAT if present
  if (data.github_pat && typeof data.github_pat === "string") {
    data.github_pat = redactPat(data.github_pat);
  }

  return NextResponse.json({ data });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const now = new Date().toISOString();

  for (const [key, value] of Object.entries(body)) {
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
