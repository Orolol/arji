import { NextResponse } from "next/server";
import { getProvider } from "@/lib/providers";
import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";

export async function GET() {
  const results: Record<string, boolean> = {};

  // Probe every registered provider. Derived from PROVIDER_OPTIONS rather
  // than restated here: a private copy of the list does not fail when it
  // drifts, it just stops probing the provider it never heard about, and the
  // workshop's "CLI detected" indicator goes quietly blank for it.
  const checks = await Promise.all(
    PROVIDER_OPTIONS.map(async (type) => {
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
