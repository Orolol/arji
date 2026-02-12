import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ticketComments, userStories } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";

type Params = { params: Promise<{ projectId: string; storyId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { storyId } = await params;

  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const comments = db
    .select()
    .from(ticketComments)
    .where(eq(ticketComments.userStoryId, storyId))
    .orderBy(ticketComments.createdAt)
    .all();

  return NextResponse.json({ data: comments });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { storyId } = await params;
  const body = await request.json();

  if (!body.content || !body.author) {
    return NextResponse.json(
      { error: "author and content are required" },
      { status: 400 }
    );
  }

  const story = db
    .select()
    .from(userStories)
    .where(eq(userStories.id, storyId))
    .get();

  if (!story) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  const id = createId();
  const now = new Date().toISOString();

  db.insert(ticketComments)
    .values({
      id,
      userStoryId: storyId,
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
