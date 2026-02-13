import Database from "better-sqlite3";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  chatConversations,
  epics,
  ticketComments,
  userStories,
} from "@/lib/db/schema";

export class ScopedDeleteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopedDeleteNotFoundError";
  }
}

function sqliteClient() {
  return (db as unknown as { $client: Database.Database }).$client;
}

export function deleteEpicPermanently(projectId: string, epicId: string) {
  const epic = db
    .select()
    .from(epics)
    .where(and(eq(epics.id, epicId), eq(epics.projectId, projectId)))
    .get();

  if (!epic) {
    throw new ScopedDeleteNotFoundError("Epic not found");
  }

  const transaction = sqliteClient().transaction(() => {
    const storyIds = db
      .select({ id: userStories.id })
      .from(userStories)
      .where(eq(userStories.epicId, epicId))
      .all()
      .map((row) => row.id);

    const sessions = db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(
        storyIds.length > 0
          ? or(
              eq(agentSessions.epicId, epicId),
              inArray(agentSessions.userStoryId, storyIds),
            )
          : eq(agentSessions.epicId, epicId),
      )
      .all();

    const sessionIds = sessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      db.delete(ticketComments)
        .where(inArray(ticketComments.agentSessionId, sessionIds))
        .run();
      db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds)).run();
    }

    if (storyIds.length > 0) {
      db.delete(ticketComments)
        .where(inArray(ticketComments.userStoryId, storyIds))
        .run();
    }

    db.delete(ticketComments).where(eq(ticketComments.epicId, epicId)).run();
    db.delete(chatConversations).where(eq(chatConversations.epicId, epicId)).run();
    db.delete(epics).where(eq(epics.id, epicId)).run();
  });

  transaction();
}

export function deleteUserStoryPermanently(projectId: string, storyId: string) {
  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    throw new ScopedDeleteNotFoundError("Story not found");
  }

  const parentEpic = db
    .select({ id: epics.id })
    .from(epics)
    .where(and(eq(epics.id, story.epicId), eq(epics.projectId, projectId)))
    .get();

  if (!parentEpic) {
    throw new ScopedDeleteNotFoundError("Story not found");
  }

  const transaction = sqliteClient().transaction(() => {
    const sessions = db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.userStoryId, storyId))
      .all();

    const sessionIds = sessions.map((session) => session.id);

    if (sessionIds.length > 0) {
      db.delete(ticketComments)
        .where(inArray(ticketComments.agentSessionId, sessionIds))
        .run();
      db.delete(agentSessions).where(inArray(agentSessions.id, sessionIds)).run();
    }

    db.delete(ticketComments).where(eq(ticketComments.userStoryId, storyId)).run();
    db.delete(userStories).where(eq(userStories.id, storyId)).run();
  });

  transaction();

  return { epicId: story.epicId };
}

