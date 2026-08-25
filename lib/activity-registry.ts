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
  provider: string;
  namedAgentName?: string | null;
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

  /**
   * Cancels an activity only when it belongs to `projectId`.
   *
   * For the project-scoped API routes: an id alone must not be enough to kill
   * a run registered under a different project. A `projectId`-less activity
   * (nothing associates it with a project in the first place) is cancellable
   * from anywhere, which is the only behaviour that leaves it cancellable at
   * all.
   */
  cancelInProject(id: string, projectId: string): boolean {
    const activity = this.activities.get(id);
    if (!activity) return false;
    if (activity.projectId !== null && activity.projectId !== projectId) {
      return false;
    }
    return this.cancel(id);
  }

  listByProject(projectId: string): Activity[] {
    return Array.from(this.activities.values()).filter(
      (a) => a.projectId === projectId,
    );
  }
}

export const activityRegistry = new ActivityRegistry();
