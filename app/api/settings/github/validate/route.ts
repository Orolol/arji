import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { validateToken } from "@/lib/github/client";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { token } = body as { token?: string };

  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "missing_token", message: "A GitHub token is required." },
      { status: 400 }
    );
  }

  const result = await validateToken(token);

  if (!result.valid) {
    return NextResponse.json(
      { error: "invalid_token", message: "The provided GitHub token is invalid." },
      { status: 400 }
    );
  }

  // Save the validated token
  const now = new Date().toISOString();
  const jsonValue = JSON.stringify(token);
  const existing = db
    .select()
    .from(settings)
    .where(eq(settings.key, "github_pat"))
    .get();

  if (existing) {
    db.update(settings)
      .set({ value: jsonValue, updatedAt: now })
      .where(eq(settings.key, "github_pat"))
      .run();
  } else {
    db.insert(settings)
      .values({ key: "github_pat", value: jsonValue, updatedAt: now })
      .run();
  }

  return NextResponse.json({
    data: { valid: true, login: result.login },
  });
}
