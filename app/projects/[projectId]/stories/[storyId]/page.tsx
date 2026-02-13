"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useStoryDetail } from "@/hooks/useStoryDetail";
import { useComments } from "@/hooks/useComments";
import { useTicketAgent } from "@/hooks/useTicketAgent";
import { useCodexAvailable } from "@/hooks/useCodexAvailable";
import { StoryDetailPanel } from "@/components/story/StoryDetailPanel";
import { CommentThread } from "@/components/story/CommentThread";
import { StoryActions } from "@/components/story/StoryActions";
import { ArrowLeft, Loader2, XCircle, X } from "lucide-react";
import Link from "next/link";
import { isAgentAlreadyRunningError } from "@/lib/agents/client-error";

interface Toast {
  id: string;
  message: string;
  href?: string;
}

export default function StoryDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const storyId = params.storyId as string;
  const [toasts, setToasts] = useState<Toast[]>([]);

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
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    approve,
  } = useTicketAgent(projectId, storyId, story?.epicId);

  const { codexAvailable, codexInstalled } = useCodexAvailable();

  function addToast(message: string, href?: string) {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, href }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 5000);
  }

  function handleAgentActionError(error: unknown) {
    if (isAgentAlreadyRunningError(error)) {
      addToast(
        error.message,
        error.sessionUrl || `/projects/${projectId}/sessions/${error.activeSessionId}`
      );
      return;
    }
    addToast(error instanceof Error ? error.message : "Failed to run agent action");
  }

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
          codexAvailable={codexAvailable}
          codexInstalled={codexInstalled}
          onSendToDev={async (comment, provider) => {
            await sendToDev(comment, provider);
            refreshStory();
          }}
          onSendToReview={async (types, provider) => {
            await sendToReview(types, provider);
          }}
          onApprove={async () => {
            await approve();
            refreshStory();
          }}
          activeSessionId={activeSession?.id || null}
          onActionError={handleAgentActionError}
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

      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg text-sm bg-red-900/90 text-red-100"
          >
            <XCircle className="h-4 w-4 shrink-0" />
            <span>{toast.message}</span>
            {toast.href && (
              <Link href={toast.href} className="text-red-50 underline text-xs whitespace-nowrap">
                Open session
              </Link>
            )}
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              aria-label="Close notification"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
