import { NextRequest, NextResponse } from "next/server";
import { validateGitHubToken } from "@/lib/github/client";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const token =
    body && typeof body === "object" && "token" in body
      ? String((body as { token?: unknown }).token ?? "")
      : "";

  if (!token.trim()) {
    return NextResponse.json(
      {
        data: { valid: false },
        error: "Enter a GitHub personal access token to validate.",
      },
      { status: 400 }
    );
  }

  const result = await validateGitHubToken(token);
  if (!result.valid) {
    return NextResponse.json(
      {
        data: { valid: false },
        error: result.error ?? "GitHub token validation failed.",
      },
      { status: 401 }
    );
  }

  return NextResponse.json({
    data: { valid: true, login: result.login },
  });
}
