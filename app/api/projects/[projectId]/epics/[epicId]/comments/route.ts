import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ticketComments, epics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import {
  MentionResolutionError,
  validateMentionsExist,
} from "@/lib/documents/mentions";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { epicId } = await params;

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.epicId, epicId))
    .orderBy(ticketComments.createdAt)
    .all();

  return NextResponse.json({ data: comments });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const body = await request.json();

  if (!body.content || !body.author) {
    return NextResponse.json(
      { error: "author and content are required" },
      { status: 400 }
    );
  }

  try {
    validateMentionsExist({
      projectId,
      textSources: [body.content],
    });
  } catch (error) {
    if (error instanceof MentionResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const id = createId();
  const now = new Date().toISOString();

  db.insert(ticketComments)
    .values({
      id,
      epicId,
      author: body.author,
      content: body.content,
      agentSessionId: body.agentSessionId || null,
      createdAt: now,
    })
    .run();

  const comment = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.id, id))
    .get();

  return NextResponse.json({ data: comment }, { status: 201 });
}
