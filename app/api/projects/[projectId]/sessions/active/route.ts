import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions, epics, userStories } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getSessionStatusForApi } from "@/lib/agent-sessions/lifecycle";
import { activityRegistry } from "@/lib/activity-registry";

export interface UnifiedActivity {
  id: string;
  epicId: string | null;
  userStoryId: string | null;
  type: "build" | "review" | "merge" | "chat" | "spec_generation" | "release";
  label: string;
  status: string;
  mode: string;
  provider: string;
  startedAt: string;
  source: "db" | "registry";
  cancellable: boolean;
}

function inferDbActivityType(row: {
  orchestrationMode: string | null;
  mode: string | null;
  prompt: string | null;
}): UnifiedActivity["type"] {
  if (row.orchestrationMode === "team") {
    return "build";
  }

  const prompt = (row.prompt || "").toLowerCase();
  if (
    prompt.includes("merge conflict resolution") ||
    prompt.includes("git merge main")
  ) {
    return "merge";
  }

  if (
    row.mode === "plan" ||
    /you are performing a \*\*.+review/.test(prompt)
  ) {
    return "review";
  }

  return "build";
}

function buildDbActivityLabel(
  type: UnifiedActivity["type"],
  row: { storyTitle: string | null; epicTitle: string | null }
): string {
  if (type === "merge") {
    return row.epicTitle ? `Merging: ${row.epicTitle}` : "Merging";
  }

  if (type === "review") {
    return row.storyTitle
      ? `Reviewing: ${row.storyTitle}`
      : row.epicTitle
        ? `Reviewing: ${row.epicTitle}`
        : "Reviewing";
  }

  return row.storyTitle
    ? `Building: ${row.storyTitle}`
    : row.epicTitle
      ? `Building: ${row.epicTitle}`
      : "Building";
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
      prompt: agentSessions.prompt,
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
    const type = inferDbActivityType(row);
    const label =
      row.orchestrationMode === "team"
        ? "Team Build"
        : buildDbActivityLabel(type, row);

    return {
      id: row.id,
      epicId: row.epicId ?? null,
      userStoryId: row.userStoryId ?? null,
      type,
      label,
      status: getSessionStatusForApi(row.status),
      mode: row.mode || "code",
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
      epicId: null,
      userStoryId: null,
      type: a.type,
      label: a.label,
      status: "running",
      mode: "plan",
      provider: a.provider,
      startedAt: a.startedAt,
      source: "registry" as const,
      cancellable: !!a.kill,
    }));

  return NextResponse.json({ data: [...dbActivities, ...registryActivities] });
}
