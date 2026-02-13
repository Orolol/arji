import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions, epics, userStories } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { activityRegistry } from "@/lib/activity-registry";

export interface UnifiedActivity {
  id: string;
  type: "build" | "review" | "merge" | "chat" | "spec_generation" | "release";
  label: string;
  provider: string;
  startedAt: string;
  source: "db" | "registry";
  cancellable: boolean;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  // DB sessions with LEFT JOINs for labels
  const rows = db
    .select({
      id: agentSessions.id,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      status: agentSessions.status,
      mode: agentSessions.mode,
      orchestrationMode: agentSessions.orchestrationMode,
      provider: agentSessions.provider,
      startedAt: agentSessions.startedAt,
      epicTitle: epics.title,
      storyTitle: userStories.title,
    })
    .from(agentSessions)
    .leftJoin(epics, eq(agentSessions.epicId, epics.id))
    .leftJoin(userStories, eq(agentSessions.userStoryId, userStories.id))
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, "running")
      )
    )
    .all();

  const dbActivities: UnifiedActivity[] = rows.map((row) => {
    let type: UnifiedActivity["type"];
    let label: string;

    if (row.orchestrationMode === "team") {
      type = "build";
      label = "Team Build";
    } else if (row.mode === "code") {
      type = "build";
      label = row.storyTitle
        ? `Building: ${row.storyTitle}`
        : row.epicTitle
          ? `Building: ${row.epicTitle}`
          : "Building";
    } else {
      // mode === "plan" → review
      type = "review";
      label = row.epicTitle ? `Reviewing: ${row.epicTitle}` : "Reviewing";
    }

    return {
      id: row.id,
      type,
      label,
      provider: row.provider || "claude-code",
      startedAt: row.startedAt || new Date().toISOString(),
      source: "db" as const,
      cancellable: true,
    };
  });

  // Registry activities (chat, spec gen, releases)
  const registryActivities: UnifiedActivity[] = activityRegistry
    .listByProject(projectId)
    .map((a) => ({
      id: a.id,
      type: a.type,
      label: a.label,
      provider: a.provider,
      startedAt: a.startedAt,
      source: "registry" as const,
      cancellable: !!a.kill,
    }));

  return NextResponse.json({ data: [...dbActivities, ...registryActivities] });
}
