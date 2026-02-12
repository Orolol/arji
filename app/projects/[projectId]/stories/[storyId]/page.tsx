"use client";

import { useParams } from "next/navigation";
import { useStoryDetail } from "@/hooks/useStoryDetail";
import { useComments } from "@/hooks/useComments";
import { useTicketAgent } from "@/hooks/useTicketAgent";
import { StoryDetailPanel } from "@/components/story/StoryDetailPanel";
import { CommentThread } from "@/components/story/CommentThread";
import { StoryActions } from "@/components/story/StoryActions";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";

export default function StoryDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const storyId = params.storyId as string;

  const {
    story,
    loading: storyLoading,
    updateStory,
    refresh: refreshStory,
  } = useStoryDetail(projectId, storyId);

  const {
    comments,
    loading: commentsLoading,
    addComment,
  } = useComments(projectId, storyId);

  const {
    activeSessions,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    approve,
  } = useTicketAgent(projectId, storyId);

  if (storyLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!story) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-muted-foreground">Story not found</p>
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-primary hover:underline"
        >
          Back to board
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <Link
          href={`/projects/${projectId}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Board
        </Link>
        {story.epic && (
          <span className="text-sm text-muted-foreground">
            / {story.epic.title}
          </span>
        )}
        <div className="flex-1" />
        <StoryActions
          story={story}
          dispatching={dispatching}
          isRunning={isRunning}
          activeSessions={activeSessions}
          onSendToDev={async (comment) => {
            await sendToDev(comment);
            refreshStory();
          }}
          onSendToReview={async (types) => {
            await sendToReview(types);
          }}
          onApprove={async () => {
            await approve();
            refreshStory();
          }}
        />
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Story details */}
        <div className="w-1/2 border-r border-border overflow-y-auto">
          <StoryDetailPanel
            story={story}
            onUpdate={updateStory}
          />
        </div>

        {/* Right: Comment thread */}
        <div className="w-1/2 flex flex-col overflow-hidden">
          <CommentThread
            comments={comments}
            loading={commentsLoading}
            onAddComment={addComment}
          />
        </div>
      </div>
    </div>
  );
}
