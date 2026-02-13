import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { chatConversations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; conversationId: string }> }
) {
  const { projectId, conversationId } = await params;

  // Validate the conversation belongs to the project
  const conversation = db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId)
      )
    )
    .get();

  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Delete conversation (messages cascade via FK)
  db.delete(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .run();

  return NextResponse.json({ data: { deleted: true } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; conversationId: string }> }
) {
  const { projectId, conversationId } = await params;
  const body = await request.json();

  const conversation = db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId)
      )
    )
    .get();

  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const updates: Record<string, string> = {};
  if (body.provider && ["claude-code", "codex", "gemini-cli"].includes(body.provider)) {
    updates.provider = body.provider;
  }
  if (body.label) {
    updates.label = body.label;
  }

  if (Object.keys(updates).length > 0) {
    db.update(chatConversations)
      .set(updates)
      .where(eq(chatConversations.id, conversationId))
      .run();
  }

  const updated = db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .get();

  return NextResponse.json({ data: updated });
}
