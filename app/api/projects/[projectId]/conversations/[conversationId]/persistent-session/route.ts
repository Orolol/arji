import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatConversations } from "@/lib/db/schema";
import {
  getPersistentChatSessionState,
  restartPersistentChatSession,
} from "@/lib/chat/persistent-runner";

export async function DELETE(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; conversationId: string }> },
) {
  const { projectId, conversationId } = await params;
  const conversation = db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.projectId, projectId),
      ),
    )
    .get();
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const restarted = restartPersistentChatSession(conversationId);
  return NextResponse.json({
    data: {
      restarted,
      persistentSessionState: getPersistentChatSessionState(conversationId),
    },
  });
}
