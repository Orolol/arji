import { NextResponse } from "next/server";
import { getNamedAgentDispatchReliability } from "@/lib/agent-config/stats";
import {
  DISPATCH_RELIABILITY_MIN_SAMPLE,
  DISPATCH_RELIABILITY_WINDOW_DAYS,
} from "@/lib/agent-config/dispatch-reliability-constants";

/**
 * GET /api/agent-config/dispatch-stats
 *
 * The reliability badge shown next to every named agent in the dispatch
 * pickers: success rate and median duration per (named agent × dispatch role)
 * over the trailing 30 days, plus the threshold under which the picker must
 * render an em-dash instead of a number.
 *
 * Every role comes back in ONE response computed by ONE query, because a
 * single page can hold several pickers (build + review in the auto-mode
 * dialog) and a picker holds a row per agent — neither may turn into a query
 * per agent.
 *
 * Deliberately global (no projectId param): per-project samples rarely clear
 * the 5-run threshold, and the badge must agree with the Full Auto argmax in
 * lib/agent-config/smart-dispatch.ts, which reads the same unscoped numbers.
 */
export async function GET() {
  try {
    return NextResponse.json({
      data: {
        windowDays: DISPATCH_RELIABILITY_WINDOW_DAYS,
        minSample: DISPATCH_RELIABILITY_MIN_SAMPLE,
        rows: getNamedAgentDispatchReliability(),
      },
    });
  } catch (error) {
    // Inline (not errorResponse) to match the other agent-config routes.
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load dispatch stats",
      },
      { status: 500 },
    );
  }
}
