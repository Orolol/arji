import { NextResponse } from "next/server";
import { getProvider, type ProviderType } from "@/lib/providers";

const ALL_PROVIDERS: ProviderType[] = ["claude-code", "codex", "oh-my-pi"];

export async function GET() {
  const results: Record<string, boolean> = {};

  // Check all providers in parallel
  const checks = await Promise.all(
    ALL_PROVIDERS.map(async (type) => {
      const provider = getProvider(type);
      try {
        const available = await provider.isAvailable();
        return { type, available };
      } catch {
        return { type, available: false };
      }
    }),
  );

  for (const { type, available } of checks) {
    results[type] = available;
  }

  return NextResponse.json({ data: results });
}
