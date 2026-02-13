/**
 * In-memory registry for ephemeral agent activities (chat, spec generation, releases)
 * that are NOT tracked in the DB agent_sessions table.
 *
 * Same module-level singleton pattern as processManager.
 */

export type ActivityType = "chat" | "spec_generation" | "release";

export interface Activity {
  id: string;
  projectId: string | null;
  type: ActivityType;
  label: string;
  provider: "claude-code" | "codex";
  startedAt: string;
  kill?: () => void;
}

class ActivityRegistry {
  private activities: Map<string, Activity> = new Map();

  register(activity: Activity): void {
    this.activities.set(activity.id, activity);
  }

  unregister(id: string): void {
    this.activities.delete(id);
  }

  cancel(id: string): boolean {
    const activity = this.activities.get(id);
    if (!activity) return false;
    activity.kill?.();
    this.activities.delete(id);
    return true;
  }

  listByProject(projectId: string): Activity[] {
    return Array.from(this.activities.values()).filter(
      (a) => a.projectId === projectId,
    );
  }
}

export const activityRegistry = new ActivityRegistry();
