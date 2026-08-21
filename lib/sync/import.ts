import { db } from "@/lib/db";
import { projects, epics, userStories, agentSessions, chatConversations, ticketComments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { readArjiJson } from "./arji-json";
import type { ArjiJsonComment } from "./arji-json";
import Database from "better-sqlite3";
import {
  applyStoryTransition,
  applyTransition,
  type StoryStatus,
} from "@/lib/workflow/transition-service";
import type { KanbanStatus } from "@/lib/types/kanban";
import { emitTicketMoved } from "@/lib/events/emit";

export interface ImportResult {
  epicsUpserted: number;
  epicsRemoved: number;
  storiesUpserted: number;
  storiesRemoved: number;
  commentsUpserted: number;
  /** Guarded status changes that were left unchanged while content synced. */
  statusesSkipped: Array<{
    target: "epic" | "story";
    epicId: string;
    userStoryId?: string;
    fromStatus: string;
    toStatus: string;
    reason: string;
  }>;
}

export async function importArjiJson(projectId: string): Promise<ImportResult> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("Project not found");
  if (!project.gitRepoPath) throw new Error("Project has no gitRepoPath");

  const data = await readArjiJson(project.gitRepoPath);
  if (!data) throw new Error("arji.json not found in repo");

  const now = new Date().toISOString();

  // Update project fields from JSON
  db.update(projects)
    .set({
      name: data.project.name,
      description: data.project.description,
      status: data.project.status,
      spec: data.project.spec,
      updatedAt: now,
    })
    .where(eq(projects.id, projectId))
    .run();

  // Run epic + story sync inside a transaction
  const sqlite = (db as unknown as { $client: Database.Database }).$client;

  let epicsUpserted = 0;
  let epicsRemoved = 0;
  let storiesUpserted = 0;
  let storiesRemoved = 0;
  let commentsUpserted = 0;
  const statusesSkipped: ImportResult["statusesSkipped"] = [];
  const deferredTicketMoves: Array<{
    epicId: string;
    fromStatus: KanbanStatus;
    toStatus: KanbanStatus;
  }> = [];

  const transaction = sqlite.transaction(() => {
    // Get current epic/story IDs for deletion pass
    const currentEpicRows = db
      .select({ id: epics.id, status: epics.status })
      .from(epics)
      .where(eq(epics.projectId, projectId))
      .all();
    const currentEpicIds = new Set(currentEpicRows.map((epic) => epic.id));
    const currentEpicStatus = new Map(
      currentEpicRows.map((epic) => [epic.id, epic.status ?? "backlog"])
    );
    const jsonEpicIds = new Set(data.epics.map((e) => e.id));

    // Upsert epics
    for (const epic of data.epics) {
      const existingEpicStatus = currentEpicStatus.get(epic.id);
      if (existingEpicStatus && existingEpicStatus !== epic.status) {
        const fromStatus = existingEpicStatus as KanbanStatus;
        const toStatus = epic.status as KanbanStatus;
        const result = applyTransition({
          projectId,
          epicId: epic.id,
          fromStatus,
          toStatus,
          actor: "system",
          source: "api",
          reason: "arji.json status import",
          deferEvent: true,
        });
        if (result.valid) {
          deferredTicketMoves.push({ epicId: epic.id, fromStatus, toStatus });
        } else {
          statusesSkipped.push({
            target: "epic",
            epicId: epic.id,
            fromStatus,
            toStatus,
            reason: result.error ?? "Unknown workflow guard failure",
          });
        }
      }
      db.insert(epics)
        .values({
          id: epic.id,
          projectId,
          title: epic.title,
          description: epic.description,
          priority: epic.priority,
          status: epic.status,
          position: epic.position,
          branchName: epic.branchName,
          type: epic.type ?? "feature",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: epics.id,
          set: {
            title: epic.title,
            description: epic.description,
            priority: epic.priority,
            position: epic.position,
            branchName: epic.branchName,
            type: epic.type ?? "feature",
            updatedAt: now,
          },
        })
        .run();
      epicsUpserted++;

      // Sync epic comments
      if (epic.comments) {
        commentsUpserted += upsertComments(epic.comments, { epicId: epic.id });
      }

      // Sync user stories within this epic
      const currentStoryRows = db
        .select({ id: userStories.id, status: userStories.status })
        .from(userStories)
        .where(eq(userStories.epicId, epic.id))
        .all();
      const currentStoryIds = new Set(currentStoryRows.map((story) => story.id));
      const currentStoryStatus = new Map(
        currentStoryRows.map((story) => [story.id, story.status ?? "todo"])
      );
      const jsonStoryIds = new Set(epic.user_stories.map((s) => s.id));

      for (const story of epic.user_stories) {
        const existingStoryStatus = currentStoryStatus.get(story.id);
        if (existingStoryStatus && existingStoryStatus !== story.status) {
          // A refused status is logged by the workflow service and skipped;
          // content reconciliation for this story and the rest of the file
          // continues inside the same transaction.
          const result = applyStoryTransition({
            projectId,
            epicId: epic.id,
            userStoryId: story.id,
            fromStatus: existingStoryStatus as StoryStatus,
            toStatus: story.status as StoryStatus,
            actor: "system",
            source: "api",
            reason: "arji.json story status import",
          });
          if (!result.valid) {
            statusesSkipped.push({
              target: "story",
              epicId: epic.id,
              userStoryId: story.id,
              fromStatus: existingStoryStatus,
              toStatus: story.status,
              reason: result.error ?? "Unknown workflow guard failure",
            });
          }
        }
        db.insert(userStories)
          .values({
            id: story.id,
            epicId: epic.id,
            title: story.title,
            description: story.description,
            acceptanceCriteria: story.acceptance_criteria,
            status: story.status,
            position: story.position,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: userStories.id,
            set: {
              title: story.title,
              description: story.description,
              acceptanceCriteria: story.acceptance_criteria,
              position: story.position,
            },
          })
          .run();
        storiesUpserted++;

        // Sync story comments
        if (story.comments) {
          commentsUpserted += upsertComments(story.comments, { userStoryId: story.id });
        }
      }

      // Delete stories not in JSON
      for (const id of currentStoryIds) {
        if (!jsonStoryIds.has(id)) {
          db.delete(userStories).where(eq(userStories.id, id)).run();
          storiesRemoved++;
        }
      }
    }

    // Delete epics not in JSON
    for (const id of currentEpicIds) {
      if (!jsonEpicIds.has(id)) {
        // Null out FK references that lack ON DELETE CASCADE
        db.update(agentSessions).set({ epicId: null }).where(eq(agentSessions.epicId, id)).run();
        db.update(chatConversations).set({ epicId: null }).where(eq(chatConversations.epicId, id)).run();
        db.delete(epics).where(eq(epics.id, id)).run();
        epicsRemoved++;
      }
    }
  });

  transaction();

  // Status writes and activity entries above are transactional. Emit only
  // after commit so a later import error cannot publish a phantom board move.
  for (const move of deferredTicketMoves) {
    emitTicketMoved(projectId, move.epicId, move.fromStatus, move.toStatus);
  }

  return {
    epicsUpserted,
    epicsRemoved,
    storiesUpserted,
    storiesRemoved,
    commentsUpserted,
    statusesSkipped,
  };
}

function upsertComments(
  comments: ArjiJsonComment[],
  parent: { epicId?: string; userStoryId?: string },
): number {
  let count = 0;
  for (const comment of comments) {
    const existing = db
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(eq(ticketComments.id, comment.id))
      .get();

    if (existing) {
      db.update(ticketComments)
        .set({
          author: comment.author,
          content: comment.content,
        })
        .where(eq(ticketComments.id, comment.id))
        .run();
    } else {
      db.insert(ticketComments)
        .values({
          id: comment.id,
          author: comment.author,
          content: comment.content,
          createdAt: comment.createdAt ?? new Date().toISOString(),
          ...parent,
        })
        .run();
    }
    count++;
  }
  return count;
}
