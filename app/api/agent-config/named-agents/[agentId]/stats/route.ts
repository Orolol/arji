import { NextRequest, NextResponse } from "next/server";
import {
  getAgentDayStats,
  getNamedAgentStats,
} from "@/lib/agent-config/agent-stats";
import { getNamedAgent } from "@/lib/agent-config/named-agents";

/**
 * GET /api/agent-config/named-agents/{agentId}/stats
 *
 * The 14-day payload behind the /agents workshop's THE NUMBERS band.
 *
 * THE `all` SENTINEL. The same file also serves the roster's today-window
 * aggregate at `/api/agent-config/named-agents/all/stats`, returning
 * `{ data: { agents: AgentDayStats[] } }` — one row per named agent from a
 * single query. It lives here rather than under
 * /api/agent-config/named-agents/stats because that path would collide with
 * the `[agentId]` segment, and rather than in the existing
 * /api/agent-config/stats route because that route is pinned by tests and
 * serves a different pair of aggregates. `all` is not a valid nanoid, so no
 * real agent id can shadow it.
 *
 * Errors are built inline rather than through lib/api/route-helpers, matching
 * the neighbouring agent-config routes: they deliberately avoid pulling
 * lib/db in through the helper module.
 */

const ROSTER_SENTINEL = "all";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { agentId } = await params;

  try {
    if (agentId === ROSTER_SENTINEL) {
      return NextResponse.json({ data: { agents: getAgentDayStats() } });
    }

    const agent = await getNamedAgent(agentId);
    if (!agent) {
      return NextResponse.json(
        { error: "Named agent not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: getNamedAgentStats(agentId) });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load agent stats",
      },
      { status: 500 },
    );
  }
}
