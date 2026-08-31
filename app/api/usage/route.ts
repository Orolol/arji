import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/route-helpers";
import { refreshCodexUsageSnapshot } from "@/lib/usage/codex-snapshot";
import { getUsageReport, parseUsageRange } from "@/lib/usage/aggregate";
import {
  getClaudeQuotaCached,
  getCodexQuotaCached,
} from "@/lib/usage/quota-cache";

/**
 * GET /api/usage — one fat response. Two query params:
 *   `?fresh=1`      bypasses the quota cache TTL (the header Refresh button);
 *                   a plain GET respects it.
 *   `?range=7d|all` scopes the additive `dashboard` block (the 8d segmented
 *                   control). Anything unrecognised falls back to "30d", the
 *                   same tolerance the `fresh` check applies. The other eight
 *                   response sections ignore it entirely.
 *
 * The two live pollers run in parallel and NEVER reject — null data means
 * "CLI unavailable / poll failed" and the report falls back to the existing
 * sources (rollout snapshot for codex, metered-via-Arij for claude), so a
 * poller failure is invisible except for the card falling back. Cold-cache
 * latency is bounded by the pollers' own 10s hard timeout; no shorter
 * route-level timeout is layered on top — that would orphan the shared
 * in-flight promise other requests may be joining.
 *
 * The codex rollout refresh stays a refresh-on-read, not a lifecycle hook:
 * Arij's own session logs never carry `rate_limits`, so the filesystem scan
 * remains the live poll's fallback source. Best-effort, never throws — a
 * missing `~/.codex` tree cannot break the page.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const fresh = params.get("fresh") === "1";
    const range = parseUsageRange(params.get("range"));
    const [claudeLive, codexLive] = await Promise.all([
      getClaudeQuotaCached(fresh), // never rejects; null data = fallback
      getCodexQuotaCached(fresh),
    ]);
    refreshCodexUsageSnapshot(); // best-effort, never throws
    return NextResponse.json({
      data: getUsageReport({ claudeLive, codexLive }, range),
    });
  } catch (error) {
    return errorResponse(error, "Failed to load usage report");
  }
}
